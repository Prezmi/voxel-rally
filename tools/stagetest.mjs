// Headless acceptance run for F4 (docs/07 "Faza 4 — Pętla rajdowa").
// Builds a real generated stage, drives the whole 4.2 km with the pure-pursuit
// driver from tools/smoke.mjs, and runs the stage state machine + timing on the
// fixed step. No DOM, no GPU, no assets.
import { VoxelWorld } from '../src/world/chunk.js';
import { makeTerrain } from '../src/world/terrain-gen.js';
import { buildRoad } from '../src/world/road-spline.js';
import { buildCarveIndex, prewarmArea } from '../src/world/road-carve.js';
import { Vehicle } from '../src/car/vehicle.js';
import { DT } from '../src/core/time.js';
import { Emitter } from '../src/core/events.js';
import { StageRun, planGates, STATE } from '../src/game/stage.js';
import { formatTime, formatSplit } from '../src/game/timing.js';
import { RallyHud } from '../src/game/hud-rally.js';
import { solveGhost } from '../src/game/ghost.js';
import { buildPaceNotes } from '../src/game/pace-notes.js';

const SEED = 12345, BIOME = 'FOREST', LEN = 4200, REF_SPEED = 15;
const START = 12;
let failures = 0;
const ok = (cond, label, extra = '') => {
  if (!cond) failures++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`);
};

function makeStage() {
  const t0 = performance.now();
  const world = new VoxelWorld(SEED);
  const terrain = makeTerrain(SEED, BIOME);
  const road = buildRoad({ seed: SEED, lengthTarget: LEN, terrainHeightAt: terrain.heightAt, biome: BIOME });
  const gates = planGates(road, SEED);
  const carveIndex = buildCarveIndex(road);
  prewarmArea(world, terrain, road, carveIndex, road.x[START], road.z[START], 150);
  // The reference time is solved offline from the road geometry (docs/03 §6), not from
  // a constant stage speed: LEN / REF_SPEED made a 1124 m sector "ref 00:16" (~250 km/h)
  // and DNF'd every honest drive on the limit (docs/07 F4).
  const ghost = solveGhost(road, { seed: SEED, gates, carId: 'A' });
  return { world, terrain, road, gates, carveIndex, ghost, genMs: performance.now() - t0 };
}

/**
 * @param mode 'clean' | 'skip1' | 'skip2' | 'slow' | 'limit'
 * The driver is the smoke-test pure pursuit: lookahead scales with speed, the
 * steering command is rate-limited, so the whole stage is drivable headlessly.
 */
function drive(mode, refTime, refSectors = null) {
  const st = makeStage();
  const { world, terrain, road, gates, carveIndex } = st;
  // Same floor() shim main.js installs: world.surfaceAt indexes a column with a
  // fractional local offset, so without it every wheel reads the 'unknown' surface.
  const carWorld = Object.create(world);
  carWorld.surfaceAt = (x, z) => world.surfaceAt(Math.floor(x), Math.floor(z));
  carWorld.rutAt = (x, z) => world.rutAt(Math.floor(x), Math.floor(z));
  const car = new Vehicle('A', carWorld, { assists: { abs: false, tc: false, counterSteer: false, autoShift: true } });
  car.placeAt(road.x[START], road.z[START], -road.heading[START], road.h[START]);
  car.wheels.forEach((w) => { w.omega = 0; });

  const bus = new Emitter();
  const log = { checkpoint: [], penalty: [], finished: null, dnf: null };
  bus.on('checkpoint', (p) => log.checkpoint.push(p));
  bus.on('penalty', (p) => log.penalty.push(p));
  bus.on('finished', (r) => { log.finished = r; });
  bus.on('dnf', (r) => { log.dnf = r; });

  const stage = new StageRun({ road, gates, seed: SEED, refTime, refSectors, emit: bus });
  // Gate numbers to skip: 'skip1' drops checkpoint 2, 'skip2' drops 2 and 4.
  const skipList = mode === 'skip1' ? [2] : (mode === 'skip2' ? [2, 4] : []);
  const input = { throttle: 0, brake: 0, steer: 0, handbrake: 0, shiftUp: 0, shiftDown: 0 };

  const slow = mode === 'slow';
  let nan = false, maxAir = 0, steps = 0, skipped = 0, teleports = 0, recoveries = 0, stuck = 0;
  let arcMax = 0, maxLat = 0;
  const maxSteps = Math.round(560 / DT);
  for (let i = 0; i < maxSteps; i++) {
    const idx = Math.max(0, road.nearest(car.body.pos.x, car.body.pos.z));
    const sp = Math.max(1, car.body.groundSpeed);
    const ds = road.s[1] - road.s[0];

    // ---- pace + steering: the smoke-test pure pursuit, given a rally pace model
    // (v = sqrt(a_lat / kappa) at the tightest point ahead, braking distance folded
    // in — the same offline plan docs/03 §6 step 2 describes). ----
      const ALAT = slow ? 1.4 : 9, VMAX = slow ? 6 : 26, DECEL = slow ? 1.5 : 7;
    let look = Math.max(12, Math.min(26, 10 + sp * 1.1));
    let vLim = VMAX, kAhead = 1e-4;
    for (let q = idx; q <= Math.min(road.n - 1, idx + 140); q++) {
      const k = Math.abs(road.kappa[q]);
      const vl = k > 1e-4 ? Math.min(VMAX, Math.sqrt(ALAT / k)) : VMAX;
      const allowed = Math.sqrt(vl * vl + 2 * DECEL * (road.s[q] - road.s[idx]));
      if (allowed < vLim) vLim = allowed;
      if (k > kAhead) kAhead = k;
    }
    look = Math.min(look, Math.max(12, 0.45 / kAhead));   // hug a hairpin instead of cutting it
    const j = Math.min(road.n - 1, idx + Math.max(1, Math.round(look / ds)));
    const want = Math.atan2(road.z[j] - car.body.pos.z, road.x[j] - car.body.pos.x);
    let dA = want - Math.atan2(car.body.forward.z, car.body.forward.x);
    while (dA > Math.PI) dA -= 2 * Math.PI;
    while (dA < -Math.PI) dA += 2 * Math.PI;
    const target = Math.max(-1, Math.min(1, -Math.atan(2 * car.params.wheelbase * Math.sin(dA) / look) / car.params.steerMax));
    input.steer += Math.sign(target - input.steer) * Math.min(Math.abs(target - input.steer), 6 * DT);
    if (stage.state === STATE.PRE_START) {
      input.throttle = 0; input.brake = 1;      // hold the car until GO (no jump start)
    } else {
      input.throttle = sp < vLim * 0.95 ? 0.85 : (sp < vLim * 1.08 ? 0.35 : 0.1);
      input.brake = sp > vLim * 1.1 ? Math.min(0.85, (sp - vLim) * 0.07) : 0;
    }
    input.handbrake = 0;

    // ---- on-stage guards: the same two the player has (docs/06 §5 R / zakotwiczenie) ----
    const lat = Math.hypot(car.body.pos.x - road.x[idx], car.body.pos.z - road.z[idx]);
    maxLat = Math.max(maxLat, lat);
    const roll = Math.abs(Math.asin(Math.max(-1, Math.min(1, -car.body.m[7]))) * 57.3);
    if (lat > 6 || roll > 22) {
      car.placeAt(road.x[Math.min(road.n - 2, idx + 2)], road.z[Math.min(road.n - 2, idx + 2)],
        -road.heading[Math.min(road.n - 2, idx + 2)], road.h[Math.min(road.n - 2, idx + 2)]);
      car.wheels.forEach((w2) => { w2.omega = car.body.groundSpeed / w2.rEff; });
      recoveries++;
    }
    if (car.body.groundSpeed < 1.2) stuck++; else stuck = 0;
    if (stuck > 150 && mode !== 'slow') {   // 'slow' must be allowed to stall into a DNF
      const k = Math.min(road.n - 2, idx + 5);
      car.placeAt(road.x[k], road.z[k], -road.heading[k], road.h[k]);
      car.wheels.forEach((w2) => { w2.omega = 6; });
      stuck = 0; recoveries++;
    }
    if (stage.arc > arcMax) arcMax = stage.arc;

    // ---- forcing a skipped checkpoint: drop the car past the gate plane, outside
    // the crossing window, so the state machine must judge it as missed (docs/03 §4) ----
    if (skipped < skipList.length) {
      const gate = gates[skipList[skipped]];
      if (gate && stage.furthest >= gate.arc - 30 && stage.furthest < gate.arc + 10) {
        // Past the gate line AND 60 m sideways: the gate plane crossing test of
        // docs/03 §4 cannot fire, so the state machine has to judge it as missed.
        const at = road.indexAt(gate.arc + 90);
        car.placeAt(road.x[at] + road.nx[at] * 60, road.z[at] + road.nz[at] * 60,
          -road.heading[at], road.h[at] + 0.4);
        car.wheels.forEach((w2) => { w2.omega = car.body.groundSpeed / w2.rEff; });
        teleports++; skipped++;
      }
    }

    car.setInput(input);
    car.step(DT);
    stage.step(DT, car);
    steps++;
    if (!Number.isFinite(car.body.pos.y)) { nan = true; break; }
    maxAir = Math.max(maxAir, car.airborneWheels);
    if (i % 240 === 0) prewarmArea(world, terrain, road, carveIndex, car.body.pos.x, car.body.pos.z, 90);
    if (stage.state === STATE.FINISHED || stage.state === STATE.DNF) break;
  }

  return {
    mode, stage, log, steps, nan, maxAir, road, gates, world, car,
    endSpeed: car.body.groundSpeed, chunks: world.chunkCount, endArc: stage.arc,
    arcMax, maxLat, recoveries, teleports, genMs: st.genMs, ghost: st.ghost,
  };
}

function printRun(r) {
  const res = r.stage.result || r.stage.timing.classify('RUNNING');
  console.log(`\n--- ${r.mode}: ${r.stage.state}${r.stage.reason ? ` (${r.stage.reason})` : ''}  `
    + `czas ${formatTime(res.total)}  split ${formatSplit(res.split)}  kary +${res.penaltyTotal}s  `
    + `limit ${formatTime(res.limit)}  steps ${r.steps}  v_end ${r.endSpeed.toFixed(1)} m/s`);
  for (const s of res.sectors) {
    console.log(`    S${s.index}  arc->${s.toArc.toFixed(0)}  czas ${s.time >= 0 ? formatTime(s.time) : '—'}`
      + `  split ${formatSplit(s.split)}  ref ${formatTime(s.refTime)}${s.penaltyHere ? `  kary +${s.penaltyHere}s` : ''}`);
  }
  for (const p of res.penalties) console.log(`    KARA  +${p.seconds}s  ${p.label}`);
  console.log(`    checkpointy w kolejnosci: ${r.log.checkpoint.map((c) => c.number).join(',') || '—'}`
    + `  missed=${r.stage.missed}  maxLat=${r.maxLat.toFixed(1)} m  recoveries=${r.recoveries}  teleports=${r.teleports}`
    + `  chunks(materialized)=${r.chunks}  maxAir=${r.maxAir}  nan=${r.nan}`);
}

const probe = makeStage();
const ghost = probe.ghost;
const notes = buildPaceNotes(probe.road, ghost);
const refTime = ghost.refTime, refSectors = ghost.refSectors;
console.log(`stage: ${BIOME} seed ${SEED} target ${LEN} m  road ${probe.road.length.toFixed(0)} m`
  + `  ghost ref ${formatTime(refTime)}  limit ${formatTime(refTime * 1.6)}  (solve ${ghost.solveMs.toFixed(1)} ms)`);
console.log(`ghost sectors: ${ghost.sectors.map((s) => `S${s.index}:${formatTime(s.time)}`).join('  ')}`
  + `   pace notes: ${notes.count}`);

const clean = drive('clean', refTime, refSectors);
printRun(clean);

// ---- A. checkpoint sequence, splits, penalties, limit + DNF paths ----
const cps = clean.log.checkpoint;
ok(clean.stage.state === STATE.FINISHED, 'A1 clean run FINISHED', clean.stage.reason);
ok(clean.stage.gates.length === 6, 'A2 stage has 6 checkpoint gates (start + 4 sectors + finish)', `${clean.stage.gates.length}`);
ok(cps.length === 5 && cps.map((c) => c.number).join(',') === '1,2,3,4,5',
  'A3 every gate after the start line is taken, in order', cps.map((c) => c.number).join(','));
ok(clean.stage.gateRuns[5].taken && clean.arcMax >= clean.road.length - 60, 'A3b the whole stage length is driven (finish gate crossed)',
  `${clean.arcMax.toFixed(0)} / ${clean.road.length.toFixed(0)} m`);
ok(clean.log.penalty.length === 0 && clean.stage.result.penaltyTotal === 0, 'A4 clean run carries no penalty');
ok(!clean.nan, 'A5 no NaN in the drive', `end v ${clean.endSpeed.toFixed(1)} m/s arc ${clean.endArc.toFixed(0)}`);
const splitClean = clean.stage.result.split;
ok(Math.abs(splitClean) < 20, 'A6 split vs a sane reference is a small, real number', `${formatSplit(splitClean)}`);
ok(clean.log.checkpoint.every((c, i) => Math.abs(c.split - (c.total - clean.stage.timing.refUpTo(i))) < 0.02),
  'A6b each split = cumulative time - cumulative reference',
  clean.log.checkpoint.map((c) => formatSplit(c.split)).join(' '));

const skip1 = drive('skip1', refTime, refSectors);
printRun(skip1);
ok(skip1.stage.missed === 1 && skip1.log.penalty.length === 1 && skip1.log.penalty[0].record.seconds === 30,
  'A7 skipping one checkpoint adds the documented +30 s (docs/03 §4)',
  `missed=${skip1.stage.missed} penalties=${skip1.log.penalty.map((p) => p.record.seconds).join(',')}`);
ok(skip1.stage.state === STATE.FINISHED, 'A8 run with one skipped checkpoint still FINISHES',
  `czas ${formatTime(skip1.stage.result.total)} vs clean ${formatTime(clean.stage.result.total)}`);
ok(skip1.stage.result.total > clean.stage.result.total, 'A9 penalty is inside the classified total',
  `+${(skip1.stage.result.total - clean.stage.result.total).toFixed(2)} s`);

const skip2 = drive('skip2', refTime, refSectors);
printRun(skip2);
ok(skip2.stage.state === STATE.DNF && skip2.stage.reason === 'gates',
  'A10 two missed checkpoints -> DNF (docs/03 §4)', `${skip2.stage.reason}`);

const slow = drive('slow', refTime, refSectors);
printRun(slow);
ok(slow.stage.state === STATE.DNF && (slow.stage.reason === 'limit' || slow.stage.reason === 'stuck'),
  'A11 slow/erratic driver reaches a DNF path', `${slow.stage.reason} @ ${formatTime(slow.stage.result.total)} (limit ${formatTime(slow.stage.result.limit)})`);

const limited = drive('clean', 60);      // ref 60 s -> limit 96 s: the limit path, forced
printRun(limited);
ok(limited.stage.state === STATE.DNF && limited.stage.reason === 'limit',
  'A12 time limit = ref * 1.6 is enforced (docs/03 §4)', `${formatTime(limited.stage.result.total)} > ${formatTime(limited.stage.result.limit)}`);

// ---- B. determinism: same drive, same stage, identical numbers ----
const again = drive('clean', refTime, refSectors);
const a = clean.stage.result, b = again.stage.result;
const dtTotal = Math.abs(a.total - b.total);
const dtSplit = Math.abs(a.split - b.split);
let dtSector = 0;
for (let i = 0; i < a.sectors.length; i++) dtSector = Math.max(dtSector, Math.abs(a.sectors[i].time - b.sectors[i].time));
console.log(`\n--- determinism (two identical drives)`);
console.log(`    total  ${a.total.toFixed(6)} vs ${b.total.toFixed(6)}   diff ${dtTotal.toFixed(6)} s`);
console.log(`    split  ${a.split.toFixed(6)} vs ${b.split.toFixed(6)}   diff ${dtSplit.toFixed(6)} s`);
console.log(`    sectors ${a.sectors.map((s, i) => `S${s.index}:${s.time.toFixed(4)}/${b.sectors[i].time.toFixed(4)}`).join(' ')}  max diff ${dtSector.toFixed(6)} s`);
ok(dtTotal === 0 && dtSplit === 0 && dtSector === 0, 'B1 identical stage times on a replayed drive (PLAN.md §8 #7)',
  `diff ${dtTotal.toFixed(6)} s (want 0)`);

// ---- C. HUD cost against a stub DOM (no jsdom installed) ----
class StubEl {
  constructor(tag) {
    this.tag = tag; this.children = []; this.className = ''; this.textContent = '';
    this.style = { width: '' }; this.parentNode = null;
  }
  appendChild(c) { c.parentNode = this; this.children.push(c); return c; }
  removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); c.parentNode = null; return c; }
}
class StubDoc {
  constructor() { this.body = new StubEl('body'); }
  createElement(t) { return new StubEl(t); }
  getElementById() { return null; }
}
const hudDoc = new StubDoc();
const hud = new RallyHud(hudDoc);
const hudCtx = { car: clean.car, stage: clean.stage };
for (let i = 0; i < 120; i++) hud.update(1 / 60, hudCtx);       // warm up
if (typeof gc === 'function') { gc(); }
const heap0 = process.memoryUsage().heapUsed;
const tHud = performance.now();
for (let i = 0; i < 600; i++) hud.update(1 / 60, hudCtx);
const msPerFrame = (performance.now() - tHud) / 600;
const heapPerFrame = (process.memoryUsage().heapUsed - heap0) / 600;
let domNodes = 0;
(function count(el) { domNodes++; for (const c of el.children) count(c); })(hudDoc.body);
console.log(`\n--- HUD cost (600 update() calls, stub DOM, ${domNodes} nodes)`);
console.log(`    ${msPerFrame.toFixed(4)} ms/frame   heap ${heapPerFrame.toFixed(1)} B/frame   stack=[${hud.stack.join(' ')}]`);
ok(msPerFrame <= 0.3, 'C1 HUD update <= 0.3 ms/frame (docs/07 budgets)', `${msPerFrame.toFixed(4)} ms`);
ok(heapPerFrame <= 2048, 'C2 no per-frame allocation in the HUD update path', `${heapPerFrame.toFixed(0)} B/frame`);

// wheel gauges must actually distinguish a wheel that is getting away
const w = clean.car.wheels;
const gaugeTexts = hud.gauges.map((g) => g.val.textContent);
console.log(`    gauges: ${gaugeTexts.join(' | ')}`);
console.log(`    kappa ${w.map((x) => x.kappa.toFixed(2)).join(' ')}  alpha ${w.map((x) => (x.alpha * 57.3).toFixed(1)).join(' ')}  slipEnergy ${w.map((x) => x.slipEnergy.toFixed(0)).join(' ')}`);
ok(gaugeTexts.every((t) => t.length > 0), 'C3 four per-wheel gauges are populated (PLAN.md §8 #2)');

// budgets that are measurable headless; draw calls / streamed meshes come from the
// F3 profiler in the browser (see SYSTEM-NOTES.md)
console.log(`\n--- budgets`);
console.log(`    stage generation ${clean.genMs.toFixed(0)} ms (budget 1200 ms, docs/07)`);
console.log(`    chunks materialized for the whole 4.2 km drive: ${clean.chunks} (world cache, not scene meshes)`);
ok(clean.genMs <= 1200, 'D1 stage generation budget', `${clean.genMs.toFixed(0)} ms`);

// ---- E. the reference itself: geometric sector refs, plausible speeds, quicker than the driver ----
console.log('\n--- ghost reference (docs/03 §6)');
for (const s of clean.ghost.sectors) {
  console.log(`    S${s.index} ${s.dist.toFixed(0)} m  ref ${formatTime(s.time)}  avg ${(3.6 * s.avgSpeed).toFixed(1)} km/h`
    + `  R_min ${s.tightestRadius.toFixed(1)} m  ghost ${s.ghostAtTightest.toFixed(2)} m/s <= sqrt(mu*g*R) ${s.frictionCircleSpeed.toFixed(2)} m/s`);
}
const integrated = clean.stage.timing.sectors.every((sec, i) => Math.abs(sec.refTime - ghost.refSectors[i]) < 1e-6);
const flatPlaceholder = Math.abs(ghost.refTime - LEN / 15) > 5 && Math.abs(ghost.refTime - LEN / 20) > 5;
ok(integrated && flatPlaceholder, 'E1 sector refs are the integrated ghost time between the gates, not a length/const-speed share',
  `${ghost.refSectors.map((r) => r.toFixed(1) + 's').join(' / ')}  (flat LEN/15 = ${(LEN / 15).toFixed(1)}s, LEN/20 = ${(LEN / 20).toFixed(1)}s)`);
ok(ghost.sectors.every((s) => s.ghostAtTightest <= s.frictionCircleSpeed + 1e-3), 'E2 no ghost corner exceeds sqrt(mu_eff*g*R)',
  `worst ratio ${Math.max(...ghost.sectors.map((s) => s.ghostAtTightest / s.frictionCircleSpeed)).toFixed(3)}`);
ok(ghost.refTime < clean.stage.result.total && Math.abs(ghost.refTime - clean.stage.result.total) / clean.stage.result.total < 0.25,
  'E3 ghost is quicker than the harness driver and within +/-25 % of it',
  `${formatTime(ghost.refTime)} vs driver ${formatTime(clean.stage.result.total)} (${(100 * (1 - ghost.refTime / clean.stage.result.total)).toFixed(1)} % quicker)`);
ok(clean.ghost.solveMs <= 200, 'E4 stage solve budget <= 200 ms', `${clean.ghost.solveMs.toFixed(1)} ms`);

console.log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILURES'}`);
process.exit(failures ? 1 : 0);
