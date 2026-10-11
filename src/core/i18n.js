// Minimal shared translation helper (PLAN §10 / docs/06 §2). Only the two new render
// rows go through it today; the rest of the HUD is converted later, so this stays a
// flat key -> string table with an English default and Polish second.
const TABLES = {
  en: {
    'settings.drawDistance': 'Draw distance',
    'settings.farDetail': 'Far detail',
    'hud.rolled': 'ROLLED OVER',
    'hud.side': 'ON ITS SIDE',
    'hud.righting': 'RIGHTING',
  },
  pl: {
    'settings.drawDistance': 'Zasięg rysowania',
    'settings.farDetail': 'Daleki detal',
    'hud.rolled': 'PRZEWRÓT',
    'hud.side': 'NA BOKU',
    'hud.righting': 'PROSTUJE',
  },
};

let lang = 'en';
// Polish build stays Polish; anything else falls back to the English default.
try {
  const nav = (typeof globalThis !== 'undefined' && globalThis.navigator && globalThis.navigator.language) || '';
  if (/^pl/i.test(nav)) lang = 'pl';
} catch { /* node / no navigator: the English default stands */ }

export function setLang(l) { if (TABLES[l]) lang = l; return lang; }
export function getLang() { return lang; }

/** Key lookup: current table, then the English default, then the key itself. */
export function t(key) {
  const cur = TABLES[lang];
  if (cur && cur[key] !== undefined) return cur[key];
  return TABLES.en[key] !== undefined ? TABLES.en[key] : key;
}
