// Rollover state machine (docs/02 §9 physics step, docs/07 F4 HUD state).
// The chassis orientation gives the roll angle every physics step; past the side /
// fully-rolled thresholds the drivetrain, the steering and the handbrake are all cut,
// so an upside-down car can only slide and settle. Getting out is either the automatic
// righting (rolled + at rest for REST_SETTLE_S, or side-down for SIDE_TIMEOUT_S) or the
// player pressing RESET, which starts the same routine immediately.
import { clamp, normalizeQ, quatFromYaw, mul3v } from '../core/math3.js';
import { TYRE_BASE } from './car-params.js';

export const ROLLOVER_STATE = { UPRIGHT: 'upright', SIDE: 'side', ROLLED: 'rolled' };

// Classification thresholds, degrees between the chassis up axis and world up.
export const SIDE_DEG = 50;         // >= this: on its side
export const UPSIDE_DEG = 125;      // >= this: fully rolled
// Hysteresis band on the way back, so a car rocking at the threshold cannot flicker
// the state (and the HUD label) several times a second.
const HYST_DEG = 5;
// Timings, seconds.
export const REST_SETTLE_S = 1.5;   // rolled + at rest this long -> right automatically
export const SIDE_TIMEOUT_S = 4.0;  // side-down this long -> treat as rolled, right
export const RIGHT_DURATION_S = 1.0; // the slerp: 0.8 .. 1.2 s reads as a recovery
export const RIGHT_DROP_M = 0.35;   // lifted this far, then dropped onto the ground
const REST_SPEED = 1.2;             // m/s ground speed counted as "at rest"
const ROCK_HZ = 1.1;                // side-down rocking rate
const ROCK_GAIN = 7.0;              // rad/s^2 driving that rock

export function createRollover() {
  return {
    state: ROLLOVER_STATE.UPRIGHT,
    angleDeg: 0,
    sideTime: 0,
    restTime: 0,
    rockPhase: 0,
    right: null,                  // active righting routine (see startRighting)
  };
}

export function resetRollover(r) {
  r.state = ROLLOVER_STATE.UPRIGHT;
  r.angleDeg = 0; r.sideTime = 0; r.restTime = 0; r.rockPhase = 0; r.right = null;
}

/** Angle in degrees between the chassis up axis and world up (0 = upright, 180 = roof). */
export function measureRoll(car) {
  const up = car.body.up;
  return Math.acos(clamp(up.y, -1, 1)) * 180 / Math.PI;
}

/** Hysteresis: the entry thresholds going down, the exit ones coming back up. */
function classify(r, deg) {
  const sideIn = SIDE_DEG, upIn = SIDE_DEG - HYST_DEG;
  const rollIn = UPSIDE_DEG, sideOut = UPSIDE_DEG - HYST_DEG;
  if (r.state === ROLLOVER_STATE.UPRIGHT) {
    if (deg >= rollIn) return ROLLOVER_STATE.ROLLED;
    if (deg >= sideIn) return ROLLOVER_STATE.SIDE;
    return ROLLOVER_STATE.UPRIGHT;
  }
  if (r.state === ROLLOVER_STATE.SIDE) {
    if (deg >= rollIn) return ROLLOVER_STATE.ROLLED;
    if (deg < upIn) return ROLLOVER_STATE.UPRIGHT;
    return ROLLOVER_STATE.SIDE;
  }
  if (deg < upIn) return ROLLOVER_STATE.UPRIGHT;
  if (deg < sideOut) return ROLLOVER_STATE.SIDE;
  return ROLLOVER_STATE.ROLLED;
}

export function isRolled(car) {
  const r = car && car.rollover;
  return !!r && (r.state !== ROLLOVER_STATE.UPRIGHT || !!r.right);
}

/** True only when the car can actually be driven. */
export function isDrivable(car) {
  const r = car.rollover;
  return !r.right && r.state === ROLLOVER_STATE.UPRIGHT;
}

