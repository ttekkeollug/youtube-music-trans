// 자막 한 줄 → 한글 발음. 언어 판별 결과와 구글 로마자 표기를 받아 처리한다.
import { englishWord, latinWord } from './english.js';
import { romajiWord, kanaToRomaji } from './japanese.js';
import { pinyinWord } from './chinese.js';

const RE_KANA = /[぀-ヿㇰ-ㇿ]/;
const RE_HAN = /[㐀-鿿豈-﫿]/;
const RE_HANGUL = /[가-힣ㄱ-ㆎ]/;
const RE_LATIN = /[A-Za-zÀ-ɏ]/;
const TOKEN = /[A-Za-zÀ-ɏ']+|[^A-Za-zÀ-ɏ'\s]+/g;

export function detectScript(text) {
  if (RE_KANA.test(text)) return 'ja';
  if (RE_HAN.test(text)) return 'zh';
  if (RE_HANGUL.test(text)) return 'ko';
  if (RE_LATIN.test(text)) return 'latin';
  return 'other';
}

/** 원문에 그대로 나오는 로마자 단어 집합 (일본어·중국어 가사 속 영어 단어 판별용) */
function latinWordsIn(text) {
  return new Set((text.match(/[A-Za-z']+/g) || []).map((w) => w.toLowerCase()));
}

function mapTokens(src, fn) {
  return (src.match(TOKEN) || [])
    .map((tok) => (RE_LATIN.test(tok) ? fn(tok) : tok.replace(/[♪♫]/g, '').trim()))
    .filter(Boolean)
    .join(' ')
    .replace(/\s+([,.!?、。！？])/g, '$1')
    .trim();
}

/**
 * @param {string} text  자막 원문
 * @param {{lang?: string, roman?: string}} g  구글 응답(없을 수 있음)
 * @param {(w: string) => string|undefined} lookup  영어 발음사전 조회
 */
export function pronounce(text, g, lookup) {
  const script = detectScript(text);
  const lang = (g && g.lang) || '';
  const roman = g && g.roman ? g.roman : '';
  const eng = (w) => englishWord(w, lookup);

  if (script === 'ko') {
    // 한국어 가사 속 영어 단어만 변환
    if (!RE_LATIN.test(text)) return '';
    return mapTokens(text, (w) => (/^[A-Za-z']+$/.test(w) ? eng(w) : latinWord(w)));
  }

  if (script === 'ja' || (script === 'zh' && lang.startsWith('ja'))) {
    const keep = latinWordsIn(text);
    const src = roman || (RE_HAN.test(text) ? '' : kanaToRomaji(text));
    if (!src) return '';
    return mapTokens(src, (w) => (keep.has(w.toLowerCase()) ? eng(w) : romajiWord(w)));
  }

  if (script === 'zh') {
    if (!roman) return '';
    const keep = latinWordsIn(text);
    return mapTokens(roman, (w) => (keep.has(w.toLowerCase()) ? eng(w) : pinyinWord(w) ?? latinWord(w)));
  }

  if (script === 'latin') {
    const isEnglish = !lang || lang === 'en' || lang === 'und';
    return mapTokens(text, isEnglish ? eng : latinWord);
  }

  // 러시아어·태국어 등: 구글 로마자 표기를 소리 나는 대로 읽는다
  if (!roman) return '';
  return mapTokens(roman, latinWord);
}
