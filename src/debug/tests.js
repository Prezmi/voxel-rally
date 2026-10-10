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
import { buildAssetBody, tyreScale, BODY_PARTS, WHEEL_NODES } from '../render/car-asset.js';
import { PANEL_COUNT } from '../dirt/panel-dirt.js';
import { makeTerrain } from '../world/terrain-gen.js';
import { buildRoad } from '../world/road-spline.js';
import { solveGhost } from '../game/ghost.js';
import { planGates } from '../game/stage.js';
import { buildPaceNotes, selectNotes } from '../game/pace-notes.js';
import { signWord, bendKind } from '../game/sign-board.js';
import { Input } from '../game/input.js';

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

// ---------------------------------------------------------------- test 10
// The asset car (assets/models/rally_v2.glb) must keep the render contract of
// the procedural body: aPanel per vertex + non-empty named damage ranges
// (render/carMesh.js dirt, livery and damage all read them). Headless, so the
// glTF nodes are stand-ins with the same duck-typed geometry interface.
class FakeAttr {
  constructor(array, itemSize) { this.array = array; this.itemSize = itemSize; this.count = array.length / itemSize; }
}
function fakeGeo(quads) {
  const pos = [], nor = [], idx = [];
  for (const qd of quads) {
    const off = pos.length / 3;
    for (const c of qd.c) pos.push(c[0], c[1], c[2]);
    for (let i = 0; i < qd.c.length; i++) nor.push(qd.n[0], qd.n[1], qd.n[2]);
    idx.push(off, off + 1, off + 2, off, off + 2, off + 3);
  }
  return {
    index: { array: idx, count: idx.length }, groups: null,
    getAttribute(name) {
      if (name === 'position') return new FakeAttr(pos, 3);
      if (name === 'normal') return new FakeAttr(nor, 3);
      return null;
    },
  };
}

function fakeNodes() {
  // Asset frame: ground y = 0, nose +2.1, tail -2.2, width +-0.98.
  const top = (x0, x1, z0, z1, y) => ({ c: [[x0, y, z0], [x1, y, z0], [x1, y, z1], [x0, y, z1]], n: [0, 1, 0] });
  const bot = (x0, x1, z0, z1, y) => ({ c: [[x0, y, z0], [x1, y, z0], [x1, y, z1], [x0, y, z1]], n: [0, -1, 0] });
  const side = (z, x0, x1, y0, y1) => ({ c: [[x0, y0, z], [x1, y0, z], [x1, y1, z], [x0, y1, z]], n: [0, 0, z > 0 ? 1 : -1] });
  const spec = {
    car_body: [top(1.0, 1.6, -0.6, 0.6, 1.0), side(0.9, -0.4, 0.6, 0.35, 0.85), bot(-1.0, 1.0, -0.5, 0.5, 0.1)],
    car_fender: [side(0.95, 0.9, 1.7, 0.3, 0.7), side(-0.95, -1.7, -0.9, 0.3, 0.7)],
    car_panel: [top(-0.6, 0.4, -0.5, 0.5, 1.43), side(0.85, -0.4, 0.4, 1.0, 1.3)],
    car_lamps: [side(-0.5, 1.8, 1.9, 0.5, 0.7), side(0.5, 1.8, 1.9, 0.5, 0.7)],
    car_fascia: [side(0.6, 1.9, 2.1, 0.4, 0.8)],
    car_grille: [side(0.0, 1.9, 2.0, 0.5, 0.7)],
    car_splitter: [top(1.7, 2.1, -0.8, 0.8, 0.35)],
    car_snorkel: [side(-0.9, 0.7, 1.5, 0.8, 1.05)],
    car_spoiler: [top(-2.2, -1.4, -0.9, 0.9, 1.2)],
    car_rear: [side(-0.9, -2.1, -2.0, 0.4, 0.7)],
    car_diffuser: [top(-1.8, -1.1, -0.05, 0.05, 0.3)],
    car_flap: [side(0.9, -0.8, -0.6, 0.2, 0.4)],
  };
  const nodes = new Map();
  for (const name of BODY_PARTS) nodes.set(name, { geometry: fakeGeo(spec[name]), material: null, node: { name } });
  for (const n of WHEEL_NODES) nodes.set(n, { geometry: wheelGeo(), material: null, node: { name: n } });
  return nodes;
}
function wheelGeo() {
  const pos = [], nor = [], r = 0.35;
  for (let k = 0; k < 8; k++) {
    const a = (k / 8) * Math.PI * 2, b = ((k + 1) / 8) * Math.PI * 2;
    pos.push(Math.cos(a) * r, Math.sin(a) * r, -0.17, Math.cos(b) * r, Math.sin(b) * r, -0.17,
      Math.cos(b) * r, Math.sin(b) * r, 0.17, Math.cos(a) * r, Math.sin(a) * r, 0.17);
    for (let i = 0; i < 4; i++) nor.push(Math.cos(a), Math.sin(a), 0);
  }
  const idx = [];
  for (let q = 0; q < 8; q++) { const o = q * 4; idx.push(o, o + 1, o + 2, o, o + 2, o + 3); }
  return {
    index: { array: idx, count: idx.length }, groups: null,
    getAttribute(name) {
      if (name === 'position') return new FakeAttr(pos, 3);
      if (name === 'normal') return new FakeAttr(nor, 3);
      return null;
    },
  };
}

