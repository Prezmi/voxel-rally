// Arcade rally physics. Pure module: velocity lives in the world frame,
// forces are applied in the car frame, and lateral velocity is damped by
// surface grip — that one trick gives weighty, driftable handling without
// a full tyre model. Ground height and surface come from injected
// callbacks, so tests can drive it on a synthetic stage.

import { clamp, lerp } from '../core/rng.js';
import { SURFACE_GRIP, SURFACE_DRAG, isRoadSurface } from '../world/tiles.js';

const WHEELBASE = 2.6;
const ENGINE_A = 10.5;      // m/s^2 at standstill
const ENGINE_V = 60;        // m/s reference for the power curve
const BRAKE_A = 11.5;
const QUAD_DRAG = 0.0007;
const GRAV = 21;            // snappier than 9.8, feels right at this scale

export function createCar(pose) {
  return {
    x: pose.x, z: pose.z, y: 0, vy: 0,
    heading: pose.heading,
    vx: 0, vz: 0,
    grounded: true,
    steerVis: 0,
    speedF: 0, slip: 0, speed: 0,
    surface: 0, offroad: false, drifting: false,
    lastImpact: 0,
    throttle: 0,
  };
}

export function stepCar(st, input, dt, env) {
  const surf = env.surfaceAt(st.x, st.z);
  st.surface = surf;
  st.offroad = !isRoadSurface(surf);
  const gripMul = (env.params?.grip ?? 1);
  const grip = SURFACE_GRIP[surf] * gripMul;

  const s = Math.sin(st.heading), c = Math.cos(st.heading);
  const fx = s, fz = -c;      // forward
  const rx = c, rz = s;       // right
  let vf = st.vx * fx + st.vz * fz;
  let vl = st.vx * rx + st.vz * rz;

  // --- steering -------------------------------------------------------------
  const speedAbs = Math.abs(vf);
  const maxSteer = lerp(0.58, 0.13, clamp(speedAbs / 46, 0, 1));
  const steerAngle = input.steer * maxSteer;
  st.steerVis += (steerAngle - st.steerVis) * Math.min(1, dt * 10);
  if (st.grounded) {
    let yawRate = (vf / WHEELBASE) * Math.tan(steerAngle);
    if (input.handbrake && speedAbs > 4) yawRate *= 1.5;
    st.heading += yawRate * dt;
    if (st.heading > Math.PI) st.heading -= Math.PI * 2;
    if (st.heading < -Math.PI) st.heading += Math.PI * 2;
  }

  // Recompute frame after yaw, reproject velocity.
  const s2 = Math.sin(st.heading), c2 = Math.cos(st.heading);
  const fx2 = s2, fz2 = -c2, rx2 = c2, rz2 = s2;
  vf = st.vx * fx2 + st.vz * fz2;
  vl = st.vx * rx2 + st.vz * rz2;

  // --- longitudinal forces ----------------------------------------------------
  let a = 0;
  if (st.grounded) {
    if (input.throttle > 0 && !input.handbrake) {
      const curve = Math.max(0, 1 - Math.pow(Math.max(0, vf) / ENGINE_V, 1.5));
      a += input.throttle * ENGINE_A * curve * (env.params?.accel ?? 1);
      if (vf < 0) a += input.throttle * 6; // pull out of reverse
    }
    if (input.brake > 0) {
      if (vf > 0.4) a -= BRAKE_A * input.brake;
      else a -= 5.2 * input.brake; // reverse
    }
    if (input.handbrake) a -= Math.sign(vf) * Math.min(Math.abs(vf), 3.4);
    // slope gravity along heading
    const ahead = env.groundHeight(st.x + fx2 * 1.4, st.z + fz2 * 1.4);
    const behind = env.groundHeight(st.x - fx2 * 1.4, st.z - fz2 * 1.4);
    const slope = (ahead - behind) / 2.8;
    a -= 9.81 * slope * 0.85;
  }
  // resistance
  const rollC = 0.05 * (1 + SURFACE_DRAG[surf] * (st.grounded ? 2.2 : 0.15));
  a -= QUAD_DRAG * vf * Math.abs(vf) + rollC * vf;
  vf += a * dt;
  vf = clamp(vf, -10, 64);
  if (!input.throttle && !input.brake && Math.abs(vf) < 0.12 && st.grounded) vf = 0;

  // --- lateral grip ---------------------------------------------------------
  const gripRate = st.grounded
    ? (input.handbrake ? 1.7 : 9.5) * grip
    : 0;
  vl *= Math.exp(-gripRate * dt);
  if (Math.abs(vl) < 0.01) vl = 0;

  // --- integrate ----------------------------------------------------------------
  st.vx = fx2 * vf + rx2 * vl;
  st.vz = fz2 * vf + rz2 * vl;
  st.x += st.vx * dt;
  st.z += st.vz * dt;
  // World bounds come from the stage (kilometres across now, not a
  // fixed 256 m box). No bounds in env = no clamp (synthetic tests).
  if (env.bounds) {
    st.x = clamp(st.x, env.bounds.minX, env.bounds.maxX);
    st.z = clamp(st.z, env.bounds.minZ, env.bounds.maxZ);
  }

  // --- vertical: suspension on ground, ballistic in air -------------------------
  st.lastImpact = 0;
  const gy = env.groundHeight(st.x, st.z);
  if (st.grounded) {
    if (gy < st.y - 0.06) {
      st.grounded = false; // drove off a crest
      st.vy = 0;
    } else {
      st.y = gy;
      st.vy = 0;
    }
  }
  if (!st.grounded) {
    st.vy -= GRAV * dt;
    st.y += st.vy * dt;
    if (st.y <= gy) {
      st.lastImpact = -st.vy;
      st.y = gy;
      st.vy = 0;
      st.grounded = true;
    }
  }

  st.speedF = vf;
  st.slip = vl;
  st.speed = Math.hypot(st.vx, st.vz);
  st.drifting = st.grounded && Math.abs(vl) > 3.2 && st.speed > 8;
  st.throttle = input.throttle;
  return st;
}
