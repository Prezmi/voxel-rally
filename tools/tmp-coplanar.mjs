// Probe: find different-colour faces that share a plane (or come within EPS) with
// overlapping footprints in GeoBuilder geometry.
import { GeoBuilder } from '../src/render/primitives.js';
import { buildGateGeometry } from '../src/world/props.js';

class FakeGeo {
  constructor() { this.attrs = {}; }
  setAttribute(n, a) { this.attrs[n] = a.array; }
  setIndex(i) { this.index = i; }
  computeBoundingSphere() {}
}
const THREE_STUB = { BufferGeometry: FakeGeo, Float32BufferAttribute: class { constructor(a) { this.array = a; } } };

export function faces(buildFn) {
  const b = buildFn(GeoBuilder, THREE_STUB);
  const pos = b.attrs.position, nrm = b.attrs.normal, col = b.attrs.color, idx = b.index;
  const out = [];
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t] * 3, bb = idx[t + 1] * 3, c = idx[t + 2] * 3;
    const n = [nrm[a], nrm[a + 1], nrm[a + 2]];
    const v = [pos[a], pos[a + 1], pos[a + 2]];
    const d = n[0] * v[0] + n[1] * v[1] + n[2] * v[2];
    const cr = (col[a] + col[bb] + col[c]) / 3, cg = (col[a + 1] + col[bb + 1] + col[c + 1]) / 3, cb = (col[a + 2] + col[bb + 2] + col[c + 2]) / 3;
    let minx = Infinity, maxx = -Infinity, miny = Infinity, maxy = -Infinity, minz = Infinity, maxz = -Infinity;
    for (const k of [a, bb, c]) {
      minx = Math.min(minx, pos[k]); maxx = Math.max(maxx, pos[k]);
      miny = Math.min(miny, pos[k + 1]); maxy = Math.max(maxy, pos[k + 1]);
      minz = Math.min(minz, pos[k + 2]); maxz = Math.max(maxz, pos[k + 2]);
    }
    out.push({ n, d, cr, cg, cb, minx, maxx, miny, maxy, minz, maxz });
  }
  return { faces: out, tris: idx.length / 3 };
}

export function defects(list, eps = 0.10) {
  const bad = [];
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const A = list[i], B = list[j];
      const dot = Math.abs(A.n[0] * B.n[0] + A.n[1] * B.n[1] + A.n[2] * B.n[2]);
      if (dot < 0.999) continue;
      if (Math.abs(A.d - B.d) > eps) continue;
      if (A.maxx < B.minx || B.maxx < A.minx || A.maxy < B.miny || B.maxy < A.miny || A.maxz < B.minz || B.maxz < A.minz) continue;
      const dc = Math.hypot(A.cr - B.cr, A.cg - B.cg, A.cb - B.cb);
      if (dc < 0.06) continue;
      bad.push({ i, j, gap: Math.abs(A.d - B.d), dc, a: [A.minx, A.maxx, A.miny, A.maxy, A.minz, A.maxz], b: [B.minx, B.maxx, B.miny, B.maxy, B.minz, B.maxz], d: A.d });
    }
  }
  return bad;
}

const gate = faces(buildGateGeometry);
const bad = defects(gate.faces);
console.log(`gate tris=${gate.tris} facePairs=${bad.length}`);
const seen = new Set();
for (const b of bad) {
  const k = `${b.a.map((v) => v.toFixed(2))}|${b.b.map((v) => v.toFixed(2))}`;
  if (seen.has(k)) continue;
  seen.add(k);
  console.log(`d=${b.d.toFixed(3)} gap=${b.gap.toFixed(3)} A[${b.a.map((v) => v.toFixed(2)).join(',')}] B[${b.b.map((v) => v.toFixed(2)).join(',')}]`);
}
