// Rigid body: state, inertia, semi-implicit integration (docs/02 §1, §9).
// angVel is integrated in the BODY frame (Euler's equation), velocity/position in world.
import { v3, q4, quatToMat3, mul3v, mul3vT, cross3, integrateQ, normalizeQ, clamp } from '../core/math3.js';

export const GRAVITY = 9.81;
const RHO_AIR = 1.2;

export class Body {
  constructor(params) {
    this.params = params;
    this.mass = params.mass;
    this.pos = v3(0, 1, 0);
    this.vel = v3();
    this.quat = q4();
    this.angVel = v3();
    this.prevPos = v3(0, 1, 0);
    this.prevQuat = q4();
    this.force = v3();
    this.torque = v3();

    const h = params.hull;
    const s = params.inertiaScale || { xx: 1, yy: 1, zz: 1 };
    const m3 = this.mass / 3;
    this.I = {
      xx: m3 * (h.y * h.y + h.z * h.z) * s.xx,
      yy: m3 * (h.x * h.x + h.z * h.z) * s.yy,
      zz: m3 * (h.x * h.x + h.y * h.y) * s.zz,
    };
    this.m = new Float64Array(9);
    this._tqB = v3(); this._wB = v3(); this._tmp = v3();
    this.up = v3(0, 1, 0);
    this.forward = v3(1, 0, 0);
    this.right = v3(0, 0, 1);
    this.speed = 0;
    this.groundSpeed = 0;
  }

  refreshFrame() {
    quatToMat3(this.quat, this.m);
    const m = this.m;
    this.forward.x = m[0]; this.forward.y = m[1]; this.forward.z = m[2];
    this.up.x = m[3]; this.up.y = m[4]; this.up.z = m[5];
    this.right.x = m[6]; this.right.y = m[7]; this.right.z = m[8];
    this.speed = Math.hypot(this.vel.x, this.vel.y, this.vel.z);
    this.groundSpeed = Math.hypot(this.vel.x, this.vel.z);
  }

  clearForces() { this.force.x = 0; this.force.y = 0; this.force.z = 0; this.torque.x = 0; this.torque.y = 0; this.torque.z = 0; }

  snapshot() {
    this.prevPos.x = this.pos.x; this.prevPos.y = this.pos.y; this.prevPos.z = this.pos.z;
    this.prevQuat.x = this.quat.x; this.prevQuat.y = this.quat.y;
    this.prevQuat.z = this.quat.z; this.prevQuat.w = this.quat.w;
  }

  /** docs/02 §9: angVel -> quat -> vel -> pos. */
  integrate(h) {
    const m = this.m;
    mul3vT(m, this.torque, this._tqB);
    mul3vT(m, this.angVel, this._wB);

    const I = this.I;
    const wx = this._wB.x, wy = this._wB.y, wz = this._wB.z;
    // gyroscopic term w x (I w)
    const Iwx = I.xx * wx, Iwy = I.yy * wy, Iwz = I.zz * wz;
    const gx = wy * Iwz - wz * Iwy;
    const gy = wz * Iwx - wx * Iwz;
    const gz = wx * Iwy - wy * Iwx;

    let bx = wx + ((this._tqB.x - gx) / I.xx) * h;
    let by = wy + ((this._tqB.y - gy) / I.yy) * h;
    let bz = wz + ((this._tqB.z - gz) / I.zz) * h;

    // Clamp body rate (docs/02 §9).
    const wmag = Math.hypot(bx, by, bz);
    if (wmag > 12) { const s = 12 / wmag; bx *= s; by *= s; bz *= s; }
    // Aerodynamic-ish angular damping keeps the shell from ringing.
    const angDamp = 1 - 1.6 * h;
    bx *= angDamp; by *= angDamp; bz *= angDamp;

    this._wB.x = bx; this._wB.y = by; this._wB.z = bz;
    integrateQ(this.quat, this._wB, h);
    mul3v(m, this._wB, this.angVel);

    // Velocity with a rate limit (docs/02 §9: |dv| <= 45 m/s per step).
    const ax = this.force.x / this.mass, ay = this.force.y / this.mass, az = this.force.z / this.mass;
    let dvx = ax * h, dvy = ay * h, dvz = az * h;
    const dvm = Math.hypot(dvx, dvy, dvz);
    if (dvm > 45) { const s = 45 / dvm; dvx *= s; dvy *= s; dvz *= s; }
    this.vel.x += dvx; this.vel.y += dvy; this.vel.z += dvz;
    const vm = Math.hypot(this.vel.x, this.vel.y, this.vel.z);
    if (vm > 120) { const s = 120 / vm; this.vel.x *= s; this.vel.y *= s; this.vel.z *= s; }

    this.pos.x += this.vel.x * h; this.pos.y += this.vel.y * h; this.pos.z += this.vel.z * h;
    if (!isFinite(this.pos.x) || !isFinite(this.pos.y) || !isFinite(this.pos.z)) this.recover();
  }

  applyGravityAero() {
    const p = this.params;
    this.force.y -= this.mass * GRAVITY;
    const v = this.vel;
    const sp = Math.hypot(v.x, v.y, v.z);
    if (sp > 0.01) {
      const qd = 0.5 * RHO_AIR * p.aero.cdA;
      const drag = qd * sp * sp;
      this.force.x -= drag * (v.x / sp);
      this.force.y -= drag * (v.y / sp);
      this.force.z -= drag * (v.z / sp);
      // Downforce presses the car down: more grip, no lift.
      const df = 0.5 * RHO_AIR * p.aero.downforce * (v.x * v.x + v.z * v.z);
      this.force.y -= df;
    }
  }

  recover() {
    this.pos.x = 0; this.pos.y = 30; this.pos.z = 0;
    this.vel.x = 0; this.vel.y = 0; this.vel.z = 0;
    this.angVel.x = 0; this.angVel.y = 0; this.angVel.z = 0;
    this.quat.x = 0; this.quat.y = 0; this.quat.z = 0; this.quat.w = 1;
  }
}
