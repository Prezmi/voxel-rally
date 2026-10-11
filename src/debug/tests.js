// Physics regression tests (docs/02 §11) + determinism.
// Runs headless in Node: the sim has no renderer/DOM dependency (physics-tuning
// skill: "extract the physics from the renderer first").
//
//   node src/debug/tests.js            all
//   node src/debug/tests.js 3          only test 3
import { Vehicle } from '../car/vehicle.js';
import { VoxelWorld } from '../world/chunk.js';
import { SURF, SURFACES, surface } from '../world/surfaces.js';
import { TYRE_BASE, CARS } from '../car/car-params.js';
import { DT, MAX_STEPS_PER_FRAME } from '../core/time.js';
import { FrameLoop } from '../core/loop.js';
import { buildAssetBody, tyreScale, BODY_PARTS, WHEEL_NODES, defaultExhaust } from '../render/car-asset.js';
import { FxSystem } from '../fx/fx.js';
import { bus } from '../core/events.js';
import { PANEL_COUNT } from '../dirt/panel-dirt.js';
import { makeTerrain } from '../world/terrain-gen.js';
import { buildRoad } from '../world/road-spline.js';
import { solveGhost, powertrainCeiling, SURFACE_VMAX, GHOST_TUNE } from '../game/ghost.js';
import { planGates, StageRun, STATE } from '../game/stage.js';
import { buildPaceNotes, selectNotes } from '../game/pace-notes.js';
import { signWord, bendKind } from '../game/sign-board.js';
import { Input } from '../game/input.js';
import { steerCurve, STEER_DEADZONE, dragToSteer, knobOffset } from '../game/touch.js';
import { settings, SETTINGS_KEY, LEGACY_SETTINGS_KEY, loadSettings, saveSettings, migrateSettings } from '../core/settings.js';
import { RallyHud } from '../game/hud-rally.js';
import { generateChunkProps, roadCorridorGap, PROP_CORRIDOR_MARGIN, PROP, PROP_NAMES, buildGateGeometry, GATE_PLANES, SPRITE_PROPS, SPRITE_SPEC, SPRITE_ATLAS, NEAR_LOD_TRIS, atlasRect, buildSpriteGeometries, buildBillboardGeometries } from '../world/props.js';
import { buildCarveIndex, prewarmArea } from '../world/road-carve.js';
import { createPaceDriver } from './pace-driver.js';
import { GeoBuilder } from '../render/primitives.js';
import { CHUNK } from '../world/chunk.js';

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
  // The ground under a loaded wheel must never fall below the terrain height it
  // stood on (the bed here is a flat column top at 21 m). `rut` is the only field
  // that could put a column below the carved height, so a driven stage has to leave
  // it at 0 everywhere, and every wheel contact stays at or above 21 m.
  let rutCols = 0, worstRut16 = 0;
  for (const ch of world.chunks.values()) {
    for (let c = 0; c < 256; c++) {
      const r = ch.rut[c];
      if (r < 0) { rutCols++; if (r < worstRut16) worstRut16 = r; }
    }
  }
  let sink = 0;
  for (const w of c.wheels) {
    const gx = Math.floor(w.contact.x), gz = Math.floor(w.contact.z);
    // groundHeight blends the four columns under (gx,gz); only judge points that are
    // fully inside the generated patch, otherwise the missing columns read as 0.
    if (world.columnTopAt(gx - 1, gz - 1) < 0 || world.columnTopAt(gx, gz - 1) < 0 ||
        world.columnTopAt(gx - 1, gz) < 0 || world.columnTopAt(gx, gz) < 0) continue;
    const bed = Math.max(world.columnTopAt(gx - 1, gz - 1), world.columnTopAt(gx, gz - 1),
      world.columnTopAt(gx - 1, gz), world.columnTopAt(gx, gz));
    sink = Math.max(sink, bed - world.groundHeight(w.contact.x, w.contact.z));
  }
  // 0.07 m tolerance = the procedural micro relief amplitude (0.06 m) groundHeight
  // adds, which is not displacement. Any rut at all, or a column below its bed, fails.
  const noSink = rutCols === 0 && sink <= 0.07;
  check('T9 sim cost per 1/120 step on voxel terrain', ms <= 4 && noSink, `sim=${ms.toFixed(3)} ms/step (budget <=4) setup=${Date.now() - t0} ms | ground under loaded wheels: rut columns=${rutCols} worst=${(worstRut16 / 16).toFixed(3)} m sink=${sink.toFixed(4)} m (budget 0)`);
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

// ---------------------------------------------------------------------------
// T21 particle FX (src/fx): the pools are hard-capped, a real gearbox upshift
// lights the backfire plume, and the fixed-step tick allocates nothing once the
// pools are warm (same buffers, flat heap).
function testFx() {
  const fx = new FxSystem({ scale: 1, bus });
  const car = makeCar(new FlatWorld(SURF.GRAVEL), {});
  fx.setLocalTips(defaultExhaust(car.params));
  fx.env.trees = 0.9; fx.env.wind = 4; fx.env.sun = 1;
  const caps = [fx.flame, fx.dust, fx.leaves, fx.motes];

  // 1) a hostile spawn storm can never pass a capacity
  for (let i = 0; i < 12000; i++) fx.flame.spawn();
  let over = 0;
  for (const P of caps) if (P.count > P.capacity) over++;
  fx.flame.count = 0;

  // 2) the gearbox's own 'shift' event must produce a non-zero flame burst
  const input = { throttle: 1, brake: 0, steer: 0, handbrake: 0, shiftUp: 0, shiftDown: 0 };
  let shifts = 0, flameMax = 0, liveMax = 0, overLive = 0;
  const off = bus.on('shift', () => { shifts++; });
  drive(car, input, 4.0, (c) => {
    fx.step(DT, c, 1);
    if (fx.flame.count > flameMax) flameMax = fx.flame.count;
    const live = fx.live();
    if (live > liveMax) liveMax = live;
    if (live > fx.maxLive) overLive++;
    for (const P of caps) if (P.count > P.capacity) over++;
  });
  off();

  // 3) steady state allocates nothing: the buffers never change and not one
  //    typed array / Array / Map / Set is constructed across 1200 fixed steps.
  const fx2 = new FxSystem({ scale: 1, bus });
  fx2.setLocalTips(defaultExhaust(car.params));
  const buf = [fx2.flame.data, fx2.dust.data, fx2.leaves.data, fx2.motes.data];
  for (let i = 0; i < 240; i++) fx2.step(DT, car, 0.9);          // warm the pools
  const h0 = process.memoryUsage().heapUsed;
  const made = countAllocations(() => { for (let i = 0; i < 1200; i++) fx2.step(DT, car, 0.9); });
  const grew = process.memoryUsage().heapUsed - h0;
  const sameBuf = buf[0] === fx2.flame.data && buf[1] === fx2.dust.data
    && buf[2] === fx2.leaves.data && buf[3] === fx2.motes.data;

  const ok = over === 0 && shifts > 0 && flameMax > 0 && overLive === 0 && sameBuf && made.n === 0;
  check('T21 fx pools stay inside capacity, a gearbox upshift lights a flame burst and the fx step allocates nothing in steady state',
    ok, `caps=${caps.map((P) => P.capacity).join('/')} liveMax=${liveMax}/${fx.maxLive} shifts=${shifts} flameMax=${flameMax} overCap=${over} allocsPer1200Steps=${made.n} heapDrift=${(grew / 1024).toFixed(1)} kB`);
}

/** Count every construction of the container types the hot path could reach. */
function countAllocations(fn) {
  const ct = { n: 0 };
  const names = ['Float32Array', 'Uint8Array', 'Int32Array', 'Array', 'Map', 'Set'];
  const saved = [];
  for (const k of names) {
    const Native = globalThis[k];
    saved.push([k, Native]);
    globalThis[k] = class extends Native { constructor(...a) { super(...a); ct.n++; } };
  }
  try { fn(); } finally { for (const [k, v] of saved) globalThis[k] = v; }
  return ct;
}

