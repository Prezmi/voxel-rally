// Offline reference solver — the "duch" that produces ref_time (docs/03 §6,
// docs/07 F4 "ghost.js + duch AI (offline solver) -> ref_time i limity").
//
// It does not simulate the car. It integrates a *capability envelope* over the road
// arrays the generator already produced:
//   1. per-node lateral capability from the surface's effective mu and the tyre's
//      own peak coefficient — the same product tyre.js uses (docs/02 §4, §3.4):
//         a_lat = mu_eff(surface) * compound/gain * g * camber bonus
//   2. the friction-circle corner speed (docs/02 §3.4 / docs/03 §6 step 2):
//         v_corner = sqrt(a_lat / |kappa|), hard-capped at sqrt(mu_eff * g * R)
//      so a sector reference can never claim more grip than the surface has.
//   3. forward capability from the car ('A') table: traction limit, the straight-line
//      powertrain ceiling (tallest gear, or power vs rolling + aero, whichever binds —
//      see powertrainCeiling()); braking from the wheel torque capped by mu.
// Then a forward pass (acceleration-limited) and a backward pass (braking-limited)
// over the arc give the fastest speed profile that respects both, and the integral
// of ds/v becomes refTime / refSector[] — real numbers, not length/const_speed.
//
// Deterministic: a pure function of the road arrays + the options. No RNG, no
// performance-dependent iteration, so the same seed gives a bit-identical ghost
// (PLAN.md §8 #7). Cost: one pass per arc sample (~4.2k) — a few ms, well inside
// the 200 ms stage-solve budget (docs/07).
import { surface, effectiveMu } from '../world/surfaces.js';
import { CARS, G, TYRE_BASE } from '../car/car-params.js';

const RHO = 1.2;              // kg/m3 (docs/02 aero term)
const CURV_EPS = 1e-4;        // 1/m: below this the road is treated as a straight
const COMPOUND_SCALE = 1.0;   // reference driver runs the MED compound (car-params)

// What a reference driver is *willing* to carry on a surface on the long straights.
// These are NOT top speeds. Measured on the flat straight with tools/vmax.mjs (car 'A',
// 2026-10-11, pinned by T24 in src/debug/tests.js), what car 'A' can actually hold is
//   gearing cap 71.3 m/s > asphalt 69.3 > stone 69.1 > ice 66.9 > gravel 51.6 >
//   grass 41.7 > dirt 39.1 > snow 36.7 > sand 33.9 > mud 28.7 > peat 24.9 m/s
// and nobody holds even gravel's 51.6 m/s on 7.5 m of forest road lined with trees, so
// the number used here is a surface property, always well under the powertrain cap that
// `powertrainCeiling()` derives below (docs/03 §3).
export const SURFACE_VMAX = {
  gravel: 36, dirt: 32, mud: 24, sand: 26, grass: 29, asphalt: 46,
  stone: 34, peat: 22, snow: 24, ice: 20, unknown: 30,
};

/**
 * Straight-line powertrain ceiling: the fastest a car can *hold* a straight on one
 * surface row. A cap on the pace, never the pace itself. Two limits, take the smaller:
 *   gearing — redline through the tallest ratio at the tyre radius (docs/02 §3.7);
 *   power   — where peak power stops beating rolling + aero resistance,
 *             0.5*rho*CdA*v^3 + Crr*m*g*v = P, monotone in v so 40 bisection steps land
 *             far inside float precision.
 * The tyre's own losses (plough, sink, drag torque) sit outside this model, so the
 * measured terminal on loose ground is lower than the cap (gravel 51.6 m/s measured vs
 * 71.3 m/s here); on asphalt the gearing term binds and the two agree to 3 %. Re-measure
 * the measured column with tools/vmax.mjs.
 */
export function powertrainCeiling(p, s) {
  const topRatio = Math.min(...p.gears) * p.finalDrive;
  const vGear = (p.engine.redline * Math.PI / 30) / topRatio * TYRE_BASE.r;
  const P = p.engine.maxTorque * p.engine.peakRpm * Math.PI / 30 * p.efficiency;
  const aero = 0.5 * RHO * p.aero.cdA, roll = s.crr * p.mass * G;
  let lo = 0, hi = vGear;
  for (let i = 0; i < 40; i++) {
    const mid = 0.5 * (lo + hi);
    if (aero * mid * mid * mid + roll * mid > P) hi = mid; else lo = mid;
  }
  return Math.min(vGear, 0.5 * (lo + hi));
}