/**
 * Copy the raw input into `out` with drive / steering / handbrake zeroed while the car
 * is on its side or its roof. The service brake stays available: an upside-down car is
 * still allowed to be dragged to a stop.
 */
export function gateInput(car, input, out) {
  const g = isDrivable(car) ? 1 : 0;
  out.throttle = (input.throttle || 0) * g;
  out.steer = (input.steer || 0) * g;
  out.handbrake = (input.handbrake || 0) * g;
  out.brake = input.brake || 0;
  out.shiftUp = (input.shiftUp || 0) * g;
  out.shiftDown = (input.shiftDown || 0) * g;
  return out;
}

// ---------------------------------------------------------------- righting routine
function copyQ(q, out) { out.x = q.x; out.y = q.y; out.z = q.z; out.w = q.w; return out; }

/** Slerp on the shortest arc; falls back to a normalised lerp for tiny angles. */
function slerpQ(a, b, u, out) {
  let bx = b.x, by = b.y, bz = b.z, bw = b.w;
  let d = a.x * bx + a.y * by + a.z * bz + a.w * bw;
  if (d < 0) { bx = -bx; by = -by; bz = -bz; bw = -bw; d = -d; }
  if (d > 0.9995) {
    out.x = a.x + (bx - a.x) * u; out.y = a.y + (by - a.y) * u;
    out.z = a.z + (bz - a.z) * u; out.w = a.w + (bw - a.w) * u;
    return normalizeQ(out);
  }
  const th = Math.acos(Math.min(1, d)), s = Math.sin(th);
  const w1 = Math.sin((1 - u) * th) / s, w2 = Math.sin(u * th) / s;
  out.x = a.x * w1 + bx * w2; out.y = a.y * w1 + by * w2;
  out.z = a.z * w1 + bz * w2; out.w = a.w * w1 + bw * w2;
  return normalizeQ(out);
}

/**
 * Height the CoM must sit at for every wheel to hang at its static length over the
 * ground under it (same relation placeAt uses), so the righted car is dropped in from
 * a small, controlled height instead of being teleported into the road.
 */
function standOffHeight(car) {
  const b = car.body;
  let y = -Infinity;
  for (const w of car.wheels) {
    mul3v(b.m, w.mountLocal, w.hub);
    const g = car.world.groundHeight(b.pos.x + w.hub.x, b.pos.z + w.hub.z);
    y = Math.max(y, g + TYRE_BASE.r + car.restLength - w.mountLocal.y);
  }
  return y;
}

/** Park every wheel at its static length for the current body pose (no teleporting). */
export function settleWheels(car) {
  const b = car.body;
  for (const w of car.wheels) {
    mul3v(b.m, w.mountLocal, w.hub);
    w.hub.x += b.pos.x; w.hub.y += b.pos.y; w.hub.z += b.pos.z;
    w.groundY = car.world.groundHeight(w.hub.x, w.hub.z);
    w.y = w.hub.y - car.restLength;
    w.vy = 0; w.omega = 0; w.N = 0; w.NPrev = 0;
    w.susp = 0; w.suspRaw = 0; w.suspVel = 0; w.compression = 0;
    w.driveTorque = 0;
  }
  car.powertrain.rpm = car.params.engine.idle;
}

/**
 * Start the recovery. The heading the car is lying with is kept (only the tilt is
 * removed), the attitude is slerped upright over `dur` and the body is then dropped
 * RIGHT_DROP_M onto the ground so the suspension takes the landing.
 */
export function startRighting(car, dur = RIGHT_DURATION_S) {
  const r = car.rollover, b = car.body;
  if (r.right) return;
  b.refreshFrame();
  const yaw = Math.atan2(-b.forward.z, b.forward.x);
  const q0 = copyQ(b.quat, {});
  const q1 = quatFromYaw(yaw, { x: 0, y: 0, z: 0, w: 1 });
  const y1 = standOffHeight(car) + RIGHT_DROP_M;
  r.right = {
    t: 0,
    dur: clamp(dur, 0.2, 1.6),
    q0, q1,
    y0: b.pos.y,
    y1: Math.max(y1, b.pos.y - 1.5),   // never drive the car through the ground
    x: b.pos.x, z: b.pos.z,
  };
  b.vel.x = 0; b.vel.y = 0; b.vel.z = 0;
  b.angVel.x = 0; b.angVel.y = 0; b.angVel.z = 0;
  settleWheels(car);
}

