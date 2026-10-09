// TYRE MODEL — the core of the game (docs/02 §3).
// Pacejka magic formula per axis, combined-slip friction circle, rolling
// resistance, ground bulldozing (plough), sink drag, rut and surface features.
import { surface, effectiveMu } from '../world/surfaces.js';
import { TYRE_BASE } from './car-params.js';
import { clamp } from '../core/math3.js';

const RHO_SOFT = 900;          // kg/m^3 for the sink/plough medium
const SINK_AREA = 0.06;        // m^2 per metre of sink depth (tunable, docs/02 §4)

function magic(x, B, C, E) {
  const bx = B * x;
  return Math.sin(C * Math.atan(bx - E * (bx - Math.atan(bx))));
}

export function tyreForces(w, car, h) {
  const surf = surface(w.surfaceId);
  const B0 = TYRE_BASE.B0 * surf.stiffFactor;
  const C0 = TYRE_BASE.C0 * surf.curveFactor;
  const E0 = TYRE_BASE.E0;

  // --- effective peak friction coefficient (docs/02 §4) ---
  let mu = effectiveMu(surf, car.wetness, car.frozen) * car.compound.muScale * TYRE_BASE.gain;

  if (surf.kink) {
    // Asphalt heats up: up to +8% after ~20 s of driving.
    mu *= 1 + 0.08 * clamp(car.tyreTemp, 0, 1);
  }
  if (surf.looseLayer) {
    // Grainy pulse under braking on loose surfaces (docs/02 §4) — this is what
    // you feel in the wheel and hear in the granular bed.
    mu *= 1 + surf.grainAmp * Math.sin(car.grainPhase + w.i * 1.9);
  }
  const speed = Math.hypot(w.vx, w.vyLat);
  if (surf.aquaplane && car.wetness > 0.7 && Math.abs(w.vx) > 27) mu = 0.25;

  // Rut: a wheel sitting in a rut gains lateral grip and loses speed (docs/02 §4).
  let rutDepth = 0;
  if (surf.rut) {
    rutDepth = car.world ? car.world.rutAt(w.contact.x, w.contact.z) : 0;
    if (rutDepth > 0.015) mu *= 1.12;
  }

  w.muEff = mu;
  // Grip needs contact. The strut can pull (suspension.js), so the *load* that buys
  // grip is the part of it the ground can actually answer.
  const load = Math.max(0, w.N);
  const loadNorm = load / Math.max(1, car.weightN / 4);
  w.rEff = TYRE_BASE.r * (1 - 0.02 * clamp(loadNorm, 0, 3));

  // --- kinematics (docs/02 §3.1) ---
  const vcx = car.vContact.x, vcy = car.vContact.y, vcz = car.vContact.z;
  w.vx = vcx * w.forward.x + vcy * w.forward.y + vcz * w.forward.z;
  w.vyLat = vcx * w.right.x + vcy * w.right.y + vcz * w.right.z;

  // --- slips (docs/02 §3.2) ---
  const wr = w.omega * w.rEff;
  const denom = Math.max(Math.abs(w.vx), Math.abs(wr), 0.5);
  w.kappa = (wr - w.vx) / denom;
  w.alpha = Math.atan2(-w.vyLat, Math.abs(w.vx) + 0.5);   // already in the wheel frame
  w.kappaDenom = denom;

  // --- forces (docs/02 §3.3) ---
  // Combined slip as a slip *vector*: the tyre force magnitude follows the total
  // slip through the magic formula and its direction follows the slip direction.
  // Scaling the two axes proportionally instead (the usual shortcut) lets a fully
  // locked wheel keep almost all of its lateral grip, so a handbrake could never
  // break the rear away and a locked axle silently kept cornering.
  const Fpeak = mu * load;
  const sMag = Math.hypot(w.kappa, w.alpha);
  const dirK = sMag > 1e-6 ? w.kappa / sMag : 0;
  const dirA = sMag > 1e-6 ? w.alpha / sMag : 0;
  const Fmag = Fpeak * magic(sMag, B0, C0, E0);
  let Flon = Fmag * dirK;
  let Flat = Fmag * dirA;

  // Local slope of the magic formula (dF/dkappa / Fpeak). brakeAndDrive needs it:
  // it is ~B*C on the linear part and ~0 once the tyre is saturated, which is what
  // separates "the tyre is holding the wheel" from "the wheel is spinning away".
  w.slipSlope = (magic(sMag + 0.02, B0, C0, E0) - magic(Math.max(0, sMag - 0.02), B0, C0, E0)) / 0.04;

  // --- friction circle (docs/02 §3.4) ---
  const demand = Math.hypot(Flon, Flat);
  const cap = mu * w.N;
  if (demand > cap && demand > 1e-6) {
    const sc = cap / demand;
    Flon *= sc; Flat *= sc;
  }

  // --- rolling resistance + bulldozing + sink (docs/02 §3.5) ---
  const cushion = surf.sink * 900;
  w.Froll = -Math.sign(w.vx) * (surf.crr * load + cushion * Math.abs(w.vx) * 0.25);
  w.Fplough = -Math.sign(w.vyLat) * surf.plough * load * Math.abs(w.vyLat) / (Math.abs(w.vyLat) + 3);

  if (surf.ridgeBuild && w.slipTime > 0.15) {
    // Snow banks up in front of a sliding wheel, then breaks (docs/02 §4).
    w.Fplough *= 1 + 0.8 * clamp(w.slipTime / 2.5, 0, 1);
  }

  if (rutDepth > 0.015) w.Froll -= Math.sign(w.vx) * 0.08 * Math.abs(w.vx) * 60;

  if (surf.sink > 0 && Math.abs(w.vx) > 0.5) {
    const a = surf.sink * SINK_AREA;
    const Fsink = 0.5 * RHO_SOFT * a * w.vx * w.vx * Math.sign(w.vx);
    w.Froll -= Fsink;
  }

  w.Flon = Flon;
  w.Flat = Flat;

  // --- slip energy: drives dirt, decals, audio (docs/06 §4) ---
  const slipV = Math.abs(w.kappa) * Math.abs(w.vx) + Math.abs(w.vyLat);
  w.slip = clamp(slipV / 6, 0, 1);
  w.slipEnergy = Math.min(200000, Math.hypot(Flon * w.kappa * w.vx, Flat * w.vyLat));
  if (w.slipEnergy > 4000) w.slipTime += h; else w.slipTime = Math.max(0, w.slipTime - h * 2);

  // Clamp per docs/02 §9.
  const fmax = 3.5 * car.mass * 9.81;
  if (w.Flon > fmax) w.Flon = fmax; else if (w.Flon < -fmax) w.Flon = -fmax;
  if (w.Flat > fmax) w.Flat = fmax; else if (w.Flat < -fmax) w.Flat = -fmax;

  return { Flon: w.Flon, Flat: w.Flat };
}

