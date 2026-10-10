// Asset-backed rally car body (assets/models/rally_v2.glb, built by
// tools/blender/build_rally_car_v2.py). This module is deliberately free of any
// THREE import: it turns the loaded glTF nodes into plain typed arrays plus the
// named damage ranges, so the merge is unit-testable headless
// (src/debug/tests.js) and render/carMesh.js stays the only place that owns a
// BufferGeometry. The output keeps the car shader contract (docs/04 §4.2):
//   position / normal / color    geometry + the glb's own material colour
//                                  (no baked face shading, no per-part tone)
//   aPanel (0..15)               dirt panel per vertex
//   aLivUv, aLiv                 livery coords + strength
//   aLamp                        0 none, 1 headlight, 2 tail-light
// plus `ranges`: contiguous vertex ranges the damage code (carMesh.applyDamage)
// dents and knocks out.
import { PANEL_INDEX, PANEL_COUNT, panelBoxes, classifyPanel } from '../dirt/panel-dirt.js';

export const ASSET_CAR_MODEL = 'rally_v2';

/** Body mesh nodes merged into ONE geometry, in draw order (car-body.js order). */
export const BODY_PARTS = [
  'car_body', 'car_fender', 'car_panel', 'car_lamps', 'car_fascia', 'car_grille',
  'car_splitter', 'car_snorkel', 'car_spoiler', 'car_rear', 'car_diffuser', 'car_flap',
];

/** Wheel pivot nodes, normative order FL FR RL RR (same order as car.wheels). */
export const WHEEL_NODES = ['car_wheel_fl', 'car_wheel_fr', 'car_wheel_rl', 'car_wheel_rr'];

/** Exhaust tip nodes. Merged into the same body geometry as the rest (so the
 *  rear damage range and the rear dirt panel cover them) but TOLERANT: a glb
 *  without them still loads the asset car, the car just gets the default tips. */
export const EXHAUST_PARTS = ['car_exhaust_l', 'car_exhaust_r'];
const EXHAUST_SLOT = { car_exhaust_l: 0, car_exhaust_r: 1 };

/**
 * Mesh name -> default dirt panel key (src/dirt/panel-dirt.js PANELS order).
 * Sided bases (flank / sill / arch) are resolved per triangle with
 * classifyPanel, so left/right and the four arches land where the dirt does.
 */
export const PART_PANEL = {
  car_body: 'flank',
  car_fender: 'archFL',
  car_panel: 'roof',
  car_lamps: 'front',
  car_fascia: 'front',
  car_grille: 'front',
  car_splitter: 'under',
  car_snorkel: 'flank',
  car_spoiler: 'wing',
  car_rear: 'rear',
  car_diffuser: 'under',
  car_flap: 'flank',
  car_exhaust_l: 'rear',
  car_exhaust_r: 'rear',
};

/** Damage regions emitted, in merge order (each one a contiguous range). */
export const REGIONS = ['hood', 'roof', 'glass', 'flank', 'front', 'bumperF',
  'rear', 'under', 'wing', 'lampFL', 'lampFR'];

const SIDED_BASE = /^(flank|sill|arch)/;
const LIV_PARTS = new Set(['car_body', 'car_fender', 'car_panel', 'car_spoiler']);

/** Car-local envelope from params. Heights are ASSET frame (the glb is authored
 *  with the ground at y = 0); `g` is the CoM-frame ground used for the fit. */
export function assetShape(p) {
  const g = -p.comY;
  return {
    g, floor: 0.15, belt: 0.82, roof: 1.28,
    hx: p.hull.x, hz: p.hull.z, wb: p.wheelbase / 2,
    tf: p.trackFront / 2, tr: p.trackRear / 2,
  };
}

