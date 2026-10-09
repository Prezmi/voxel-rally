// EMITTERS — the per-surface dirt rules of docs/04 §4.2.
// Every surface answers three questions: what it throws (thick / wet / dust),
// where it lands (a 16 panel x 4 wheel transfer matrix) and what colour it has
// (the surface `dirtColor` from the single source of truth, world/surfaces.js).
// The matrix is what makes the four masks different in *location*, not just in
// brightness — that is risk R4 of docs/07 ("brud wygląda jak szara mgła").
//
// Transfer rows are given per panel as [FL, FR, RL, RR] weights: how much of one
// wheel's emission ends up on that panel. Front wheels throw forward-and-up
// (maska, szyba, próg), rear wheels throw the rooster tail (nadkola tylne, boki,
// dach, tył), and every wheel sprays the underside.
import { SURF, SURFACES } from '../world/surfaces.js';
import { PANELS, PANEL_INDEX, PANEL_COUNT } from './panel-dirt.js';

const TRANSFER = {
  // Loose, dry, dusty: the rooster tail. Gravel, dirt, sand, peat. Rear wheels
  // throw up and over the car, so the roof, the wing and the rear take the most;
  // the nose stays almost clean (docs/04 "progi, tylne nadkola, tyl, dach").
  looseRear: {
    hood: [0.01, 0.01, 0.005, 0.005],
    roof: [0.04, 0.04, 0.22, 0.22],
    screenF: [0.02, 0.02, 0.005, 0.005],
    screenR: [0.00, 0.00, 0.12, 0.12],
    sillL: [0.04, 0.01, 0.07, 0.01],
    sillR: [0.01, 0.04, 0.01, 0.07],
    flankL: [0.01, 0.00, 0.13, 0.03],
    flankR: [0.00, 0.01, 0.03, 0.13],
    archFL: [0.05, 0.01, 0.00, 0.00],
    archFR: [0.01, 0.05, 0.00, 0.00],
    archRL: [0.00, 0.00, 0.20, 0.05],
    archRR: [0.00, 0.05, 0.00, 0.20],
    rear: [0.00, 0.00, 0.16, 0.16],
    front: [0.01, 0.01, 0.00, 0.00],
    under: [0.03, 0.03, 0.04, 0.04],
    wing: [0.00, 0.00, 0.18, 0.18],
  },
  // Thick wet plates: mud and grass. The front wheels throw the spray forward onto
  // the nose and the windscreen, everything else is slung low (docs "progi,
  // nadkola, kola, maska (przy wodzie), sp6d, tył").
  mud: {
    hood: [0.26, 0.26, 0.02, 0.02],
    roof: [0.01, 0.01, 0.02, 0.02],
    screenF: [0.14, 0.14, 0.01, 0.01],
    screenR: [0.00, 0.00, 0.02, 0.02],
    sillL: [0.18, 0.04, 0.22, 0.05],
    sillR: [0.04, 0.18, 0.05, 0.22],
    flankL: [0.05, 0.01, 0.20, 0.05],
    flankR: [0.01, 0.05, 0.05, 0.20],
    archFL: [0.24, 0.06, 0.00, 0.00],
    archFR: [0.06, 0.24, 0.00, 0.00],
    archRL: [0.00, 0.00, 0.24, 0.06],
    archRR: [0.00, 0.06, 0.00, 0.24],
    rear: [0.00, 0.00, 0.18, 0.18],
    front: [0.16, 0.16, 0.00, 0.00],
    under: [0.28, 0.28, 0.28, 0.28],
    wing: [0.00, 0.00, 0.02, 0.02],
  },
  // Almost nothing leaves an asphalt road: a film of tyre-worn dust on the sills
  // and the front, brake dust on the windscreen. The real deposit is rubber on the
  // tyres, which is a separate channel (docs/04 "guma na oponach").
  hard: {
    hood: [0.00, 0.00, 0.00, 0.00],
    roof: [0.00, 0.00, 0.00, 0.00],
    screenF: [0.05, 0.05, 0.00, 0.00],
    screenR: [0.00, 0.00, 0.00, 0.00],
    sillL: [0.04, 0.00, 0.06, 0.00],
    sillR: [0.00, 0.04, 0.00, 0.06],
    flankL: [0.00, 0.00, 0.01, 0.00],
    flankR: [0.00, 0.00, 0.00, 0.01],
    archFL: [0.02, 0.00, 0.00, 0.00],
    archFR: [0.00, 0.02, 0.00, 0.00],
    archRL: [0.00, 0.00, 0.02, 0.00],
    archRR: [0.00, 0.00, 0.00, 0.02],
    rear: [0.00, 0.00, 0.00, 0.00],
    front: [0.05, 0.05, 0.00, 0.00],
    under: [0.02, 0.02, 0.02, 0.02],
    wing: [0.00, 0.00, 0.00, 0.00],
  },
  // Snow: no dirt, a wet sheen that whitens and dries fast (docs channel `g`).
  snow: {
    hood: [0.03, 0.03, 0.00, 0.00],
    roof: [0.00, 0.00, 0.01, 0.01],
    screenF: [0.09, 0.09, 0.00, 0.00],
    screenR: [0.00, 0.00, 0.01, 0.01],
    sillL: [0.07, 0.01, 0.14, 0.02],
    sillR: [0.01, 0.07, 0.02, 0.14],
    flankL: [0.01, 0.00, 0.07, 0.01],
    flankR: [0.00, 0.01, 0.01, 0.07],
    archFL: [0.10, 0.02, 0.00, 0.00],
    archFR: [0.02, 0.10, 0.00, 0.00],
    archRL: [0.00, 0.00, 0.12, 0.03],
    archRR: [0.00, 0.03, 0.00, 0.12],
    rear: [0.00, 0.00, 0.11, 0.11],
    front: [0.05, 0.05, 0.00, 0.00],
    under: [0.18, 0.18, 0.18, 0.18],
    wing: [0.00, 0.00, 0.01, 0.01],
  },
};

