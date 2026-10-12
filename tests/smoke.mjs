// Node smoke tests for the pure game core:
//   node tests/smoke.mjs
// Covers stage determinism, the named stage roster (length, checkpoint
// scaling, road sanity), mesher culling, a 2000-step physics run free
// of NaNs, and scripted-driver full stage completions (pure pursuit
// along the route, same checkpoint/finish rules as the game), proving
// checkpoints and finish work end to end at real rally length.

import { generateStage, STAGES } from '../src/world/stage.js';
import { meshChunk, meshStatsAround, CHUNK } from '../src/world/mesher.js';
import { createCar, stepCar } from '../src/car/physics.js';

let passed = 0, failed = 0;
const ok = (cond, label) => {
  if (cond) { passed++; console.log(`  ok  ${label}`); }
  else { failed++; console.log(`FAIL  ${label}`); }
};
const finite = (v) => Number.isFinite(v);

// --- Free play determinism ---------------------------------------------------
console.log('free play generation');
const a = generateStage({ biome: 'forest', seed: 42, length: 'medium' });
const b = generateStage({ biome: 'forest', seed: 42, length: 'medium' });
const c = generateStage({ biome: 'forest', seed: 43, length: 'medium' });
ok(a.totalLength === b.totalLength && a.path.length === b.path.length, 'same seed produces identical road');
let sameCols = true;
for (let i = 0; i < 400; i += 37) {
  const p = a.path[i * 7 % a.path.length];
  if (a.columnAt(Math.floor(p.x), Math.floor(p.z)).h !== b.columnAt(Math.floor(p.x), Math.floor(p.z)).h) { sameCols = false; break; }
}
ok(sameCols, 'same seed produces identical columns');
ok(Math.abs(a.totalLength - 4000) / 4000 < 0.03, `free medium length hits target (${(a.totalLength / 1000).toFixed(2)} km)`);
ok(Math.abs(c.totalLength - a.totalLength) < 60 && c.path[100].x !== a.path[100].x, 'different seed produces a different stage');
for (const [len, target] of [['short', 2400], ['long', 6000]]) {
  const s = generateStage({ biome: 'desert', seed: 5, length: len });
  ok(Math.abs(s.totalLength - target) / target < 0.03, `free ${len} length hits target (${(s.totalLength / 1000).toFixed(2)} km)`);
  ok(s.checkpoints.length >= 4, `free ${len} has checkpoints (${s.checkpoints.length})`);
}

// --- Named stage roster --------------------------------------------------------
console.log('named stages');
const stages = {};
for (const def of STAGES) {
  const s = generateStage({ stageId: def.id });
  stages[def.id] = s;
  const target = def.lengthKm * 1000;
  ok(Math.abs(s.totalLength - target) / target <= 0.12,
    `${def.id}: length ${(s.totalLength / 1000).toFixed(2)} km vs design ${def.lengthKm} km`);
  ok(s.checkpoints.length >= 6, `${def.id}: checkpoint count scales (${s.checkpoints.length})`);
  const spacing = s.totalLength / (s.checkpoints.length + 1);
  ok(spacing >= 350 && spacing <= 780, `${def.id}: checkpoint spacing ${spacing.toFixed(0)} m in 350-780 band`);
  ok(s.corners.length >= 4, `${def.id}: pace note corners found (${s.corners.length})`);
  ok(s.props.length > 800, `${def.id}: props scattered (${s.props.length})`);
  let roadOk = true, maxGrade = 0;
  for (let i = 1; i < s.path.length; i++) {
    const h0 = s.path[i - 1].roadH, h1 = s.path[i].roadH;
    if (!finite(h0) || !finite(h1) || !finite(s.groundHeight(s.path[i].x, s.path[i].z))) { roadOk = false; break; }
    const d = Math.max(0.4, s.path[i].dist - s.path[i - 1].dist);
    maxGrade = Math.max(maxGrade, Math.abs(h1 - h0) / d);
  }
  ok(roadOk, `${def.id}: road heights finite along the full ${(s.totalLength / 1000).toFixed(1)} km`);
  ok(maxGrade < 0.34, `${def.id}: road grade stays drivable (max ${(maxGrade * 100).toFixed(0)}%)`);
}