/** Damage region of one triangle centroid (disjoint; contiguous ranges). */
export function regionOf(name, cx, cy, cz, ny, s, matName) {
  const mn = matName || '';
  if (EXHAUST_SLOT[name] !== undefined) return 'rear';
  if (name === 'car_lamps' || /lamp|tail/.test(mn)) return cz < 0 ? 'lampFL' : 'lampFR';
  if (/glass/.test(mn)) return 'glass';
  if (name === 'car_fascia') return 'bumperF';
  if (name === 'car_grille') return 'front';
  if (name === 'car_rear' || name === 'car_diffuser') return 'rear';
  if (name === 'car_spoiler') return 'wing';
  if (name === 'car_splitter') return 'under';
  if (name === 'car_flap' || name === 'car_snorkel') return 'flank';
  if (cy <= s.floor + 0.02) return 'under';
  if (name === 'car_panel') {
    if (Math.abs(ny) > 0.55 && cy > s.belt + 0.30) return 'roof';
    if (Math.abs(ny) <= 0.55) return 'glass';
    return 'flank';
  }
  if (cx > s.hx * 0.25 && cy > s.belt - 0.10 && ny > 0.55) return 'hood';
  return 'flank';
}

/** Panel index of one triangle: PART_PANEL name map, sided ones via classifyPanel. */
export function panelOf(name, cx, cy, cz, boxes) {
  const key = PART_PANEL[name] || 'flank';
  if (!SIDED_BASE.test(key)) {
    const i = PANEL_INDEX[key];
    if (i !== undefined) return i;
  }
  return classifyPanel(cx, cy, cz, boxes);
}

/** The colour of the material the node was exported with, already in the
 *  renderer's linear working space. Nothing else: no per-part tone table, no
 *  sRGB re-encode. A node with no material stays neutral white and is lit by
 *  the scene rather than painted. */
function tintOf(mat) {
  const c = mat && mat.color;
  if (c && Number.isFinite(c.r) && Number.isFinite(c.g) && Number.isFinite(c.b)) return [c.r, c.g, c.b];
  return [1, 1, 1];
}

/**
 * Merge the body nodes of `nodes` (Map name -> {geometry, material, node}, see
 * render/assets.js loadModelNodes) into one vertex set.
 * Returns { position, normal, color, aPanel, aLivUv, aLiv, aLamp, ranges, tris,
 *           scale, tris, missing, exhaust }.
 * A missing part is skipped and reported; the caller keeps the procedural car
 * when too much is absent. `exhaust` is the two tip positions in the CAR-GROUP
 * local frame (x fwd, y up, z lateral, ground at y = -comY) as
 * Float32Array(6) = [lx,ly,lz, rx,ry,rz], or null when the glb has no tips.
 */