// Gains per surface key. `dry` is 1/s (docs: "błoto schnie 3x wolniej niż śnieg"),
// `fling` scales how easily airflow strips the deposit, `spray` how much material
// is thrown into the world spray field instead of onto the car.
// Gains per surface key. `gain` scales emission (drive) into panel units per
// second and is tuned for readability, not for dust mass conservation: a 30 s
// stage segment must read dirty to the eye (docs/04 §4.2 "czytelne gołym okiem").
// The shares split one emission into thick / wet / dust, `dry` is 1/s (docs:
// "błoto schnie 3x wolniej niż śnieg"), `slipDust` is tyre-and-brake dust, which
// exists even where the road itself sticks nothing (asphalt), `fling` scales how
// easily airflow strips the deposit, `spray` how much goes into the world field.
const RULES = {
  gravel: { cls: 'looseRear', gain: 0.130, thick: 0.20, wet: 0.05, dust: 0.85, slipDust: 0.25, rubber: 0.22, dry: 2.2, fling: 1.45, streak: 0.40, spray: 1.00 },
  dirt: { cls: 'looseRear', gain: 0.100, thick: 0.45, wet: 0.28, dust: 0.55, slipDust: 0.18, rubber: 0.20, dry: 1.5, fling: 1.25, streak: 0.55, spray: 1.05 },
  sand: { cls: 'looseRear', gain: 0.090, thick: 0.35, wet: 0.12, dust: 0.95, slipDust: 0.15, rubber: 0.18, dry: 2.0, fling: 1.55, streak: 0.35, spray: 1.10 },
  peat: { cls: 'mud', gain: 0.026, thick: 0.70, wet: 0.62, dust: 0.12, slipDust: 0.08, rubber: 0.18, dry: 0.7, fling: 0.80, streak: 0.85, spray: 1.20 },
  mud: { cls: 'mud', gain: 0.022, thick: 0.78, wet: 0.62, dust: 0.06, slipDust: 0.06, rubber: 0.16, dry: 0.55, fling: 0.70, streak: 1.00, spray: 1.35 },
  grass: { cls: 'mud', gain: 0.035, thick: 0.50, wet: 0.38, dust: 0.28, slipDust: 0.10, rubber: 0.18, dry: 1.6, fling: 1.10, streak: 0.55, spray: 0.85 },
  asphalt: { cls: 'hard', gain: 0.30, thick: 0.10, wet: 0.05, dust: 0.90, slipDust: 1.80, rubber: 0.95, dry: 4.5, fling: 1.60, streak: 0.20, spray: 0.28 },
  stone: { cls: 'hard', gain: 0.24, thick: 0.16, wet: 0.05, dust: 0.84, slipDust: 1.20, rubber: 0.55, dry: 4.0, fling: 1.60, streak: 0.20, spray: 0.35 },
  snow: { cls: 'snow', gain: 0.240, thick: 0.05, wet: 1.00, dust: 0.12, slipDust: 0.10, rubber: 0.10, dry: 6.5, fling: 1.80, streak: 0.75, spray: 0.80 },
  ice: { cls: 'snow', gain: 0.200, thick: 0.03, wet: 0.80, dust: 0.05, slipDust: 0.06, rubber: 0.06, dry: 7.5, fling: 1.90, streak: 0.50, spray: 0.45 },
  unknown: { cls: 'looseRear', gain: 0.070, thick: 0.40, wet: 0.20, dust: 0.50, slipDust: 0.15, rubber: 0.15, dry: 2.0, fling: 1.20, streak: 0.45, spray: 0.70 },
};

