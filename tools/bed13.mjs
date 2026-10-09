import { VoxelWorld } from '../src/world/chunk.js';
import { Vehicle } from '../src/car/vehicle.js';
import { DT } from '../src/core/time.js';
import { mul3vT } from '../src/core/math3.js';
const world = new VoxelWorld(1);
world.groundHeight = () => 0; world.surfaceAt = () => 2; world.rutAt = () => 0;
const _t = { x: 0, y: 0, z: 0 };
const YAWS = (process.argv.find((a) => a.startsWith('--yaw=')) || '').split('=')[1] || '0.4,1.57,-2.991';
const STEPS = Number(process.argv.find((a) => a.startsWith('--steps='))?.split('=')[1] || 1200);
const NAME = process.argv.find((a) => a.startsWith('--name='))?.split('=')[1] || 'variant';
for (const yawS of YAWS.split(',')) {
  const yaw = Number(yawS);
  const car = new Vehicle('A', world, { assists: { autoShift: true } });
  car.placeAt(0, 0, yaw, 0);
  car.setInput({ throttle: 0, brake: 0, steer: 0, handbrake: 0, shiftUp: 0, shiftDown: 0 });
  let maxRate = 0, maxDy = 0; const y0 = car.body.pos.y;
  for (let i = 0; i < STEPS; i++) {
    car.step(DT);
    const b = car.body; mul3vT(b.m, b.angVel, _t);
    maxRate = Math.max(maxRate, Math.hypot(_t.x, _t.z)); maxDy = Math.max(maxDy, Math.abs(b.pos.y - y0));
  }
  const b = car.body;
  const sumN = car.wheels.reduce((s, w) => s + w.N, 0);
  console.log(`${NAME} yaw=${yaw} steps=${STEPS} k=${car.susp.kFront.toFixed(0)}/${car.susp.kRear.toFixed(0)} c=${car.susp.cBump.toFixed(0)}/${car.susp.cReb.toFixed(0)} unsprung=${car.params.unsprung} maxRate=${maxRate.toFixed(4)} maxDy=${maxDy.toFixed(4)} sumN=${sumN.toFixed(0)} len=${car.wheels.map((w) => (w.hub.y - w.y).toFixed(3)).join(' ')}`);
}