function testCarAsset() {
  const w = new FlatWorld(SURF.DIRT);
  const params = makeCar(w, {}).params;
  const nodes = fakeNodes();
  const built = buildAssetBody(nodes, params);
  const need = ['hood', 'flank', 'rear', 'roof', 'glass', 'front', 'under'];
  const haveRegions = need.filter((r) => built.ranges[r] && built.ranges[r][1] > built.ranges[r][0]);
  let panels = new Set(), contiguous = true, covered = 0;
  for (let i = 0; i < built.aPanel.length; i++) panels.add(built.aPanel[i]);
  for (const k in built.ranges) {
    const r = built.ranges[k];
    if (r[0] >= r[1] || r[1] > built.count) contiguous = false;
    covered += r[1] - r[0];
  }
  const ty = tyreScale(nodes, TYRE_BASE.r, WHEEL_NODES[0]);
  let minY = Infinity;
  for (let i = 1; i < built.position.length; i += 3) if (built.position[i] < minY) minY = Math.min(minY, built.position[i]);
  const ok = built.tris > 0 && built.missing.length === 0
    && !!built.aPanel && built.aPanel.length === built.count
    && panels.size >= 4 && [...panels].every((p) => p >= 0 && p < PANEL_COUNT)
    && haveRegions.length === need.length && contiguous && covered === built.count
    && Math.abs(ty * 0.35 - TYRE_BASE.r) < 1e-6 && Math.abs(minY - (-params.comY)) < 1e-4;
  check('T10 asset car keeps aPanel + damage ranges', ok,
    `tris=${built.tris} verts=${built.count} panels=${panels.size} regions=[${Object.keys(built.ranges).join(',')}] fit=${built.scale.toFixed(3)} tyreScale=${ty.toFixed(3)} groundY=${minY.toFixed(3)}`);
}

// ---------------------------------------------------------------- test 11
// HUD note cursor: at any sampled arc at most ONE board is active (plus the small
// preview), and every shown note's direction + Polish word (LEWO/PRAWO) match the
// direction the road spline actually makes at that corner.
function testPaceNoteDisplay() {
  const SEED = 12345, LEN = 4200;
  const terrain = makeTerrain(SEED, 'FOREST');
  const road = buildRoad({ seed: SEED, lengthTarget: LEN, terrainHeightAt: terrain.heightAt, biome: 'FOREST' });
  const ghost = solveGhost(road, { seed: SEED, gates: planGates(road, SEED), carId: 'A' });
  const notes = buildPaceNotes(road, ghost).notes;
  let maxActive = 0, maxBoards = 0, dirMismatch = 0, wordMismatch = 0, glyphMismatch = 0, sampled = 0;
  for (let arc = 0; arc < road.length; arc += 20) {
    const sel = selectNotes(notes, arc, 22);              // 22 m/s ~ 80 km/h
    const nAct = sel.active ? 1 : 0;
    maxActive = Math.max(maxActive, nAct);
    maxBoards = Math.max(maxBoards, nAct + (sel.preview ? 1 : 0));
    for (const n of [sel.active, sel.preview]) {
      if (!n || n.kind !== 'corner') continue;
      sampled++;
      const i = road.indexAt(n.apexArc);
      let turn = 0;
      for (let j = Math.max(0, i - 6); j <= Math.min(road.n - 1, i + 6); j++) turn += road.kappa[j];
      if (Math.abs(turn) > 1e-3 && (turn > 0 ? 'R' : 'L') !== n.dir) dirMismatch++;
      const word = signWord(n);
      if ((n.dir === 'L') !== word.includes('LEWO') || (n.dir === 'R') !== word.includes('PRAWO')) wordMismatch++;
      const kind = bendKind(n.severity, n.hairpin, n.dir);
      if (!kind.endsWith(n.dir === 'L' ? 'Left' : 'Right')) glyphMismatch++;
    }
  }
  const ok = maxActive <= 1 && maxBoards <= 2 && dirMismatch === 0 && wordMismatch === 0 && glyphMismatch === 0 && sampled > 40;
  check('T11 one active pace note + direction matches the spline', ok,
    `maxActive=${maxActive} (want <=1) maxBoards=${maxBoards} (want <=2) dirMismatch=${dirMismatch} wordMismatch=${wordMismatch} glyphMismatch=${glyphMismatch} samples=${sampled}`);
}

