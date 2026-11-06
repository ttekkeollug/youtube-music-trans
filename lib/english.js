// 영어(ARPAbet 발음기호) → 한글 표기
// 외래어 표기법을 기반으로 노래 가사 읽기에 맞게 단순화했다.
import { render, addCoda, Y_GLIDE, W_GLIDE, stripMarks } from './hangul.js';

const VOWEL = {
  AA: ['ㅏ'], AE: ['ㅐ'], AH: ['ㅓ'], AO: ['ㅗ'], AW: ['ㅏ', 'ㅜ'], AY: ['ㅏ', 'ㅣ'],
  EH: ['ㅔ'], ER: ['ㅓ'], EY: ['ㅔ', 'ㅣ'], IH: ['ㅣ'], IY: ['ㅣ'], OW: ['ㅗ'],
  OY: ['ㅗ', 'ㅣ'], UH: ['ㅜ'], UW: ['ㅜ'],
};
const SHORT = new Set(['AE', 'EH', 'IH', 'AH', 'UH', 'AA']);
const ONSET = {
  B: 'ㅂ', CH: 'ㅊ', D: 'ㄷ', DH: 'ㄷ', F: 'ㅍ', G: 'ㄱ', HH: 'ㅎ', JH: 'ㅈ', K: 'ㅋ',
  L: 'ㄹ', M: 'ㅁ', N: 'ㄴ', NG: 'ㅇ', P: 'ㅍ', R: 'ㄹ', S: 'ㅅ', SH: 'ㅅ', T: 'ㅌ',
  TH: 'ㅅ', V: 'ㅂ', Z: 'ㅈ', ZH: 'ㅈ', W: 'ㅇ', Y: 'ㅇ',
};
// 모음 없이 홀로 남는 자음
const LONE = {
  B: ['ㅂ', 'ㅡ'], CH: ['ㅊ', 'ㅣ'], D: ['ㄷ', 'ㅡ'], DH: ['ㄷ', 'ㅡ'], F: ['ㅍ', 'ㅡ'],
  G: ['ㄱ', 'ㅡ'], JH: ['ㅈ', 'ㅣ'], K: ['ㅋ', 'ㅡ'], P: ['ㅍ', 'ㅡ'], S: ['ㅅ', 'ㅡ'],
  SH: ['ㅅ', 'ㅣ'], T: ['ㅌ', 'ㅡ'], TH: ['ㅅ', 'ㅡ'], V: ['ㅂ', 'ㅡ'], Z: ['ㅈ', 'ㅡ'],
  ZH: ['ㅈ', 'ㅣ'], W: ['ㅇ', 'ㅜ'], Y: ['ㅇ', 'ㅣ'], M: ['ㅁ', 'ㅡ'], N: ['ㄴ', 'ㅡ'],
};
const STOP_CODA = { K: 'ㄱ', P: 'ㅂ', T: 'ㅅ' };
const NASAL_CODA = { M: 'ㅁ', N: 'ㄴ', NG: 'ㅇ', L: 'ㄹ' };

function isVowel(p) {
  return p.replace('0', '') in VOWEL;
}

/** ARPAbet 배열(예: ['HH','AH0','L','OW']) → 한글 */
export function arpabetToHangul(phones) {
  const sylls = [];
  let pending = [];
  let lastVowel = null; // 직전 모음 정보 (받침 판단용)

  const emitLone = (c) => {
    if (c === 'R' || c === 'HH') return;
    if (c in NASAL_CODA) {
      const last = sylls[sylls.length - 1];
      if (last && !last.t) { last.t = NASAL_CODA[c]; return; }
      if (c === 'L') { sylls.push({ l: 'ㄹ', v: 'ㅡ', t: '' }); return; }
      if (c === 'NG') { addCoda(sylls, 'ㅇ'); return; }
    }
    const [l, v] = LONE[c] || ['ㅇ', 'ㅡ'];
    sylls.push({ l, v, t: '' });
  };

  // 모음 사이(혹은 끝)의 자음 묶음 처리. onsetNext: 다음에 모음이 오는가
  const flush = (cons, onsetNext) => {
    let list = cons.slice();
    let onset = null;
    if (onsetNext && list.length) onset = list.pop();
    // W/Y 반모음은 앞 자음과 결합할 수 있다
    let glide = null;
    if (onset === 'W' || onset === 'Y') {
      glide = onset;
      const prev = list[list.length - 1];
      if (prev && (glide === 'Y' || ['K', 'G', 'HH'].includes(prev)) && prev !== 'NG' && prev !== 'R') {
        onset = list.pop();
      } else onset = null;
    }
    // 첫 자음은 앞 음절의 받침이 될 수 있다
    if (list.length) {
      const c = list[0];
      const last = sylls[sylls.length - 1];
      if (last && !last.t && lastVowel) {
        if (c in NASAL_CODA && c !== 'L') { last.t = NASAL_CODA[c]; list.shift(); }
        else if (c === 'L') { last.t = 'ㄹ'; list.shift(); }
        else if (c in STOP_CODA && SHORT.has(lastVowel)) {
          // 짧은 모음 뒤 무성파열음은 받침 (cat→캣, book→북)
          last.t = STOP_CODA[c]; list.shift();
        } else if (c === 'R') list.shift();
      }
    }
    for (const c of list) emitLone(c);
    return { onset, glide };
  };

  for (let i = 0; i < phones.length; i++) {
    const p = phones[i];
    if (!isVowel(p)) { pending.push(p); continue; }
    const base = p.replace('0', '');
    const unstressed = p.endsWith('0');
    let { onset, glide } = flush(pending, true);
    pending = [];
    if (onset === 'NG') { addCoda(sylls, 'ㅇ'); onset = null; } // singing→싱잉
    let vs = VOWEL[base].slice();
    // 약모음 + 끝 L (apple→애플, little→리틀)
    const next = phones[i + 1];
    if (base === 'AH' && unstressed && next === 'L' && (i + 2 >= phones.length || !isVowel(phones[i + 2]))) vs = ['ㅡ'];
    if (glide === 'W') vs[0] = W_GLIDE[vs[0]] || vs[0];
    if (glide === 'Y' || onset === 'SH') vs[0] = Y_GLIDE[vs[0]] || vs[0];
    if (glide === 'W' && base === 'UW' && onset == null) vs[0] = 'ㅜ';
    let l = onset ? ONSET[onset] : 'ㅇ';
    // L 초성 앞 음절에 ㄹ 받침 추가 (hello→헬로, play→플레이)
    if (onset === 'L') {
      const last = sylls[sylls.length - 1];
      if (last && !last.t) last.t = 'ㄹ';
    }
    sylls.push({ l, v: vs[0], t: '' });
    for (let k = 1; k < vs.length; k++) sylls.push({ l: 'ㅇ', v: vs[k], t: '' });
    lastVowel = vs.length > 1 ? 'DIPH' : base;
    // ER 바로 뒤에 모음이 오면 r 소리를 다음 음절 초성으로 (every→에버리)
    if (base === 'ER' && next && isVowel(next)) pending = ['R'];
  }
  flush(pending, false);
  return render(sylls);
}

