// Runtime settings (docs/06 §2). Mutated by debug keys, persisted by core/save.js.
export const QUALITY = { LOW: 0, MED: 1, HIGH: 2 };

export const settings = {
  quality: QUALITY.MED,

  // Rendering
  renderScale: 1.0,          // 1.0 = native; LOW drops to 0.75
  shadows: true,
  post: false,               // F5 composite: GATED OFF (see SYSTEM-NOTES §15) — the offscreen
                             // RT -> canvas blit of PostChain composites nothing on this
                             // driver, so the base ACES path is the correct render.
  drawDistance: 330,         // m, docs/03 §1 - must stay past vegFarDistance or the
                             // vegetation LOD has no chunk to draw in the outer ring
  fullRadius: 110,
  simpleRadius: 220,
  // Outer edge of the far vegetation billboard band (streaming.js _rebuildProps).
  // The far band is one 2-tri quad per tree, so pushing it out is cheap; the per-band
  // instance caps, not this radius, are what bound the triangle count.
  vegFarDistance: 320,
  // Visual-only block tiles over the road band + verge (assets/models/stage_blocks.glb).
  // Read-only layer: it reads the surface ids the carve already assigned, it never
  // touches the heightfield or physics. Switch off with `settings.blockTiles = false`.
  blockTiles: true,
  // Particle FX (src/fx): exhaust backfire plumes, wheel dust, treeline leaves,
  // dust motes. One switch for weak devices: `fx` off/on, `fxScale` the capacity
  // dial (1.0 desktop, 0.5 mobile / LOW, see main.js + qualityPreset).
  fx: true,
  fxScale: 1.0,

  // Simulation / difficulty (docs/02 §10: assists change limiters, never mu)
  difficulty: 'RALLY',       // NOVICE | RALLY | PRO
  assists: { abs: false, tc: false, counterSteer: false, autoShift: true, brakeMarker: true },

  // Controls (docs/06 §5)
  keyboardAsPad: true,       // binary -> analog with 120 ms ramp
  steerRampMs: 120,
  deadzone: 0.08,
  invertSteer: false,
  steerRateLimit: true,

  // Camera
  cameraMode: 'CHASE',       // CHASE | ONBOARD | BUMPER | CINEMATIC | FREE
  cameraShake: 0.35,        // was 1.0: the rig swung half a metre and swam
  // docs/04 §6 wants dirt on the lens; PLAN.md §8 #5 says the camera must not
  // "swim" and the player must read the road. The lens is the dirt the player
  // cannot look away from, so it is a dialled accent by default, not a effect.
  lensDirt: 0.45,            // 0 = off, 1 = full docs/04 §6 strength

  // Audio (F5)
  audioEnabled: false,
  masterGain: 0.8,

  // HUD (PLAN.md §10: CMR "Game Displays: Full / Minimal / Off")
  hudMode: 'FULL',             // FULL | MINIMAL | OFF, cycled with N
  showCoDriverArrows: true,    // CMR options: co-driver arrows On/Off
  // Nakładka sterowania dotykowego (skills/game-ui-ux #7): 'auto' = pokaż przy
  // coarse pointerze / ?touch=on, 'on' | 'off' ustawia menu USTAWIENIA.
  touchOverlay: 'auto',
  // 'right' = kolumna gazu/hamulca pod prawym kciukiem (domyślne), 'left' = lustro.
  touchHandedness: 'right',

  // Debug
  showPhysicsHud: false,
  showSurfaceProbe: false,
  showProfiler: true,
  showTests: false,
  slowMo: 1.0,
  paused: false,
};

export const DIFFICULTY_ASSISTS = {
  NOVICE: { abs: true, tc: true, counterSteer: true, autoShift: true, brakeMarker: true },
  RALLY: { abs: false, tc: false, counterSteer: false, autoShift: true, brakeMarker: false },
  PRO: { abs: false, tc: false, counterSteer: false, autoShift: false, brakeMarker: false },
};

export function applyDifficulty(name) {
  if (!DIFFICULTY_ASSISTS[name]) return;
  settings.difficulty = name;
  settings.assists = { ...DIFFICULTY_ASSISTS[name] };
}

