// Per-substep power audit (docs/02 §9 order, library functions untouched).
// Body.integrate is subclassed: at that moment b.force/b.torque and every per-wheel
// cache hold exactly the values the substep used, so each term's power can be
// recomputed from the model's own numbers without editing src/.
import { VoxelWorld } from '../src/world/chunk.js';
import { Vehicle } from '../src/car/vehicle.js';
import { Body, GRAVITY } from '../src/car/body.js';
import { DT } from '../src/core/time.js';
import { TYRE_BASE } from '../src/car/car-params.js';
import { TYRE_K, TYRE_MAX_COMP } from '../src/car/suspension.js';

const world = new VoxelWorld(1);
world.groundHeight = () => 0; world.surfaceAt = () => 2; world.rutAt = () => 0;

class TraceBody extends Body {
  constructor(p) { super(p); this.log = []; }
  integrate(h) {
    const b = this, car = this.car, w4 = car.wheels;
    const vx = b.vel.x, vy = b.vel.y, vz = b.vel.z, wx = b.angVel.x, wy = b.angVel.y, wz = b.angVel.z;
    // total wrench power the integrator is about to apply
    const Ptot = b.force.x * vx + b.force.y * vy + b.force.z * vz + b.torque.x * wx + b.torque.y * wy + b.torque.z * wz;
    // suspension: N applied at the hub (world), arm hub-pos
    let Psusp = 0;
    for (const w of w4) {
      const rx = w.hub.x - b.pos.x, ry = w.hub.y - b.pos.y, rz = w.hub.z - b.pos.z;
      const hy = vy + (wz * rx - wx * rz);
      Psusp += w.N * hy;
    }
    // tyre in-plane forces at the contact arm (same arms as accumulateOnBody)
    let Ptyre = 0;
    for (const w of w4) {
      const fx = (w.Flon + w.Froll) * w.forward.x + w.Flat * w.right.x;
      const fy = (w.Flon + w.Froll) * w.forward.y + w.Flat * w.right.y;
      const fz = (w.Flon + w.Froll) * w.forward.z + w.Flat * w.right.z;
      const ax = w.contact.x - b.pos.x, ay = (w.groundY + car.params.forceCentre) - b.pos.y, az = w.contact.z - b.pos.z;
      const tx = ay * fz - az * fy, ty = az * fx - ax * fz, tz = ax * fy - ay * fx;
      Ptyre += fx * vx + fy * vy + fz * vz + tx * wx + ty * wy + tz * wz;
    }
    // hull = everything left over
    const grav = -b.mass * GRAVITY * vy;
    const Pgrav = grav;
    const Phull = Ptot - Psusp - Ptyre - Pgrav;
    // unsprung mass
    let Pwheel = 0, PsuspOnWheel = 0, PtyreSpring = 0;
    for (const w of w4) {
      Pwheel += (w.Fvert - w.N - car.params.unsprung * GRAVITY) * w.vy;
      PtyreSpring += w.Fvert * w.vy;
      PsuspOnWheel += -w.N * w.vy;
    }
    this.log.push([Ptot, Psusp, Ptyre, Phull, Pgrav, Pwheel, PtyreSpring, PsuspOnWheel]);
    super.integrate(h);
  }
}

class TraceCar extends Vehicle {
  constructor(id, w, o) { super(id, w, o); const tb = new TraceBody(this.params); tb.car = this; this.body = tb; }
}

function energy(car) {
  const b = car.body, mu = car.params.unsprung;
  mul3vT(b.m, b.angVel, _wb);
  const I = b.I;
  let E = 0.5 * b.mass * (b.vel.x ** 2 + b.vel.y ** 2 + b.vel.z ** 2)
        + 0.5 * (I.xx * _wb.x ** 2 + I.yy * _wb.y ** 2 + I.zz * _wb.z ** 2)
        + b.mass * GRAVITY * b.pos.y;
  for (const w of car.wheels) {
    const k = w.axle === 0 ? car.susp.kFront : car.susp.kRear;
    const comp = Math.min(w.compression, TYRE_MAX_COMP);
    E += 0.5 * mu * w.vy * w.vy + mu * GRAVITY * w.y + 0.5 * k * w.susp * w.susp + 0.5 * TYRE_K * comp * comp;
  }
  return E;
}
import { mul3vT } from '../src/core/math3.js';
const _wb = { x: 0, y: 0, z: 0 };

const YAWS = (process.argv.find((a) => a.startsWith('--yaw=')) || '').split('=')[1] || '0.4,1.57,-2.991';
const STEPS = Number(process.argv.find((a) => a.startsWith('--steps='))?.split('=')[1] || 240);
for (const yawS of YAWS.split(',')) {
  const yaw = Number(yawS);
  const car = new TraceCar('A', world, { assists: { autoShift: true } });
  car.placeAt(0, 0, yaw, 0);
  car.setInput({ throttle: 0, brake: 0, steer: 0, handbrake: 0, shiftUp: 0, shiftDown: 0 });
  const L = car.body.log; L.length = 0;
  const sums = new Float64Array(8);
  const per = [];
  let E0 = energy(car), Emax = 0, Eprev = E0;
  for (let i = 0; i < STEPS; i++) {
    L.length = 0;
    car.step(DT);
    let subMax = 0;
    for (let s = 0; s < L.length; s++) for (let t = 0; t < 8; t++) { sums[t] += L[s][t]; if (t === 0) subMax = Math.max(subMax, L[s][0]); }
    const E = energy(car);
    per.push({ dE: E - Eprev, P: subMax });
    Eprev = E; Emax = Math.max(Emax, Math.abs(E - E0));
  }
  const names = ['TOTAL wrench', 'suspension N@hub', 'tyre Flon/Flat/Froll', 'HULL+rest', 'gravity', 'unsprung net', 'tyre spring Fg@vy', '-N @ wheel vy'];
  console.log(`--- yaw ${yaw}  ${STEPS} steps  E=${E0.toFixed(0)}  max|E-E0|=${Emax.toFixed(0)} J`);
  for (let t = 0; t < 8; t++) console.log(`   ${names[t].padEnd(22)} int over run = ${sums[t].toFixed(1)} J`);
  for (let i = 0; i < per.length; i += Math.max(1, Math.floor(per.length / 8))) {
    console.log(`   step ${i}: dE=${per[i].dE.toFixed(2)} J   maxSubP=${per[i].P.toFixed(1)} W  dy=${(car.body.pos.y - 0.461379).toFixed(4)}`);
  }
}
