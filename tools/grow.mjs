// Divergence of two identical parked cars that differ by 1e-9 in every DOF.
// Reports the exponential growth rate per sim step in the linear range.
import { VoxelWorld } from '../src/world/chunk.js';
import { DT } from '../src/core/time.js';
const SRC = (process.argv.find((a) => a.startsWith('--src=')) || '').split('=')[1] || '../src/car/vehicle.js';
const { Vehicle } = await import(SRC);
const world = new VoxelWorld(1);
world.groundHeight = () => 0; world.surfaceAt = () => 2; world.rutAt = () => 0;
const EPS = 1e-9;
function run(yaw) {
  const mk = () => { const c = new Vehicle('A', world, { assists: { autoShift: true } }); c.placeAt(0, 0, yaw, 0); c.setInput({ throttle: 0, brake: 0, steer: 0, handbrake: 0, shiftUp: 0, shiftDown: 0 }); return c; };
  const B = mk(), P = mk();
  for (const w of P.wheels) { w.y += EPS; w.vy += EPS; }
  const q = P.body.quat, { x, y, z, w } = q, a = EPS * 0.5;   // tiny body-frame roll
  q.x += a * w; q.y += a * z; q.z += a * w + a * x * 0; q.w += -a * x;
  P.body.refreshFrame();
  const rec = [];
  for (let i = 0; i < 1200; i++) {
    B.step(DT); P.step(DT);
    let d = 0;
    d = Math.max(d, Math.abs(P.body.pos.y - B.body.pos.y), Math.abs(P.body.vel.y - B.body.vel.y));
    for (let k = 0; k < 4; k++) d = Math.max(d, Math.abs(P.wheels[k].y - B.wheels[k].y), Math.abs(P.wheels[k].N - B.wheels[k].N) / 1000);
    rec.push(d);
  }
  // linear-range fit: 1e-8 .. 1e-2
  let lo = -1, hi = -1;
  for (let i = 0; i < rec.length; i++) { if (lo < 0 && rec[i] > 1e-8) lo = i; if (rec[i] < 1e-2) hi = i; }
  let lam = NaN;
  if (lo >= 0 && hi > lo + 5) lam = Math.pow(rec[hi] / rec[lo], 1 / (hi - lo));
  return { lam, rec };
}
for (const yaw of ((process.argv.find((a) => a.startsWith('--yaw=')) || '').split('=')[1] || '0.4,1.57,-2.991').split(',')) {
  const { lam, rec } = run(Number(yaw));
  console.log(`yaw=${String(yaw).padEnd(7)} |lambda|/step=${Number.isNaN(lam) ? 'none (no growth past 1e-8)' : lam.toFixed(4)}   |d| at 60/300/600/1200 = ${rec[59].toExponential(2)} ${rec[299].toExponential(2)} ${rec[599].toExponential(2)} ${rec[1199].toExponential(2)}`);
}