const only = process.argv[2] ? Number(process.argv[2]) : 0;
const all = [test1, test2, test3, test4, test5, test6, test7, testCarAsset, testPaceNoteDisplay, testFx];
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

  // ---- one ground truth for the steer sign, measured in the SIM ----------------
  // src/debug/steer-truth.js: steer = +1 for 2 s -> yawDelta +1.236 rad, body-right
  // displacement -15.6 m => POSITIVE steer is a LEFT turn. Every input path has to
  // land on that sign; settings.invertSteer (default false) is the ONLY place a sign
  // may be flipped, so no mapping may pre-compensate.
  const latOf = (press) => {
    const inp = new Input();
    inp.touch.enabled = true;
    const car = makeCar(new FlatWorld(SURF.ASPHALT), {});
    car.placeAt(0, 0, 0);
    car.body.vel.x = 60 / 3.6;
    car.wheels.forEach((w) => { w.omega = (60 / 3.6) / w.rEff; });
    const r0 = { x: car.body.right.x, z: car.body.right.z }, p0 = { x: car.body.pos.x, z: car.body.pos.z };
    press(inp);
    for (let k = 0; k < 120; k++) { car.setInput(inp.sample(DT)); car.step(DT); }
    const lat = (car.body.pos.x - p0.x) * r0.x + (car.body.pos.z - p0.z) * r0.z;  // + = RIGHT
    inp.touch.steerVisual = inp.state.steer;
    return { lat, knob: knobOffset(inp.touch.steerVisual, 40), steer: inp.state.steer };
  };
  const kLeft = latOf((i) => i.down.add('steerLeft'));                       // keyboard A / ArrowLeft
  const gLeft = latOf((i) => { i.down.add('steerLeft'); i.down.delete('steerRight'); }); // pad left -> same action state
  const tLeft = latOf((i) => i.touch.setAction('steerLeft', true));           // touch pad button
  const aLeft = latOf((i) => i.touch.setSteerRaw(dragToSteer(-80, 80)));      // thumb dragged left
  check('steer sign: keyboard, pad and touch left all turn the car the same way',
    kLeft.lat < 0 && gLeft.lat < 0 && tLeft.lat < 0 && aLeft.lat < 0 &&
    Math.sign(kLeft.lat) === Math.sign(tLeft.lat) && Math.sign(kLeft.lat) === Math.sign(aLeft.lat),
    `lat kb=${kLeft.lat.toFixed(1)} pad=${gLeft.lat.toFixed(1)} touch=${tLeft.lat.toFixed(1)} analog=${aLeft.lat.toFixed(1)}`);
  check('steer sign: the pad knob moves the way the car turns',
    kLeft.steer > 0 && aLeft.steer > 0 && Math.sign(kLeft.knob) === Math.sign(kLeft.lat),
    `steer=${kLeft.steer} knobPx=${kLeft.knob.toFixed(1)} lat=${kLeft.lat.toFixed(1)} (knob<0 = knob left = car left)`);

  input.touch.setAction('steerLeft', true);
  input.touch.setAction('throttle', true);
  settle();
  check('touch: left steer + throttle held together',
    input.state.steer === 1 && input.state.throttle === 1 && input.state.brake === 0,
    `steer=${input.state.steer} throttle=${input.state.throttle}`);

  input.touch.setAction('steerLeft', true);          // a second finger, same side
  settle();
  check('touch: two fingers one side stay at one unit of lock',
    input.state.steer === 1, `steer=${input.state.steer}`);

  input.touch.setAction('steerLeft', false);
  input.touch.setAction('steerRight', true);
  settle();
  check('touch: steer follows the live finger',
    input.state.steer === -1 && input.state.throttle === 1, `steer=${input.state.steer}`);

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

// ---------------------------------------------------------------- main menu
// The modal screen stack is the gate for the stage clock: boot lands on the menu,
// the countdown may only begin after START, and every screen has a way back.
// Same stub-DOM shape as tools/stagetest.mjs C (no jsdom installed).
class MenuStubEl {
  constructor(tag) {
    this.tag = tag; this.children = []; this.className = ''; this.textContent = '';
    this.style = {}; this.parentNode = null; this.attrs = {};
  }
  setAttribute(k, v) { this.attrs[k] = v; }
  addEventListener() {}
  appendChild(c) { c.parentNode = this; this.children.push(c); return c; }
}
class MenuStubDoc {
  constructor() { this.body = new MenuStubEl('body'); }
  createElement(t) { return new MenuStubEl(t); }
  getElementById() { return null; }
}

function testMenuStateMachine() {
  const SEED = 99, LEN = 900;
  const terrain = makeTerrain(SEED, 'FOREST');
  const road = buildRoad({ seed: SEED, lengthTarget: LEN, terrainHeightAt: terrain.heightAt, biome: 'FOREST' });
  const run = new StageRun({ road, gates: planGates(road, SEED), seed: SEED, refTime: 90 });
  const wheelStub = () => ({ alpha: 0, kappa: 0, N: 0, slipEnergy: 0, airborneFrames: 0 });
  const car = { body: { pos: { x: road.x[12], z: road.z[12] }, groundSpeed: 0 }, wheels: [wheelStub(), wheelStub(), wheelStub(), wheelStub()] };
  const rally = new RallyHud(new MenuStubDoc(), {
    stages: [{ key: 'FOREST', label: 'Leśny' }, { key: 'SWAMP', label: 'Bagno' }],
  });
  const c0 = run.countdown;
  const frames = (n) => {
    for (let i = 0; i < n; i++) {
      if (rally.driving()) run.step(DT, car);          // the gate main.js uses
      rally.update(DT, { car, stage: run, notes: [], stageName: 'ODCINEK LEŚNY' });
    }
  };
  const trail = [];
  rally.openMenu();
  trail.push(`boot=${rally.top()}`);
  frames(180);                                        // 3 s on the menu
  const frozen = run.countdown === c0 && run.state === STATE.PRE_START && rally.top() === 'menu';
  rally.focus = rally.rowIndex('screen:settings'); rally.activate();
  trail.push(`settings=${rally.top()}`);
  const openSettings = rally.top() === 'settings';
  const toggles = rally.rowIndex('toggle:blockTiles') >= 0 && rally.rowIndex('cycle:touchOverlay') >= 0;
  rally.focus = rally.rowIndex('back'); rally.activate();
  trail.push(`back=${rally.top()}`);
  const backToMenu = rally.top() === 'menu';
  rally.focus = rally.rowIndex('start'); rally.activate();
  trail.push(`start=${rally.top()}`);
  frames(30);
  const began = rally.driving() && run.countdown < c0 && run.state === STATE.PRE_START;
  frames(Math.round(6 / DT) + 10);                     // odliczanie + kawałek jazdy
  const running = run.state === STATE.RUNNING;
  const ok = frozen && openSettings && toggles && backToMenu && began && running;
  check('T12 menu gates the stage clock: countdown only after START', ok,
    `${trail.join(' ')} frozen=${frozen} settings=${openSettings} toggles=${toggles} back=${backToMenu} began=${began} running=${running}`);
}
testMenuStateMachine();

// -------------------------------------------------- mobile controls (phone-first)
// The thumb pad is analog: continuous steer from the thumb's displacement, a real
// dead zone, progressive near centre, and it self-centres smoothly on lift. Pedals
// may never fight. Then: the whole stage flow with FINGERS ONLY, no keyboard.
function testAnalogTouchSteering() {
  const input = new Input();
  input.touch.enabled = true;                     // DOM overlay off, state machine on
  const settle = (n = 40) => { for (let k = 0; k < n; k++) input.sample(DT); };

  // dead zone ~8%: a thumb resting slightly off centre is nothing, either side
  input.touch.setSteerRaw(0.06); settle();
  const dzPos = input.state.steer === 0;
  input.touch.setSteerRaw(-0.07); settle();
  const dzNeg = input.state.steer === 0;
  const dzOk = dzPos && dzNeg && steerCurve(0.08, STEER_DEADZONE) === 0 && steerCurve(0.09, STEER_DEADZONE) > 0;

  // progressive near centre: half travel is under half lock, monotonic, full at the rim
  const q = steerCurve(0.25), half = steerCurve(0.5), rim = steerCurve(1);
  const progressive = q > 0 && q < half && half < 0.5 && half > 0.25 && rim === 1
    && steerCurve(-0.5) === -half;

  // the value the car gets is the curve, not a step, and it holds while the thumb sits
  input.touch.setSteerRaw(0.5); settle();
  const mid = input.state.steer;
  const holds = Math.abs(mid - half) < 1e-6 && input.state.steer > 0;

  // self-centring on lift: eases back over the ramp, no step, lands exactly on 0
  input.touch.releaseSteer();
  input.sample(DT);
  const maxStep = (1000 / Math.max(20, settings.steerRampMs)) * DT * 1.5;
  const eased = Math.abs(mid - input.state.steer) <= maxStep && input.state.steer > 0;
  settle(60);
  const centred = input.state.steer === 0;

  // pedals never fight: thumb on gas, thumb on brake -> brake owns the car
  input.touch.setAction('throttle', true);
  input.touch.setAction('brake', true);
  input.touch.setAction('handbrake', true);
  settle();
  const brakeWins = input.state.brake === 1 && input.state.throttle === 0 && input.state.handbrake === 1;
  input.touch.releaseAll();

  const ok = dzOk && progressive && holds && eased && centred && brakeWins;
  check('T13 analog thumb steering: dead zone + progressive curve + self-centring, brake beats throttle',
    ok, `dz=${dzOk} curve(q=${q.toFixed(3)} half=${half.toFixed(3)} rim=${rim}) steer@half=${mid.toFixed(3)} `
      + `liftStep=${(mid - input.state.steer).toFixed(3)}<=${maxStep.toFixed(3)} eased=${eased} centred=${centred} brake=${brakeWins}`);
}
testAnalogTouchSteering();

