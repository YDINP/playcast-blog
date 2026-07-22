/* ============================================================
   scene-player.js — playcast 합성 씬플레이어(가짜 영상) 엔진
   순수 바닐라. 의존성 없음.

   각 .sp-stage 안의 <script class="sp-data"> JSON(scenes)을 읽어
   [배경 크로스페이드 + 타이핑 자막 + 호스트 입모양 + 진행바]를
   타임라인으로 자동 재생한다.

   ── TTS-ready ──────────────────────────────────────────────
   시간 소스를 getSceneElapsed()/getSceneDuration() 한 곳으로 추상화.
   씬에 voice(오디오 URL)가 있으면 오디오의 currentTime/duration을
   시간 소스로 사용 → 자막/입모양이 음성에 자동 립싱크.
   voice가 없으면(현재 기본, 무음) 텍스트 길이 기반 가상 타임라인.
   나중에 생성형 TTS mp3를 voice에 채우기만 하면 코드 변경 없이 동작.
   ============================================================ */
(function () {
  'use strict';

  var PER_CHAR = 75; // ms/글자 (무음 타이핑 속도) — 자막·발음 흐름을 천천히
  var HOLD_DEFAULT = 1100; // 타이핑 완료 후 정지(ms)
  var TYPE_MIN = 780; // 최소 타이핑 시간
  var MOUTH_MS = 130; // 입모양 토글 주기
  var STEP_MS = 550; // 입모양 한 스텝 유지(ms) — 각 입을 더 오래 붙잡아 천천히 진행
  // 각 입모양의 벌어짐(세로 스케일). 스텝마다 이 값으로 부드럽게 스케일 전환.
  var MOUTH_OPEN = { closed: 0.16, i: 0.55, u: 0.6, e: 0.82, o: 0.88, a: 1.0 };

  // 한글/라틴 문자 → 입모양(비셈). 한글은 중성(모음) 추출.
  var JUNG_VIS = ['a','e','a','e','e','e','e','e','o','a','e','e','o','u','o','e','i','u','i','i','i'];
  function visemeOf(ch) {
    if (!ch || /\s/.test(ch)) return 'closed';
    var c = ch.charCodeAt(0);
    if (c >= 0xac00 && c <= 0xd7a3) { var j = Math.floor(((c - 0xac00) % 588) / 28); return JUNG_VIS[j] || 'a'; }
    if (/[aeiou]/i.test(ch)) return ch.toLowerCase();
    if (/[a-z]/i.test(ch)) return 'e';
    return 'closed';
  }

  var reduceMotion =
    window.matchMedia &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function fmt(ms) {
    var s = Math.max(0, Math.round(ms / 1000));
    var m = Math.floor(s / 60);
    return m + ':' + String(s % 60).padStart(2, '0');
  }

  // ── 자막 강조(**키워드**) ──────────────────────────────────
  // 씬 text의 **...**를 민트 강조 span으로 렌더. 마커는 표시 길이에서 제외.
  function parseEm(text) {
    var out = [], re = /\*\*([^*]+)\*\*/g, last = 0, m;
    while ((m = re.exec(text))) {
      if (m.index > last) out.push({ s: text.slice(last, m.index), em: false });
      out.push({ s: m[1], em: true });
      last = re.lastIndex;
    }
    if (last < text.length) out.push({ s: text.slice(last), em: false });
    return out;
  }
  function plainText(text) {
    return (text || '').replace(/\*\*([^*]+)\*\*/g, '$1');
  }
  function escHtml(s) {
    return s
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/\n/g, '<br>'); // 대사 내 명시적 줄바꿈
  }
  // 앞에서부터 n글자(표시 기준)만 노출. 강조 세그먼트는 <span class="sp-em">로 감싼다.
  function revealHTML(text, n) {
    var segs = parseEm(text), html = '', left = n;
    for (var i = 0; i < segs.length && left > 0; i++) {
      var take = segs[i].s.slice(0, left);
      left -= take.length;
      html += segs[i].em
        ? '<span class="sp-em">' + escHtml(take) + '</span>'
        : escHtml(take);
    }
    return html;
  }

  function Player(stage) {
    this.stage = stage;
    var dataEl = stage.querySelector('.sp-data');
    try {
      this.scenes = JSON.parse(dataEl.textContent).scenes || [];
    } catch (e) {
      this.scenes = [];
    }
    if (!this.scenes.length) return;

    // refs
    this.bgA = stage.querySelector('.sp-bg-a');
    this.bgB = stage.querySelector('.sp-bg-b');
    // booth 모드에서는 호스트가 스테이지 밖(.sp-shell > .sp-booth)에 있다
    var shell = stage.closest('.sp-shell');
    this.shell = shell;
    this.host =
      stage.querySelector('.sp-host') ||
      (shell && shell.querySelector('.sp-host')) ||
      document.createElement('div'); // 호스트 없는 변형에서도 classList 호출이 안전하도록
    this.textEl = stage.querySelector('.sp-text');
    this.captionBox = stage.querySelector('.sp-caption .box');
    this.capWrap = stage.querySelector('.sp-caption');
    this.cardEl = stage.querySelector('.sp-card'); // 씬 타이포 카드 오버레이
    this.pointerEl = stage.querySelector('.sp-pointer'); // 손가락 포인터
    this.capBtn = stage.querySelector('.sp-cap');
    // 자막 위치 모드: 'overlay'(이미지 위 스크림) | 'safe'(이미지 아래 전용 띠)
    // 기본값 safe: 이미지를 안 가리는 CC 띠가 기본. localStorage에 저장된 선택이 있으면 그걸 우선.
    this.capMode = 'safe';
    try {
      var savedCap = localStorage.getItem('sp-cap-mode');
      if (savedCap === 'safe' || savedCap === 'overlay') this.capMode = savedCap;
    } catch (e) {}
    this.fill = stage.querySelector('.sp-progress-fill');
    this.ticks = stage.querySelector('.sp-ticks');
    this.progress = stage.querySelector('.sp-progress');
    this.timeEl = stage.querySelector('.sp-time');
    this.bigplay = stage.querySelector('.sp-bigplay');

    // state
    this.i = -1;
    this.playing = false;
    this.started = false;
    this.autostarted = false;
    this._curVis = 'closed'; // 현재 글자의 입모양(모음/닫힘)
    this._step = 0; // 발음 플로우 스텝 인덱스
    this._stepAt = 0; // 마지막 스텝 시각(ms)
    this.muted = true; // 기본 무음(효과음/음성 공통)
    this.sceneStart = 0; // performance.now() 기준 (무음 경로)
    this.pausedAt = 0;
    this.activeBg = 'a';
    this.audio = null; // 현재 씬 voice 오디오
    this.durations = []; // 무음 경로 예상 지속시간(진행바 계산용)

    this._precompute();
    this._buildTicks();
    this._bindControls();
    this._observe();

    // 초기: 첫 씬 배경/정지 표시 (재생 전에도 콘텐츠 노출)
    this._paintScene(0, true);
    this._loop = this._loop.bind(this);
  }

  Player.prototype._precompute = function () {
    // 무음 경로 씬 지속시간 (진행바/시간표시용). voice 있으면 로드 후 보정.
    this.durations = this.scenes.map(function (sc) {
      var typing = Math.max(TYPE_MIN, plainText(sc.text).length * PER_CHAR);
      var hold = typeof sc.holdMs === 'number' ? sc.holdMs : HOLD_DEFAULT;
      return typing + hold;
    });
    this.total = this.durations.reduce(function (a, b) {
      return a + b;
    }, 0);
    this.prefix = [];
    var acc = 0;
    for (var k = 0; k < this.durations.length; k++) {
      this.prefix.push(acc);
      acc += this.durations[k];
    }
    if (this.timeEl) this.timeEl.textContent = '0:00 / ' + fmt(this.total);
  };

  Player.prototype._buildTicks = function () {
    if (!this.ticks) return;
    var self = this;
    this.scenes.forEach(function (sc, idx) {
      if (idx === 0) return;
      var t = document.createElement('div');
      t.className = 'sp-tick';
      t.style.left = (self.prefix[idx] / self.total) * 100 + '%';
      self.ticks.appendChild(t);
    });
  };

  // ── 시간 소스 추상화 (TTS-ready) ───────────────────────────
  Player.prototype._typingDuration = function () {
    var sc = this.scenes[this.i];
    if (this.audio && this.audio.duration) {
      // 음성이 있으면 자막을 음성 길이의 92%에 걸쳐 노출
      return this.audio.duration * 1000 * 0.92;
    }
    return Math.max(TYPE_MIN, plainText(sc.text).length * PER_CHAR);
  };
  Player.prototype._sceneDuration = function () {
    if (this.audio && this.audio.duration) return this.audio.duration * 1000;
    return this.durations[this.i];
  };
  Player.prototype._sceneElapsed = function () {
    if (this.audio && this.audio.duration) return this.audio.currentTime * 1000;
    return performance.now() - this.sceneStart;
  };

  // ── 씬 진입 ────────────────────────────────────────────────
  Player.prototype._paintScene = function (idx, staticOnly) {
    var sc = this.scenes[idx];
    // 배경 크로스페이드
    var next = this.activeBg === 'a' ? this.bgB : this.bgA;
    var cur = this.activeBg === 'a' ? this.bgA : this.bgB;
    if (sc.image) {
      next.style.backgroundImage = 'url("' + sc.image + '")';
      next.classList.remove('is-grad');
    } else {
      next.style.backgroundImage = '';
      next.classList.add('is-grad');
    }
    next.classList.add('is-on');
    cur.classList.remove('is-on');
    this.activeBg = this.activeBg === 'a' ? 'b' : 'a';

    // 씬 타이포 카드(핵심 수치·문구를 이미지 위에 얹음)
    this._renderCard(sc.card);
    // 손가락 포인터(이미지 속 중요 지점 강조)
    this._renderPointer(sc.point);

    // 표정
    // 표정 클래스 전체 제거 (emo-* 는 계속 늘어난다: shy/wink/laugh/sad/cry ...)
    // classList는 라이브 컬렉션이라 순회 중 제거하면 항목을 건너뛴다 → 스냅샷 후 제거
    var host = this.host;
    Array.prototype.slice.call(host.classList).forEach(function (c) {
      if (c.indexOf('emo-') === 0) host.classList.remove(c);
    });
    var hasEmo = !!(sc.emotion && sc.emotion !== 'idle');
    if (hasEmo) this.host.classList.add('emo-' + sc.emotion);
    this.host.classList.toggle('has-emo', hasEmo); // 표정 파츠가 눈을 덮으므로 눈동자 레이어 숨김
    this.host.classList.remove('is-talking');

    // 자막 초기화
    if (staticOnly) {
      // 재생 전 미리보기: 첫 줄 전체 노출(정지) — 강조 포함
      this.textEl.innerHTML = revealHTML(sc.text || '', plainText(sc.text).length);
      this.captionBox.parentNode.classList.remove('is-typing');
    } else {
      this.textEl.textContent = '';
    }
    // 대사 없는 씬/전환: 자막 영역 숨겨 이미지 100% 노출
    if (this.capWrap)
      this.capWrap.classList.toggle('is-empty', !this.textEl.textContent);
  };

  // 씬 카드 렌더 — kind: stat(큰 수치) | title(큰 문구) | points(핵심 목록)
  Player.prototype._renderCard = function (card) {
    var el = this.cardEl;
    if (!el) return;
    if (!card) { el.className = 'sp-card'; el.innerHTML = ''; return; }
    var kind = card.kind || 'stat', inner = '';
    if (kind === 'points') {
      var items = (card.items || [])
        .map(function (it) { return '<li>' + escHtml(String(it)) + '</li>'; })
        .join('');
      inner =
        (card.head ? '<div class="spc-head">' + escHtml(String(card.head)) + '</div>' : '') +
        '<ul>' + items + '</ul>';
    } else {
      inner =
        (card.big ? '<div class="spc-big">' + escHtml(String(card.big)) + '</div>' : '') +
        (card.label ? '<div class="spc-label">' + escHtml(String(card.label)) + '</div>' : '') +
        (card.sub ? '<div class="spc-sub">' + escHtml(String(card.sub)) + '</div>' : '');
    }
    el.innerHTML = '<div class="spc-inner">' + inner + '</div>';
    var extra = (card.pos ? ' pos-' + card.pos : '') + (card.size ? ' size-' + card.size : '');
    // 등장 애니메이션 리트리거
    el.className = 'sp-card';
    void el.offsetWidth;
    el.className = 'sp-card is-show spc-' + kind + extra;
  };

  // (말소리 블립 제거됨 — 립싱크는 시각 전용, 사운드 없음)

  // 손가락 포인터 — 이미지 속 (x,y)% 지점을 가리키고, from이 있으면 그 지점에서 이동
  Player.prototype._renderPointer = function (point) {
    var el = this.pointerEl;
    if (!el) return;
    if (!point) { el.className = 'sp-pointer'; el.innerHTML = ''; return; }
    var emoji = point.emoji || '👆'; // 👆
    var label = point.label ? '<span class="pt-label">' + escHtml(String(point.label)) + '</span>' : '';
    el.innerHTML = '<span class="pt-ring"></span><span class="pt-hand">' + escHtml(emoji) + '</span>' + label;
    var fromX = point.from ? point.from[0] : point.x;
    var fromY = point.from ? point.from[1] : point.y;
    // 시작 위치 배치 후 목표로 트랜지션(이동)
    el.className = 'sp-pointer';
    el.style.left = fromX + '%';
    el.style.top = fromY + '%';
    void el.offsetWidth;
    el.className = 'sp-pointer is-show';
    var tx = point.x, ty = point.y;
    requestAnimationFrame(function () {
      requestAnimationFrame(function () { el.style.left = tx + '%'; el.style.top = ty + '%'; });
    });
  };

  Player.prototype._enterScene = function (idx) {
    this.i = idx;
    this._paintScene(idx, false);
    // voice 오디오 셋업 (있을 때만)
    if (this.audio) {
      this.audio.pause();
      this.audio = null;
    }
    var sc = this.scenes[idx];
    if (sc.voice) {
      this.audio = new Audio(sc.voice);
      this.audio.muted = this.muted;
      this.audio.play().catch(function () {});
    }
    this.sceneStart = performance.now();
    this._updateActiveChapter(idx);
  };

  // ── 메인 루프 ─────────────────────────────────────────────
  Player.prototype._loop = function () {
    if (!this.playing) return;
    var sc = this.scenes[this.i];
    var elapsed = this._sceneElapsed();
    var typingDur = this._typingDuration();
    var sceneDur = this._sceneDuration();
    var text = sc.text || '';
    var plain = plainText(text);
    var plen = plain.length;

    // 자막 타이핑 (표시 글자 수 기준, 강조 마커 제외)
    var reveal = Math.min(
      plen,
      Math.floor((plen * elapsed) / Math.max(1, typingDur))
    );
    if (this.textEl.textContent.length !== reveal) {
      this.textEl.innerHTML = revealHTML(text, reveal);
      // 현재 글자의 입모양(모음/닫힘)만 갱신.
      this._curVis = visemeOf(plain.charAt(reveal - 1));
    }
    // 발음 플로우(징검다리): 기본(닫힘)→이→현재모음→이 를 '시간 기준' 스텝으로 진행.
    // 자막 타이핑 속도와 분리(STEP_MS 고정)해 입이 너무 빨리 지나가지 않게 한다.
    var peak = (this._curVis && this._curVis !== 'closed') ? this._curVis : 'i';
    var flow = ['closed', 'i', peak, 'i'];
    var nowMs = performance.now();
    if (nowMs - this._stepAt >= STEP_MS) { this._step = (this._step + 1) % flow.length; this._stepAt = nowMs; }
    var vis = (this._curVis === 'closed') ? 'closed' : flow[this._step];
    this.host.setAttribute('data-viseme', vis);
    var mo = MOUTH_OPEN[vis]; if (mo == null) mo = 1;
    this.host.style.setProperty('--mopen', mo.toFixed(3));
    if (this.capWrap) this.capWrap.classList.toggle('is-empty', reveal === 0);
    var isTyping = elapsed < typingDur && reveal < plen;
    this.stage.classList.toggle('is-typing', isTyping);

    // 말하는 중: 호스트 끄덕임(정적 포트레이트라 입모양 대신)
    this.host.classList.toggle('is-talking', isTyping);

    // 진행바 + 시간
    var globalMs = this.prefix[this.i] + Math.min(elapsed, sceneDur);
    var pct = Math.min(100, (globalMs / this.total) * 100);
    this.fill.style.width = pct + '%';
    if (this.timeEl)
      this.timeEl.textContent = fmt(globalMs) + ' / ' + fmt(this.total);

    // 다음 씬
    if (elapsed >= sceneDur) {
      if (this.i + 1 < this.scenes.length) {
        this._enterScene(this.i + 1);
      } else {
        this._finish();
        return;
      }
    }
    this.raf = requestAnimationFrame(this._loop);
  };

  Player.prototype._finish = function () {
    this.playing = false;
    this.started = false;
    this.stage.classList.remove('is-typing');
    this.stage.classList.add('is-paused', 'is-ended');
    this.host.classList.remove('is-talking');
    this.fill.style.width = '100%';
    if (this.bigplay) this.bigplay.classList.remove('is-hidden');
    this._setPlayIcon(false);
  };

  // ── 컨트롤 ────────────────────────────────────────────────
  Player.prototype.play = function () {
    if (this.playing) return;
    if (this.stage.classList.contains('is-ended') || this.i < 0) {
      this._enterScene(0);
    } else {
      // resume: sceneStart 보정
      this.sceneStart = performance.now() - this.pausedAt;
      if (this.audio) this.audio.play().catch(function () {});
    }
    this.playing = true;
    this.started = true;
    this.stage.classList.remove('is-paused', 'is-ended');
    if (this.bigplay) this.bigplay.classList.add('is-hidden');
    this._setPlayIcon(true);
    this.raf = requestAnimationFrame(this._loop);
  };

  Player.prototype.pause = function () {
    if (!this.playing) return;
    this.playing = false;
    this.pausedAt = this._sceneElapsed();
    if (this.audio) this.audio.pause();
    cancelAnimationFrame(this.raf);
    this.stage.classList.add('is-paused');
    this.host.classList.remove('is-talking');
    if (this.bigplay) this.bigplay.classList.add('is-hidden');
    this._setPlayIcon(false);
  };

  Player.prototype.toggle = function () {
    this.playing ? this.pause() : this.play();
  };

  Player.prototype.seekScene = function (idx) {
    idx = Math.max(0, Math.min(this.scenes.length - 1, idx));
    this.stage.classList.remove('is-ended');
    this._enterScene(idx);
    if (!this.playing) {
      this.playing = true;
      this.started = true;
      this.stage.classList.remove('is-paused');
      if (this.bigplay) this.bigplay.classList.add('is-hidden');
      this._setPlayIcon(true);
      this.raf = requestAnimationFrame(this._loop);
    }
  };

  Player.prototype.replay = function () {
    this.stage.classList.remove('is-ended');
    this.seekScene(0);
  };

  Player.prototype._seekFraction = function (frac) {
    var target = frac * this.total;
    var idx = 0;
    for (var k = 0; k < this.scenes.length; k++) {
      if (target >= this.prefix[k]) idx = k;
    }
    this.seekScene(idx);
  };

  Player.prototype.setMuted = function (m) {
    this.muted = m;
    if (this.audio) this.audio.muted = m;
    this.stage.classList.toggle('is-muted', m);
    this._setMuteIcon(m);
  };

  // 자막 위치 전환: overlay(이미지 위) ↔ safe(이미지 아래 전용 띠, 이미지 0% 가림)
  Player.prototype.setCapMode = function (mode, silent) {
    this.capMode = mode === 'safe' ? 'safe' : 'overlay';
    var safe = this.capMode === 'safe';
    this.stage.classList.toggle('cap-safe', safe);
    if (this.capBtn) {
      this.capBtn.classList.toggle('is-safe', safe);
      this.capBtn.setAttribute(
        'title',
        safe ? '자막: 이미지 아래 (탭하면 이미지 위로)' : '자막: 이미지 위 (탭하면 아래로 내려 이미지 안 가림)'
      );
    }
    this._setCapIcon();
    if (!silent) {
      try { localStorage.setItem('sp-cap-mode', this.capMode); } catch (e) {}
    }
  };
  Player.prototype.toggleCapMode = function () {
    this.setCapMode(this.capMode === 'safe' ? 'overlay' : 'safe');
  };

  // ── 아이콘 ────────────────────────────────────────────────
  Player.prototype._setPlayIcon = function (playing) {
    var b = this.stage.querySelector('.sp-play');
    if (!b) return;
    b.innerHTML = playing
      ? '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg>'
      : '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>';
  };
  Player.prototype._setMuteIcon = function (m) {
    var b = this.stage.querySelector('.sp-mute');
    if (!b) return;
    b.innerHTML = m
      ? '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M4 9v6h4l5 5V4L8 9H4z"/><path d="M16 9l4 6M20 9l-4 6" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>'
      : '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M4 9v6h4l5 5V4L8 9H4z"/><path d="M15 8a5 5 0 010 8" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
  };
  Player.prototype._setCapIcon = function () {
    if (!this.capBtn) return;
    // CC 배지 + 자막이 놓이는 위치를 밑줄로 표시(safe=이미지 아래)
    this.capBtn.innerHTML =
      '<svg viewBox="0 0 24 24" fill="none">' +
      '<rect x="3" y="5" width="18" height="11" rx="2.5" fill="currentColor"/>' +
      '<text x="12" y="13.6" text-anchor="middle" font-size="7.5" font-weight="800" fill="#0a0a0f" font-family="Arial, sans-serif">CC</text>' +
      '<rect x="6" y="19" width="12" height="2" rx="1" fill="currentColor"/>' +
      '</svg>';
  };

  Player.prototype._updateActiveChapter = function (idx) {
    // watch 페이지 트랜스크립트 하이라이트 (같은 stage id 연결)
    var id = this.stage.getAttribute('data-player');
    if (!id) return;
    var items = document.querySelectorAll(
      '[data-transcript="' + id + '"] .tr-item'
    );
    items.forEach(function (el, k) {
      el.classList.toggle('is-active', k === idx);
    });
  };

  // ── 전체화면 (유튜브식) — 가로모드 강제 + width fit ──
  Player.prototype._isFs = function () {
    var fe = document.fullscreenElement || document.webkitFullscreenElement;
    return (!!fe && fe === this.shell) || (!!this.shell && this.shell.classList.contains('is-fs'));
  };
  Player.prototype._syncFs = function () {
    var native = !!(document.fullscreenElement || document.webkitFullscreenElement);
    if (this.shell && !native) this.shell.classList.remove('is-fs'); // 네이티브 종료 시 폴백 클래스 정리
    var on = this._isFs();
    var b = this.stage.querySelector('.sp-fs');
    if (b) { b.classList.toggle('is-on', on); b.setAttribute('aria-label', on ? '전체화면 종료' : '전체화면'); }
    if (!on) {
      document.documentElement.classList.remove('sp-fs-lock');
      try { if (screen.orientation && screen.orientation.unlock) screen.orientation.unlock(); } catch (e) {}
    }
  };
  Player.prototype.toggleFullscreen = function () {
    var shell = this.shell; if (!shell) return;
    var self = this;
    var ua = navigator.userAgent || '';
    var isIOS = /iP(hone|ad|od)/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    var lockLandscape = function () {
      try { if (screen.orientation && screen.orientation.lock) screen.orientation.lock('landscape').catch(function () {}); } catch (e) {}
    };
    if (this._isFs()) {
      if (document.exitFullscreen) document.exitFullscreen().catch(function () {});
      else if (document.webkitExitFullscreen) document.webkitExitFullscreen();
      shell.classList.remove('is-fs');
      document.documentElement.classList.remove('sp-fs-lock');
      try { if (screen.orientation && screen.orientation.unlock) screen.orientation.unlock(); } catch (e) {}
      this._syncFs();
      return;
    }
    var req = shell.requestFullscreen || shell.webkitRequestFullscreen;
    if (req && !isIOS) {
      req.call(shell).then(function () { lockLandscape(); self._syncFs(); }).catch(function () {
        shell.classList.add('is-fs'); document.documentElement.classList.add('sp-fs-lock'); self._syncFs();
      });
    } else {
      // iOS 사파리: div 네이티브 전체화면 불가 → CSS 유사 전체화면(가로 회전은 OS가 잠금 못 함, CSS로 안내)
      shell.classList.add('is-fs');
      document.documentElement.classList.add('sp-fs-lock');
      this._syncFs();
    }
  };

  Player.prototype._bindControls = function () {
    var self = this;
    if (this.bigplay) {
      var bp = this.bigplay.querySelector('button');
      if (bp) bp.addEventListener('click', function () { self.play(); });
    }
    var map = {
      '.sp-play': function () { self.toggle(); },
      '.sp-prev': function () { self.seekScene(self.i - 1); },
      '.sp-next': function () { self.seekScene(self.i + 1); },
      '.sp-replay': function () { self.replay(); },
      '.sp-mute': function () { self.setMuted(!self.muted); },
      '.sp-cap': function () { self.toggleCapMode(); },
      '.sp-fs': function () { self.toggleFullscreen(); },
    };
    Object.keys(map).forEach(function (sel) {
      var el = self.stage.querySelector(sel);
      if (el) el.addEventListener('click', function (e) {
        e.stopPropagation(); // 컨트롤 클릭이 스테이지 토글(재생/정지)로 번지지 않게 → 사운드 토글해도 재생 유지
        map[sel]();
      });
    });
    // 전체화면: ESC/제스처로 나가도 버튼·클래스 동기화
    document.addEventListener('fullscreenchange', function () { self._syncFs(); });
    document.addEventListener('webkitfullscreenchange', function () { self._syncFs(); });

    // 진행바 클릭 시크
    if (this.progress) {
      this.progress.addEventListener('click', function (e) {
        var r = self.progress.getBoundingClientRect();
        self._seekFraction((e.clientX - r.left) / r.width);
      });
    }
    // 스테이지 클릭(컨트롤/버튼 제외) → 토글
    this.stage.addEventListener('click', function (e) {
      if (e.target.closest('.sp-controls') || e.target.closest('.sp-bigplay'))
        return;
      if (self.started) self.toggle();
      else self.play();
    });
    // 외부 트랜스크립트 항목 → 해당 씬으로
    var id = this.stage.getAttribute('data-player');
    if (id) {
      document
        .querySelectorAll('[data-transcript="' + id + '"] .tr-item')
        .forEach(function (el, k) {
          el.addEventListener('click', function () { self.seekScene(k); });
        });
    }
    this._setPlayIcon(false);
    this._setMuteIcon(true);
    this.setCapMode(this.capMode, true);
    this.stage.classList.add('is-muted');
  };

  Player.prototype._observe = function () {
    var self = this;
    if (reduceMotion || !('IntersectionObserver' in window)) return;
    var io = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (en) {
          if (
            en.isIntersecting &&
            en.intersectionRatio >= 0.6 &&
            !self.autostarted
          ) {
            self.autostarted = true;
            self.play();
          } else if (en.intersectionRatio < 0.15 && self.playing) {
            self.pause();
          }
        });
      },
      { threshold: [0, 0.15, 0.6] }
    );
    io.observe(this.stage);
  };

  // 눈 깜빡임 스케줄러 — CSS 애니메이션은 주기가 고정이라 "항상 같은 리듬으로 두 번"이
  // 눈에 띈다. 간격(2.4~7s)·연속 깜빡 여부(약 22%)를 매번 랜덤으로 뽑는다.
  function startBlink(el) {
    if (el.__blink) return;
    el.__blink = true;
    var reduce =
      window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduce) return;

    var CLOSE_MS = 110; // 눈 감고 있는 시간
    function close(then) {
      el.classList.add('is-blink');
      setTimeout(function () {
        el.classList.remove('is-blink');
        if (then) setTimeout(then, 130 + Math.random() * 60); // 연속 깜빡 사이 간격
      }, CLOSE_MS);
    }
    function schedule() {
      setTimeout(function () {
        if (Math.random() < 0.22) close(function () { close(schedule); });
        else close(schedule);
      }, 2400 + Math.random() * 4600);
    }
    schedule();
  }

  // ── 리깅(2.5D) ──────────────────────────────────────────────
  // 있는 파츠만으로 가능한 것: 포인터 방향으로 몸 기울임 + 얼굴 레이어 시차(깊이감),
  // 아이들 흔들림, 말할 때 끄덕임, 표정별 몸짓. (진짜 Live2D의 메시 변형은 아님)
  var POSE = {
    'emo-surprised': { dy: -4, rot: 0, scale: 1.015 },
    'emo-laugh': { dy: -3, rot: 1.0, scale: 1.01 },
    'emo-wink': { dy: -1, rot: -1.0, scale: 1 },
    'emo-happy': { dy: -1, rot: 0.5, scale: 1 },
    'emo-shy': { dy: 1, rot: 1.2, scale: 0.997 },
    'emo-think': { dy: 1, rot: -1.4, scale: 1 },
    'emo-sad': { dy: 4, rot: -1.2, scale: 0.995 },
    'emo-cry': { dy: 5, rot: -1.6, scale: 0.993 },
  };
  var rigs = [];
  var ptr = { x: 0, y: 0 }; // -1..1

  function startRig(host) {
    if (host.__rig) return;
    host.__rig = true;
    // 정적 리그(파츠 분리 없음)도 상체 모핑을 위해 등록. parts/pupils는 있으면 사용.
    rigs.push({
      host: host,
      parts: host.querySelector('.rig-parts'),
      pupils: host.querySelectorAll('.rig-pupil'),
      cur: { x: 0, y: 0, rot: 0, scale: 1, fx: 0, fy: 0, px: 0, py: 0, bph: 0, bamp: 0.0035 },
    });
  }

  function poseOf(host) {
    for (var k in POSE) if (host.classList.contains(k)) return POSE[k];
    return { dy: 0, rot: 0, scale: 1 };
  }

  var lastRigT = performance.now();
  function rigLoop() {
    var dtR = Math.min(0.05, (performance.now() - lastRigT) / 1000);
    lastRigT = performance.now();
    for (var i = 0; i < rigs.length; i++) {
      var r = rigs[i], host = r.host, c = r.cur;
      var pose = poseOf(host);
      var talking = host.classList.contains('is-talking');

      // 목표값: 마우스 방향 상체 기울임(가슴 위쪽만 — transform-origin 하단 피벗이라 상체가 크게,
      // 책상/손 밑단은 거의 고정) + 아이들 흔들림 + 말할 때 끄덕임. 호흡은 .rig가 담당하므로 bob 생략.
      // 마우스 추적/기울임 전면 제거 — 호스트는 하단에 완전 고정. 호흡 모핑만 유지.
      var tx = 0;
      var ty = 0;
      var lean = 0; // skew/rotate 없음(고정)
      var sc = 1; // 감정별 스케일 제거 — 씬 전환마다 캐릭터 크기 변동(커짐) 방지
      var fx = 0;
      var fy = 0;

      var k = 0.12; // 감쇠(lerp) — 뚝뚝 끊기지 않게
      c.x += (tx - c.x) * k;
      c.y += (ty - c.y) * k;
      c.rot += (lean - c.rot) * k; // c.rot = skewX 각도(상체 기울임)
      c.scale += (sc - c.scale) * k;
      c.fx += (fx - c.fx) * k;
      c.fy += (fy - c.fy) * k;

      // 호흡 모핑: transform-origin 하단이라 세로 스케일↑ = 하단 고정·가슴/상체가 부풀어 오름.
      // 말할 때 조금 더 빠르고 크게(생동감).
      // 호흡 위상을 '누적'해 말할때/아닐때 속도(bSpd)가 바뀌어도 위상이 튀지 않게 한다.
      // (기존 sin(t*bSpd)는 씬 전환 시 is-talking 토글로 bSpd가 바뀌면 큰 t에 곱해져
      //  위상이 불연속 점프 → 캐릭터가 갑자기 커지던 버그.) 진폭도 부드럽게 보간.
      var bSpd = talking ? 1.6 : 0.85;
      c.bamp += ((talking ? 0.005 : 0.0035) - c.bamp) * 0.1;
      c.bph += dtR * bSpd;
      var breath = Math.sin(c.bph) * c.bamp;
      var sy = c.scale * (1 + breath);
      var sx = c.scale * (1 - breath * 0.45);

      // skewX 부호: 마우스 오른쪽(ptr.x>0)일 때 상체가 오른쪽으로 기울도록 음수 적용.
      host.style.transform =
        'translate(' + c.x.toFixed(2) + 'px,' + c.y.toFixed(2) + 'px) skewX(' +
        (-c.rot).toFixed(2) + 'deg) scale(' + sx.toFixed(4) + ',' + sy.toFixed(4) + ')';
      if (r.parts) {
        r.parts.style.transform =
          'translate(' + c.fx.toFixed(2) + 'px,' + c.fy.toFixed(2) + 'px)';
      }

      // 눈동자: 커서를 따라 이동. 파츠 좌표는 base(600px 폭) 기준이라 렌더 크기에 맞춰 환산.
      if (r.pupils.length) {
        var s = host.clientWidth / 600;
        var tpx = ptr.x * 8 * s;            // 좌우 ±8px(base). 눈 소켓 마스크가 잘라주므로 넘칠 걱정 없음
        var tpy = ptr.y * 4 * s;
        c.px += (tpx - c.px) * 0.14;
        c.py += (tpy - c.py) * 0.14;
        var tr = 'translate(' + c.px.toFixed(2) + 'px,' + c.py.toFixed(2) + 'px)';
        for (var j = 0; j < r.pupils.length; j++) r.pupils[j].style.transform = tr;
      }
    }
    requestAnimationFrame(rigLoop);
  }

  function initRigs() {
    if (reduceMotion) return; // 모션 최소화 사용자는 정지 포트레이트로
    document.querySelectorAll('.sp-host').forEach(startRig);
    if (!rigs.length) return;
    // 포인터: 화면 중앙 기준 -1..1 (터치 기기는 hover가 없어 자동 제외)
    if (window.matchMedia && window.matchMedia('(hover: hover)').matches) {
      window.addEventListener(
        'pointermove',
        function (e) {
          ptr.x = Math.max(-1, Math.min(1, (e.clientX / window.innerWidth) * 2 - 1));
          ptr.y = Math.max(-1, Math.min(1, (e.clientY / window.innerHeight) * 2 - 1));
        },
        { passive: true }
      );
    }
    requestAnimationFrame(rigLoop);
  }

  function init() {
    document.querySelectorAll('.sp-stage').forEach(function (stage) {
      if (stage.__sp) return;
      stage.__sp = new Player(stage);
    });
    document.querySelectorAll('.rig-blink').forEach(startBlink);
    initRigs();
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
