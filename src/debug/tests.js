// Physics regression tests (docs/02 §11) + determinism.
// Runs headless in Node: the sim has no renderer/DOM dependency (physics-tuning
// skill: "extract the physics from the renderer first").
//
//   node src/debug/tests.js            all
//   node src/debug/tests.js 3          only test 3
import { Vehicle } from '../car/vehicle.js';
import { settleWheels, UPSIDE_DEG, RIGHT_DURATION_S } from '../car/rollover.js';
import { VoxelWorld } from '../world/chunk.js';
import { chunkKey } from '../world/chunk.js';
import { MAP_CATALOG, MAP_VERSION, MAP_SIZE_BUDGET, applyMap, mapUrl } from '../world/map-load.js';
import { SURF, SURFACES, surface } from '../world/surfaces.js';
import { TYRE_BASE, CARS } from '../car/car-params.js';
import { DT, MAX_STEPS_PER_FRAME } from '../core/time.js';
import { FrameLoop } from '../core/loop.js';
import { buildAssetBody, tyreScale, BODY_PARTS, WHEEL_NODES, defaultExhaust, GLASS_TINT, GLASS_UV, ARCH_PANELS, FLANK_UV } from '../render/car-asset.js';
import { LIVERY_BAND, LIVERY_ROUND, LIVERY_STRIP, LIVERY_TEXEL, LIVERY_NUM, LIVERY_SAMPLE, liveryNumberRects, buildLiveryTexture } from '../render/car-livery.js';
import { FxSystem, FX_CAPACITY, DUST_TUNE, shiftPop, POP_FLOOR, LIFT_THROTTLE } from '../fx/fx.js';
import { BackfirePop, BACKFIRE, popVoice, crackTrain, shiftRpmN } from '../audio/backfire.js';
import { bus } from '../core/events.js';
import { PANEL_COUNT } from '../dirt/panel-dirt.js';
import { makeTerrain } from '../world/terrain-gen.js';
import { buildRoad, stageClimate, WEATHER, WIDTH_DEFAULT } from '../world/road-spline.js';
import { solveGhost, powertrainCeiling, SURFACE_VMAX, GHOST_TUNE } from '../game/ghost.js';
import { planGates, StageRun, STATE } from '../game/stage.js';
import { buildPaceNotes, selectNotes } from '../game/pace-notes.js';
import { signWord, bendKind } from '../game/sign-board.js';
import { Input } from '../game/input.js';
import { steerCurve, STEER_DEADZONE, dragToSteer, knobOffset } from '../game/touch.js';
import { padRects, rectMap, applyPadLayout, layoutDefects, parseHandedness, TOUCH_BAND, BAND_MAX, MIN_HIT, PAD_CLS, GROUP_CLS } from '../game/touch-layout.js';
import { settings, SETTINGS_KEY, LEGACY_SETTINGS_KEY, loadSettings, saveSettings, migrateSettings, qualityPreset, QUALITY, FAR_RADII, DRAW_DISTANCE_STEPS, cycleDrawDistance, cycleBloom, fogNearFor, fogFarFor } from '../core/settings.js';
import { RallyHud } from '../game/hud-rally.js';
import { t as tr, setLang, getLang, table as i18nTable, languages as i18nLanguages, TEXT_BOXES } from '../core/i18n.js';
import { textWidth } from '../game/pixel-font.js';
import { generateChunkProps, roadCorridorGap, PROP_CORRIDOR_MARGIN, PROP, PROP_NAMES, buildGateGeometry, GATE_PLANES, SPRITE_PROPS, SPRITE_SPEC, SPRITE_ATLAS, NEAR_LOD_TRIS, atlasRect, buildSpriteGeometries, buildBillboardGeometries } from '../world/props.js';
import { VEG_BANDS, PROP_CAPACITY, vegBandPlan, vegDensity, vegCostFromDensity, vegTrisPerInstance } from '../world/veg-bands.js';
import { buildCarveIndex, prewarmArea, SHOULDER } from '../world/road-carve.js';
import { buildColliders, queryNearBrute, COLLIDER_CELL, SPECIES_SHAPE } from '../world/prop-colliders.js';
import { ROAD_TONE, RUT_GLOSS, roadToneRange, roadRutRoughness } from '../render/road-skin.js';
import { TYRE_TREAD, treadPlan, treadCell, treadCrown, treadReliefAmp, treadNormalTilt, wheelTreadPlan, TYRE_TREAD_GLSL } from '../render/tyre-tread.js';
import { POST_TUNE, passGraph, BLOOM_LEVELS, resolveToneMode,
  ATMO_TUNE, MAX_POST_PASSES, MAX_OFFSCREEN_PASSES, shaftAlpha, lensFlareAlpha,
  radialBlurAmount, sunVisibility } from '../render/post/tune.js';
import { MODEL_QUEUE, ModelQueue, nextBackoffMs } from '../render/model-queue.js';
import { BEAM, BEAM_VERT, BEAM_FRAG, isDark, beamAnchors, beamGeometry, beamMaterialSpec, beamTriangleCount, setBeamGain, beamFootprint, poolIlluminance, shaftHalfAngle, shaftWallAlpha, shaftPeak } from '../render/headlights.js';
import { createPaceDriver } from './pace-driver.js';
import { GeoBuilder } from '../render/primitives.js';
import { CHUNK } from '../world/chunk.js';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { showroomConfig, showroomRoute, showroomPose } from './showroom.js';
import { fileURLToPath } from 'node:url';

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
      // Asserted in BOTH languages (src/core/i18n.js): the board word always states the
      // side of the bend, in Polish AND in the English call vocabulary.
      let mismatch = 0;
      for (const lang of ['pl', 'en']) {
        setLang(lang);
        const w = signWord(n);
        const want = n.dir === 'L' ? tr('note.left') : tr('note.right');
        const other = n.dir === 'L' ? tr('note.right') : tr('note.left');
        if (!w.includes(want) || w.includes(other)) mismatch++;
      }
      setLang('en');
      if (mismatch) wordMismatch++;
      if (word.length === 0) wordMismatch++;
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
  // The row is asserted in BOTH dictionaries: the label is rebuilt under each language,
  // so neither the Polish wording nor the English one may go missing (src/core/i18n.js).
  const labelIn = (lang) => {
    setLang(lang); rally.refreshMenu();
    const s = labelOf();
    const ok = s.includes(tr('settings.steer'))
      && s.includes(tr(settings.invertSteer ? 'val.steerInvert' : 'val.steerNormal'));
    setLang('en'); rally.refreshMenu();
    return ok;
  };
  const labelledNormal = rowIdx >= 0 && labelIn('en') && labelIn('pl');
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
  const toggledInvert = settings.invertSteer === true && labelIn('en') && labelIn('pl');
  const persisted = JSON.parse(store.store.get(SETTINGS_KEY)).invertSteer === true;
  tapRow(rowIdx);
  const toggledBack = settings.invertSteer === false && labelIn('en') && labelIn('pl');

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
  // Rebuild the row under each language and match it against that language's own words,
  // so the EFEKTY / Effects row is proven in both dictionaries (src/core/i18n.js).
  const labelIn = (lang) => {
    setLang(lang); rally.refreshMenu();
    const s = labelOf();
    const ok = s.includes(tr('settings.fx')) && s.includes(tr(settings.fx ? 'val.on' : 'val.off'));
    setLang('en'); rally.refreshMenu();
    return ok;
  };

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
  const labelled = idx() >= 0 && labelIn('en') && labelIn('pl');

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
  const flippedOff = settings.fx === false && fx.enabled === false && labelIn('en') && labelIn('pl');
  const persisted = JSON.parse(store.store.get(SETTINGS_KEY)).fx === false;
  tapRow();
  const flippedBack = settings.fx === true && fx.enabled === true && labelIn('en') && labelIn('pl');

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

// ---------------------------------------------------------------- test 27
// Everything the streaming layer adopts out of a glb must be single-sided AT THE SOURCE
// (queue P6). The glTF exporter writes doubleSided = not material.use_backface_culling,
// and with the Blender default left alone every material in props.glb and
// stage_blocks.glb landed doubleSided: the far wall of a closed voxel drew on the same
// depth as the face in front of it (that is what checkerboarded the 9 m banner board),
// the tile layer that carpet the whole road band paid double the fill, and the only thing
// standing between the player and that mess was an engine-side `side = FrontSide` patch
// in src/world/streaming.js. Pin the contract instead of the patch: the shipped prop and
// block materials are single-sided, every primitive resolves to one of them, and the
// winding of every exported triangle agrees with the normal it ships with - so backface
// culling can only ever remove a face that was already shading away from the camera, and
// no hole or vanishing surface can be traded for the checkerboard.
function readGlbDoc(name) {
  const blob = readFileSync(fileURLToPath(new URL(`../../${name}`, import.meta.url)));
  if (blob.readUInt32LE(0) !== 0x46546C67) throw new Error(`${name}: not a GLB`);
  let off = 12, doc = null, binOff = -1;
  while (off + 8 <= blob.length) {
    const clen = blob.readUInt32LE(off);
    const ctype = blob.readUInt32LE(off + 4);
    off += 8;
    if (ctype === 0x4E4F534A) doc = JSON.parse(blob.toString('utf8', off, off + clen));
    else if (ctype === 0x004E4942) binOff = off;
    off += clen;
  }
  if (!doc || binOff < 0) throw new Error(`${name}: no JSON or BIN chunk`);
  const acc = (i) => {
    const a = doc.accessors[i];
    const v = doc.bufferViews[a.bufferView];
    const comp = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 }[a.componentType];
    const per = a.type === 'VEC3' ? 3 : (a.type === 'VEC2' ? 2 : 1);
    const base = binOff + (v.byteOffset || 0) + (a.byteOffset || 0);
    const n = a.count * per;
    const out = new Float64Array(n);
    for (let k = 0; k < n; k++) {
      const p = base + k * comp;
      out[k] = a.componentType === 5126 ? blob.readFloatLE(p)
        : a.componentType === 5125 ? blob.readUInt32LE(p)
        : a.componentType === 5123 ? blob.readUInt16LE(p)
        : a.componentType === 5122 ? blob.readInt16LE(p)
        : a.componentType === 5121 ? blob.readUInt8(p) : blob.readInt8(p);
    }
    return out;
  };
  return { doc, acc };
}

function testShippedGlbsAreSingleSided() {
  const gaps = [];
  let mats = 0, sided = 0, tris = 0, backfacing = 0, nodes = 0;
  for (const name of ['assets/models/props.glb', 'assets/models/stage_blocks.glb']) {
    const { doc, acc } = readGlbDoc(name);
    const list = doc.materials || [];
    mats += list.length;
    if (!list.length) { gaps.push(`${name}: exports no material at all`); continue; }
    const dbl = list.filter((m) => m.doubleSided === true).map((m) => m.name || '?');
    if (dbl.length) gaps.push(`${name}: ${dbl.length} doubleSided material(s): ${dbl.slice(0, 4).join(',')}`);
    for (const nd of doc.nodes || []) {
      if (!nd.name || !/^(prop|block)_/.test(nd.name)) continue;
      nodes++;
      const mesh = (doc.meshes || [])[nd.mesh];
      if (!mesh) { gaps.push(`${name}: ${nd.name} has no mesh`); continue; }
      for (const pr of mesh.primitives) {
        if (pr.material === undefined || !list[pr.material]) gaps.push(`${name}: ${nd.name} primitive has no material`);
        else sided++;
        if (pr.attributes.POSITION === undefined || pr.attributes.NORMAL === undefined) {
          gaps.push(`${name}: ${nd.name} primitive has no POSITION/NORMAL`);
          continue;
        }
        const P = acc(pr.attributes.POSITION), N = acc(pr.attributes.NORMAL);
        const I = pr.indices === undefined ? null : acc(pr.indices);
        const t = I ? I.length / 3 : (P.length / 3) / 3;
        tris += t;
        for (let k = 0; k < t; k++) {          // winding normal vs the shipped shading normal
          const i0 = I ? I[k * 3] : k * 3, i1 = I ? I[k * 3 + 1] : k * 3 + 1, i2 = I ? I[k * 3 + 2] : k * 3 + 2;
          const ux = P[i1 * 3] - P[i0 * 3], uy = P[i1 * 3 + 1] - P[i0 * 3 + 1], uz = P[i1 * 3 + 2] - P[i0 * 3 + 2];
          const vx = P[i2 * 3] - P[i0 * 3], vy = P[i2 * 3 + 1] - P[i0 * 3 + 1], vz = P[i2 * 3 + 2] - P[i0 * 3 + 2];
          const gx = uy * vz - uz * vy, gy = uz * vx - ux * vz, gz = ux * vy - uy * vx;
          const nx = N[i0 * 3] + N[i1 * 3] + N[i2 * 3];
          const ny = N[i0 * 3 + 1] + N[i1 * 3 + 1] + N[i2 * 3 + 1];
          const nz = N[i0 * 3 + 2] + N[i1 * 3 + 2] + N[i2 * 3 + 2];
          if (gx * nx + gy * ny + gz * nz < 0) backfacing++;
        }
      }
    }
  }
  // Floors: a file emptied of its nodes or materials must not pass this vacuously.
  if (!(nodes >= 30)) gaps.push(`only ${nodes} prop/block nodes`);
  if (!(mats >= 40)) gaps.push(`only ${mats} materials`);
  if (!(sided >= 30)) gaps.push(`only ${sided} primitives carry a material`);
  if (backfacing) gaps.push(`${backfacing} triangles wind against their own normal`);
  check('T27 the shipped props and block tiles are single-sided at the source: no doubleSided material, no backfacing winding, so the engine never patches side',
    gaps.length === 0,
    `nodes=${nodes} materials=${mats} primitives=${sided} tris=${tris} doubleSided=0 backfacing=${backfacing} | gaps=[${gaps.join(' ')}]`);
}
testShippedGlbsAreSingleSided();

// ---------------------------------------------------------------- test 28
// The road skin's value swing (queue P7). The terrain material multiplied every panel by
// `0.82 + 0.40 * tile` - a 48.8 % band whose midpoint sat at 1.02, i.e. above the panel
// colour itself - so whole 2.5 m patches of the near-field carriageway came out over-lit,
// and that one swing dwarfed every other value field in the shader (hue mix ~14 %, grit
// ~22 %, edge wear ~18 %). Narrowed to a 12 % band centred on 1.0: still above the floor
// PLAN §10 criterion 2 sets for tonal difference between panels of one surface, with no
// net lift. Because the value spread came down, the wheel-line rut now has to sell itself
// in the specular instead: it gets a slightly lower roughness across the packed wear band
// on every loose road surface, not only on asphalt. The constants live in
// src/render/road-skin.js and are interpolated into the GLSL, so this check pins the
// numbers that actually compile rather than a copy of them.
function testRoadSkinToneBandAndRutGloss() {
  const src = readFileSync(new URL('../render/renderer.js', import.meta.url), 'utf8');
  const range = roadToneRange();
  const gaps = [];

  // The band itself: PLAN §10 criterion 2 floor, and a ceiling the near field tolerates.
  if (!(range.spreadPct >= 12)) gaps.push(`panel tone spread ${range.spreadPct.toFixed(1)} % is under the 12 % criterion`);
  if (!(range.spreadPct <= 18)) gaps.push(`panel tone spread ${range.spreadPct.toFixed(1)} % is blown out again`);
  // No net lift: the midpoint of the swing sits ON the panel colour, and no panel gets
  // brightened more than 2 % (the old band reached 1.22).
  if (Math.abs(range.mid - 1) > 0.01) gaps.push(`tone midpoint ${range.mid.toFixed(3)} is off 1.00`);
  if (range.max > 1.10) gaps.push(`brightest panel lifted to ${range.max.toFixed(3)} of the panel colour`);

  // The rut must read as packed ground: glossier than the panel around it, and only
  // slightly so (a mirror-polished road is the other failure mode).
  const inRut = roadRutRoughness(0);
  const onPanel = roadRutRoughness(RUT_GLOSS.to);
  const gloss = (1 - inRut / onPanel) * 100;
  if (!(inRut < onPanel)) gaps.push(`rut roughness ${inRut.toFixed(3)} is not under panel ${onPanel.toFixed(3)}`);
  if (!(gloss >= 5 && gloss <= 30)) gaps.push(`rut is ${gloss.toFixed(1)} % glossier, not slight`);
  let monotone = true;
  for (let w = 0; w <= 1.0001; w += 0.05) if (roadRutRoughness(w) < inRut - 1e-9 || roadRutRoughness(w) > onPanel + 1e-9) monotone = false;
  if (!monotone) gaps.push('the rut term leaves its band');

  // Wiring: the shader builds its tone and rut terms from the pinned constants, so a
  // number edited here is a number the player sees - and a hardcoded GLSL literal would
  // silently escape this check.
  const importsSkin = /from '\.\/road-skin\.js'/.test(src);
  const toneWired = src.includes('float tone = ${ROAD_TONE.base} + ${ROAD_TONE.swing} * tile;');
  const rutWired = src.includes('(1.0 - ${RUT_GLOSS.road}) * rutRoad')
    && src.includes('smoothstep(${RUT_GLOSS.from}, ${RUT_GLOSS.to}, fract(vSurface))');
  if (!importsSkin) gaps.push('renderer.js no longer imports render/road-skin.js');
  if (!toneWired) gaps.push(`ROAD_TONE ${ROAD_TONE.base}/${ROAD_TONE.swing} is not the tone the shader compiles`);
  if (!rutWired) gaps.push(`RUT_GLOSS ${RUT_GLOSS.road} is not the rut term the shader compiles`);
  if (/float tone = \d/.test(src)) gaps.push('the shader carries a hardcoded tone band instead of the pinned constants');

  // Surface scope: the rut mask must cover exactly the road family the colour pass
  // treats as road, minus asphalt, which keeps its own stronger compaction term.
  const idsOf = (re) => { const m = src.match(re); return m ? [...m[1].matchAll(/sidx == (\d+)/g)].map((s) => +s[1]).sort((a, b) => a - b) : null; };
  const roadish = idsOf(/float roadish = \(([^;]*)\) \? 1\.0 : 0\.0;/);
  const rutMask = idsOf(/float rutRoad = \(([^;]*)\) \? 1\.0 : 0\.0;/);
  if (!roadish || !rutMask) gaps.push('could not read the road surface masks');
  else {
    const want = roadish.filter((s) => s !== SURF.ASPHALT);
    if (JSON.stringify(rutMask) !== JSON.stringify(want)) gaps.push(`rut mask [${rutMask}] != road family minus asphalt [${want}]`);
    if (!src.includes('r *= mix(0.55, 1.0, smoothstep(0.10, 0.40, fract(vSurface)))')) gaps.push('asphalt lost its own compaction term');
  }

  check('T28 the road skin swings 12 % in value about the panel colour, never over-lit, and the wheel-line rut runs slightly glossier',
    gaps.length === 0,
    `tone ${range.min.toFixed(2)}..${range.max.toFixed(2)} spread ${range.spreadPct.toFixed(1)} % mid ${range.mid.toFixed(3)} `
    + `| rut roughness ${inRut.toFixed(3)} vs panel ${onPanel.toFixed(3)} = ${gloss.toFixed(1)} % glossier `
    + `| masks road=[${roadish}] rut=[${rutMask}] | wired=${importsSkin}/${toneWired}/${rutWired} | gaps=[${gaps.join(' ')}]`);
}
testRoadSkinToneBandAndRutGloss();

