/* VIP(playcast) 애드핏 노출 계측 — BaseLayout 에서 ba.min.js 뒤에 1회 로드.
 *
 * 뭉게의 wp-ad-observe.js 와 같은 목적·같은 이벤트 스키마다(adfit_slot).
 * 매체만 source='vip' 로 갈라 /adfit 에서 뭉게와 나란히 볼 수 있게 한다.
 * VIP 는 앵커(하단 고정) 위주, 뭉게는 인아티클 위주라 서빙 양상이 다를 수 있어
 * 한쪽만 재면 "재로드를 붙일까" 판단이 반쪽이 된다.
 *
 * ⚠️ 계측만 한다. 재시도하지 않는다.
 *
 * 판정 = 두 신호의 합:
 *  ① data-ad-onfail 콜백 — 애드핏이 "광고 없다"고 응답한 경우(nofill)
 *  ② 지연 후 iframe 유무 — ①이 안 오는 무응답·차단 구간(empty)
 *
 * ⚠️ 뷰포트에 들어온 슬롯만, **보이기 시작한 시점부터** 잰다. 애드핏은 display:none
 *    슬롯엔 요청조차 하지 않으므로(PRD-vip-adfit / reference_adfit_serving_rules)
 *    안 보이는 슬롯을 실패로 세면 전부 실패가 된다.
 *    VIP 는 뷰포트 폭으로 top/bottom/anchor 를 갈라 감추므로 특히 중요하다.
 */
(function () {
  var URL_ = 'https://xyprbsmagtlzebxyxsvj.supabase.co/functions/v1/analytics-ingest';
  var NOTRACK = '__notrack';
  var WAIT_MS = 4000;

  try { if (localStorage.getItem(NOTRACK) === '1') return; } catch (e) {}

  // 로컬/사설망 제외 — BaseLayout 트래커와 같은 기준.
  var host = location.hostname;
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '0.0.0.0'
    || /^192\.168\./.test(host) || /^10\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host)) return;

  // 봇 제외도 같은 기준. ⚠️ 애드핏은 headless 에 아예 서빙하지 않아, 봇을 안 빼면
  // 실패율이 통째로 부풀려진다. naver/yandex/baidu 넓은 토큰은 쓰지 않는다(인앱 실유저 오분류).
  var ua = navigator.userAgent || '';
  if (navigator.webdriver ||
    /bot|crawl|spider|headless|lighthouse|playwright|puppeteer|slurp|petalbot|bytespider|yeti|daumoa|googleother|google-inspection/i.test(ua)) return;

  var slug = location.pathname.replace(/^\/watch\//, '').replace(/\/$/, '') || 'home';
  var isMobile = window.matchMedia('(max-width: 767px)').matches;
  var seen = {};

  function placementOf(ins) {
    var anchor = ins.closest && ins.closest('.vad-anchor');
    if (anchor) return 'anchor';
    var vad = ins.closest && ins.closest('.vad');
    return (vad && vad.getAttribute('data-vad')) || 'other';
  }

  function report(ins, result, detail) {
    var unit = ins.getAttribute('data-ad-unit');
    if (!unit || seen[unit]) return;
    seen[unit] = 1;
    var body = JSON.stringify({
      event_type: 'adfit_slot',
      source: 'vip',
      metadata: {
        unit: unit, result: result, detail: detail || '', slug: slug,
        device: isMobile ? 'mobile' : 'pc',
        placement: placementOf(ins),
        path: location.pathname
      }
    });
    try {
      if (navigator.sendBeacon(URL_, new Blob([body], { type: 'application/json' }))) return;
    } catch (e) {}
    fetch(URL_, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body, keepalive: true })
      .catch(function () {});
  }

  window.vipAdFail = function (el) {
    try { if (el && el.getAttribute) report(el, 'nofill', 'onfail'); } catch (e) {}
  };

  function watch() {
    var slots = document.querySelectorAll('ins.kakao_ad_area');
    if (!slots.length) return;

    for (var i = 0; i < slots.length; i++) {
      if (!slots[i].getAttribute('data-ad-onfail')) slots[i].setAttribute('data-ad-onfail', 'vipAdFail');
    }

    var check = function (ins) {
      if (seen[ins.getAttribute('data-ad-unit')]) return;
      report(ins, ins.querySelector('iframe') ? 'filled' : 'empty', 'timeout' + WAIT_MS);
    };

    if (!('IntersectionObserver' in window)) {
      setTimeout(function () {
        for (var j = 0; j < slots.length; j++) {
          var r = slots[j].getBoundingClientRect();
          if (r.top < window.innerHeight && r.bottom > 0) check(slots[j]);
        }
      }, WAIT_MS);
      return;
    }

    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (!en.isIntersecting) return;
        io.unobserve(en.target);
        setTimeout(function () { check(en.target); }, WAIT_MS);
      });
    }, { rootMargin: '0px' });

    for (var k = 0; k < slots.length; k++) io.observe(slots[k]);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', watch);
  else watch();
})();
