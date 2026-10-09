// Steering: speed-sensitive ratio + simplified Ackermann (docs/02 §3.2, docs/06 §5).
import { clamp } from '../core/math3.js';

export function computeSteer(car, input) {
  const p = car.params;
  let s = clamp(input.steer, -1, 1);

  // Speed-sensitive: full lock is not available at stage speed.
  const speedFactor = 1 / (1 + car.groundSpeed * 0.012);
  let angle = s * p.steerMax * speedFactor;

  // Damage: slack in the rack (docs/02 §8).
  angle *= car.damage.steerRatio;

  // Counter-steer assist (docs/02 §10) and the handbrake +2 deg (docs/02 §6).
  if (car.assists.counterSteer) {
    const a = (car.wheels[0].alpha + car.wheels[1].alpha) * 0.5;
    angle += clamp(-a * 0.6, -4 * Math.PI / 180, 4 * Math.PI / 180);
  }
  if (input.handbrake > 0.1) angle += 2 * Math.PI / 180 * Math.sign(car.wheels[0].alpha || 0) * input.handbrake;

  car.steerAngle = angle;

  // Ackermann: the inner wheel turns more.
  const wb = p.wheelbase, t = p.trackFront;
  if (Math.abs(angle) < 1e-4) {
    car.wheels[0].steer = angle; car.wheels[1].steer = angle;
  } else {
    const R = wb / Math.tan(Math.abs(angle));
    const innerSide = -Math.sign(angle);           // turning left -> left wheel is inner
    const inner = Math.atan(wb / Math.max(0.5, R - t / 2)) * Math.sign(angle);
    const outer = Math.atan(wb / (R + t / 2)) * Math.sign(angle);
    car.wheels[0].steer = innerSide === -1 ? inner : outer;   // wheel 0 = front-left
    car.wheels[1].steer = innerSide === -1 ? outer : inner;   // wheel 1 = front-right
  }
  // Static toe-out on the rear (docs/02 §3.2).
  car.wheels[2].steer = 0.0035;
  car.wheels[3].steer = -0.0035;
  return angle;
}
