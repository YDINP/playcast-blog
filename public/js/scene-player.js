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

  var PER_CHAR = 58; // ms/글자 (무음 타이핑 속도)
  var HOLD_DEFAULT = 1100; // 타이핑 완료 후 정지(ms)
  var TYPE_MIN = 650; // 최소 타이핑 시간
  var MOUTH_MS = 130; // 입모양 토글 주기
  var reduceMotion =
    window.matchMedia &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function fmt(ms) {
    var s = Math.max(0, Math.round(ms / 1000));
    var m = Math.floor(s / 60);
    return m + ':' + String(s % 60).padStart(2, '0');
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
    this.host =
      stage.querySelector('.sp-host') ||
      (shell && shell.querySelector('.sp-host')) ||
      document.createElement('div'); // 호스트 없는 변형에서도 classList 호출이 안전하도록
    this.textEl = stage.querySelector('.sp-text');
    this.captionBox = stage.querySelector('.sp-caption .box');
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
      var typing = Math.max(TYPE_MIN, (sc.text || '').length * PER_CHAR);
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
    return Math.max(TYPE_MIN, (sc.text || '').length * PER_CHAR);
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

    // 표정
    // 표정 클래스 전체 제거 (emo-* 는 계속 늘어난다: shy/wink/laugh/sad/cry ...)
    // classList는 라이브 컬렉션이라 순회 중 제거하면 항목을 건너뛴다 → 스냅샷 후 제거
    var host = this.host;
    Array.prototype.slice.call(host.classList).forEach(function (c) {
      if (c.indexOf('emo-') === 0) host.classList.remove(c);
    });
    if (sc.emotion && sc.emotion !== 'idle')
      this.host.classList.add('emo-' + sc.emotion);
    this.host.classList.remove('is-talking');

    // 자막 초기화
    if (staticOnly) {
      // 재생 전 미리보기: 첫 줄 살짝 노출(정지)
      this.textEl.textContent = sc.text || '';
      this.captionBox.parentNode.classList.remove('is-typing');
    } else {
      this.textEl.textContent = '';
    }
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

    // 자막 타이핑
    var reveal = Math.min(
      text.length,
      Math.floor((text.length * elapsed) / Math.max(1, typingDur))
    );
    if (this.textEl.textContent.length !== reveal) {
      this.textEl.textContent = text.slice(0, reveal);
    }
    var isTyping = elapsed < typingDur && reveal < text.length;
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
    };
    Object.keys(map).forEach(function (sel) {
      var el = self.stage.querySelector(sel);
      if (el) el.addEventListener('click', map[sel]);
    });
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

  function init() {
    document.querySelectorAll('.sp-stage').forEach(function (stage) {
      if (stage.__sp) return;
      stage.__sp = new Player(stage);
    });
    document.querySelectorAll('.rig-blink').forEach(startBlink);
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
