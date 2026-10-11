// Runtime settings (docs/06 §2). Mutated by debug keys, persisted by core/save.js.
export const QUALITY = { LOW: 0, MED: 1, HIGH: 2 };

export const settings = {
  quality: QUALITY.MED,

  // Rendering
  renderScale: 1.0,          // 1.0 = native; LOW drops to 0.75
  shadows: true,
  // POST (src/render/post/composer.js): scene -> half-float HDR, quarter/eighth bright
  // + separable gaussian bloom, one composite pass that tone maps (AgX), grades and
  // writes the canvas. Off = the plain direct-to-canvas path, unchanged. The old
  // single-pass chain was gated off on drivers whose offscreen RT -> canvas blit
  // composited nothing (SYSTEM-NOTES §15); the composer re-checks half-float FBO
  // support and disables itself there, so POST off stays the guaranteed fallback.
  post: true,
  bloom: 'MEDIUM',           // 'LOW' | 'MEDIUM' | 'HIGH' -> POST_TUNE.bloom row
  grade: true,               // the split-tone / contrast / vignette / grain half
  // SHAFTS: the one extra eighth-res quad in the composite graph (postGraph gates it).
  // The renderer passes this through post.setConfig, so it is a real dial and not a
  // default the composer falls back to. LOW drops it with the cheapest graph.
  shafts: true,
  drawDistance: 1000,        // m, docs/03 §1 - the outer edge of EVERYTHING streamed:
                             // terrain silhouette bands, hill band and the far vegetation
                             // billboard band. Must stay past vegFarDistance or the
                             // vegetation LOD has no chunk to draw in the outer ring.
                             // Menu steps: DRAW_DISTANCE_STEPS.
  // FAR DETAIL: the one switch that trades the distant bands for frame rate. Off = no
  // 16 m hill band beyond hillFarRadius and a much shorter far billboard band; the near
  // and mid bands are never touched, so the drive itself reads identically.
  farDetail: true,
  fullRadius: 110,
  simpleRadius: 220,
  // Outer edge of the far vegetation billboard band (streaming.js _rebuildProps).
  // The far band is one 2-tri quad per tree, so pushing it out is cheap; the per-band
  // instance caps, not this radius, are what bound the triangle count.
  vegFarDistance: 620,
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
  // Speed feel (src/render/camera.js). Each is a 0..1 gain on a term that is itself
  // smoothed (1 - exp / critically damped) and hard-clamped in camera.js, so the rig
  // can never lurch or make the player ill: FOV ceiling 20 deg, roll ceiling 6 deg,
  // ride-height ceiling 0.26 m. The existing cameraShake ceiling is untouched.
  speedFov: 1.0,             // FOV widens with speed
  cornerLean: 0.55,          // camera rolls into the corner with lateral acceleration
  rideSag: 0.60,             // rig drops at speed: the downforce read

  // Audio (F5)
  audioEnabled: false,
  masterGain: 0.8,

  // HUD (PLAN.md §10: CMR "Game Displays: Full / Minimal / Off")
  hudMode: 'FULL',             // FULL | MINIMAL | OFF, cycled with N
  // Build language (src/core/i18n.js): 'en' default, 'pl' selectable on the Ustawienia
  // screen. Persisted like every other preference, applied by the HUD at boot.
  language: 'en',
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

const PERSISTED_KEYS = ['quality', 'shadows', 'post', 'bloom', 'grade', 'drawDistance', 'farDetail', 'vegFarDistance', 'blockTiles', 'fx', 'difficulty',
  'assists', 'keyboardAsPad', 'deadzone', 'invertSteer', 'cameraMode', 'hudMode',
  'showCoDriverArrows', 'touchOverlay', 'touchHandedness', 'lensDirt', 'audioEnabled', 'masterGain',
  'language', 'map'];
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

// ------------------------------------------------ far distance (render budget)
// The visible world is carried by cheap far levels of detail, never by raw geometry:
// the outer terrain bands are 8 m / 16 m cell silhouettes and every distant tree is
// ONE camera-facing quad (2 tris). The near (1 m) and mid (2 m) bands keep the radii
// they always had, only the outer bands grew.
//   ring 0 full 1 m   -> fullRadius
//   ring 1 simple 2 m -> simpleRadius
//   ring 2 4 m        -> hillMidRadius()   (streaming.js)
//   ring 3 8 m        -> hillFarRadius()   (streaming.js)
//   ring 4 16 m       -> drawDistance      (only with settings.farDetail)
export const DRAW_DISTANCE_STEPS = [400, 700, 1000, 1600];
// Target radii per preset: LOW reaches at least 700 m, HIGH roughly 1200 m.
export const FAR_RADII = {
  LOW: { drawDistance: 700, vegFarDistance: 460, farDetail: false },
  MED: { drawDistance: 1000, vegFarDistance: 620, farDetail: true },
  HIGH: { drawDistance: 1200, vegFarDistance: 760, farDetail: true },
};

/** Next menu step up, wrapping. Keeps the value inside DRAW_DISTANCE_STEPS. */
export function cycleDrawDistance() {
  const s = DRAW_DISTANCE_STEPS;
  let i = s.findIndex((v) => v > settings.drawDistance);
  if (i < 0) i = 0;
  settings.drawDistance = s[i];
  if (settings.vegFarDistance > settings.drawDistance) settings.vegFarDistance = settings.drawDistance;
  return settings.drawDistance;
}

/** Fog must never show a hard wall inside the streamed disc, so `far` sits past the
 *  draw distance and `near` stays clamped, or the mid-distance ground hazes out. */
export function fogNearFor(dd = settings.drawDistance) {
  return Math.min(420, Math.max(120, dd * 0.32));
}
export function fogFarFor(dd = settings.drawDistance) {
  return Math.round(Math.max(dd * 1.06, 260));
}

/** BLOOM row: LOW -> MEDIUM -> HIGH -> wrap. The composer re-reads this per frame. */
export const BLOOM_STEPS = ['LOW', 'MEDIUM', 'HIGH'];
export function cycleBloom() {
  const i = BLOOM_STEPS.indexOf(settings.bloom);
  settings.bloom = BLOOM_STEPS[((i < 0 ? 1 : i) + 1) % BLOOM_STEPS.length];
  return settings.bloom;
}

/** POST/BLOOM/GRADE mapped onto the quality presets: LOW still runs the composite,
 *  but the cheapest graph (one mip, 3 taps, quarter only) — see passGraph(). */
export function postForPreset(q) {
  settings.bloom = q === QUALITY.LOW ? 'LOW' : (q === QUALITY.MED ? 'MEDIUM' : 'HIGH');
  return settings.bloom;
}

export function qualityPreset(q) {
  settings.quality = q;
  const far = q === QUALITY.LOW ? FAR_RADII.LOW : (q === QUALITY.MED ? FAR_RADII.MED : FAR_RADII.HIGH);
  if (q === QUALITY.LOW) {
    settings.renderScale = 0.75; settings.shadows = false; settings.post = true; settings.shafts = false; postForPreset(q);
    settings.fullRadius = 80; settings.simpleRadius = 160; settings.fxScale = 0.5;
  } else if (q === QUALITY.MED) {
    settings.renderScale = 1.0; settings.shadows = true; settings.post = true; settings.shafts = true; postForPreset(q);
    settings.fullRadius = 110; settings.simpleRadius = 220; settings.fxScale = 1.0;
  } else {
    settings.renderScale = 1.0; settings.shadows = true; settings.post = true; settings.shafts = true; postForPreset(q);
    settings.fullRadius = 130; settings.simpleRadius = 260; settings.fxScale = 1.0;
  }
  settings.drawDistance = far.drawDistance;
  settings.vegFarDistance = far.vegFarDistance;
  settings.farDetail = far.farDetail;
}
