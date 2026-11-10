// LRCLIB 에서 원문 가사 찾기
const RE_HANGUL = /[가-힣ㄱ-ㆎ]/;
const RE_CJK = /[぀-ヿ㐀-鿿豈-﫿]/;
const NOISE = /(cover|covered|커버|歌ってみた|불러\s*보았다|불러봤|mv|m\/v|official|music\s*video|lyrics?|가사|자막|번역|발음|full\s*ver|video|live|라이브|acoustic|piano|ver\.)/i;
const OPEN = '([（【〔{［';
const CLOSE = ')]）】〕}］';
const QUOTES = /[「『“"]([^」』”"]{1,80})[」』”"]/g;

/** 제목을 괄호 깊이를 고려해 구분자로 자른 조각들로 만든다 */
function chunksOf(title) {
  const groups = []; // 괄호 안 내용
  let outside = '';
  let depth = 0, buf = '';
  for (const ch of title) {
    if (OPEN.includes(ch)) { if (depth === 0) { outside += ' \u0000 '; buf = ''; } else buf += ch; depth++; continue; }
    if (CLOSE.includes(ch) && depth > 0) { depth--; if (depth === 0) groups.push(buf); else buf += ch; continue; }
    if (depth > 0) buf += ch; else outside += ch;
  }
  if (depth > 0 && buf) groups.push(buf);
  const SEP = /\s+\/\s*|\s*\/\s+|\s*[|｜ㅣ×]\s*|\s+[-–—:]\s+|\s+[-–—]|[-–—]\s+|\s*[:：]\s+|\s+l\s+|\s+x\s+/i;
  const pieces = [];
  for (const seg of outside.split(/\u0000/)) for (const p of seg.split(SEP)) pieces.push({ text: p, inBracket: false });
  for (const g of groups) for (const p of g.split(SEP)) pieces.push({ text: p, inBracket: true });
  return pieces.map((p) => ({ ...p, text: p.text.replace(/[「」『』“”"]/g, ' ').replace(/\s+/g, ' ').trim() })).filter((p) => p.text);
}

/** 한글 단어를 빼고 원어(일본어·중국어·영어) 부분만 남긴다 */
function foreignPart(s) {
  s = s.replace(/[(（][^)）]*[\uac00-\ud7a3][^)）]*[)）]/g, ' '); // 抜錨(발묘) → 抜錨
  return s.split(/\s+/).filter((w) => !RE_HANGUL.test(w)).join(' ').trim();
}

const okQuery = (s) => s.length >= 2 || RE_CJK.test(s);

/**
 * @returns {{queries: string[], korean: string[], terms: string[]}}
 *   queries: 바로 검색할 검색어, korean: 원어 표기가 없을 때 번역해서 검색할 한국어 조각,
 *   terms: 결과 검증용 원어 조각
 */
export function analyzeTitle(rawTitle, channel = '') {
  const title = String(rawTitle || '').replace(/^\(\d+\)\s*/, '').replace(/\s*-\s*YouTube\s*$/i, '').trim();
  const ch = String(channel || '').toLowerCase();
  const chWords = new Set(ch.split(/\s+/).filter((w) => w.length >= 2));
  const isSinger = (t) => {
    const low = t.toLowerCase();
    if (ch && (ch.includes(low) || low.includes(ch))) return true;
    const ws = low.split(/\s+/).filter(Boolean);
    return ws.length > 0 && ws.every((w) => chWords.has(w));
  };

  const quoted = [...title.matchAll(QUOTES)].map((m) => m[1].trim()).filter(Boolean);
  const terms = [];
  const korean = [];
  for (const piece of chunksOf(title)) {
    let t = piece.text;
    if (NOISE.test(t)) {
      // "아오쿠모 린 Cover" 처럼 커버 가수 조각은 버린다
      t = t.replace(new RegExp(NOISE.source, 'gi'), ' ').replace(/\s+/g, ' ').trim();
      if (!t || isSinger(t) || !piece.inBracket) continue;
    }
    if (!t || isSinger(t)) continue;
    const f = foreignPart(t);
    if (f && okQuery(f)) terms.push(f);
    else if (RE_HANGUL.test(t)) korean.push(t);
  }
  for (const q of quoted) if (!terms.includes(q)) terms.unshift(q);
  const uniqTerms = [...new Set(terms)].slice(0, 4);

  const queries = [];
  // 일본어·중국어 조각(곡명일 가능성 높음)을 앞에 둔다
  const cjk = uniqTerms.filter((t) => RE_CJK.test(t));
  const latin = uniqTerms.filter((t) => !RE_CJK.test(t));
  const ordered = [...cjk, ...latin];
  const pair = (a, b) => a && b && !a.includes(b) && !b.includes(a) && queries.push(`${a} ${b}`);
  pair(ordered[0], ordered[1]);
  pair(ordered[0], ordered[2]);
  for (const t of ordered) queries.push(t);
  const seen = new Set();
  return {
    queries: queries.filter((q) => okQuery(q) && !seen.has(q.toLowerCase()) && seen.add(q.toLowerCase())).slice(0, 5),
    korean: [...new Set(korean)].slice(0, 3),
    terms: uniqTerms,
  };
}

export function buildQueries(rawTitle, channel = '') {
  return analyzeTitle(rawTitle, channel).queries;
}

export function parseLrc(synced) {
  const out = [];
  for (const line of String(synced || '').split('\n')) {
    const stamps = [...line.matchAll(/\[(\d+):(\d+(?:\.\d+)?)\]/g)];
    const text = line.replace(/\[[^\]]*\]/g, '').trim();
    if (!stamps.length || !text) continue;
    for (const s of stamps) out.push({ t: Number(s[1]) * 60 + Number(s[2]), text });
  }
  return out.sort((a, b) => a.t - b.t);
}

function hangulRatio(s) {
  const letters = s.match(/[\p{L}]/gu) || [];
  if (!letters.length) return 0;
  return (s.match(/[가-힣]/g) || []).length / letters.length;
}

const squash = (s) => String(s || '').toLowerCase().normalize('NFKC').replace(/[\s・·.,'’!?！？、。~〜\-–_()（）\[\]]/g, '');

/**
 * 검색 결과 중 영상에 맞는 가사 선택. 곡명이 제목 조각과 맞지 않으면 고르지 않는다.
 * @param terms 제목에서 뽑은 원어 조각(번역된 조각 포함)
 */
export function pickBest(results, { title = '', duration = 0, terms = [] } = {}) {
  const hay = [squash(title), ...terms.map(squash)].filter(Boolean);
  let best = null, bestScore = -Infinity;
  for (const r of results) {
    const lyr = r.syncedLyrics || r.plainLyrics;
    if (!lyr || r.instrumental) continue;
    // 한국어 노래는 대상 아님. 원문+한국어 번역이 섞인 업로드는 원문 줄이 30% 이상이면 사용
    const allLines = String(lyr).split('\n').map((l) => l.replace(/\[[^\]]*\]/g, '').trim()).filter(Boolean);
    const foreignLines = allLines.filter((l) => !/[\uac00-\ud7a3]/.test(l));
    if (hangulRatio(lyr) > 0.3 && foreignLines.length < allLines.length * 0.3) continue;
    const artist = squash(r.artistName);
    // 곡명에서 가수 이름 조각은 뺀다 ("Vaundy - ZERO" 가 제목의 "Vaundy" 로 맞았다고 보지 않게)
    const artistWords = String(r.artistName || '').split(/[,、&×x]|\bfeat\.?|\bft\.?/i).map(squash).filter(Boolean);
    const isArtistish = (x) => x === artist || (artist && artist.includes(x)) || artistWords.some((w) => w && (w === x || x.includes(w) || w.includes(x)));
    const segs = String(r.trackName || '')
      .replace(/[(（[]?\s*(feat|ft)\.?\s[^)）\]]*[)）\]]?/gi, ' ') // feat. 가수 부분 제거
      .split(/\s[-–]\s|[(（]|\s\/\s|[：|｜]/).map(squash).filter((x) => x && !isArtistish(x) && !/^(musicvideo|mv|officialvideo|lyricvideo)$/.test(x));
    // 제목 조각 중 가수 이름인 것은 곡명 일치 근거로 쓰지 않는다
    const hayNoArtist = hay.filter((h) => !isArtistish(h));
    const trackHit = segs.some((track) => hay.some((h) => h.includes(track)) || hayNoArtist.some((h) => h.length >= 2 && track.includes(h) && h.length >= track.length * 0.6));
    const artistHit = artist.length > 0 && hay.some((h) => h.includes(artist) || (artist.includes(h) && h.length >= 2));
    if (!trackHit) continue;
    let score = 2;
    if (artistHit) score += 1;
    if (r.syncedLyrics) score += 1.5;
    // 영상 제목을 그대로 곡명으로 올린 업로드(한글 곡명)는 타임스탬프가 없으면 뒤로
    if (/[\uac00-\ud7a3]/.test(String(r.trackName || '')) && !r.syncedLyrics) score -= 1;
    if (duration && r.duration) score -= Math.min(2, Math.abs(duration - r.duration) / 40);
    if (score > bestScore) { bestScore = score; best = r; }
  }
  return best;
}

/** 한국어 문장끼리 비슷한 정도 (글자 2-gram Dice) */
export function koSimilarity(a, b) {
  const g = (t) => {
    const n = String(t).replace(/[^\uac00-\ud7a3]/g, '');
    const m = new Map();
    for (let i = 0; i < n.length; i++) {
      m.set(n[i], (m.get(n[i]) || 0) + 1);
      if (i + 1 < n.length) m.set(n.slice(i, i + 2), (m.get(n.slice(i, i + 2)) || 0) + 1);
    }
    return m;
  };
  const A = g(a), B = g(b);
  let x = 0, sa = 0, sb = 0;
  for (const v of A.values()) sa += v;
  for (const v of B.values()) sb += v;
  for (const [k, v] of A) if (B.has(k)) x += Math.min(v, B.get(k));
  return sa + sb ? (2 * x) / (sa + sb) : 0;
}

export async function searchLrclib(q, fetchImpl = fetch) {
  const url = 'https://lrclib.net/api/search?q=' + encodeURIComponent(q);
  const opts = { headers: { 'Lrclib-Client': 'yt-kpron/1.2.0' } };
  // 응답 없는 요청에 묶여 가사 준비가 끝나지 않는 일이 없도록 8초 제한
  const timed = async () => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    try { return await fetchImpl(url, { ...opts, signal: ctrl.signal }); } finally { clearTimeout(timer); }
  };
  let res = await timed();
  if (res.status === 429 || res.status >= 500) {
    // 요청 제한·일시 오류는 잠시 후 한 번 더
    await new Promise((r) => setTimeout(r, 1500));
    res = await timed();
  }
  if (!res.ok) throw new Error('lrclib ' + res.status);
  const data = await res.json();
  return Array.isArray(data) ? data : [];
}
