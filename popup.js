const DEFAULTS = { enabled: true, showPron: true, showTrans: false, lyricsMode: true, showOrig: true, origFallback: true, noCapMode: true, noCapAsr: false, scale: 0.85, color: '#ffe066' };

chrome.storage.sync.get(DEFAULTS, (s) => {
  for (const [key, def] of Object.entries(DEFAULTS)) {
    const el = document.getElementById(key);
    if (typeof def === 'boolean') el.checked = !!s[key];
    else el.value = s[key];
    el.addEventListener('input', () => {
      let v = typeof def === 'boolean' ? el.checked : el.value;
      if (typeof def === 'number') v = Number(v);
      chrome.storage.sync.set({ [key]: v });
    });
  }
});