function srgb(hex, out) {
  out[0] = ((hex >> 16) & 255) / 255;
  out[1] = ((hex >> 8) & 255) / 255;
  out[2] = (hex & 255) / 255;
  return out;
}

/** One emitter per surface id, index-aligned with world/surfaces.js. */
export const EMITTERS = SURFACES.map((s) => {
  const rule = RULES[s.key] || RULES.unknown;
  const cls = TRANSFER[rule.cls];
  const transfer = new Float32Array(PANEL_COUNT * 4);
  for (let p = 0; p < PANEL_COUNT; p++) {
    const row = cls[PANELS[p].key];
    transfer[p * 4] = row[0]; transfer[p * 4 + 1] = row[1];
    transfer[p * 4 + 2] = row[2]; transfer[p * 4 + 3] = row[3];
  }
  const col = srgb(s.dirtColor, new Float32Array(3));
  return {
    id: s.id, key: s.key, cls: rule.cls,
    transfer,
    gain: rule.gain, thick: rule.thick, dust: rule.dust, wet: rule.wet,
    slipDust: rule.slipDust, rubber: rule.rubber,
    dry: rule.dry, fling: rule.fling, streak: rule.streak, spray: rule.spray,
    r: col[0], g: col[1], b: col[2],
    // Rubber is tyre black, not surface colour: asphalt leaves the tyre blacker
    // than the road itself (docs/04 §4.2 "guma na oponach").
    rr: col[0] * 0.45 + 0.03, rg: col[1] * 0.45 + 0.03, rb: col[2] * 0.45 + 0.04,
  };
});

export const RUBBER_R = 0.055, RUBBER_G = 0.055, RUBBER_B = 0.062;

/** Scratch state that has to survive between substeps without allocating. */
export function makeScratch() {
  return {
    wasAir: new Uint8Array([0, 0, 0, 0]),
    wet: 0,          // ambient wetness 0..1 (rain / damp track)
    splats: 0,       // splats queued this frame
    emission: 0,     // total emission this frame, feeds the lens + HUD
    perWheel: new Float32Array(4),
    splash: new Float32Array(4),
  };
}

/**
 * Emission for one substep (docs/04 §4.2 "emisja splatów").
 * rate = |slip_energy| * stick * (1 + wetness*0.8)            [the doc's formula]
 *      + ploughing power                                     [loose layer churn]
 *      + landing burst                                       [after a jump]
 * Called 120x/s from the sim step; writes only into `panels`, `map` and scratch.
 */
