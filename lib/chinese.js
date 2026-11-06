// 중국어 병음 → 한글 (중국어 외래어 표기법 기반)
import { render, DEPALATAL } from './hangul.js';

const INITIALS = {
  b: 'ㅂ', p: 'ㅍ', m: 'ㅁ', f: 'ㅍ', d: 'ㄷ', t: 'ㅌ', n: 'ㄴ', l: 'ㄹ', g: 'ㄱ', k: 'ㅋ', h: 'ㅎ',
  j: 'ㅈ', q: 'ㅊ', x: 'ㅅ', zh: 'ㅈ', ch: 'ㅊ', sh: 'ㅅ', r: 'ㄹ', z: 'ㅉ', c: 'ㅊ', s: 'ㅆ',
};
// 운모 → [[모음, 받침], ...]
const FINALS = {
  a: [['ㅏ']], o: [['ㅗ']], e: [['ㅓ']], ai: [['ㅏ'], ['ㅣ']], ei: [['ㅔ'], ['ㅣ']], ao: [['ㅏ'], ['ㅗ']],
  ou: [['ㅓ'], ['ㅜ']], an: [['ㅏ', 'ㄴ']], en: [['ㅓ', 'ㄴ']], ang: [['ㅏ', 'ㅇ']], eng: [['ㅓ', 'ㅇ']],
  ong: [['ㅗ', 'ㅇ']], er: [['ㅓ', 'ㄹ']],
  i: [['ㅣ']], ia: [['ㅑ']], ie: [['ㅖ']], iao: [['ㅑ'], ['ㅗ']], iu: [['ㅠ']], ian: [['ㅖ', 'ㄴ']],
  in: [['ㅣ', 'ㄴ']], iang: [['ㅑ', 'ㅇ']], ing: [['ㅣ', 'ㅇ']], iong: [['ㅠ', 'ㅇ']],
  u: [['ㅜ']], ua: [['ㅘ']], uo: [['ㅝ']], uai: [['ㅘ'], ['ㅣ']], ui: [['ㅜ'], ['ㅣ']], uan: [['ㅘ', 'ㄴ']],
  un: [['ㅜ', 'ㄴ']], uang: [['ㅘ', 'ㅇ']], ueng: [['ㅝ', 'ㅇ']],
  v: [['ㅟ']], ve: [['ㅞ']], van: [['ㅟ'], ['ㅏ', 'ㄴ']], vn: [['ㅟ', 'ㄴ']],
};
// y·w 로 시작하는 음절(성모 없음)
const ZERO = {
  yi: 'i', ya: 'ia', ye: 'ie', yao: 'iao', you: 'iu', yan: 'ian', yin: 'in', yang: 'iang', ying: 'ing',
  yong: 'iong', yu: 'v', yue: 've', yuan: 'van', yun: 'vn', wu: 'u', wa: 'ua', wo: 'uo', wai: 'uai',
  wang: 'uang', weng: 'ueng',
};
const ZERO_SPECIAL = { wei: [['ㅞ'], ['ㅣ']], wan: [['ㅘ', 'ㄴ']], wen: [['ㅝ', 'ㄴ']] };
const PLAIN_ZERO = ['a', 'o', 'e', 'ai', 'ei', 'ao', 'ou', 'an', 'en', 'ang', 'eng', 'er'];

function syllable(s) {
  if (ZERO_SPECIAL[s]) return ZERO_SPECIAL[s].map(([v, t]) => ({ l: 'ㅇ', v, t: t || '' }));
  if (ZERO[s]) return build('', ZERO[s]);
  if (PLAIN_ZERO.includes(s)) return build('', s);
  const ini = /^(zh|ch|sh|[bpmfdtnlgkhjqxrzcs])/.exec(s);
  if (!ini) return null;
  let fin = s.slice(ini[1].length);
  if ('jqx'.includes(ini[1]) && fin[0] === 'u') fin = 'v' + fin.slice(1);
  if (['zh', 'ch', 'sh', 'r', 'z', 'c', 's'].includes(ini[1]) && fin === 'i') {
    return [{ l: INITIALS[ini[1]], v: 'ㅡ', t: '' }];
  }
  return build(ini[1], fin);
}

function build(ini, fin) {
  const f = FINALS[fin];
  if (!f) return null;
  return f.map(([v, t], k) => {
    let vv = v;
    if (k === 0 && ['j', 'q', 'zh', 'ch', 'sh'].includes(ini)) vv = DEPALATAL[v] || v;
    return { l: k === 0 && ini ? INITIALS[ini] : 'ㅇ', v: vv, t: t || '' };
  });
}

/** 띄어쓰기 없이 붙은 병음 단어를 음절로 분해(가장 긴 음절 우선 + 되돌아가기) */
function split(word, memo = new Map()) {
  if (word === '') return [];
  if (memo.has(word)) return memo.get(word);
  let res = null;
  for (let len = Math.min(6, word.length); len >= 1 && !res; len--) {
    const head = word.slice(0, len);
    const sy = syllable(head);
    if (!sy) continue;
    const rest = split(word.slice(len), memo);
    if (rest) res = [sy, ...rest];
  }
  memo.set(word, res);
  return res;
}

export function normalizePinyin(s) {
  return s.normalize('NFD').replace(/ü/g, 'v').replace(/[̀-ͯ]/g, '').toLowerCase();
}

/** 병음 단어 → 한글. 병음이 아니면 null */
export function pinyinWord(word) {
  const parts = normalizePinyin(word).split("'").filter(Boolean);
  let out = '';
  for (const p of parts) {
    const sy = split(p.replace(/[^a-z]/g, ''));
    if (!sy) return null;
    out += sy.map(render).join('');
  }
  return out;
}
