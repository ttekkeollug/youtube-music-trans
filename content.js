// 유튜브 자막을 읽어 한글 발음 표시 + 자막 없는 영상 모드
(() => {
  if (window.__ykpronLoaded) return;
  window.__ykpronLoaded = true;

  const DEFAULTS = {
    enabled: true, showPron: true, showTrans: false, lyricsMode: true, showOrig: true,
    origFallback: true, noCapMode: true, noCapAsr: false, scale: 0.85, color: '#ffe066',
  };
  const settings = { ...DEFAULTS };
  const RE_HANGUL = /[가-힣]/;
  const RE_SRC = /[぀-ヿ㐀-鿿]/;
  const T = globalThis.YKTrack;

  const cache = new Map();      // 자막 줄 → {pron, translation}
  const inflight = new Set();
  const failedAt = new Map();
  const baseUrls = new Map();   // videoId → 플레이어가 쓴 자막 URL
  let overlay = null, toast = null, toastTimer = 0;
  let player = null, container = null, observer = null;
  let lift = 0, rafId = 0, lastRender = '', shownText = '', debounceTimer = 0, lastShownAt = 0;
  let alive = true;
  let lastReq = { vid: '', title: '' };
  let vs = newVideoState('');

  function newVideoState(vid) {
    return {
      vid, since: Date.now(), info: null, infoAt: 0,
      lyr: { status: 'idle', pkg: null, matcher: null, lastText: '', lastMatch: null, retryAt: 0 },
      orig: { status: 'idle', cues: null, retryAt: 0 },
      align: { status: 'idle', offset: 0, confident: false },
      manualOffset: 0, manualLoaded: false,
    };
  }

  // ── 설정 ──
  try {
    chrome.storage.sync.get(DEFAULTS, (s) => {
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
  } catch (e) { alive = false; }

  // ── 페이지(page.js)와 통신 ──
  let askSeq = 0;
  const pending = new Map();
  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data || e.data.source !== 'ykp-main') return;
    const d = e.data;
    if (d.type === 'timedtext' && typeof d.videoId === 'string' && typeof d.url === 'string') {
      baseUrls.set(d.videoId, d.url);
    } else if (d.type === 'reply' && pending.has(d.id)) {
      pending.get(d.id)(d.data);
      pending.delete(d.id);
    }
  });
  function ask(type, timeout = 1500) {
    return new Promise((resolve) => {
      const id = 'k' + (++askSeq);
      const timer = setTimeout(() => { pending.delete(id); resolve(null); }, timeout);
      pending.set(id, (data) => { clearTimeout(timer); resolve(data); });
      window.postMessage({ source: 'ykp-iso', id, type }, location.origin);
    });
  }
  function refreshInfo() {
    const now = Date.now();
    if (vs.info && vs.info.videoId === vs.vid && now - vs.infoAt < 5000) return;
    if (now - vs.infoAt < 1000) return;
    vs.infoAt = now;
    const mine = vs;
    ask('info').then((i) => {
      if (mine !== vs || !i || i.videoId !== mine.vid) return;
      mine.info = i;
      if (i.url) baseUrls.set(i.videoId, i.url);
      schedule();
    });
  }
  async function getBaseUrl(mine) {
    if (baseUrls.get(mine.vid)) return baseUrls.get(mine.vid);
    const u = await ask('prime', 7000);
    if (u) baseUrls.set(mine.vid, u);
    return baseUrls.get(mine.vid) || null;
  }
  async function fetchCues(mine, track) {
    const base = await getBaseUrl(mine);
    if (!base) return null;
    const res = await fetch(T.buildTrackUrl(base, track.lang, track.kind), { credentials: 'include' });
    if (!res.ok) throw new Error('timedtext ' + res.status);
    const txt = await res.text();
    if (!txt) return null;
    return T.parseJson3(JSON.parse(txt));
  }

  // ── 플레이어·자막 읽기 ──
  function visible(p) {
    const r = p.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }
  function findPlayer() {
    const players = [...document.querySelectorAll('.html5-video-player')]
      .filter((p) => p.id !== 'inline-preview-player' && !p.closest('ytd-video-preview') && visible(p));
    return players.find((p) => p.querySelector('.ytp-caption-segment'))
      || players.find((p) => p.id === 'shorts-player' || p.id === 'movie_player')
      || players[0] || null;
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
    const srcParts = parts.filter((t) => RE_SRC.test(t) && !RE_HANGUL.test(t));
    const koParts = parts.filter((t) => RE_HANGUL.test(t));
    const text = (srcParts.length && koParts.length ? srcParts : parts).join(' ').replace(/\s+/g, ' ').trim();
    const seg = p.querySelector('.ytp-caption-segment');
    const fontSize = seg ? parseFloat(getComputedStyle(seg).fontSize) || 18 : 18;
    const host = windows.length ? windows[0].closest('.ytp-caption-window-container') : null;
    return { text, rect, fontSize, host };
  }

  function currentVideoId() {
    const u = new URL(location.href);
    const v = u.searchParams.get('v');
    if (v) return v;
    const m = u.pathname.match(/\/(?:embed|shorts|live)\/([\w-]{6,})/);
    return m ? m[1] : '';
  }

  function videoMeta(p) {
    const i = vs.info;
    if (i && i.videoId === vs.vid && i.title) return { title: i.title, channel: i.author, duration: i.duration };
    const h1 = document.querySelector('ytd-watch-metadata h1, h1.ytd-watch-metadata, #title h1');
    const embedTitle = p.querySelector('.ytp-title-link');
    const title = ((h1 && h1.textContent) || (embedTitle && embedTitle.textContent) || document.title || '')
      .replace(/^\(\d+\)\s*/, '').replace(/\s*-\s*YouTube\s*$/i, '').trim();
    const ch = document.querySelector('ytd-watch-metadata ytd-channel-name a, #owner ytd-channel-name a');
    const video = p.querySelector('video');
    return { title, channel: ch ? ch.textContent.trim() : '', duration: video && isFinite(video.duration) ? video.duration : 0, fromDom: true };
  }

  // ── 원문 가사 (백그라운드에서 검색·변환) ──
  function ensureLyrics(p) {
    const lyr = vs.lyr;
    if (lyr.status !== 'idle' || !alive || Date.now() < lyr.retryAt) return lyr;
    const meta = videoMeta(p);
    if (!meta.title) return lyr;
    if (meta.fromDom) {
      // 페이지 정보가 아직 없으면 잠깐 기다린다(자동재생 직후 이전 영상 제목 방지)
      if (Date.now() - vs.since < 2500) return lyr;
      const flexy = document.querySelector('ytd-watch-flexy');
      if (flexy && flexy.getAttribute('video-id') && flexy.getAttribute('video-id') !== vs.vid) return lyr;
      if (lastReq.vid && lastReq.vid !== vs.vid && meta.title === lastReq.title && Date.now() - vs.since < 5000) return lyr;
    }
    lastReq = { vid: vs.vid, title: meta.title };
    lyr.status = 'loading';
    const mine = vs;
    try {
      chrome.runtime.sendMessage({ type: 'lyrics', videoId: vs.vid, title: meta.title, channel: meta.channel, duration: meta.duration }, (res) => {
        if (mine !== vs) return;
        if (chrome.runtime.lastError || !res) { lyr.status = 'idle'; lyr.retryAt = Date.now() + 5000; return; }
        if (!res.pkg) { lyr.status = 'none'; schedule(); return; }
        lyr.pkg = res.pkg;
        lyr.matcher = globalThis.YKMatch.createMatcher(res.pkg.lines);
        lyr.status = 'ready';
        lyr.lastText = '';
        schedule();
      });
    } catch (e) {
      alive = false;
      hide();
    }
    return lyr;
  }

  // ── 원어 자막 트랙 (한국어 자막만 보일 때·자막이 꺼져 있을 때 사용) ──
  function ensureOrig() {
    const o = vs.orig;
    if (o.status !== 'idle' || Date.now() < o.retryAt) return o;
    const i = vs.info;
    if (!i || i.videoId !== vs.vid || i.ad) return o;
    const track = T.pickSourceTrack(i.tracks);
    if (!track) { o.status = 'none'; return o; }
    o.status = 'loading';
    const mine = vs;
    fetchCues(mine, track).then((cues) => {
      if (mine !== vs) return;
      if (cues && cues.length) { o.cues = cues; o.status = 'ready'; schedule(); }
      else { o.status = 'idle'; o.retryAt = Date.now() + 15000; }
    }, () => { if (mine === vs) { o.status = 'idle'; o.retryAt = Date.now() + 15000; } });
    return o;
  }

  // ── 자막 없는 모드의 가사 싱크: 자동 자막과 가사를 비교해 시간차 계산 ──
  function ensureAlign(pkg) {
    const a = vs.align;
    if (a.status !== 'idle') return a;
    const i = vs.info;
    if (!i || i.videoId !== vs.vid || i.ad) return a;
    const list = i.tracks || [];
    const track = list.find((t) => t.kind === 'asr' && !/^ko/i.test(t.lang)) || T.pickSourceTrack(list);
    if (!track) { a.status = 'done'; return a; }
    a.status = 'running';
    const mine = vs;
    fetchCues(mine, track).then((cues) => {
      if (mine !== vs) return;
      const r = cues ? T.alignOffset(cues, pkg.lines) : null;
      if (r && r.confidence >= 1.8) { a.offset = r.offset; a.confident = true; }
      a.status = 'done';
      schedule();
    }, () => { if (mine === vs) { a.status = 'done'; schedule(); } });
    return a;
  }

  function loadManualOffset() {
    if (vs.manualLoaded) return;
    vs.manualLoaded = true;
    const mine = vs;
    try {
      chrome.storage.local.get('off:' + vs.vid, (r) => {
        if (mine !== vs || chrome.runtime.lastError) return;
        const v = Number(r && r['off:' + mine.vid]);
        if (isFinite(v)) mine.manualOffset = v;
      });
    } catch (e) { /* 무시 */ }
  }

  // ── 발음 변환 요청 ──
  function request(text, direct = false) {
    if (inflight.has(text) || !alive) return;
    const f = failedAt.get(text);
    if (f && Date.now() - f < 3000) return;
    const send = () => {
      inflight.add(text);
      try {
        chrome.runtime.sendMessage({ type: 'convert', text }, (res) => {
          inflight.delete(text);
          if (chrome.runtime.lastError || !res) { failedAt.set(text, Date.now()); return; }
          cache.set(text, res);
          if (cache.size > 600) cache.delete(cache.keys().next().value);
          schedule();
        });
      } catch (e) {
        inflight.delete(text);
        alive = false; // 확장 프로그램이 다시 로드됨 → 페이지 새로고침 필요
        hide();
      }
    };
    if (direct) return send();
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      // 자동 생성 자막처럼 글자가 계속 늘어나는 경우 마지막 상태만 요청
      if (!player || readCaption(player).text !== text) return;
      send();
    }, 100);
  }

  function lyricLines(line, withTrans) {
    const out = [];
    if (settings.showPron && line.pron) out.push(['ykpron-pron', line.pron]);
    if (settings.showOrig && line.text) out.push(['ykpron-orig', line.text]);
    if (withTrans && settings.showTrans && line.ko) out.push(['ykpron-trans', line.ko]);
    return out;
  }

  /** 원어 트랙에서 지금 시각의 줄을 발음으로 */
  function origLines(now) {
    const o = ensureOrig();
    if (o.status !== 'ready') return null;
    const cue = T.activeCue(o.cues, now);
    if (!cue) return null;
    const res = cache.get(cue.text);
    if (!res) { request(cue.text, true); return null; }
    const out = [];
    if (settings.showPron && res.pron) out.push(['ykpron-pron', res.pron]);
    if (settings.showOrig && res.pron && res.pron !== cue.text) out.push(['ykpron-orig', cue.text]);
    return out;
  }

  // 자막이 보일 때 보여 줄 줄
  function captionLines(p, text) {
    const video = p.querySelector('video');
    const now = video ? video.currentTime : undefined;
    if (settings.lyricsMode && RE_HANGUL.test(text)) {
      const st = ensureLyrics(p);
      if (st.status === 'ready') {
        if (st.lastText !== text) {
          st.lastText = text;
          st.lastMatch = st.matcher.match(text, now);
        }
        shownText = '';
        return st.lastMatch ? lyricLines(st.pkg.lines[st.lastMatch.index], false) : null;
      }
      // 노래 가사를 못 찾으면 같은 영상의 원어 자막(자동 생성 포함)으로
      if (st.status === 'none' && settings.origFallback && typeof now === 'number') {
        const r = origLines(now);
        if (r && r.length) return r;
      }
    }
    let res = cache.get(text);
    if (!res) {
      request(text);
      // 이어지는 자막(글자 추가)일 때만 직전 결과를 유지
      if (!(shownText && text.startsWith(shownText))) return null;
      res = cache.get(shownText);
      if (!res) return null;
    } else {
      shownText = text;
    }
    const out = [];
    if (settings.showPron && res.pron) out.push(['ykpron-pron', res.pron]);
    if (settings.showTrans && res.translation) out.push(['ykpron-trans', res.translation]);
    return out;
  }

  // 자막이 꺼져 있거나 없는 영상에서 보여 줄 줄
  function noCaptionLines(p) {
    const i = vs.info;
    if (!i || i.videoId !== vs.vid || i.isLive) return null;
    const video = p.querySelector('video');
    if (!video) return null;
    const now = video.currentTime;
    const st = ensureLyrics(p);
    if (st.status === 'ready' && st.pkg.synced) {
      const a = ensureAlign(st.pkg);
      if (a.status === 'running') return null;
      // 엉뚱한 노래를 띄우지 않도록: 자동 자막으로 싱크가 확인됐거나, 곡 길이가 영상 길이와 비슷할 때만
      const durOk = st.pkg.duration && i.duration && Math.abs(st.pkg.duration - i.duration) <= 25;
      if (!a.confident && !durOk) return null;
      loadManualOffset();
      const idx = T.lineAtTime(st.pkg.lines, now, a.offset + vs.manualOffset);
      return idx >= 0 ? lyricLines(st.pkg.lines[idx], true) : null;
    }
    if (st.status === 'none' && settings.noCapAsr) return origLines(now);
    return null;
  }

  // ── 표시 ──
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

  // 유튜브는 시작·광고 전환 때 자막 컨테이너를 새로 만든다 → 매 프레임 실제 자막이 들어 있는 컨테이너를 쓴다
  function attach(p, host) {
    const next = host || (p ? p.querySelector('.ytp-caption-window-container') : null);
    if (p === player && next === container) return;
    if (container) container.style.translate = '';
    if (next && lift) next.style.translate = `0 ${-lift}px`;
    player = p;
    container = next;
    if (observer) observer.disconnect();
    observer = null;
    if (container) {
      observer = new MutationObserver(schedule);
      observer.observe(container, { childList: true, subtree: true, characterData: true });
    }
  }

  function paint(p, lines, size) {
    const el = ensureOverlay(p);
    const pr = p.getBoundingClientRect();
    const key = JSON.stringify([lines, size, settings.color, Math.round(pr.width)]);
    if (key !== lastRender) {
      lastRender = key;
      el.textContent = '';
      for (const [cls, str] of lines) {
        const div = document.createElement('div');
        div.className = cls;
        div.textContent = str;
        el.appendChild(div);
      }
      el.style.fontSize = size + 'px';
      el.style.setProperty('--ykpron-color', settings.color || '#ffe066');
      el.style.maxWidth = Math.round(pr.width * 0.92) + 'px';
    }
    el.style.display = 'block';
    lastShownAt = Date.now();
    return { el, pr };
  }

  function bottomReserve(p) {
    const controlsVisible = !p.classList.contains('ytp-autohide');
    const bar = p.querySelector('.ytp-chrome-bottom');
    return controlsVisible && bar ? bar.offsetHeight + 8 : 6;
  }

  // 자막 바로 아래에 배치. 화면 밖으로 나가면 자막 전체를 위로 올린다.
  function showUnderCaption(p, lines, cap) {
    const size = Math.max(10, cap.fontSize * (Number(settings.scale) || 0.85));
    const { el, pr } = paint(p, lines, size);
    const gap = Math.round(size * 0.25);
    const h = el.offsetHeight;
    const baseBottom = cap.rect.bottom + lift - pr.top; // 들어올리기 전 자막 아래 위치
    const limit = pr.height - bottomReserve(p);
    let need = Math.max(0, Math.min(baseBottom + gap + h - limit, baseBottom - h));
    // 표시 중에는 올리기만 한다(두 줄↔한 줄 자막 전환 때 흔들리지 않게)
    if (lift && el.dataset.shownAt && Date.now() - Number(el.dataset.shownAt) < 2500) need = Math.max(need, lift);
    el.dataset.shownAt = String(Date.now());
    setLift(need);
    const center = (cap.rect.left + cap.rect.right) / 2 - pr.left;
    const half = el.offsetWidth / 2;
    el.style.top = Math.round(baseBottom - lift + gap) + 'px';
    el.style.left = Math.round(Math.min(Math.max(center, half + 4), pr.width - half - 4)) + 'px';
  }

  // 자막 없는 모드: 유튜브 자막 자리(화면 아래쪽 가운데)에 표시
  function showAtBottom(p, lines) {
    const pr0 = p.getBoundingClientRect();
    const size = Math.max(12, (pr0.height / 20) * ((Number(settings.scale) || 0.85) / 0.85));
    const { el, pr } = paint(p, lines, size);
    setLift(0);
    const h = el.offsetHeight;
    el.style.top = Math.round(pr.height - bottomReserve(p) - h - Math.round(pr.height * 0.03)) + 'px';
    el.style.left = Math.round(pr.width / 2) + 'px';
  }

  function showToast(p, msg) {
    if (!toast || toast.parentNode !== p) {
      if (toast) toast.remove();
      toast = document.createElement('div');
      toast.className = 'ykpron-toast';
      p.appendChild(toast);
    }
    toast.textContent = msg;
    toast.style.display = 'block';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toast.style.display = 'none'; }, 1600);
  }

  // ── 메인 루프 ──
  function schedule() {
    if (!rafId) rafId = requestAnimationFrame(update);
  }

  function update() {
    rafId = 0;
    if (!alive) return;
    const p = findPlayer();
    if (!settings.enabled || !p) { attach(p, null); return hide(); }
    const vid = currentVideoId();
    if (vid !== vs.vid) vs = newVideoState(vid);
    if (vid) refreshInfo();
    // 광고 중에는 광고 자막을 무시
    if (p.classList.contains('ad-showing') || p.classList.contains('ad-interrupting')) { attach(p, null); return hide(); }

    const cap = readCaption(p);
    attach(p, cap.host);
    if (cap.text && cap.rect) {
      if (lift) lastShownAt = Date.now(); // 자막이 떠 있는 동안은 높이 유지
      const lines = captionLines(p, cap.text);
      if (lines && lines.length) return showUnderCaption(p, lines, cap);
      return hide('keep');
    }
    if (settings.noCapMode && vid) {
      const lines = noCaptionLines(p);
      if (lines && lines.length) return showAtBottom(p, lines);
    }
    return hide('gap');
  }

  // 자막 없는 모드 싱크 수동 조정: Alt+, (가사 늦게) / Alt+. (가사 빠르게) / Alt+/ (초기화)
  window.addEventListener('keydown', (e) => {
    if (!e.altKey || e.ctrlKey || e.metaKey || !vs.vid) return;
    let d = 0;
    if (e.code === 'Comma') d = 0.5;
    else if (e.code === 'Period') d = -0.5;
    else if (e.code !== 'Slash') return;
    const p = findPlayer();
    if (!p) return;
    e.preventDefault();
    e.stopPropagation();
    vs.manualLoaded = true;
    vs.manualOffset = d ? Math.round((vs.manualOffset + d) * 10) / 10 : 0;
    try { chrome.storage.local.set({ ['off:' + vs.vid]: vs.manualOffset }); } catch (err) { /* 무시 */ }
    const total = (vs.align.offset || 0) + vs.manualOffset;
    showToast(p, `가사 싱크 ${vs.manualOffset >= 0 ? '+' : ''}${vs.manualOffset.toFixed(1)}초 (합계 ${total.toFixed(1)}초) · Alt+, / Alt+. / Alt+/`);
    schedule();
  }, true);

  setInterval(schedule, 250);
  window.addEventListener('resize', schedule);
  document.addEventListener('fullscreenchange', schedule);
})();