function testTouchOnlyStageFlow() {
  const SEED = 71, LEN = 700;
  const terrain = makeTerrain(SEED, 'FOREST');
  const road = buildRoad({ seed: SEED, lengthTarget: LEN, terrainHeightAt: terrain.heightAt, biome: 'FOREST' });
  const run = new StageRun({ road, gates: planGates(road, SEED), seed: SEED, refTime: 60 });
  const wheelStub = () => ({ alpha: 0, kappa: 0, N: 0, slipEnergy: 0, airborneFrames: 0 });
  const car = { body: { pos: { x: road.x[12], z: road.z[12] }, groundSpeed: 0 }, wheels: [wheelStub(), wheelStub(), wheelStub(), wheelStub()] };
  const rally = new RallyHud(new MenuStubDoc(), { stages: [{ key: 'FOREST', label: 'Leśny' }] });
  const input = new Input();
  input.touch.enabled = true;
  const seen = { camera: 0, restart: 0 };
  let camMode = 0;
  // The consumer wiring main.js installs, minus the renderer.
  input.on((code) => {
    if (code === 'KeyC') { seen.camera++; camMode = (camMode + 1) % 4; }
    else if (code === 'KeyR') seen.restart++;
    else if (code === 'KeyP') { if (rally.driving()) rally.openMenu(); else rally.back(); }
  });
  const frames = (n) => {
    for (let i = 0; i < n; i++) {
      if (rally.driving()) run.step(DT, car);
      rally.update(DT, { car, stage: run, notes: [], stageName: 'ODCINEK LEŚNY' });
    }
  };
  // a pad tap = exactly what a finger does: push the tap, let sample() drain it
  const tap = (action) => {
    input.touch.tap(action);
    for (let k = 0; k < 4; k++) input.sample(DT);
  };
  // a menu row tap = the row's pointerdown handler: focus that row, then activate
  const rowTap = (act) => { rally.focus = rally.rowIndex(act); rally.activate(); };

  const trail = [];
  rally.openMenu();
  frames(90);                                     // sitting on the menu: clock frozen
  const frozen = run.state === STATE.PRE_START;
  rowTap('start');                                // finger on START
  frames(30);
  const countdown = rally.top() === 'countdown' || rally.driving();
  frames(Math.round(6 / DT) + 10);                // odliczanie -> RUNNING
  const driving = run.state === STATE.RUNNING && rally.driving();

  tap('camera'); tap('restart');                  // in-stage pads
  const pads = seen.camera === 1 && seen.restart === 1 && camMode === 1;

  const cd0 = run.countdown, t0 = run.elapsedRun;
  tap('menu');                                    // pad MENU = way back, no keyboard
  frames(60);
  const menuBack = rally.top() === 'menu' && !rally.driving() && run.countdown === cd0;
  trail.push(`menu=${rally.top()}`);
  rowTap('start');                                // START resumes the same stage
  frames(60);
  const resumed = rally.driving() && run.state === STATE.RUNNING && run.elapsedRun > t0;

  const ok = frozen && countdown && driving && pads && menuBack && resumed;
  check('T14 touch-only stage flow: menu START -> countdown -> drive -> pads -> menu -> START',
    ok, `frozen=${frozen} countdown=${countdown} driving=${driving} cam=${seen.camera} restart=${seen.restart} `
      + `padPads=${pads} menuBack=${menuBack} resumed=${resumed} ${trail.join(' ')}`);
}
testTouchOnlyStageFlow();

// ---------------------------------------------------------------------------
// Steering sign chain. The vehicle convention is POSITIVE steer = a LEFT turn
// (car/steering.js turns the front wheels to body -X), verified here by driving
// the real car: heading +X, world left = -Z. Pad buttons, the analog thumb drag,
// the keyboard and the pad knob must all agree with it — one flipped sign in the
// chain and the on-screen left arrow steers the car right.
function testSteerSignChain() {
  const world = new FlatWorld(SURF.ASPHALT);
  const input = new Input();
  input.touch.enabled = true;
  const settle = () => { for (let k = 0; k < 30; k++) input.sample(DT); };

  input.touch.setAction('steerLeft', true); settle();
  const touchLeft = input.state.steer;
  input.touch.setAction('steerLeft', false); settle();
  input.touch.setAction('steerRight', true); settle();
  const touchRight = input.state.steer;
  input.touch.setAction('steerRight', false); settle();

  input.down.add('steerLeft'); settle();
  const keyLeft = input.state.steer;
  input.down.clear(); settle();
  input.down.add('steerRight'); settle();
  const keyRight = input.state.steer;
  input.down.clear(); settle();

  // a thumb dragged LEFT (negative screen dx) is a left steer, and the knob for a
  // left steer sits LEFT of the track centre (negative px offset)
  const dragLeft = steerCurve(dragToSteer(-60, 80), STEER_DEADZONE);
  const dragRight = steerCurve(dragToSteer(60, 80), STEER_DEADZONE);
  const knobForLeft = knobOffset(1, 60);          // px from centre
  const knobForRight = knobOffset(-1, 60);

  // the car itself: feed the number the pad handed over and watch it turn left
  const turnTo = (steer) => {
    const car = makeCar(world, {});
    car.placeAt(0, 0, 0);
    car.body.vel.x = 14;
    car.wheels.forEach((wh) => { wh.omega = 14 / wh.rEff; });
    for (let i = 0; i < 90; i++) {
      car.setInput({ throttle: 0.3, brake: 0, steer, handbrake: 0, shiftUp: 0, shiftDown: 0 });
      car.step(DT);
    }
    return { z: car.body.pos.z, yaw: Math.atan2(car.body.forward.z, car.body.forward.x) };
  };
  const carLeft = turnTo(keyLeft);
  const carRight = turnTo(keyRight);

  const agree = touchLeft === 1 && keyLeft === 1 && touchLeft === keyLeft
    && touchRight === -1 && keyRight === -1;
  const dragAgrees = dragLeft > 0 && dragRight < 0 && Math.sign(dragLeft) === Math.sign(keyLeft);
  const knobAgrees = knobForLeft < 0 && knobForRight > 0
    && Math.sign(knobForLeft) === -Math.sign(keyLeft);
  const turnsLeft = carLeft.z < -0.5 && carLeft.yaw < -0.05 && carRight.z > 0.5 && carRight.yaw > 0.05;
  check('T15 steering sign chain: pad left == keyboard left == drag left == a real left turn, knob matches',
    agree && dragAgrees && knobAgrees && turnsLeft,
    `touch=${touchLeft} key=${keyLeft} drag=${dragLeft.toFixed(3)} knob=${knobForLeft} ` +
    `carL.z=${carLeft.z.toFixed(2)} carL.yaw=${carLeft.yaw.toFixed(3)} carR.z=${carRight.z.toFixed(2)}`);
}
testSteerSignChain();