const only = process.argv[2] ? Number(process.argv[2]) : 0;
const all = [test1, test2, test3, test4, test5, test6, test7, testCarAsset, testPaceNoteDisplay];
if (!only) {
  for (const t of all) t();
  testSurfaces();
  testStageLoad();
} else {
  all[only - 1]();
}

// ---------------------------------------------------------------- touch controls
// The touch layer has to hand the car exactly the action state the keyboard and
// a pad hand it, so no consumer downstream learns where an action came from.
function testTouch() {
  const input = new Input();
  input.touch.enabled = true;              // DOM overlay off, state machine on
  const settle = () => { for (let k = 0; k < 60; k++) input.sample(DT); };

  input.touch.setAction('steerLeft', true);
  input.touch.setAction('throttle', true);
  settle();
  check('touch: left steer + throttle held together',
    input.state.steer === -1 && input.state.throttle === 1 && input.state.brake === 0,
    `steer=${input.state.steer} throttle=${input.state.throttle}`);

  input.touch.setAction('steerLeft', true);          // a second finger, same side
  settle();
  check('touch: two fingers one side stay at one unit of lock',
    input.state.steer === -1, `steer=${input.state.steer}`);

  input.touch.setAction('steerLeft', false);
  input.touch.setAction('steerRight', true);
  settle();
  check('touch: steer follows the live finger',
    input.state.steer === 1 && input.state.throttle === 1, `steer=${input.state.steer}`);

  input.touch.setAction('steerRight', false);
  input.touch.setAction('throttle', false);
  settle();
  check('touch: lifting every finger clears every action',
    input.state.steer === 0 && input.state.throttle === 0 && input.state.handbrake === 0,
    `throttle=${input.state.throttle}`);

  input.touch.setAction('brake', true);
  input.touch.setAction('handbrake', true);
  settle();
  check('touch: brake and handbrake stay separate',
    input.state.brake === 1 && input.state.handbrake === 1 && input.state.throttle === 0,
    `brake=${input.state.brake} hand=${input.state.handbrake}`);
  input.touch.setAction('brake', false);
  input.touch.setAction('handbrake', false);

  let got = null;
  input.on((code) => { got = code; });
  input.touch.tap('camera'); settle();
  const cam = got === 'KeyC';
  input.touch.tap('restart'); settle();
  check('touch: camera/restart taps reuse the keyboard consumer path',
    cam && got === 'KeyR', `cam=${cam} restart=${got}`);

  input.down.add('throttle');                        // keyboard path untouched
  settle();
  check('touch layer leaves the keyboard path working', input.state.throttle === 1,
    `throttle=${input.state.throttle}`);

  // and the car really drives off the touch state
  const w = new FlatWorld(SURF.ASPHALT);
  const car = makeCar(w, { bias: 0.55 });
  car.placeAt(0, 0, 0);
  input.touch.setAction('throttle', true);
  for (let i = 0; i < Math.round(1.5 / DT); i++) { input.sample(DT); car.setInput(input.state); car.step(DT); }
  check('touch: the car accelerates from the touch state', car.body.vel.x > 10, `vx=${car.body.vel.x.toFixed(1)}`);
}
testTouch();

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) process.exitCode = 1;

export { results, arcRun, test1, test2, test3, test4, test5, test6, test7, testCarAsset, testPaceNoteDisplay };
