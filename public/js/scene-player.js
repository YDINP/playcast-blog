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

  var PER_CHAR = 68; // ms/글자 — 자막 리빌 속도(무음 씬). 작을수록 빠름
  var MOUTH_BEAT = 240; // 입모양(모음) 유지 시간(ms) — 크로스페이드로 부드럽게 다음 모양으로
  var MOUTH_OPEN_PERIOD = 560; // 벌어짐 연속 사인 주기(ms) — 은은한 개폐(하드 X)
  var MOUTH_SEQ = ['a', 'e', 'o', 'a', 'i', 'e', 'o', 'u', 'e', 'a']; // 순환할 입모양(모음)
  var HOLD_DEFAULT = 1100; // 타이핑 완료 후 정지(ms)
  var TYPE_MIN = 780; // 최소 타이핑 시간
  var MOUTH_MS = 130; // 입모양 토글 주기
  var MOUTH_FLOOR = 0.1; // 최소 벌어짐(음절 사이 다뭄 정도 — 낮을수록 또박또박)
  var MOUTH_DUTY = 0.72; // 글자 beat 중 입을 열고닫는 비율(나머지는 다뭄 → 음절 분리)
  // 각 입모양의 벌어짐(세로 스케일). 스텝마다 이 값으로 부드럽게 스케일 전환.
  var MOUTH_OPEN = { closed: 0.16, i: 0.55, u: 0.6, e: 0.82, o: 0.88, a: 1.0 };

  /* ── 오디오 파형 립싱크 ────────────────────────────────────
     예전에는 MOUTH_SEQ 를 고정 주기로 순환시켰다 — 음성이 무슨 말을 하든 입은 늘 같은
     리듬으로 뻐끔거렸고, 문장 사이 침묵에도 계속 움직였다. 여기서는 실제 <audio> 파형을
     Web Audio 로 읽어 세기 → 벌어짐(--mopen), 스펙트럼 → 모음(data-viseme) 을 만든다.
     AudioContext 를 못 쓰면(구형 브라우저·제스처 전) attach 가 null 을 주고 루프가
     예전 순환 방식으로 자동 폴백한다.

     ⚠ 임계값은 반드시 **dB 영역**에서 재야 한다. getByteFrequencyData 는 선형 magnitude 가
     아니라 [minDecibels,maxDecibels] 를 0..255 로 편 값이라, 선형으로 잰 대역비(중앙값 0.055)를
     그대로 쓰면 전 프레임이 'e'/'i' 두 모양에 갇힌다(실측: a=0.5% o=0.2%).
     아래 값은 브라우저 분석기를 스펙대로 흉내 내 로지 TTS(GPT-SoVITS)로 실측한 백분위다 —
     2026-08-10, wuthering-waves 7트랙 + vtuber-beginner-guide 로 교차검증.
     front(dB) p33=0.295 / p50=0.333 / p66=0.357, open p50=0.737.
     결과 분포 a25/e23/u17/o12/i10/closed12%, 평균 유지 124ms. */
  var LIP_FRONT_BACK = 0.295; // 이 아래 = 후설·원순(오/우)
  var LIP_FRONT_FWD = 0.357;  // 이 위 = 전설(이/에)
  var LIP_OPEN_HI = 0.68;     // 전설·후설 안에서 크게/작게를 가르는 벌어짐(open 중앙값 근처)
  var LIP_OPEN_MID = 0.50;    // 중설에서 '아'로 넘어가는 벌어짐
  var LIP_RMS_FLOOR = 0.025;  // 무음 바닥
  var LIP_RMS_CEIL = 0.225;   // 최대 벌어짐에 닿는 세기
  var LIP_SILENCE = 0.08;     // 정규화 세기가 이 아래면 입을 다문다(문장 사이 쉼)
  var LIP_HOLD = 90;          // 모음 최소 유지(ms) — 프레임마다 바뀌면 입이 떨린다

  var Lip = (function () {
    var ctx = null, dead = false;

    function context() {
      if (ctx || dead) return ctx;
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) { dead = true; return null; }
      try { ctx = new AC(); } catch (e) { dead = true; }
      return ctx;
    }

    /* createMediaElementSource 는 요소당 단 한 번만 허용되고, 한 번 연결하면 그 요소의
       소리는 그래프를 통해서만 나간다 → destination 연결이 빠지면 무음이 된다.
       컨텍스트가 running 일 때만 붙인다(제스처 전에 붙으면 소리가 끊긴다). */
    function attach(el) {
      if (!el) return null;
      if (el.__lip) return el.__lip;
      if (el.__lipFail) return null;
      var c = context();
      if (!c || c.state !== 'running') return null;
      try {
        var an = c.createAnalyser();
        an.fftSize = 1024;
        an.smoothingTimeConstant = 0.5;
        c.createMediaElementSource(el).connect(an);
        an.connect(c.destination);
        el.__lip = {
          an: an,
          freq: new Uint8Array(an.frequencyBinCount),
          wave: new Uint8Array(an.fftSize),
          hz: c.sampleRate / an.fftSize,
          open: 0, front: (LIP_FRONT_BACK + LIP_FRONT_FWD) / 2, vis: 'closed', since: 0
        };
        return el.__lip;
      } catch (e) {
        el.__lipFail = true; // 이미 소스가 붙은 요소 등 — 다시 시도하지 않는다
        return null;
      }
    }

    // 사용자 제스처 안에서 호출 — 자동재생 정책상 여기서만 컨텍스트가 살아난다.
    function resume() {
      var c = context();
      if (c && c.state === 'suspended') { try { c.resume(); } catch (e) {} }
    }

    function bandAvg(freq, from, to, hz) {
      var a = Math.max(1, Math.round(from / hz));
      var b = Math.min(freq.length - 1, Math.round(to / hz));
      if (b <= a) return 0;
      var s = 0;
      for (var i = a; i <= b; i++) s += freq[i];
      return s / (b - a + 1);
    }

    // 프레임 1회 분석 → {open, vis}. 붙어 있지 않으면 null(호출부가 폴백).
    /* 붙지 않았으면 매 프레임 재시도한다 — 첫 씬은 제스처 직후라 컨텍스트가 아직
       suspended 인 경우가 흔한데, 그때 포기하면 1씬 내내 폴백으로 남는다.
       재생 중 연결해도 요소 소리가 그래프로 옮겨갈 뿐 끊기지 않는다. */
    function read(el, now) {
      var L = el && (el.__lip || attach(el));
      if (!L) return null;
      L.an.getByteTimeDomainData(L.wave);
      var sum = 0;
      for (var i = 0; i < L.wave.length; i++) {
        var d = (L.wave[i] - 128) / 128;
        sum += d * d;
      }
      var rms = Math.sqrt(sum / L.wave.length);
      var target = (rms - LIP_RMS_FLOOR) / (LIP_RMS_CEIL - LIP_RMS_FLOOR);
      target = target < 0 ? 0 : target > 1 ? 1 : target;
      // 열릴 땐 빠르게, 닫힐 땐 느리게 — 자음마다 입이 딱딱 끊기는 걸 막는다.
      L.open += (target - L.open) * (target > L.open ? 0.55 : 0.18);

      if (L.open < LIP_SILENCE) {
        if (L.vis !== 'closed') { L.vis = 'closed'; L.since = now; }
        return L;
      }
      L.an.getByteFrequencyData(L.freq);
      var lo = bandAvg(L.freq, 200, 1000, L.hz);
      var hi = bandAvg(L.freq, 1300, 3200, L.hz);
      var f = hi / (lo + hi + 1e-6);
      L.front += (f - L.front) * 0.35;
      var vis;
      if (L.front > LIP_FRONT_FWD) vis = L.open > LIP_OPEN_HI ? 'e' : 'i';
      else if (L.front < LIP_FRONT_BACK) vis = L.open > LIP_OPEN_HI ? 'o' : 'u';
      else vis = L.open > LIP_OPEN_MID ? 'a' : 'e';
      if (vis !== L.vis && now - L.since >= LIP_HOLD) { L.vis = vis; L.since = now; }
      return L;
    }

    return { attach: attach, resume: resume, read: read };
  })();

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
    this.gameTitleEl = stage.querySelector('.sp-gametitle');
    // booth 모드에서는 호스트가 스테이지 밖(.sp-shell > .sp-booth)에 있다
    var shell = stage.closest('.sp-shell');
    this.shell = shell;
    this.ctl = shell || stage; // 컨트롤바는 스테이지 밖(shell > .sp-controls)로 이동 — 컨트롤 요소는 여기서 찾는다
    this.host =
      stage.querySelector('.sp-host') ||
      (shell && shell.querySelector('.sp-host')) ||
      document.createElement('div'); // 호스트 없는 변형에서도 classList 호출이 안전하도록
    this.textEl = stage.querySelector('.sp-text');
    this.captionBox = stage.querySelector('.sp-caption .box');
    this.capWrap = stage.querySelector('.sp-caption');
    this.cardEl = stage.querySelector('.sp-card'); // 씬 타이포 카드 오버레이
    this.pointerEl = stage.querySelector('.sp-pointer'); // 손가락 포인터
    this.capBtn = this.ctl.querySelector('.sp-cap');
    // 자막 위치 모드: 'overlay'(이미지 위 스크림) | 'safe'(이미지 아래 전용 띠)
    // 기본값 safe: 이미지를 안 가리는 CC 띠가 기본. localStorage에 저장된 선택이 있으면 그걸 우선.
    this.capMode = 'safe';
    try {
      var savedCap = localStorage.getItem('sp-cap-mode');
      if (savedCap === 'safe' || savedCap === 'overlay') this.capMode = savedCap;
    } catch (e) {}
    // 호스트(로지) 캐릭터 표시/숨김. localStorage에 저장 → 다른 페이지·재접속에도 유지.
    this.hostToggleBtn = this.ctl.querySelector('.sp-host-toggle');
    this.hostHidden = false;
    try { this.hostHidden = localStorage.getItem('sp-host-hidden') === '1'; } catch (e) {}
    if (this.host) this.host.classList.toggle('is-hidden', this.hostHidden);
    this._setHostIcon(this.hostHidden);
    this.fill = this.ctl.querySelector('.sp-progress-fill');
    this.ticks = this.ctl.querySelector('.sp-ticks');
    this.progress = this.ctl.querySelector('.sp-progress');
    this.timeEl = this.ctl.querySelector('.sp-time');
    this.bigplay = stage.querySelector('.sp-bigplay'); // 센터 재생버튼은 스테이지 내부 유지(영상 위 오버레이)

    // state
    this.i = -1;
    this.playing = false;
    this.started = false;
    this.autostarted = false;
    this._curVis = 'closed'; // 현재 글자(닫힘/모음) — 공백이면 입 다뭄
    // 음소거로 시작하지 않는다: <audio>는 muted 여도 자동재생이 막히므로 음소거 시작은
    // 이득이 없고, 정책이 허용되는 경우(재방문·이전 상호작용 있음)에도 소리를 잃었다.
    // 차단되면 영상만 벽시계로 진행하고 첫 탭에서 unlockAudio()가 소리를 켠다.
    this.muted = false;
    this.userMuted = false; // 사용자가 음소거 버튼을 직접 누른 경우
    this.sceneStart = 0; // performance.now() 기준 (무음 경로)
    this.pausedAt = 0;
    this.activeBg = 'a';
    this.audio = null; // 현재 씬 voice 오디오
    /* 다음 씬 자산 선반입. 없으면 씬이 바뀔 때마다 그 자리에서 받게 되는데,
       씬 배경이 최대 600KB대라 **빈 화면으로 크로스페이드된 뒤 늦게 뜨는** 끊김이 생긴다.
       오디오도 마찬가지로 늦게 시작돼, 'playing' 시점의 재앵커가 자막을 0초로 되돌려 튄다. */
    this._pre = { imgUrl: '', img: null, voiceUrl: '', voice: null };
    this.durations = []; // 무음 경로 예상 지속시간(진행바 계산용)

    this._precompute();
    this._buildTicks();
    this._bindControls();
    this._observe();

    // 초기: 첫 씬 배경/정지 표시 (재생 전에도 콘텐츠 노출)
    this._paintScene(0, true);
    this._preloadNext(-1);   // 첫 씬 자산 선반입(재생 버튼을 누른 순간 바로 뜨도록)
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
      // 음성이 있으면 자막을 음성 길이의 앞 30%에 걸쳐 빠르게 노출(이후 말 끝날 때까지 유지)
      return this.audio.duration * 1000 * 0.30;
    }
    return Math.max(TYPE_MIN, plainText(sc.text).length * PER_CHAR);
  };
  Player.prototype._sceneDuration = function () {
    if (this.audio && this.audio.duration) return this.audio.duration * 1000;
    return this.durations[this.i];
  };
  // 오디오 시계를 신뢰할 수 있는가 = 지금 '실제로 흐르는 중'인가.
  // ⚠️ 브라우저 자동재생 정책상 <audio>는 muted 여도 사용자 활성화 없이 재생되지 않는다
  //    (muted 예외는 <video> 전용). play()가 거부되면 audio는 paused·currentTime=0 에
  //    머무는데, 예전엔 duration만 잡히면 그걸 시간 소스로 써서 자막·진행바·씬전환이
  //    전부 0초에 얼어붙었다("새로고침하면 영상이 재시작을 안 함"의 원인).
  //    → 오디오가 멈춰 있으면 벽시계로 진행한다. duration(길이)은 계속 신뢰해도 된다.
  Player.prototype._audioLive = function () {
    var a = this.audio;
    return !!(a && a.duration && !a.paused && !a.ended);
  };
  Player.prototype._sceneElapsed = function () {
    if (this._audioLive()) return this.audio.currentTime * 1000;
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

    // 지금 다루는 게임 이름(추천·가이드 편). 없는 씬에서는 배지를 숨긴다.
    if (this.gameTitleEl) {
      var gt = sc.gameTitle || '';
      this.gameTitleEl.firstElementChild.textContent = gt;
      this.gameTitleEl.classList.toggle('is-on', !!gt);
    }

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

  /* 다음 씬 자산을 미리 받아 둔다(이미지 + 음성).
     이미지는 브라우저 캐시에만 올려 두면 되고(그리는 건 _paintScene 이 한다),
     음성은 만들어 둔 <audio> 를 그대로 재사용해 씬 진입 즉시 play() 가 붙게 한다. */
  Player.prototype._preloadNext = function (idx) {
    var nx = this.scenes[idx + 1];
    if (!nx) return;
    if (nx.image && this._pre.imgUrl !== nx.image) {
      var im = new Image();
      im.decoding = 'async';
      im.src = nx.image;
      this._pre.imgUrl = nx.image;
      this._pre.img = im;
    }
    if (nx.voice && this._pre.voiceUrl !== nx.voice) {
      var au = new Audio();
      au.preload = 'auto';
      au.muted = this.muted;
      au.src = nx.voice;
      try { au.load(); } catch (e) {}
      this._pre.voiceUrl = nx.voice;
      this._pre.voice = au;
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
    // 자막 동적 폰트: CSS vw(해상도) 스케일 × 텍스트 길이 보정(길수록 축소 → 박스에 맞춤)
    if (this.captionBox) {
      var _len = plainText(sc.text || '').length;
      var _scale = _len <= 34 ? 1 : Math.max(0.68, 34 / _len);
      this.captionBox.style.fontSize =
        'calc(clamp(0.95rem, 2.2vw, 1.35rem) * ' + _scale.toFixed(2) + ')';
    }
    this.sceneStart = performance.now(); // 벽시계 기준(오디오가 못 돌 때의 시간 소스)
    if (sc.voice) {
      var self = this;
      // 선반입해 둔 오디오가 있으면 그대로 쓴다(네트워크 왕복이 없어 즉시 재생된다).
      var a;
      if (this._pre.voice && this._pre.voiceUrl === sc.voice) {
        a = this._pre.voice;
        this._pre.voice = null; this._pre.voiceUrl = '';
        try { a.currentTime = 0; } catch (e) {}
      } else {
        a = new Audio(sc.voice);
      }
      this.audio = a;
      a.muted = this.muted;
      Lip.attach(a); // 파형 분석기 연결(컨텍스트가 살아 있을 때만 — 아니면 순환 폴백)
      // 재생이 실제로 시작되면 오디오 시계로 자연 전환 — 두 시계가 어긋나지 않게 원점을 맞춘다.
      a.addEventListener('playing', function () {
        if (self.audio !== a) return;
        /* ⚠️ 무조건 재앵커하면 **자막이 뒤로 튄다.** 오디오가 늦게(네트워크 대기) 시작되면
           그동안 벽시계로 진행한 만큼을 currentTime≈0 으로 되돌려 버리기 때문이다.
           앞으로 감는(=오디오가 이미 앞서 있는) 경우만 맞추고, 되감기는 하지 않는다. */
        var anchored = performance.now() - a.currentTime * 1000;
        if (anchored < self.sceneStart) self.sceneStart = anchored;
        self._syncSound();
      });
      var pr = a.play();
      if (pr && pr.catch)
        pr.catch(function () {
          // 자동재생 차단 — 영상은 벽시계로 계속 진행하고, 첫 사용자 활성화 제스처에서
          // unlockAudio()가 이 씬을 처음부터 소리와 함께 다시 태운다.
          if (self.audio === a) self._syncSound();
        });
    }
    this._syncSound();
    this._updateActiveChapter(idx);
    this._preloadNext(idx);   // 현재 씬이 재생되는 동안 다음 씬 자산을 받아 둔다
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
    }
    if (this.capWrap) this.capWrap.classList.toggle('is-empty', reveal === 0);
    var isTyping = elapsed < typingDur && reveal < plen;
    this.stage.classList.toggle('is-typing', isTyping);

    // 말하는 동안 입 뻐끔: 음성이 있으면 '음성 재생 내내', 없으면 타이핑 중.
    // → 자막은 빨리 다 뜨고(typingDur 짧음) 말 끝날 때까지 유지되며, 그동안 입은 계속 움직인다.
    var speaking = (this.audio && this.audio.duration)
      ? (!this.audio.paused && this.audio.currentTime < this.audio.duration - 0.05)
      : isTyping;
    this.host.classList.toggle('is-talking', speaking);
    if (speaking) {
      /* 1순위: 실제 파형 — 목소리가 큰 만큼 입이 벌어지고, 쉼표에서 다물린다.
         폴백(분석기 미연결): 예전처럼 모음을 순환시키고 사인으로 여닫는다. */
      var lip = Lip.read(this.audio, performance.now());
      if (lip) {
        this.host.setAttribute('data-viseme', lip.vis);
        this.host.style.setProperty('--mopen', (0.30 + 0.70 * lip.open).toFixed(3));
      } else {
        var vis = MOUTH_SEQ[Math.floor(elapsed / MOUTH_BEAT) % MOUTH_SEQ.length];
        this.host.setAttribute('data-viseme', vis);
        var wave = 0.5 - 0.5 * Math.cos((elapsed / MOUTH_OPEN_PERIOD) * 6.2831853); // 0..1 부드럽게
        this.host.style.setProperty('--mopen', (0.45 + 0.55 * wave).toFixed(3)); // 0.45~1.0
      }
    } else {
      this.host.setAttribute('data-viseme', 'closed');
      this.host.style.setProperty('--mopen', String(MOUTH_OPEN.closed));
    }

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
    this._syncSound();
  };

  // ── 컨트롤 ────────────────────────────────────────────────
  Player.prototype.play = function () {
    Lip.resume(); // 제스처 안에서만 AudioContext 가 살아난다(립싱크 분석기 전제조건)
    if (this.playing) {
      // 영상은 (벽시계로) 도는데 자동재생 차단으로 오디오만 멈춘 상태 —
      // 예전엔 여기서 그냥 return 해서 재생버튼을 눌러도 아무 일도 안 났다.
      if (this.audio && this.audio.paused) this.unlockAudio();
      return;
    }
    if (this.stage.classList.contains('is-ended') || this.i < 0) {
      this._enterScene(0);
    } else {
      // resume: sceneStart 보정
      this.sceneStart = performance.now() - this.pausedAt;
      if (this.audio) {
        var self = this;
        var pr = this.audio.play();
        // 재개가 거부될 수도 있으므로(활성화 없는 재개) 성패 양쪽에서 토글 표시를 맞춘다
        if (pr && pr.then) pr.then(function () { self._syncSound(); }, function () { self._syncSound(); });
      }
    }
    this.playing = true;
    this.started = true;
    this.stage.classList.remove('is-paused', 'is-ended');
    if (this.bigplay) this.bigplay.classList.add('is-hidden');
    this._setPlayIcon(true);
    this._syncSound();
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
    if (this.bigplay) this.bigplay.classList.remove('is-hidden'); // 일시정지 시 중앙 재생버튼 노출(재개 가능)
    this._setPlayIcon(false);
    this._syncSound(); // 정지 중엔 토글이 '차단'이 아니라 사용자 음소거 설정을 가리킨다
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

  Player.prototype.setMuted = function (m, byUser) {
    this.muted = m;
    if (byUser) this.userMuted = m; // 사용자가 직접 고른 음소거는 자동으로 해제하지 않는다
    if (this.audio) this.audio.muted = m;
    this._syncSound();
  };

  // 사운드 토글이 가리켜야 하는 진실 = "지금 실제로 소리가 나고 있나".
  // 자동재생이 차단돼 오디오가 못 도는 동안은 muted 가 아니어도 '꺼짐'으로 표시한다 —
  // 토글이 켜짐인데 무음이면 유저가 속고, 그 상태에서 토글을 누르면 오히려 음소거된다.
  // (paused 기준: play() 직후엔 metadata 로드 전에도 paused=false 라 장면마다 깜빡이지 않는다)
  Player.prototype._soundOff = function () {
    if (this.muted) return true;
    var sc = this.scenes[this.i];
    if (!sc || !sc.voice) return false;
    return !!(this.playing && (!this.audio || this.audio.paused));
  };
  Player.prototype._syncSound = function () {
    var off = this._soundOff();
    this.stage.classList.toggle('is-muted', this.muted);
    this.stage.classList.toggle('is-sound-blocked', off && !this.muted);
    this._setMuteIcon(off);
  };

  // 사운드 언락 — 반드시 사용자 활성화 제스처(클릭/탭/키) 안에서 호출해야 한다.
  // 자동재생이 거부된 씬을 처음부터 다시 태워 자막과 음성 싱크를 맞춘다.
  Player.prototype.unlockAudio = function () {
    Lip.resume();
    if (this.userMuted) return;          // 사용자가 음소거를 원함
    if (this._audioLive()) return;       // 이미 소리가 흐르는 중
    if (this.muted) this.setMuted(false);
    var sc = this.scenes[this.i];
    if (!this.playing || !sc || !sc.voice) return;
    this._enterScene(this.i);
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
  // ── 호스트(로지) 표시/숨김 ────────────────────────────────
  Player.prototype.setHostHidden = function (hidden, save) {
    this.hostHidden = !!hidden;
    if (this.host) this.host.classList.toggle('is-hidden', this.hostHidden);
    this._setHostIcon(this.hostHidden);
    if (save) { try { localStorage.setItem('sp-host-hidden', this.hostHidden ? '1' : '0'); } catch (e) {} }
  };
  Player.prototype.toggleHost = function () { this.setHostHidden(!this.hostHidden, true); };
  Player.prototype._setHostIcon = function (hidden) {
    var b = this.hostToggleBtn;
    if (!b) return;
    b.classList.toggle('is-off', !!hidden);
    b.setAttribute('title', hidden ? '호스트 표시' : '호스트 숨기기');
    b.setAttribute('aria-pressed', hidden ? 'true' : 'false');
    // 숨김 상태엔 사람 아이콘에 사선(/)을 얹어 'off'를 표시
    b.innerHTML = hidden
      ? '<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="8" r="4"/><path d="M4 20c0-4.4 3.6-7 8-7s8 2.6 8 7z"/><line x1="3" y1="21" x2="21" y2="3" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>'
      : '<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="8" r="4"/><path d="M4 20c0-4.4 3.6-7 8-7s8 2.6 8 7z"/></svg>';
  };

  // ── 아이콘 ────────────────────────────────────────────────
  Player.prototype._setPlayIcon = function (playing) {
    var b = this.ctl.querySelector('.sp-play');
    if (!b) return;
    b.innerHTML = playing
      ? '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg>'
      : '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>';
  };
  Player.prototype._setMuteIcon = function (m) {
    var b = this.ctl.querySelector('.sp-mute');
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
      // 음소거 버튼: 사용자 의사(userMuted)를 기록하고, 해제 시엔 실제로 소리를 켠다
      // (클릭 핸들러 = 활성화 제스처이므로 여기서 audio.play()가 통과한다).
      '.sp-mute': function () {
        if (self._soundOff()) {
          // 꺼짐(음소거 or 자동재생 차단) → 켜기. 클릭 = 활성화 제스처라 여기서 오디오가 통과한다.
          self.setMuted(false, true);
          self.unlockAudio();
        } else {
          self.setMuted(true, true);
        }
      },
      '.sp-cap': function () { self.toggleCapMode(); },
      '.sp-host-toggle': function () { self.toggleHost(); },
      '.sp-fs': function () { self.toggleFullscreen(); },
    };
    Object.keys(map).forEach(function (sel) {
      var el = self.ctl.querySelector(sel);
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
    // ── 컨트롤바 자동 숨김/표시 ──
    var isHoverable = !!(window.matchMedia && window.matchMedia('(hover: hover)').matches);
    var hideEl = this.shell || this.stage;
    self._showControls = function () {
      hideEl.classList.remove('controls-hidden');
      clearTimeout(self._hideTimer);
      self._hideTimer = setTimeout(function () {
        if (self.playing) hideEl.classList.add('controls-hidden');
      }, 2600);
    };
    if (isHoverable) {
      // PC: 마우스 움직이면 컨트롤 표시, 벗어나면 숨김
      hideEl.addEventListener('mousemove', self._showControls);
      hideEl.addEventListener('mouseleave', function () {
        clearTimeout(self._hideTimer);
        if (self.playing) hideEl.classList.add('controls-hidden');
      });
    }
    // 스테이지 클릭(컨트롤/버튼 제외)
    this.stage.addEventListener('click', function (e) {
      if (e.target.closest('.sp-controls') || e.target.closest('.sp-bigplay'))
        return;
      // 재생 중인데 소리가 안 나는 상태(자동재생 차단)면 탭은 '소리 켜기'로 쓴다 —
      // 일시정지가 아니라 유튜브 앱처럼 탭 한 번에 소리가 붙는 게 기대 동작.
      if (self.playing && !self.userMuted && !self._audioLive()) {
        self.unlockAudio();
        self._showControls();
        return;
      }
      // 모바일: 컨트롤 숨김 상태면 터치 → 컨트롤만 표시(일시정지 안 함)
      if (!isHoverable && hideEl.classList.contains('controls-hidden')) {
        self._showControls();
        return;
      }
      if (self.started) self.toggle();
      else self.play();
      self._showControls();
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
    this.setCapMode(this.capMode, true);
    this._syncSound();
  };

  Player.prototype._observe = function () {
    var self = this;
    if (reduceMotion || !('IntersectionObserver' in window)) return;
    var io = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (en) {
          if (
            en.isIntersecting &&
            en.intersectionRatio >= 0.4 &&
            !self.autostarted
          ) {
            self.autostarted = true;
            self.play();
            if (self._showControls) self._showControls();
          }
          // 스크롤로 화면 밖으로 나가도 계속 재생(자동 일시정지 제거)
        });
      },
      { threshold: [0, 0.2, 0.4] }
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
    armSound();
  }

  // 첫 사용자 활성화 제스처에 음성을 켠다.
  // ⚠️ 'wheel'/'touchstart' 는 user activation 을 부여하지 않는 이벤트다. 예전엔 이 둘까지
  //    once:true 로 걸어놔서 "스크롤 한 번"에 무장이 소진되고, 정작 소리를 켤 수 있는
  //    탭/클릭 시점에는 아무 시도도 하지 않아 영상이 끝까지 무음이었다.
  //    → 활성화를 주는 이벤트만 쓰고, 실제로 소리가 흐르는 게 확인될 때까지 유지한다.
  //    버블 단계라 컨트롤 버튼(핸들러가 stopPropagation)의 클릭은 여기까지 오지 않는다.
  function armSound() {
    var EVENTS = ['pointerup', 'click', 'touchend', 'keydown'];
    function players() {
      return Array.prototype.map
        .call(document.querySelectorAll('.sp-stage'), function (st) { return st.__sp; })
        .filter(Boolean);
    }
    function on() {
      var list = players();
      list.forEach(function (sp) { sp.unlockAudio(); });
      // play()는 비동기라 즉시 판정이 안 된다 — 다음 제스처에서 재확인하고,
      // 소리가 확인되면(또는 사용자가 음소거를 골랐으면) 리스너를 뗀다.
      var settled = list.every(function (sp) { return sp.userMuted || sp._audioLive(); });
      if (settled)
        EVENTS.forEach(function (ev) { document.removeEventListener(ev, on); });
    }
    EVENTS.forEach(function (ev) { document.addEventListener(ev, on, { passive: true }); });
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
