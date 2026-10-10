// Car parameter tables (docs/02 §1, docs/06 car/car-params.js).
// Units: SI. `setup` is the tuning block the player changes (docs/01 tuning).

export const G = 9.81;

export const TYRE_BASE = {
  D: 1.28,          // reference peak coefficient of the rally tyre (docs/02 §3.3)
  // docs/02 gives the tyre a peak coefficient of 1.28 while the reference road
  // (asphalt) is 1.18, so the reference rally tyre is ~8.5 % better than the road
  // table alone implies. Applied to both the Pacejka peak and the friction circle
  // so the two stay consistent.
  gain: 1.28 / 1.18,
  C0: 1.55,
  B0: 9.4,
  E0: 0.85,
  r: 0.335,
  I: 1.15,          // kg m^2, tyre + rim + half-shaft
  kappaLockBrake: 0.18,
  kappaLockDrive: 0.28,
};

export const COMPOUNDS = {
  HARD: { id: 0, name: 'HARD', muScale: 0.94, wear: 0.5, note: 'trwały, wolniej się grzeje' },
  MED: { id: 1, name: 'MEDIUM', muScale: 1.0, wear: 1.0 },
  SOFT: { id: 2, name: 'SOFT', muScale: 1.09, wear: 2.1, note: 'szybszy, szybciej się brudzi' },
};

export const DIFF_TYPES = { OPEN: 0, VISCOUS: 1, LOCKED: 2 };

const DEFAULT_SETUP = {
  ride: 0,             // -1 softer/lower .. +1 stiffer/higher
  damp: 0,             // bump/rebound scale
  arb: 0,              // anti-roll bar scale
  lock: 0.25,          // centre/axle lock fraction
  bias: 0.55,          // front brake share
  compound: 'MED',
};

