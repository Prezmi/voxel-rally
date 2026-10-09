// Differentials: centre split + per-axle open / viscous / locked (docs/02 §5).
import { clamp } from '../core/math3.js';
import { DIFF_TYPES } from './car-params.js';

function axleSplit(car, axle, T) {
  const p = car.params;
  const wl = car.wheels[axle * 2].omega;
  const wr = car.wheels[axle * 2 + 1].omega;
  const type = axle === 0 ? p.diffFront : p.diffRear;
  let transfer = 0;

  if (type === DIFF_TYPES.OPEN) {
    transfer = p.diffClutch * Math.sign(wr - wl);
  } else if (type === DIFF_TYPES.VISCOUS) {
    const slow = Math.max(wl, wr), fast = Math.min(wl, wr);
    transfer = clamp(p.kv * (slow - fast) * Math.sign(wr - wl), -Math.abs(T) * 0.9, Math.abs(T) * 0.9);
  } else {
    const pct = car.setup.lock;
    transfer = clamp(pct * T * Math.sign(wr - wl), -Math.abs(T) * 0.95, Math.abs(T) * 0.95);
  }

  let tl = T / 2 + transfer / 2;
  let tr = T / 2 - transfer / 2;
  // A wheel with no load cannot take much torque (it just spins).
  if (car.wheels[axle * 2].N < 120) tl *= 0.35;
  if (car.wheels[axle * 2 + 1].N < 120) tr *= 0.35;
  return [tl, tr];
}

export function applyDrive(car, shaftTorque, handbrake) {
  const p = car.params;
  const throttle = car.input.throttle;

  // Centre split, biased by throttle (on power the rear gets more) and by
  // longitudinal load transfer.
  let split = p.splitFront;
  if (p.drive === 'RWD') split = 0;
  else {
    const loadFront = (car.wheels[0].N + car.wheels[1].N) / Math.max(1, car.weightN);
    split = clamp(p.splitFront + 0.10 * (0.5 - loadFront) - 0.06 * throttle, 0.05, 0.75);
  }

  // Handbrake disconnects the rear drive and over-feeds the front (docs/02 §6).
  let rearShare = 1 - split;
  if (handbrake > 0.1) {
    rearShare *= (1 - handbrake);
    if (p.drive !== 'RWD') split = 0;
  }

  const Trear = shaftTorque * rearShare;
  const Tfront = shaftTorque * split;

  const [fl, fr] = Tfront > 0 ? axleSplit(car, 0, Tfront) : [0, 0];
  const [rl, rr] = Trear > 0 ? axleSplit(car, 1, Trear) : [0, 0];

  car.wheels[0].driveTorque = fl;
  car.wheels[1].driveTorque = fr;
  car.wheels[2].driveTorque = rl;
  car.wheels[3].driveTorque = rr;
}

export function applyBrakes(car, brakeInput, handbrake) {
  const p = car.params;
  const bias = car.setup.bias;                 // front share
  const total = p.brakeMax * brakeInput;
  const front = total * bias;
  const rear = total * (1 - bias);

  // docs/02 §3.7: the *service* brake is capped at mu*N*r so it cannot buy a
  // free lock — the limit is the tyre, not the caliper.
  const cap = (w) => Math.max(0, w.muEff * w.N * w.rEff);
  const capFront = cap(car.wheels[0]) + cap(car.wheels[1]);
  const capRear = cap(car.wheels[2]) + cap(car.wheels[3]);

  // docs/02 §6 sizes the lever as 0.9 * brake_max_torque. With §3.7's tyre cap in
  // place that literal value is either inert (capped back down to the tyre peak)
  // or locks the rear solid (3x the rear tyre's own peak); neither gives the §11
  // test-3 "controlled rear throw". The lever is therefore sized against the rear
  // tyre's own peak, which is what a driver actually modulates against.
  const hb = handbrake * p.handbrakeGain * capRear;

  const f = Math.min(front, capFront);
  const r = Math.min(rear, capRear) + hb;

  car.wheels[0].brakeTorque = f / 2;
  car.wheels[1].brakeTorque = f / 2;
  car.wheels[2].brakeTorque = r / 2;
  car.wheels[3].brakeTorque = r / 2;
}