/**
 * Reference-driver capability margins. These are the only tuning knobs: they say
 * how much of the available envelope the reference driver uses. Measured against
 * the headless harness driver (tools/stagetest.mjs): the ghost ends up ~4 % quicker
 * than that driver, which is the intent — the harness driver lifts off early and
 * leaves the road (see SYSTEM-NOTES.md "ghost calibration"). It is pinned rather than
 * assumed now: src/debug/tests.js T25 drives that lap inside the suite and fails if the
 * reference stops being quicker than it (see referenceSpeedMargin below).
 */
export const GHOST_TUNE = {
  gripMargin: 0.98,     // fraction of the friction circle used at the apex
  camberBonus: 0.55,    // camber leans into the corner (road-spline CAMBER_GAIN): buys back grip
  cornerMargin: 0.97,   // line quality: apex speed vs the corner limit
  brakeUtil: 0.90,      // service-brake utilisation (docs/02 §6: the limit is the tyre, not the disc)
  driveUtil: 0.88,      // traction utilisation on exit
  straightUtil: 0.93,   // straight-line speed vs the surface ceiling
  cornerDrag: 0.055,    // extra resistance while cornering (docs/03 §6: gravel scrubs speed)
  // A friction-circle-perfect solve is *not* a rally reference: it assumes a line
  // that uses the whole 7.5 m corridor, no cut risk, no sight-line limit and no
  // mistakes, and docs/03 §4 then makes the stage limit (ref * 1.6) unbeatable. The
  // reference is a club-level driver, so the whole envelope is scaled once here.
  // Calibrated against a real lap of the headless pace driver (the pure-pursuit driver
  // in src/debug/pace-driver.js, driven by tools/stagetest.mjs) on the reference stage
  // (seed 12345, 4229 m forest gravel), re-measured after the loose-surface drag
  // retune, 2026-10-11: raw solve 168.97 s (90.1 km/h avg, 33.5 m/s max) -> at 0.73 the
  // reference lands 217.43 s (70.0 km/h avg, 24.5 m/s max), 2.4 % quicker than that
  // driver's 222.83 s lap (a +5.40 s split), while limit = ref * 1.6 = 05:47.89 stays
  // beatable by 56 % for the same driver.
  // Three acceptance criteria bound the knob and together leave it about eight seconds
  // of room (tools/stagetest.mjs E1/E3/A6): the reference must be *quicker* than the
  // driven lap and within 25 % of it (E3), within 20 s of it (A6, the split band), and
  // far from LEN/20 = 210 s, the constant-speed placeholder a reference must never be
  // mistaken for (E1) — i.e. ref in 215 s .. 223 s. Outside that envelope is what made
  // 0.58 red after the drag retune moved the car: 268.16 s, 20.3 % *slower* than the
  // driver and a -44.30 s split.
  // Re-measure with tools/stagetest.mjs (driven lap) and tools/pacenote-test.mjs (raw
  // solve, note lead). T25 in src/debug/tests.js drives the same lap inside the suite,
  // so any retune that moves the car fails there until this number follows it.
  referenceSpeedMargin: 0.73,
};

/** Corner speed limit pair for one node: [capability, friction-circle hard cap]. */
function cornerLimits(road, i, o, muEff) {
  const k = Math.abs(road.kappa[i]);
  if (k < CURV_EPS) return [Infinity, Infinity];
  // Camber bonus, but the friction circle is the hard ceiling (criterion C).
  const aLat = muEff * G * o.gripMargin * (1 + o.camberBonus * Math.abs(road.camber[i]));
  return [
    Math.min(Math.sqrt(aLat / k) * o.cornerMargin, Math.sqrt(muEff * G / k)),
    Math.sqrt(muEff * G / k),
  ];
}

/**
 * @param road  the road object from buildRoad()
 * @param opts  { seed, gates, carId, wetness, frozen, tune }
 * @returns ghost: v[]/t[] per arc sample, refTime, refSector[], ghostPath, diagnostics
 */