export const CARS = {
  // 'A' is the docs/02 §1 reference car.
  A: {
    id: 'A', name: 'KORVETTA A-6', drive: 'AWD',
    mass: 1240, weightSplit: 0.57, wheelbase: 2.62,
    trackFront: 1.52, trackRear: 1.54, comY: 0.52, mountY: 0.33,
    hull: { x: 2.10, y: 0.50, z: 0.78, cy: 0.28 },   // cy = box centre offset from CoM
    inertiaScale: { xx: 1.0, yy: 1.0, zz: 1.0 },
    springFront: 78000, springRear: 66000,
    dampBump: 4800, dampReb: 6900,
    arbFront: 1400, arbRear: 2200,
    handbrakeGain: 1.84,  // rear brake torque the lever applies, as a multiple of the rear tyre's own peak
    forceCentre: 0.22,  // suspension roll/pitch centre height above ground (m)
    bumpStop: 0.10, droopStop: 0.12,
    unsprung: 18,
    brakeMax: 5000,          // N m total at the wheels (see note below)
    diffFront: DIFF_TYPES.VISCOUS, diffRear: DIFF_TYPES.OPEN,
    diffClutch: 900,          // N m internal clutch torque (open diff)
    kv: 900,                  // viscous coupling N m per (rad/s)
    splitFront: 0.54,   // front-biased AWD split: puts the extra torque down without a rear break-away
    // Detuned under the old runaway accumulator: with the frame loop fixed the
    // car was ~4.5 s short of a modern rally car's 0-100 on gravel. Retrained to
    // ~4.7 s 0-100 / ~190 kph terminal on szuter, with closer ratios so an
    // upshift lands the revs just above the torque plateau (no dead spot).
    engine: { maxTorque: 440, idle: 900, redline: 7000, peakRpm: 5000, powerBog: 0.9 },
    gears: [3.30, 2.35, 1.75, 1.34, 1.06, 0.84],
    finalDrive: 4.10,
    efficiency: 0.90,
    aero: { cdA: 0.62, downforce: 0.55 },
    steerMax: 32 * Math.PI / 180,
    setup: { ...DEFAULT_SETUP },
  },
  B: {
    id: 'B', name: 'FJORD R2', drive: 'AWD',
    mass: 1180, weightSplit: 0.54, wheelbase: 2.50,
    trackFront: 1.48, trackRear: 1.50, comY: 0.50, mountY: 0.35,
    hull: { x: 1.98, y: 0.48, z: 0.74, cy: 0.26 },
    inertiaScale: { xx: 1.05, yy: 0.95, zz: 0.92 },
    springFront: 72000, springRear: 62000,
    dampBump: 4400, dampReb: 6300,
    arbFront: 1200, arbRear: 2500,
    handbrakeGain: 1.84,  // rear brake torque the lever applies, as a multiple of the rear tyre's own peak
    forceCentre: 0.22,  // suspension roll/pitch centre height above ground (m)
    bumpStop: 0.10, droopStop: 0.13,
    unsprung: 17,
    brakeMax: 4700,
    diffFront: DIFF_TYPES.OPEN, diffRear: DIFF_TYPES.VISCOUS,
    diffClutch: 700, kv: 1200,
    splitFront: 0.36,
    engine: { maxTorque: 355, idle: 950, redline: 7200, peakRpm: 4600, powerBog: 0.92 },
    gears: [3.72, 2.30, 1.60, 1.16, 0.90, 0.72],
    finalDrive: 4.10,
    efficiency: 0.90,
    aero: { cdA: 0.58, downforce: 0.62 },
    steerMax: 34 * Math.PI / 180,
    setup: { ...DEFAULT_SETUP, lock: 0.35, bias: 0.52 },
  },
  C: {
    id: 'C', name: 'TERRA 4X', drive: 'AWD',
    mass: 1390, weightSplit: 0.55, wheelbase: 2.78,
    trackFront: 1.60, trackRear: 1.62, comY: 0.58, mountY: 0.30,
    hull: { x: 2.24, y: 0.56, z: 0.84, cy: 0.32 },
    inertiaScale: { xx: 1.12, yy: 1.05, zz: 1.10 },
    springFront: 86000, springRear: 74000,
    dampBump: 5400, dampReb: 7600,
    arbFront: 1700, arbRear: 2400,
    handbrakeGain: 1.84,  // rear brake torque the lever applies, as a multiple of the rear tyre's own peak
    forceCentre: 0.26,  // suspension roll/pitch centre height above ground (m)
    bumpStop: 0.11, droopStop: 0.14,
    unsprung: 21,
    brakeMax: 5400,
    diffFront: DIFF_TYPES.LOCKED, diffRear: DIFF_TYPES.LOCKED,
    diffClutch: 1400, kv: 1500,
    splitFront: 0.48,
    engine: { maxTorque: 430, idle: 850, redline: 5800, peakRpm: 3400, powerBog: 0.86 },
    gears: [3.20, 2.00, 1.40, 1.02, 0.80, 0.62],
    finalDrive: 3.70,
    efficiency: 0.88,
    aero: { cdA: 0.78, downforce: 0.40 },
    steerMax: 30 * Math.PI / 180,
    setup: { ...DEFAULT_SETUP, lock: 0.6, bias: 0.58 },
  },
  D: {
    id: 'D', name: 'SVALA SR', drive: 'RWD',
    mass: 1120, weightSplit: 0.51, wheelbase: 2.55,
    trackFront: 1.46, trackRear: 1.48, comY: 0.48, mountY: 0.37,
    hull: { x: 2.02, y: 0.46, z: 0.72, cy: 0.24 },
    inertiaScale: { xx: 0.95, yy: 0.92, zz: 0.90 },
    springFront: 66000, springRear: 58000,
    dampBump: 4000, dampReb: 5800,
    arbFront: 1000, arbRear: 1800,
    handbrakeGain: 1.84,  // rear brake torque the lever applies, as a multiple of the rear tyre's own peak
    forceCentre: 0.21,  // suspension roll/pitch centre height above ground (m)
    bumpStop: 0.09, droopStop: 0.12,
    unsprung: 16,
    brakeMax: 4500,
    diffFront: DIFF_TYPES.OPEN, diffRear: DIFF_TYPES.VISCOUS,
    diffClutch: 500, kv: 1100,
    splitFront: 0.0,
    engine: { maxTorque: 330, idle: 1000, redline: 7600, peakRpm: 5200, powerBog: 0.95 },
    gears: [3.90, 2.45, 1.72, 1.26, 0.98, 0.78],
    finalDrive: 3.55,
    efficiency: 0.91,
    aero: { cdA: 0.52, downforce: 0.70 },
    steerMax: 36 * Math.PI / 180,
    setup: { ...DEFAULT_SETUP, lock: 0.4, bias: 0.50 },
  },
};

export function makeCar(carId, setupPatch = {}) {
  const base = CARS[carId] || CARS.A;
  const p = JSON.parse(JSON.stringify(base));
  p.setup = { ...p.setup, ...setupPatch };
  return p;
}

/** Effective suspension constants after tuning + damage. */
export function suspensionConstants(p, setup = p.setup, damage = null) {
  const ride = 1 + 0.18 * (setup.ride || 0);
  const dampS = 1 + 0.35 * (setup.damp || 0);
  const arbS = 1 + 0.6 * (setup.arb || 0);
  const dmg = damage || { spring: 1, damp: 1 };
  return {
    kFront: p.springFront * ride * dmg.spring,
    kRear: p.springRear * ride * dmg.spring,
    cBump: p.dampBump * dampS * dmg.damp,
    cReb: p.dampReb * dampS * dmg.damp,
    arbFront: p.arbFront * arbS,
    arbRear: p.arbRear * arbS,
  };
}

/** Geometric rest length so the wheel centre sits at r_eff above the ground at e=0. */
export function restLengthOf(p) { return p.comY + p.mountY - TYRE_BASE.r; }
