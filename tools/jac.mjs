// Linearise one Vehicle.step() about the parked equilibrium: dominant |lambda|
// per yaw. If |lambda| > 1 only at some yaws, the yaw-dependent term is the bug.
import { VoxelWorld } from '../src/world/chunk.js';
const SRC = (process.argv.find((a) => a.startsWith('--src=')) || '').split('=')[1] || '../src/car/vehicle.js';
const { Vehicle } = await import(SRC);
import { DT } from '../src/core/time.js';

const world = new VoxelWorld(1);
world.groundHeight = () => 0; world.surfaceAt = () => 2; world.rutAt = () => 0;

const SKIP = new Set(['world', 'params', 'body', 'wheels', 'powertrain', 'damage', 'events', 'assists', 'compound', 'setup', 'm', 'I', 'hullLocal']);
function ownDeep(src, dst) {
  for (const k of Object.keys(src)) {
    if (SKIP.has(k)) continue;
    const v = src[k];
    if (typeof v === 'function') continue;
    if (typeof v === 'object' && v !== null) {
      const t = dst[k] || (dst[k] = Array.isArray(v) ? [] : (ArrayBuffer.isView(v) ? new v.constructor(v.length) : {}));
      if (ArrayBuffer.isView(v)) { t.set(v); continue; }
      ownDeep(v, t);
    } else dst[k] = v;
  }
  return dst;
}
function snap(car) {
  const s = {};
  ownDeep(car.body, s.body = {}); ownDeep(car.powertrain, s.powertrain = {});
  ownDeep(car.damage, s.damage = {}); ownDeep(car, s.car = {});
  s.wheels = car.wheels.map((w) => ownDeep(w, {}));
  return s;
}
function restore(car, s) {
  ownDeep(s.body, car.body); ownDeep(s.powertrain, car.powertrain);
  ownDeep(s.damage, car.damage); ownDeep(s.car, car);
  s.wheels.forEach((w, i) => ownDeep(w, car.wheels[i]));
}

// ---- 24-dim state vector: pos3 vel3 attitude3(body) angVel3(body) wy4 wyv4 omega4
function vec(car, q0) {
  const b = car.body, m = b.m, v = [];
  v.push(b.pos.x, b.pos.y, b.pos.z, b.vel.x, b.vel.y, b.vel.z);
  // small attitude error in the body frame: axial vector of (m m0^T) antisymmetric part
  const E = new Float64Array(9);
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) {
    let s = 0; for (let k = 0; k < 3; k++) s += m[r * 3 + k] * q0[k * 3 + c];
    E[r * 3 + c] = s;
  }
  v.push(0.5 * (E[7] - E[5]), 0.5 * (E[2] - E[6]), 0.5 * (E[3] - E[1]));
  // angVel is world frame -> body frame
  for (let i = 0; i < 3; i++) v.push(m[i] * b.angVel.x + m[3 + i] * b.angVel.y + m[6 + i] * b.angVel.z);
  for (const w of car.wheels) v.push(w.y);
  for (const w of car.wheels) v.push(w.vy);
  for (const w of car.wheels) v.push(w.omega * 0.01);
  return v;
}
function perturb(car, j, d) {
  const b = car.body;
  if (j < 3) b.pos[['x', 'y', 'z'][j]] += d;
  else if (j < 6) b.vel[['x', 'y', 'z'][j - 3]] += d;
  else if (j < 9) {                     // body-frame attitude nudge via quat
    const a = d * 0.5, q = b.quat;
    const ax = j === 6 ? a : 0, ay = j === 7 ? a : 0, az = j === 8 ? a : 0;
    const { x, y, z, w } = q;
    q.x += ax * w + ay * z - az * y; q.y += ay * w - ax * z + az * x;
    q.z += az * w + ax * y - ay * x; q.w += -ax * x - ay * y - az * z;
    const l = Math.hypot(q.x, q.y, q.z, q.w); q.x /= l; q.y /= l; q.z /= l; q.w /= l;
    b.refreshFrame();
  } else if (j < 12) {
    const i = j - 9;
    // world-frame angVel from a body-frame unit (columns of m)
    b.angVel.x += (i === 0 ? b.m[0] : i === 1 ? b.m[3] : b.m[6]) * d;
    b.angVel.y += (i === 0 ? b.m[1] : i === 1 ? b.m[4] : b.m[7]) * d;
    b.angVel.z += (i === 0 ? b.m[2] : i === 1 ? b.m[5] : b.m[8]) * d;
  } else if (j < 16) car.wheels[j - 12].y += d;
  else if (j < 20) car.wheels[j - 16].vy += d;
  else car.wheels[j - 20].omega += d / 0.01;
}

