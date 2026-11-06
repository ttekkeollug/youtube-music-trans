// 한국어 번역 자막 ↔ 원문 가사 줄 매칭 (콘텐츠 스크립트·테스트 공용, 일반 스크립트)
(function (root) {
  function norm(s) {
    return String(s).toLowerCase().replace(/[^가-힣a-z0-9]/g, '');
  }
  function grams(s) {
    const n = norm(s);
    const m = new Map();
    const add = (k) => m.set(k, (m.get(k) || 0) + 1);
    for (let i = 0; i < n.length; i++) {
      add(n[i]);
      if (i + 1 < n.length) add(n.slice(i, i + 2));
    }
    return m;
  }
  function dice(a, b) {
    let x = 0, sa = 0, sb = 0;
    for (const v of a.values()) sa += v;
    for (const v of b.values()) sb += v;
    for (const [k, v] of a) if (b.has(k)) x += Math.min(v, b.get(k));
    return sa + sb ? (2 * x) / (sa + sb) : 0;
  }
  // 짧은 자막(한 줄을 둘로 나눈 반쪽)이 가사 줄 안에 얼마나 들어 있는가
  function containment(cue, line) {
    let x = 0, sc = 0;
    for (const v of cue.values()) sc += v;
    for (const [k, v] of cue) if (line.has(k)) x += Math.min(v, line.get(k));
    return sc ? x / sc : 0;
  }
  function median(arr) {
    const s = [...arr].sort((p, q) => p - q);
    return s[Math.floor(s.length / 2)];
  }

  /**
   * lines: [{t: 초|null, ko: 번역문, ...}]
   * 반환된 matcher.match(자막, 영상시각) → {index, score} 또는 null
   */
  function createMatcher(lines) {
    const G = lines.map((l) => grams(l.ko || ''));
    const timed = lines.some((l) => typeof l.t === 'number');
    const offsets = [];
    return {
      match(text, time) {
        const cg = grams(text);
        if (!cg.size) return null;
        const useContain = norm(text).length >= 4;
        const dices = G.map((g) => dice(cg, g));
        const sims = useContain ? G.map((g, i) => Math.max(dices[i], 0.8 * containment(cg, g))) : dices;
        const learned = offsets.length >= 2;
        const off = learned ? median(offsets) : 0;
        const weight = learned ? 0.45 : 0.2;
        let best = -1, bestScore = -1;
        for (let i = 0; i < lines.length; i++) {
          let score = sims[i];
          if (timed && typeof lines[i].t === 'number' && typeof time === 'number') {
            score += weight * Math.exp(-Math.abs(time - (lines[i].t + off)) / 6);
          }
          if (score > bestScore) { bestScore = score; best = i; }
        }
        if (best < 0) return null;
        // 확신할 수 있는 매칭으로 영상↔가사 시간차 학습
        let second = 0; // 내용이 다른 줄 중 최고 유사도 (반복 후렴은 제외)
        for (let i = 0; i < lines.length; i++) {
          if (lines[i].ko !== lines[best].ko && sims[i] > second) second = sims[i];
        }
        if (timed && typeof time === 'number' && typeof lines[best].t === 'number' &&
            dices[best] >= 0.45 && sims[best] - second >= 0.15) {
          offsets.push(time - lines[best].t);
          if (offsets.length > 9) offsets.shift();
        }
        const minScore = learned ? 0.35 : 0.3;
        if (bestScore < minScore) return null;
        return { index: best, score: bestScore, sim: sims[best] };
      },
    };
  }

  root.YKMatch = { createMatcher, grams, dice };
})(typeof globalThis !== 'undefined' ? globalThis : this);
