// The headless rally driver the acceptance harnesses share.
//
// tools/stagetest.mjs drives the whole 4.2 km reference stage with it to judge the
// stage state machine, and src/debug/tests.js (T25) drives it again to judge the
// *reference itself*: the ghost in src/game/ghost.js is calibrated against what this
// driver actually manages, so the two must never fall out of step. Keeping the driver
// in one module is what makes that pin honest — a test that re-implemented its own
// driver would quietly calibrate against something else.
//
// It is a pure-pursuit follower with a rally pace model, not a physics driver: it
// reads the spline (curvature ahead, braking distance), picks a target speed, and
// steers with a rate-limited kinematic bicycle command. It lifts off early and it
// leaves the road — that is why the reference is allowed to be a few percent quicker
// than it is (docs/03 §6, SYSTEM-NOTES.md "ghost calibration").
//
// Deterministic: no RNG, no wall-clock, same road + same car => same lap (PLAN.md §8 #7).
import { DT } from '../core/time.js';

/** What the driver is willing to carry. Deliberately below the car's limit. */
export const PACE = {
  alat: 9,            // m/s2 lateral carried at the tightest point ahead
  vmax: 26,           // m/s self-imposed straight-line ceiling
  decel: 7,           // m/s2 braking it is willing to plan for
  horizon: 140,       // arc nodes scanned ahead (~140 m)
  lookBase: 10,       // m: pure-pursuit lookahead at a standstill
  lookMin: 12,        // m: pure-pursuit lookahead floor
  lookMax: 26,        // m: pure-pursuit lookahead ceiling
  lookK: 1.1,         // m per m/s: lookahead grows with speed
  hairpin: 0.45,      // m: lookahead that hugs the tightest radius ahead
  steerRate: 6,       // 1/s: steering-command slew limit
  flatKappa: 1e-4,    // 1/m: below this a node is a straight
  throttleFull: 0.85, // throttle below 95 % of the pace limit (never a full send)
  targetHold: 0.95,
  throttleLift: 0.35, // lift between 95 % and 108 % of the pace limit
  targetLift: 1.08,
  throttleCoast: 0.1, // above 108 % of the pace limit: off the gas
  brakeOver: 1.10,    // brake above 110 % of the pace limit
  brakeGain: 0.07,    // brake command per m/s over the limit
  brakeMax: 0.85,     // brake command ceiling
};

/** The 'slow/erratic' driver the DNF paths in stagetest need: no pace, no commitment. */
export const SLOW_PACE = { alat: 1.4, vmax: 6, decel: 1.5 };

/**
 * @param road  the road object from buildRoad()
 * @param tuning  overrides of PACE (e.g. SLOW_PACE)
 * @returns driver: { pace(idx, speed), input(car, idx, speed, launched), steerCommand }
 *   `input()` returns a fresh input object every step and keeps its own steer state,
 *   so the caller never has to carry the rate limiter.
 */
export function createPaceDriver(road, tuning = {}) {
  const t = { ...PACE, ...tuning };
  const ds = road.s[1] - road.s[0];
  let steer = 0;

  /** Fastest speed still reachable for every corner/brake point ahead. */
  function pace(idx, speed) {
    let look = Math.max(t.lookMin, Math.min(t.lookMax, t.lookBase + speed * t.lookK));
    let vLim = t.vmax, kAhead = t.flatKappa;
    for (let q = idx; q <= Math.min(road.n - 1, idx + t.horizon); q++) {
      const k = Math.abs(road.kappa[q]);
      const vl = k > t.flatKappa ? Math.min(t.vmax, Math.sqrt(t.alat / k)) : t.vmax;
      const allowed = Math.sqrt(vl * vl + 2 * t.decel * (road.s[q] - road.s[idx]));
      if (allowed < vLim) vLim = allowed;
      if (k > kAhead) kAhead = k;
    }
    // hug a hairpin instead of cutting it
    look = Math.min(look, Math.max(t.lookMin, t.hairpin / kAhead));
    return { vLim, look, kAhead };
  }

  function input(car, idx, speed, launched = true) {
    const { vLim, look } = pace(idx, speed);
    const j = Math.min(road.n - 1, idx + Math.max(1, Math.round(look / ds)));
    const want = Math.atan2(road.z[j] - car.body.pos.z, road.x[j] - car.body.pos.x);
    let dA = want - Math.atan2(car.body.forward.z, car.body.forward.x);
    while (dA > Math.PI) dA -= 2 * Math.PI;
    while (dA < -Math.PI) dA += 2 * Math.PI;
    const target = Math.max(-1, Math.min(1,
      -Math.atan(2 * car.params.wheelbase * Math.sin(dA) / look) / car.params.steerMax));
    steer += Math.sign(target - steer) * Math.min(Math.abs(target - steer), t.steerRate * DT);
    if (!launched) return { throttle: 0, brake: 1, steer, handbrake: 0, shiftUp: 0, shiftDown: 0 };
    return {
      throttle: speed < vLim * t.targetHold ? t.throttleFull
        : (speed < vLim * t.targetLift ? t.throttleLift : t.throttleCoast),
      brake: speed > vLim * t.brakeOver ? Math.min(t.brakeMax, (speed - vLim) * t.brakeGain) : 0,
      steer, handbrake: 0, shiftUp: 0, shiftDown: 0,
    };
  }

  return { pace, input, get steerCommand() { return steer; } };
}
