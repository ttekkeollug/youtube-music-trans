// 한글 음절 조합 유틸리티
const L = 'ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ';
const V = 'ㅏㅐㅑㅒㅓㅔㅕㅖㅗㅘㅙㅚㅛㅜㅝㅞㅟㅠㅡㅢㅣ';
const T = ['', 'ㄱ', 'ㄲ', 'ㄳ', 'ㄴ', 'ㄵ', 'ㄶ', 'ㄷ', 'ㄹ', 'ㄺ', 'ㄻ', 'ㄼ', 'ㄽ', 'ㄾ', 'ㄿ', 'ㅀ', 'ㅁ', 'ㅂ', 'ㅄ', 'ㅅ', 'ㅆ', 'ㅇ', 'ㅈ', 'ㅊ', 'ㅋ', 'ㅌ', 'ㅍ', 'ㅎ'];

export function compose(l, v, t = '') {
  const li = L.indexOf(l || 'ㅇ');
  const vi = V.indexOf(v);
  const ti = T.indexOf(t || '');
  if (li < 0 || vi < 0 || ti < 0) return '';
  return String.fromCharCode(0xac00 + (li * 21 + vi) * 28 + ti);
}

/** 음절 배열 [{l, v, t}] 을 문자열로 */
export function render(sylls) {
  return sylls.map((s) => compose(s.l, s.v, s.t)).join('');
}

/** 앞 음절에 받침을 붙일 수 있으면 붙이고, 아니면 'ㅇ+ㅡ+받침' 음절을 새로 만든다 */
export function addCoda(sylls, coda) {
  const last = sylls[sylls.length - 1];
  if (last && !last.t) last.t = coda;
  else sylls.push({ l: 'ㅇ', v: 'ㅡ', t: coda });
}

// y-반모음 결합 / w-반모음 결합 표
export const Y_GLIDE = { 'ㅏ': 'ㅑ', 'ㅐ': 'ㅒ', 'ㅓ': 'ㅕ', 'ㅔ': 'ㅖ', 'ㅗ': 'ㅛ', 'ㅜ': 'ㅠ', 'ㅣ': 'ㅣ', 'ㅡ': 'ㅣ' };
export const W_GLIDE = { 'ㅏ': 'ㅘ', 'ㅐ': 'ㅙ', 'ㅓ': 'ㅝ', 'ㅔ': 'ㅞ', 'ㅗ': 'ㅝ', 'ㅜ': 'ㅜ', 'ㅣ': 'ㅟ', 'ㅡ': 'ㅜ' };
export const DEPALATAL = { 'ㅑ': 'ㅏ', 'ㅒ': 'ㅐ', 'ㅕ': 'ㅓ', 'ㅖ': 'ㅔ', 'ㅛ': 'ㅗ', 'ㅠ': 'ㅜ' };

export function stripMarks(s) {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '');
}
