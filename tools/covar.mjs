// Covariance test: placeAt gives a body-frame-identical state at every yaw, so if
// the substep were frame-covariant the BODY-frame trajectory would be identical.
// Find the first substep where it isn't, and which quantity breaks first.
import { VoxelWorld } from '../src/world/chunk.js';
const FLAGS = process.argv[2] ? JSON.parse(process.argv[2]) : {};
globalThis.__flags = FLAGS;
const SRC = (process.argv[3]) || '../src/car/vehicle.js';
const { Vehicle } = await import(SRC);
import { Body } from '../src/car/body.js';
import { DT } from '../src/core/time.js';
import { mul3vT } from '../src/core/math3.js';

const world = new VoxelWorld(1);
world.groundHeight = () => 0; world.surfaceAt = () => 2; world.rutAt = () => 0;

class TraceBody extends Body {
  constructor(p) { super(p); this.rows = []; }
  integrate(h) {
    const b = this, car = this.car;
    mul3vT(b.m, b.force, this._fb || (this._fb = { x: 0, y: 0, z: 0 }));
    mul3vT(b.m, b.torque, this._tb || (this._tb = { x: 0, y: 0, z: 0 }));
    mul3vT(b.m, b.angVel, this._wb || (this._wb = { x: 0, y: 0, z: 0 }));
    mul3vT(b.m, b.vel, this._vb || (this._vb = { x: 0, y: 0, z: 0 }));
    const r = [b.pos.y, this._vb.x, this._vb.y, this._vb.z, this._wb.x, this._wb.y, this._wb.z,
               this._fb.x, this._fb.y, this._fb.z, this._tb.x, this._tb.y, this._tb.z,
               b.m[1], b.m[7]];
    for (const w of car.wheels) {
      r.push(w.hub.y - w.y, w.suspVel, w.N, w.vy, w.Flon, w.Flat, w.Froll, w.alpha, w.kappa, w.omega, w.hubVy);
    }
    this.rows.push(r);
    super.integrate(h);
  }
}
class TraceCar extends Vehicle {
  constructor(id, w, o) { super(id, w, o); const tb = new TraceBody(this.params); tb.car = this; this.body = tb; }
}

const NAMES = ['pos.y','vBx','vBy','vBz','wBx','wBy','wBz','FBx','FBy','FBz','TBx','TBy',
  'TBz','m1','m7',
  'L0','sV0','N0','vy0','Fl0','Fa0','Fr0','al0','ka0','om0','hV0',
  'L1','sV1','N1','vy1','Fl1','Fa1','Fr1','al1','ka1','om1','hV1',
  'L2','sV2','N2','vy2','Fl2','Fa2','Fr2','al2','ka2','om2','hV2',
  'L3','sV3','N3','vy3','Fl3','Fa3','Fr3','al3','ka3','om3','hV3'];

function run(yaw, steps) {
  const car = new TraceCar('A', world, { assists: { autoShift: true } });
  car.placeAt(0, 0, yaw, 0);
  car.setInput({ throttle: 0, brake: 0, steer: 0, handbrake: 0, shiftUp: 0, shiftDown: 0 });
  car.body.rows.length = 0;
  for (let i = 0; i < steps; i++) car.step(DT);
  return car.body.rows;
}

const A = run(0.4, 60), B = run(1.57, 60);
let found = false;
for (let s = 0; s < A.length && !found; s++) {
  const diffs = [];
  for (let i = 0; i < A[s].length; i++) {
    const d = Math.abs(A[s][i] - B[s][i]);
    const sc = Math.max(1e-12, Math.abs(A[s][i]) + Math.abs(B[s][i]));
    if (d / sc > 1e-7 && d > 1e-12) diffs.push([NAMES[i], A[s][i], B[s][i], d]);
  }
  if (diffs.length) {
    console.log(`first divergence at substep ${s} (step ${Math.floor(s / 4)}, sub ${s % 4}):`);
    for (const [n, a, b, d] of diffs) console.log(`   ${n.padEnd(6)} yaw0.4=${a.toExponential(6)}  yaw1.57=${b.toExponential(6)}  d=${d.toExponential(3)}`);
    found = true;
  }
}
if (!found) console.log('no divergence in 60 steps');
