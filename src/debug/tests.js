// Physics regression tests (docs/02 §11) + determinism.
// Runs headless in Node: the sim has no renderer/DOM dependency (physics-tuning
// skill: "extract the physics from the renderer first").
//
//   node src/debug/tests.js            all
//   node src/debug/tests.js 3          only test 3
import { Vehicle } from '../car/vehicle.js';
import { VoxelWorld } from '../world/chunk.js';
import { SURF, SURFACES, surface } from '../world/surfaces.js';
import { TYRE_BASE } from '../car/car-params.js';
import { DT } from '../core/time.js';

const G = 9.81;

/** Controlled synthetic terrain so a test measures the tyre, not the map. */
class FlatWorld {
  constructor(surfaceId, opts = {}) {
    this.surfaceId = surfaceId;
    this.bumps = opts.bumps || null;
    this.rutDepth = 0;
  }
  groundHeight(x, z) {
    let h = 0;
    if (this.bumps) {
      const k = 2 * Math.PI / this.bumps.wavelength;
      h = this.bumps.amp * Math.sin(x * k) * (0.6 + 0.4 * Math.cos(z * 0.35));
    }
    return h;
  }
  surfaceAt() { return this.surfaceId; }
  rutAt() { return this.rutDepth; }
  addRut() { return false; }
  breakLooseBlock() { return false; }
  columnTopAt(x, z) { return Math.floor(this.groundHeight(x, z)); }
}

function makeCar(world, setup) {
  const car = new Vehicle('A', world, { setup, assists: { abs: false, tc: false, counterSteer: false, autoShift: true } });
  return car;
}

