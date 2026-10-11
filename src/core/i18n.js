// Translation layer (PLAN §10 / docs/06 §2). English is the DEFAULT build language,
// Polish is one tap away on the Ustawienia screen (`LANGUAGE` row, persisted through
// settings.language + saveSettings). Nothing here changes behaviour: it maps a key to a
// string and nothing else.
//
// Key naming convention (flat, one dictionary per language, `<screen>.<name>`):
//   menu.*      main-menu rows            settings.*  settings rows + their values
//   val.*       shared value words (on/off/left/right/…)
//   controls.*  controls-legend actions   result.*    countdown/result modals
//   hud.*       HUD panels, strips, dials hud.wheel.* per-wheel state words
//   note.*      pace-note call words + distance words   touch.* pad labels
//   stage.*     stage (biome) names                     boot.* / toast.* loading + hotkey lines
// Adding a string = add it to `en` AND `pl`. A missing key falls back to `en`, then to
// the key itself (never a blank label). Width rule: a label must fit the pixel box it
// already has (src/game/pixel-font.js ADVANCE = 6 px/glyph), so where Polish is short
// the English wording is shortened too - never grow a panel.
const TABLES = {
  en: {
    // ---- main menu ----
    'menu.title': 'VOXEL RALLY',
    'menu.heading': 'MAIN MENU',
    'menu.start': 'Start  (enter)',
    'menu.stage': 'Stage: %s',
    'stage.forest': 'Forest', 'stage.mountain': 'Mountain', 'stage.swamp': 'Swamp',
    'stage.plateau': 'Plateau', 'stage.canyon': 'Canyon',
    'menu.settings': 'Settings',
    'menu.controls': 'Controls',
    // ---- settings rows ----
    'settings.heading': 'SETTINGS',
    'settings.blockTiles': 'Surface blocks',
    'settings.touch': 'Touch pad',
    'settings.handedness': 'Thumb side',
    'settings.coDriver': 'Co-driver notes',
    'settings.steer': 'STEERING',
    'settings.hud': 'HUD',
    'settings.fx': 'Effects',
    'settings.quality': 'Quality',
    'settings.post': 'Post',
    'settings.bloom': 'Bloom',
    'settings.grade': 'Grade',
    'settings.drawDistance': 'Draw distance',
    'settings.farDetail': 'Far detail',
    'settings.language': 'Language',
    'settings.back': 'Back  (esc)',
    // ---- row values ----
    'val.on': 'on', 'val.off': 'off', 'val.auto': 'auto',
    'val.left': 'left', 'val.right': 'right',
    'val.steerNormal': 'NORMAL', 'val.steerInvert': 'INVERTED',
    'val.hudFull': 'full', 'val.hudMinimal': 'minimal', 'val.hudOff': 'off',
    'val.qualLow': 'low', 'val.qualMedium': 'medium', 'val.qualHigh': 'high',
    'val.bloomLow': 'low', 'val.bloomMedium': 'medium', 'val.bloomHigh': 'high',
    'val.en': 'ENGLISH', 'val.pl': 'POLSKI',
    // ---- controls legend (key caps stay short: the table is drawn in two columns) ----
    'controls.heading': 'CONTROLS',
    'controls.throttle': 'throttle', 'controls.brake': 'brake', 'controls.steer': 'steer',
    'controls.handbrake': 'handbrake', 'controls.gear': 'gear', 'controls.reset': 'reset',
    'controls.start': 'start', 'controls.back': 'back', 'controls.camera': 'camera',
    'controls.hud': 'hud', 'controls.notes': 'co-driver', 'controls.pause': 'pause',
    'controls.dev': 'DEV panel', 'controls.padGas': 'pad gas',
    'controls.left': 'LEFT', 'controls.right': 'RIGHT', 'controls.gasBrake': 'gas, brake',
    // ---- HUD panels ----
    'hud.stage': 'STAGE', 'hud.gravel': 'GRAVEL',
    'hud.sector': 'SECTOR', 'hud.progress': 'PROGRESS', 'hud.metres': 'M',
    'hud.revs': 'REVS', 'hud.maxGas': 'MAX GAS',
    'hud.engine': 'ENGINE', 'hud.front': 'FRONT', 'hud.rear': 'REAR',
    'hud.damage': 'DAMAGE', 'hud.wheels': 'WHEELS',
    'hud.wheelFL': 'FL', 'hud.wheelFR': 'FR', 'hud.wheelRL': 'RL', 'hud.wheelRR': 'RR',
    'hud.kmh': 'KM/H',
    'hud.time': 'TIME', 'hud.split': 'SPLIT', 'hud.limit': 'LIMIT', 'hud.penalty': 'PEN',
    'hud.countdown': 'START IN %s s',
    'hud.rolled': 'ROLLED OVER', 'hud.side': 'ON ITS SIDE', 'hud.righting': 'RIGHTING',
    'hud.wheelAir': 'AIR', 'hud.wheelLock': 'LOCK', 'hud.wheelSlip': 'SLIP',
    'hud.wheelDrive': 'DRIVE', 'hud.wheelGrip': 'GRIP',
    // ---- result / DNF modal ----
    'result.finish': 'FINISH', 'result.dnf': 'DNF',
    'result.whyLimit': 'TIME LIMIT', 'result.whyGates': 'MISSED CHECKPOINTS',
    'result.whyStuck': 'CAR STALLED',
    'result.penalty': 'PENALTY',
    'result.restart': 'Restart  (enter)', 'result.resume': 'Resume  (esc)',
    // ---- pace notes: idiomatic rally call vocabulary ----
    'note.caution': 'CAUTION',
    'note.left': 'LEFT', 'note.right': 'RIGHT',
    'note.easyLeft': 'EASY LEFT', 'note.easyRight': 'EASY RIGHT',
    'note.sharpLeft': 'SHARP LEFT', 'note.sharpRight': 'SHARP RIGHT',
    'note.dontCut': "DON'T CUT",
    'note.horn': 'HORN', 'note.dissa': 'DISSA',
    'note.crest': 'CREST', 'note.dip': 'DIP', 'note.jump': 'JUMP',
    'note.water': 'WATER', 'note.bridge': 'BRIDGE', 'note.hant': 'HANT',
    'note.sev1': 'ONE', 'note.sev2': 'TWO', 'note.sev3': 'THREE',
    'note.sev4': 'FOUR', 'note.sev5': 'FIVE',
    'note.d5': 'FIVE', 'note.d10': 'TEN', 'note.d15': 'FIFTEEN', 'note.d20': 'TWENTY',
    'note.d25': 'TWENTY-FIVE', 'note.d30': 'THIRTY', 'note.d35': 'THIRTY-FIVE',
    'note.d40': 'FORTY', 'note.d45': 'FORTY-FIVE', 'note.d50': 'FIFTY',
    // ---- touch pads ----
    'touch.handbrake': 'HAND', 'touch.camera': 'CAM', 'touch.restart': 'RESET',
    'touch.menu': 'MENU', 'touch.steer': 'STEER',
    'touch.aGas': 'Throttle', 'touch.aBrake': 'Brake', 'touch.aHand': 'Handbrake',
    'touch.aMenu': 'Pause and menu', 'touch.aCam': 'Change camera', 'touch.aRestart': 'Restart stage',
    // ---- boot screen + hotkey toasts (src/main.js) ----
    'boot.cached': 'loading the saved stage…',
    'boot.generate': 'generating the whole stage…',
    'boot.cachedPct': 'loading stage: %s%', 'boot.generatePct': 'generating stage: %s%',
    'boot.chunks': 'chunks', 'boot.surface': 'surface', 'boot.megabytes': 'MB',
    'toast.steer': 'steering: %s', 'toast.hud': 'HUD: %s',
    'toast.notesOff': 'co-driver muted', 'toast.notesOn': 'co-driver: live notes',
    'toast.wash': 'car washed - the tyre rubber stays',
    'toast.lens': 'lens: %s',
    'val.lensClean': 'clean', 'val.lensFull': 'full', 'val.lensSoft': 'subtle',
    'toast.shot': 'shot mode: %s sim steps (1/120 s)',
  },
  // Polish set keeps the wording the game shipped with.
  pl: {
    'menu.title': 'VOXEL RALLY',
    'menu.heading': 'Menu główne',
    'menu.start': 'Start  (enter)',
    'menu.stage': 'Etap: %s',
    'stage.forest': 'Leśny', 'stage.mountain': 'Górski', 'stage.swamp': 'Bagno',
    'stage.plateau': 'Wyżyna', 'stage.canyon': 'Wąwóz',
    'menu.settings': 'Ustawienia',
    'menu.controls': 'Sterowanie',
    'settings.heading': 'Ustawienia',
    'settings.blockTiles': 'Bloki nawierzchni',
    'settings.touch': 'Sterowanie dotykiem',
    'settings.handedness': 'Kciuk sterujący',
    'settings.coDriver': 'Strzałki pilota',
    'settings.steer': 'KIEROWNICA',
    'settings.hud': 'HUD',
    'settings.fx': 'Efekty',
    'settings.quality': 'Jakość',
    'settings.post': 'Post',
    'settings.bloom': 'Bloom',
    'settings.grade': 'Grade',
    'settings.drawDistance': 'Zasięg rysowania',
    'settings.farDetail': 'Daleki detal',
    'settings.language': 'Język',
    'settings.back': 'Wróć  (esc)',
    'val.on': 'wł.', 'val.off': 'wył.', 'val.auto': 'auto',
    'val.left': 'lewy', 'val.right': 'prawy',
    'val.steerNormal': 'NORMALNA', 'val.steerInvert': 'ODWROTNA',
    'val.hudFull': 'pełny', 'val.hudMinimal': 'minimalny', 'val.hudOff': 'wyłączony',
    'val.qualLow': 'niska', 'val.qualMedium': 'średnia', 'val.qualHigh': 'wysoka',
    'val.bloomLow': 'niski', 'val.bloomMedium': 'średni', 'val.bloomHigh': 'wysoki',
    'val.en': 'ENGLISH', 'val.pl': 'POLSKI',
    'controls.heading': 'Sterowanie',
    'controls.throttle': 'gaz', 'controls.brake': 'hamulec', 'controls.steer': 'skręt',
    'controls.handbrake': 'ręczny', 'controls.gear': 'bieg', 'controls.reset': 'reset',
    'controls.start': 'start', 'controls.back': 'wróć', 'controls.camera': 'kamera',
    'controls.hud': 'hud', 'controls.notes': 'pilot', 'controls.pause': 'pauza',
    'controls.dev': 'DEV panel', 'controls.padGas': 'pad gaz',
    'controls.left': 'LEWA', 'controls.right': 'PRAWA', 'controls.gasBrake': 'gaz, ham',
    'hud.stage': 'ODCINEK', 'hud.gravel': 'SZUTER',
    'hud.sector': 'SEKTOR', 'hud.progress': 'POSTĘP', 'hud.metres': 'M',
    'hud.revs': 'OBROTY', 'hud.maxGas': 'MAX GAZ',
    'hud.engine': 'SILNIK', 'hud.front': 'PRZÓD', 'hud.rear': 'TYŁ',
    'hud.damage': 'USZKODZENIA', 'hud.wheels': 'KOŁA',
    'hud.wheelFL': 'PRZ L', 'hud.wheelFR': 'PRZ P', 'hud.wheelRL': 'TYŁ L', 'hud.wheelRR': 'TYŁ P',
    'hud.kmh': 'KM/H',
    'hud.time': 'CZAS', 'hud.split': 'SPLIT', 'hud.limit': 'LIMIT', 'hud.penalty': 'KARY',
    'hud.countdown': 'START ZA %s s',
    'hud.rolled': 'PRZEWRÓT', 'hud.side': 'NA BOKU', 'hud.righting': 'PROSTUJE',
    'hud.wheelAir': 'POWIETRZE', 'hud.wheelLock': 'BLOKADA', 'hud.wheelSlip': 'UŚLIZG',
    'hud.wheelDrive': 'NAPĘD', 'hud.wheelGrip': 'CZEPNE',
    'result.finish': 'META', 'result.dnf': 'DNF',
    'result.whyLimit': 'limit czasu', 'result.whyGates': 'dwa brakujące checkpointy',
    'result.whyStuck': 'auto stanęło',
    'result.penalty': 'KARA',
    'result.restart': 'Restart odcinka  (enter)', 'result.resume': 'Wróć do gry  (esc)',
    'note.caution': 'UWAGA',
    'note.left': 'LEWO', 'note.right': 'PRAWO',
    'note.easyLeft': 'SZYBKI LEWO', 'note.easyRight': 'SZYBKI PRAWO',
    'note.sharpLeft': 'OSTRO LEWO', 'note.sharpRight': 'OSTRO PRAWO',
    'note.dontCut': 'ZAWRÓT',
    'note.horn': 'PÓŁTORA', 'note.dissa': 'NEGATYW',
    'note.crest': 'GARB', 'note.dip': 'DOŁ', 'note.jump': 'SKOK',
    'note.water': 'WODA', 'note.bridge': 'MOST', 'note.hant': 'HANT',
    'note.sev1': '1', 'note.sev2': '2', 'note.sev3': '3', 'note.sev4': '4', 'note.sev5': '5',
    // The Polish board keeps the metres figure it always carved (the words are English-only).
    'note.d5': '5 M', 'note.d10': '10 M', 'note.d15': '15 M', 'note.d20': '20 M',
    'note.d25': '25 M', 'note.d30': '30 M', 'note.d35': '35 M', 'note.d40': '40 M',
    'note.d45': '45 M', 'note.d50': '50 M',
    'touch.handbrake': 'RĘCZNY', 'touch.camera': 'KAMERA', 'touch.restart': 'RESET',
    'touch.menu': 'MENU', 'touch.steer': 'SKRĘT',
    'touch.aGas': 'Gaz', 'touch.aBrake': 'Hamulec', 'touch.aHand': 'Hamulec ręczny',
    'touch.aMenu': 'Pauza i menu', 'touch.aCam': 'Zmień kamerę', 'touch.aRestart': 'Restart odcinka',
    'boot.cached': 'ładowanie zapisanego etapu…',
    'boot.generate': 'generowanie całego etapu…',
    'boot.cachedPct': 'wczytywanie etapu: %s%', 'boot.generatePct': 'generowanie etapu: %s%',
    'boot.chunks': 'chunków', 'boot.surface': 'nawierzchnia', 'boot.megabytes': 'MB',
    'toast.steer': 'kierownica: %s', 'toast.hud': 'HUD: %s',
    'toast.notesOff': 'pilot wyciszony', 'toast.notesOn': 'pilot: notatki na żywo',
    'toast.wash': 'auto umyte — guma na oponach zostaje',
    'toast.lens': 'obiektyw: %s',
    'val.lensClean': 'czysty', 'val.lensFull': 'pełny', 'val.lensSoft': 'dyskretny',
    'toast.shot': 'tryb zrzutu: %s kroków symulacji (1/120 s)',
  },
};

