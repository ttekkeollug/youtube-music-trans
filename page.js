// 페이지(MAIN world)에서 실행: 플레이어 정보 제공 + 플레이어가 쓰는 자막 URL 확보
// 확장 프로그램 쪽 content.js 와 window.postMessage 로만 통신한다.
(() => {
  if (window.__ykpMain) return;
  window.__ykpMain = true;

  const urls = new Map(); // videoId → 플레이어가 요청한 timedtext URL (pot 토큰 포함)

  function post(msg) {
    window.postMessage({ source: 'ykp-main', ...msg }, location.origin);
  }

  function note(u) {
    try {
      const x = new URL(String(u), location.href);
      if (!x.pathname.endsWith('/api/timedtext')) return;
      const v = x.searchParams.get('v');
      if (!v) return;
      urls.set(v, x.href);
      post({ type: 'timedtext', videoId: v, url: x.href });
    } catch (e) { /* 무시 */ }
  }

  // 플레이어의 자막 요청 URL 관찰 (fetch·XHR·리소스 타이밍 모두)
  const origFetch = window.fetch;
  window.fetch = function (input, init) {
    try { note(typeof input === 'string' ? input : input && input.url); } catch (e) { /* 무시 */ }
    return origFetch.apply(this, arguments);
  };
  const origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    try { note(url); } catch (e) { /* 무시 */ }
    return origOpen.apply(this, arguments);
  };
  try {
    new PerformanceObserver((list) => list.getEntries().forEach((e) => note(e.name)))
      .observe({ type: 'resource', buffered: true });
  } catch (e) { /* 무시 */ }

  function getPlayer() {
    const cands = [document.querySelector('#shorts-player'), document.querySelector('#movie_player'), ...document.querySelectorAll('.html5-video-player')];
    for (const p of cands) {
      if (!p || typeof p.getPlayerResponse !== 'function') continue;
      const r = p.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) return p;
    }
    return null;
  }

  function info() {
    const p = getPlayer();
    let pr = null;
    try { pr = p && p.getPlayerResponse(); } catch (e) { pr = null; }
    if (!pr || !pr.videoDetails) return null;
    const vd = pr.videoDetails;
    const tl = pr.captions && pr.captions.playerCaptionsTracklistRenderer;
    const mf = pr.microformat && pr.microformat.playerMicroformatRenderer;
    return {
      videoId: vd.videoId,
      title: vd.title || '',
      author: vd.author || '',
      duration: Number(vd.lengthSeconds) || 0,
      isLive: !!vd.isLive,
      category: (mf && mf.category) || '',
      ad: p.classList.contains('ad-showing'),
      tracks: ((tl && tl.captionTracks) || []).map((t) => ({
        lang: t.languageCode,
        kind: t.kind || '',
        name: (t.name && (t.name.simpleText || (t.name.runs || []).map((r) => r.text).join(''))) || '',
      })),
      url: urls.get(vd.videoId) || null,
    };
  }

  // 자막이 꺼져 있을 때: 자막 영역을 숨긴 채 자막 모듈을 잠깐 불러와 URL만 얻고 원래대로 되돌린다
  let priming = null;
  function prime() {
    if (priming) return priming;
    priming = (async () => {
      const p = getPlayer();
      const i = info();
      if (!p || !i || !i.tracks.length || i.ad) return null;
      if (urls.get(i.videoId)) return urls.get(i.videoId);
      let wasOn = false;
      try { const t = p.getOption('captions', 'track'); wasOn = !!(t && t.languageCode); } catch (e) { /* 무시 */ }
      const wait = async (ms) => {
        const end = Date.now() + ms;
        while (Date.now() < end) {
          if (urls.get(i.videoId)) return urls.get(i.videoId);
          await new Promise((r) => setTimeout(r, 150));
        }
        return urls.get(i.videoId) || null;
      };
      if (wasOn) return wait(3000);
      const style = document.createElement('style');
      style.textContent = '.ytp-caption-window-container{visibility:hidden!important}';
      document.documentElement.appendChild(style);
      try {
        p.loadModule('captions');
        const list = p.getOption('captions', 'tracklist') || [];
        if (list[0]) p.setOption('captions', 'track', list[0]);
        return await wait(4000);
      } finally {
        try { p.unloadModule('captions'); } catch (e) { /* 무시 */ }
        setTimeout(() => style.remove(), 400);
      }
    })().finally(() => setTimeout(() => { priming = null; }, 0));
    return priming;
  }

  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data || e.data.source !== 'ykp-iso') return;
    const { id, type } = e.data;
    if (type === 'info') post({ type: 'reply', id, data: info() });
    else if (type === 'prime') prime().then((u) => post({ type: 'reply', id, data: u }), () => post({ type: 'reply', id, data: null }));
  });
})();
