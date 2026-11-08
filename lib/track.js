// 유튜브 자막 트랙 처리 + 가사 싱크 자동 계산 (콘텐츠 스크립트·테스트 공용, 일반 스크립트)
(function (root) {
  /** 플레이어가 쓴 URL(pot 토큰 포함)에서 언어만 바꿔 다른 트랙 URL을 만든다 */
  function buildTrackUrl(baseUrl, lang, kind) {
    const u = new URL(baseUrl, 'https://www.youtube.com');
    u.searchParams.set('lang', lang);
    if (kind) u.searchParams.set('kind', kind); else u.searchParams.delete('kind');
    u.searchParams.delete('tlang');
    u.searchParams.set('fmt', 'json3');
    return u.href;
  }

  /** json3 → [{t, e, text}] (자동 자막의 단어 조각은 한 줄로 합친다) */
  function parseJson3(json) {
    const out = [];
    for (const ev of (json && json.events) || []) {
      if (!ev.segs) continue;
      const text = ev.segs.map((s) => s.utf8 || '').join('').replace(/\s*\n\s*/g, ' ').trim();
      if (!text) continue;
      const t = (ev.tStartMs || 0) / 1000;
      out.push({ t, e: t + (ev.dDurationMs || 0) / 1000, text });
    }
    out.sort((a, b) => a.t - b.t);
    return out;
  }

  /** time 에 화면에 있어야 할 줄 (겹치면 가장 늦게 시작한 것) */
  function activeCue(cues, time) {
    let best = null;
    for (const c of cues) {
      if (c.t > time + 0.05) break;
      if (time < c.e + 0.2) best = c;
    }
    return best;
  }

  /**
   * 한국어 자막만 보이는 영상에서 원어 줄을 가져올 트랙 고르기.
   * 1) 말하는 언어(자동 자막 언어)와 같은 수동 자막  2) 자동 자막  3) 한국어가 아닌 수동 자막
   */
  function pickSourceTrack(tracks) {
    const list = tracks || [];
    const asr = list.find((t) => t.kind === 'asr');
    const notKo = (t) => !/^ko/i.test(t.lang);
    if (asr && notKo(asr)) {
      const manual = list.find((t) => t.kind !== 'asr' && t.lang.split('-')[0] === asr.lang.split('-')[0]);
      return manual || asr;
    }
    return list.find((t) => t.kind !== 'asr' && notKo(t)) || null;
  }

  // 원문끼리 비교: 가타카나→히라가나, 가나·한자·영숫자·한글만 남긴 2-gram
  function norm(s) {
    return String(s).normalize('NFKC').toLowerCase()
      .replace(/[^぀-ヿ㐀-鿿a-z0-9가-힣]/g, '')
      .replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));
  }
  function grams(s) {
    const n = norm(s);
    const m = new Map();
    for (let i = 0; i + 1 < n.length; i++) {
      const k = n.slice(i, i + 2);
      m.set(k, (m.get(k) || 0) + 1);
    }
    return m;
  }
  function contain(a, b) {
    let x = 0, sa = 0;
    for (const v of a.values()) sa += v;
    for (const [k, v] of a) if (b.has(k)) x += Math.min(v, b.get(k));
    return sa ? x / sa : 0;
  }

  /**
   * 자동 자막(음성 인식)과 가사 타임스탬프를 비교해 영상↔가사 시간차를 구한다.
   * -30~+30초를 0.25초 간격으로 대 보고, 자동 자막이 그 시각 가사 줄과 가장 많이 겹치는 값을 고른다.
   * @returns {{offset:number, confidence:number}|null} confidence = 최고점/평균 (1.8 이상이면 믿을 만함)
   */
  function alignOffset(cues, lines) {
    const L = lines.filter((l) => typeof l.t === 'number');
    if (cues.length < 5 || L.length < 5) return null;
    const LG = L.map((l) => grams(l.text));
    const CG = cues.map((c) => grams(c.text));
    const lineAt = (t) => {
      let lo = 0, hi = L.length - 1, ans = -1;
      while (lo <= hi) { const mid = (lo + hi) >> 1; if (L[mid].t <= t) { ans = mid; lo = mid + 1; } else hi = mid - 1; }
      return ans;
    };
    let best = null, sum = 0, n = 0;
    for (let off = -30; off <= 30.001; off += 0.25) {
      let s = 0;
      for (let i = 0; i < cues.length; i++) {
        if (!CG[i].size) continue;
        const tt = cues[i].t - off;
        const li = lineAt(tt + 0.3);
        if (li < 0) continue;
        // 자동 자막은 줄이 시작될 때 나오므로, 줄 시작에 가까울수록 높은 점수
        const lag = Math.max(0, tt - L[li].t);
        s += contain(CG[i], LG[li]) * (0.4 + 0.6 * Math.exp(-lag / 2.5));
      }
      sum += s; n++;
      if (!best || s > best.s) best = { off: Math.round(off * 100) / 100, s };
    }
    const mean = sum / n;
    if (!best || best.s <= 0 || mean <= 0) return null;
    return { offset: best.off, confidence: best.s / mean };
  }

  /** 가사 줄 중 time(+offset 보정) 에 불리고 있는 줄 */
  function lineAtTime(lines, time, offset) {
    let cur = -1;
    for (let i = 0; i < lines.length; i++) {
      if (typeof lines[i].t !== 'number') continue;
      if (lines[i].t + offset <= time + 0.15) cur = i; else break;
    }
    if (cur < 0) return -1;
    let next = null;
    for (let i = cur + 1; i < lines.length; i++) if (typeof lines[i].t === 'number' && lines[i].t > lines[cur].t) { next = lines[i]; break; }
    const end = next ? next.t + offset : lines[cur].t + offset + 8;
    // 다음 줄까지 너무 길면(간주) 10초 뒤에는 숨긴다
    if (time >= end || time - (lines[cur].t + offset) > 10) return -1;
    return cur;
  }

  root.YKTrack = { buildTrackUrl, parseJson3, activeCue, pickSourceTrack, alignOffset, lineAtTime };
})(typeof globalThis !== 'undefined' ? globalThis : this);