// Pixel boxes every label is drawn into (px at the scale noted; src/game/pixel-font.js
// ADVANCE = 6 px/glyph). Fixed HUD panels never resize, so the audit in
// src/debug/tests.js T39 measures every key below against these boxes at 1600x900,
// 390x844 and 844x390. Modal rows are audited against the real drawn row rect instead.
export const TEXT_BOXES = {
  'hud.engine': [38, 1], 'hud.front': [38, 1], 'hud.rear': [38, 1],
  'hud.wheelFL': [33, 1], 'hud.wheelFR': [33, 1], 'hud.wheelRL': [33, 1], 'hud.wheelRR': [33, 1],
  'hud.damage': [121, 1], 'hud.wheels': [121, 1], 'hud.revs': [134, 1], 'hud.maxGas': [50, 1],
  'hud.kmh': [52, 1], 'hud.time': [91, 1], 'hud.limit': [91, 1], 'hud.split': [91, 1],
  'hud.sector': [120, 1], 'hud.progress': [120, 1], 'hud.rolled': [96, 1],
  'hud.side': [96, 1], 'hud.righting': [96, 1],
  'hud.wheelAir': [121, 1], 'hud.wheelLock': [121, 1], 'hud.wheelSlip': [121, 1],
  'hud.wheelDrive': [121, 1], 'hud.wheelGrip': [121, 1],
  'touch.handbrake': [72, 1], 'touch.camera': [72, 1], 'touch.restart': [72, 1],
  'touch.menu': [72, 1], 'touch.steer': [120, 1],
};

let lang = 'en';                                            // English is the default build
const LANGS = ['en', 'pl'];

/** 'en' | 'pl' (anything else keeps the current language). Returns the language set. */
export function setLang(l) { if (LANGS.indexOf(l) >= 0) lang = l; return lang; }
export function getLang() { return lang; }
export function otherLang(l) { return l === 'pl' ? 'en' : 'pl'; }
export function languages() { return LANGS.slice(); }
export function table(l = lang) { return TABLES[l] || TABLES.en; }

/** Key lookup: current table, then the English default, then the key itself. */
export function t(key, vars) {
  const cur = TABLES[lang];
  let s = cur && cur[key] !== undefined ? cur[key] : (TABLES.en[key] !== undefined ? TABLES.en[key] : key);
  if (vars !== undefined) s = s.replace('%s', String(vars));
  return s;
}