/** Brake + drive torques into wheel spin (docs/02 §3.7) incl. lock feedback. */
export function brakeAndDrive(w, car, h) {
  const I = TYRE_BASE.I;
  let drive = w.driveTorque;
  let brake = w.brakeTorque * w.damage.brakeScale;

  // A free wheel cannot be dragged backwards by the driveline.
  if (w.omega < 0 && drive < 0) drive = 0;

  const r = w.rEff;
  const T = drive - brake;
  const cap = Math.max(1, w.muEff * Math.max(0, w.N));

  // --- implicit slip <-> spin step ---
  // dF/domega = (dF/dkappa) * r / denom is tens of kN per rad/s while the tyre is
  // on its linear part, so this coupling is the stiffest mode in the model. Taken
  // explicitly it overshoots by an order of magnitude at every substep: a parked or
  // creeping car gets a couple of kN per wheel flipping sign each substep, which
  // pumps energy into the body and launches it. Solved as a linear implicit step it
  // settles to pure rolling in one substep, and because the slope is the *local*
  // one it collapses to the explicit case exactly where the tyre is saturated
  // (a spinning wheel must still be free to spin away).
  const slope = w.slipSlope || 0;
  const G = cap * slope * r / Math.max(0.05, w.kappaDenom || 0.5);   // N per (rad/s)
  const dOmega = (T - r * w.Flon) / (I / h + r * G);
  w.omega += dOmega;

  // The force that belongs to that spin step (torque balance on the wheel), kept
  // inside the tyre's own peak and inside the friction circle.
  let Flon = w.Flon + G * dOmega;
  if (Flon > cap) Flon = cap; else if (Flon < -cap) Flon = -cap;
  const demand = Math.hypot(Flon, w.Flat);
  if (demand > cap && demand > 1e-6) {
    const sc = cap / demand;
    Flon *= sc; w.Flat *= sc;
  }
  w.Flon = Flon;

  // docs/02 §3.4's lock limit taken as a limit on the spin itself: a braked wheel
  // is held at the slip where the magic formula peaks instead of being dragged
  // solid. Held solid, a tyre keeps all of its force along the slide and none
  // across it, so the handbrake could only ever spin the car (59 deg of body slip
  // in T3); at the limit it drifts, and the car can be brought back.
  const braking = brake > drive;
  const lockLimit = braking ? TYRE_BASE.kappaLockBrake : TYRE_BASE.kappaLockDrive;
  // The service brake is already capped at the tyre's own peak, so it is held
  // at peak slip; the handbrake is the one control that is allowed to drag the
  // rear past it.
  if (braking && w.N > 100 && w.vx > 0.1 && car.input.handbrake < 0.1) {
    const minOmega = w.vx * (1 - lockLimit) / r;
    if (w.omega < minOmega) w.omega = minOmega;
  }

  // Combined-slip lock feedback (docs/02 §3.4).
  if (Math.abs(w.kappa) > lockLimit && w.N > 100) {
    w.omega -= (Flon * r / I) * h * 0.6;
  }

  // Assists are limiters only, never mu (docs/02 §10).
  if (car.assists.abs && braking && w.kappa < -0.15) {
    w.omega += ((-0.15 * Math.max(Math.abs(w.vx), w.omega * w.rEff, 0.5) - w.omega * w.rEff) / w.rEff) * h * 0.8;
  }
  if (car.assists.tc && drive > 0 && w.kappa > 0.22) {
    w.omega -= ((w.kappa - 0.22) * Math.max(Math.abs(w.vx), 1) / w.rEff) * h * 0.8;
  }

  const redlineOmega = car.redlineOmega;
  if (w.omega > redlineOmega) w.omega = redlineOmega;
  if (w.omega < 0) w.omega = 0;      // free wheel does not reverse (docs/02 §3.7)
}