// --- Mesher --------------------------------------------------------------------
console.log('mesher');
const fin = stages.finland;
const anchor = fin.path[Math.floor(fin.path.length / 2)];
const stats = meshStatsAround(fin, anchor.x, anchor.z, 2);
ok(stats.faces > 0, `mesher emits faces (${stats.faces})`);
ok(stats.faces < stats.naive * 0.75, `culling beats naive (${stats.faces} vs ${stats.naive})`);
const chunk = meshChunk(fin, Math.floor(anchor.x / CHUNK), Math.floor(anchor.z / CHUNK));
ok(chunk.positions.length === chunk.normals.length, 'positions and normals aligned');
ok(chunk.positions.length / 3 === chunk.uvs.length / 2, 'positions and uvs aligned');
ok(chunk.indices.length === chunk.faceCount * 6, 'index count matches face count');
let meshFinite = true;
for (let i = 0; i < chunk.positions.length; i += 613) if (!finite(chunk.positions[i])) { meshFinite = false; break; }
ok(meshFinite, 'mesh positions are finite');
let unitNormals = true;
for (let i = 0; i < chunk.normals.length; i += 3 * 977) {
  const len = Math.hypot(chunk.normals[i], chunk.normals[i + 1], chunk.normals[i + 2]);
  if (Math.abs(len - 1) > 0.01) { unitNormals = false; break; }
}
ok(unitNormals, 'mesh normals are unit length');

// --- Physics ---------------------------------------------------------------------
console.log('physics');
const env = { groundHeight: a.groundHeight, surfaceAt: a.surfaceAt, bounds: a.bounds, params: {} };
const car = createCar(a.startPose);
const inputs = [
  { throttle: 1, brake: 0, steer: 0, handbrake: false },
  { throttle: 1, brake: 0, steer: 0.7, handbrake: false },
  { throttle: 1, brake: 0, steer: -0.7, handbrake: true },
  { throttle: 0, brake: 1, steer: 0.3, handbrake: false },
  { throttle: 0.6, brake: 0, steer: -1, handbrake: true },
  { throttle: 1, brake: 0, steer: 1, handbrake: false },
];
let nanFree = true, maxSpeed = 0;
const dt = 1 / 60;
for (let i = 0; i < 2000; i++) {
  const input = inputs[Math.floor(i / 300) % inputs.length];
  stepCar(car, input, dt, env);
  if (!finite(car.x) || !finite(car.z) || !finite(car.y) || !finite(car.heading) || !finite(car.vx) || !finite(car.vz)) { nanFree = false; break; }
  maxSpeed = Math.max(maxSpeed, car.speed);
}
ok(nanFree, '2000 physics steps produce no NaN');
ok(maxSpeed > 18, `car reaches speed under throttle (peak ${(maxSpeed * 3.6).toFixed(0)} km/h)`);
ok(car.x >= a.bounds.minX && car.x <= a.bounds.maxX && car.z >= a.bounds.minZ && car.z <= a.bounds.maxZ, 'car stays inside stage bounds');

const car2 = createCar(a.startPose);
for (let i = 0; i < 300; i++) stepCar(car2, { throttle: 1, brake: 0, steer: 0, handbrake: false }, dt, env);
const moved = Math.hypot(car2.x - a.startPose.x, car2.z - a.startPose.z);
ok(moved > 40 && car2.speed > 10, `car drives away from the start (${moved.toFixed(0)} m in 5 s)`);

const car3 = createCar(a.startPose);
for (let i = 0; i < 240; i++) stepCar(car3, { throttle: 1, brake: 0, steer: 0, handbrake: false }, dt, env);
let stoppedAt = -1;
for (let i = 0; i < 400; i++) {
  stepCar(car3, { throttle: 0, brake: 1, steer: 0, handbrake: false }, dt, env);
  if (car3.speedF <= 0.05) { stoppedAt = i; break; }
}
ok(stoppedAt > 0 && car3.speed < 1.2, `car brakes to a stop (${(stoppedAt / 60).toFixed(1)} s of braking)`);