// ------------------------------------------------- persisted steer sign / KIEROWNICA
// The player-facing symptom was "steering is inverted on desktop" while the sim ground
// truth (T15) says positive steer is LEFT and no mapping pre-compensates. The only
// place a sign may flip is settings.invertSteer, so the suspect is a stored payload:
// an untagged pre-v2 payload carries no explicit invertSteer, and restoring such an
// implicit invert on top of the corrected mapping inverts it for returning players only.
// Last test in the file: it mutates the shared `settings`, so nothing may run after it.
function testSteerSettingPersistence() {
  const mem = () => { const m = new Map(); return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k), store: m }; };

  // ---- 1. legacy payload, no explicit invertSteer -> must restore false ----------
  const legacy = mem();
  legacy.setItem(LEGACY_SETTINGS_KEY, JSON.stringify({
    quality: 2, hudMode: 'FULL', touchOverlay: 'on', assists: { abs: true, tc: true },
  }));
  settings.invertSteer = true;                     // dirty in-memory state, must not survive
  const migrated = loadSettings(legacy);
  const legacyRestoresFalse = settings.invertSteer === false && migrated.invertSteer === false;
  const retagged = JSON.parse(legacy.store.get(SETTINGS_KEY) || 'null');
  const retaggedExplicit = !!retagged && retagged.schema === 2 && retagged.invertSteer === false;

  // an *explicit* old value is still honoured - the fix drops implicit inverts only
  const explicit = mem();
  explicit.setItem(LEGACY_SETTINGS_KEY, JSON.stringify({ invertSteer: true }));
  const honoured = loadSettings(explicit).invertSteer === true && settings.invertSteer === true;

  // ---- 2. save always writes the field explicitly ------------------------------
  const store = mem();
  settings.invertSteer = false;
  saveSettings(settings, store);
  const saved = JSON.parse(store.store.get(SETTINGS_KEY));
  const savedExplicit = saved.schema === 2 && typeof saved.invertSteer === 'boolean' && saved.invertSteer === false;
  settings.invertSteer = true;
  saveSettings(settings, store);
  const roundTrip = loadSettings(store).invertSteer === true && settings.invertSteer === true;
  settings.invertSteer = false;
  const clean = mem();
  const freshDefaults = loadSettings(clean) === null && settings.invertSteer === false
    && migrateSettings(null).invertSteer === false;

  // ---- 3. the KIEROWNICA row toggles it, live and visibly ---------------------
  const SEED = 99, LEN = 700;
  const terrain = makeTerrain(SEED, 'FOREST');
  const road = buildRoad({ seed: SEED, lengthTarget: LEN, terrainHeightAt: terrain.heightAt, biome: 'FOREST' });
  const run = new StageRun({ road, gates: planGates(road, SEED), seed: SEED, refTime: 60 });
  const carStub = { body: { pos: { x: road.x[12], z: road.z[12] }, groundSpeed: 0 }, wheels: [] };
  const rally = new RallyHud(new MenuStubDoc(), { stages: [{ key: 'FOREST', label: 'Leśny' }] });
  rally.openMenu();
  rally.focus = rally.rowIndex('screen:settings'); rally.activate();
  const rowIdx = rally.rowIndex('cycle:invertSteer');
  const labelOf = () => (rally._rows[rowIdx] ? rally._rows[rowIdx].label : '—');
  const labelledNormal = rowIdx >= 0 && labelOf().includes('KIEROWNICA') && labelOf().includes('NORMALNA');
  // Exactly what main.js activateMenu() does with the row the HUD hands back.
  const tapRow = (idx) => {
    rally.focus = idx;
    const it = rally.activate();
    if (it && it.act === 'cycle:invertSteer') { settings.invertSteer = !settings.invertSteer; saveSettings(settings, store); }
    rally.refreshMenu();
    return it;
  };
  settings.invertSteer = false;
  tapRow(rowIdx);
  const toggledInvert = settings.invertSteer === true && labelOf().includes('ODWROTNA');
  const persisted = JSON.parse(store.store.get(SETTINGS_KEY)).invertSteer === true;
  tapRow(rowIdx);
  const toggledBack = settings.invertSteer === false && labelOf().includes('NORMALNA');

  // ---- 4. it reaches the car immediately (input.sample re-reads it) -----------
  const input = new Input();
  input.down.add('steerLeft');
  for (let k = 0; k < 40; k++) input.sample(DT);
  const normalSign = Math.sign(input.state.steer);
  settings.invertSteer = true;
  for (let k = 0; k < 40; k++) input.sample(DT);
  const invertedSign = Math.sign(input.state.steer);
  settings.invertSteer = false;
  const rowIsLive = normalSign > 0 && invertedSign < 0;

  const ok = legacyRestoresFalse && retaggedExplicit && honoured && savedExplicit && roundTrip
    && freshDefaults && labelledNormal && toggledInvert && persisted && toggledBack && rowIsLive;
  check('T16 a legacy settings payload with no explicit invertSteer restores false, and the KIEROWNICA row toggles it + persists',
    ok, `legacyFalse=${legacyRestoresFalse} retagged=${retaggedExplicit} explicitHonoured=${honoured} `
      + `savedExplicit=${savedExplicit} roundTrip=${roundTrip} fresh=${freshDefaults} row=${labelledNormal} `
      + `toggle=${toggledInvert} persisted=${persisted} back=${toggledBack} live=${rowIsLive} (${labelOf()})`);
}
testSteerSettingPersistence();

// ---------------------------------------------------------------------------
// Frame-rate independence (docs/06 §3). The fixed-step accumulator has to be paid
// back every frame: while `consume()` was never called, acc grew without bound,
// floor(acc/DT) saturated at MAX_STEPS_PER_FRAME and the sim advance became
// MAX_STEPS_PER_FRAME * DT * fps — a 120 Hz phone ran the stage twice as fast as
// a 60 Hz one and the car left the line far harder.
function testFrameRateIndependence() {
  const SEED = 71, LEN = 700, WALL = 14;
  const terrain = makeTerrain(SEED, 'FOREST');
  const road = buildRoad({ seed: SEED, lengthTarget: LEN, terrainHeightAt: terrain.heightAt, biome: 'FOREST' });
  const runRate = (hz) => {
    const world = new FlatWorld(SURF.ASPHALT);
    const car = makeCar(world, {});
    car.placeAt(0, 0, 0);
    const stage = new StageRun({ road, gates: planGates(road, SEED), seed: SEED, refTime: 60 });
    const inp = { throttle: 0.85, brake: 0, steer: 0, handbrake: 0, shiftUp: 0, shiftDown: 0 };
    const loop = new FrameLoop({
      stepSim(dt) { car.setInput(inp); car.step(dt); stage.step(dt, car); },
      render() {},
    });
    const step = 1000 / hz;
    let last = 0;
    for (let i = 1; i <= Math.round(WALL * hz); i++) { last = i * step; loop.frame(last); }
    // A pathological 0.25 s hitch must not advance more than the substep cap.
    loop.frame(last + 250);
    const capStep = loop.time.frameSimDt;
    return {
      dist: Math.abs(car.body.pos.x),
      elapsed: stage.timing.elapsed,
      countdown: stage.countdown,
      state: stage.state,
      steps: loop.time.stepCount,
      capStep,
      capOk: capStep <= MAX_STEPS_PER_FRAME * DT + 1e-9,
    };
  };
  const a = runRate(60), b = runRate(120);
  const rel = Math.abs(a.dist - b.dist) / Math.max(a.dist, b.dist);
  const distOk = rel <= 0.01 && a.dist > 30;
  const clockOk = Math.abs(a.elapsed - b.elapsed) <= 0.02 && a.elapsed > 5 && a.state === b.state;
  const cdOk = Math.abs(a.countdown - b.countdown) <= 1e-6;
  check('T17 the fixed-step loop advances the same distance and stage clock at 60 Hz and 120 Hz, and a 0.25 s hitch stays under the substep cap',
    distOk && clockOk && cdOk && a.capOk && b.capOk,
    `dist60=${a.dist.toFixed(2)}m dist120=${b.dist.toFixed(2)}m rel=${(rel * 100).toFixed(2)}% `
    + `clock60=${a.elapsed.toFixed(3)}s clock120=${b.elapsed.toFixed(3)}s countdown=${a.countdown.toFixed(3)}/${b.countdown.toFixed(3)} `
    + `steps60=${a.steps} steps120=${b.steps} hitchAdvance=${a.capStep.toFixed(4)}s cap=${(MAX_STEPS_PER_FRAME * DT).toFixed(4)}s`);
}
testFrameRateIndependence();

