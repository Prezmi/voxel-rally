// Headless steering probe: drives the real Vehicle on flat ground and reports
// yaw rate, lateral accel, radius, applied steer angle and settling time.
// node "tools/steer-probe.mjs"
import { Vehicle } from '../src/car/vehicle.js';
import { SURF } from '../src/world/surfaces.js';

const DT = 1 / 120;
class FlatWorld {
  constructor(id) { this.surfaceId = id; this.rutDepth = 0; }
  groundHeight() { return 0; }
  surfaceAt() { return this.surfaceId; }
  rutAt() { return 0; }
  addRut() { return false; }
  breakLooseBlock() { return false; }
  columnTopAt() { return 0; }
}

function run(surfaceId, kph, steerFrac) {
  const v0 = kph / 3.6;
  const car = new Vehicle('P', new FlatWorld(surfaceId),
    { setup: {}, assists: { abs: false, tc: false, counterSteer: false, autoShift: true } });
  car.placeAt(0, 0, 0);
  car.body.vel.x = v0;
  car.wheels.forEach((w) => { w.omega = v0 / w.rEff; });
  const zero = { throttle: 0, brake: 0, steer: 0, handbrake: 0, shiftUp: 0, shiftDown: 0 };
  for (let i = 0; i < 120; i++) { car.setInput(zero); car.step(DT); }   // settle suspension
  const v1 = car.body.groundSpeed;
  const f0 = { x: car.body.forward.x, z: car.body.forward.z };
  const r0 = { x: car.body.right.x, z: car.body.right.z };

  const N = Math.round(3 / DT);
  const yaws = [];
  let settle = NaN, sample = 0, ss = 0;
  const hist = [];
  for (let i = 0; i < N; i++) {
    car.setInput({ throttle: 0, brake: 0, steer: steerFrac, handbrake: 0, shiftUp: 0, shiftDown: 0 });
    car.step(DT);
    hist.push(car.body.angVel.y);
  }
  // steady state = mean of the last 0.5 s
  const tail = hist.slice(Math.round(0.5 / DT));
  const yawSS = tail.reduce((a, b) => a + b, 0) / tail.length;
  // settling: first t after which |yaw - yawSS| stays < 10 % of yawSS
  const band = 0.1 * Math.abs(yawSS);
  for (let i = hist.length - 1; i >= 0; i--) {
    if (Math.abs(hist[i] - yawSS) > band) { settle = (hist.length - 1 - i) * DT; break; }
  }
  const dtail = tail.length;
  // radius from the yaw rate and the speed at the end
  const vEnd = car.body.groundSpeed;
  const radius = Math.abs(yawSS) > 1e-3 ? vEnd / Math.abs(yawSS) : Infinity;
  // lateral accel measured in the body frame
  const lat = vEnd * yawSS;
  return {
    surface: surfaceId, kph, steer: steerFrac,
    yawDps: yawSS * 180 / Math.PI,
    latG: lat / 9.81,
    radius,
    steerDeg: car.steerAngle * 180 / Math.PI,
    settle, vEnd: vEnd * 3.6,
  };
}

const rows = [];
for (const s of [SURF.GRAVEL, SURF.ASPHALT]) {
  for (const kph of [20, 40, 60, 90, 120]) {
    for (const st of [0.3, 0.9, -0.3, -0.9]) rows.push(run(s, kph, st));
  }
}
console.log('surf  kph  steer%  yaw(deg/s)  latA(g)  R(m)   steerApp(deg)  settle(s)  vEnd(kph)');
for (const r of rows) {
  console.log(`${String(r.surface).padEnd(7)} ${String(r.kph).padStart(3)}  ${String(Math.round(r.steer * 100)).padStart(5)}  ${r.yawDps.toFixed(2).padStart(9)}  ${r.latG.toFixed(3).padStart(7)}  ${Number.isFinite(r.radius) ? r.radius.toFixed(1).padStart(6) : '   inf'}  ${r.steerDeg.toFixed(2).padStart(12)}  ${Number.isNaN(r.settle) ? '   n/a' : r.settle.toFixed(2).padStart(8)}  ${r.vEnd.toFixed(1)}`);
}
// launch gear
const car = new Vehicle('L', new FlatWorld(SURF.GRAVEL), { setup: {} });
car.placeAt(0, 0, 0);
let first = null, seq = [];
for (let i = 0; i < 300; i++) {
  car.setInput({ throttle: 1, brake: 0, steer: 0, handbrake: 0, shiftUp: 0, shiftDown: 0 });
  car.step(DT);
  if (first === null) first = car.powertrain.displayGear;
  if (i % 30 === 0) seq.push(car.powertrain.gearLabel);
}
console.log(`launch: initial displayGear=${first} gear@0.0/0.25/0.5/1.0/1.5/2.0s=${seq.join(',')}`);