// --- Scripted driver: full stage completion --------------------------------------
// Pure pursuit along the route with curvature based speed targets, plus
// the game's own reset-to-road when stuck. Checkpoint and finish rules
// mirror src/main.js checkRaceProgress().
function driveStage(s, label) {
  const envS = { groundHeight: s.groundHeight, surfaceAt: s.surfaceAt, bounds: s.bounds, params: {} };
  const st = createCar(s.startPose);
  const path = s.path;
  const DT = 1 / 120;
  let lastIdx = 0, nextCp = 0, resets = 0, stuckT = 0, simT = 0;
  const finishDist = path[s.finishIdx].dist;
  const angNorm = (v) => ((v + Math.PI * 3) % (Math.PI * 2)) - Math.PI;

  while (simT < 1500) {
    // Progress: nearest path index in a window around the last one.
    let bestI = lastIdx, bestD = Infinity;
    const lo = Math.max(0, lastIdx - 40), hi = Math.min(path.length - 1, lastIdx + 90);
    for (let i = lo; i <= hi; i++) {
      const dx = path[i].x - st.x, dz = path[i].z - st.z;
      const d = dx * dx + dz * dz;
      if (d < bestD) { bestD = d; bestI = i; }
    }
    lastIdx = bestI;
    const pd = path[lastIdx].dist;
    if (nextCp < s.checkpoints.length && pd >= s.checkpoints[nextCp].dist) nextCp++;
    if (pd >= finishDist) {
      return { finished: true, time: simT, cps: nextCp, resets };
    }
    // Speed target from curvature over the next 70 m.
    let vmax = 47;
    for (let i = lastIdx; i < Math.min(path.length - 1, lastIdx + 70); i += 3) {
      const r = 1 / Math.max(Math.abs(path[i].curv), 1e-4);
      vmax = Math.min(vmax, Math.sqrt(30 * r));
    }
    vmax = Math.max(8, vmax);
    // Pure pursuit target.
    const look = Math.min(58, Math.max(13, st.speed * 1.15));
    let ti = lastIdx;
    while (ti < path.length - 1 && path[ti].dist - pd < look) ti++;
    const tp = path[ti];
    const desired = Math.atan2(tp.x - st.x, -(tp.z - st.z));
    const diff = angNorm(desired - st.heading);
    const steer = Math.max(-1, Math.min(1, diff * 1.9));
    let throttle = 0, brake = 0, handbrake = false;
    if (st.speed < vmax - 0.5) throttle = 1;
    if (st.speed > vmax + 2.2) brake = 1;
    if (Math.abs(diff) > 1.05 && st.speed > 11) { handbrake = true; throttle = 0; }
    stepCar(st, { throttle, brake, steer, handbrake }, DT, envS);
    simT += DT;
    if (st.speed < 0.7 && throttle > 0) {
      stuckT += DT;
      if (stuckT > 2.2) {
        const p = path[Math.min(lastIdx + 2, path.length - 1)];
        st.x = p.x; st.z = p.z; st.y = s.groundHeight(p.x, p.z);
        st.heading = p.heading; st.vx = 0; st.vz = 0; st.vy = 0; st.grounded = true;
        resets++; stuckT = 0;
      }
    } else stuckT = 0;
    if (!finite(st.x) || !finite(st.z) || !finite(st.y)) return { finished: false, time: simT, cps: nextCp, resets, nan: true };
  }
  return { finished: false, time: simT, cps: nextCp, resets };
}

console.log('scripted driver (full stage completions)');
for (const id of ['finland', 'kenya']) {
  const s = stages[id];
  const r = driveStage(s, id);
  ok(r.finished && !r.nan, `${id}: driver finishes the full ${(s.totalLength / 1000).toFixed(1)} km stage (${r.time.toFixed(0)} s sim, ${r.resets} resets)`);
  ok(r.cps === s.checkpoints.length, `${id}: all ${s.checkpoints.length} checkpoints hit in order (got ${r.cps})`);
  ok(r.resets <= 15, `${id}: resets stay reasonable (${r.resets})`);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