function stepRighting(car, dt) {
  const r = car.rollover, b = car.body, s = r.right;
  s.t += dt;
  const u = clamp(s.t / s.dur, 0, 1);
  const e = u * u * (3 - 2 * u);           // smoothstep: no snap at either end
  slerpQ(s.q0, s.q1, e, b.quat);
  normalizeQ(b.quat);
  b.pos.x = s.x; b.pos.z = s.z;
  b.pos.y = s.y0 + (s.y1 - s.y0) * e;
  b.vel.x = 0; b.vel.y = 0; b.vel.z = 0;
  b.angVel.x = 0; b.angVel.y = 0; b.angVel.z = 0;
  b.refreshFrame();
  settleWheels(car);
  if (u >= 1) {
    r.right = null;
    r.state = ROLLOVER_STATE.UPRIGHT;
    r.sideTime = 0; r.restTime = 0; r.rockPhase = 0;
    b.vel.y = -1.2;                        // the small drop onto the ground
  }
  return true;
}

/**
 * One call per physics step, before the forces are built. Measures the angle, runs the
 * side/rolled timers, rocks a side-down car, and starts the righting routine on its own
 * when the player has clearly stopped needing to be rescued by hand.
 */
export function rolloverStep(car, dt) {
  const r = car.rollover, b = car.body;
  b.refreshFrame();
  r.angleDeg = measureRoll(car);
  if (r.right) { stepRighting(car, dt); return; }

  const next = classify(r, r.angleDeg);
  if (next !== r.state) {
    r.state = next;
    r.sideTime = 0; r.restTime = 0;
    if (next === ROLLOVER_STATE.UPRIGHT) r.rockPhase = 0;
  }

  if (r.state === ROLLOVER_STATE.SIDE) {
    r.sideTime += dt;
    r.restTime = 0;
    // A side-down car on soft ground tends to freeze in place. Driving a light
    // oscillation about the forward axis (the body's own damping + contact friction
    // damp it back down) reads as a rock instead of a statue.
    r.rockPhase += dt * 2 * Math.PI * ROCK_HZ;
    const amp = ROCK_GAIN * Math.min(1, r.sideTime * 3) * dt;
    const s = Math.sin(r.rockPhase) * amp;
    b.angVel.x += b.forward.x * s;
    b.angVel.y += b.forward.y * s;
    b.angVel.z += b.forward.z * s;
    if (r.sideTime >= SIDE_TIMEOUT_S) startRighting(car);
  } else if (r.state === ROLLOVER_STATE.ROLLED) {
    r.sideTime = 0;
    const atRest = b.groundSpeed < REST_SPEED && Math.abs(b.vel.y) < 0.8
      && Math.hypot(b.angVel.x, b.angVel.y, b.angVel.z) < 0.6;
    r.restTime = atRest ? r.restTime + dt : 0;
    if (r.restTime >= REST_SETTLE_S) startRighting(car);
  } else {
    r.sideTime = 0; r.restTime = 0;
  }
}

/**
 * Wheels the drivetrain no longer turns must not keep spinning up: bleed omega towards
 * the free-rolling rate while the car cannot be driven.
 */
export function spinDownWheels(car, dt) {
  const b = car.body;
  const target = (b.forward.x * b.vel.x + b.forward.z * b.vel.z) >= 0 ? 1 : -1;
  const rate = Math.min(1, 3 * dt);
  for (const w of car.wheels) {
    w.driveTorque = 0;
    const free = target * b.groundSpeed / (w.rEff || w.rGeo || TYRE_BASE.r);
    w.omega += (free - w.omega) * rate;
  }
}
