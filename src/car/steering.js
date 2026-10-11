// Steering: speed-sensitive ratio + simplified Ackermann (docs/02 §3.2, docs/06 §5).
import { clamp } from '../core/math3.js';

const PARK_SPEED = 13;             // m/s (~47 km/h): below this the rack is at full lock
const RAMP_TOP_SPEED = 120 / 3.6;  // m/s where the lock floor is pinned
const LOCK_AT_TOP = 0.30;          // 30 % of steerMax left at 120 km/h

export function computeSteer(car, input) {
  const p = car.params;
  let s = clamp(input.steer, -1, 1);

  // Speed-sensitive ramp (docs/02 §3.2): the rack is at FULL LOCK at parking speeds
  // and falls in a straight line to LOCK_AT_TOP of lock at 120 km/h, so full lock can
  // never throw the car at stage speed. The old 1/(1+v*0.012) curve still gave 71 % of
  // lock at 120 km/h (measured 22.8 deg of rack) - that is what the player felt as the
  // car snapping away from the apex, and it never reached full lock at walking speed.
  const v = Math.max(0, car.groundSpeed);
  const u = clamp((v - PARK_SPEED) / (RAMP_TOP_SPEED - PARK_SPEED), 0, 1);
  const speedFactor = 1 - (1 - LOCK_AT_TOP) * u;
  let angle = s * p.steerMax * speedFactor;

  // Damage: slack in the rack (docs/02 §8).
  angle *= car.damage.steerRatio;

  // Counter-steer assist (docs/02 §10) and the handbrake +2 deg (docs/02 §6).
  if (car.assists.counterSteer) {
    const a = (car.wheels[0].alpha + car.wheels[1].alpha) * 0.5;
    angle += clamp(-a * 0.6, -4 * Math.PI / 180, 4 * Math.PI / 180);
    // Assisted counter steer stability: a yaw-rate damper whose gain grows with speed,
    // so a fast car that is lifted off the throttle is caught before it snaps.
    const k = 0.03 + 0.006 * car.groundSpeed;      // rad of rack per rad/s of yaw
    angle += clamp(-k * car.body.angVel.y, -5 * Math.PI / 180, 5 * Math.PI / 180);
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