// ------------------------------------------------- HUD layout: modal vs boards, label vs bar
// Fault 1: the countdown / result modal was painted over the two pace-note boards, the
// meta strip and the locator bar, leaving half-erased labels. While ANY modal screen is
// up the boards must draw nothing at all. Fault 2: the sector strip label sat on top of
// the locator bar, so at every viewport (desktop / phone portrait / phone landscape) the
// label rect must not intersect the bar rect.
function testHudBoardsUnderModalAndSectorLabelRow() {
  let ops = 0;                                   // every 2D call on the stub canvas
  const ctx2d = new Proxy({}, {
    get(t, k) { if (k in t) return t[k]; return () => { ops++; }; },
    set(t, k, v) { t[k] = v; return true; },
  });
  class CanvasStubDoc extends MenuStubDoc {
    createElement(tag) {
      const el = super.createElement(tag);
      if (tag === 'canvas') el.getContext = () => ctx2d;
      return el;
    }
  }
  const SEED = 99, LEN = 900;
  const terrain = makeTerrain(SEED, 'FOREST');
  const road = buildRoad({ seed: SEED, lengthTarget: LEN, terrainHeightAt: terrain.heightAt, biome: 'FOREST' });
  const run = new StageRun({ road, gates: planGates(road, SEED), seed: SEED, refTime: 90 });
  const wheelStub = () => ({ alpha: 0, kappa: 0, N: 0, slipEnergy: 0, airborneFrames: 0 });
  const car = { body: { pos: { x: road.x[12], z: road.z[12] }, groundSpeed: 14 }, wheels: [wheelStub(), wheelStub(), wheelStub(), wheelStub()] };
  const hudCtx = { car, stage: run, notes: [], stageName: 'ODCINEK LEŚNY' };
  const sizes = [[1600, 900], [390, 844], [844, 390]];
  globalThis.window = { innerWidth: sizes[0][0], innerHeight: sizes[0][1], addEventListener() {} };
  const rally = new RallyHud(new CanvasStubDoc(), { stages: [{ key: 'FOREST', label: 'Leśny' }] });

  // ---- 1. boards are suppressed while a modal (countdown) is open ------------
  rally.update(DT, hudCtx);                      // PRE_START stage pushes 'countdown'
  const modalUp = rally.top() === 'countdown' && rally._modalOpen === true;
  const hidden = rally._keys.boards === 'hidden';
  ops = 0;
  rally._drawMeta(hudCtx); rally._drawSigns(hudCtx); rally._drawProg(hudCtx);
  const silentUnderModal = ops === 0;
  rally.startStage();                            // countdown closed -> the boards return
  for (const key in rally._keys) rally._keys[key] = '';
  ops = 0;
  rally._drawMeta(hudCtx); rally._drawProg(hudCtx);
  const paintsOnHud = ops > 0;

  // ---- 2. sector label row never overlaps the bar row, at all three sizes ----
  let k = 12;                                    // walk the car down the road into a sector
  for (let i = 0; i < 900; i++) {
    k = Math.min(road.x.length - 1, k + 1);
    car.body.pos.x = road.x[k]; car.body.pos.z = road.z[k];
    run.step(DT, car);
  }
  const rects = [];
  let clearAtAll = true;
  for (const [w, h] of sizes) {
    globalThis.window.innerWidth = w; globalThis.window.innerHeight = h;
    rally._resize();
    rally._drawProg(hudCtx);
    const g = rally._progGeom;
    if (!g) { clearAtAll = false; rects.push(`${w}x${h}:none`); continue; }
    const gap = Math.max(g.bar.y - (g.label.y + g.label.h), g.label.y - (g.bar.y + g.bar.h));
    const inside = g.label.x >= 0 && g.label.y >= 0
      && g.bar.x + g.bar.w <= rally.W && g.bar.y + g.bar.h <= rally.H;
    if (!(gap >= 0 && inside)) clearAtAll = false;
    rects.push(`${w}x${h}:L[${g.label.x},${g.label.y},${g.label.w},${g.label.h}] `
      + `B[${g.bar.x},${g.bar.y},${g.bar.w},${g.bar.h}] gap=${gap}`);
  }
  const secActive = !!run.timing.activeSector;
  const ok = modalUp && hidden && silentUnderModal && paintsOnHud && clearAtAll && secActive;
  check('T18 HUD layout: pace-note boards are suppressed while a modal is open, and the sector label rect never intersects the progress bar rect (1600x900 / 390x844 / 844x390)',
    ok, `modal=${modalUp} boardsHidden=${hidden} silentUnderModal=${silentUnderModal} `
    + `paintsOnHud=${paintsOnHud} sector=${secActive} ${rects.join(' ')}`);
  delete globalThis.window;
}
testHudBoardsUnderModalAndSectorLabelRow();

// ---------------------------------------------------------------- test 19
// No prop may stand inside the road corridor (carriageway + shoulder + margin).
// The corridor is measured against the 1 m spline samples as a polyline, not against
// the normal of one nearest sample - that is exactly what let a bush land in the middle
// of the track at the start line. Props are re-scattered out of the corridor, so the
// prop count of a chunk must stay in the same range as before, not shrink.
function testPropsStayOffRoad() {
  const SEED = 12345, LEN = 4200;
  const terrain = makeTerrain(SEED, 'FOREST');
  const road = buildRoad({ seed: SEED, lengthTarget: LEN, terrainHeightAt: terrain.heightAt, biome: 'FOREST' });
  const carveIndex = buildCarveIndex(road);
  const stage = { road, carveIndex, terrain, biome: 'FOREST', density: 1, seed: SEED, world: null };
  const keys = [];
  const seen = new Set();
  for (let i = 0; i < road.n; i += 8) {
    const k = `${Math.floor(road.x[i] / CHUNK)},${Math.floor(road.z[i] / CHUNK)}`;
    if (!seen.has(k)) { seen.add(k); keys.push(k); }
  }
  const sample = keys.slice(0, 6).concat(keys.filter((_, k) => k % 3 === 0)).slice(0, 90);
  let total = 0, inside = 0, minGap = Infinity, startInside = 0, startCount = 0;
  for (const k of sample) {
    const [cx, cz] = k.split(',').map(Number);
    for (const p of generateChunkProps(cx, cz, stage)) {
      total++;
      const gap = roadCorridorGap(road, p.x, p.z);
      if (gap < minGap) minGap = gap;
      if (gap < PROP_CORRIDOR_MARGIN) inside++;
      if (p.prop === PROP.BUSH || p.prop === PROP.FERN) {
        startCount++;
        if (gap < PROP_CORRIDOR_MARGIN) startInside++;
      }
    }
  }
  const ok = total > 300 && inside === 0 && startInside === 0 && startCount > 40
    && minGap >= PROP_CORRIDOR_MARGIN;
  check('T19 no prop placement falls inside the road corridor (carriageway + shoulder + 1.2 m), re-scattered not deleted',
    ok, `chunks=${sample.length} props=${total} vergeSprites=${startCount} inside=${inside} `
    + `insideVerge=${startInside} minGap=${minGap.toFixed(2)}m need=${PROP_CORRIDOR_MARGIN}m`);
}
testPropsStayOffRoad();

// ---------------------------------------------------------------- test 20
// Straight-line performance of the reference car on gravel. Every performance
// number used to be tuned under the old runaway accumulator, so once the frame
// loop was fixed the car came back detuned (6.5 s to 100 kph, 124 kph terminal).
// These are the numbers the retune has to hold.
function testStraightLinePerformance() {
  const w = new FlatWorld(SURF.GRAVEL);
  const car = makeCar(w, {});
  car.placeAt(0, 0, 0);
  let t = 0, t100 = null, vtop = 0, launchKappa = 0;
  for (let i = 0; i < Math.round(110 / DT); i++) {
    car.setInput({ throttle: 1, brake: 0, steer: 0, handbrake: 0, shiftUp: 0, shiftDown: 0 });
    car.step(DT);
    t += DT;
    const v = car.body.groundSpeed;
    if (t100 === null && v >= 100 / 3.6) t100 = t;
    vtop = Math.max(vtop, v);
    if (t < 3) launchKappa = Math.max(launchKappa, ...car.wheels.map((wh) => Math.abs(wh.kappa)));
  }
  const top = vtop * 3.6;
  const ok = t100 !== null && t100 >= 4.0 && t100 <= 5.0 && top >= 180 && top <= 200 && launchKappa < 0.9;
  check('T20 gravel straight line: 0-100 in 4.0-5.0 s, terminal 180-200 kph, no launch wheelspin over kappa 0.9',
    ok, `0-100=${t100 === null ? '>110' : t100.toFixed(2)}s top=${top.toFixed(1)} kph launchKappa=${launchKappa.toFixed(2)}`);
  return { t100, top };
}
testStraightLinePerformance();

