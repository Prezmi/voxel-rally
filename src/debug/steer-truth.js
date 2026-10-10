// Ground truth for the steer sign: which sign of input.steer turns the car LEFT?
// Builds the vehicle exactly like src/debug/tests.js (makeCar + FlatWorld).
import { Vehicle } from '../car/vehicle.js';
import { SURF } from '../world/surfaces.js';
import { DT } from '../core/time.js';
import { yawOf } from '../core/math3.js';

class FlatWorld {
  constructor(id) { this.surfaceId = id; this.rutDepth = 0; }
  groundHeight() { return 0; }
  surfaceAt() { return this.surfaceId; }
  rutAt() { return this.rutDepth; }
  addRut() { return false; }
  breakLooseBlock() { return false; }
  columnTopAt(x) { return Math.floor(this.groundHeight(x)); }
}

export function runSteer(steer, seconds = 2) {
  const car = new Vehicle('A', new FlatWorld(SURF.ASPHALT),
    { setup: {}, assists: { abs: false, tc: false, counterSteer: false, autoShift: true } });
  car.placeAt(0, 0, 0);
  car.body.vel.x = 60 / 3.6;                       // ~17 m/s forward at yaw 0
  car.wheels.forEach((w) => { w.omega = (60 / 3.6) / w.rEff; });
  const b0 = car.body;
  const p0 = { x: b0.pos.x, z: b0.pos.z };
  const r0 = { x: b0.right.x, z: b0.right.z };     // body-right (local +Z)
  const yaw0 = yawOf(b0.m);
  for (let i = 0; i < Math.round(seconds / DT); i++) {
    car.setInput({ throttle: 0.25, brake: 0, steer, handbrake: 0, shiftUp: 0, shiftDown: 0 });
    car.step(DT);
  }
  const dx = car.body.pos.x - p0.x, dz = car.body.pos.z - p0.z;
  const lateral = dx * r0.x + dz * r0.z;           // + = displaced RIGHT
  return { steer, yawDelta: yawOf(car.body.m) - yaw0, lateral };
}

if (process.argv[1] && process.argv[1].endsWith('steer-truth.js')) {
  for (const s of [1, -1]) {
    const r = runSteer(s);
    console.log(`steer=${s > 0 ? '+1' : '-1'} yawDelta=${r.yawDelta.toFixed(3)} rad lateral=${r.lateral.toFixed(3)} m -> car turned ${r.lateral < 0 ? 'LEFT' : 'RIGHT'}`);
  }
}
