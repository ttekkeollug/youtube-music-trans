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
  let rafId = 0, lastRender = '', shownText = '', debounceTimer = 0, lastCaptionAt = 0;
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
    if (vs.info && vs.info.videoId === vs.vid && now - vs.infoAt < 3000) return;
    if (now - vs.infoAt < 1000) return;
    vs.infoAt = now;
    const mine = vs;
    ask('info').then((i) => {
      if (mine !== vs || !i || i.videoId !== mine.vid) return;
      const prevCc = mine.info && mine.info.ccTrack ? JSON.stringify(mine.info.ccTrack) : '';
      mine.info = i;
      if (prevCc && prevCc !== JSON.stringify(i.ccTrack || null) && mine.orig.status !== 'loading') mine.orig = { status: 'idle', cues: null, retryAt: 0 };
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

  // 유튜브가 자막 자리에 띄우는 안내 문구(자동 번역 설정 안내 등)는 자막이 아니다
  const RE_NOTICE = /자동 생성됨|설정을 확인하려면|auto-generated|click .*settings|>>\s*한국어/i;
  const clean = (t) => t.replace(/[\u200b-\u200d\u2060\ufeff]/g, '').replace(/(^|\s)>>\s*/g, ' ').replace(/\s+/g, ' ').trim();

  function readCaption(p) {
    const pr = p.getBoundingClientRect();
    const windows = [...p.querySelectorAll('.caption-window')]
      .filter((w) => w.offsetParent !== null && w.querySelector('.ytp-caption-segment') && !RE_NOTICE.test(w.textContent));
    const parts = [];
    const seenText = new Set();
    let rect = null, bottomRect = null;
    const grow = (a, r) => (a
      ? { left: Math.min(a.left, r.left), right: Math.max(a.right, r.right), top: Math.min(a.top, r.top), bottom: Math.max(a.bottom, r.bottom) }
      : { left: r.left, right: r.right, top: r.top, bottom: r.bottom });
    for (const win of windows) {
      const lines = win.querySelectorAll('.caption-visual-line');
      const src = lines.length ? lines : [win];
      const winText = [];
      for (const line of src) {
        const t = clean([...line.querySelectorAll('.ytp-caption-segment')].map((s) => s.textContent).join(''));
        if (t) winText.push(t);
      }
      // 효과용으로 같은 자막을 여러 겹 겹쳐 놓은 영상은 한 번만 읽는다
      const key = winText.join('\n');
      if (!key || seenText.has(key)) continue;
      seenText.add(key);
      parts.push(...winText);
      const r = win.getBoundingClientRect();
      rect = grow(rect, r);
      if ((r.top + r.bottom) / 2 - pr.top >= pr.height * 0.5) bottomRect = grow(bottomRect, r);
    }
    // 위치는 아래쪽 자막 창 기준 (위·아래에 동시에 자막이 있으면 아래쪽에 맞춘다)
    if (bottomRect) rect = bottomRect;
    // 원문 줄과 한국어 번역 줄이 함께 있는 자막이면 원문 줄만 발음 변환에 쓴다
    const srcParts = parts.filter((t) => RE_SRC.test(t) && !RE_HANGUL.test(t));
    const koParts = parts.filter((t) => RE_HANGUL.test(t));
    const text = clean((srcParts.length && koParts.length ? srcParts : parts).join(' '));
    const seg = p.querySelector('.ytp-caption-segment');
    const fontSize = seg ? parseFloat(getComputedStyle(seg).fontSize) || 18 : 18;
    const host = windows.length ? windows[0].closest('.ytp-caption-window-container') : p.querySelector('.ytp-caption-window-container');
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
    // 지금 보는 자막이 자동 번역(예: 영어 자동 생성 >> 한국어)이면 번역 전 트랙이 곧 원문이다
    const cc = i.ccTrack;
    const track = cc && cc.translated && cc.lang && !/^ko/i.test(cc.lang) ? { lang: cc.lang, kind: cc.kind } : T.pickSourceTrack(i.tracks);
    o.lang = track ? track.lang : '';
    if (!track) { o.status = 'none'; return o; }
    o.status = 'loading';
    const mine = vs;
    fetchCues(mine, track).then((cues) => {
      if (mine !== vs) return;
      if (cues && cues.length) { o.cues = cues.map((c) => ({ ...c, text: clean(c.text) })).filter((c) => c.text); o.status = 'ready'; schedule(); }
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
  function request(text, direct = false, hint = '') {
    if (inflight.has(text) || !alive) return;
    const f = failedAt.get(text);
    if (f && Date.now() - f < 3000) return;
    const send = () => {
      inflight.add(text);
      try {
        chrome.runtime.sendMessage({ type: 'convert', text, hint }, (res) => {
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
    if (!res) { request(cue.text, true, (o.lang || '').split('-')[0] === 'ja' ? 'ja' : ''); return null; }
    const out = [];
    if (settings.showPron && res.pron) out.push(['ykpron-pron', res.pron]);
    if (settings.showOrig && res.pron && res.pron !== cue.text) out.push(['ykpron-orig', cue.text]);
    return out;
  }

  /**
   * 가사 타임스탬프로 지금 부르는 줄. 싱크는 ① 자막 매칭으로 배운 시간차 ② 자동 자막으로 계산한 시간차 순으로 쓴다.
   * 엉뚱한 노래를 띄우지 않도록, 둘 다 없으면 곡 길이가 영상 길이와 비슷할 때만 시간차 0으로 표시.
   */
  function timedLyricLines(st, now, withTrans) {
    const pkg = st.pkg;
    if (!pkg || !pkg.synced || typeof now !== 'number') return null;
    let off = st.matcher && st.matcher.learnedOffset();
    if (off == null) {
      const a = ensureAlign(pkg);
      if (a.status === 'running') return null;
      const i = vs.info;
      const durOk = pkg.duration && i && i.duration && Math.abs(pkg.duration - i.duration) <= 25;
      if (!a.confident && !durOk && !pkg.manual) return null; // 사용자가 직접 고른 가사는 그대로 표시
      off = a.confident ? a.offset : 0;
    }
    loadManualOffset();
    const idx = T.lineAtTime(pkg.lines, now, off + vs.manualOffset);
    return idx >= 0 ? lyricLines(pkg.lines[idx], withTrans) : null;
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
        if (st.lastMatch) return lyricLines(st.pkg.lines[st.lastMatch.index], false);
        // 번역 자막이 가사 줄과 글자로 안 맞으면(말투 차이·안내 문구 등) 시간 기준 가사 줄로
        const timed = timedLyricLines(st, now, false);
        if (timed && timed.length) return timed;
      }
      // 노래 가사를 못 찾았거나 시간으로도 못 맞추면 같은 영상의 원어 자막(자동 생성 포함)으로
      if ((st.status === 'none' || st.status === 'ready') && settings.origFallback && typeof now === 'number') {
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
    if (st.status === 'ready' && st.pkg.synced) return timedLyricLines(st, now, true);
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

  function hide() {
    if (overlay) overlay.style.display = 'none';
    shownText = '';
    lastRender = '';
  }

  // 유튜브는 시작·광고 전환 때 자막 컨테이너를 새로 만든다 → 매 프레임 실제 자막이 들어 있는 컨테이너를 관찰
  function attach(p, host) {
    const next = host || (p ? p.querySelector('.ytp-caption-window-container') : null);
    if (p === player && next === container) return;
    if (container) container.style.translate = ''; // 이전 버전이 남긴 이동 값 정리
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
    return { el, pr };
  }

  function bottomReserve(p) {
    const controlsVisible = !p.classList.contains('ytp-autohide');
    const bar = p.querySelector('.ytp-chrome-bottom');
    return controlsVisible && bar ? bar.offsetHeight + 8 : 6;
  }

  // 유튜브 자막은 기본 위치 그대로 두고(절대 움직이지 않음), 발음 줄은
  //  · 자막 아래에 공간이 있으면 자막 바로 아래
  //  · 없으면(기본 위치는 화면 맨 아래라 보통 공간이 없음) 자막 바로 위
  //  · 자막이 화면 위쪽에 배치된 영상이면 기본 위치(화면 아래쪽 가운데)
  function showWithCaption(p, lines, cap) {
    const size = Math.max(10, cap.fontSize * (Number(settings.scale) || 0.85));
    const { el, pr } = paint(p, lines, size);
    const gap = Math.round(size * 0.25);
    const h = el.offsetHeight;
    const capTop = cap.rect.top - pr.top;
    const capBottom = cap.rect.bottom - pr.top;
    if ((capTop + capBottom) / 2 < pr.height * 0.5) return placeDefault(p, el, pr);
    const limit = pr.height - bottomReserve(p);
    const top = capBottom + gap + h <= limit ? capBottom + gap : capTop - gap - h;
    const center = (cap.rect.left + cap.rect.right) / 2 - pr.left;
    const half = el.offsetWidth / 2;
    el.style.top = Math.round(Math.max(4, top)) + 'px';
    el.style.left = Math.round(Math.min(Math.max(center, half + 4), pr.width - half - 4)) + 'px';
  }

  function placeDefault(p, el, pr) {
    el.style.top = Math.round(pr.height - bottomReserve(p) - el.offsetHeight - Math.round(pr.height * 0.03)) + 'px';
    el.style.left = Math.round(pr.width / 2) + 'px';
  }

  // 자막 없는 모드: 유튜브 자막의 기본 위치(화면 아래쪽 가운데)에 표시
  function showAtBottom(p, lines) {
    const pr0 = p.getBoundingClientRect();
    const size = Math.max(12, (pr0.height / 20) * ((Number(settings.scale) || 0.85) / 0.85));
    const { el, pr } = paint(p, lines, size);
    placeDefault(p, el, pr);
  }

  function showToast(p, msg, ms = 1600) {
    if (!toast || toast.parentNode !== p) {
      if (toast) toast.remove();
      toast = document.createElement('div');
      toast.className = 'ykpron-toast';
      p.appendChild(toast);
    }
    toast.textContent = msg;
    toast.style.display = 'block';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toast.style.display = 'none'; }, ms);
  }


  // ── 가사 직접 찾기: 플레이어 컨트롤의 '가' 버튼 → 노래 제목 검색 → 결과 선택 ──
  let panel = null;
  let hintShownFor = '';

  function send(msg) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(msg, (res) => resolve(chrome.runtime.lastError ? null : res));
      } catch (e) {
        alive = false;
        resolve(null);
      }
    });
  }

  function ensureButton(p) {
    const right = p.querySelector('.ytp-right-controls');
    if (!right || right.querySelector('.ykpron-btn')) return;
    const b = document.createElement('button');
    b.className = 'ytp-button ykpron-btn';
    b.title = '가사 찾기 (유튜브 노래방)';
    b.setAttribute('aria-label', '가사 찾기');
    b.textContent = '가';
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      togglePanel(p);
    });
    right.insertBefore(b, right.firstChild);
  }

  function statusText() {
    const l = vs.lyr;
    if (l.status === 'ready') return `가사: ${l.pkg.track} – ${l.pkg.artist}${l.pkg.synced ? '' : ' (타임스탬프 없음)'}${l.pkg.manual ? ' · 직접 선택' : ''}`;
    if (l.status === 'loading') return '가사를 찾는 중…';
    if (l.status === 'none') return '이 영상의 가사를 자동으로 찾지 못했습니다.';
    return '아직 가사를 찾지 않았습니다.';
  }

  function fmtDur(sec) {
    if (!sec) return '';
    return Math.floor(sec / 60) + ':' + String(sec % 60).padStart(2, '0');
  }

  function buildPanel(p) {
    const el = document.createElement('div');
    el.className = 'ykpron-panel';
    const status = document.createElement('div');
    status.className = 'ykpron-panel-status';
    const form = document.createElement('form');
    form.className = 'ykpron-panel-form';
    const input = document.createElement('input');
    input.type = 'text';
    input.placeholder = '노래 제목 (원어 제목이 잘 찾아집니다)';
    const go = document.createElement('button');
    go.type = 'submit';
    go.textContent = '검색';
    form.append(input, go);
    const list = document.createElement('div');
    list.className = 'ykpron-panel-list';
    const foot = document.createElement('div');
    foot.className = 'ykpron-panel-foot';
    const clear = document.createElement('button');
    clear.type = 'button';
    clear.textContent = '이 영상 가사 끄기';
    const close = document.createElement('button');
    close.type = 'button';
    close.textContent = '닫기';
    const hint = document.createElement('span');
    hint.textContent = '싱크: Alt+, / Alt+.';
    foot.append(hint, clear, close);
    el.append(status, form, list, foot);

    // 패널 안의 키 입력·클릭이 유튜브 단축키나 재생/일시정지로 넘어가지 않게
    for (const t of ['keydown', 'keyup', 'keypress']) el.addEventListener(t, (e) => e.stopPropagation());
    for (const t of ['click', 'mousedown', 'mouseup', 'dblclick', 'wheel']) el.addEventListener(t, (e) => e.stopPropagation());

    const runSearch = async (query) => {
      list.textContent = '검색 중…';
      const meta = videoMeta(p);
      const res = await send({ type: 'search', query, title: meta.title, channel: meta.channel });
      if (!res) { list.textContent = '검색하지 못했습니다. 잠시 후 다시 시도해 주세요.'; return; }
      if (!query && res.query) input.value = res.query;
      list.textContent = '';
      if (!res.results.length) { list.textContent = '결과가 없습니다. 원어 제목이나 가수 이름으로 검색해 보세요.'; return; }
      for (const r of res.results) {
        const item = document.createElement('button');
        item.type = 'button';
        item.className = 'ykpron-panel-item';
        const name = document.createElement('b');
        name.textContent = r.track;
        const sub = document.createElement('span');
        sub.textContent = ` ${r.artist}${r.duration ? ' · ' + fmtDur(r.duration) : ''}${r.synced ? ' · 싱크' : ' · 싱크 없음'}`;
        item.append(name, sub);
        item.addEventListener('click', () => choose(r, item));
        list.appendChild(item);
      }
    };

    const choose = async (r, item) => {
      const mine = vs;
      item.disabled = true;
      status.textContent = `"${r.track}" 가사를 준비하는 중… (줄마다 발음 변환)`;
      const res = await send({ type: 'setLyrics', videoId: mine.vid, id: r.id });
      item.disabled = false;
      if (mine !== vs) return;
      if (!res || !res.pkg) { status.textContent = '가사를 불러오지 못했습니다.'; return; }
      applyPkg(res.pkg);
      status.textContent = statusText();
      showToast(p, `가사 적용: ${res.pkg.track} – ${res.pkg.artist}`);
    };

    form.addEventListener('submit', (e) => {
      e.preventDefault();
      runSearch(input.value.trim());
    });
    clear.addEventListener('click', async () => {
      const mine = vs;
      await send({ type: 'clearLyrics', videoId: mine.vid });
      if (mine !== vs) return;
      mine.lyr = { status: 'none', pkg: null, matcher: null, lastText: '', lastMatch: null, retryAt: 0 };
      status.textContent = '이 영상에서는 가사를 쓰지 않습니다. 다시 쓰려면 검색해서 고르세요.';
      schedule();
    });
    close.addEventListener('click', () => { el.style.display = 'none'; });
    el._refresh = () => { status.textContent = statusText(); };
    el._search = runSearch;
    el._vid = '';
    return el;
  }

  function togglePanel(p) {
    if (!panel || panel.parentNode !== p) {
      if (panel) panel.remove();
      panel = buildPanel(p);
      p.appendChild(panel);
    }
    const open = panel.style.display !== 'block';
    panel.style.display = open ? 'block' : 'none';
    if (open) {
      panel._refresh();
      if (panel._vid !== vs.vid) {
        panel._vid = vs.vid;
        panel.querySelector('input').value = '';
        panel._search(''); // 영상 제목으로 먼저 검색해 후보를 보여 준다
      }
      setTimeout(() => { try { panel.querySelector('input').focus(); } catch (e) { /* 무시 */ } }, 0);
    }
  }

  function applyPkg(pkg) {
    vs.lyr = { status: 'ready', pkg, matcher: globalThis.YKMatch.createMatcher(pkg.lines), lastText: '', lastMatch: null, retryAt: 0 };
    vs.align = { status: 'idle', offset: 0, confident: false };
    lastRender = '';
    schedule();
  }

  // 음악 영상인데 가사를 못 찾았으면 한 번만 안내
  function maybeHint(p) {
    if (hintShownFor === vs.vid || vs.lyr.status !== 'none') return;
    const i = vs.info;
    if (!i || i.videoId !== vs.vid || i.category !== 'Music') return;
    hintShownFor = vs.vid;
    showToast(p, "가사를 자동으로 찾지 못했어요. 플레이어 오른쪽 아래 '가' 버튼으로 노래 제목을 검색해 보세요.", 4000);
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
    if (vid !== vs.vid) {
      vs = newVideoState(vid);
      if (panel) panel.style.display = 'none';
    }
    if (vid) {
      refreshInfo();
      ensureButton(p);
      if (panel && panel.style.display === 'block') panel._refresh();
    }
    // 광고 중에는 광고 자막을 무시
    if (p.classList.contains('ad-showing') || p.classList.contains('ad-interrupting')) { attach(p, null); return hide(); }

    const cap = readCaption(p);
    attach(p, cap.host);
    if (cap.text && cap.rect) {
      lastCaptionAt = Date.now();
      const lines = captionLines(p, cap.text);
      if (lines && lines.length) return showWithCaption(p, lines, cap);
      return hide();
    }
    // 자막 버튼이 켜져 있고 최근에 자막이 있었으면 줄 사이 빈틈 → 자막 없는 모드로 넘어가지 않는다.
    // 버튼을 끄면 바로 자막 없는 모드로.
    const ccBtn = p.querySelector('.ytp-subtitles-button');
    const ccOn = ccBtn ? ccBtn.getAttribute('aria-pressed') === 'true' : true;
    const inGap = ccOn && Date.now() - lastCaptionAt < (ccBtn ? 15000 : 5000);
    if (settings.noCapMode && vid && !inGap) {
      const lines = noCaptionLines(p);
      maybeHint(p);
      if (lines && lines.length) return showAtBottom(p, lines);
    }
    return hide();
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
