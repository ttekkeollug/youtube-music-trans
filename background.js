// 서비스 워커: 언어 판별·로마자 표기(구글 번역) + 한글 발음 변환
import { pronounce, detectScript } from './lib/convert.js';
import { analyzeTitle, parseLrc, pickBest, searchLrclib } from './lib/lyrics.js';

let dictPromise = null;
function loadDict() {
  if (!dictPromise) {
    dictPromise = fetch(chrome.runtime.getURL('data/cmudict.txt'))
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

async function google(text) {
  const url =
    'https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=ko&dt=t&dt=rm&q=' +
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

async function convert(text) {
  if (cache.has(text)) return cache.get(text);
  const script = detectScript(text);
  let g = null;
  if (script !== 'ko') {
    try {
      g = await google(text);
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
  const translation = g && g.translation && !lang.startsWith('ko') && g.translation !== text ? g.translation : '';
  const result = { pron, translation, lang };
  // 구글 응답이 있었을 때만 캐시(실패 결과가 굳지 않도록)
  if (g || script === 'ko') remember(text, result);
  return result;
}

// ── 번역 자막 영상용: 원문 가사 찾아 줄마다 발음·번역 준비 ──
const LYR_VER = 'v2';
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
  if (stored && (stored.lines || Date.now() - stored.at < 6 * 3600 * 1000)) return stored.lines ? stored : null;

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
  if (!best && info.korean.length) {
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
  let raw = best.syncedLyrics ? parseLrc(best.syncedLyrics) : [];
  if (!raw.length) raw = String(best.plainLyrics || '').split('\n').map((t) => ({ t: null, text: t.trim() })).filter((l) => l.text);
  raw = raw.slice(0, 150);
  const uniq = [...new Set(raw.map((l) => l.text))];
  const conv = new Map();
  await mapLimit(uniq, 4, async (text) => conv.set(text, await convert(text)));
  const lines = raw.map((l) => {
    const c = conv.get(l.text) || {};
    return { t: l.t, text: l.text, pron: c.pron || '', ko: c.translation || '' };
  });
  if (!lines.some((l) => l.ko)) return null; // 번역 실패 시 저장하지 않고 다음에 재시도
  const pkg = { id: best.id, track: best.trackName, artist: best.artistName, lines, at: Date.now() };
  await chrome.storage.local.set({ [key]: pkg });
  return pkg;
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
  if (msg && msg.type === 'convert' && typeof msg.text === 'string') {
    convert(msg.text.slice(0, 500)).then(sendResponse, () => sendResponse({ pron: '', translation: '', lang: '' }));
    return true;
  }
  return false;
});