export function buildAssetBody(nodes, params) {
  const s = assetShape(params);
  const boxes = panelBoxes(params);
  const bucket = new Map();
  for (const r of REGIONS) bucket.set(r, []);
  const missing = [];
  let minx = Infinity, maxx = -Infinity, miny = Infinity, maxy = -Infinity, minz = Infinity, maxz = -Infinity;
  let tris = 0;
  const exSum = new Float64Array(6);
  const exN = new Int32Array(2);

  const get = (n) => (nodes && typeof nodes.get === 'function' ? nodes.get(n) : (nodes ? nodes[n] : null));

  for (const name of BODY_PARTS.concat(EXHAUST_PARTS)) {
    const rec = get(name);
    if (!rec || !rec.geometry || !rec.geometry.getAttribute('position')) {
      if (BODY_PARTS.indexOf(name) >= 0) missing.push(name);
      continue;
    }
    const geo = rec.geometry;
    const pos = geo.getAttribute('position');
    const nor = geo.getAttribute('normal');
    const ps = pos.itemSize || 3, ns = (nor ? nor.itemSize || 3 : 3);
    const idx = geo.index && geo.index.array ? geo.index.array : null;
    const np = idx ? idx.length : pos.count;
    const groups = (geo.groups && geo.groups.length)
      ? geo.groups
      : [{ start: 0, count: np, materialIndex: 0 }];
    const mats = Array.isArray(rec.material) ? rec.material : (rec.material ? [rec.material] : []);

    for (const g of groups) {
      const mat = mats[g.materialIndex] || null;
      const matName = mat && mat.name ? String(mat.name) : '';
      const [cr, cg, cb] = tintOf(mat);
      const end = Math.min(np, (g.start || 0) + (g.count || 0));
      for (let k = g.start || 0; k + 2 < end; k += 3) {
        const v = [idx ? idx[k] : k, idx ? idx[k + 1] : k + 1, idx ? idx[k + 2] : k + 2];
        const tri = { x: [0, 0, 0], y: [0, 0, 0], z: [0, 0, 0], nx: [0, 0, 0], ny: [0, 0, 0], nz: [0, 0, 0] };
        let an = 0, anY = 0;
        for (let j = 0; j < 3; j++) {
          const p = v[j] * ps, n = v[j] * ns;
          tri.x[j] = pos.array[p]; tri.y[j] = pos.array[p + 1]; tri.z[j] = pos.array[p + 2];
          if (nor) { tri.nx[j] = nor.array[n]; tri.ny[j] = nor.array[n + 1]; tri.nz[j] = nor.array[n + 2]; }
          else { tri.nx[j] = 0; tri.ny[j] = 1; tri.nz[j] = 0; }
          an += tri.nx[j] * tri.nx[j] + tri.ny[j] * tri.ny[j] + tri.nz[j] * tri.nz[j];
          anY += tri.ny[j];
          if (tri.x[j] < minx) minx = tri.x[j];
          if (tri.x[j] > maxx) maxx = tri.x[j];
          if (tri.y[j] < miny) miny = tri.y[j];
          if (tri.y[j] > maxy) maxy = tri.y[j];
          if (tri.z[j] < minz) minz = tri.z[j];
          if (tri.z[j] > maxz) maxz = tri.z[j];
        }
        const cx = (tri.x[0] + tri.x[1] + tri.x[2]) / 3;
        const cy = (tri.y[0] + tri.y[1] + tri.y[2]) / 3;
        const cz = (tri.z[0] + tri.z[1] + tri.z[2]) / 3;
        const nAvg = an > 1e-12 ? Math.sqrt(an / 3) : 1;
        const ny = anY / 3 / (nAvg || 1);
        const region = regionOf(name, cx, cy, cz, ny, s, matName);
        const slot = EXHAUST_SLOT[name];
        if (slot !== undefined) {
          exSum[slot * 3] += cx; exSum[slot * 3 + 1] += cy; exSum[slot * 3 + 2] += cz;
          exN[slot]++;
        }
        const panel = panelOf(name, cx, cy, cz, boxes);
        const lamp = (name === 'car_lamps' || /lamp|tail/.test(matName)) ? (cx > s.hx * 0.55 ? 1 : 2) : 0;
        const liv = (LIV_PARTS.has(name) && region !== 'glass' && region !== 'lampFL' && region !== 'lampFR' && region !== 'under') ? 1 : 0;
        const list = bucket.get(region) || bucket.get('flank');
        for (let j = 0; j < 3; j++) {
          list.push(tri.x[j], tri.y[j], tri.z[j], tri.nx[j] / nAvg, tri.ny[j] / nAvg, tri.nz[j] / nAvg,
            cr, cg, cb, panel, liv, lamp);
        }
        tris++;
      }
    }
  }

  if (!tris) return { tris: 0, missing: BODY_PARTS.slice(), ranges: {}, position: null };

  // One uniform fit of the whole body to the physics envelope: length vs the
  // collision hull (plus the bumper overhang the asset has), width vs the outer
  // face of the wheels. Never per-axis.
  const sizeX = maxx - minx, sizeZ = maxz - minz;
  const wantLen = 2 * s.hx + 0.24, wantWide = 2 * (Math.max(s.tf, s.tr) + 0.14);
  const scale = Math.min(wantLen / (sizeX || 1), wantWide / (sizeZ || 1));
  const ox = -(minx + maxx) * 0.5 * scale, oz = -(minz + maxz) * 0.5 * scale;
  const oy = s.g - miny * scale;   // asset sits on y=0; the CoM frame has ground at s.g

  let count = 0;
  for (const r of REGIONS) count += bucket.get(r).length / 12;

  const position = new Float32Array(count * 3);
  const normal = new Float32Array(count * 3);
  const color = new Float32Array(count * 3);
  const aPanel = new Float32Array(count);
  const aLivUv = new Float32Array(count * 2);
  const aLiv = new Float32Array(count);
  const aLamp = new Float32Array(count);
  const ranges = {};
  const halfX = sizeX * 0.5 * scale, halfZ = sizeZ * 0.5 * scale, yb = miny * scale + oy, yt = maxy * scale + oy;

  let vi = 0;
  for (const r of REGIONS) {    const list = bucket.get(r);
    if (!list.length) continue;
    const from = vi;
    for (let o = 0; o < list.length; o += 12) {
      const x = list[o] * scale + ox, y = list[o + 1] * scale + oy, z = list[o + 2] * scale + oz;
      const nx = list[o + 3], ny = list[o + 4], nz = list[o + 5];
      position[vi * 3] = x; position[vi * 3 + 1] = y; position[vi * 3 + 2] = z;
      normal[vi * 3] = nx; normal[vi * 3 + 1] = ny; normal[vi * 3 + 2] = nz;
      color[vi * 3] = list[o + 6]; color[vi * 3 + 1] = list[o + 7]; color[vi * 3 + 2] = list[o + 8];
      // Planar livery projection on the dominant axis, as car-body.js does.
      const ax = Math.abs(nx), ay = Math.abs(ny), az = Math.abs(nz);
      let u, vv;
      if (az >= ax && az >= ay) { u = (z + halfZ) / (2 * halfZ || 1); vv = (y - yb) / ((yt - yb) || 1); }
      else if (ay >= ax) { u = (x + halfX) / (2 * halfX || 1); vv = (z + halfZ) / (2 * halfZ || 1); }
      else { u = (z + halfZ) / (2 * halfZ || 1); vv = (y - yb) / ((yt - yb) || 1); }
      aLivUv[vi * 2] = Math.max(0, Math.min(1, u)); aLivUv[vi * 2 + 1] = Math.max(0, Math.min(1, vv));
      aPanel[vi] = list[o + 9]; aLiv[vi] = list[o + 10]; aLamp[vi] = list[o + 11];
      vi++;
    }
    if (vi > from) ranges[r] = [from, vi];
  }

  // Exhaust tip points, in the same fitted frame the vertices were written in:
  // src/fx/fx.js emits the backfire plume from exactly where the tips are.
  let exhaust = null;
  if (exN[0] > 0 && exN[1] > 0) {
    exhaust = new Float32Array(6);
    for (let i = 0; i < 2; i++) {
      exhaust[i * 3] = (exSum[i * 3] / exN[i]) * scale + ox;
      exhaust[i * 3 + 1] = (exSum[i * 3 + 1] / exN[i]) * scale + oy;
      exhaust[i * 3 + 2] = (exSum[i * 3 + 2] / exN[i]) * scale + oz;
    }
  }
  return { position, normal, color, aPanel, aLivUv, aLiv, aLamp, ranges, tris, scale, count, missing, exhaust };
}