export function emitAll(panels, map, car, dt, scratch, env) {
  const wheels = car.wheels;
  const speed = car.body.groundSpeed;
  let emission = 0;
  let domR = 0, domG = 0, domB = 0, domW = 0;

  for (let wi = 0; wi < 4; wi++) {
    const w = wheels[wi];
    const em = EMITTERS[w.surfaceId] || EMITTERS[SURF.UNKNOWN];
    const airNow = w.Fvert <= 1 ? 1 : 0;
    const landed = scratch.wasAir[wi] && !airNow && w.compression > 0.01;
    scratch.wasAir[wi] = airNow;

    const vscrub = Math.abs(w.vx) + Math.abs(w.vyLat);
    if (speed < 0.35 && vscrub < 0.35 && !landed) { scratch.perWheel[wi] = 0; continue; }

    // (1) the doc's slip term: |slip_energy| * stick * (1 + wetness*0.8) / 40 kW.
    // `stick` (world/surfaces.js) is the odspajanie coefficient — it decides how
    // much of the scrubbed material actually lifts off the surface.
    const slip = w.slipEnergy / 40000;
    let drive = slip * surfaceStick(w.surfaceId) * (1 + 0.8 * scratch.wet);

    // (1b) tyre and brake dust: fine material that exists even where the road
    // itself sticks nothing, which is the only thing an asphalt road leaves behind.
    drive += slip * em.slipDust;

    // (2) bulldozing the loose layer: the plough force the tyre actually produces
    //     times the scrub speed, plus the constant churn of rolling through it.
    const ploughPower = Math.abs(w.Fplough) * Math.abs(w.vyLat) / 22000;
    const churn = looseChurn(w.surfaceId) * Math.abs(w.vx) * (w.N > 0 ? w.N : 0) / 12000;
    drive += ploughPower + churn;

    // (3) landing after a jump throws everything upward (docs "dach przy skokach")
    let splash = 0;
    if (landed) {
      splash = Math.min(1.2, Math.abs(w.vy) * 0.35 + w.edgeStep * 0.4);
      scratch.splash[wi] = splash;
    } else {
      scratch.splash[wi] = 0;
    }
    drive += splash * 0.8;

    drive = Math.min(6, drive);
    scratch.perWheel[wi] = drive;
    if (drive <= 1e-4) continue;
    emission += drive;

    const gain = drive * dt * em.gain;
    const wetBias = em.wet * (1 + 0.8 * scratch.wet);
    for (let p = 0; p < PANEL_COUNT; p++) {
      const t = em.transfer[p * 4 + wi];
      if (t <= 0) continue;
      // Landing splash is what throws mud/gravel up onto the roof and the underside.
      const up = (p === PANEL_INDEX.roof || p === PANEL_INDEX.under || p === PANEL_INDEX.flankL || p === PANEL_INDEX.flankR)
        ? scratch.splash[wi] * 0.55 : 0;
      panels.deposit(
        p,
        gain * em.thick * (t + up * 0.5),
        gain * wetBias * t,
        gain * em.dust * t,
        em.r, em.g, em.b,
        em.dry,
        gain * em.streak * t * (0.35 + 0.65 * wetBias),
        em.fling,
      );
    }

    // Rubber film on the tyre: worn by slip, scaled by the surface (asphalt wears
    // the tyre, gravel grinds it faster but the loose layer blows most of it off).
    const rubberPower = (slip * 1.6 + Math.abs(w.vx) * 0.010) * em.rubber;
    if (rubberPower > 0) panels.addRubber(wi, rubberPower * dt, em.rr, em.rg, em.rb);

    // World spray field: material that leaves the wheel instead of hitting the car.
    const spray = drive * em.spray;
    if (spray > 0.02) {
      const vx = w.vx * w.forward.x + w.vyLat * w.right.x;
      const vz = w.vx * w.forward.z + w.vyLat * w.right.z;
      const len = Math.hypot(vx, vz) || 1;
      // The splat lands behind the wheel, where the spray actually goes.
      const back = 0.45 + 0.25 * Math.min(1, speed / 30);
      map.splat(w.contact.x - (vx / len) * back, w.contact.z - (vz / len) * back,
        spray * dt * 26, wetBias * 0.9, em.dust, w.surfaceId);
      scratch.splats++;
      domR += em.r * spray; domG += em.g * spray; domB += em.b * spray; domW += spray;
    }
  }

  scratch.emission = emission;
  if (domW > 1e-4) {
    env.sprayR = domR / domW; env.sprayG = domG / domW; env.sprayB = domB / domW;
  }
  return emission;
}

// stick per surface id, index-aligned (surf.stick is the table value; kept as a
// flat lookup so the substep loop does not re-read an object graph).
const STICK = new Float32Array(SURFACES.length);
const CHURN = new Float32Array(SURFACES.length);
for (const s of SURFACES) {
  STICK[s.id] = s.stick;
  CHURN[s.id] = s.loose ? (s.crr * 0.9 + s.sink * 2.2) : 0;
}
function surfaceStick(id) { return STICK[id] || 0; }
function looseChurn(id) { return CHURN[id] || 0; }