// T29 (docs/QUALITY-QUEUE.md P8): a dark stage had no headlight beam the eye could
// see. A SpotLight lights the road but is invisible in clear air, so the beam is
// geometry: two additive open cone shells per lamp. Pinned here: the day/night gate
// agrees with the stage climate generator (beams only on a stage the rig calls dark),
// the shaft and its light pool are one object with one axis, the volume is additive /
// depth-tested / never depth-writing (otherwise it punches a hole in the terrain), it
// stays inside the frame triangle budget, and a smashed lamp cluster mutes pool and
// shaft together. render/headlights.js is THREE-free so all of this is checkable
// headless, exactly like render/road-skin.js.
function testNightHeadlightBeams() {
  const src = readFileSync(new URL('../render/carMesh.js', import.meta.url), 'utf8');
  const gaps = [];

  // --- the gate matches the generator: DUSK stages get beams, daylight never does ---
  let dusk = 0, darkDay = 0, litDark = 0;
  for (let seed = 1; seed <= 400; seed++) {
    const cl = stageClimate(seed, 'FOREST');
    const dark = isDark(cl.tod);
    if (cl.weather === WEATHER.DUSK) dusk++;
    if (dark && cl.weather !== WEATHER.DUSK) darkDay++;
    if (cl.weather === WEATHER.DUSK && !dark) litDark++;
  }
  if (dusk === 0) gaps.push('no DUSK stage in 400 seeds, the gate has nothing to light');
  if (darkDay > 0) gaps.push(`${darkDay}/400 daylight stages would run the beams`);
  if (litDark > 0) gaps.push(`${litDark}/400 DUSK stages would stay dark`);
  if (!isDark(0.95) || !isDark(0.05)) gaps.push('the deep-night ends of the day cycle are not dark');
  if (isDark(0.5) || isDark(0.72)) gaps.push('broad daylight is gated dark');

  // --- anchors: pool and shaft are one object, aimed down the road (car frame, +X) ---
  // The three shape fields the lamps mount on. render/car-body.js carShape() derives
  // them from the car params (hx/hz = hull half-extents, floor = -comY + 0.15); they
  // are recomputed here because car-body.js owns THREE and cannot load in Node.
  const p = CARS.A;
  const shape = { hx: p.hull.x, hz: p.hull.z, floor: -p.comY + 0.15 };
  const anchors = beamAnchors(shape);
  if (anchors.length !== 2) gaps.push(`${anchors.length} lamps, want 2`);
  for (const a of anchors) {
    if (a.dir.some((d) => !Number.isFinite(d)) || a.pos.some((d) => !Number.isFinite(d))) gaps.push('a lamp anchor is not finite');
    if (a.dir[0] <= 0.9) gaps.push(`a lamp aims ${(a.dir[0] * 100).toFixed(0)} % forward, not down the road`);
    if (a.dir[1] >= 0) gaps.push('a lamp aims above the horizon, its pool lands past the horizon');
    if ((a.pos[2] > 0) !== (a.dir[2] > 0)) gaps.push('a lamp aims inward, the two pools never merge');
    if (!(a.pos[0] > shape.hx)) gaps.push(`a lamp sits behind the nose at x=${a.pos[0].toFixed(2)}`);
    if (!(Math.abs(a.pos[2]) <= shape.hz)) gaps.push(`a lamp sits outside the body at z=${a.pos[2].toFixed(2)}`);
    if (!(Math.abs(a.pos[1] - shape.floor) < 1)) gaps.push('a lamp is not on the lamp band of the fascia');
    const px = a.pool[0] - a.pos[0], py = a.pool[1] - a.pos[1], pz = a.pool[2] - a.pos[2];
    const l = Math.hypot(px, py, pz);
    if (Math.abs(l - BEAM.reach) > 1e-6) gaps.push(`pool centre sits ${l.toFixed(2)} m out, the shaft reaches ${BEAM.reach} m`);
    if (Math.abs(px / l - a.dir[0]) > 1e-9 || Math.abs(pz / l - a.dir[2]) > 1e-9) gaps.push('pool and shaft axes disagree');
  }
  if (anchors.length === 2 && Math.abs(anchors[0].pos[2] + anchors[1].pos[2]) > 1e-9) gaps.push('the two lamps are not mirrored across the centreline');

  // --- geometry: an open cone shell along +X, radius opening to the far end ---
  const geo = beamGeometry();
  const verts = BEAM.rings.length * (BEAM.segments + 1);
  if (geo.position.length !== verts * 3 || geo.aFade.length !== verts) gaps.push(`shell has ${geo.aFade.length} verts, expected ${verts}`);
  if (geo.index.length !== (BEAM.rings.length - 1) * BEAM.segments * 6) gaps.push('the shell is not a closed ring stack');
  if (geo.tris * 2 !== beamTriangleCount()) gaps.push(`budget says ${beamTriangleCount()} tris, geometry built ${geo.tris * 2}`);
  const tris = beamTriangleCount();
  if (!(tris > 0 && tris <= 160)) gaps.push(`${tris} tris is not a cheap volume`);
  if (!(BEAM.reach <= BEAM.spot.distance)) gaps.push(`shaft reaches ${BEAM.reach} m past a ${BEAM.spot.distance} m light pool`);
  let rMin = 1e9, rMax = -1e9, xMin = 1e9, xMax = -1e9, bad = 0;
  for (let i = 0; i < verts; i++) {
    const x = geo.position[i * 3], y = geo.position[i * 3 + 1], z = geo.position[i * 3 + 2];
    if (![x, y, z, geo.aFade[i]].every((v) => Number.isFinite(v))) bad++;
    xMin = Math.min(xMin, x); xMax = Math.max(xMax, x);
    const r = Math.hypot(y, z);
    rMin = Math.min(rMin, r); rMax = Math.max(rMax, r);
  }
  if (bad) gaps.push(`${bad} non-finite shell vertices`);
  if (Math.abs(xMin) > 1e-9 || Math.abs(xMax - BEAM.reach) > 1e-6) gaps.push(`shell spans x ${xMin}..${xMax}, want 0..${BEAM.reach}`);
  if (!(rMin < BEAM.rings[0].r + 1e-6 && Math.abs(rMax - BEAM.rings[BEAM.rings.length - 1].r) < 1e-6))
    gaps.push(`shell radii ${rMin.toFixed(2)}..${rMax.toFixed(2)} do not open out from the lens`);
  let idxBad = 0;
  for (let i = 0; i < geo.index.length; i++) if (geo.index[i] >= verts) idxBad++;
  if (idxBad) gaps.push(`${idxBad} indices leave the vertex set`);

  // --- the alpha ramp: no hard disc at the lens, no cut in mid-air ---
  const alphas = BEAM.rings.map((r) => r.a);
  if (alphas[alphas.length - 1] !== 0) gaps.push(`the shaft ends at alpha ${alphas[alphas.length - 1]}: a hard cut in mid-air`);
  if (!(alphas[0] < alphas[1])) gaps.push('the shaft starts as a hard disc at the lens');
  if (BEAM.rings.some((r, i) => i && r.t <= BEAM.rings[i - 1].t)) gaps.push('the shell rings are not ordered along the beam');
  let fadeBad = 0;
  for (let b = 0; b < BEAM.rings.length; b++) {
    for (let i = 0; i <= BEAM.segments; i++) if (Math.abs(geo.aFade[b * (BEAM.segments + 1) + i] - BEAM.rings[b].a) > 1e-6) fadeBad++;
  }
  if (fadeBad) gaps.push('the ramp is not constant around a ring: a visible seam');

  // --- blend contract: adds light, never occludes, never writes depth ---
  const spec = beamMaterialSpec();
  if (!spec.transparent) gaps.push('the shell is opaque, it hides the terrain behind it');
  if (spec.depthWrite) gaps.push('the shell writes depth, it punches a hole in everything behind it');
  if (!spec.depthTest) gaps.push('the shell ignores depth, the beam shows through hills and the car');
  if (spec.blending !== 'AdditiveBlending') gaps.push(`blending ${spec.blending} is not additive`);
  if (spec.side !== 'DoubleSide') gaps.push(`side ${spec.side}: a shell crossed twice is the whole depth cue`);
  if (!(BEAM.gain >= 0.05 && BEAM.gain <= 0.4)) gaps.push(`peak shell alpha ${BEAM.gain} is a fog bank or invisible`);
  if (!/attribute float aFade/.test(BEAM_VERT) || !/vFade = aFade/.test(BEAM_VERT)) gaps.push('the shader does not carry the ramp');
  if (!/uGain \* vFade/.test(BEAM_FRAG) || !/discard/.test(BEAM_FRAG)) gaps.push('the shader ignores the gain uniform');
  if (!/gl_FragColor = vec4\( uColor \* a, a \)/.test(BEAM_FRAG)) gaps.push('the additive output is not alpha-modulated');

  // --- damage: pool and shaft go dark together, and come back ---
  const beams = {
    lights: anchors.map(() => ({ intensity: BEAM.spot.intensity })),
    shells: anchors.map(() => ({ visible: true })),
    mat: { uniforms: { uGain: { value: BEAM.gain } } },
  };
  const on = beams.lights[0].intensity, onGain = beams.mat.uniforms.uGain.value;
  setBeamGain(beams, BEAM.dimmed);
  if (Math.abs(beams.lights[0].intensity - on * BEAM.dimmed) > 1e-6) gaps.push('a smashed lamp keeps its light pool');
  if (Math.abs(beams.mat.uniforms.uGain.value - onGain * BEAM.dimmed) > 1e-9) gaps.push('a smashed lamp keeps its shaft');
  if (!beams.shells[0].visible) gaps.push('the dimmed shaft is hidden instead of dimmed');
  setBeamGain(beams, 0);
  if (beams.shells[0].visible) gaps.push('a zero-gain beam still draws');
  setBeamGain(beams, 1);
  if (Math.abs(beams.lights[0].intensity - on) > 1e-9) gaps.push('the beam cannot be restored once the lamps are repaired');

  // --- wiring: carMesh runs this module, it does not carry its own numbers ---
  if (!/from '\.\/headlights\.js'/.test(src)) gaps.push('carMesh.js no longer uses render/headlights.js');
  if (!src.includes('night ? attachHeadlights(group, shape) : null')) gaps.push('beams are no longer gated on a dark stage');
  if (!src.includes('isDark(tod)')) gaps.push('carMesh.js re-invents its own day/night threshold');
  if (!src.includes('setBeamGain(view.headlights, view.lightsOut ? BEAM.dimmed : 1)')) gaps.push('damage no longer mutes the beams');
  if (!src.includes('beamGeometry()') || !src.includes('beamMaterialSpec()')) gaps.push('carMesh.js builds its own shell instead of the pinned one');
  if (!/new THREE\.SpotLight\(BEAM\.color/.test(src) || /new THREE\.SpotLight\(\s*0x/.test(src)) gaps.push('carMesh.js builds its own SpotLight numbers');

  check('T29 a dark stage runs two headlight beams: pool and shaft agree, the gate matches the stage climate, damage kills both, and the volume is cheap',
    gaps.length === 0,
    `gate dark>${BEAM.darkAbove}/<${BEAM.darkBelow} dusk=${dusk}/400 wrongDark=${darkDay} wrongLit=${litDark} `
    + `| reach ${BEAM.reach} m <= pool ${BEAM.spot.distance} m radii ${BEAM.rings.map((r) => r.r).join('/')} alpha ${alphas.join('/')} x${BEAM.gain} `
    + `| lamps=${anchors.length} tris=${tris} (budget 160) dimmedPool=${(on * BEAM.dimmed).toFixed(2)}/${on.toFixed(0)} `
    + `| gaps=[${gaps.join(' ')}]`);
}
testNightHeadlightBeams();

// T30 (docs/QUALITY-QUEUE.md P8, second half): T29 proved the beam exists; it said
// nothing about the light under it. The SpotLight shipped as a 0.55 rad / 34 m cone,
// which is not a headlight but a flood: marched over the road plane, one lamp lit a
// 12.5 m-wide strip at 10 m out and 28 m at 25 m - the whole 10.5 m corridor
// (road-spline WIDTH_DEFAULT + road-carve SHOULDER), both banks and the treeline -
// 550 m2 of ground at up to 2x the night ambient, so a dusk stage never went dark and
// the 4.7 m-wide shaft drew inside a glow twice its size. Pinned here: the pool is the
// same object as the shaft (the cone is wider than the shaft's own fan, cut off a
// little past its reach), it lands inside the road corridor, and the ground past the
// shaft falls back to ambient.
function testHeadlightPoolIsTheSizeOfItsShaft() {
  const p = CARS.A;
  const shape = { hx: p.hull.x, hz: p.hull.z, floor: -p.comY + 0.15 };
  const gaps = [];

  // the cone must contain the shaft it is supposed to be causing, and end near it
  const shaftAng = shaftHalfAngle();
  if (!(shaftAng <= BEAM.spot.angle)) gaps.push(`the shaft fans to ${(shaftAng * 57.3).toFixed(1)} deg inside a ${(BEAM.spot.angle * 57.3).toFixed(1)} deg cone`);
  if (!(BEAM.spot.angle <= shaftAng * 2.2)) gaps.push(`a ${(BEAM.spot.angle * 57.3).toFixed(1)} deg cone is a flood lamp, not a headlight`);
  if (!(BEAM.reach <= BEAM.spot.distance && BEAM.spot.distance <= BEAM.reach + 12)) gaps.push(`pool cut-off ${BEAM.spot.distance} m against a ${BEAM.reach} m shaft`);

  // the footprint on the road plane, both lamps together
  const fp = beamFootprint(shape, 0.25);
  const corridor = 2 * (WIDTH_DEFAULT.gravel / 2 + SHOULDER);   // carriageway + shoulder
  const nearRel = fp.near - shape.hx, farRel = fp.far - shape.hx;
  if (!(fp.near > 0 && nearRel <= 6)) gaps.push(`pool starts ${nearRel.toFixed(1)} m ahead of the nose, a blind wedge under the car or light through it`);
  if (!(farRel >= BEAM.reach)) gaps.push(`the light dies ${farRel.toFixed(1)} m ahead, short of the ${BEAM.reach} m shaft drawn over it`);
  if (farRel > BEAM.spot.distance + 0.5) gaps.push(`pool reaches ${farRel.toFixed(1)} m ahead past its own ${BEAM.spot.distance} m cut-off`);
  if (!(fp.area > 20 && fp.area <= 200)) gaps.push(`the two lamps light ${fp.area.toFixed(0)} m2 of ground`);
  const mid = fp.spanAt(BEAM.reach * 0.5), end = fp.spanAt(BEAM.reach);
  if (!(mid >= 3 && mid <= corridor)) gaps.push(`pool is ${mid.toFixed(1)} m across at ${BEAM.reach * 0.5} m`);
  if (!(end >= 3 && end <= corridor)) gaps.push(`pool is ${end.toFixed(1)} m across at ${BEAM.reach} m, corridor is ${corridor.toFixed(1)} m`);

  // brightness profile down the beam: reads at the end of the shaft, gone past it
  const atEnd = poolIlluminance(shape, shape.hx + BEAM.reach * 0.8, 0);
  const past = poolIlluminance(shape, shape.hx + BEAM.reach * 1.5, 0);
  if (!(atEnd >= 0.8)) gaps.push(`only ${atEnd.toFixed(2)} of light at the end of the shaft (night ambient is 0.60-0.72)`);
  if (!(past <= 0.6)) gaps.push(`${past.toFixed(2)} of light ${BEAM.reach * 1.5} m out: the frame stays lit past the beam`);

  check('T30 the headlight pool is the size of the beam it draws: cone contains the shaft, ends with it, and never floods the corridor',
    gaps.length === 0,
    `cone ${(BEAM.spot.angle * 57.3).toFixed(1)} deg >= shaft ${(shaftAng * 57.3).toFixed(1)} deg, cut ${BEAM.spot.distance} m vs reach ${BEAM.reach} m `
    + `| ground ${fp.area.toFixed(0)} m2, ${nearRel.toFixed(1)}..${farRel.toFixed(1)} m ahead of the nose, across ${mid.toFixed(1)} m @${BEAM.reach * 0.5} / ${end.toFixed(1)} m @${BEAM.reach} (corridor ${corridor.toFixed(1)} m) `
    + `| pool ${atEnd.toFixed(2)} @${(BEAM.reach * 0.8).toFixed(0)} m -> ${past.toFixed(2)} @${(BEAM.reach * 1.5).toFixed(0)} m, peak ${fp.peak.toFixed(1)} | gaps=[${gaps.join(' ')}]`);
}
testHeadlightPoolIsTheSizeOfItsShaft();

// ------------------------------------------------ far draw distance (fog + radii)
// The player's complaint is a short view. Two invariants: the fog can never land a hard
// wall inside the streamed disc, and every quality preset actually reaches its target
// radius (LOW >= 700 m, HIGH >= 1200 m) with the near/mid bands untouched.
function testFarDrawDistance() {
  const gaps = [];
  for (const dd of DRAW_DISTANCE_STEPS) {
    if (fogFarFor(dd) < dd) gaps.push(`fog far ${fogFarFor(dd)} < drawDistance ${dd}: hard wall inside the disc`);
    if (fogNearFor(dd) > 520) gaps.push(`fog near ${fogNearFor(dd)} at ${dd} m hazes the mid-distance ground`);
  }
  if (!(fogFarFor(1600) > fogFarFor(400))) gaps.push('fog far does not follow the draw distance setting');
  const before = { full: settings.fullRadius, simple: settings.simpleRadius };
  qualityPreset(QUALITY.LOW);
  const low = { dd: settings.drawDistance, veg: settings.vegFarDistance, full: settings.fullRadius, simple: settings.simpleRadius, farDetail: settings.farDetail };
  qualityPreset(QUALITY.MED);
  const med = { dd: settings.drawDistance, veg: settings.vegFarDistance, full: settings.fullRadius, simple: settings.simpleRadius };
  qualityPreset(QUALITY.HIGH);
  const high = { dd: settings.drawDistance, veg: settings.vegFarDistance, full: settings.fullRadius, simple: settings.simpleRadius, farDetail: settings.farDetail };
  if (low.dd < 700) gaps.push(`LOW reaches only ${low.dd} m (target >= 700)`);
  if (high.dd < 1200) gaps.push(`HIGH reaches only ${high.dd} m (target ~1200)`);
  for (const [n, r] of [['LOW', low], ['MED', med], ['HIGH', high]]) {
    if (r.veg > r.dd) gaps.push(`${n}: vegFarDistance ${r.veg} past drawDistance ${r.dd} - the far band has no chunks to draw in`);
    if (r.veg < r.dd * 0.5) gaps.push(`${n}: vegFarDistance ${r.veg} fades the treeline at half the view`);
  }
  if (!(high.dd > med.dd && med.dd > low.dd)) gaps.push('presets do not step the draw distance up');
  if (high.full < before.full || high.simple < before.simple) gaps.push('near/mid streaming bands were shrunk instead of the far bands grown');
  if (cycleDrawDistance() !== 1600) gaps.push('the menu row does not step up to 1600 m');
  if (cycleDrawDistance() !== DRAW_DISTANCE_STEPS[0]) gaps.push('the menu row does not wrap back to 400 m');
  qualityPreset(QUALITY.MED);
  check('T31 the view reaches far: fog far follows the draw distance and every preset hits its target radii',
    gaps.length === 0,
    `LOW ${low.dd} m (veg ${low.veg}, far detail ${low.farDetail}) MED ${med.dd} m (veg ${med.veg}) HIGH ${high.dd} m (veg ${high.veg}, far detail ${high.farDetail}) `
    + `| near/mid ${high.full}/${high.simple} m | fog 400->${fogFarFor(400)} m, 1600->${fogFarFor(1600)} m | gaps=[${gaps.join(' ')}]`);
}
testFarDrawDistance();

// ---------------------------------------------------------------------------
// T32/T33/T34 post-composite stack (src/render/post/composer.js). Headless: the
// pass graph and the dial table are pure data, no WebGL context needed.
const POST_RANGES = {
  exposure: [0.4, 2.2],
  'bloom.threshold': [0.05, 4.0], 'bloom.knee': [0.05, 2.0], 'bloom.intensity': [0, 2.0],
  'bloom.radius': [0.5, 4.0], 'bloom.taps': [1, 8], 'bloom.sigma': [0.5, 3.0], 'bloom.mips': [1, 2],
  'grade.contrast': [0, 0.8], 'grade.shadowLift': [0, 0.12], 'grade.warmAmt': [0, 1], 'grade.coolAmt': [0, 1],
  'grade.satGreen': [0, 0.5], 'grade.satBrown': [0, 0.5], 'grade.vignette': [0, 0.6],
  'grade.grain': [0, 0.05], 'grade.grainSpeed': [1, 60],
};

function testPostPassGraph() {
  const gaps = [];
  const per = {};
  for (const [qName, q] of [['LOW', QUALITY.LOW], ['MED', QUALITY.MED], ['HIGH', QUALITY.HIGH]]) {
    qualityPreset(q);
    const g = passGraph({ post: settings.post, bloom: settings.bloom });
    per[qName] = { bloom: settings.bloom, n: g.length, off: g.filter((p) => p.res !== 'canvas').length, names: g.map((p) => p.name) };
    if (g.length < 3) gaps.push(`${qName}: graph has only ${g.length} passes`);
    // "at most four extra passes": the four offscreen quads, plus the one composite
    // that writes the canvas.
    if (per[qName].off > 4) gaps.push(`${qName}: ${per[qName].off} offscreen passes > 4`);
    if (g[g.length - 1].name !== 'composite') gaps.push(`${qName}: last pass is not the canvas composite`);
    const bright = g.filter((p) => p.kind === 'bright').length;
    const blurV = g.filter((p) => p.kind === 'blurV').length;
    if (bright !== blurV) gaps.push(`${qName}: separable blur unbalanced (${bright} H vs ${blurV} V)`);
    if (qName === 'LOW' && settings.bloom !== 'LOW') gaps.push('LOW preset does not run the cheapest bloom row');
    if (qName === 'LOW' && g.length !== 3) gaps.push(`LOW cheapest path is not 1 mip (got ${g.length})`);
    if (qName !== 'LOW') {
      const mips = new Set(g.filter((p) => p.res !== 'canvas').map((p) => p.res));
      if (mips.size < 2 || !mips.has('quarter') || !mips.has('eighth')) gaps.push(`${qName}: bright/blur mips [${[...mips]}] < 2 (quarter+eighth expected)`);
      if (g.length < 5) gaps.push(`${qName}: expected 5 passes, got ${g.length}`);
    }
  }
  // BLOOM row cycles and stays inside the table.
  const vendor = readFileSync(new URL('../../vendor/three.module.js', import.meta.url), 'utf8');
  const vendored = /export \{[^}]*\bAgXToneMapping\b/.test(vendor);
  const tone = resolveToneMode(vendored ? { AgXToneMapping: 6, ACESFilmicToneMapping: 4 } : { ACESFilmicToneMapping: 4 });
  if (vendored && tone.name !== 'AgX') gaps.push('r169 exports AgXToneMapping but the composer did not pick AgX');
  if (!vendored && tone.name !== 'ACESFilmic') gaps.push('no AgXToneMapping in the vendor build and ACES was not picked either');
  const cycled = [cycleBloom(), cycleBloom(), cycleBloom(), cycleBloom()];
  if (cycled.some((v) => !BLOOM_LEVELS.includes(v))) gaps.push(`cycleBloom left the table: ${cycled}`);
  if (cycled[3] !== cycled[0]) gaps.push('cycleBloom does not wrap');
  qualityPreset(QUALITY.MED);
  check('T32 pass graph is built per quality preset: 1 mip + composite at LOW, quarter+eighth separable gaussian at MED/HIGH, <= 4 extra passes',
    gaps.length === 0,
    `LOW ${per.LOW.n} [${per.LOW.names}] | MED ${per.MED.n} [${per.MED.names}] | HIGH ${per.HIGH.n} [${per.HIGH.names}] | bloom row ${settings.bloom} | tone ${tone.name} | gaps=[${gaps.join(' ')}]`);
}
testPostPassGraph();

function testPostTunablesFinite() {
  const gaps = [];
  const vendored = /export \{[^}]*\bAgXToneMapping\b/.test(readFileSync(new URL('../../vendor/three.module.js', import.meta.url), 'utf8'));
  const tone = resolveToneMode(vendored ? { AgXToneMapping: 6, ACESFilmicToneMapping: 4 } : { ACESFilmicToneMapping: 4 });
  const walk = (obj, path) => {
    for (const [k, v] of Object.entries(obj)) {
      const p = (path === 'bloom' && BLOOM_LEVELS.includes(k)) ? path : (path ? `${path}.${k}` : k);
      if (p === 'bloom') { walk(v, p); continue; }
      if (Array.isArray(v)) {
        if (v.length !== 3 || v.some((n) => !Number.isFinite(n) || n < 0.5 || n > 1.3)) gaps.push(`${p} tint out of 0.5..1.3: ${v}`);
      } else if (typeof v === 'number') {
        if (!Number.isFinite(v)) { gaps.push(`${p} is not finite (${v})`); continue; }
        const r = POST_RANGES[p];
        if (!r) gaps.push(`${p} has no pinned range`);
        else if (v < r[0] || v > r[1]) gaps.push(`${p}=${v} outside ${r[0]}..${r[1]}`);
      } else if (v && typeof v === 'object') walk(v, p);
      else gaps.push(`${p} is not a number (${v})`);
    }
  };
  walk(POST_TUNE, '');
  for (const lvl of BLOOM_LEVELS) {
    const b = POST_TUNE.bloom[lvl];
    if (!Number.isInteger(b.taps) || b.taps < 3 || b.taps > 7) gaps.push(`bloom.${lvl}.taps=${b.taps} outside 3..7`);
  }
  // bloom rows must step up monotonically or the row is a lie
  const I = BLOOM_LEVELS.map((l) => POST_TUNE.bloom[l].intensity);
  const R = BLOOM_LEVELS.map((l) => POST_TUNE.bloom[l].radius);
  if (!(I[0] < I[1] && I[1] < I[2])) gaps.push(`bloom intensity does not step up: ${I}`);
  if (!(R[0] < R[1] && R[1] < R[2])) gaps.push(`bloom radius does not step up: ${R}`);
  if (typeof tone.mode !== 'number' || tone.mode <= 0) gaps.push(`tone mode is not a real THREE mode (${tone.mode})`);
  check('T33 every post tunable is finite and inside its pinned range (one dial table)',
    gaps.length === 0,
    `exposure ${POST_TUNE.exposure} | bloom ${BLOOM_LEVELS.map((l) => `${l} t${POST_TUNE.bloom[l].threshold} i${POST_TUNE.bloom[l].intensity} r${POST_TUNE.bloom[l].radius} k${POST_TUNE.bloom[l].taps}`).join(' ')} | grade contrast ${POST_TUNE.grade.contrast} satG ${POST_TUNE.grade.satGreen} satB ${POST_TUNE.grade.satBrown} vig ${POST_TUNE.grade.vignette} grain ${POST_TUNE.grade.grain} | tone ${tone.name} | gaps=[${gaps.join(' ')}]`);
}
testPostTunablesFinite();

function testPostFallback() {
  const gaps = [];
  const storage = { m: new Map(), getItem(k) { return this.m.has(k) ? this.m.get(k) : null; }, setItem(k, v) { this.m.set(k, String(v)); } };
  for (const q of [QUALITY.LOW, QUALITY.MED, QUALITY.HIGH]) {
    qualityPreset(q);
    settings.post = false;
    const g = passGraph({ post: false, bloom: settings.bloom });
    if (g.length !== 0) gaps.push(`quality ${q}: POST off still builds ${g.length} composer passes`);
  }
  // the three rows persist and migrate back, so a reload keeps the look
  qualityPreset(QUALITY.HIGH);
  settings.post = false; settings.bloom = 'LOW'; settings.grade = false;
  saveSettings(settings, storage);
  settings.post = true; settings.bloom = 'HIGH'; settings.grade = true;
  loadSettings(storage);
  if (settings.post !== false) gaps.push('POST row did not persist');
  if (settings.bloom !== 'LOW') gaps.push(`BLOOM row did not persist (${settings.bloom})`);
  if (settings.grade !== false) gaps.push('GRADE row did not persist');
  // a legacy payload with no opinion keeps the current defaults, never a half-state
  const m = migrateSettings({ quality: 1 });
  if (typeof m.post !== 'boolean' || !BLOOM_LEVELS.includes(m.bloom) || typeof m.grade !== 'boolean') gaps.push('migrateSettings left the post rows implicit');
  qualityPreset(QUALITY.MED);
  check('T34 POST off builds zero composer passes (pre-post render is the fallback) and POST/BLOOM/GRADE persist',
    gaps.length === 0,
    `off passes ${passGraph({ post: false, bloom: 'HIGH' }).length} | rows persisted post=${settings.post} bloom=${settings.bloom} grade=${settings.grade} | gaps=[${gaps.join(' ')}]`);
}
testPostFallback();

// ---------------------------------------------------------------- test 35
// Livery/glass separation (shots showed the roundel reading on the rear window):
// a glass-material panel goes through the real merge, every glass vertex must be
// masked out (aLiv 0) and parked outside the painted rects, and the painted door
// skin must still carry the roundel.
function testLiveryGlassSeparation() {
  const w = new FlatWorld(SURF.DIRT);
  const params = makeCar(w, {}).params;
  const nodes = fakeNodes();
  nodes.get('car_panel').material = [{ name: 'rally_glass' }];   // the greenhouse
  const built = buildAssetBody(nodes, params);
  const inBand = (u, v) => u >= LIVERY_BAND.u0 && u <= LIVERY_BAND.u1 && v >= LIVERY_BAND.v0 && v <= LIVERY_BAND.v1;
  const inStrip = (u, v) => u >= LIVERY_STRIP.u0 && u <= LIVERY_STRIP.u1 && v >= LIVERY_STRIP.v0 && v <= LIVERY_STRIP.v1;
  const inRound = (u, v) => ((u - LIVERY_ROUND.u) ** 2 + (v - LIVERY_ROUND.v) ** 2) <= LIVERY_ROUND.r ** 2;
  let glass = 0, glassBad = 0, parked = 0, painted = 0;
  let u0 = 9, u1 = -9, v0 = 9, v1 = -9;
  for (let i = 0; i < built.count; i++) {
    const u = built.aLivUv[i * 2], v = built.aLivUv[i * 2 + 1];
    const isGlass = Math.abs(built.color[i * 3] - GLASS_TINT[0]) < 1e-6
      && Math.abs(built.color[i * 3 + 1] - GLASS_TINT[1]) < 1e-6
      && Math.abs(built.color[i * 3 + 2] - GLASS_TINT[2]) < 1e-6;
    if (isGlass) {
      glass++;
      if (built.aLiv[i] !== 0 || inBand(u, v) || inStrip(u, v) || inRound(u, v)) glassBad++;
      if (Math.abs(u - GLASS_UV[0]) < 1e-6 && Math.abs(v - GLASS_UV[1]) < 1e-6) parked++;
    } else if (built.aLiv[i] === 1 && u <= FLANK_UV.u0 + FLANK_UV.uSpan) {
      painted++;
      u0 = Math.min(u0, u); u1 = Math.max(u1, u); v0 = Math.min(v0, v); v1 = Math.max(v1, v);
    }
  }
  const doorCoversRoundel = painted > 0
    && u0 <= LIVERY_ROUND.u && u1 >= LIVERY_ROUND.u;
  // The roundel has to be a CIRCLE in metres, not in texels: convert its rect
  // back through the flank metric (x = (u-u0)/mu - halfX, y = (v-v0)/mu + yb).
  const M = built.livMetric;
  const rx0 = (LIVERY_ROUND.u - LIVERY_ROUND.r - M.u0) / M.mu - M.halfX;
  const rx1 = (LIVERY_ROUND.u + LIVERY_ROUND.r - M.u0) / M.mu - M.halfX;
  const ry0 = (LIVERY_ROUND.v - LIVERY_ROUND.r - M.v0) / M.mu + M.yb;
  const ry1 = (LIVERY_ROUND.v + LIVERY_ROUND.r - M.v0) / M.mu + M.yb;
  const dx = rx1 - rx0, dy = ry1 - ry0;
  const roundelMetric = Math.abs(dx - dy) < 0.02 && dx > 0.30 && dx < 0.40
    && rx0 > -M.halfX && rx1 < M.halfX && ry0 > M.yb && ry1 < M.yt;
  const rectsOnFlank = LIVERY_BAND.u1 <= 0.45 && LIVERY_STRIP.u1 <= 0.45
    && LIVERY_BAND.v1 <= 0.50 && LIVERY_ROUND.v + LIVERY_ROUND.r <= 0.50;
  const ok = glass >= 12 && glassBad === 0 && parked === glass && doorCoversRoundel && rectsOnFlank && roundelMetric;
  check('T35 no glass face reads the livery: glass is masked + parked outside the band/roundel rects, the door skin still carries the roundel',
    ok,
    `glassVerts=${glass} glassBad=${glassBad} parked=${parked}/${glass} | roundel ${dx.toFixed(3)}x${dy.toFixed(3)} m at x[${rx0.toFixed(2)}..${rx1.toFixed(2)}] y[${ry0.toFixed(2)}..${ry1.toFixed(2)}] | door u[${u0.toFixed(3)}..${u1.toFixed(3)}] v[${v0.toFixed(3)}..${v1.toFixed(3)}] roundel(${LIVERY_ROUND.u},${LIVERY_ROUND.v}) r=${LIVERY_ROUND.r.toFixed(3)} | band u[${LIVERY_BAND.u0}..${LIVERY_BAND.u1}] v[${LIVERY_BAND.v0}..${LIVERY_BAND.v1}] strip u[${LIVERY_STRIP.u0}..${LIVERY_STRIP.u1}] v[${LIVERY_STRIP.v0}..${LIVERY_STRIP.v1}]`);
}
testLiveryGlassSeparation();

// ---------------------------------------------------------------- test 36
// Rollover (player report: a car flipped onto its roof still drove, scrubbing along
// upside down). Roof-down there must be no drive torque and no steering response, the
// state must classify as rolled, and the righting routine must have the car back on
// its wheels inside 2 s (0.8..1.2 s slerp + a small drop, then it settles).
function testRolloverRighting() {
  const w = new FlatWorld(SURF.DIRT);
  const car = makeCar(w, {});
  car.placeAt(0, 0, 0);
  // Start on its roof: half a turn about the body forward axis, lifted clear so the
  // hull takes the landing rather than the wheels being dragged through the road.
  car.body.quat.x = 1; car.body.quat.y = 0; car.body.quat.z = 0; car.body.quat.w = 0;
  car.body.pos.y += 0.9;
  car.body.refreshFrame();
  settleWheels(car);

  const full = { throttle: 1, brake: 0, steer: 1, handbrake: 1, shiftUp: 0, shiftDown: 0 };
  let rolled = false, maxDrive = 0, maxSteer = 0;
  drive(car, full, 1.2, (c) => {
    if (c.rollover.state === 'rolled') rolled = true;
    for (const wh of c.wheels) maxDrive = Math.max(maxDrive, Math.abs(wh.driveTorque));
    maxSteer = Math.max(maxSteer, Math.abs(c.steerAngle), Math.abs(c.wheels[0].steer), Math.abs(c.wheels[1].steer));
  });
  const deg = car.rollover.angleDeg;
  const omega = Math.max(...car.wheels.map((wh) => Math.abs(wh.omega)));

  car.rightNow(RIGHT_DURATION_S);
  let uprightAt = -1;
  const idle = { throttle: 0, brake: 0, steer: 0, handbrake: 0, shiftUp: 0, shiftDown: 0 };
  drive(car, idle, 2.0, (c, i) => {
    if (uprightAt < 0 && c.rollover.state === 'upright' && c.rollover.angleDeg < 40) uprightAt = (i + 1) * DT;
  });

  const ok = rolled && deg > UPSIDE_DEG && maxDrive === 0 && maxSteer < 1e-3 && omega < 2
    && uprightAt >= 0 && uprightAt <= 2.0 && car.rollover.angleDeg < 40;
  check('T36 rollover: a roof-down car gets no drive torque and no steering, classifies as rolled, and righting returns it upright within 2 s',
    ok,
    `rolled=${rolled} deg=${deg.toFixed(1)} (>${UPSIDE_DEG}) maxDriveTorque=${maxDrive} maxSteerRad=${maxSteer.toExponential(1)} wheelOmega=${omega.toFixed(2)} uprightAt=${uprightAt < 0 ? 'never' : uprightAt.toFixed(2) + ' s'} finalDeg=${car.rollover.angleDeg.toFixed(1)} finalUp=${car.body.up.y.toFixed(3)}`);
}
testRolloverRighting();

// T37 showroom route (?showroom=1): the car-only debug pose has to freeze the sim and
// hide the world, or the sheet-vs-game comparison compares a moving, cluttered frame.
// Same camera maths the Blender sheet uses (tools/blender/preview_model.py), asserted here.
function testShowroomRoute() {
  const cfg = showroomConfig('?frames=3600&shot=1&showroom=1&view=side');
  const off = showroomConfig('?shot=1');
  const route = showroomRoute();
  const src = readFileSync(new URL('../main.js', import.meta.url), 'utf8');
  // The shipped asset's own proportions: length 4.2, width 1.9, height 1.2.
  const bbox = { min: { x: -2.1, y: 0, z: -0.95 }, max: { x: 2.1, y: 1.2, z: 0.95 } };
  const side = showroomPose('side', bbox, 1400 / 880);
  const rear = showroomPose('rear', bbox, 1400 / 880);
  const tq = showroomPose('three-quarter', bbox, 1400 / 880);
  // preview_model.py: fw = 36/45, fh = fw * H/W, dist = max(seen/(fill*fw), h/((fill+.1)*fh))
  const fw = 36 / 45, fh = fw * 880 / 1400;
  const dSide = Math.max(4.2 / (0.70 * fw), 1.2 / (0.80 * fh));
  const dRear = Math.max(1.9 / (0.55 * fw), 1.2 / (0.65 * fh));
  const d3q = Math.max(4.2 / (0.55 * fw), 1.2 / (0.65 * fh));
  const near = (a, b) => Math.abs(a - b) < 1e-9;
  const ok = cfg.active && cfg.view === 'side' && !off.active
    && route.simFrozen && !route.streamWorld && !route.props && !route.pregen && !route.stageCache
    && route.hudMode === 'OFF'
    && near(side.dist, dSide) && near(rear.dist, dRear) && near(tq.dist, d3q)
    && side.pos.z === dSide && side.pos.x === 0 && side.look.x === 0 && side.look.z === 0
    && side.pos.y === (bbox.min.y + bbox.max.y) / 2 && side.look.y === side.pos.y   // side elevation: camera level with the car centre, zero vertical offset, on the car's lateral axis (x = cx, no tilt)
    && rear.pos.x === -dRear && near(rear.pos.y, 0.90)
    && near(tq.pos.x, d3q * 0.62) && near(tq.pos.z, d3q * 0.72) && near(tq.pos.y, 0.90 + d3q * 0.16)
    && near(tq.look.y, 4.2 * 0.30)   // aim = zmin + size*0.30, size = the max extent
    && /if \(!cfg\.showroom\) stream\.update/.test(src)
    && /cfg\.showroom[\s\S]{0,400}loop\.time\.paused = true/.test(src);
  check('T37 showroom route: ?showroom=1 freezes the sim, never streams or props the world, hides the HUD, and the sheet camera offsets match preview_model.py (side/front/rear/three-quarter)',
    ok,
    `active=${cfg.active} view=${cfg.view} off=${off.active} frozen=${route.simFrozen} stream=${route.streamWorld} hud=${route.hudMode} dist side=${side.dist.toFixed(2)} rear=${rear.dist.toFixed(2)} 3q=${tq.dist.toFixed(2)} (want ${dSide.toFixed(2)}/${dRear.toFixed(2)}/${d3q.toFixed(2)}) fov=${side.fovDeg.toFixed(1)}`);
}
testShowroomRoute();

// ---------------------------------------------------------------- test 38
// The flank projection is METRIC (one atlas scale per panel, not one planar map
// over the whole body), so a painted rect converts back to the same number of
// metres on u and on v. T38 uses that to prove the roundel/band/strip never
// reach a wheel, an arch or a glass face: their metre footprint must not
// overlap the x/y extent of any arch-panel vertex or of the glass region, and
// arch vertices are masked out of the livery mask entirely (aLiv 0).
function testRoundelClearsWheelsArchesGlass() {
  const w = new FlatWorld(SURF.DIRT);
  const params = makeCar(w, {}).params;
  const nodes = fakeNodes();
  nodes.get('car_panel').material = [{ name: 'rally_glass' }];
  const built = buildAssetBody(nodes, params);
  const M = built.livMetric;
  const X = (u) => (u - M.u0) / M.mu - M.halfX;
  const Y = (v) => (v - M.v0) / M.mu + M.yb;
  const rects = [
    ['band', X(LIVERY_BAND.u0), X(LIVERY_BAND.u1), Y(LIVERY_BAND.v0), Y(LIVERY_BAND.v1)],
    ['roundel', X(LIVERY_ROUND.u - LIVERY_ROUND.r), X(LIVERY_ROUND.u + LIVERY_ROUND.r), Y(LIVERY_ROUND.v - LIVERY_ROUND.r), Y(LIVERY_ROUND.v + LIVERY_ROUND.r)],
    ['strip', X(LIVERY_STRIP.u0), X(LIVERY_STRIP.u1), Y(LIVERY_STRIP.v0), Y(LIVERY_STRIP.v1)],
  ];
  // 1. every arch-panel + glass vertex stays out of the mask and out of the rects
  const inAny = (u, v) => rects.some(([, ax0, ax1, ay0, ay1]) => u >= ax0 && u <= ax1 && v >= ay0 && v <= ay1);
  let archVerts = 0, archBad = 0;
  for (let i = 0; i < built.count; i++) {
    if (!ARCH_PANELS.has(built.aPanel[i])) continue;
    archVerts++;
    if (built.aLiv[i] !== 0) archBad++;
  }
  // 2. glass region: no vertex inside a rect, and it starts above the paint
  let glassUvBad = 0, glassY = 9;
  const gr = built.ranges.glass;
  if (gr) for (let i = gr[0]; i < gr[1]; i++) {
    if (inAny(built.aLivUv[i * 2], built.aLivUv[i * 2 + 1])) glassUvBad++;
    glassY = Math.min(glassY, built.position[i * 3 + 1]);
  }
  // 3. metric overlap of the metre footprints against every arch box, and the
  //    roundel has to be a circle (equal u/v scale) of ~0.35 m
  // 3. the real geometry contract, in metres: every painted rect sits inside the
  //    door window - short of the inner edge of the nearest wheel, above the
  //    sill, below the belt line (where the glass starts) - and the roundel is a
  //    circle, not an ellipse, because the flank projection is isotropic.
  const wheelEdge = params.wheelbase / 2 - TYRE_BASE.r;      // inner wheel plane
  const sillTop = M.yb + 0.15 * built.scale, belt = M.yb + 0.82 * built.scale;
  let outside = 0;
  for (const [nm, x0, x1, y0, y1] of rects) {
    if (Math.abs(x0) > wheelEdge - 0.05 || Math.abs(x1) > wheelEdge - 0.05) outside++;
    if (y0 < sillTop || y1 > belt) outside++;
  }
  const diam = X(LIVERY_ROUND.u + LIVERY_ROUND.r) - X(LIVERY_ROUND.u - LIVERY_ROUND.r);
  const diamY = Y(LIVERY_ROUND.v + LIVERY_ROUND.r) - Y(LIVERY_ROUND.v - LIVERY_ROUND.r);
  const bandYTop = Y(LIVERY_BAND.v1);
  const ok = archVerts >= 4 && archBad === 0 && glassUvBad === 0 && outside === 0
    && bandYTop < glassY && Math.abs(diam - diamY) < 0.02 && diam > 0.30 && diam < 0.40;
  check('T38 roundel + band + strip uv rects never intersect a wheel arch, wheel or glass face, and the projection is metric (isotropic)',
    ok,
    `archVerts=${archVerts} archMaskedBad=${archBad} glassUvInRect=${glassUvBad} rectsOutsideDoorWindow=${outside} | roundel ${diam.toFixed(3)}x${diamY.toFixed(3)} m (want ~0.35) bandTop y=${bandYTop.toFixed(3)} < glassY=${glassY.toFixed(3)} | wheelEdge x=${wheelEdge.toFixed(2)} sill=${sillTop.toFixed(2)} belt=${belt.toFixed(2)} | rects ${rects.map((r) => `${r[0]} x[${r[1].toFixed(2)}..${r[2].toFixed(2)}] y[${r[3].toFixed(2)}..${r[4].toFixed(2)}]`).join(' ')} | flank u[${FLANK_UV.u0}..${(FLANK_UV.u0 + FLANK_UV.uSpan).toFixed(2)}] mu=${M.mu.toFixed(5)}`);
}
testRoundelClearsWheelsArchesGlass();

// ---------------------------------------------------------------------------
// T39 i18n (src/core/i18n.js): English is the default and Polish the selectable option.
// Walks the whole dictionary: both languages must define the same keys with non-empty
// strings, no English label may be wider than the pixel box it is drawn into (measured
// with the game's own font metrics at 1600x900 / 390x844 / 844x390, modal rows against
// the real drawn row rect), and the LANGUAGE row must re-render the menu and the HUD
// labels on the spot and persist settings.language.
function testI18nDictionaryCoversEveryLabel() {
  const gaps = [];
  const wasLang = getLang(), wasSetting = settings.language, wasFx = settings.fx;
  if (getLang() !== 'en') gaps.push(`default language is ${getLang()}, want en`);

  // ---- 1. the two dictionaries carry the same keys, both non-empty --------------
  const en = i18nTable('en'), pl = i18nTable('pl');
  const keysEn = Object.keys(en), keysPl = Object.keys(pl);
  for (const k of keysEn) if (!(k in pl)) gaps.push(`pl missing ${k}`);
  for (const k of keysPl) if (!(k in en)) gaps.push(`en missing ${k}`);
  for (const k of keysEn) {
    if (typeof en[k] !== 'string' || !en[k].trim()) gaps.push(`en ${k} empty`);
    if (typeof pl[k] !== 'string' || !pl[k].trim()) gaps.push(`pl ${k} empty`);
    if (en[k] === k || pl[k] === k) gaps.push(`${k} resolves to its own key`);
  }
  setLang('de');
  const fallback = tr('hud.engine');
  if (fallback !== 'ENGINE') gaps.push(`unknown language does not fall back to English (${fallback})`);
  if (tr('nope.not.a.key') !== 'nope.not.a.key') gaps.push('a missing key does not fall back to itself');
  setLang('en');

  // ---- 2. every fixed-size HUD / pad label fits its box in both languages ------
  const boxCount = Object.keys(TEXT_BOXES).length;
  for (const key of Object.keys(TEXT_BOXES)) {
    const [boxW, scale] = TEXT_BOXES[key];
    for (const lang of i18nLanguages()) {
      setLang(lang);
      const w = textWidth(tr(key), scale);
      if (w > boxW) gaps.push(`${key}/${lang} "${tr(key)}" ${w}px > ${boxW}px box`);
    }
  }
  setLang('en');

  // ---- 3. modal rows at three viewports: each label inside the drawn row rect --
  const sizes = [[1600, 900], [390, 844], [844, 390]];
  globalThis.window = { innerWidth: sizes[0][0], innerHeight: sizes[0][1], addEventListener() {} };
  const doc = new (class extends MenuStubDoc {
    createElement(tag) {
      const el = super.createElement(tag);
      if (tag === 'canvas') el.getContext = () => new Proxy({}, {
        get: (p, k) => (k in p ? p[k] : () => {}), set: (p, k, v) => { p[k] = v; return true; },
      });
      return el;
    }
  })();
  let rowsChecked = 0;
  for (const lang of ['en', 'pl']) {
    for (const [w, h] of sizes) {
      globalThis.window.innerWidth = w; globalThis.window.innerHeight = h;
      setLang(lang);
      const hud = new RallyHud(doc, { stages: [{ key: 'FOREST', label: 'Leśny' }] });
      hud.openMenu();
      for (const screen of ['menu', 'settings', 'controls']) {
        hud.openScreen(screen);
        hud._drawModal({});
        const TS = (hud.uiScale || 1) >= 2 ? 1 : 2;
        for (let i = 0; i < hud._rows.length; i++) {
          const rect = hud._menuRect[i];
          rowsChecked++;
          if (!rect || !rect[2]) { gaps.push(`${lang} ${w}x${h} ${screen} row ${i} has no drawn rect`); continue; }
          const tw = textWidth(hud._rows[i].label, TS);
          if (tw > rect[2] - 6) gaps.push(`${lang} ${w}x${h} ${screen} "${hud._rows[i].label}" ${tw}px > ${rect[2] - 6}px row`);
        }
      }
    }
  }
  setLang('en');

  // ---- 4. the LANGUAGE row re-renders menu + HUD labels, and persists ---------
  const menu = new RallyHud(new MenuStubDoc(), { stages: [{ key: 'FOREST', label: 'Leśny' }] });
  menu.openMenu(); menu.openScreen('settings');
  const langRow = menu.rowIndex('cycle:language');
  if (langRow < 0) gaps.push('the settings screen has no cycle:language row');
  const enRows = menu._rows.map((r) => r.label).join('|');
  if (!enRows.includes('Draw distance') || !enRows.includes('Language')) gaps.push(`menu is not English (${enRows.slice(0, 60)})`);
  settings.fx = true;
  menu.focus = langRow;
  const acted = menu.activate();
  const plRows = menu._rows.map((r) => r.label).join('|');
  const switched = getLang() === 'pl' && settings.language === 'pl';
  if (!acted || acted.act !== 'cycle:language') gaps.push('the row did not come back for main.js to save');
  if (!switched) gaps.push(`the row did not switch language (lang=${getLang()} setting=${settings.language})`);
  if (!plRows.includes('Zasięg rysowania') || !plRows.includes('Język')) gaps.push(`menu did not re-render in Polish (${plRows.slice(0, 60)})`);
  const store = (() => { const m = new Map(); return {
    store: m, getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, v), removeItem: (k) => m.delete(k),
  }; })();
  saveSettings(settings, store);
  const persisted = JSON.parse(store.store.get(SETTINGS_KEY)).language === 'pl';
  if (!persisted) gaps.push('settings.language is not persisted');
  menu.focus = langRow; menu.activate();
  const backEn = getLang() === 'en' && settings.language === 'en'
    && menu._rows.map((r) => r.label).join('|').includes('Draw distance');
  if (!backEn) gaps.push('the row did not switch back to English');

  // HUD labels: the wheel-condition strip re-labels on the same pass it is switched on.
  const SEED = 99, LEN = 900;
  const terrain = makeTerrain(SEED, 'FOREST');
  const road = buildRoad({ seed: SEED, lengthTarget: LEN, terrainHeightAt: terrain.heightAt, biome: 'FOREST' });
  const run = new StageRun({ road, gates: planGates(road, SEED), seed: SEED, refTime: 90 });
  const wheelStub = () => ({ alpha: 0, kappa: 0, N: 20000, slipEnergy: 0, airborneFrames: 0 });
  const car = { body: { pos: { x: road.x[12], z: road.z[12] }, groundSpeed: 14 }, wheels: [wheelStub(), wheelStub(), wheelStub(), wheelStub()] };
  const hudCtx = { car, stage: run, notes: [], stageName: 'STAGE 99' };
  globalThis.window.innerWidth = 1600; globalThis.window.innerHeight = 900;
  const hud = new RallyHud(new MenuStubDoc(), { stages: [{ key: 'FOREST', label: 'Leśny' }] });
  hud._drawWheels(hudCtx);
  setLang('en'); hud._drawWheels(hudCtx);
  const wheelEn = hud.gauges[0].val.textContent;
  setLang('pl'); hud._drawWheels(hudCtx);
  const wheelPl = hud.gauges[0].val.textContent;
  setLang('en'); hud._drawWheels(hudCtx);
  if (!wheelEn.includes('GRIP') || !wheelPl.includes('CZEPNE') || wheelEn === wheelPl) {
    gaps.push(`HUD wheel strip does not re-label (${wheelEn} / ${wheelPl})`);
  }
  setLang('en'); settings.language = 'en';
  delete globalThis.window;
  settings.fx = wasFx; setLang(wasLang); settings.language = wasSetting;

  check('T39 the i18n dictionary is complete in both languages, every label fits its pixel box at 1600x900 / 390x844 / 844x390, and the LANGUAGE row re-renders menu + HUD and persists',
    gaps.length === 0 && keysEn.length >= 90 && keysEn.length === keysPl.length && boxCount >= 20 && rowsChecked >= 120,
    `keys en=${keysEn.length} pl=${keysPl.length} boxes=${boxCount} rowsChecked=${rowsChecked} languageRow=${langRow} `
    + `switched=${switched} persisted=${persisted} wheelEn="${wheelEn}" wheelPl="${wheelPl}" | gaps=[${gaps.join(' ')}]`);
}
testI18nDictionaryCoversEveryLabel();

// ---------------------------------------------------------------- test 40
// Rally atmosphere + speed-feel layer (sun shafts, sun-keyed dirty lens, edge radial
// blur, camera feel, wheel dust). Headless: pass graph, dial table and the two hard
// zero-conditions (sun out of frame, speed zero) are all pure data.
const ATMO_RANGES = {
  'shafts.samples': [1, 8], 'shafts.decay': [0.1, 1], 'shafts.density': [0.05, 4],
  'shafts.drift': [0, 3], 'shafts.intensity': [0, 1.5], 'shafts.contrast': [0, 1],
  'shafts.spread': [0.05, 1], 'shafts.falloff': [0.1, 6], 'shafts.edgeFade': [0.05, 1],
  'lens.blobs': [1, 5], 'lens.ghosts': [0, 3], 'lens.smudge': [0, 1], 'lens.flare': [0, 1],
  'lens.halo': [0, 1], 'lens.spread': [0, 1], 'lens.edgeFade': [0.05, 1],
  'blur.maxStrength': [0, 0.12], 'blur.speedFull': [5, 120], 'blur.inner': [0, 0.5],
  'blur.outer': [0.2, 1], 'blur.taps': [1, 4],
};
const FEEL_RANGES = { speedFov: [0, 1], cornerLean: [0, 1], rideSag: [0, 1] };
const DUST_RANGES = {
  looseMul: [0, 2], hardMul: [0, 1], ttlMin: [0.1, 4], ttlSpan: [0, 4],
  windMul: [0, 1.5], drag: [0, 2], sizeLoose: [0.5, 2],
};

function testRallyAtmosphereBudget() {
  const gaps = [];
  const per = {};
  for (const [qName, q] of [['LOW', QUALITY.LOW], ['MED', QUALITY.MED], ['HIGH', QUALITY.HIGH]]) {
    qualityPreset(q);
    const g = passGraph({ post: settings.post, bloom: settings.bloom, shafts: true });
    const off = g.filter((p) => p.res !== 'canvas').length;
    per[qName] = { bloom: settings.bloom, n: g.length, off, names: g.map((p) => p.name) };
    if (g.length > MAX_POST_PASSES) gaps.push(`${qName}: ${g.length} passes > budget ${MAX_POST_PASSES}`);
    if (off > MAX_OFFSCREEN_PASSES) gaps.push(`${qName}: ${off} offscreen passes > budget ${MAX_OFFSCREEN_PASSES}`);
    if (g.filter((p) => p.kind === 'shafts').length !== 1) gaps.push(`${qName}: shafts pass is not exactly one quad`);
    if (g[g.length - 1].name !== 'composite') gaps.push(`${qName}: composite is no longer the last pass`);
    if (per[qName].off > (qName === 'LOW' ? 2 : 4) + 1) gaps.push(`${qName}: more than one pass added over the bloom graph`);
  }
  if (per.LOW.n !== 4 || per.MED.n !== 6 || per.HIGH.n !== 6) gaps.push(`pass count moved: ${per.LOW.n}/${per.MED.n}/${per.HIGH.n} (want 4/6/6)`);
  // POST off stays the zero-pass fallback, shafts included.
  if (passGraph({ post: false, bloom: 'HIGH', shafts: true }).length !== 0) gaps.push('POST off still builds passes');
  // every new dial finite and inside its pinned range
  const walk = (obj, ranges, path) => {
    for (const [k, v] of Object.entries(obj)) {
      const p = path ? `${path}.${k}` : k;
      if (v && typeof v === 'object') { walk(v, ranges, p); continue; }
      if (!Number.isFinite(v)) { gaps.push(`${p} is not finite (${v})`); continue; }
      const r = ranges[p];
      if (!r) gaps.push(`${p} has no pinned range`);
      else if (v < r[0] || v > r[1]) gaps.push(`${p}=${v} outside ${r[0]}..${r[1]}`);
    }
  };
  walk(ATMO_TUNE, ATMO_RANGES, '');
  walk(DUST_TUNE, DUST_RANGES, '');
  const feel = {}; for (const k of Object.keys(FEEL_RANGES)) feel[k] = settings[k];
  walk(feel, FEEL_RANGES, '');
  // garbage in -> finite, clamped out
  const bad = [NaN, Infinity, -1e9, 1e9, undefined, '4'];
  for (const v of bad) {
    for (const a of [
      shaftAlpha({ post: true, bloom: 'HIGH', sunVis: v, sun: v }),
      radialBlurAmount({ post: true, speed: v, gain: v }),
      lensFlareAlpha({ post: true, sunVis: v, lensDirt: v }),
      sunVisibility(v, v, v, v),
    ]) if (!Number.isFinite(a) || a < 0 || a > 1.5) gaps.push(`clamp leaked ${a} for input ${v}`);
  }
  // the two hard zeros: sun out of frame, and a standstill
  if (shaftAlpha({ post: true, bloom: 'HIGH', sunVis: 0, sun: 1 }) !== 0) gaps.push('shaft alpha is not 0 with the sun out of frame');
  if (lensFlareAlpha({ post: true, sunVis: 0, lensDirt: 1 }) !== 0) gaps.push('lens flare is not 0 with the sun out of frame');
  if (radialBlurAmount({ post: true, speed: 0 }) !== 0) gaps.push('radial blur is not 0 at a standstill');
  if (shaftAlpha({ post: false, bloom: 'HIGH', sunVis: 1, sun: 1 }) !== 0) gaps.push('shafts light a frame with POST off');
  if (radialBlurAmount({ post: false, speed: 90 }) !== 0) gaps.push('radial blur runs with POST off');
  if (sunVisibility(0.1, 0.1, false) !== 0) gaps.push('sun behind the camera still lit the shafts');
  if (sunVisibility(9, 9, true) !== 0) gaps.push('sun far outside the frame still lit the shafts');
  const full = radialBlurAmount({ post: true, speed: 1e9 });
  if (full > ATMO_TUNE.blur.maxStrength + 1e-9) gaps.push(`radial blur ${full} exceeded its cap ${ATMO_TUNE.blur.maxStrength}`);
  const shMax = shaftAlpha({ post: true, bloom: 'HIGH', sunVis: 1, sun: 1e9 });
  if (shMax > ATMO_TUNE.shafts.intensity + 1e-9) gaps.push(`shaft alpha ${shMax} exceeded its ceiling ${ATMO_TUNE.shafts.intensity}`);
  // wheel dust: surface-keyed, longer-lived, and the pools never grew
  if (!(DUST_TUNE.hardMul < DUST_TUNE.looseMul)) gaps.push('dust is not keyed loose > hard');
  if (!(DUST_TUNE.ttlMin > 0.5 && DUST_TUNE.ttlMin + DUST_TUNE.ttlSpan > 1.4)) gaps.push('dust plume is not longer lasting');
  const fxS = new FxSystem({ scale: 1 });
  for (const k of Object.keys(FX_CAPACITY)) {
    if (fxS[k].capacity !== FX_CAPACITY[k]) gaps.push(`${k} capacity grew: ${fxS[k].capacity} != ${FX_CAPACITY[k]}`);
  }
  qualityPreset(QUALITY.MED);
  check('T40 the atmosphere/feel layer stays inside its budget: 4 passes at LOW and 6 at MED/HIGH (never > 6, one shaft quad, POST off = 0), every new tunable finite and clamped, and the shaft/lens/blur intensity is exactly 0 when the sun is out of frame or the speed is 0',
    gaps.length === 0,
    `LOW ${per.LOW.n} [${per.LOW.names}] | MED ${per.MED.n} [${per.MED.names}] | HIGH ${per.HIGH.n} [${per.HIGH.names}] | budget ${MAX_POST_PASSES} passes / ${MAX_OFFSCREEN_PASSES} offscreen | shaft max ${shMax.toFixed(3)} blur max ${full.toFixed(4)} | dust ${DUST_TUNE.hardMul}/${DUST_TUNE.looseMul} ttl ${DUST_TUNE.ttlMin}+${DUST_TUNE.ttlSpan} caps ${Object.keys(FX_CAPACITY).map((k) => fxS[k].capacity).join('/')} | gaps=[${gaps.join(' ')}]`);
}
testRallyAtmosphereBudget();

// ------------------------------------------------ night beam ramp (queue P8, third half)
// T29 proved the beams run, T30 proved the pool is the size of the shaft. Neither one
// looked at the frame: the first night capture (seed 95, DUSK tod 0.85, bumper cam)
// showed the shafts as two solid pale cards welded to the nose - the ramp opened at
// a=0.34 *at the lens*, and every driver camera (BUMPER/ONBOARD, and CHASE close in)
// sits at lamp height *inside* the cone, so the near wall of both shells filled the
// lower half of the screen while the far half, where the pool actually lights the
// road, was the dim part of the curve. The shaft also outranked the road it drew over.
// Pinned: the shell contributes nothing at the lens, stays quiet through the part of
// the cone the camera is inside, peaks over the lit ground rather than on the
// dashboard, is a single rise and fall (banded = geometry), never outranks the pool it
// belongs to, and still costs one cheap volume.
function testShaftRampReadsAsLightNotAsGeometry() {
  const p = CARS.A;
  const shape = { hx: p.hull.x, hz: p.hull.z, floor: -p.comY + 0.15 };
  const gaps = [];
  const peak = shaftPeak();

  // ends: nothing at the lens, nothing at the far end, one rise and one fall
  if (shaftWallAlpha(0) !== 0) gaps.push(`the shell starts at alpha ${shaftWallAlpha(0)} on the lens: the camera is inside the cone`);
  if (shaftWallAlpha(1) !== 0) gaps.push(`the shell ends at alpha ${shaftWallAlpha(1)}: a hard cut in mid-air`);
  let nearWall = 0;
  for (let i = 0; i <= 40; i++) nearWall = Math.max(nearWall, shaftWallAlpha(0.2 * i / 40) * BEAM.gain);
  if (!(nearWall <= peak.wall * 0.5)) gaps.push(`the first ${(0.2 * BEAM.reach).toFixed(0)} m run at ${((100 * nearWall) / peak.wall).toFixed(0)} % of peak: a pale card on the nose`);
  let turns = 0, sgn = 0;
  for (let i = 1; i <= 200; i++) {
    const d = shaftWallAlpha(i / 200) - shaftWallAlpha((i - 1) / 200);
    const s = Math.sign(d);
    if (s && sgn && s !== sgn) turns++;
    if (s) sgn = s;
  }
  if (turns > 1) gaps.push(`the ramp changes direction ${turns} times: a banded shaft reads as geometry`);

  // brightest part of the shaft stands over ground the pool actually lights
  if (!(peak.t >= 0.35 && peak.t <= 0.75)) gaps.push(`the shaft peaks ${(peak.t * BEAM.reach).toFixed(1)} m into a ${BEAM.reach} m beam, not over the middle of the pool`);
  const under = poolIlluminance(shape, shape.hx + peak.t * BEAM.reach, 0);
  if (!(under >= 0.8)) gaps.push(`the shaft peaks over ground that only gets ${under.toFixed(2)} of light: the shaft and its pool are two separate blobs`);

  // brightness: visible haze, never a wall, and never brighter than the lit road
  if (!(peak.core >= 0.10 && peak.core <= 0.26)) gaps.push(`the core of the shaft adds ${peak.core.toFixed(3)} of light: a fog bank or invisible`);
  let worst = 0;
  for (let i = 0; i <= 100; i++) worst = Math.max(worst, 2 * shaftWallAlpha(i / 100) * BEAM.gain);
  if (!(worst <= 0.30)) gaps.push(`the shaft core reaches ${worst.toFixed(3)} at its worst sample`);
  if (!(BEAM.gain >= 0.05 && BEAM.gain <= 0.2)) gaps.push(`per-wall gain ${BEAM.gain} is outside the pinned haze band`);

  // the cone still opens out from a lens-sized first ring, still costs one volume
  let rPrev = -1, rOpen = true;
  for (const r of BEAM.rings) { if (r.r < rPrev) rOpen = false; rPrev = r.r; }
  if (!rOpen) gaps.push('the shell rings do not open out along the beam');
  if (!(BEAM.rings[0].r <= 0.15)) gaps.push(`the first ring is ${BEAM.rings[0].r} m across, not a lens`);
  const tris = beamTriangleCount();
  if (!(tris > 0 && tris <= 160)) gaps.push(`${tris} tris is not a cheap volume`);
  if (beamGeometry().tris * 2 !== tris) gaps.push(`the ramp costs ${tris} tris, geometry built ${beamGeometry().tris * 2}`);

  check('T41 the night shaft reads as light, not as geometry: nothing at the lens, peak over the lit pool, one rise and fall, brighter haze never outranks the road',
    gaps.length === 0,
    `rings t ${BEAM.rings.map((r) => r.t).join('/')} r ${BEAM.rings.map((r) => r.r).join('/')} a ${BEAM.rings.map((r) => r.a).join('/')} gain ${BEAM.gain} `
    + `| peak ${(peak.t * BEAM.reach).toFixed(1)} m of ${BEAM.reach} m core ${peak.core.toFixed(3)} max ${worst.toFixed(3)} near-quarter ${(100 * nearWall / peak.wall).toFixed(0)}% turns=${turns} `
    + `| lit ground under peak ${under.toFixed(2)} | tris=${tris} (budget 160) | gaps=[${gaps.join(' ')}]`);
}
testShaftRampReadsAsLightNotAsGeometry();

// ---------------------------------------------------------------- test 42
// Livery legibility (queue P9: the door number stops reading past ~15 m). Three things
// have to hold at once, and all three are measurable headless: the number is GEOMETRY
// (blocks of the HUD's own bitmap, not a system-font glyph), its strokes are thick
// enough to survive a mip box, and the texture is actually minified through a mip chain
// instead of nearest-neighbour, which is what punched holes in the digit on screen.
function testLiveryNumberReadsAtDistance() {
  const src = readFileSync(new URL('../render/car-livery.js', import.meta.url), 'utf8');
  const gaps = [];
  const disc = LIVERY_ROUND.r * LIVERY_TEXEL * 2;      // the 0.35 m roundel, in texels
  if (!(LIVERY_TEXEL >= 1024)) gaps.push(`atlas is ${LIVERY_TEXEL} texels`);
  if (!(disc >= 36)) gaps.push(`roundel is only ${disc.toFixed(1)} texels across`);

  let capFrac = 1, stroke = 1e9, coverMin = 1, coverMax = 0, spill = 0, rectsTotal = 0;
  const detail = [];
  for (const id of ['A', 'B', 'C', 'D']) {
    const n = liveryNumberRects(id);
    if (!n.rects.length) { gaps.push(`${id}: no number geometry`); continue; }
    rectsTotal += n.rects.length;

    // 1. the whole lit box, bold growth included, stays inside the white disc
    let out = 0;
    for (const [x, y, w, h] of n.rects) {
      for (const [px, py] of [[x, y], [x + w, y], [x, y + h], [x + w, y + h]]) {
        out = Math.max(out, Math.hypot(px - n.cx, py - n.cy) - n.r);
      }
    }
    spill = Math.max(spill, out);
    if (out > 0) gaps.push(`${id}: the number leaves the roundel by ${out.toFixed(2)} texels`);

    // 2. centred on the roundel, and the lit box measures what it claims to
    let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
    for (const [x, y, w, h] of n.rects) {
      x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x + w); y1 = Math.max(y1, y + h);
    }
    if (Math.abs((x0 + x1) / 2 - n.cx) > 1 || Math.abs((y0 + y1) / 2 - n.cy) > 1) {
      gaps.push(`${id}: number off the roundel centre by ${((x0 + x1) / 2 - n.cx).toFixed(2)},${((y0 + y1) / 2 - n.cy).toFixed(2)}`);
    }
    if (Math.abs((x1 - x0) - (n.inkW * n.cell + n.bold)) > 1 || Math.abs((y1 - y0) - n.cap) > 1) {
      gaps.push(`${id}: lit box ${x1 - x0}x${y1 - y0} disagrees with cell ${n.cell} cap ${n.cap}`);
    }

    // 3. size + stroke: a stroke must still carry ink two mip levels down (a 4x4 texel
    //    box), which is where a 0.35 m roundel sits at ~18-20 m on a 1080p screen.
    const s = n.cell + n.bold;
    stroke = Math.min(stroke, s);
    capFrac = Math.min(capFrac, n.cap / disc);
    if (n.cap < 0.5 * disc) gaps.push(`${id}: cap ${n.cap} of a ${disc.toFixed(0)} texel roundel is a dot, not a number`);
    if (s < 4) gaps.push(`${id}: ${s} texel strokes vanish in the 4x mip box`);

    // ink share of the disc: enough to read, never a blob that reads as a dark plate.
    // Rasterise in a frame centred on the roundel (the rects live at u 0.25 / v 0.09 of
    // a 1024 canvas, so a local grid is the only sane window).
    const W = Math.ceil(disc) + 4, ox = n.cx - W / 2, oy = n.cy - W / 2;
    const g = new Uint8Array(W * W);
    for (const [x, y, w, h] of n.rects) {
      for (let iy = Math.round(y - oy); iy < Math.round(y - oy) + h; iy++) {
        for (let ix = Math.round(x - ox); ix < Math.round(x - ox) + w; ix++) {
          if (ix >= 0 && iy >= 0 && ix < W && iy < W) g[iy * W + ix] = 1;
        }
      }
    }
    let ink = 0, area = 0;
    for (let iy = 0; iy < W; iy++) {
      for (let ix = 0; ix < W; ix++) {
        if (Math.hypot(ix + 0.5 - (n.cx - ox), iy + 0.5 - (n.cy - oy)) > n.r) continue;
        area++;
        if (g[iy * W + ix]) ink++;
      }
    }
    const cover = area ? ink / area : 0;
    coverMin = Math.min(coverMin, cover); coverMax = Math.max(coverMax, cover);
    if (!(cover >= 0.10 && cover <= 0.50)) gaps.push(`${id}: number covers ${(cover * 100).toFixed(0)}% of the roundel`);
    detail.push(`${id}'${n.label}' cell ${n.cell}+${n.bold} cap ${n.cap}/${disc.toFixed(0)} cover ${(cover * 100).toFixed(0)}% rects ${n.rects.length}`);
  }

  // 4. the sampler: minifying with NearestFilter and no mip chain is the defect itself,
  //    so build the texture through a stub DOM/three and read back what it asks for.
  const prevDoc = globalThis.document;
  const drawn = [];
  const ctx2d = new Proxy({ fillRect: (x, y, w, h) => drawn.push([x, y, w, h]) }, {
    get: (p, k) => (k in p ? p[k] : () => {}), set: (p, k, v) => { p[k] = v; return true; },
  });
  globalThis.document = { createElement: () => ({ width: 0, height: 0, getContext: () => ctx2d }) };
  const F = { Nearest: 1003, Mip: 1008, Linear: 1006, Clamp: 33071 };
  let tex = null;
  try {
    tex = buildLiveryTexture('A', {
      NearestFilter: F.Nearest, LinearMipmapLinearFilter: F.Mip, LinearFilter: F.Linear,
      ClampToEdgeWrapping: F.Clamp, SRGBColorSpace: 'srgb',
      CanvasTexture: class { constructor(img) { this.image = img; } },
    });
  } finally { globalThis.document = prevDoc; }
  if (!tex) gaps.push('buildLiveryTexture did not return a texture');
  else {
    if (tex.image.width !== LIVERY_TEXEL || tex.image.height !== LIVERY_TEXEL) gaps.push(`canvas ${tex.image.width}x${tex.image.height}`);
    if (tex.magFilter !== F.Nearest) gaps.push('magnification is no longer nearest (the block digit turns to mush up close)');
    if (tex.minFilter !== F.Mip) gaps.push(`minFilter ${tex.minFilter} is not a mipmap filter`);
    if (tex.generateMipmaps !== LIVERY_SAMPLE.mips || LIVERY_SAMPLE.mips !== true) gaps.push('no mip chain is generated');
    if (!(tex.anisotropy >= 4)) gaps.push(`anisotropy ${tex.anisotropy} cannot hold a flank seen at a graze angle`);
  }
  // the paint path must actually draw the geometry, and must not go back to a font
  if (drawn.length < liveryNumberRects('A').rects.length + 3) gaps.push(`drawLivery painted ${drawn.length} rects for ${liveryNumberRects('A').rects.length} number cells + 3 fields`);
  const code = src.split('\n').filter((l) => !/^\s*(\/\/|\/\*|\*)/.test(l)).join('\n');
  if (/ctx\.font\s*=|fillText\s*\(/.test(code)) gaps.push('car-livery.js paints the number with a system font again');
  if (!/LIVERY_NUM/.test(src)) gaps.push('the number block spec is not used by the paint path');

  // 5. the ?sheetDist knob T42 measured with: the sheet frames at ~8 m, which cannot
  //    answer "does it still read at 20 m".
  const sc = showroomConfig('?showroom=1&view=side&sheetDist=22');
  const pose = showroomPose('side', { min: { x: -2.1, y: 0, z: -0.95 }, max: { x: 2.1, y: 1.2, z: 0.95 } }, 16 / 9, sc.dist);
  const poseDefault = showroomPose('side', { min: { x: -2.1, y: 0, z: -0.95 }, max: { x: 2.1, y: 1.2, z: 0.95 } }, 16 / 9);
  if (!(sc.active && sc.dist === 22)) gaps.push(`?sheetDist=22 parsed as ${sc.dist}`);
  if (!(pose.dist === 22 && poseDefault.dist !== 22)) gaps.push('sheetDist does not move the showroom camera');
  if (!(sc.dist > poseDefault.dist)) gaps.push('the knob moved the camera closer, not further');

  check('T42 the door number is geometry that reads at distance: pixel-bitmap blocks, strokes >= a 4x mip box, cap >= half the roundel, inside the disc, centred, painted through a mip-sampled 1024 atlas, never a font glyph',
    gaps.length === 0,
    `atlas ${LIVERY_TEXEL} | roundel ${disc.toFixed(1)} texels = ${(LIVERY_ROUND.r * 2 / (0.46 / 4.114)).toFixed(3)} m | min cap ${(capFrac * 100).toFixed(0)}% of the roundel, min stroke ${stroke} texels, cover ${(coverMin * 100).toFixed(0)}-${(coverMax * 100).toFixed(0)}%, spill ${spill.toFixed(2)}, rects ${rectsTotal} | min ${LIVERY_TEXEL >= 1024 ? 'ok' : 'low'} | aniso ${tex && tex.anisotropy} minFilter ${tex && tex.minFilter} mag ${tex && tex.magFilter} | drawn ${drawn.length} | sheetDist ${sc.dist} vs ${poseDefault.dist.toFixed(2)} | ${detail.join(' ')} | gaps=[${gaps.join(' ')}]`);
}
testLiveryNumberReadsAtDistance();

// ---------------------------------------------------------------- touch layout (P10)
// The left-handed overlay used to be five `#touch-ui.lefty` rules plus a scaleX(-1)
// cluster and a counter-flip on its buttons: nothing could prove it, because no layout
// engine runs in node. The geometry now lives in src/game/touch-layout.js, so the whole
// overlay contract is assertable: real phone viewports x both handednesses must hold
// every pad inside the screen and inside the band the HUD owns, never under the 72 px
// minimum target, never on top of another pad, and the left-handed overlay must be the
// exact mirror of the right-handed one, pad for pad.
function testTouchLayoutIsMirroredGeometry() {
  const touchSrc = readFileSync(new URL('../game/touch.js', import.meta.url), 'utf8');
  const mainSrc = readFileSync(new URL('../main.js', import.meta.url), 'utf8');
  // Real configurations with the safe-area insets each one actually reports: a notch
  // costs the left/right edges in landscape, a home bar costs the bottom in portrait.
  const DEVICES = [
    ['phone 667x375', 667, 375, {}],
    ['phone 320x568', 320, 568, {}],
    ['notch 844x390', 844, 390, { left: 47, right: 47, bottom: 0 }],
    ['notch 390x844', 390, 844, { left: 0, right: 0, bottom: 34 }],
    ['notch 896x414', 896, 414, { left: 44, right: 44, bottom: 0 }],
    ['android 915x412', 915, 412, {}],
    ['android 412x915', 412, 915, { left: 0, right: 0, bottom: 24 }],
    ['tablet 1024x768', 1024, 768, {}],
    ['tablet 768x1024', 768, 1024, {}],
    ['desktop 1280x720', 1280, 720, {}],
    ['desktop 1920x1080', 1920, 1080, {}],
  ];
  const gaps = [];
  let minHit = 1e9, minGapArea = 1e9, mirrors = 0, fits = 0;
  for (const [name, W, H, safe] of DEVICES) {
    for (const hand of ['right', 'left']) {
      const L = padRects({ width: W, height: H, handedness: hand, safe });
      const R = padRects({ width: W, height: H, handedness: hand === 'left' ? 'right' : 'left', safe });
      for (const g of layoutDefects(L)) gaps.push(`${name}/${hand}: ${g}`);
      // exact mirror, every pad and both group boxes
      const m = rectMap(L), r = rectMap(R);
      for (const k in m) {
        if (!r[k]) { gaps.push(`${name}/${hand}: ${k} has no mirror counterpart`); continue; }
        if (m[k].x !== W - r[k].x - r[k].w || m[k].y !== r[k].y || m[k].w !== r[k].w || m[k].h !== r[k].h) {
          gaps.push(`${name}/${hand}: ${k} is not the mirror (${m[k].x} vs ${W - r[k].x - r[k].w})`);
        }
      }
      mirrors += Object.keys(m).length;
      // the band the HUD is told about: never lower than the contract, never absurd
      if (L.band < TOUCH_BAND || L.band > BAND_MAX) gaps.push(`${name}/${hand}: band ${L.band} outside ${TOUCH_BAND}..${BAND_MAX}`);
      // the only thing allowed to push a pad up is the bottom inset it sits on
      if (L.top > TOUCH_BAND + (safe.bottom || 0)) gaps.push(`${name}/${hand}: pads climb to ${L.top} px`);
      if (L.handedness !== hand) gaps.push(`${name}: handedness reported as ${L.handedness}`);
      // handedness is a real swap of sides, not a container turned inside out
      if ((m.throttle.x - m.steer.x > 0) !== (hand === 'right')) gaps.push(`${name}: drive pads did not change side`);
      for (const p of L.pads) if (p.hit) minHit = Math.min(minHit, p.w, p.h);
      for (let i = 0; i < L.pads.length; i++) {
        for (let j = i + 1; j < L.pads.length; j++) {
          const a = L.pads[i].y + L.pads[i].h <= L.pads[j].y || L.pads[j].y + L.pads[j].h <= L.pads[i].y
            ? Math.abs(L.pads[i].x - (L.pads[j].x + L.pads[j].w))
            : Math.abs(L.pads[i].x + L.pads[i].w - L.pads[j].x);
          minGapArea = Math.min(minGapArea, a);
        }
      }
      fits++;
    }
  }
  // the model has to reach the DOM, and handedness has to move it (stub root, no browser)
  const els = {};
  for (const cls of Object.values(PAD_CLS)) els[cls] = { style: {} };
  for (const cls of Object.values(GROUP_CLS)) els[cls] = { style: {} };
  const root = { style: {}, querySelector: (sel) => els[sel.slice(1)] || null };
  const placedRight = applyPadLayout(root, padRects({ width: 844, height: 390, handedness: 'right', safe: { left: 47, right: 47 } }));
  const rightSteer = els['tg-steer'].style.left, rightHand = els['tg-hand'].style.left;
  const placedLeft = applyPadLayout(root, padRects({ width: 844, height: 390, handedness: 'left', safe: { left: 47, right: 47 } }));
  if (placedRight !== 9 || placedLeft !== 9) gaps.push(`applyPadLayout placed ${placedRight}/${placedLeft} boxes of 9`);
  if (rightSteer === els['tg-steer'].style.left || rightHand === els['tg-hand'].style.left) gaps.push('handedness did not move the pad boxes');
  const lm = rectMap(padRects({ width: 844, height: 390, handedness: 'left', safe: { left: 47, right: 47 } }));
  if (els['tg-steer'].style.left !== `${lm.steer.x}px` || els['tg-throttle'].style.left !== `${lm.throttle.x - lm.cluster.x}px`) {
    gaps.push(`the DOM did not get the modelled rects (steer ${els['tg-steer'].style.left}, throttle ${els['tg-throttle'].style.left})`);
  }
  if (root.style['--s'] == null && root.style.setProperty === undefined) gaps.push('--s was never written from the resolved scale');
  // the CSS must stop owning pad geometry, or the two owners can disagree again
  const css = (touchSrc.match(/const STYLE = `([\s\S]*?)`;/) || [''])[1];
  if (!css) gaps.push('the overlay style block is gone');
  for (const forbidden of ['scaleX(-1)', '.lefty', 'width:calc(214px', 'width:calc(318px', 'width:calc(248px', '--sa-l', '--edge']) {
    if (css.includes(forbidden)) gaps.push(`CSS still owns geometry: "${forbidden}"`);
  }
  if (!/padRects\(/.test(touchSrc) || !/applyPadLayout\(/.test(touchSrc)) gaps.push('touch.js no longer resolves and applies the layout');
  if (!/this\._layout\(\)/.test(touchSrc.match(/setHandedness\([\s\S]{0,400}/)?.[0] || '')) gaps.push('setHandedness no longer re-lays out the overlay');
  if (!/input\.touch\.band\(\)/.test(mainSrc)) gaps.push('main.js does not ask the layout how much band the HUD must keep');
  if (parseHandedness('?touch=on&hand=left') !== 'left' || parseHandedness('?hand=RIGHT') !== 'right' || parseHandedness('?q=LOW') !== null) {
    gaps.push('the ?hand= verification hook does not parse');
  }
  if (minHit < MIN_HIT) gaps.push(`a tap target shrank to ${minHit} px`);

  check('T43 the thumb overlay is modelled geometry, not CSS: across real phone viewports and both handednesses no pad overlaps, leaves the screen, climbs over the HUD band or falls under the 72 px target, the left-handed layout is the exact mirror of the right-handed one, the boxes reach the DOM, and no scaleX(-1) mirror hack is left',
    gaps.length === 0,
    `${fits} viewport x handedness configs, ${mirrors} mirrored rects, min tap target ${minHit} px, min edge clearance ${minGapArea} px | 844x390 steer ${rightSteer} -> ${els['tg-steer'].style.left}, hand ${rightHand} -> ${els['tg-hand'].style.left} | placed ${placedRight}/${placedLeft} | gaps=[${gaps.join(' ')}]`);
}
testTouchLayoutIsMirroredGeometry();

// -------------------------------------------------- model request scheduling (P41)
// Two passes in a row recorded "the hero car is not in frame" and each blamed a
// different thing (P33: the fetch failed although curl says 200; P41: the glb has
// no named nodes). Both were the same event: at boot the game asks for three glbs
// at once on a server that accepts with a 5-deep backlog (`LISTEN 0 5` on :8090,
// HTTP/1.0 so no keep-alive) while ~60 module requests are in flight, so one
// connection sits out a SYN retransmit and its fetch is aborted when the shot
// harness stops the page. The scheduling policy is therefore code, not prose, and
// this check runs it in node with a fake attempt and a fake timer.
async function testModelRequestsAreQueuedAndRetried() {
  const assetsSrc = readFileSync(new URL('../render/assets.js', import.meta.url), 'utf8');
  const carSrc = readFileSync(new URL('../render/carMesh.js', import.meta.url), 'utf8');
  const gaps = [];

  // ---- 1. the published policy: serialized, retried, and bounded ----
  if (MODEL_QUEUE.concurrency !== 1) gaps.push(`concurrency ${MODEL_QUEUE.concurrency}, the boot burst needs one model at a time`);
  if (MODEL_QUEUE.attempts < 3) gaps.push(`only ${MODEL_QUEUE.attempts} attempts per model`);
  if (MODEL_QUEUE.maxSessionAttempts <= MODEL_QUEUE.attempts) gaps.push('the session attempt budget does not exceed one request');
  if (MODEL_QUEUE.backoffMs.some((v) => !(v > 0))) gaps.push('a retry backoff is not positive');
  if (nextBackoffMs(1) >= nextBackoffMs(2)) gaps.push('the backoff does not grow between tries');
  if (nextBackoffMs(9) !== MODEL_QUEUE.backoffMs[MODEL_QUEUE.backoffMs.length - 1]) gaps.push('the backoff runs off the end of its table');

  // ---- 2. real scheduling behaviour, with an instrumented fake loader ----
  const waits = [];
  const q = new ModelQueue({ wait: (ms) => { waits.push(ms); return Promise.resolve(); } });
  let live = 0, maxLive = 0, calls = 0;
  const order = [];
  const slow = (name) => async () => {
    calls++; order.push(name); live++; maxLive = Math.max(maxLive, live);
    await Promise.resolve(); live--;
    return name;
  };
  const three = await Promise.all(['rally_v2', 'props', 'stage_blocks'].map((n) => q.run(n, slow(n))));
  if (maxLive > MODEL_QUEUE.concurrency) gaps.push(`${maxLive} model requests in flight at once`);
  if (three.join(',') !== 'rally_v2,props,stage_blocks') gaps.push(`the queue returned ${three.join(',')}`);
  if (order.join(',') !== 'rally_v2,props,stage_blocks') gaps.push('the queue is not FIFO');
  if (q.inflight !== 0 || q.queued !== 0 || q.waiting !== 0) gaps.push(`the queue left work behind (${q.inflight}/${q.queued}/${q.waiting})`);

  // ---- 3. a transient failure is retried, and the recovery is what resolves ----
  let flaky = 0;
  const recovered = await q.run('flaky', async () => {
    calls++;
    flaky++;
    if (flaky === 1) throw new Error('Failed to fetch');
    return 'ok';
  });
  if (recovered !== 'ok') gaps.push('a model that failed once never recovered');
  if (q.tries('flaky') !== 2) gaps.push(`flaky took ${q.tries('flaky')} tries`);
  const flakyWaits = waits.slice();
  if (flakyWaits.length !== 1 || flakyWaits[0] !== nextBackoffMs(1)) {
    gaps.push(`the retry did not wait exactly one backoff of ${nextBackoffMs(1)} ms (${flakyWaits.join(',')})`);
  }

  // ---- 4. a hard failure stops after `attempts`, and stays retryable later ----
  const hard = await q.run('missing', async () => { calls++; throw new Error('404'); }).then(
    () => { gaps.push('a permanently missing model resolved as if it loaded'); return null; },
    (e) => e && e.message);
  if (hard !== '404') gaps.push(`the last error reported was "${hard}"`);
  const hardTries = q.tries('missing'), hardWaits = waits.length - flakyWaits.length;
  if (hardTries !== MODEL_QUEUE.attempts) gaps.push(`missing took ${hardTries} tries of ${MODEL_QUEUE.attempts}`);
  if (hardWaits !== MODEL_QUEUE.attempts - 1) gaps.push(`${hardWaits} backoffs for ${hardTries} tries`);
  if (!/404/.test(q.lastFailure('missing'))) gaps.push('the recorded failure reason is empty');
  let revived = 0;
  const secondShot = await q.run('missing', async () => { revived++; return 'back'; });
  if (secondShot !== 'back' || revived !== 1) gaps.push('a failed name can never be asked again');

  // ---- 5. the session budget bounds it: no infinite retry loop ----
  const bounded = new ModelQueue({ attempts: 2, maxSessionAttempts: 3, wait: () => Promise.resolve() });
  let asks = 0;
  const fail = async () => { asks++; throw new Error('gone'); };
  for (let round = 0; round < 3; round++) {
    await bounded.run('gone', fail).catch(() => {});
  }
  const budgetErr = await bounded.run('gone', fail).then(() => '', (e) => e && e.message);
  if (asks !== 3) gaps.push(`the budget let ${asks} asks through for one name`);
  if (!/attempt budget/.test(budgetErr)) gaps.push(`past the budget the error was "${budgetErr}"`);

  // ---- 6. two callers asking for one model share one request ----
  const dup = new ModelQueue({ wait: () => Promise.resolve() });
  let dupAsks = 0;
  const [a, b] = await Promise.all([
    dup.run('props', async () => { dupAsks++; return 1; }),
    dup.run('props', async () => { dupAsks++; return 2; }),
  ]);
  if (dupAsks !== 1 || a !== 1 || b !== 1) gaps.push(`the same name was requested ${dupAsks} times`);

  // ---- 7. the loader wires this up, and stops blaming the asset for a fetch ----
  if (!/from '\.\/model-queue\.js'/.test(assetsSrc)) gaps.push('assets.js does not use the model queue');
  if (!/queue\.run\(/.test(assetsSrc)) gaps.push('assets.js fires its request outside the queue');
  if (!/cache\.delete\(key\)/.test(assetsSrc)) gaps.push('a failed load stays cached: one starved connection pins the fallback for the session');
  if (!/nodes\.reason\s*=/.test(assetsSrc) || !/nodes\.source\s*=/.test(assetsSrc)) gaps.push('loadModelNodes does not report which failure it was');
  if (/return new Map\(\);/.test(assetsSrc)) gaps.push('the scan-failure path throws away the reason');
  if (!/loader: \$\{/.test(carSrc) || /no named nodes in the glb/.test(carSrc)) {
    gaps.push('carMesh still guesses at the cause instead of reporting the loader reason');
  }

  check('T44 model requests are serialized, retried and bounded, and a failed load reports WHICH failure it was: one model fetch at a time, >= 3 tries with a growing backoff, a transient failure recovers, a hard failure stops at its session budget, one name is asked once, a failure is never cached, and the car log quotes the loader reason instead of blaming the glb',
    gaps.length === 0,
    `concurrency ${MODEL_QUEUE.concurrency}, attempts ${MODEL_QUEUE.attempts}, backoff ${MODEL_QUEUE.backoffMs.join('/')}, budget ${MODEL_QUEUE.maxSessionAttempts} | max in flight ${maxLive}, order ${order.join('>')} | flaky recovered in 2 tries after ${flakyWaits.join('/')} ms | hard failure after ${hardTries} tries and ${hardWaits} backoffs | budget asks ${asks}, error "${budgetErr}" | dup asks ${dupAsks} | ${calls} fake loads | gaps=[${gaps.join(' ')}]`);
}
await testModelRequestsAreQueuedAndRetried();

// ------------------------------------------------------------------ test 45
// The quality ladder, in triangles. "Does the cheap preset pay more than the expensive
// one?" used to be answerable only by running the game with ?perftest=1, and the whole
// band/cap table was inline inside Streaming._rebuildProps where node could not read it.
// It now lives in src/world/veg-bands.js, so this check integrates the real bands over a
// real measured prop density and pins that LOW never draws a heavier treeline than MED
// and MED never heavier than HIGH - band by band, not just in total, because a preset
// can hide an inversion inside one band while the total still steps up.
function testVegetationCostLadderNeverInverts() {
  const gaps = [];
  // ---- 1. measure a real placement: props per square metre, per species ----
  const SEED = 12345;
  const terrain = makeTerrain(SEED, 'FOREST');
  const road = buildRoad({ seed: SEED, lengthTarget: 4200, terrainHeightAt: terrain.heightAt, biome: 'FOREST' });
  const carveIndex = buildCarveIndex(road);
  const stage = { road, carveIndex, terrain, biome: 'FOREST', density: 1, seed: SEED, world: null };
  const seen = new Set(); const chunks = [];
  for (let i = 0; i < road.n; i += 16) {
    const k = `${Math.floor(road.x[i] / CHUNK)},${Math.floor(road.z[i] / CHUNK)}`;
    if (!seen.has(k)) { seen.add(k); chunks.push(k); }
  }
  const sample = chunks.slice(0, 48);
  const counts = {}; let placed = 0;
  for (const k of sample) {
    const [cx, cz] = k.split(',').map(Number);
    for (const p of generateChunkProps(cx, cz, stage)) { placed++; counts[p.prop] = (counts[p.prop] || 0) + 1; }
  }
  if (sample.length < 30 || placed < 400) gaps.push(`placement sample too small to carry a cost: ${sample.length} chunks, ${placed} props`);
  const density = vegDensity(counts, sample.length, CHUNK * CHUNK);

  // ---- 2. the three preset plans, integrated over that density ----
  // Whole-disc, no frustum cull: it is the upper bound and cuts every preset the same
  // way, so the ladder comparison stands without a camera.
  const ROWS = [['LOW', QUALITY.LOW], ['MED', QUALITY.MED], ['HIGH', QUALITY.HIGH]];
  const plan = {}; const cost = {};
  for (const [n, q] of ROWS) {
    qualityPreset(q);
    plan[n] = vegBandPlan(q, settings);
    cost[n] = vegCostFromDensity(plan[n], density);
    if (!(cost[n].total > 0)) gaps.push(`${n}: vegetation cost measured as ${cost[n].total}`);
  }
  qualityPreset(QUALITY.MED);

  // ---- 3. the ladder, band by band ----
  for (let i = 1; i < ROWS.length; i++) {
    const lo = ROWS[i - 1][0], hi = ROWS[i][0];
    for (const b of ['near', 'mid', 'far', 'total']) {
      if (cost[lo][b] > cost[hi][b]) gaps.push(`${b} band costs more at ${lo} (${cost[lo][b].toFixed(0)}) than at ${hi} (${cost[hi][b].toFixed(0)})`);
    }
    for (const k of ['nearR', 'midR', 'nearRHard', 'farR', 'nearCapMul', 'midCapMul', 'farCapMul']) {
      if (plan[lo][k] > plan[hi][k]) gaps.push(`${k} is larger at ${lo} (${plan[lo][k]}) than at ${hi} (${plan[hi][k]})`);
    }
  }

  // ---- 4. why the far radius is the cheap axis: 2 tris vs a whole tree ----
  if (vegTrisPerInstance(PROP.PINE, 'far') !== 2) gaps.push('the far band is no longer one quad per tree, so its radius is not the cheap axis');
  if (!(vegTrisPerInstance(PROP.PINE, 'near') >= 100)) gaps.push('the near band carries no per-tree budget, so nearR is the axis that eats the frame');
  if (!(vegTrisPerInstance(PROP.PINE, 'mid') === SPRITE_SPEC[PROP.PINE].planes * 2)) gaps.push('the mid band is not the crossed-quad sprite');

  // ---- 5. the near band at LOW is pinned, not merely cheaper than MED ----
  const LOW_NEAR_CEIL = 26000;
  if (cost.LOW.near > LOW_NEAR_CEIL) gaps.push(`LOW near band ${cost.LOW.near.toFixed(0)} tris over its ${LOW_NEAR_CEIL} budget`);
  if (cost.LOW.total > cost.MED.total * 0.75) gaps.push(`LOW vegetation ${cost.LOW.total.toFixed(0)} is within ${((cost.LOW.total / cost.MED.total) * 100).toFixed(0)}% of MED: the cheap preset buys almost nothing`);
  // the clamp must not be able to erase the treeline either
  if (plan.LOW.farR < 240) gaps.push(`LOW far band pulled in to ${plan.LOW.farR.toFixed(0)} m: the forest ends inside the near field`);

  // ---- 6. the clamp binds: poison the LOW row, the plan must still sit under MED ----
  const row = VEG_BANDS[QUALITY.LOW];
  const saved = { ...row };
  row.nearR = 90; row.midCapMul = 0.95; row.farAdd = 900; row.nearCapMul = 0.9;
  const poisoned = vegBandPlan(QUALITY.LOW, settings);
  const med = vegBandPlan(QUALITY.MED, settings);
  const poisonedCost = vegCostFromDensity(poisoned, density);
  if (poisoned.nearR > med.nearR || poisoned.midCapMul > med.midCapMul || poisoned.nearCapMul > med.nearCapMul) {
    gaps.push(`a poisoned LOW row stays above MED (nearR ${poisoned.nearR}, capMul ${poisoned.nearCapMul}/${poisoned.midCapMul})`);
  }
  if (poisoned.farR > med.farR) gaps.push(`a poisoned LOW row reaches ${poisoned.farR} m past MED's ${med.farR} m`);
  if (poisonedCost.total > cost.MED.total) gaps.push(`a poisoned LOW row costs ${poisonedCost.total.toFixed(0)} over MED's ${cost.MED.total.toFixed(0)}`);
  Object.assign(row, saved);
  if (vegBandPlan(QUALITY.LOW, settings).nearR !== plan.LOW.nearR) gaps.push('the LOW row was not restored after poisoning');

  // ---- 7. the renderer reads this table instead of keeping its own copy ----
  const streamSrc = readFileSync(new URL('../world/streaming.js', import.meta.url), 'utf8');
  if (!/vegBandPlan\(/.test(streamSrc)) gaps.push('streaming.js still resolves its own band radii inline');
  if (/nearCapMul = low|midCapMul = low \?|farCapMul = !settings\.farDetail/.test(streamSrc)) gaps.push('the band table is still duplicated in streaming.js');

  const line = (n) => `${n} near ${plan[n].nearR}m/mid ${plan[n].midR}m/far ${plan[n].farR}m caps ${plan[n].nearCapMul}/${plan[n].midCapMul}/${plan[n].farCapMul} = ${cost[n].near.toFixed(0)}+${cost[n].mid.toFixed(0)}+${cost[n].far.toFixed(0)} = ${cost[n].total.toFixed(0)} tris / ${cost[n].instances.toFixed(0)} inst`;
  check('T45 the vegetation cost ladder never inverts: measured over a real FOREST placement, LOW draws a cheaper treeline than MED and MED than HIGH band by band, the far band stays one quad per tree, the LOW near band sits inside its budget, and a poisoned LOW row is clamped under MED',
    gaps.length === 0,
    `${sample.length} chunks / ${placed} props = ${(placed / sample.length).toFixed(1)} per chunk | ${line('LOW')} | ${line('MED')} | ${line('HIGH')} | gaps=[${gaps.join(' ')}]`);
}
testVegetationCostLadderNeverInverts();

// ---------------------------------------------------------------- test 46
// The rubber's own relief (queue P12: "tyres have no tread relief once caked").
// attachTyreDirt used to write diffuseColor and roughnessFactor only - it never touched
// the normal, and its only detail was a value-noise spatter - so a wheel came out as a
// brown drum at every distance and every dirt level. The tread is now a height field in
// the wheel's own coordinates (angle around the rolling axis + axial position: it spins
// with the wheel, costs no geometry), and its gradient tilts the normal by the lug depth
// that survives the crust. src/render/tyre-tread.js holds the pattern and the GLSL is
// generated from the same table, so this check measures the field the shader compiles.
function testTyreTreadRelief() {
  const T = TYRE_TREAD;
  const halfW = 0.095, rMax = TYRE_BASE.r;      // the exported rubber: 0.335 m radius, ~190 mm wide
  const plan = treadPlan(halfW, rMax);
  const gaps = [];

  // ---- 1. a real block tread: sane pitch, grooves that are grooves ----
  if (!(plan.lugCount >= 20 && plan.lugCount <= 52)) gaps.push(`${plan.lugCount} lugs around a ${(rMax * 2).toFixed(2)} m tyre`);
  if (!(plan.pitchAx >= 0.02 && plan.pitchAx <= 0.09)) gaps.push(`block column pitch ${plan.pitchAx.toFixed(4)} m`);
  if (!(T.depth >= 0.004 && T.depth <= 0.016)) gaps.push(`lug depth ${T.depth} m is not a tyre lug`);
  const crest = treadCell(0.5, 0, 1, 0, plan);        // column centre, mid-lug
  const groove = treadCell(0, 0.5, 1, 1, plan);       // groove floor at the shoulder
  if (!(crest > 0.85)) gaps.push(`block top reads ${crest.toFixed(2)}, not a crest`);
  if (!(groove < 0.12)) gaps.push(`groove floor reads ${groove.toFixed(2)}, not a groove`);

  // ---- 2. blocks across the width, shoulder columns staggered ----
  let dips = 0, wasLow = false;
  for (let c = -plan.blocks * 0.5; c <= plan.blocks * 0.5 + 1e-9; c += 0.02) {
    const low = treadCell(0.5, c, 1, Math.min(1, Math.abs(c) / (plan.blocks * 0.5)), plan) < 0.5;
    if (low && !wasLow) dips++;
    wasLow = low;
  }
  if (!(dips >= 3 && dips <= 6)) gaps.push(`${dips} circumferential grooves across ${plan.blocks} columns`);
  // the centre rib is shallower-cut than the shoulder grooves, and the shoulders sit half
  // a pitch off the centre columns (a directional tread, not a grid of identical squares)
  const cutCentre = 1 - treadCell(0.5, 0, 1, 0, plan);
  const cutShoulder = 1 - treadCell(0.5, 2, 1, 1, plan);
  if (!(cutShoulder > cutCentre + 0.10)) gaps.push(`shoulder cut ${cutShoulder.toFixed(2)} is not deeper than the rib ${cutCentre.toFixed(2)}`);
  const centreLug = treadCell(0.5, 0, 1, 0, plan), centreSlot = treadCell(0, 0, 1, 0, plan);
  const shoulderLug = treadCell(0, 2, 1, 1, plan), shoulderSlot = treadCell(0.5, 2, 1, 1, plan);
  if (!(centreLug > 0.85 && centreSlot < 0.12)) gaps.push('the centre columns are not phased');
  if (!(shoulderLug > 0.85 && shoulderSlot < 0.12)) gaps.push('the shoulder columns are not staggered by half a pitch');

  // ---- 3. the tread is on the tread: rim and sidewall stay smooth rubber ----
  if (!(treadCrown(0.45, 0.0, plan) === 0)) gaps.push('tread reaches down onto the rim');
  if (!(treadCrown(1.0, 1.0, plan) === 0)) gaps.push('tread reaches out onto the sidewall');
  if (!(treadCrown(1.0, 0.25, plan) > 0.95)) gaps.push('the crown band is not fully treaded');
  if (!(treadCell(0.5, 0.3, treadCrown(1.0, 1.0, plan), 1.0, plan) === 0)) gaps.push('a sidewall fragment still gets lugs');

  // ---- 4. the relief is real, sane, and survives caking (the P12 defect) ----
  let maxTilt = 0, shaped = 0, capped = 0, n = 0, minAmpCaked = Infinity, maxAmpClean = 0;
  for (let a = 0; a < Math.PI * 2; a += 0.07) {
    for (let ax = -halfW * 0.8; ax <= halfW * 0.8; ax += 0.006) {
      const side = Math.abs(ax) / halfW;
      const clean = treadNormalTilt(a, ax, 1.0, side, plan, 0, 0);
      const caked = treadNormalTilt(a, ax, 1.0, side, plan, 0.9, 0.5);
      n++;
      if (clean.tilt > maxTilt) maxTilt = clean.tilt;
      if (clean.tilt > 0.15) shaped++;
      if (clean.raw > T.maxTilt) capped++;
      if (clean.crown > 0.9) { maxAmpClean = Math.max(maxAmpClean, clean.amp); minAmpCaked = Math.min(minAmpCaked, caked.amp); }
    }
  }
  if (!(maxTilt > 0.25)) gaps.push(`max normal tilt ${maxTilt.toFixed(3)} - the tyre is still flat`);
  if (!(maxTilt <= T.maxTilt + 1e-6)) gaps.push(`normal tilt ${maxTilt.toFixed(3)} over the ${T.maxTilt} cap`);
  if (!(capped / n < 0.25)) gaps.push(`the tilt cap binds on ${((capped / n) * 100).toFixed(0)} % of the tread: the groove walls are cliffs, not walls`);
  if (!(shaped / n > 0.25)) gaps.push(`only ${((shaped / n) * 100).toFixed(0)} % of the tread carries relief`);
  if (!(minAmpCaked > 0.5 * maxAmpClean)) gaps.push(`a caked tyre keeps only ${minAmpCaked.toFixed(5)} m of the ${maxAmpClean.toFixed(5)} m lug depth`);
  if (!(treadReliefAmp(0, 1, plan) < treadReliefAmp(0, 0, plan))) gaps.push('water does not round the block edges');
  if (!(treadReliefAmp(1, 0, plan) < treadReliefAmp(0, 0, plan))) gaps.push('crust does not round the block edges');
  if (!(treadReliefAmp(1, 0, plan) >= 0.5 * treadReliefAmp(0, 0, plan))) gaps.push('crust erases the tread instead of rounding it');

  // ---- 5. the shader really compiles this field, with no added geometry ----
  const src = readFileSync(new URL('../render/carMesh.js', import.meta.url), 'utf8');
  const tyreFn = src.slice(src.indexOf('function attachTyreDirt'), src.indexOf('const _m4 ='));
  if (!tyreFn.length) gaps.push('attachTyreDirt not found');
  if (!/normal_fragment_maps/.test(tyreFn)) gaps.push('the tyre patch never touches the normal - the P12 defect is back');
  if (!/TYRE_TREAD_GLSL/.test(tyreFn) || !/wheelTreadPlan\(/.test(tyreFn)) gaps.push('the tyre patch hand-writes its own tread maths instead of the shared wheel plan');
  if (!/uTyreRelief|vTyreT1/.test(tyreFn)) gaps.push('the tread gradient never reaches the normal');
  if (/new THREE\.BufferGeometry|setAttribute\(/.test(tyreFn)) gaps.push('the tread is baked as extra geometry instead of relief');
  if ((src.match(/#include <normal_fragment_maps>/g) || []).length < 2) gaps.push('only the body shader perturbs the normal');
  for (const k of ['feather']) {
    if (!TYRE_TREAD_GLSL.includes(String(T[k]))) gaps.push(`the generated GLSL lost TYRE_TREAD.${k}`);
  }

  // ---- 6. the patched sources still parse ----
  // A GLSL patch lives inside a JS template literal, so one stray backtick in a shader
  // comment is a page-wide SyntaxError: the car layer never builds and every shader
  // string below silently never compiles. This exact defect happened while writing P12,
  // and the only thing that caught it was a screenshot of a blank frame.
  for (const f of ['../render/carMesh.js', '../render/tyre-tread.js', '../dirt/dirt.js', '../main.js']) {
    const p = fileURLToPath(new URL(f, import.meta.url));
    const r = spawnSync(process.execPath, ['--check', p], { encoding: 'utf8' });
    if (r.status !== 0) gaps.push(`${f.split('/').pop()} does not parse: ${(r.stderr || '').split('\n')[1] || r.status}`);
  }

  check('T46 the rubber has its own relief: a real block tread (lugs, grooves, staggered shoulders, smooth sidewall) whose normal tilt is bounded, covers the crown, and survives caking and water - and the tyre shader perturbs the normal instead of only painting colour',
    gaps.length === 0,
    `lugs=${plan.lugCount} pitch ${(T.lugPitch * 1000).toFixed(0)}mm cols=${plan.blocks} axPitch=${(plan.pitchAx * 1000).toFixed(0)}mm depth=${(T.depth * 1000).toFixed(0)}mm | crest=${crest.toFixed(2)} groove=${groove.toFixed(2)} dips=${dips} | tilt max=${maxTilt.toFixed(2)} capped=${((capped / n) * 100).toFixed(0)}% shaped=${((shaped / n) * 100).toFixed(0)}% amp clean=${maxAmpClean.toFixed(4)} caked>=${minAmpCaked.toFixed(4)} | newTris=0 gaps=[${gaps.join(' ')}]`);
}
testTyreTreadRelief();

// T47 - the shipped preset maps are authored as a CORRIDOR along the whole route, in
// two bands: a fully authored near band and a far band (distant heightfield + far
// vegetation billboards) that has to reach 400 m off the spline at every 200 m of the
// stage, so the treeline and the horizon exist ahead of the car everywhere. Everything
// below reads the shipped files with the runtime loader: a map that decodes, but leaves
// a hole in the corridor or blows the size budget, is the "trees do not render ahead"
// defect the player reports, so it fails the build.
function testShippedMapCorridor() {
  const gaps = [];
  const per = [];
  for (const def of MAP_CATALOG) {
    const bytes = new Uint8Array(readFileSync(fileURLToPath(new URL(`../../${mapUrl(def.id)}`, import.meta.url))));
    if (!(bytes.length > 0 && bytes.length <= MAP_SIZE_BUDGET)) gaps.push(`${def.id} ${(bytes.length / 1e6).toFixed(1)} MB vs ${(MAP_SIZE_BUDGET / 1e6).toFixed(0)} MB budget`);
    const world = new VoxelWorld(def.seed >>> 0);
    const res = applyMap(world, bytes);
    if (!res) { gaps.push(`${def.id}: map refused by the loader`); continue; }
    const cov = res.meta.coverage || null;
    if (res.meta.version !== MAP_VERSION) gaps.push(`${def.id}: version ${res.meta.version} != ${MAP_VERSION}`);
    if (!cov || !(cov.near >= 120) || !(cov.far >= 400)) gaps.push(`${def.id}: coverage header ${JSON.stringify(cov)}`);
    // Both bands decode: near chunks (full corridor data) and far chunks (compact
    // heightfield) come back as distinct, non-empty sets.
    if (!(res.stats.near > 0 && res.stats.far > 0)) gaps.push(`${def.id}: bands ${res.stats.near}/${res.stats.far}`);
    if (res.stats.near + res.stats.far !== res.stats.chunks) gaps.push(`${def.id}: band split != chunk count`);
    const authored = new Set();
    for (const c of world.chunks.values()) authored.add(chunkKey(c.cx, c.cz));
    if (authored.size !== res.stats.chunks) gaps.push(`${def.id}: ${authored.size} resident != ${res.stats.chunks} decoded`);
    const road = res.road;
    // 1) coverage: walk sideways off the spline every 200 m - authored ground has to
    //    still be there past 400 m on BOTH sides of the road.
    let minReach = Infinity;
    for (let arc = 0; arc < road.length; arc += 200) {
      const i = road.indexAt(arc);
      for (const side of [1, -1]) {
        let r = 0;
        for (let q = 8; q <= 700; q += 8) {
          const X = road.x[i] + road.nx[i] * q * side, Z = road.z[i] + road.nz[i] * q * side;
          if (!authored.has(chunkKey(Math.floor(X / CHUNK), Math.floor(Z / CHUNK)))) break;
          r = q;
        }
        if (r < minReach) minReach = r;
      }
    }
    if (!(minReach >= 400)) gaps.push(`${def.id}: authored coverage only ${minReach} m off the spline`);
    // 2) no hole inside the corridor, and no generation anywhere: replay the streaming
    //    job disc (settings.drawDistance, no reach clamp) over every road sample. A job
    //    the file covers must be resident; a job outside the corridor is skipped by
    //    Streaming, so stats.generated stays 0 the whole stage.
    let holes = 0, resident = 0, outside = 0;
    const R = Math.max(700, settings.drawDistance);
    const span = Math.ceil(R / CHUNK) + 1;
    for (let arc = 0; arc < road.length; arc += 100) {
      const i = road.indexAt(arc);
      const cx = Math.floor(road.x[i] / CHUNK), cz = Math.floor(road.z[i] / CHUNK);
      for (let dz = -span; dz <= span; dz++) {
        for (let dx = -span; dx <= span; dx++) {
          const X = (cx + dx) * CHUNK + CHUNK / 2, Z = (cz + dz) * CHUNK + CHUNK / 2;
          if (Math.hypot(X - road.x[i], Z - road.z[i]) > R) continue;
          if (authored.has(chunkKey(cx + dx, cz + dz))) { resident++; continue; }
          outside++;
          if (Math.hypot(X - road.x[i], Z - road.z[i]) <= cov.far) holes++;
        }
      }
    }
    if (holes) gaps.push(`${def.id}: ${holes} holes inside the ${cov.far} m authored band`);
    if (resident === 0) gaps.push(`${def.id}: nothing resident over the route`);
    per.push(`${def.id} ${(bytes.length / 1e6).toFixed(2)}MB chunks=${res.stats.chunks}(${res.stats.near}+${res.stats.far}) props=${res.stats.props} reach=${minReach}m skipped=${outside} generated=0`);
  }
  check('T47 every shipped map is a two-band corridor along the whole route: both bands decode, authored coverage reaches >= 400 m off the spline at every 200 m of road, the corridor has no holes, each file stays inside the size budget and the streaming job disc over the whole stage generates nothing',
    gaps.length === 0, gaps.join(' ') + ' | ' + per.join(' | '));
}
testShippedMapCorridor();

// ---------------------------------------------------------------- test 48-52
// Scenery collision: src/world/prop-colliders.js turns the prop list into a
// chunk-keyed grid, and propContact() in src/car/vehicle.js answers it in the
// wheel substep loop (after hullContact, before integrate).
function testPropColliders() {
  // Which way the sim drives a car at yaw 0: probe the sign, do not assume it.
  const probe = makeCar(new FlatWorld(SURF.DIRT), {});
  probe.placeAt(0, 0, 0);
  for (let i = 0; i < 40; i++) {
    probe.setInput({ throttle: 1, brake: 0, steer: 0, handbrake: 0, shiftUp: 0, shiftDown: 0 });
    probe.step(DT);
  }
  // placeAt(x, z, yaw, groundY): at yaw 0 the sim drives the car along +X, so the
  // planted tree sits down that axis (probed above, not assumed).
  const fwd = probe.body.pos.x >= 0 ? 1 : -1;
  const TREE_X = fwd * 45;
  const tree = { prop: PROP.OAK, x: TREE_X, y: 0, z: 0, yaw: 0, scale: 1 };
  const FULL = { throttle: 1, brake: 0, steer: 0, handbrake: 0, shiftUp: 0, shiftDown: 0 };

  // 1) speed + damage, not a drive-through
  {
    const w = new FlatWorld(SURF.DIRT);
    const car = makeCar(w, {});
    car.placeAt(0, 0, 0);
    car.setPropColliders(buildColliders([tree]));
    let peak = 0, hits = 0;
    for (let i = 0; i < Math.round(7 / DT); i++) {
      car.setInput(FULL);
      for (const e of car.step(DT)) if (e.type === 'propHit') hits++;
      peak = Math.max(peak, car.body.groundSpeed);
    }
    const after = car.body.groundSpeed;
    const through = fwd * car.body.pos.x > TREE_X + 0.5;
    check('T48 a full-throttle car driven straight into a planted tree loses most of its speed and takes damage instead of passing through',
      hits > 0 && peak > 12 && after < 0.35 * peak && !through && car.damage.totalSeverity > 0,
      `peak=${peak.toFixed(1)} -> ${after.toFixed(1)} m/s hits=${hits} severity=${car.damage.totalSeverity.toFixed(2)} frontHits=${car.damage.frontHits} stopX=${car.body.pos.x.toFixed(1)} treeX=${TREE_X}`);
  }

  // 2) the non-solid species never collide
  {
    const w = new FlatWorld(SURF.DIRT);
    const car = makeCar(w, {});
    car.placeAt(0, 0, 0);
    const grid = buildColliders([
      { prop: PROP.FERN, x: TREE_X, y: 0, z: 0, yaw: 0, scale: 1 },
      { prop: PROP.BUSH, x: TREE_X + 1, y: 0, z: 0.3, yaw: 0, scale: 1 },
    ]);
    car.setPropColliders(grid);
    let hits = 0;
    for (let i = 0; i < Math.round(7 / DT); i++) {
      car.setInput(FULL);
      for (const e of car.step(DT)) if (e.type === 'propHit') hits++;
    }
    const through = fwd * car.body.pos.x > TREE_X + 3;
    check('T49 ferns and bushes are non-solid: no collider is built for them and the car drives through untouched',
      grid.count === 0 && grid.skipped === 2 && hits === 0 && through,
      `colliders=${grid.count} skipped=${grid.skipped} hits=${hits} x=${car.body.pos.x.toFixed(1)} solidSpecies=${Object.keys(SPECIES_SHAPE).length}`);
  }

  // 3) no trapping: a car started dead centre on a trunk is ejected
  {
    const w = new FlatWorld(SURF.DIRT);
    const car = makeCar(w, {});
    const grid = buildColliders([tree, { prop: PROP.PINE, x: TREE_X + 0.3, y: 0, z: 0.4, yaw: 0, scale: 1 }]);
    car.placeAt(TREE_X, 0, 0, 0);   // dead centre on the trunk
    car.setPropColliders(grid);
    for (let i = 0; i < 20; i++) {
      car.setInput({ throttle: 0, brake: 0, steer: 0, handbrake: 0, shiftUp: 0, shiftDown: 0 });
      car.step(DT);
    }
    const clear = grid.hit(car.body.pos.x, car.body.pos.z, 0.05, {}) <= 0;
    const d = Math.hypot(car.body.pos.x - TREE_X, car.body.pos.z);
    check('T50 a car started inside a collider is ejected along the shortest axis instead of being trapped in it',
      clear && d > 0.42, `dist=${d.toFixed(2)} m (oak trunk r=0.42) pos=(${car.body.pos.x.toFixed(1)}, ${car.body.pos.z.toFixed(2)}) colliders=${grid.count}`);
  }

  // 4) the grid matches a brute force scan, plus the per-map counts / build time
  {
    const per = [];
    let missing = 0, sampled = 0, far = 0;
    for (const def of MAP_CATALOG) {
      const bytes = new Uint8Array(readFileSync(fileURLToPath(new URL(`../../${mapUrl(def.id)}`, import.meta.url))));
      const world = new VoxelWorld(def.seed || 1);
      const res = applyMap(world, bytes);
      const g = buildColliders(res.propTables);
      for (let a = 0; a < 40; a++) {
        const i = res.road.indexAt(res.road.length * (a + 0.5) / 40);
        const x = res.road.x[i], z = res.road.z[i], r = 3;
        const got = g.queryNear(x, z, r);
        const set = new Set(got);
        for (const sh of queryNearBrute(g.colliders, x, z, r)) if (!set.has(sh)) missing++;
        for (const sh of set) if (Math.abs(sh.x - x) > r + sh.r + COLLIDER_CELL
          || Math.abs(sh.z - z) > r + sh.r + COLLIDER_CELL) far++;
        sampled++;
      }
      per.push(`${def.id} props=${g.props} -> colliders=${g.count} (solids=${g.solids} nonSolidSkipped=${g.skipped} fenceLinks=${g.fences}) cells=${g.cells} build=${g.builtMs.toFixed(0)}ms`);
    }
    check('T51 every shipped map builds a chunk-keyed collider grid, and its query matches a brute force scan on sampled positions',
      missing === 0 && sampled === 40 * MAP_CATALOG.length,
      `missing=${missing} farOutsideQuery=${far} samples=${sampled} | ${per.join(' | ')}`);
  }

  // 5) cost of the contact pass on the T9 voxel patch (1200 steps, grid vs no grid)
  function simCost(props) {
    const world = new VoxelWorld(4242);
    for (let cz = -1; cz <= 1; cz++) for (let cx = -1; cx <= 1; cx++) {
      const ch = world.ensureChunk(cx, cz);
      for (let lz = 0; lz < 16; lz++) for (let lx = 0; lx < 16; lx++) {
        const col = lz * 16 + lx;
        for (let y = 0; y <= 20; y++) ch.blocks[col * 96 + y] = 3;
        ch.height[col] = 20; ch.surface[col] = 2;
      }
    }
    const c = new Vehicle('A', world, {});
    c.placeAt(0, 0, 0, 21);
    c.body.vel.x = 20;
    c.wheels.forEach((wh) => { wh.omega = 20 / wh.rEff; });
    if (props) c.setPropColliders(buildColliders(props));
    const t = process.hrtime.bigint();
    for (let i = 0; i < 1200; i++) {
      c.setInput({ throttle: 0.7, brake: 0, steer: 0.15, handbrake: 0, shiftUp: 0, shiftDown: 0 });
      c.step(DT);
    }
    return Number(process.hrtime.bigint() - t) / 1e6 / 1200;
  }
  const grove = [];
  for (let z = 6; z >= -14; z -= 3) grove.push({ prop: PROP.OAK, x: 4, y: 20, z, yaw: 0, scale: 1 });
  const before = simCost(null), after = simCost(grove);
  check('T52 the collider contact pass keeps the sim cost per 1/120 step inside the T9 budget',
    after <= 4 && after - before <= 0.5,
    `no-colliders=${before.toFixed(3)} ms/step with-colliders=${after.toFixed(3)} ms/step (budget <=4) colliders=${grove.length}`);
}
testPropColliders();

// ---------------------------------------------------------------- test 53
// The tread's RULER is the wheel, not the fragment's own mesh — the half of queue P12
// ("tyres have no tread relief once caked") that T46 could not see. T46 measures the
// height field on a SYNTHETIC tyre (halfW 0.095, r 0.335); the shipped wheel is five
// separate primitives, and attachTyreDirt used to build its own plan from each part's
// bounding box. The shader normalizes the radius (rr = |rad| / uTyreDims.y) and the axial
// position (side = |ax| / uTyreDims.x) by that ruler, so a part measured on its own scale
// is told it is the tread: the exported outboard rubber ring spans radius 0.21-0.25 m,
// which on its own 0.25 m ruler is rr ~ 1 — full crown — so it drew 27 fat lugs across
// the flank of every wheel at a groove pitch that does not line up with the 38 lugs of
// the rolling band, while the band itself was the only place the tyre should be lugged.
// This check measures the field off the SHIPPED asset, folded per wheel.
function testTyreTreadRulerIsTheShippedWheel() {
  const gaps = [];
  const { doc, acc } = readGlbDoc('assets/models/rally_v2.glb');
  const meshOf = new Map();
  for (const n of doc.nodes) if (n.mesh !== undefined) meshOf.set(n.name, doc.meshes[n.mesh]);
  const RUBBER = /tyre|rubber|sidewall/i;

  // Sample every triangle centroid the way the fragment shader does: ax from the object
  // origin along the rolling axis, rr from that axis line, both over the WHEEL's ruler.
  const sample = (pos, idx, axis, halfW, rMax, plan, caked, wet) => {
    const ctr = [0, 0, 0];
    let out = { n: 0, crownSum: 0, crownMax: 0, shaped: 0, band: 0, bandShaped: 0 };
    const o = [0, 1, 2].filter((k) => k !== axis);
    for (let t = 0; t < idx.length; t += 3) {
      const P = [0, 1, 2].map((k) => (pos[idx[t] * 3 + k] + pos[idx[t + 1] * 3 + k] + pos[idx[t + 2] * 3 + k]) / 3);
      const ax = P[axis];
      const rr = Math.hypot(P[o[0]], P[o[1]]) / rMax;
      const side = Math.min(1, Math.abs(ax) / halfW);
      const ang = Math.atan2(P[o[1]], P[o[0]]);   // the shader's own bearing around the wheel
      const s = treadNormalTilt(ang, ax, rr, side, plan, caked, wet);
      out.n++;
      out.crownSum += s.crown;
      if (s.crown > out.crownMax) out.crownMax = s.crown;
      if (s.crown > 0.01) { out.band++; if (s.tilt > 0.15) out.shaped++; }
      if (side < 0.5 && s.crown > 0.9) out.bandShaped++;
    }
    out.crownMean = out.crownSum / Math.max(1, out.n);
    return out;
  };

  const sizesOf = (mn, mx) => [mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2]];
  const bboxOf = (pos) => {
    const mn = [1e9, 1e9, 1e9], mx = [-1e9, -1e9, -1e9];
    for (let i = 0; i < pos.length; i += 3) for (let k = 0; k < 3; k++) {
      mn[k] = Math.min(mn[k], pos[i + k]); mx[k] = Math.max(mx[k], pos[i + k]);
    }
    return { mn, mx, s: sizesOf(mn, mx) };
  };

  const plans = [], rows = [];
  let bandTris = 0, bandShaped = 0, flankTris = 0, flankOld = 0, flankNew = 0, parts = 0, rubberParts = 0;
  for (const wn of WHEEL_NODES) {
    const mesh = meshOf.get(wn);
    if (!mesh) { gaps.push(`${wn} missing from the shipped glb`); continue; }
    const prims = mesh.primitives.map((p) => {
      const pos = acc(p.attributes.POSITION), idx = acc(p.indices);
      const b = bboxOf(pos);
      const s = b.s;
      const axis = (s[1] < s[0] && s[1] < s[2]) ? 1 : (s[2] < s[0] && s[2] < s[1]) ? 2 : 0;
      return { name: (doc.materials[p.material] && doc.materials[p.material].name) || '?', pos, idx, b, s, axis };
    });
    parts += prims.length;
    const rub = prims.filter((p) => RUBBER.test(p.name));
    rubberParts += rub.length;
    if (rub.length < 2) { gaps.push(`${wn}: only ${rub.length} rubber primitive, the fold is vacuous`); continue; }
    // the exported rubber sits centred on the wheel pivot, which is what lets the shader
    // read ax/rr off the object origin at all
    for (const p of rub) for (let k = 0; k < 3; k++) {
      if (Math.abs((p.b.mn[k] + p.b.mx[k]) * 0.5) > 0.01) gaps.push(`${wn}/${p.name}: rubber is ${((p.b.mn[k] + p.b.mx[k]) * 0.5).toFixed(3)} m off the pivot on axis ${k}`);
    }
    const sizes = rub.map((p) => p.s);
    const plan = wheelTreadPlan(sizes);
    plans.push(JSON.stringify([plan.tread, plan.crown, plan.relief, plan.rMax, plan.halfW]));
    if (!(plan.rMax >= 0.30 && plan.rMax <= 0.40)) gaps.push(`${wn}: folded tyre radius ${plan.rMax.toFixed(3)} m`);
    if (!(plan.halfW >= 0.12 && plan.halfW <= 0.22)) gaps.push(`${wn}: folded tyre width ${(plan.halfW * 2).toFixed(3)} m`);
    if (!(plan.lugCount >= 30 && plan.lugCount <= 46)) gaps.push(`${wn}: ${plan.lugCount} lugs on the folded tyre`);
    for (const p of rub) {
      // the old ruler: this part's own bbox
      const ownW = p.s[p.axis] * 0.5;
      const dims = [...p.s]; dims.splice(p.axis, 1);
      const ownR = Math.max(dims[0], dims[1]) * 0.5;
      const shared = sample(p.pos, p.idx, p.axis, plan.halfW, plan.rMax, plan, 0.9, 0.5);
      const own = sample(p.pos, p.idx, p.axis, ownW, ownR, treadPlan(ownW, ownR), 0.9, 0.5);
      const wide = ownR > plan.rMax * 0.9;      // the rolling band, by the wheel's ruler
      rows.push(`${p.name}:${wide ? 'band' : 'flank'} ownR=${ownR.toFixed(2)} crown ${own.crownMean.toFixed(2)}->${shared.crownMean.toFixed(2)}`);
      if (wide) {
        bandTris += shared.n; bandShaped += shared.bandShaped;
        if (!(shared.bandShaped / shared.n > 0.3)) gaps.push(`${wn}/${p.name}: the rolling band carries relief on only ${((100 * shared.bandShaped) / shared.n).toFixed(0)} % of its triangles`);
      } else {
        flankTris += shared.n; flankOld += own.crownSum; flankNew += shared.crownSum;
        if (!(shared.crownMean < 0.25)) gaps.push(`${wn}/${p.name}: ${shared.crownMean.toFixed(2)} mean crown on outboard rubber - the flank is being lugged`);
        // and prove the fold is what fixes it: on its own ruler this same part IS the tread
        if (!(own.crownMean > 0.35 && own.band / own.n > 0.35)) gaps.push(`${wn}/${p.name}: per-part ruler crown=${own.crownMean.toFixed(2)} masked=${((100 * own.band) / own.n).toFixed(0)}% - the fold is guarding nothing here`);
      }
    }
  }
  if (new Set(plans).size !== 1) gaps.push('the four wheels disagree on the tread ruler');
  if (!(parts >= 16 && rubberParts >= 8)) gaps.push(`shipped wheel primitives parts=${parts} rubber=${rubberParts}: asset truncated`);
  if (!(bandTris > 0 && flankTris > 0)) gaps.push('no band/flank split to measure on the shipped wheel');

  // ---- the source routes every part of a wheel through the one folded plan ----
  const src = readFileSync(new URL('../render/carMesh.js', import.meta.url), 'utf8');
  const wheelLoop = src.slice(src.indexOf('// Wheels: the exported pivots'), src.indexOf('node.material = null;'));
  if (!/wheelTreadPlan\(/.test(wheelLoop)) gaps.push('the wheel loop builds no folded tread plan');
  if (!/attachTyreDirt\([^)]*plan\)/.test(wheelLoop)) gaps.push('attachTyreDirt still measures the wheel per primitive');
  const tyreFn = src.slice(src.indexOf('function attachTyreDirt'), src.indexOf('const _m4 ='));
  if (/(?:^|[^A-Za-z])treadPlan\(/.test(tyreFn)) gaps.push('attachTyreDirt re-derives its own treadPlan from the part bbox');
  if (!/plan\.halfW/.test(tyreFn) || !/plan\.rMax/.test(tyreFn)) gaps.push('uTyreDims no longer reads the folded wheel ruler');

  check('T53 the tread ruler is the whole wheel: the shipped rubber family folds into ONE plan per wheel, the rolling band keeps its relief, and the outboard rubber keeps a smooth flank (no lugs across the sidewall) where a per-part ruler would draw 27 of them',
    gaps.length === 0,
    `wheels=4 parts=${parts} rubber=${rubberParts} bandTris=${bandTris} flankTris=${flankTris} shaped=${((100 * bandShaped) / Math.max(1, bandTris)).toFixed(0)}% flankCrown shared=${(flankNew / Math.max(1, flankTris)).toFixed(2)} old=${(flankOld / Math.max(1, flankTris)).toFixed(2)} plan=${plans[0] || '-'} | ${rows.slice(0, 5).join(' ')} gaps=[${gaps.join(' ')}]`);
}
testTyreTreadRulerIsTheShippedWheel();

// ---------------------------------------------------------------- test 54
// The backfire has a SOUND (queue P13): src/fx/fx.js has lit the exhaust flame off the
// gearbox's 'shift' event for ages and nothing in the audio layer ever listened, so the
// car fired a 150..350 ms fireball in total silence. T21/T26 own the flame side; this
// check owns the crack, and above all that the two can never disagree: one gate
// (fx.js shiftPop), one switch (settings.fx), one graph built once, and a pop that is
// nothing but AudioParam ramps (docs/05 §1 "żadnego createOscillator() w pętli").
class StubParam {
  constructor(tag, log, v = 1) { this.tag = tag; this.log = log; this._v = v; }
  get value() { return this._v; }
  set value(v) { this._v = v; this.log.push({ tag: this.tag, kind: 'now', v, t: -1 }); }
  _push(kind, v, t) {
    if (!Number.isFinite(v) || !Number.isFinite(t)) throw new RangeError(`${this.tag} ${kind} NaN`);
    this.log.push({ tag: this.tag, kind, v, t });
    return this;
  }
  setValueAtTime(v, t) { return this._push('set', v, t); }
  linearRampToValueAtTime(v, t) { return this._push('lin', v, t); }
  // Real WebAudio throws for an exponential ramp to 0 — the stub must too, or the
  // suite would bless an envelope the browser refuses.
  exponentialRampToValueAtTime(v, t) {
    if (!(v > 0)) throw new RangeError(`exponential ramp to ${v} on ${this.tag}`);
    return this._push('exp', v, t);
  }
  setTargetAtTime(v, t, c) { return this._push('target', v, t); }
  cancelScheduledValues(t) { return this._push('cancel', 0, t); }
}
class StubNode {
  constructor(ctx, kind, params) {
    this.ctx = ctx; this.kind = kind; this.uid = ctx.uid++;
    ctx.created.push(kind);
    for (const p of params) this[p] = new StubParam(`${kind}#${this.uid}.${p}`, ctx.log, p === 'Q' ? 1 : 1);
  }
  connect(dst) { this.ctx.wires.push(`${this.kind}#${this.uid}->${dst && dst.kind ? dst.kind + '#' + dst.uid : 'destination'}`); return dst; }
  disconnect() {}
  start(t = 0) { this.starts = (this.starts || 0) + 1; this.ctx.starts.push({ tag: `${this.kind}#${this.uid}`, t }); }
  stop(t = 0) { this.stops = (this.stops || 0) + 1; }
}
class StubCtx {
  constructor() {
    this.currentTime = 0; this.sampleRate = 48000; this.state = 'suspended';
    this.created = []; this.log = []; this.wires = []; this.starts = []; this.buffers = 0;
    this.uid = 0; this.resumeCalls = 0; this.data = null;
    this.destination = { kind: 'destination', uid: -1, connect() {}, disconnect() {} };
  }
  resume() { this.resumeCalls++; this.state = 'running'; return Promise.resolve(); }
  close() { return Promise.resolve(); }
  createGain() { return new StubNode(this, 'gain', ['gain']); }
  createBiquadFilter() { return new StubNode(this, 'biquad', ['frequency', 'Q', 'gain', 'detune']); }
  createOscillator() { return new StubNode(this, 'osc', ['frequency', 'detune']); }
  createBufferSource() { return new StubNode(this, 'bufsrc', ['playbackRate']); }
  createDynamicsCompressor() { return new StubNode(this, 'comp', ['threshold', 'ratio', 'attack', 'release', 'knee']); }
  createBuffer(ch, len, sr) {
    this.buffers++;
    const data = new Float32Array(len);
    this.data = data;
    return { numberOfChannels: ch, length: len, sampleRate: sr, getChannelData: () => data };
  }
}
function testBackfireHasASound() {
  const gaps = [];
  const V = BACKFIRE;

  // 1) nothing is built until a shift actually wants a pop (no AudioContext at boot).
  const idle = new BackfirePop({ bus, settings });
  if (idle.ctx || idle.nodes !== 0) gaps.push('the audio graph is built at boot, not at the first pop');

  // 2) the plume and the crack answer the SAME question for the same event.
  const car = makeCar(new FlatWorld(SURF.GRAVEL), {});
  const fx = new FxSystem({ scale: 1, bus });
  fx.setLocalTips(defaultExhaust(car.params));
  const ctx = new StubCtx();
  const bf = new BackfirePop({ bus, settings, engine: car.params.engine, Ctor: function () { return ctx; } });
  const events = [
    { up: true, gear: 3, rpm: 6200, throttle: 1.0, demand: 0.80 },   // upshift: pops
    { up: false, gear: 2, rpm: 3000, throttle: 1.0, demand: 0.60 },  // downshift, open throttle: silent
    { up: false, gear: 2, rpm: 5200, throttle: 0.0, demand: 0.00 },  // downshift on lift: pops
    { up: true, gear: 4, rpm: 950, throttle: 0.0, demand: 0.00 },    // idle upshift: the floor pop
    null,                                                            // junk on the bus
  ];
  const agree = [];
  for (const e of events) {
    const p0 = fx.exhaust.pending;
    bus.emit('shift', e);
    const flame = fx.exhaust.pending > p0;              // what the plume accepted
    const crack = bf.wants(e) > 0;                      // what the pop accepted
    agree.push(`${flame === crack ? 'ok' : 'SPLIT'}`);
    if (flame !== crack) gaps.push(`flame/crack disagree on ${JSON.stringify(e)}`);
    fx.exhaust.pending = 0;
  }
  if (shiftPop({ up: false, throttle: LIFT_THROTTLE - 0.01 }) < POP_FLOOR) gaps.push('the gate floor is not reachable');

  // 3) a driven lap: every shift the gearbox announces is either popped or gated, and
  //    the pop never lands on a chain that is still ringing.
  const input = { throttle: 1, brake: 0, steer: 0, handbrake: 0, shiftUp: 0, shiftDown: 0 };
  let shifts = 0, flameBursts = 0, prevBurst = 0;
  const p0 = bf.pops, g0 = bf.gated;
  const off = bus.on('shift', () => { shifts++; });
  drive(car, input, 8.0, (c) => {
    fx.step(DT, c, 1);
    if (fx.exhaust.burst > 0 && prevBurst <= 0) flameBursts++;
    prevBurst = fx.exhaust.burst;
    ctx.currentTime += DT;
  });
  off();
  const accepted = shifts - (bf.gated - g0);
  if (!(shifts > 0 && accepted > 0)) gaps.push(`no shift happened on the reference lap (shifts=${shifts})`);
  if (bf.pops - p0 !== accepted) gaps.push(`${bf.pops - p0} pops for ${accepted} gate-accepted shifts (${shifts} total)`);
  if (!(flameBursts > 0)) gaps.push('the plume never lit on the same lap');
  if (flameBursts !== accepted) gaps.push(`${flameBursts} plume bursts for ${accepted} cracks`);
  if (bf.stolen !== 0) gaps.push(`${bf.stolen} pops landed on a chain still ringing`);

  // 4) the graph is built ONCE and a pop only moves AudioParams (docs/05 §1).
  const built = ctx.created.length, starts = ctx.starts.length, evAfterBuild = ctx.log.length;
  for (let i = 0; i < 30; i++) { bf.pop(0.3 + 0.02 * (i % 5), 0.5); ctx.currentTime += 0.5; }
  if (bf.builds !== 1) gaps.push(`${bf.builds} graph builds for one layer`);
  if (ctx.created.length !== built) gaps.push(`a pop created ${ctx.created.length - built} nodes`);
  if (ctx.starts.length !== starts) gaps.push('a pop started a source: the loops must run continuously');
  const nodes = ctx.created.length;
  if (nodes !== bf.nodes) gaps.push(`nodes counted ${bf.nodes} but built ${nodes}`);
  if (nodes > V.nodeBudget) gaps.push(`${nodes} nodes over the layer budget ${V.nodeBudget}`);
  if (V.nodeBudget > 60) gaps.push('the layer budget exceeds docs/05 §10 (60 nodes for the whole mix)');
  if (ctx.buffers !== 1) gaps.push(`${ctx.buffers} noise buffers: the grain is generated once`);

  // 5) the envelope is legal WebAudio and click-free: every gain move ramps (never a
  //    step to an audible value), the attack is never shorter than the floor, times
  //    never go backwards, and no gain ever exceeds the bus level.
  const perParam = new Map();
  let steps = 0, shortAttack = 0, backTime = 0, hot = 0;
  for (const e of ctx.log) {
    if (!/\.gain$/.test(e.tag) || e.kind === 'cancel' || e.kind === 'now') continue;
    const a = perParam.get(e.tag) || [];
    a.push(e); perParam.set(e.tag, a);
  }
  for (const [tag, evs] of perParam) {
    for (let i = 0; i < evs.length; i++) {
      const e = evs[i];
      if (e.v > V.level + 1e-6) hot++;
      if (i > 0 && e.t < evs[i - 1].t - 1e-9) backTime++;
      if (e.kind === 'set' && e.v > 0.001) steps++;
      if (e.kind === 'exp' && i > 0) {
        const dt = e.t - evs[i - 1].t;
        if (dt < V.attackMin - 1e-9) shortAttack++;
      }
    }
    const span = evs[evs.length - 1].t - evs[0].t;
    if (span > 0 && evs.length > 4 && span / (evs.length / 4) > 40 * V.maxPopS) gaps.push(`${tag} automation ran away`);
  }
  if (steps) gaps.push(`${steps} gain steps to an audible value: a click on the bus`);
  if (shortAttack) gaps.push(`${shortAttack} attacks shorter than ${V.attackMin} s`);
  if (backTime) gaps.push(`${backTime} out-of-order automation events`);
  if (hot) gaps.push(`${hot} gain events over the bus level ${V.level}`);
  if (ctx.resumeCalls === 0) gaps.push('a suspended context was never asked to resume');

  // 6) the voice itself, measured with no audio device at all.
  let mono = true, bound = true, winMax = 0, trainMax = 0, gprev = -1;
  for (let i = 0; i <= 10; i++) {
    const s = i / 10;
    const v = popVoice(s, s, V);
    const nums = [v.gain, v.band, v.bandEnd, v.q, v.lowpass, v.thump, v.thumpGain, v.attack, v.decay, v.rate];
    if (!nums.every(Number.isFinite)) bound = false;
    if (v.gain < gprev - 1e-9) mono = false;
    gprev = v.gain;
    if (v.gain > V.level || v.gain < 0.02) bound = false;
    if (v.thumpGain >= v.gain || v.bandEnd >= v.band) bound = false;
    if (v.band < V.crackLo || v.band > V.crackHi) bound = false;
    if (v.decay < V.decayLo || v.decay > V.decayHi || v.attack < V.attackMin) bound = false;
    for (let r = 0; r < 20; r++) {
      const tr = crackTrain(v, V);
      if (tr.length < 1 || tr.length > V.cracksMax) bound = false;
      if (tr[0].at !== 0) bound = false;
      let end = 0;
      for (let k = 1; k < tr.length; k++) {
        if (tr[k].at - tr[k - 1].at < Math.max(V.crackGapMin, tr[k - 1].decay) - 1e-9) bound = false;
      }
      for (const k of tr) {
        end = Math.max(end, k.at + k.decay);
        if (k.gain > V.level || k.thumpGain > V.level) bound = false;
        if (k.decay > V.maxPopS) bound = false;
      }
      if (end > V.maxPopS + 1e-9) bound = false;
      winMax = Math.max(winMax, end);
      trainMax = Math.max(trainMax, tr.length);
    }
  }
  if (!mono || !bound) gaps.push('the pop voice is not monotone / out of bounds');
  if (winMax > V.maxPopS) gaps.push(`a crack train outlasts the plume window (${winMax.toFixed(3)} s)`);

  // 7) the switch is the player's own: settings.fx, read at pop time, no extra wiring.
  const ev = { up: true, gear: 3, rpm: 6400, throttle: 1.0, demand: 0.9 };
  const fxWas = settings.fx;
  settings.fx = false;
  const popsAtOff = bf.pops, evAtOff = ctx.log.length;
  ctx.currentTime += 1.0;
  bus.emit('shift', ev);
  const offSilent = bf.pops === popsAtOff && ctx.log.length === evAtOff && bf.silenced() === true;
  settings.fx = true;
  ctx.currentTime += 1.0;
  bus.emit('shift', ev);
  const onHeard = bf.pops === popsAtOff + 1 && ctx.log.length > evAtOff;
  settings.fx = fxWas;
  if (!offSilent) gaps.push('the crack plays with fx off');
  if (!onHeard) gaps.push('the crack does not follow settings.fx back on');

  // 8) the same determinism rule as the particle field: no Math.random in audio.
  const src = readFileSync(new URL('../audio/backfire.js', import.meta.url), 'utf8');
  const code = src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  const head = code.slice(0, code.indexOf('_ensure() {'));
  if (/Math\.random/.test(code)) gaps.push('Math.random in the audio path (a replay must sound identical)');
  if (/create(Gain|Oscillator|BiquadFilter|BufferSource|DynamicsCompressor)\(/.test(head)) gaps.push('nodes are built outside _ensure()');
  if (/\bfetch\(|decodeAudioData|\.mp3|\.wav|\.ogg|XMLHttpRequest/.test(code)) gaps.push('the pop loads audio data instead of synthesizing it (docs/05 §0)');
  const main = readFileSync(new URL('../main.js', import.meta.url), 'utf8');
  if (!/new BackfirePop\(\{[^}]*settings/.test(main)) gaps.push('main.js does not hand the pop layer settings.fx');
  if (!/backfire\.arm\(/.test(main)) gaps.push('main.js never arms the layer on a user gesture');
  const fxSrc = readFileSync(new URL('../fx/fx.js', import.meta.url), 'utf8');
  const onShiftBody = fxSrc.slice(fxSrc.indexOf('onShift(e) {'), fxSrc.indexOf('onShift(e) {') + 420);
  if (!/shiftPop\(/.test(onShiftBody)) gaps.push('ExhaustFx.onShift went back to its own inline throttle rule');

  check('T54 the backfire makes a sound: one gate and one switch with the flame plume, a synthesized crack whose graph is built once at the first pop, no node created per pop, an envelope with no clicks and no stolen chain, and silence with fx off',
    gaps.length === 0,
    `shifts=${shifts} accepted=${accepted} pops=${bf.pops} gated=${bf.gated} muted=${bf.muted} stolen=${bf.stolen} flameBursts=${flameBursts} gate=${agree.join('')} nodes=${nodes}/${V.nodeBudget} chains=${V.chains} builds=${bf.builds} buffers=${ctx.buffers} resume=${ctx.resumeCalls} trainMax=${trainMax} window=${winMax.toFixed(3)}s<=${V.maxPopS} gainMax=${V.level} clicks=${steps}/${shortAttack}/${backTime}/${hot} gaps=[${gaps.join(' ')}]`);
}
testBackfireHasASound();

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) process.exitCode = 1;

export { results, arcRun, test1, test2, test3, test4, test5, test6, test7, testCarAsset, testPaceNoteDisplay };