function drive(car, input, seconds, onStep) {
  const steps = Math.round(seconds / DT);
  for (let i = 0; i < steps; i++) {
    car.setInput(input);
    car.step(DT);
    if (onStep) onStep(car, i);
  }
}

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}  ${detail}`);
}

// ---------------------------------------------------------------- test 1
function test1() {
  const w = new FlatWorld(SURF.ASPHALT);
  const car = makeCar(w, { bias: 0.55 });
  car.placeAt(0, 0, 0);
  car.body.vel.x = 160 / 3.6;
  car.wheels.forEach((wh) => { wh.omega = (160 / 3.6) / wh.rEff; });

  let dist = 0, t = 0, locked = false, maxKappa = 0;
  const x0 = car.body.pos.x;
  for (let i = 0; i < 120 * 12; i++) {
    car.setInput({ throttle: 0, brake: 1, steer: 0, handbrake: 0, shiftUp: 0, shiftDown: 0 });
    car.step(DT);
    t += DT;
    maxKappa = Math.max(maxKappa, Math.abs(car.wheels[0].kappa), Math.abs(car.wheels[2].kappa));
    // Lock is only a fault while the car is still fast; a full stop without ABS
    // always ends with the wheels locked.
    if (car.body.groundSpeed > 15 && Math.abs(car.wheels[0].kappa) > 0.95) locked = true;
    if (car.body.groundSpeed < 0.6) break;
  }
  dist = Math.abs(car.body.pos.x - x0);
  const ok = dist >= 78 && dist <= 92 && !locked;
  check('T1 braking 160->0 (asphalt, bias 55%)', ok,
    `dist=${dist.toFixed(1)} m (want 78-92) time=${t.toFixed(2)} s maxKappa=${maxKappa.toFixed(2)} lockedAbove15kph=${locked}`);
  return { dist, t };
}

// ---------------------------------------------------------------- test 2
// docs/02 §11 test 2 is implemented as "can the car hold a 60 m arc at this
// speed", which needs a closed-loop driver: with a fixed steering angle the car
// simply changes radius instead of saturating the tyres.
//
// NOTE (deviation from docs/02 §11): the doc's target of 41-46 m/s on a 60 m arc
// implies 2.9 g, which no tyre in the docs' own surface table (asphalt mu 1.18)
// can produce. The physical limit is sqrt(mu_eff * g * R) = 27.4 m/s on asphalt
// and 22.6 m/s on gravel, so the assertion is made against that.
function arcRun(surfaceId, speed, R, opts = {}) {
  const handbrake = opts.handbrake || 0;
  const hbStart = opts.hbStart || 0;
  const hbDur = opts.hbDur || 0.6;
  const throttle = opts.throttle || 0;
  const seconds = opts.seconds || 6;
  const w = new FlatWorld(surfaceId);
  const car = makeCar(w, {});
  if (opts.gain) car.params.handbrakeGain = opts.gain;
  car.placeAt(0, 0, 0);
  car.body.vel.x = speed;
  car.wheels.forEach((wh) => { wh.omega = speed / wh.rEff; });

  // Arc: centre at (0, -R), car starts at the origin heading +X and curves left.
  const cx = 0, cz = -R;
  const L = car.params.wheelbase;
  const maxSteer = car.params.steerMax;

  let maxUtil = 0, maxAlpha = 0, maxBodySlip = 0, crossTrack = 0, minR = Infinity;
  let recovery = -1;
  let steerCmd = 0;
  const steps = Math.round(seconds / DT);
  for (let i = 0; i < steps; i++) {
    const t = i * DT;
    // Pure-pursuit: aim at the point `look` metres of arc ahead. The lookahead
    // tracks speed (a fixed one turns the follower into an oscillator once the car
    // scrubs speed) and the command is rate-limited like a real driver.
    const px = car.body.pos.x, pz = car.body.pos.z;
    const sp0 = Math.hypot(car.body.vel.x, car.body.vel.z);
    const look = Math.max(14, sp0 * 1.15);
    const th = Math.atan2(pz - cz, px - cx) - look / R;
    const tx = cx + R * Math.cos(th), tz = cz + R * Math.sin(th);
    const fwd = car.body.forward;
    const heading = Math.atan2(fwd.z, fwd.x);
    const want = Math.atan2(tz - pz, tx - px);
    let dAng = want - heading;
    while (dAng > Math.PI) dAng -= 2 * Math.PI;
    while (dAng < -Math.PI) dAng += 2 * Math.PI;
    // World X/Z uses +Z = right, while the steering convention is positive = left,
    // so the planar angle from atan2 must be negated.
    const cmd = -Math.atan((2 * L * Math.sin(dAng)) / look) / maxSteer;
    steerCmd += (cmd - steerCmd) * Math.min(1, 12 * DT);
    const s = Math.max(-1, Math.min(1, steerCmd));

    car.setInput({ throttle, brake: 0, steer: s, handbrake: (t >= hbStart && t < hbStart + hbDur) ? handbrake : 0, shiftUp: 0, shiftDown: 0 });
    car.step(DT);
    for (const wh of car.wheels) {
      const cap = wh.muEff * wh.N;
      if (cap > 1) maxUtil = Math.max(maxUtil, Math.hypot(wh.Flon, wh.Flat) / cap);
      maxAlpha = Math.max(maxAlpha, Math.abs(wh.alpha));
    }
    const v = car.body.vel, sp = Math.hypot(v.x, v.z);
    crossTrack = Math.max(crossTrack, Math.abs(Math.hypot(car.body.pos.x - cx, car.body.pos.z - cz) - R));
    if (sp > 1) {
      const dot = (fwd.x * v.x + fwd.z * v.z) / (sp * Math.hypot(fwd.x, fwd.z) || 1);
      maxBodySlip = Math.max(maxBodySlip, Math.acos(Math.max(-1, Math.min(1, dot))));
      const omegaY = car.body.angVel.y;
      if (Math.abs(omegaY) > 1e-3) minR = Math.min(minR, sp / Math.abs(omegaY));
      const slipNow = Math.acos(Math.max(-1, Math.min(1, dot)));
      if (t > hbStart + hbDur && recovery < 0 && slipNow < 5 * Math.PI / 180) recovery = t - (hbStart + hbDur);
    }
  }
  return { maxUtil, maxAlpha, maxBodySlip, minR, crossTrack, recovery, endSpeed: car.body.groundSpeed };
}

function test2() {
  const R = 60;
  const holds = (surfId, speed) => {
    const r = arcRun(surfId, speed, R, { seconds: 5 });
    return r.crossTrack < 5 && r.maxBodySlip < 40 * Math.PI / 180 && r.endSpeed > speed * 0.6;
  };
  const findMax = (surfId) => {
    let lo = 8, hi = 45;
    for (let it = 0; it < 12; it++) {
      const mid = (lo + hi) / 2;
      if (holds(surfId, mid)) lo = mid; else hi = mid;
    }
    return lo;
  };
  const asphalt = findMax(SURF.ASPHALT);
  const gravel = findMax(SURF.GRAVEL);
  const theo = (id) => Math.sqrt(surface(id).mu * TYRE_BASE.gain * 9.81 * R);
  const okA = asphalt >= 0.75 * theo(SURF.ASPHALT) && asphalt <= 1.1 * theo(SURF.ASPHALT);
  const okG = gravel >= 0.75 * theo(SURF.GRAVEL) && gravel <= 1.1 * theo(SURF.GRAVEL);
  const ok = okA && okG && asphalt > gravel;
  check('T2 steady arc R=60 m max grip speed', ok,
    `asphalt=${asphalt.toFixed(1)} m/s (limit ${theo(SURF.ASPHALT).toFixed(1)}) gravel=${gravel.toFixed(1)} m/s (limit ${theo(SURF.GRAVEL).toFixed(1)}) ratio=${(asphalt / gravel).toFixed(2)}`);
  return { asphalt, gravel };
}

// ---------------------------------------------------------------- test 3
function test3() {
  const R = 60;
  const r = arcRun(SURF.GRAVEL, 16, R, { handbrake: 1, hbStart: 2.0, hbDur: 0.5, throttle: 0.4, seconds: 6 });
  const deg = r.maxBodySlip * 180 / Math.PI;
  const ok = deg >= 12 && deg <= 22 && r.recovery >= 0 && r.recovery < 1.2;
  check('T3 gravel arc + handbrake rear throw', ok,
    `maxBodySlip=${deg.toFixed(1)} deg (want 12-22) recovery=${r.recovery < 0 ? 'never' : r.recovery.toFixed(2) + ' s'} (want <1.2)`);
}

// ---------------------------------------------------------------- test 4
function launchTime(surfaceId) {
  const w = new FlatWorld(surfaceId);
  const car = makeCar(w, {});
  car.placeAt(0, 0, 0);
  let t = 0;
  const steps = Math.round(14 / DT);
  for (let i = 0; i < steps; i++) {
    car.setInput({ throttle: 1, brake: 0, steer: 0, handbrake: 0, shiftUp: 0, shiftDown: 0 });
    car.step(DT);
    t += DT;
    if (car.body.groundSpeed >= 60 / 3.6) return t;
  }
  return Infinity;
}

function test4() {
  const mud = launchTime(SURF.MUD);
  const asphalt = launchTime(SURF.ASPHALT);
  const ok = mud >= 4.5 && asphalt <= 2.6;
  check('T4 launch to 60 km/h: mud vs asphalt', ok,
    `mud=${mud.toFixed(2)} s (want >=4.5) asphalt=${asphalt.toFixed(2)} s (want <=2.6)`);
}

// ---------------------------------------------------------------- test 5
function test5() {
  const w = new FlatWorld(SURF.GRAVEL, { bumps: { amp: 0.09, wavelength: 5.0 } });
  const car = makeCar(w, {});
  car.placeAt(0, 0, 0, w.groundHeight(0, 0));
  car.body.vel.x = 25;
  car.wheels.forEach((wh) => { wh.omega = 25 / wh.rEff; });
  const airborne = [0, 0, 0, 0];
  let anyAir = 0, maxAirborne = 0;
  const steps = Math.round(10 / DT);
  for (let i = 0; i < steps; i++) {
    car.setInput({ throttle: 0.7, brake: 0, steer: 0, handbrake: 0, shiftUp: 0, shiftDown: 0 });
    car.step(DT);
    let a = 0;
    for (let k = 0; k < 4; k++) if (car.wheels[k].airborneFrames > 0) { airborne[k]++; a++; }
    if (a > 0) anyAir++;
    maxAirborne = Math.max(maxAirborne, a);
  }
  const pct = anyAir / steps;
  const ok = pct >= 0.25 && car.body.groundSpeed > 10;
  check('T5 bumps: wheel hop and recovery', ok,
    `airborneFrames=${airborne.join('/')} anyAir=${(pct * 100).toFixed(0)}% (want >=25%) endSpeed=${car.body.groundSpeed.toFixed(1)} m/s`);
}

// ---------------------------------------------------------------- test 6
function test6() {
  const runOnce = () => {
    const w = new FlatWorld(SURF.ASPHALT);
    const car = makeCar(w, { bias: 0.55 });
    car.placeAt(0, 0, 0);
    car.body.vel.x = 140 / 3.6;
    car.wheels.forEach((wh) => { wh.omega = (140 / 3.6) / wh.rEff; });
    let t = 0;
    for (let i = 0; i < 120 * 12; i++) {
      car.setInput({ throttle: 0.6, brake: 0.8, steer: Math.sin(i * 0.01) * 0.2, handbrake: 0, shiftUp: 0, shiftDown: 0 });
      car.step(DT);
      t += DT;
      if (car.body.groundSpeed < 0.5) break;
    }
    return { t, x: car.body.pos.x, z: car.body.pos.z };
  };
  const a = runOnce(), b = runOnce();
  const dt = Math.abs(a.t - b.t);
  const dp = Math.hypot(a.x - b.x, a.z - b.z);
  const ok = dt <= 0.02 && dp < 0.5;
  check('T6 determinism (identical input -> identical result)', ok,
    `dt=${dt.toFixed(4)} s (want <=0.02) dpos=${dp.toFixed(4)} m`);
}

// ---------------------------------------------------------------- test 7
function test7() {
  const w = new FlatWorld(SURF.ASPHALT);
  const car = makeCar(w, {});
  car.placeAt(0, 0, 0);
  car.body.vel.x = 120 / 3.6;
  car.wheels.forEach((wh) => { wh.omega = (120 / 3.6) / wh.rEff; });
  let maxAng = 0;
  const N = [];
  for (let i = 0; i < Math.round(10 / DT); i++) {
    car.setInput({ throttle: 0.55, brake: 0, steer: 0, handbrake: 0, shiftUp: 0, shiftDown: 0 });
    car.step(DT);
    maxAng = Math.max(maxAng, Math.hypot(car.body.angVel.x, car.body.angVel.y, car.body.angVel.z));
    N.push(car.wheels[0].N);
  }
  // Dominant frequency of N via zero crossings about the mean.
  const mean = N.reduce((s, v) => s + v, 0) / N.length;
  let crossings = 0;
  for (let i = 1; i < N.length; i++) {
    const a = N[i - 1] - mean, b = N[i] - mean;
    if ((a < 0 && b >= 0) || (a > 0 && b <= 0)) crossings++;
  }
  const freq = crossings / 2 / (N.length * DT);
  const ok = maxAng < 0.6 && freq <= 8;
  check('T7 no oscillation at 120 km/h straight', ok,
    `maxAngVel=${maxAng.toFixed(3)} rad/s (want <0.6) N_oscillation=${freq.toFixed(1)} Hz (want <=8)`);
}

// ---------------------------------------------------------------- extra: surfaces differ
function testSurfaces() {
  const rows = [];
  for (const s of SURFACES) {
    if (s.key === 'unknown') continue;
    const w = new FlatWorld(s.id);
    const car = makeCar(w, {});
    car.placeAt(0, 0, 0);
    car.body.vel.x = 30;
    car.wheels.forEach((wh) => { wh.omega = 30 / wh.rEff; });
    let dist = 0;
    const x0 = car.body.pos.x;
    for (let i = 0; i < Math.round(6 / DT); i++) {
      car.setInput({ throttle: 0, brake: 1, steer: 0, handbrake: 0, shiftUp: 0, shiftDown: 0 });
      car.step(DT);
      if (car.body.groundSpeed < 0.5) break;
    }
    dist = Math.abs(car.body.pos.x - x0);
    rows.push(`${s.key.padEnd(8)} ${dist.toFixed(1)} m from 108 km/h`);
  }
  check('T8 surface braking spread (informational)', true, '\n    ' + rows.join('\n    '));
}

// ---------------------------------------------------------------- extra: real stage loads
function testStageLoad() {
  const seed = 4242;
  const world = new VoxelWorld(seed);
  const t0 = Date.now();
  const c = new Vehicle('A', world, {});
  // tiny synthetic voxel patch so this stays a unit test
  for (let cz = -1; cz <= 1; cz++) for (let cx = -1; cx <= 1; cx++) {
    const ch = world.ensureChunk(cx, cz);
    for (let lz = 0; lz < 16; lz++) for (let lx = 0; lx < 16; lx++) {
      const col = lz * 16 + lx;
      for (let y = 0; y <= 20; y++) ch.blocks[col * 96 + y] = 3;
      ch.height[col] = 20; ch.surface[col] = 2;
    }
  }
  c.placeAt(0, 0, 0, 21);
  c.body.vel.x = 20;
  c.wheels.forEach((wh) => { wh.omega = 20 / wh.rEff; });
  const t1 = Date.now();
  for (let i = 0; i < 1200; i++) {
    c.setInput({ throttle: 0.7, brake: 0, steer: 0.15, handbrake: 0, shiftUp: 0, shiftDown: 0 });
    c.step(DT);
  }
  const ms = (Date.now() - t1) / 1200;
  check('T9 sim cost per 1/120 step on voxel terrain', ms <= 4, `sim=${ms.toFixed(3)} ms/step (budget <=4) setup=${Date.now() - t0} ms`);
}

const only = process.argv[2] ? Number(process.argv[2]) : 0;
const all = [test1, test2, test3, test4, test5, test6, test7];
if (!only) {
  for (const t of all) t();
  testSurfaces();
  testStageLoad();
} else {
  all[only - 1]();
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) process.exitCode = 1;

export { results, arcRun, test1, test2, test3, test4, test5, test6, test7 };
