// Node smoke tests for the pure game core:
//   node tests/smoke.mjs
// Covers stage determinism, road drivability, mesher culling and a
// 2000-step physics run free of NaNs.

import { generateStage, SIZE } from '../src/world/stage.js';
import { meshChunk, meshStats, CHUNK } from '../src/world/mesher.js';
import { createCar, stepCar } from '../src/car/physics.js';

let passed = 0, failed = 0;
const ok = (cond, label) => {
  if (cond) { passed++; console.log(`  ok  ${label}`); }
  else { failed++; console.log(`FAIL  ${label}`); }
};
const finite = (v) => Number.isFinite(v);

// --- Stage generation --------------------------------------------------------
console.log('stage generation');
const a = generateStage({ biome: 'forest', seed: 42, length: 'medium' });
const b = generateStage({ biome: 'forest', seed: 42, length: 'medium' });
const c = generateStage({ biome: 'forest', seed: 43, length: 'medium' });

let sameHeights = a.heights.length === b.heights.length;
if (sameHeights) for (let i = 0; i < a.heights.length; i += 97) if (a.heights[i] !== b.heights[i]) { sameHeights = false; break; }
ok(sameHeights, 'same seed produces identical heightfield');
ok(a.path.length === b.path.length && a.totalLength === b.totalLength, 'same seed produces identical road');
let differs = false;
for (let i = 0; i < a.heights.length; i += 131) if (a.heights[i] !== c.heights[i]) { differs = true; break; }
ok(differs, 'different seed produces a different stage');
ok(a.totalLength > 350 && a.totalLength < 1000, `stage length is sane (${a.totalLength.toFixed(0)} m)`);
ok(a.checkpoints.length >= 2, `checkpoints placed (${a.checkpoints.length})`);
ok(a.corners.length >= 3, `pace note corners found (${a.corners.length})`);
ok(a.props.length > 200, `props scattered (${a.props.length})`);

// Road drivability: heights along the centreline are finite and grades sane.
let roadOk = true, maxGrade = 0;
for (let i = 1; i < a.path.length; i++) {
  const h0 = a.groundHeight(a.path[i - 1].x, a.path[i - 1].z);
  const h1 = a.groundHeight(a.path[i].x, a.path[i].z);
  if (!finite(h0) || !finite(h1)) { roadOk = false; break; }
  const d = Math.max(0.2, a.path[i].dist - a.path[i - 1].dist);
  maxGrade = Math.max(maxGrade, Math.abs(h1 - h0) / d);
}
ok(roadOk, 'road centreline heights are finite everywhere');
ok(maxGrade < 0.45, `road grade stays drivable (max ${(maxGrade * 100).toFixed(0)}%)`);

for (const biome of ['desert', 'snow']) {
  const s = generateStage({ biome, seed: 7, length: 'short' });
  ok(s.path.length > 100 && finite(s.totalLength), `${biome} stage generates`);
}

// --- Mesher --------------------------------------------------------------------
console.log('mesher');
const stats = meshStats(a);
ok(stats.faces > 0, `mesher emits faces (${stats.faces})`);
ok(stats.faces < stats.naive * 0.75, `culling beats naive (${stats.faces} vs ${stats.naive})`);
const chunk = meshChunk(a, 8, 8);
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
const env = { groundHeight: a.groundHeight, surfaceAt: a.surfaceAt, params: {} };
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
ok(car.x >= 0 && car.x <= SIZE && car.z >= 0 && car.z <= SIZE, 'car stays inside the world');

// Full throttle from standstill should be moving clearly forward along the road.
const car2 = createCar(a.startPose);
for (let i = 0; i < 300; i++) stepCar(car2, { throttle: 1, brake: 0, steer: 0, handbrake: false }, dt, env);
const moved = Math.hypot(car2.x - a.startPose.x, car2.z - a.startPose.z);
ok(moved > 40 && car2.speed > 10, `car drives away from the start (${moved.toFixed(0)} m in 5 s)`);

// Braking to a stop (before held brake rolls over into reverse).
const car3 = createCar(a.startPose);
for (let i = 0; i < 240; i++) stepCar(car3, { throttle: 1, brake: 0, steer: 0, handbrake: false }, dt, env);
let stoppedAt = -1;
for (let i = 0; i < 400; i++) {
  stepCar(car3, { throttle: 0, brake: 1, steer: 0, handbrake: false }, dt, env);
  if (car3.speedF <= 0.05) { stoppedAt = i; break; }
}
ok(stoppedAt > 0 && car3.speed < 1.2, `car brakes to a stop (${(stoppedAt / 60).toFixed(1)} s of braking)`);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