// ---------------------------------------------------------------- test 21
// The checkpoint / start board must be solid geometry, not a sandwich of plates. Every
// past version of it (and the gantry that got fixed first) stacked thin coloured plates
// over the same span with their faces on the same plane, and the depth pass dithered the
// whole board into a white/red checkerboard. This checks the geometry the way the depth
// buffer sees it: no two differently-coloured faces may sit on the same plane (or within
// 10 cm of it) while their footprints overlap.
function testGateBoardIsSolid() {
  // Geometry without a WebGL context: the fake BufferGeometry keeps the attribute arrays
  // that GeoBuilder.toGeometry hands over, which is all this needs.
  class FakeGeo {
    setAttribute(n, a) { this[n] = a.array; }
    setIndex(i) { this.idx = i; }
    computeBoundingSphere() {}
  }
  const THREE_STUB = { BufferGeometry: FakeGeo, Float32BufferAttribute: class { constructor(a) { this.array = a; } } };
  const geo = buildGateGeometry(GeoBuilder, THREE_STUB);
  const pos = geo.position, nrm = geo.normal, col = geo.color, idx = geo.idx;
  const faces = [];
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3;
    const n = [nrm[a], nrm[a + 1], nrm[a + 2]];
    const d = n[0] * pos[a] + n[1] * pos[a + 1] + n[2] * pos[a + 2];
    const rgb = [(col[a] + col[b] + col[c]) / 3, (col[a + 1] + col[b + 1] + col[c + 1]) / 3, (col[a + 2] + col[b + 2] + col[c + 2]) / 3];
    let min = [pos[a], pos[a + 1], pos[a + 2]], max = [pos[a], pos[a + 1], pos[a + 2]];
    for (const k of [b, c]) for (let ax = 0; ax < 3; ax++) {
      min[ax] = Math.min(min[ax], pos[k + ax]); max[ax] = Math.max(max[ax], pos[k + ax]);
    }
    faces.push({ n, d, rgb, min, max });
  }
  const EPS = 0.10;                       // m: depth resolution at the 150 m this reads from
  let clashes = 0, minGap = Infinity;
  for (let i = 0; i < faces.length; i++) {
    for (let j = i + 1; j < faces.length; j++) {
      const A = faces[i], B = faces[j];
      if (A.n[0] * B.n[0] + A.n[1] * B.n[1] + A.n[2] * B.n[2] < 0.999) continue;
      const gap = Math.abs(A.d - B.d);    // same-facing planes: this IS their separation
      // Footprint overlap must be measured IN the plane, on the two axes across it:
      // comparing the plane-normal axis calls every pair of separated boxes disjoint.
      const axisOf = (n) => (Math.abs(n[0]) > 0.5 ? 0 : (Math.abs(n[1]) > 0.5 ? 1 : 2));
      const na = axisOf(A.n), nb = axisOf(B.n);
      let overlap = true;
      for (let ax = 0; ax < 3; ax++) {
        if (ax === na || ax === nb) continue;
        if (A.max[ax] < B.min[ax] || B.max[ax] < A.min[ax]) overlap = false;
      }
      if (!overlap) continue;
      const dc = Math.hypot(A.rgb[0] - B.rgb[0], A.rgb[1] - B.rgb[1], A.rgb[2] - B.rgb[2]);
      if (dc < 0.06) continue;            // same colour: a coincident seam is invisible
      minGap = Math.min(minGap, gap);
      if (gap < EPS) clashes++;
    }
  }
  const tris = idx.length / 3;
  const xs = pos.filter((_, k) => k % 3 === 0);
  const span = Math.max(...xs) - Math.min(...xs);
  const ok = clashes === 0 && tris <= 420 && tris >= 240 && minGap >= EPS && span >= 11.3;
  check('T21 checkpoint/start board is one solid core with bands through it: no two differently-coloured faces share a plane, no sheet sandwich',
    ok, `faces=${faces.length} tris=${tris} clashes=${clashes} minGap=${minGap.toFixed(2)}m eps=${EPS}m `
    + `span=${span.toFixed(1)}m planes=${Object.values(GATE_PLANES).join('/')}`);
}
testGateBoardIsSolid();

// ---------------------------------------------------------------- test 22
// Vegetation LOD bands: every tree species must own all three bands - solid near
// geometry, the mid crossed-quad sprite, and the far single billboard. A species with no
// sprite variant has no mid/far band at all, so streaming drops it at the 90 m hard prop
// limit while oaks and pines reach vegFar (320 m): that is how the bare snags popped out
// of the skyline ~90 m before the leafy trees. Second half of the check is the atlas -
// one painted cell per sprite species, all distinct, because the UV is addressed by
// SPRITE_PROPS.indexOf().
function testVegetationOwnsEveryLodBand() {
  // Same headless stand-in as T21: the fake geometry keeps the attribute arrays.
  class FakeGeo {
    setAttribute(n, a) { this[n] = a.array; }
    setIndex(i) { this.idx = i; }
    computeBoundingSphere() {}
  }
  const THREE_STUB = { BufferGeometry: FakeGeo, Float32BufferAttribute: class { constructor(a) { this.array = a; } } };
  const mid = buildSpriteGeometries(THREE_STUB);
  const bill = buildBillboardGeometries(THREE_STUB);
  const TREES = [PROP.OAK, PROP.PINE, PROP.BIRCH, PROP.DEAD, PROP.BUSH, PROP.FERN];
  const gaps = [];
  for (const p of TREES) {
    const n = PROP_NAMES[p], sp = SPRITE_SPEC[p];
    if (!SPRITE_PROPS.includes(p)) gaps.push(`${n}/no-sprite-band`);
    if (!sp || !(sp.w > 1) || !(sp.h > 1)) { gaps.push(`${n}/no-sprite-spec`); continue; }
    if (!mid[p] || !mid[p].idx || mid[p].idx.length !== sp.planes * 6) gaps.push(`${n}/mid-quad`);
    if (!bill[p] || !bill[p].idx || bill[p].idx.length !== 6) gaps.push(`${n}/billboard`);
  }
  const cells = SPRITE_ATLAS.species;
  if (cells.length !== SPRITE_PROPS.length) gaps.push(`cells=${cells.length}!=species=${SPRITE_PROPS.length}`);
  if (new Set(cells).size !== cells.length) gaps.push('duplicate-paint-cell');
  if (cells.length > SPRITE_ATLAS.cols * SPRITE_ATLAS.rows) gaps.push('atlas-over-full');
  if (new Set(SPRITE_PROPS.map((_, i) => atlasRect(i).join(','))).size !== SPRITE_PROPS.length) gaps.push('atlas-rect-collision');
  // A sprite species still needs a solid near build: a 2-plane alpha quad cannot carry a
  // trunk next to the car, and that is what the near band is for.
  for (const p of [PROP.DEAD, PROP.OAK, PROP.PINE]) if (!NEAR_LOD_TRIS[p]) gaps.push(`${PROP_NAMES[p]}/no-near-lod`);
  const snag = SPRITE_SPEC[PROP.DEAD];
  const ok = gaps.length === 0 && snag.w >= 1.6 && snag.w <= 3.0 && snag.h >= 4.5;
  check('T22 every tree species owns the mid sprite and the far billboard band with its own painted atlas cell (nothing pops at the 90 m hard prop limit)',
    ok, `species=${SPRITE_PROPS.map((p) => PROP_NAMES[p]).join(',')} snag=${snag.w}x${snag.h}m/planes=${snag.planes} `
    + `atlas=${SPRITE_ATLAS.cols}x${SPRITE_ATLAS.rows}@${SPRITE_ATLAS.cellPx}px gaps=[${gaps.join(' ')}]`);
}
testVegetationOwnsEveryLodBand();

// ---------------------------------------------------------------- test 23
// The loose-surface drag band. Gravel was re-fitted against a modern rally car's terminal
// speed (~190 kph) but the rest of the family kept the old, far heavier scale, so the
// taper turned into a cliff: mud bottomed out at 81 kph, sand at 92 and peat at 68 while
// gravel ran 186. Terminal speed is the outcome the two drag columns produce, so this
// measures it on the flat straight and pins the whole ladder: every loose surface inside
// its band, the drag columns rising monotonically with softness, terminal speed falling
// monotonically with it, and no step down larger than one gear's worth of speed.
function testLooseSurfaceDragBand() {
  // Softness order: hardest loose surface first, bog last. Bands are the terminal speeds
  // each row's crr/sink pair was fitted to (+/-6 kph of play for future retunes).
  const LADDER = ['gravel', 'grass', 'dirt', 'snow', 'sand', 'mud', 'peat'];
  const BAND = { gravel: [180, 200], grass: [144, 157], dirt: [134, 147], snow: [126, 139], sand: [116, 128], mud: [97, 109], peat: [83, 96] };
  const rows = [], gaps = [];
  const term = {};
  for (const key of LADDER) {
    const s = SURFACES.find((x) => x.key === key);
    const w = new FlatWorld(s.id);
    const car = makeCar(w, {});
    car.placeAt(0, 0, 0);
    let vtop = 0;
    for (let i = 0; i < Math.round(150 / DT); i++) {
      car.setInput({ throttle: 1, brake: 0, steer: 0, handbrake: 0, shiftUp: 0, shiftDown: 0 });
      car.step(DT);
      vtop = Math.max(vtop, car.body.groundSpeed);
    }
    const kph = vtop * 3.6;
    term[key] = kph;
    rows.push(`${key}=${kph.toFixed(0)}kph`);
    const [lo, hi] = BAND[key];
    if (kph < lo || kph > hi) gaps.push(`${key}=${kph.toFixed(0)} outside ${lo}-${hi}`);
  }
  for (let i = 1; i < LADDER.length; i++) {
    const a = SURFACES.find((x) => x.key === LADDER[i - 1]);
    const b = SURFACES.find((x) => x.key === LADDER[i]);
    if (!(b.crr > a.crr)) gaps.push(`crr ${LADDER[i]}=${b.crr}<=${a.crr}`);
    if (!(b.sink > a.sink)) gaps.push(`sink ${LADDER[i]}=${b.sink}<=${a.sink}`);
    const step = term[LADDER[i - 1]] - term[LADDER[i]];
    if (!(step >= 3)) gaps.push(`step ${LADDER[i - 1]}->${LADDER[i]}=${step.toFixed(0)}kph too flat`);
    if (step > 40) gaps.push(`step ${LADDER[i - 1]}->${LADDER[i]}=${step.toFixed(0)}kph cliff`);
  }
  // The retune is drag-only by contract: mu/plough carry cornering, drift and handbrake.
  const grip = SURFACES.filter((s) => LADDER.includes(s.key)).map((s) => `${s.key}:mu${s.mu}/pl${s.plough}`).join(' ');
  check('T23 loose-surface drag band: terminal speed tapers monotonically from gravel to peat, no surface is a wall',
    gaps.length === 0, rows.join(' ') + ` | steps=${(term.gravel - term.peat).toFixed(0)}kph total | drag=${LADDER.map((k) => { const s = SURFACES.find((x) => x.key === k); return `${k}:${s.crr}/${s.sink}`; }).join(' ')} | gaps=[${gaps.join(' ')}]`);
  return { term, gaps, grip };
}
const bandTerm = testLooseSurfaceDragBand().term;

