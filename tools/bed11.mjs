import { VoxelWorld } from '../src/world/chunk.js';
import { Vehicle } from '../src/car/vehicle.js';
import { DT } from '../src/core/time.js';
import { mul3vT } from '../src/core/math3.js';

const world = new VoxelWorld(1);
world.groundHeight = () => 0;
world.surfaceAt = () => 2;
world.rutAt = () => 0;

const YAW = Number(process.argv.find((a)=>a.startsWith('--yaw='))?.split('=')[1] || 0.4);
const _t = { x: 0, y: 0, z: 0 };
function run(name, mutate, off) {
  const car = new Vehicle('A', world, { assists: { autoShift: true } });
  car.placeAt(0, 0, YAW, 0);
  mutate(car);
  car.setInput({ throttle: 0, brake: 0, steer: 0, handbrake: 0, shiftUp: 0, shiftDown: 0 });
  let maxRate = 0, maxDy = 0;
  const y0 = car.body.pos.y;
  const STEPS = Number(process.argv.find((a)=>a.startsWith('--steps='))?.split('=')[1] || 360);
  for (let i = 0; i < STEPS; i++) {
    car.step(DT);
    const b = car.body;
    mul3vT(b.m, b.angVel, _t);
    maxRate = Math.max(maxRate, Math.hypot(_t.x, _t.z));
    maxDy = Math.max(maxDy, Math.abs(b.pos.y - y0));
  }
  const b = car.body;
  console.log(`${name.padEnd(22)} maxRate=${maxRate.toFixed(2)} maxDy=${maxDy.toFixed(3)} endRate=${Math.hypot(_t.x, _t.z).toFixed(2)} len=${car.wheels.map((w) => (w.hub.y - w.y).toFixed(3)).join(' ')}`);
}

run('baseline', () => {});
run('ALL extras off', () => {}, { hull: true, travel: true, stops: true, arb: true, tyre: true });
run('damp x2', (c) => { c.susp.cBump *= 2; c.susp.cReb *= 2; });
run('damper = 0', (c) => { c.susp.cBump = 0; c.susp.cReb = 0; });
run('damper x4', (c) => { c.susp.cBump *= 4; c.susp.cReb *= 4; });
run('springs equal', (c) => { c.susp.kRear = c.susp.kFront; });
run('unsprung 0.05', (c) => { c.params.unsprung = 0.05; });
run('damper 0, no hull', (c) => { c.susp.cBump = 0; c.susp.cReb = 0; }, { hull: true });