const N = 24, SETTLE = 60;
function build(yaw) {
  const base = new Vehicle('A', world, { assists: { autoShift: true } });
  base.placeAt(0, 0, yaw, 0);
  base.setInput({ throttle: 0, brake: 0, steer: 0, handbrake: 0, shiftUp: 0, shiftDown: 0 });
  for (let i = 0; i < SETTLE; i++) base.step(DT);
  const q0 = Float64Array.from(base.body.m);
  const s0 = snap(base);
  const x0 = vec(base, q0);
  base.step(DT);
  const x1 = vec(base, q0);
  const A = [];                                   // rows
  for (let j = 0; j < N; j++) {
    const c = new Vehicle('A', world, { assists: { autoShift: true } });
    c.placeAt(0, 0, yaw, 0);
    c.setInput(base.input);
    restore(c, s0);
    perturb(c, j, 1e-6);
    c.step(DT);
    const d = vec(c, q0);
    for (let i = 0; i < N; i++) (A[i] || (A[i] = new Float64Array(N)))[j] = (d[i] - x1[i]) / 1e-6;
  }
  return { A, x0, x1 };
}

// unsorted QR iteration -> every eigenvalue modulus of the 24x24 one-step map.
// Power iteration alone cannot see the unstable mode: the map also has neutral
// |lambda| = 1 rigid-body modes (drift, constant velocity) that dominate it.
function qrStep(A) {
  const n = A.length;
  const Q = A.map((r) => Float64Array.from(r));
  for (let k = 0; k < n; k++) {
    let nrm = 0; for (let i = 0; i < n; i++) nrm = Math.hypot(nrm, Q[i][k]);
    if (nrm < 1e-300) continue;
    for (let i = 0; i < n; i++) Q[i][k] /= nrm;
    for (let j = k + 1; j < n; j++) {
      let s = 0; for (let i = 0; i < n; i++) s += Q[i][k] * Q[i][j];
      for (let i = 0; i < n; i++) Q[i][j] -= Q[i][k] * s;
    }
  }
  const R = Array.from({ length: n }, () => new Float64Array(n));
  for (let i = 0; i < n; i++) for (let j = i; j < n; j++) { let s = 0; for (let k = 0; k < n; k++) s += Q[k][i] * A[k][j]; R[i][j] = s; }
  const out = Array.from({ length: n }, () => new Float64Array(n));
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) { let s = 0; for (let k = 0; k < n; k++) s += R[i][k] * Q[k][j]; out[i][j] = s; }
  return out;
}
function eigenModuli(A) {
  const n = A.length;
  let M = A.map((r) => Float64Array.from(r));
  for (let it = 0; it < 3000; it++) M = qrStep(M);
  const out = [];
  for (let i = 0; i < n; i++) {
    const a = M[i][i];
    if (i + 1 < n && Math.abs(M[i + 1][i]) > 1e-6 * (Math.abs(a) + Math.abs(M[i + 1][i + 1]) + 1e-30)) {
      const b = M[i][i + 1], c = M[i + 1][i], d = M[i + 1][i + 1];
      const tr = a + d, det = a * d - b * c, disc = tr * tr - 4 * det;
      if (disc < 0) { out.push(Math.sqrt(Math.max(0, det))); i++; }
      else { out.push(Math.abs((tr + Math.sqrt(disc)) / 2)); out.push(Math.abs((tr - Math.sqrt(disc)) / 2)); i++; }
    } else out.push(Math.abs(a));
  }
  return out.sort((x, y) => y - x);
}
function dominant(A) {
  let v = new Float64Array(N).fill(1), lam = 0;
  for (let it = 0; it < 200; it++) {
    const w = new Float64Array(N);
    for (let i = 0; i < N; i++) { let s = 0; for (let j = 0; j < N; j++) s += A[i][j] * v[j]; w[i] = s; }
    let n = 0; for (let i = 0; i < N; i++) n = Math.max(n, Math.abs(w[i]));
    if (n === 0) return 0;
    for (let i = 0; i < N; i++) w[i] /= n;
    lam = n; v = w;
  }
  return lam;
}

const yaws = (process.argv.find((a) => a.startsWith('--yaw=')) || '').split('=')[1];
const list = yaws ? yaws.split(',').map(Number) : [0.4, 1.57, -2.991, 0.0];
const store = {};
for (const yaw of list) {
  const { A, x0, x1 } = build(yaw);
  store[yaw] = A;
  const inc = []; for (let i = 0; i < N; i++) inc.push((x1[i] - x0[i]).toExponential(2));
  const ev = eigenModuli(A);
  console.log(`yaw=${yaw}  |lambda_dom|=${ev[0].toFixed(6)}  top=${ev.slice(0,6).map((x)=>x.toFixed(5)).join(' ')}  unstable=${ev.filter((x)=>x>1.001).length}`);
  console.log(`   fixed-point residual (1 step): ${inc.join(' ')}`);
}
if (list.length > 1) {
  const [a, b] = list;
  const D = [];
  let worst = 0, wi = 0, wj = 0;
  for (let i = 0; i < N; i++) { D[i] = []; for (let j = 0; j < N; j++) { D[i][j] = store[b][i][j] - store[a][i][j]; if (Math.abs(D[i][j]) > worst) { worst = Math.abs(D[i][j]); wi = i; wj = j; } } }
  console.log(`yaw ${a} vs ${b}: largest Jacobian difference |dA|=${worst.toFixed(3)} at row=${wi} col=${wj}`);
  for (let i = 0; i < N; i++) { const r = D[i].map((x) => x.toFixed(1)).join(' '); if (D[i].some((x) => Math.abs(x) > 0.5)) console.log(`  dA row ${i}: ${r}`); }
}
