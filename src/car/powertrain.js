// Engine + 6-speed gearbox with a 120 ms shift cut (docs/02 §3.7).
// Single-node engine model: torque(rpm, throttle) from a procedural curve.
import { clamp } from '../core/math3.js';

const CUT_TIME = 0.12;
const RPM_COUPLE = 18;      // 1/s coupling of engine rpm to the driveline

function torqueCurve(e, rpm) {
  // Flat rally torque plateau. A launch from idle still delivers torque through
  // the clutch, so the curve must not collapse to zero at idle.
  const lo = 0.52 + 0.48 * smoothstep(e.idle, e.peakRpm * 0.62, rpm);
  const hi = 1 - 0.34 * smoothstep(e.peakRpm, e.redline, rpm);
  return e.maxTorque * lo * hi;
}
function smoothstep(a, b, x) {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
}

export class Powertrain {
  constructor(car) {
    this.car = car;
    const e = car.params.engine;
    this.rpm = e.idle;
    this.gear = 1;              // 0-based index into params.gears
    this.cut = 0;               // shift interruption timer
    this.shaftTorque = 0;
    this.autoShift = true;
    this.stallTimer = 0;
  }

  ratio() { return this.car.params.gears[this.gear] * this.car.params.finalDrive; }

  shiftUp() { if (this.gear < this.car.params.gears.length - 1) { this.gear++; this.cut = CUT_TIME; } }
  shiftDown() { if (this.gear > 0) { this.gear--; this.cut = CUT_TIME; } }

  step(dt, input) {
    const p = this.car.params, e = p.engine;
    const wheels = this.car.wheels;

    // Reference wheel speed for the engaged axle(s).
    let omega = 0, n = 0;
    if (p.drive === 'RWD') { omega = (wheels[2].omega + wheels[3].omega) / 2; n = 2; }
    else { omega = (wheels[0].omega + wheels[1].omega + wheels[2].omega + wheels[3].omega) / 4; }

    const r = this.ratio();
    const targetRpm = Math.max(e.idle, omega * r * 60 / (2 * Math.PI));

    if (this.cut > 0) {
      this.cut -= dt;
      // Blip during the cut so revs do not freeze mid-shift.
      this.rpm += (Math.max(e.idle, targetRpm * 0.85) - this.rpm) * Math.min(1, dt * 8);
    } else {
      const k = 1 - Math.exp(-RPM_COUPLE * dt);
      this.rpm += (targetRpm - this.rpm) * k;
    }
    if (this.rpm < e.idle) this.rpm = e.idle;

    // Gear selection.
    if (this.cut <= 0) {
      if (this.car.assists.autoShift) {
        if (this.rpm > e.redline * 0.965) this.shiftUp();
        else if (this.rpm < e.peakRpm * 0.52 && input.throttle > 0.35 && this.gear > 0) this.shiftDown();
      } else {
        if (input.shiftUp > 0.5 && this._lastShiftUp < 0.5) this.shiftUp();
        if (input.shiftDown > 0.5 && this._lastShiftDown < 0.5) this.shiftDown();
      }
    }
    this._lastShiftUp = input.shiftUp;
    this._lastShiftDown = input.shiftDown;

    // Torque.
    let tq = 0;
    if (this.cut <= 0) {
      if (input.throttle > 0.001) {
        tq = torqueCurve(e, this.rpm) * input.throttle;
        if (this.rpm > e.redline) tq *= 0.18;                 // limiter
        if (this.rpm > e.redline * 1.02) tq = 0;
      } else {
        tq = -(14 + 0.010 * this.rpm) * (1 + (input.brake > 0.05 ? 0.4 : 0));  // engine braking
      }
    }

    // Engine damage reduces power (docs/02 §8).
    tq *= this.car.damage.enginePowerScale;

    this.shaftTorque = tq * this.ratio() * p.efficiency;
    this.car.rpm = this.rpm;
    this.car.gear = this.gear + 1;
    this.car.redlineOmega = e.redline * 60 / (2 * Math.PI) / this.ratio();
    return this.shaftTorque;
  }
}