/** Fallback tips when the glb has none: rear bumper, one per side, in the same
 *  car-group local frame as `exhaust` above. */
export function defaultExhaust(p) {
  const out = new Float32Array(6);
  const x = -p.hull.x * 0.92, y = -p.comY + 0.30, z = p.trackRear * 0.34;
  out[0] = x; out[1] = y; out[2] = -z;          // car_exhaust_l side
  out[3] = x; out[4] = y; out[5] = z;           // car_exhaust_r side
  return out;
}

/** Uniform tyre fit: the asset tyre radius -> TYRE_BASE.r (never per-axis).
 *  Radius is the widest X/Y extent of the hub-local wheel geometry: the tread
 *  blocks have corner vertices whose hypot is larger than the drum radius. */
export function tyreScale(nodes, rWant, name) {
  const rec = nodes && typeof nodes.get === 'function' ? nodes.get(name) : null;
  const pos = rec && rec.geometry ? rec.geometry.getAttribute('position') : null;
  if (!pos) return 1;
  let r = 0;
  const st = pos.itemSize || 3;
  for (let i = 0; i < pos.count; i++) {
    const d = Math.max(Math.abs(pos.array[i * st]), Math.abs(pos.array[i * st + 1]));
    if (d > r) r = d;
  }
  return r > 1e-6 ? rWant / r : 1;
}

export { PANEL_COUNT };
