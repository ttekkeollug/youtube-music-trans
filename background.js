// 서비스 워커: 언어 판별·로마자 표기(구글 번역) + 한글 발음 변환
import { pronounce, detectScript } from './lib/convert.js';
import { analyzeTitle, parseLrc, pickBest, searchLrclib } from './lib/lyrics.js';

let dictPromise = null;
function loadDict() {
  if (!dictPromise) {
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 20000);
    dictPromise = fetch(chrome.runtime.getURL('data/cmudict.txt'), { signal: ctrl.signal })
      .then((r) => r.text())
      .then((txt) => {
        const map = new Map();
        for (const line of txt.split('\n')) {
          const i = line.indexOf(' ');
          if (i > 0) map.set(line.slice(0, i), line.slice(i + 1));
        }
        return map;
      })
      .catch((e) => {
        dictPromise = null;
        throw e;
      });
  }
  return dictPromise;
}

const cache = new Map();
const CACHE_MAX = 2000;
function remember(key, val) {
  cache.set(key, val);
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
}

async function google(text, sl = 'auto') {
  const url =
    `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${encodeURIComponent(sl)}&tl=ko&dt=t&dt=rm&q=` +
    encodeURIComponent(text);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 5000);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    let translation = '';
    let roman = '';
    for (const seg of (Array.isArray(data) && Array.isArray(data[0]) ? data[0] : [])) {
      if (!Array.isArray(seg)) continue;
      if (typeof seg[0] === 'string') translation += seg[0];
      else if (seg[0] == null && typeof seg[3] === 'string') roman += (roman ? ' ' : '') + seg[3];
    }
    const lang = typeof data[2] === 'string' ? data[2] : '';
    return { lang, roman: roman.trim(), translation: translation.trim() };
  } finally {
    clearTimeout(timer);
  }
}