// ── 사전 밖 단어 / 다른 로마자 언어용 철자 → 발음 규칙 ──
const VOW_LETTER = { a: 'AA', e: 'EH', i: 'IY', o: 'AO', u: 'UW' };
export function spellToPhones(word, english = false) {
  let w = stripMarks(word.toLowerCase().replace(/ñ/g, 'ny').replace(/ß/g, 'ss')).replace(/[^a-z]/g, '');
  if (english && w.length > 3 && /[^aeiou]e$/.test(w)) w = w.slice(0, -1); // 끝 묵음 e
  const out = [];
  const isV = (ch) => 'aeiou'.includes(ch);
  for (let i = 0; i < w.length; i++) {
    const c = w[i], n = w[i + 1], n2 = w[i + 2];
    if (c === n && !isV(c)) continue; // 겹자음 축약
    const tri = w.substr(i, 3), di = w.substr(i, 2);
    if (tri === 'sch') { out.push('SH'); i += 2; continue; }
    if (tri === 'tch') { out.push('CH'); i += 2; continue; }
    if (di === 'ch') { out.push('CH'); i++; continue; }
    if (di === 'sh') { out.push('SH'); i++; continue; }
    if (di === 'th') { out.push('TH'); i++; continue; }
    if (di === 'ph') { out.push('F'); i++; continue; }
    if (di === 'ck') { out.push('K'); i++; continue; }
    if (di === 'ng') { out.push('NG'); i++; continue; }
    if (di === 'gh') { out.push('G'); i++; continue; }
    if (di === 'qu') { out.push('K'); if (!'ei'.includes(n2 || '')) out.push('W'); i++; continue; }
    if (english) {
      if (di === 'ee' || di === 'ea') { out.push('IY'); i++; continue; }
      if (di === 'oo') { out.push('UW'); i++; continue; }
      if (di === 'ou' || di === 'ow') { out.push('AW'); i++; continue; }
      if (di === 'ay' || di === 'ai') { out.push('EY'); i++; continue; }
    }
    if (isV(c)) { out.push(VOW_LETTER[c]); continue; }
    switch (c) {
      case 'c': out.push(n && 'eiy'.includes(n) ? 'S' : 'K'); break;
      case 'x': out.push('K', 'S'); break;
      case 'j': out.push('JH'); break;
      case 'q': out.push('K'); break;
      case 'h': if (n && isV(n)) out.push('HH'); break;
      case 'y': out.push(n && isV(n) ? 'Y' : 'IY'); break;
      case 'w': out.push(n && isV(n) ? 'W' : 'UW'); break;
      default: {
        const m = { b: 'B', d: 'D', f: 'F', g: 'G', k: 'K', l: 'L', m: 'M', n: 'N', p: 'P', r: 'R', s: 'S', t: 'T', v: 'V', z: 'Z' }[c];
        if (m) out.push(m);
      }
    }
  }
  return out;
}

/** 단어 단위 영어 → 한글. lookup(word) 은 ARPAbet 문자열 또는 undefined */
export function englishWord(word, lookup) {
  const key = word.toLowerCase().replace(/^'+|'+$/g, '');
  if (!key) return '';
  let phones = lookup(key);
  if (!phones && key.endsWith("'s")) {
    const b = lookup(key.slice(0, -2));
    if (b) phones = b + ' Z';
  }
  if (!phones && key.endsWith('in\'')) phones = lookup(key.slice(0, -1) + 'g'); // lovin' → loving
  const arr = phones ? phones.split(' ') : spellToPhones(key, true);
  return arpabetToHangul(arr);
}

export function latinWord(word) {
  return arpabetToHangul(spellToPhones(word, false));
}