// ---------------------------------------------------------------- test 24
// The straight-line powertrain ceiling the ghost takes as its hard cap. It used to be the
// drag-only cube root of peak power (82.3 m/s for car 'A') while the source quoted
// "~70 m/s" for it: both sat above the tallest gear (71.3 m/s) and 60 % above what the
// car actually holds on the reference surface (gravel, 51.6 m/s), so the number the pace
// was justified with was not a capability at all. Pin that ceiling between the gearbox and
// the physics: never above the gearing limit, never under the terminal speed measured on
// the flat straight, never rising with rolling resistance, and always above the
// willingness table SURFACE_VMAX so the surface row — never the cap — is what bounds a
// reference. Re-measure the physics column with tools/vmax.mjs.
function testGhostPowertrainCeilingIsReal() {
  const measured = { ...bandTerm };   // kph, straight already driven by T23 for the loose ladder
  const gaps = [], rows = [];
  for (const key of ['asphalt', 'stone', 'ice', 'unknown']) {
    const s = SURFACES.find((x) => x.key === key);
    const w = new FlatWorld(s.id);
    const car = makeCar(w, {});
    car.placeAt(0, 0, 0);
    let vtop = 0;
    for (let i = 0; i < Math.round(150 / DT); i++) {
      car.setInput({ throttle: 1, brake: 0, steer: 0, handbrake: 0, shiftUp: 0, shiftDown: 0 });
      car.step(DT);
      vtop = Math.max(vtop, car.body.groundSpeed);
    }
    measured[key] = vtop * 3.6;
  }
  const gearingOf = (c) => (c.engine.redline * Math.PI / 30) / (Math.min(...c.gears) * c.finalDrive) * TYRE_BASE.r;
  for (const key of Object.keys(SURFACE_VMAX)) {
    const s = SURFACES.find((x) => x.key === key);
    const cap = powertrainCeiling(CARS.A, s), capKph = cap * 3.6;
    rows.push(`${key}=${capKph.toFixed(0)}v${measured[key].toFixed(0)}kph`);
    if (capKph < measured[key] - 0.5) gaps.push(`${key} cap ${capKph.toFixed(0)} under measured ${measured[key].toFixed(0)}`);
    if (!(cap > SURFACE_VMAX[key])) gaps.push(`${key} cap ${cap.toFixed(1)}m/s binds the surface ceiling ${SURFACE_VMAX[key]}`);
  }
  // Gearing is the hard side of the cap for every car; the power side must be what binds
  // first for a car geared short enough to run out of power before the rev limiter.
  for (const id of Object.keys(CARS)) {
    const c = CARS[id], vGear = gearingOf(c);
    for (const s of SURFACES) {
      const cap = powertrainCeiling(c, s);
      if (!(cap > 0) || cap > vGear + 1e-6) gaps.push(`${id}/${s.key} cap ${cap.toFixed(1)} outside 0..${vGear.toFixed(1)} gearing`);
    }
    if (!(powertrainCeiling(c, surface(SURF.GRAVEL)) >= powertrainCeiling(c, surface(SURF.PEAT)))) {
      gaps.push(`${id} cap rises with rolling resistance`);
    }
  }
  if (!(powertrainCeiling(CARS.C, surface(SURF.GRAVEL)) < gearingOf(CARS.C) - 0.5)) {
    gaps.push('power term never binds (car C should run out of power before the limiter)');
  }
  check('T24 the ghost powertrain ceiling is a real ceiling: never over the tallest gear, never under the terminal speed the physics reaches, never binding under the surface ceiling',
    gaps.length === 0, `car A cap/measured ${rows.join(' ')}`
    + ` | gearing=${gearingOf(CARS.A).toFixed(1)}m/s carC=${powertrainCeiling(CARS.C, surface(SURF.GRAVEL)).toFixed(1)}m/s of ${gearingOf(CARS.C).toFixed(1)}m/s | gaps=[${gaps.join(' ')}]`);
}
testGhostPowertrainCeilingIsReal();