async function translateTo(text, tl) {
  const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${tl}&dt=t&q=` + encodeURIComponent(text);
  const res = await fetch(url);
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const data = await res.json();
  return (data[0] || []).map((seg) => (typeof seg[0] === 'string' ? seg[0] : '')).join('').trim();
}

/**
 * @param hint 언어를 이미 알 때(가사 전체가 일본어 등) 지정. 한자만 있는 짧은 줄을
 *   구글이 중국어·한국어로 잘못 판별하는 것을 막는다 (抜錨 → Batsubyō, 바마오 ✗)
 */
async function convert(text, hint = '') {
  // 일본어 노래 속 영어 줄(Brave shine 등)은 언어 지정 없이 영어로 읽는다
  if (hint && !/[\u3040-\u30ff\u3400-\u9fff]/.test(text)) hint = '';
  const key = (hint ? hint + '|' : '') + text;
  if (cache.has(key)) return cache.get(key);
  const script = detectScript(text);
  let g = null;
  if (script !== 'ko') {
    try {
      g = await google(text, hint || 'auto');
      if (hint && g && !g.lang) g.lang = hint;
    } catch (e) {
      g = null; // 오프라인 대체 변환으로 진행
    }
  }
  let lookup = () => undefined;
  if (/[A-Za-z]/.test(text) || (g && g.roman)) {
    try {
      const dict = await loadDict();
      lookup = (w) => dict.get(w);
    } catch (e) { /* 사전 없이 철자 규칙만 사용 */ }
  }
  let pron = '';
  try {
    pron = pronounce(text, g, lookup);
  } catch (e) {
    pron = '';
  }
  const lang = (g && g.lang) || script;
  const translation = g && g.translation && (hint || !lang.startsWith('ko')) && g.translation !== text ? g.translation : '';
  const result = { pron, translation, lang, ok: !!g };
  // 구글 응답이 있었을 때만 캐시(실패 결과가 굳지 않도록)
  if (g || script === 'ko') remember(key, result);
  return result;
}

// ── 번역 자막 영상용: 원문 가사 찾아 줄마다 발음·번역 준비 ──
const LYR_VER = 'v6';
const lyricsJobs = new Map();

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

async function buildLyrics({ videoId, title, channel, duration }) {
  const key = `lyr:${LYR_VER}:${videoId}`;
  const stored = (await chrome.storage.local.get(key))[key];
  if (stored && (stored.lines || stored.manual || Date.now() - stored.at < 6 * 3600 * 1000)) return stored.lines ? stored : null;

  const info = analyzeTitle(title, channel);
  const seen = new Map();
  let best = null;
  const terms = [...info.terms];
  let searched = 0;
  const tryQueries = async (queries) => {
    for (const q of queries) {
      try {
        for (const r of await searchLrclib(q)) if (!seen.has(r.id)) seen.set(r.id, r);
        searched++;
      } catch (e) { /* 다음 검색어 */ }
      best = pickBest([...seen.values()], { title, duration, terms });
      if (best && best.syncedLyrics) return;
    }
  };
  await tryQueries(info.queries);
  // 제목에 원어 곡명이 없으면 한국어 조각을 일본어로 번역해 다시 찾는다 (사신 → 死神)
  // 번역으로 찾은 가사는 다른 노래일 수 있어 '근거 약함'으로 표시 → 화면 쪽에서 확인된 뒤에만 사용
  let weak = false;
  if (!best && info.korean.length) {
    weak = true;
    const translated = [];
    for (const k of info.korean) {
      try {
        const t = await translateTo(k, 'ja');
        if (t && t !== k) translated.push(t);
      } catch (e) { /* 무시 */ }
    }
    terms.push(...translated);
    const latin = info.terms.filter((t) => !/[\u3040-\u9fff]/.test(t));
    const qs = [];
    for (const t of translated) {
      for (const o of [...translated.filter((x) => x !== t), ...latin]) qs.push(`${t} ${o}`);
      qs.push(t);
    }
    await tryQueries([...new Set(qs)].slice(0, 6));
  }
  if (!best) {
    if (searched) await chrome.storage.local.set({ [key]: { none: true, at: Date.now() } }); // 네트워크 오류면 저장 안 함
    return null;
  }
  const pkg = await buildPkg(best);
  if (!pkg) return null; // 번역 실패 시 저장하지 않고 다음에 재시도
  if (weak) pkg.weak = true;
  await chrome.storage.local.set({ [key]: pkg });
  return pkg;
}

/** LRCLIB 기록 하나 → 줄마다 발음·번역을 붙인 가사 패키지 */
async function buildPkg(rec, { manual = false } = {}) {
  let raw = rec.syncedLyrics ? parseLrc(rec.syncedLyrics) : [];
  if (!raw.length) raw = String(rec.plainLyrics || '').split('\n').map((t) => ({ t: null, text: t.trim() })).filter((l) => l.text);
  // 원문 줄과 한국어 번역 줄이 섞여 올라온 가사(커버 전용 업로드 등)는 한국어 줄을 뺀다
  const hasHangul = (t) => /[\uac00-\ud7a3]/.test(t);
  const foreign = raw.filter((l) => !hasHangul(l.text));
  if (foreign.length && foreign.length < raw.length && foreign.length >= raw.length * 0.3) raw = foreign;
  raw = raw.slice(0, 150);
  if (!raw.length) return null;
  // 가사 전체로 언어를 정해 줄마다 같은 언어로 변환 (가나가 있으면 일본어)
  const hint = raw.some((l) => /[\u3040-\u30ff]/.test(l.text)) ? 'ja' : '';
  const uniq = [...new Set(raw.map((l) => l.text))];
  const conv = new Map();
  await mapLimit(uniq, 4, async (text) => conv.set(text, await convert(text, hint)));
  const lines = raw.map((l) => {
    const c = conv.get(l.text) || {};
    return { t: l.t, text: l.text, pron: c.pron || '', ko: c.translation || '' };
  });
  // 구글 응답이 하나도 없었으면(네트워크 오류) 저장하지 않고 다음에 다시 만든다
  if (![...conv.values()].some((c) => c && c.ok)) return null;
  // 가사 언어: 가나가 있으면 일본어, 한자만 있으면 중국어, 아니면 영어 등 로마자 언어
  const all = raw.map((l) => l.text).join('\n');
  const lang = /[\u3040-\u30ff]/.test(all) ? 'ja' : /[\u3400-\u9fff]/.test(all) ? 'zh' : /[\uac00-\ud7a3]/.test(all) ? 'ko' : 'latin';
  return {
    id: rec.id, track: rec.trackName, artist: rec.artistName, duration: Number(rec.duration) || 0,
    synced: !!rec.syncedLyrics, manual, lang, lines, at: Date.now(),
  };
}

// ── 사용자가 직접 노래를 검색해 가사를 고르는 기능 ──
async function searchSongs({ query, title, channel }) {
  const queries = query ? [query] : analyzeTitle(title, channel).queries.slice(0, 3);
  const seen = new Map();
  for (const q of queries) {
    try {
      for (const r of await searchLrclib(q)) if (!seen.has(r.id) && (r.syncedLyrics || r.plainLyrics) && !r.instrumental) seen.set(r.id, r);
    } catch (e) { /* 다음 검색어 */ }
    if (seen.size >= 8) break;
  }
  const results = [...seen.values()]
    .sort((a, b) => (b.syncedLyrics ? 1 : 0) - (a.syncedLyrics ? 1 : 0))
    .slice(0, 12)
    .map((r) => ({ id: r.id, track: r.trackName, artist: r.artistName, album: r.albumName || '', duration: Math.round(Number(r.duration) || 0), synced: !!r.syncedLyrics }));
  return { query: queries[0] || '', results };
}

async function setLyrics({ videoId, id }) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10000);
  const res = await fetch('https://lrclib.net/api/get/' + encodeURIComponent(id), { headers: { 'Lrclib-Client': 'yt-kpron/2.1' }, signal: ctrl.signal }).finally(() => clearTimeout(timer));
  if (!res.ok) throw new Error('lrclib ' + res.status);
  const pkg = await buildPkg(await res.json(), { manual: true });
  if (!pkg) return null;
  await chrome.storage.local.set({ [`lyr:${LYR_VER}:${videoId}`]: pkg });
  return pkg;
}

async function clearLyrics({ videoId }) {
  await chrome.storage.local.set({ [`lyr:${LYR_VER}:${videoId}`]: { none: true, manual: true, at: Date.now() } });
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === 'lyrics' && msg.videoId) {
    let job = lyricsJobs.get(msg.videoId);
    if (!job) {
      job = buildLyrics(msg).catch(() => null).finally(() => setTimeout(() => lyricsJobs.delete(msg.videoId), 1000));
      lyricsJobs.set(msg.videoId, job);
    }
    job.then((pkg) => sendResponse({ pkg }), () => sendResponse({ pkg: null }));
    return true;
  }
  if (msg && msg.type === 'search') {
    searchSongs(msg).then(sendResponse, () => sendResponse({ query: msg.query || '', results: [], error: true }));
    return true;
  }
  if (msg && msg.type === 'setLyrics' && msg.videoId && msg.id) {
    setLyrics(msg).then((pkg) => sendResponse({ pkg }), () => sendResponse({ pkg: null, error: true }));
    return true;
  }
  if (msg && msg.type === 'clearLyrics' && msg.videoId) {
    clearLyrics(msg).then(() => sendResponse({ ok: true }), () => sendResponse({ ok: false }));
    return true;
  }
  if (msg && msg.type === 'convert' && typeof msg.text === 'string') {
    convert(msg.text.slice(0, 500), typeof msg.hint === 'string' ? msg.hint.slice(0, 10) : '').then(sendResponse, () => sendResponse({ pron: '', translation: '', lang: '' }));
    return true;
  }
  return false;
});
