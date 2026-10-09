// Suspension: spring + damper + anti-roll bar + bump stops, per wheel
// (docs/02 §2). N_i is the ONLY source of grip (docs/02 §2 "Krytyczne").
//
// Sign convention: `susp` is extension (L - rest); positive = droop, negative =
// bump. `suspVel` is d(extension)/dt. Force on the BODY is N (up positive);
// the reaction on the unsprung mass is -N.
import { clamp, v3, mul3v, mul3vT } from '../core/math3.js';

const _wB = v3();

const K_STOP_BUMP = 120000;    // N/m beyond the bump stop
const K_STOP_PROG = 2400000;   // N/m^2 progressive helper
const C_STOP_BUMP = 9000;
const K_STOP_DROOP = 90000;
const C_STOP_DROOP = 3000;

export function suspensionPrep(car) {
  const rest = car.restLength;
  const p = car.params;
  for (const w of car.wheels) {
    const L = w.hub.y - w.y;
    w.suspRaw = L - rest;
    w.susp = clamp(w.suspRaw, -p.bumpStop, p.droopStop);
    w.suspVel = w.hubVy - w.vy;
  }
}

export function suspensionForce(w, car, h) {
  const p = car.params;
  const s = car.susp;
  const k = (w.axle === 0 ? s.kFront : s.kRear) * w.damage.springScale;
  const cB = s.cBump * w.damage.dampScale;
  const cR = s.cReb * w.damage.dampScale;
  const arb = (w.axle === 0 ? s.arbFront : s.arbRear);

  const e = w.suspRaw;
  const eC = w.susp;
  const v = w.suspVel;

  let N = -k * eC;                                   // F_spring = k * (-susp)
  N += -(v > 0 ? cB : cR) * v;                       // damper resists the extension rate

  // Bump / droop stops.
  if (e < -p.bumpStop) {
    const over = -(e + p.bumpStop);            // > 0: pressed into the bump stop
    N += K_STOP_BUMP * over + K_STOP_PROG * over * over + C_STOP_BUMP * Math.max(0, -v);
  } else if (e > p.droopStop) {
    const over = e - p.droopStop;
    N += -K_STOP_DROOP * over - C_STOP_DROOP * Math.max(0, v);
  }

  // Anti-roll bar: distributes lateral load transfer (docs/02 §2).
  const other = car.wheels[w.axle * 2 + (w.side === -1 ? 1 : 0)];
  N += arb * (other.susp - eC);

  // A strut is bolted to the hub: it pulls as well as pushes. Clamping N at zero
  // (the usual shortcut) lets the body fly off the wheels, and the travel limit
  // then re-attaches it every substep - that ratchets a parked car into the air.
  // Whether a tyre has *grip* is a separate question and is clamped where it is
  // used (tyre.js), not here.
  if (N > 60000) N = 60000; else if (N < -60000) N = -60000;

  w.NPrev = N;
  w.N = N;
  return N;
}

/** Vertical tyre force from the ground + unsprung mass integration. */
const K_TYRE = 200000;      // N/m vertical tyre stiffness
export const TYRE_K = K_TYRE;
const C_TYRE = 2200;        // N s/m, symmetric: a one-sided damper pumps energy
export const TYRE_MAX_COMP = 0.045;

export function unsprungStep(w, car, h) {
  const mu = car.params.unsprung;
  let Fg = 0;
  if (w.compression > 0) {
    // The tyre can only deflect its own height. A voxel riser (the road is carved
    // in 1 m blocks) can report a metre of "compression" in one step; feeding that
    // to a 200 kN/m spring makes the wheel launch the car instead of climbing the
    // step. Clamped, the wheel rides up the riser over a few substeps.
    const comp = w.compression > TYRE_MAX_COMP ? TYRE_MAX_COMP : w.compression;
    Fg = K_TYRE * comp - C_TYRE * w.vy;
    if (Fg < 0) Fg = 0;
    if (Fg > 6 * car.mass * 9.81) Fg = 6 * car.mass * 9.81;
  } else {
    w.compression = 0;
  }
  w.Fvert = Fg;

  const a = (Fg - w.N - mu * 9.81) / mu;
  w.vy += a * h;
  if (w.vy > 40) w.vy = 40; else if (w.vy < -40) w.vy = -40;
  w.y += w.vy * h;

  // Never let the wheel sink through the ground.
  const minY = w.groundY + w.rGeo - TYRE_MAX_COMP;
  if (w.y < minY) { w.y = minY; if (w.vy < 0) w.vy = 0; }

  if (Fg <= 0) w.airborneFrames++; else w.airborneFrames = 0;
  return Fg;
}

/**
 * Hard travel limits (bump / droop stops) as a position + momentum constraint.
 * A spring-only stop cannot hold the body: with k=78 kN/m and 1240 kg the body
 * sinks far past the nominal travel, the progressive stop then stores enough
 * energy to launch the car. The stop is where the arm physically bottoms out, so
 * it is enforced as a one-dimensional inelastic collision between the unsprung
 * mass and the body's share of mass at that corner.
 */
const STOP_RESTITUTION = 0.12;
export function travelConstraint(w, car) {
  const p = car.params;
  const Lmin = car.restLength - p.bumpStop;
  const Lmax = car.restLength + p.droopStop;
  const L = w.hub.y - w.y;
  if (L > Lmin && L < Lmax) return 0;

  const b = car.body;
  const mu = p.unsprung;
  const mb = car.mass / 4;
  const beyond = L > Lmax ? L - Lmax : L - Lmin;

  // Project the wheel onto the limit.
  w.y = w.hub.y - (L > Lmax ? Lmax : Lmin);

  // Relative velocity along the arm, using the body velocity *after* integration.
  // angVel is world frame, so the lever arm is the world offset of the mount.
  const hubVy = b.vel.y + (b.angVel.z * (w.hub.x - b.pos.x) - b.angVel.x * (w.hub.z - b.pos.z));
  const vRel = hubVy - w.vy;
  const closing = L > Lmax ? vRel > 0 : vRel < 0;
  if (!closing) return beyond;

  const J = (1 + STOP_RESTITUTION) * vRel / (1 / mu + 1 / mb);
  w.vy += Math.max(-12, Math.min(12, J / mu));
  b.vel.y -= Math.max(-6, Math.min(6, J / mb));

  // The stop acts at the mount, so it also kicks the attitude. angVel is WORLD
  // frame while I is the BODY-frame inertia tensor, so the impulse has to be
  // rotated into the body frame before the body-frame arm is applied: mixing the
  // two frames turns every bump stop into a roll torque on a car that is not
  // axis-aligned, which is what used to flip the car the moment it bottomed out.
  const I = b.I;
  const rx = w.mountLocal.x, ry = w.mountLocal.y, rz = w.mountLocal.z;
  const m = b.m;
  // The body receives -J along world +Y; world +Y expressed in the body frame is
  // (m[1], m[4], m[7]) because m is column-major (columns are the body axes).
  const jx = -J * m[1], jy = -J * m[4], jz = -J * m[7];
  mul3vT(m, b.angVel, _wB);
  _wB.x += clamp((ry * jz - rz * jy) / I.xx, -8, 8);
  _wB.y += clamp((rz * jx - rx * jz) / I.yy, -8, 8);
  _wB.z += clamp((rx * jy - ry * jx) / I.zz, -8, 8);
  mul3v(m, _wB, b.angVel);
  return beyond;
}
