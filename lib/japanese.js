// 일본어 로마자(헵번식) / 가나 → 한글 발음
import { render, addCoda, Y_GLIDE, W_GLIDE, stripMarks } from './hangul.js';

const VOW = { a: 'ㅏ', i: 'ㅣ', u: 'ㅜ', e: 'ㅔ', o: 'ㅗ' };
// [초성, 반모음종류]  y: y-반모음, w: w-반모음
const ONSETS = {
  ky: ['ㅋ', 'y'], gy: ['ㄱ', 'y'], ny: ['ㄴ', 'y'], hy: ['ㅎ', 'y'], by: ['ㅂ', 'y'],
  py: ['ㅍ', 'y'], my: ['ㅁ', 'y'], ry: ['ㄹ', 'y'], sh: ['ㅅ', 'y'], ch: ['ㅊ', ''],
  ts: ['ㅊ', ''], jy: ['ㅈ', ''], dy: ['ㄷ', 'y'], ty: ['ㅌ', 'y'], sy: ['ㅅ', 'y'], zy: ['ㅈ', ''],
  k: ['ㅋ', ''], g: ['ㄱ', ''], s: ['ㅅ', ''], z: ['ㅈ', ''], t: ['ㅌ', ''], d: ['ㄷ', ''],
  n: ['ㄴ', ''], h: ['ㅎ', ''], f: ['ㅎ', 'w'], b: ['ㅂ', ''], p: ['ㅍ', ''], m: ['ㅁ', ''],
  r: ['ㄹ', ''], l: ['ㄹ', ''], j: ['ㅈ', ''], y: ['ㅇ', 'y'], w: ['ㅇ', 'w'], v: ['ㅂ', ''], c: ['ㅋ', ''],
};

export function romajiWord(word) {
  const w = stripMarks(word.toLowerCase()).replace(/[^a-z']/g, '');
  const sylls = [];
  let i = 0;
  while (i < w.length) {
    const c = w[i];
    if (c === "'" || c === '-') { i++; continue; }
    if (c in VOW) { sylls.push({ l: 'ㅇ', v: VOW[c], t: '' }); i++; continue; }
    const next = w[i + 1];
    // ん
    if (c === 'n' && (next === undefined || next === "'" || !(next in VOW || next === 'y'))) {
      addCoda(sylls, 'ㄴ'); i++; continue;
    }
    if (c === 'm' && next && 'bpm'.includes(next)) { addCoda(sylls, 'ㄴ'); i++; continue; }
    // っ (촉음): 겹자음 또는 tch
    if ((next === c && c !== 'n') || (c === 't' && w.substr(i + 1, 2) === 'ch')) {
      addCoda(sylls, 'ㅅ'); i++; continue;
    }
    let key = w.substr(i, 2) in ONSETS ? w.substr(i, 2) : c in ONSETS ? c : null;
    if (!key) { i++; continue; }
    const after = w[i + key.length];
    if (!(after in VOW)) {
      // 모음이 없는 자음(외래어 등): 'ㅡ'를 붙여 읽는다
      sylls.push({ l: ONSETS[key][0], v: key === 'ch' || key === 'sh' || key === 'j' ? 'ㅣ' : 'ㅡ', t: '' });
      i += key.length; continue;
    }
    const [l, glide] = ONSETS[key];
    let v = VOW[after];
    if (after === 'u' && ['s', 'z', 'ts'].includes(key)) v = 'ㅡ';
    else if (glide === 'y') v = key === 'sh' && after === 'e' ? 'ㅖ' : Y_GLIDE[v];
    else if (glide === 'w') v = key === 'w' && after === 'o' ? 'ㅗ' : W_GLIDE[v];
    sylls.push({ l, v, t: '' });
    i += key.length + 1;
  }
  return render(sylls);
}

// ── 가나 → 로마자 (구글 응답이 없을 때의 오프라인 대체) ──
const KANA = {
  あ: 'a', い: 'i', う: 'u', え: 'e', お: 'o', か: 'ka', き: 'ki', く: 'ku', け: 'ke', こ: 'ko',
  さ: 'sa', し: 'shi', す: 'su', せ: 'se', そ: 'so', た: 'ta', ち: 'chi', つ: 'tsu', て: 'te', と: 'to',
  な: 'na', に: 'ni', ぬ: 'nu', ね: 'ne', の: 'no', は: 'ha', ひ: 'hi', ふ: 'fu', へ: 'he', ほ: 'ho',
  ま: 'ma', み: 'mi', む: 'mu', め: 'me', も: 'mo', や: 'ya', ゆ: 'yu', よ: 'yo',
  ら: 'ra', り: 'ri', る: 'ru', れ: 're', ろ: 'ro', わ: 'wa', ゐ: 'i', ゑ: 'e', を: 'o', ん: "n'",
  が: 'ga', ぎ: 'gi', ぐ: 'gu', げ: 'ge', ご: 'go', ざ: 'za', じ: 'ji', ず: 'zu', ぜ: 'ze', ぞ: 'zo',
  だ: 'da', ぢ: 'ji', づ: 'zu', で: 'de', ど: 'do', ば: 'ba', び: 'bi', ぶ: 'bu', べ: 'be', ぼ: 'bo',
  ぱ: 'pa', ぴ: 'pi', ぷ: 'pu', ぺ: 'pe', ぽ: 'po', ゔ: 'vu',
  ぁ: 'a', ぃ: 'i', ぅ: 'u', ぇ: 'e', ぉ: 'o', ゎ: 'wa',
};
const SMALL_Y = { ゃ: 'ya', ゅ: 'yu', ょ: 'yo' };

export function kanaToRomaji(text) {
  // 가타카나 → 히라가나
  const s = text.replace(/[ァ-ヶ]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0x60));
  let out = '';
  let sokuon = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === 'っ') { sokuon = true; continue; }
    if (ch === 'ー') continue; // 장음 기호는 생략 (ラーメン→라멘)
    let r = KANA[ch];
    if (r === undefined) { out += /[　-〿＀-￯\s]/.test(ch) ? ' ' : ch; sokuon = false; continue; }
    const nx = s[i + 1];
    if (nx in SMALL_Y && /i$/.test(r)) {
      // きゃ→kya, しゃ→sha, ちゃ→cha, じゃ→ja
      const base = r.slice(0, -1);
      const y = SMALL_Y[nx];
      r = ['sh', 'ch', 'j'].includes(base) ? base + y.slice(1) : base + y;
      i++;
    } else if (nx && 'ぁぃぅぇぉ'.includes(nx) && /u$/.test(r)) {
      // ファ→fa, ウィ→wi
      r = r.slice(0, -1).replace(/^$/, 'w') + KANA[nx];
      i++;
    }
    if (sokuon) { r = (r.startsWith('ch') ? 't' : r[0]) + r; sokuon = false; }
    out += r;
  }
  return out;
}