// ---------------------------------------------------------------- persistence
// docs/06 §2 planned a `core/save.js`; there is none, so the settings payload lives
// here. The storage key is TAGGED with a schema number, because an untagged / older
// payload may carry assumptions the current mapping does not share, and `invertSteer`
// is the case that matters. Pre-v2 builds never stored `invertSteer` explicitly, so a
// legacy payload has no opinion about the sign; letting an old payload land on top of
// the corrected mapping would invert steering for exactly the returning players who
// now report it inverted. A legacy payload restores invertSteer ONLY when it states
// it explicitly as a boolean, otherwise the explicit default (false) wins, and every
// save writes the field explicitly so it can never again be implicit.
export const SETTINGS_SCHEMA = 2;
export const SETTINGS_KEY = 'mc-rally.settings.v2';
export const LEGACY_SETTINGS_KEY = 'mc-rally.v1';   // the untagged docs/06 §2 key

const PERSISTED_KEYS = ['quality', 'shadows', 'drawDistance', 'vegFarDistance', 'blockTiles', 'fx', 'difficulty',
  'assists', 'keyboardAsPad', 'deadzone', 'invertSteer', 'cameraMode', 'hudMode',
  'showCoDriverArrows', 'touchOverlay', 'touchHandedness', 'lensDirt', 'audioEnabled', 'masterGain'];
const DEFAULTS = (() => {
  const d = {};
  for (const k of PERSISTED_KEYS) d[k] = settings[k];
  return d;
})();

/** Any stored payload (untagged v1 or v2) -> an explicit, current one. */
export function migrateSettings(raw) {
  const out = { ...DEFAULTS };
  if (!raw || typeof raw !== 'object') return out;
  for (const k of PERSISTED_KEYS) {
    if (k === 'invertSteer') {
      if (typeof raw.invertSteer === 'boolean') out.invertSteer = raw.invertSteer;
      else if (typeof raw.steerInvert === 'boolean') out.invertSteer = raw.steerInvert;
      else out.invertSteer = false;            // legacy implicit invert: dropped
    } else if (raw[k] !== undefined && raw[k] !== null) out[k] = raw[k];
  }
  return out;
}

/** Restore a persisted payload onto `settings`. It can never introduce an invert. */
export function loadSettings(storage = (typeof globalThis !== 'undefined' ? globalThis.localStorage : null)) {
  if (!storage) return null;
  let raw = null;
  try {
    const s = storage.getItem(SETTINGS_KEY);
    raw = s ? JSON.parse(s) : null;
    if (!raw) {                                  // first run under the tagged key
      const legacy = storage.getItem(LEGACY_SETTINGS_KEY);
      raw = legacy ? JSON.parse(legacy) : null;
    }
  } catch { raw = null; }
  if (!raw) return null;                           // nothing stored: current defaults stand
  const m = migrateSettings(raw);
  for (const k of PERSISTED_KEYS) settings[k] = m[k];
  if (raw) saveSettings(settings, storage);      // re-tag the migrated payload once
  return m;
}

export function saveSettings(s = settings, storage = (typeof globalThis !== 'undefined' ? globalThis.localStorage : null)) {
  if (!storage) return null;
  const payload = { schema: SETTINGS_SCHEMA };
  for (const k of PERSISTED_KEYS) payload[k] = s[k];
  payload.invertSteer = !!s.invertSteer;         // always explicit, never implicit
  try { storage.setItem(SETTINGS_KEY, JSON.stringify(payload)); } catch { /* quota / private mode */ }
  return payload;
}

export function qualityPreset(q) {
  settings.quality = q;
  if (q === QUALITY.LOW) {
    settings.renderScale = 0.75; settings.shadows = false; settings.post = false;
    settings.drawDistance = 250; settings.fullRadius = 80; settings.simpleRadius = 160;
    settings.vegFarDistance = 240; settings.fxScale = 0.5;
  } else if (q === QUALITY.MED) {
    settings.renderScale = 1.0; settings.shadows = true; settings.post = false;
    settings.drawDistance = 330; settings.fullRadius = 110; settings.simpleRadius = 220;
    settings.vegFarDistance = 320; settings.fxScale = 1.0;
  } else {
    settings.renderScale = 1.0; settings.shadows = true; settings.post = false;
    settings.drawDistance = 380; settings.fullRadius = 130; settings.simpleRadius = 260;
    settings.vegFarDistance = 360; settings.fxScale = 1.0;
  }
}