// ---------------------------------------------------------------- test 25
// The ghost *calibration*, i.e. the one number (GHOST_TUNE.referenceSpeedMargin) that
// decides how hard the reference drives. T24 pins the ceiling it is built from, but
// nothing here compared the reference with a driven lap, so when the loose-surface drag
// retune made the car ~21 % quicker the reference stayed where it was and the stage
// acceptance went red around a green suite: tools/stagetest.mjs E3 (the reference was
// 20.3 % SLOWER than the driver it is supposed to beat) and A6 (a -44.30 s split), and
// the stage limit ref * 1.6 was 28 % more generous than designed. So: drive the
// reference stage with the same headless pace driver the harness drives with
// (src/debug/pace-driver.js) and pin the reference inside the acceptance envelope that
// harness states — quicker than that lap, no more than 25 % quicker, no more than 20 s
// of split, not collapsed onto the LEN/20 constant-speed placeholder it must not be, and
// still beatable inside its own ref * 1.6 limit. A car or surface retune that moves the
// lap turns this red until the margin is re-read.
function testGhostReferenceIsCalibratedToADrivenLap() {
  const SEED = 12345, LEN = 4200, START = 12;
  const world = new VoxelWorld(SEED);
  const terrain = makeTerrain(SEED, 'FOREST');
  const road = buildRoad({ seed: SEED, lengthTarget: LEN, terrainHeightAt: terrain.heightAt, biome: 'FOREST' });
  const gates = planGates(road, SEED);
  const carveIndex = buildCarveIndex(road);
  const ghost = solveGhost(road, { seed: SEED, gates, carId: 'A' });
  prewarmArea(world, terrain, road, carveIndex, road.x[START], road.z[START], 150);
  // Same floor() shim main.js installs, so the wheels read a real surface column.
  const carWorld = Object.create(world);
  carWorld.surfaceAt = (x, z) => world.surfaceAt(Math.floor(x), Math.floor(z));
  carWorld.rutAt = (x, z) => world.rutAt(Math.floor(x), Math.floor(z));
  const car = makeCar(carWorld, {});
  car.placeAt(road.x[START], road.z[START], -road.heading[START], road.h[START]);
  car.wheels.forEach((w) => { w.omega = 0; });
  const stage = new StageRun({ road, gates, seed: SEED, refTime: ghost.refTime, refSectors: ghost.refSectors });
  const driver = createPaceDriver(road);

  let steps = 0, nan = false, recoveries = 0, stuck = 0;
  const maxSteps = Math.round(560 / DT);           // the same 560 s budget the harness gives a lap
  for (let i = 0; i < maxSteps; i++) {
    const idx = Math.max(0, road.nearest(car.body.pos.x, car.body.pos.z));
    const sp = Math.max(1, car.body.groundSpeed);
    const cmd = driver.input(car, idx, sp, stage.state !== STATE.PRE_START);
    // The two on-stage guards a player has (docs/06 §5 R / zakotwiczenie): a car in the
    // trees or on its side is put back on the road, and one that stalls is nudged on.
    const lat = Math.hypot(car.body.pos.x - road.x[idx], car.body.pos.z - road.z[idx]);
    const roll = Math.abs(Math.asin(Math.max(-1, Math.min(1, -car.body.m[7]))) * 57.3);
    if (lat > 6 || roll > 22) {
      const k = Math.min(road.n - 2, idx + 2);
      car.placeAt(road.x[k], road.z[k], -road.heading[k], road.h[k]);
      car.wheels.forEach((w) => { w.omega = car.body.groundSpeed / w.rEff; });
      recoveries++;
    }
    if (car.body.groundSpeed < 1.2) stuck++; else stuck = 0;
    if (stuck > 150) {
      const k = Math.min(road.n - 2, idx + 5);
      car.placeAt(road.x[k], road.z[k], -road.heading[k], road.h[k]);
      car.wheels.forEach((w) => { w.omega = 6; });
      stuck = 0; recoveries++;
    }
    car.setInput(cmd);
    car.step(DT);
    stage.step(DT, car);
    steps++;
    if (!Number.isFinite(car.body.pos.y)) { nan = true; break; }
    if (i % 240 === 0) prewarmArea(world, terrain, road, carveIndex, car.body.pos.x, car.body.pos.z, 90);
    if (stage.state === STATE.FINISHED || stage.state === STATE.DNF) break;
  }

  const ref = ghost.refTime, driven = stage.result.total;
  const gaps = [];
  if (nan) gaps.push('NaN in the drive');
  if (stage.state !== STATE.FINISHED) gaps.push(`lap ${stage.state}${stage.reason ? '/' + stage.reason : ''}`);
  if (!(ref < driven)) gaps.push(`ref ${ref.toFixed(1)}s is not quicker than the ${driven.toFixed(1)}s lap`);
  if (!(ref >= driven * 0.75)) gaps.push(`ref ${(100 * (1 - ref / driven)).toFixed(1)}% quicker: over the 25% band`);
  if (!(driven - ref <= 20)) gaps.push(`split +${(driven - ref).toFixed(1)}s over the 20s band`);
  if (Math.abs(ref - LEN / 20) <= 5 || Math.abs(ref - LEN / 15) <= 5) {
    gaps.push(`ref ${ref.toFixed(1)}s on the constant-speed placeholder ${(LEN / 20).toFixed(1)}s`);
  }
  if (!(driven < ref * 1.6)) gaps.push('the driven lap cannot beat its own ref * 1.6 limit');
  check('T25 the ghost reference is calibrated to a driven lap: quicker than the headless pace driver, inside the acceptance band, beatable at ref * 1.6',
    gaps.length === 0, `ref ${ref.toFixed(2)}s (${(3.6 * ghost.avgSpeed).toFixed(1)} km/h avg, ${(3.6 * ghost.maxSpeed).toFixed(0)} km/h max) `
    + `vs driven ${driven.toFixed(2)}s = ${(100 * (1 - ref / driven)).toFixed(1)} % quicker, split +${(driven - ref).toFixed(2)}s `
    + ` | margin ${GHOST_TUNE.referenceSpeedMargin}, ghost peaks at ${ghost.maxSpeed.toFixed(1)} m/s under the ${SURFACE_VMAX.gravel} m/s gravel ceiling`
    + ` | limit ${(ref * 1.6).toFixed(0)}s vs lap ${driven.toFixed(0)}s | band 0.75..1.00 of lap, split <=20s, |ref-${(LEN / 20).toFixed(0)}s|>5s `
    + `| steps ${steps} rec ${recoveries} | gaps=[${gaps.join(' ')}]`);
  return { ref, driven, gaps };
}
testGhostReferenceIsCalibratedToADrivenLap();

// ---------------------------------------------------------------- test 26
// The particle FX switch (`settings.fx`, src/fx) is the weak-device lever, and before
// the EFEKTY row a phone could not reach it at all: outside the saved payload the only
// writer was a second `KeyP` inside main.js's if-chain, sitting behind the menu's KeyP,
// i.e. dead code that never ran. Pin the whole path: Ustawienia owns a labelled EFEKTY
// row, every row of every menu screen owns both a DOM hit box and a focus slot (the
// hit-box pool used to be a fixed 8 elements while Ustawienia now carries 9 rows, and a
// row without a box is a row no thumb can ever tap), the tap flips settings.fx exactly
// the way main.js applies it, the flip reaches the save, and the FX system stops
// emitting behind that flag.
function testFxSwitchIsReachableFromSettings() {
  const mem = () => { const m = new Map(); return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k), store: m }; };
  const store = mem();
  const fxWas = settings.fx;

  // The system main.js drives: one live, one behind the flag the row flips.
  const car = makeCar(new FlatWorld(SURF.GRAVEL), {});
  const fxOn = new FxSystem({ scale: 1, bus });
  const fx = new FxSystem({ scale: 1, bus, enabled: settings.fx !== false });
  for (const f of [fxOn, fx]) {
    f.setLocalTips(defaultExhaust(car.params));
    f.env.trees = 0.9; f.env.wind = 4; f.env.sun = 1;
  }

  const rally = new RallyHud(new MenuStubDoc(), { stages: [{ key: 'FOREST', label: 'Leśny' }] });
  rally.openMenu();
  rally.openScreen('settings');
  const idx = () => rally.rowIndex('toggle:fx');
  const labelOf = () => (rally._rows[idx()] ? rally._rows[idx()].label : '—');

  const gaps = [];
  // Every screen, measured from a fresh boot (that is when the pool is its smallest):
  // a DOM hit box per row AND a focus slot per row (keyboard / gamepad).
  const perScreen = [];
  for (const name of ['menu', 'settings', 'controls']) {
    const hud = new RallyHud(new MenuStubDoc(), { stages: [{ key: 'FOREST', label: 'Leśny' }] });
    hud.openMenu();
    hud.openScreen(name);
    const rows = hud._rows.length, boxes = hud.menuItems.length, focusable = hud.menu.length;
    perScreen.push(`${name}:${rows}/${boxes}/${focusable}`);
    if (boxes < rows) gaps.push(`${name} has ${rows} rows but ${boxes} hit boxes`);
    if (focusable !== rows) gaps.push(`${name} focuses ${focusable} of ${rows} rows`);
  }
  settings.fx = true; rally.refreshMenu();
  const labelled = idx() >= 0 && labelOf().includes('Efekty') && labelOf().includes('wł.');

  // Exactly what main.js activateMenu() does with the row the HUD hands back.
  const tapRow = () => {
    rally.focus = idx();
    const it = rally.activate();
    if (it && it.act === 'toggle:fx') {
      settings.fx = !settings.fx;
      fx.enabled = settings.fx;
      saveSettings(settings, store);
    }
    rally.refreshMenu();
    return it;
  };
  const rowAct = tapRow();
  const flippedOff = settings.fx === false && fx.enabled === false && labelOf().includes('wył.');
  const persisted = JSON.parse(store.store.get(SETTINGS_KEY)).fx === false;
  tapRow();
  const flippedBack = settings.fx === true && fx.enabled === true && labelOf().includes('wł.');

  // The flag is the whole switch: nothing is emitted while it is off. main.js re-arms
  // `fx.enabled` from settings.fx every rendered frame, so these two systems are what a
  // boot with the row on and with the row off builds.
  settings.fx = true; fxOn.enabled = true; fx.enabled = false;
  const inp = { throttle: 1, brake: 0, steer: 0, handbrake: 0, shiftUp: 0, shiftDown: 0 };
  drive(car, inp, 3.0, (c) => { fxOn.step(DT, c, 1); fx.step(DT, c, 1); });
  const liveOn = fxOn.live(), liveOff = fx.live();

  if (!rowAct || rowAct.act !== 'toggle:fx') gaps.push('the row is not a toggle:fx row');
  if (!labelled) gaps.push(`row not labelled (${labelOf()})`);
  if (!flippedOff) gaps.push('the tap did not flip the flag + the system');
  if (!persisted) gaps.push('the flip did not reach the save');
  if (!flippedBack) gaps.push('the tap back did not restore it');
  if (!(liveOn > 0)) gaps.push('the FX field is empty while on');
  if (liveOff !== 0) gaps.push(`${liveOff} particles live while off`);

  settings.fx = fxWas;
  check('T26 the EFEKTY row reaches the particle FX switch: labelled, tappable on every screen, persisted, and the pools stop',
    gaps.length === 0,
    `row=${labelled} off=${flippedOff} saved=${persisted} back=${flippedBack} live on/off=${liveOn}/${liveOff} `
    + `| rows/boxes/focus ${perScreen.join(' ')} | gaps=[${gaps.join(' ')}]`);
}
testFxSwitchIsReachableFromSettings();

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) process.exitCode = 1;

export { results, arcRun, test1, test2, test3, test4, test5, test6, test7, testCarAsset, testPaceNoteDisplay };
