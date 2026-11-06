// 유튜브 자막을 읽어 아래에 한글 발음(및 선택 시 번역)을 표시
(() => {
  if (window.__ykpronLoaded) return;
  window.__ykpronLoaded = true;

  const settings = { enabled: true, showPron: true, showTrans: false, lyricsMode: true, showOrig: true, scale: 0.85, color: '#ffe066' };
  const RE_HANGUL = /[\uac00-\ud7a3]/;
  let lyr = { vid: '', status: 'idle', pkg: null, matcher: null, lastText: '', lastMatch: null };
  const cache = new Map();
  const inflight = new Set();
  const failedAt = new Map();
  let overlay = null;
  let player = null;
  let container = null;
  let lift = 0;
  let rafId = 0;
  let lastRender = '';
  let shownText = '';
  let debounceTimer = 0;
  let observer = null;
  let alive = true;
  let lastShownAt = 0;
  let lastReq = { vid: '', title: '' };

  try {
    chrome.storage.sync.get(settings, (s) => {
      if (chrome.runtime.lastError) return;
      Object.assign(settings, s);
      lastRender = '';
      schedule();
    });
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'sync') return;
      for (const k of Object.keys(changes)) if (k in settings) settings[k] = changes[k].newValue;
      lastRender = '';
      schedule();
    });
  } catch (e) { /* 확장 컨텍스트 없음 */ }

  function findPlayer() {
    const players = document.querySelectorAll('.html5-video-player');
    for (const p of players) {
      if (!p.querySelector('.ytp-caption-segment')) continue;
      const r = p.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) return p;
    }
    return null;
  }

  function readCaption(p) {
    const windows = [...p.querySelectorAll('.caption-window')].filter((w) => w.offsetParent !== null);
    const parts = [];
    let rect = null;
    for (const win of windows) {
      const segs = win.querySelectorAll('.ytp-caption-segment');
      if (!segs.length) continue;
      const lines = win.querySelectorAll('.caption-visual-line');
      const src = lines.length ? lines : [win];
      for (const line of src) {
        const t = [...line.querySelectorAll('.ytp-caption-segment')].map((s) => s.textContent).join('');
        if (t.trim()) parts.push(t.trim());
      }
      const r = win.getBoundingClientRect();
      rect = rect
        ? { left: Math.min(rect.left, r.left), right: Math.max(rect.right, r.right), top: Math.min(rect.top, r.top), bottom: Math.max(rect.bottom, r.bottom) }
        : { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
    }
    // 원문 줄과 한국어 번역 줄이 함께 있는 자막이면 원문 줄만 발음 변환에 쓴다
    const RE_SRC = /[\u3040-\u30ff\u3400-\u9fff]/;
    const srcParts = parts.filter((t) => RE_SRC.test(t) && !/[\uac00-\ud7a3]/.test(t));
    const koParts = parts.filter((t) => /[\uac00-\ud7a3]/.test(t));
    const text = (srcParts.length && koParts.length ? srcParts : parts).join(' ').replace(/\s+/g, ' ').trim();
    const seg = p.querySelector('.ytp-caption-segment');
    const fontSize = seg ? parseFloat(getComputedStyle(seg).fontSize) || 18 : 18;
    const host = windows.length ? windows[0].closest('.ytp-caption-window-container') : null;
    return { text, rect, fontSize, host };
  }

  function ensureOverlay(p) {
    if (overlay && overlay.parentNode === p) return overlay;
    if (overlay) overlay.remove();
    overlay = document.createElement('div');
    overlay.className = 'ykpron-overlay';
    overlay.setAttribute('aria-hidden', 'true');
    p.appendChild(overlay);
    return overlay;
  }

  function setLift(px) {
    px = Math.round(px);
    if (px === lift) return;
    lift = px;
    if (container) container.style.translate = px ? `0 ${-px}px` : '';
  }

  // mode: 'hard' 완전 해제 / 'gap' 자막 없음(2.5초 지나면 높이 해제) / 'keep' 자막은 있는데 보여 줄 발음이 없음(높이 유지)
  // → 줄이 바뀌거나 매칭 안 되는 줄이 나와도 유튜브 자막이 위아래로 튀지 않는다
  function hide(mode = 'hard') {
    if (overlay) overlay.style.display = 'none';
    if (mode === 'hard' || (mode === 'gap' && Date.now() - lastShownAt > 2500)) setLift(0);
    shownText = '';
    lastRender = '';
  }
  const softHide = () => hide('keep');

  function request(text) {
    if (inflight.has(text) || !alive) return;
    const f = failedAt.get(text);
    if (f && Date.now() - f < 3000) return;
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      // 자동 생성 자막처럼 글자가 계속 늘어나는 경우 마지막 상태만 요청
      if (!player || readCaption(player).text !== text) return;
      inflight.add(text);
      try {
        chrome.runtime.sendMessage({ type: 'convert', text }, (res) => {
          inflight.delete(text);
          if (chrome.runtime.lastError || !res) {
            failedAt.set(text, Date.now());
            return;
          }
          cache.set(text, res);
          if (cache.size > 400) cache.delete(cache.keys().next().value);
          schedule();
        });
      } catch (e) {
        inflight.delete(text);
        alive = false; // 확장 프로그램이 다시 로드됨 → 페이지 새로고침 필요
        hide();
      }
    }, 100);
  }

  // 유튜브는 시작·광고 전환 때 자막 컨테이너를 새로 만든다 → 매 프레임 실제 자막이 들어 있는 컨테이너를 쓴다
  function attach(p, host) {
    const next = host || (p ? p.querySelector('.ytp-caption-window-container') : null);
    if (p === player && next === container) return;
    if (container) container.style.translate = '';
    if (next && lift) next.style.translate = `0 ${-lift}px`;
    player = p;
    container = next;
    if (observer) observer.disconnect();
    if (container) {
      observer = new MutationObserver(schedule);
      observer.observe(container, { childList: true, subtree: true, characterData: true });
    }
  }

  function currentVideoId() {
    const u = new URL(location.href);
    const v = u.searchParams.get('v');
    if (v) return v;
    const m = u.pathname.match(/\/(?:embed|shorts|live)\/([\w-]{6,})/);
    return m ? m[1] : '';
  }

  function videoMeta(p) {
    const h1 = document.querySelector('ytd-watch-metadata h1, h1.ytd-watch-metadata, #title h1');
    const embedTitle = p.querySelector('.ytp-title-link');
    const title = ((h1 && h1.textContent) || (embedTitle && embedTitle.textContent) || document.title || '')
      .replace(/^\(\d+\)\s*/, '').replace(/\s*-\s*YouTube\s*$/i, '').trim();
    const ch = document.querySelector('ytd-watch-metadata ytd-channel-name a, #owner ytd-channel-name a');
    const video = p.querySelector('video');
    return { title, channel: ch ? ch.textContent.trim() : '', duration: video && isFinite(video.duration) ? video.duration : 0 };
  }

  function ensureLyrics(p) {
    const vid = currentVideoId();
    if (!vid) return null;
    if (lyr.vid !== vid) lyr = { vid, status: 'idle', pkg: null, matcher: null, lastText: '', lastMatch: null, since: Date.now(), retryAt: 0 };
    if (lyr.status !== 'idle' || !alive || Date.now() < lyr.retryAt) return lyr;
    // 재생목록 자동재생 직후 이전 영상 제목을 읽지 않도록, 페이지가 새 영상으로 바뀐 뒤에 요청
    const flexy = document.querySelector('ytd-watch-flexy');
    if (flexy && flexy.getAttribute('video-id') && flexy.getAttribute('video-id') !== vid) return lyr;
    const meta = videoMeta(p);
    if (!meta.title) return lyr;
    // 영상이 바뀌었는데 제목이 아직 이전 영상 그대로면 최대 4초 기다린다
    if (lastReq.vid && lastReq.vid !== vid && meta.title === lastReq.title && Date.now() - lyr.since < 4000) return lyr;
    lastReq = { vid, title: meta.title };
    lyr.status = 'loading';
    const mine = lyr;
    try {
      chrome.runtime.sendMessage({ type: 'lyrics', videoId: vid, ...meta }, (res) => {
        if (lyr !== mine) return;
        if (chrome.runtime.lastError || !res) { mine.status = 'idle'; mine.retryAt = Date.now() + 5000; return; } // 일시 오류 → 재시도
        if (!res.pkg) { mine.status = 'none'; return; }
        mine.pkg = res.pkg;
        mine.matcher = globalThis.YKMatch.createMatcher(res.pkg.lines);
        mine.status = 'ready';
        mine.lastText = '';
        schedule();
      });
    } catch (e) {
      alive = false;
      hide();
    }
    return lyr;
  }

  function schedule() {
    if (!rafId) rafId = requestAnimationFrame(update);
  }

  function update() {
    rafId = 0;
    if (!alive) return;
    const p = findPlayer();
    if (!settings.enabled || !p) { attach(p, null); return hide(); }
    // 광고 중에는 광고 자막을 무시
    if (p.classList.contains('ad-showing') || p.classList.contains('ad-interrupting')) { attach(p, null); return hide(); }
    const { text, rect, fontSize, host } = readCaption(p);
    attach(p, host);
    if (!text || !rect) return hide('gap');
    if (lift) lastShownAt = Date.now(); // 자막이 떠 있는 동안은 높이 유지 (자막이 사라지고 2.5초 뒤 해제)

    let lines = null;
    // 번역 자막(한국어)이면 원문 가사를 찾아 해당 줄의 발음을 보여 준다
    if (settings.lyricsMode && RE_HANGUL.test(text)) {
      const video = p.querySelector('video');
      const st = ensureLyrics(p);
      if (st && st.status === 'ready') {
        if (st.lastText !== text) {
          st.lastText = text;
          st.lastMatch = st.matcher.match(text, video ? video.currentTime : undefined);
        }
        const m = st.lastMatch;
        if (m) {
          const line = st.pkg.lines[m.index];
          lines = [];
          if (settings.showPron && line.pron) lines.push(['ykpron-pron', line.pron]);
          if (settings.showOrig && line.text) lines.push(['ykpron-orig', line.text]);
          shownText = '';
        }
      }
    }

    if (!lines) {
      let res = cache.get(text);
      if (!res) {
        request(text);
        // 이어지는 자막(글자 추가)일 때만 직전 결과를 유지하고, 아니면 숨긴다
        if (!(shownText && text.startsWith(shownText))) return softHide();
        res = cache.get(shownText);
        if (!res) return softHide();
      } else {
        shownText = text;
      }
      lines = [];
      if (settings.showPron && res.pron) lines.push(['ykpron-pron', res.pron]);
      if (settings.showTrans && res.translation) lines.push(['ykpron-trans', res.translation]);
    }
    if (!lines.length) return softHide();

    const el = ensureOverlay(p);
    const pr = p.getBoundingClientRect();
    const size = Math.max(10, fontSize * (Number(settings.scale) || 0.85));
    const key = JSON.stringify([lines, size, settings.color, Math.round(pr.width)]);
    if (key !== lastRender) {
      lastRender = key;
      el.textContent = '';
      for (const [cls, str] of lines) {
        const span = document.createElement('div');
        span.className = cls;
        span.textContent = str;
        el.appendChild(span);
      }
      el.style.fontSize = size + 'px';
      el.style.setProperty('--ykpron-color', settings.color || '#ffe066');
      el.style.maxWidth = Math.round(pr.width * 0.92) + 'px';
    }
    el.style.display = 'block';
    lastShownAt = Date.now();

    // 자막 바로 아래에 배치. 화면 밖으로 나가면 자막 전체를 위로 올린다.
    const gap = Math.round(size * 0.25);
    const h = el.offsetHeight;
    const controlsVisible = !p.classList.contains('ytp-autohide');
    const chrome_ = p.querySelector('.ytp-chrome-bottom');
    const bottomReserve = controlsVisible && chrome_ ? chrome_.offsetHeight + 8 : 6;
    const baseBottom = rect.bottom + lift - pr.top; // 들어올리기 전 자막 아래 위치
    const limit = pr.height - bottomReserve;
    let need = Math.max(0, Math.min(baseBottom + gap + h - limit, baseBottom - h));
    // 표시 중에는 올리기만 한다(두 줄↔한 줄 자막 전환 때 미세하게 흔들리지 않게)
    if (lift && overlay.dataset.shownAt && Date.now() - Number(overlay.dataset.shownAt) < 2500) need = Math.max(need, lift);
    overlay.dataset.shownAt = String(Date.now());
    setLift(need);
    const center = (rect.left + rect.right) / 2 - pr.left;
    const half = el.offsetWidth / 2;
    const left = Math.min(Math.max(center, half + 4), pr.width - half - 4);
    el.style.top = Math.round(baseBottom - lift + gap) + 'px';
    el.style.left = Math.round(left) + 'px';
  }

  setInterval(schedule, 250);
  window.addEventListener('resize', schedule);
  document.addEventListener('fullscreenchange', schedule);
})();