export function solveGhost(road, opts = {}) {
  const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
  const o = { ...GHOST_TUNE, ...opts.tune };
  const p = CARS[opts.carId] || CARS.A;
  const wetness = opts.wetness ?? 0;
  const frozen = opts.frozen ?? 0;
  const n = road.n;

  // Car capability constants (car-params 'A'): power from peak torque at peakRpm,
  // brake force from wheel torque / tyre radius, both then capped by the surface.
  const peakPower = p.engine.maxTorque * p.engine.peakRpm * Math.PI / 30 * p.efficiency;   // W
  const brakeForceCap = p.brakeMax / TYRE_BASE.r;                                          // N at the CoM
  const cdA = p.aero.cdA, mass = p.mass;
  // Hard straight-line cap per surface row (gearing + power vs rolling/aero). Memoised
  // over the <= 11 rows a stage can use; never the number the pace is built on, but it
  // must stay above the surface ceiling so the surface is what binds (T24).
  const ceilings = {};
  const ceilingOf = (s) => (s.key in ceilings ? ceilings[s.key] : (ceilings[s.key] = powertrainCeiling(p, s)));

  const vCap = new Float32Array(n);      // straight-line ceiling for this node
  const muEffArr = new Float32Array(n);
  const vCorner = new Float32Array(n);   // geometric corner limit (capability)
  const vLimitArr = new Float32Array(n); // friction-circle limit (audit reference)
  const v = new Float32Array(n), t = new Float32Array(n);
  let aLatArr = null;
  if (opts.wantLat) aLatArr = new Float32Array(n);

  for (let i = 0; i < n; i++) {
    const s = surface(road.surfaceId[i]);
    const mu = effectiveMu(s, wetness, frozen) * COMPOUND_SCALE * TYRE_BASE.gain;
    muEffArr[i] = mu;
    const surfMax = SURFACE_VMAX[s.key] ?? SURFACE_VMAX.unknown;
    vCap[i] = Math.min(ceilingOf(s), surfMax) * o.straightUtil * o.referenceSpeedMargin;
    const lim = cornerLimits(road, i, o, mu);
    // vCorner is the *reference* corner speed; vLimit stays the raw physics limit
    // (sqrt(mu_eff * g * R)) so the audit can prove the ghost never exceeds it.
    vCorner[i] = lim[0] * o.referenceSpeedMargin;
    vLimitArr[i] = lim[1];
    if (aLatArr) aLatArr[i] = lim[0] * lim[0] * Math.max(CURV_EPS, Math.abs(road.kappa[i]));
  }

  // Standing start: v[0] = 0 and the acceleration envelope builds the first metres,
  // the same way the countdown release works in game (docs/03 §4).
  // Forward pass: never faster than the acceleration envelope allows.
  // a_drive = min(traction, power/v) - rolling - aero, and while cornering the
  // gravel scrubs a share of it (docs/03 §6: the flat-out line is not a straight line).
  for (let i = 1; i < n; i++) {
    const ds = road.s[i] - road.s[i - 1];
    const mu = muEffArr[i], vp = i ? v[i - 1] : 0;
    const k = Math.abs(road.kappa[i]);
    const aTracl = mu * G * o.driveUtil;
    const aPow = peakPower / (mass * Math.max(4, vp));
    const res = surface(road.surfaceId[i]).crr * G * 0.55 + 0.5 * RHO * cdA * vp * vp / mass;
    const a = Math.max(0.6, Math.min(aTracl, aPow) - res - (k > CURV_EPS ? 0 : 0));
    v[i] = Math.min(vCap[i], vCorner[i], Math.sqrt(vp * vp + 2 * a * ds));
  }
  // Backward pass: braking envelope (torque-capped, then mu-capped) walking back
  // from the finish, so every corner is reachable from the speed before it.
  v[n - 1] = Math.min(vCap[n - 1], vCorner[n - 1]);
  for (let i = n - 2; i >= 0; i--) {
    const ds = road.s[i + 1] - road.s[i];
    const mu = muEffArr[i + 1];
    const aBrake = Math.min(brakeForceCap / mass, mu * G * o.brakeUtil) * (1 - o.cornerDrag);
    v[i] = Math.min(v[i], vCap[i], vCorner[i], Math.sqrt(v[i + 1] * v[i + 1] + 2 * aBrake * ds));
  }
  // Corner speed must respect the corner even when the straight before it was slow:
  // a second forward pass clamps to min(v, corner limit) and re-checks braking.
  for (let i = 1; i < n; i++) v[i] = Math.min(v[i], vCorner[i]);

  // Time integral: trapezoid over the 1 m samples (v is never 0 — vCap >= 18 m/s).
  for (let i = 1; i < n; i++) {
    const ds = road.s[i] - road.s[i - 1];
    const vm = 0.5 * (v[i] + v[i - 1]);
    t[i] = t[i - 1] + ds / Math.max(1, vm);
  }
  const refTime = t[n - 1];

  // ---- per-sector reference: integrated between the checkpoint gates (docs/03 §4) ----
  const gates = opts.gates || null;
  const sectors = [];
  const refSector = [];
  let maxSpeed = 0, maxLimitExceed = 0;
  for (let i = 0; i < n; i++) if (v[i] > maxSpeed) maxSpeed = v[i];
  if (gates) {
    for (let s = 1; s < gates.length; s++) {
      const a = road.indexAt(gates[s - 1].arc), b = road.indexAt(gates[s].arc);
      let dist = 0, worstR = Infinity, worstI = b, sectorMax = 0;
      for (let i = a; i <= b; i++) {
        if (v[i] > sectorMax) sectorMax = v[i];
        const kk = Math.abs(road.kappa[i]);
        if (kk > CURV_EPS) {
          const R = 1 / kk;
          if (R < worstR) { worstR = R; worstI = i; }
          if (v[i] > vLimitArr[i] + 1e-3) maxLimitExceed = Math.max(maxLimitExceed, v[i] - vLimitArr[i]);
        }
      }
      dist = road.s[b] - road.s[a];
      const time = t[b] - t[a];
      const kk = Math.max(CURV_EPS, Math.abs(road.kappa[worstI]));
      refSector.push(time);
      sectors.push({
        index: s, fromArc: road.s[a], toArc: road.s[b], dist, time,
        avgSpeed: dist / time, peakSpeed: sectorMax,
        tightestIndex: worstI, tightestRadius: 1 / kk,
        ghostAtTightest: v[worstI],
        frictionCircleSpeed: Math.sqrt(muEffArr[worstI] * G / kk),
        muEff: muEffArr[worstI],
      });
    }
  }

  // ---- ghost path for a drawn ghost later (x, z, t triple, flat arrays) ----
  const step = Math.max(1, Math.round(opts.pathStep || 10));
  const count = Math.floor((n - 1) / step) + 1;
  const gx = new Float32Array(count), gz = new Float32Array(count), gt = new Float32Array(count);
  for (let c = 0; c < count; c++) {
    const i = Math.min(n - 1, c * step);
    gx[c] = road.x[i]; gz[c] = road.z[i]; gt[c] = t[i];
  }

  const ms = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0;
  return {
    seed: opts.seed ?? road.seed ?? 0,
    carId: p.id, n, roadLength: road.length,
    v, t, vCap, vCorner, vLimit: vLimitArr, muEff: muEffArr, aLat: aLatArr,
    refTime, refSectors: refSector, sectors,
    avgSpeed: road.length / refTime, maxSpeed,
    peakPower, brakeForceCap, ceilings,
    solveMs: ms,
    overshoot: maxLimitExceed,       // must be 0: no corner faster than sqrt(mu g R)
    ghostPath: { x: gx, z: gz, t: gt, step, count },
    /** Ghost speed / stage clock at an arc (used by the pace-note trigger maths). */
    speedAt(arc) {
      const i = Math.min(n - 1, Math.max(0, Math.round(arc)));
      return v[i];
    },
    timeAt(arc) {
      const i = Math.min(n - 1, Math.max(0, Math.round(arc)));
      return t[i];
    },
    /** Friction-circle limit at an arc — the audit reference for criterion C. */
    limitAt(arc) {
      const i = Math.min(n - 1, Math.max(0, Math.round(arc)));
      return vLimitArr[i];
    },
  };
}
