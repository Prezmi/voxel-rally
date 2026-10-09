// Runtime settings (docs/06 §2). Mutated by debug keys, persisted by core/save.js.
export const QUALITY = { LOW: 0, MED: 1, HIGH: 2 };

export const settings = {
  quality: QUALITY.MED,

  // Rendering
  renderScale: 1.0,          // 1.0 = native; LOW drops to 0.75
  shadows: true,
  post: true,                // F5: bloom/grade/grain composite (off at LOW, see setQuality)
  drawDistance: 260,         // m, docs/03 §1
  fullRadius: 110,
  simpleRadius: 200,

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
  cameraShake: 1.0,
  // docs/04 §6 wants dirt on the lens; PLAN.md §8 #5 says the camera must not
  // "swim" and the player must read the road. The lens is the dirt the player
  // cannot look away from, so it is a dialled accent by default, not a effect.
  lensDirt: 0.45,            // 0 = off, 1 = full docs/04 §6 strength

  // Audio (F5)
  audioEnabled: false,
  masterGain: 0.8,

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

export function qualityPreset(q) {
  settings.quality = q;
  if (q === QUALITY.LOW) {
    settings.renderScale = 0.75; settings.shadows = false; settings.post = false;
    settings.drawDistance = 170; settings.fullRadius = 80; settings.simpleRadius = 140;
  } else if (q === QUALITY.MED) {
    settings.renderScale = 1.0; settings.shadows = true; settings.post = true;
    settings.drawDistance = 260; settings.fullRadius = 110; settings.simpleRadius = 200;
  } else {
    settings.renderScale = 1.0; settings.shadows = true; settings.post = true;
    settings.drawDistance = 320; settings.fullRadius = 130; settings.simpleRadius = 240;
  }
}
