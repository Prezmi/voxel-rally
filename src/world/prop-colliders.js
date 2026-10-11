// Scenery collision (docs/03 §5 props, docs/02 §7 impacts): the authored / scattered
// prop list is also a SOLID list, so a tree stops the car instead of the car driving
// through the forest. Physics only: the renderer never reads this module and the
// shipped map format is untouched (a collider is derived from the prop record).
//
// Shapes are resolved in the horizontal plane (X/Z) against a solid standing where
// the prop stands: a car has 1.6 m of suspension travel, so the vertical problem is
// not worth a 3D solver. Kinds:
//   0 CIRCLE   trunk / post / marshal        x, z, r
//   1 CAPSULE  rocks, fence lines            x, z, x2, z2, r
//   2 BOX      tents, walls                  x, z, hx, hz, c=cos(yaw), s=sin(yaw)
//   3 LEGS     a checkpoint gantry           two CIRCLE legs, road stays open
import { CHUNK, chunkKey } from './chunk.js';
import { PROP } from './props.js';

export const CIRCLE = 0, CAPSULE = 1, BOX = 2, LEGS = 3;

/** Grid cell = the CHUNK the props were scattered on, so one build walks one list. */
export const COLLIDER_CELL = CHUNK;

/**
 * Species -> solid shape. Trunk radii are the TRUNK, never the crown: SPRITE_SPEC.w /
 * propFootprint() are crown spread (5.6 m across for an oak), which would wall the
 * stage off. The non-solid species (ferns, bushes, reeds, tufts, billboards, flags)
 * carry solid:false and are skipped at build, so the car never touches them.
 */
export const SPECIES_SHAPE = {
  [PROP.OAK]:       { kind: CIRCLE, r: 0.42 },   // trunk radius at scale 1
  [PROP.PINE]:      { kind: CIRCLE, r: 0.34 },
  [PROP.BIRCH]:     { kind: CIRCLE, r: 0.30 },
  [PROP.DEAD]:      { kind: CIRCLE, r: 0.34 },
  [PROP.POST]:      { kind: CIRCLE, r: 0.11 },   // single fence post
  [PROP.GATE]:      { kind: LEGS,   r: 0.20, span: 2.4 },
  [PROP.MARSHAL]:   { kind: CIRCLE, r: 0.22 },
  [PROP.SPECTATOR]: { kind: CIRCLE, r: 0.30 },
  [PROP.BUSH]:      { solid: false },
  [PROP.FERN]:      { solid: false },
};

/** Name-keyed shapes for content a future pass adds by name (the map format stores a
 *  u8 species id, so these only fire when a prop record carries a species `name`). */
export const NAME_SHAPE = {
  rock:        { kind: CAPSULE, r: 0.85, len: 1.4 },
  boulder:     { kind: CAPSULE, r: 1.10, len: 1.8 },
  tent:        { kind: BOX, hx: 2.40, hz: 1.80 },
  marshal_tent:{ kind: BOX, hx: 2.40, hz: 1.80 },
  wall:        { kind: BOX, hx: 3.00, hz: 0.25 },
  fence:       { kind: CAPSULE, r: 0.09, len: 3.0 },
  gantry:      { kind: LEGS, r: 0.22, span: 3.2 },
  reed:        { solid: false }, tuft: { solid: false }, grass: { solid: false },
  fern:        { solid: false }, bush: { solid: false },
  billboard:   { solid: false }, flag: { solid: false }, banner: { solid: false },
};

// Fence posts stand roughly a metre or two apart; two neighbours within this span get
// a thin capsule between them, which is the fence LINE the driver actually hits.
const FENCE_LINK = 3.2, FENCE_R = 0.09, FENCE_MAX_LINKS = 2;

function shapeFor(p) {
  const named = p.name && NAME_SHAPE[String(p.name).toLowerCase()];
  if (named) return named;
  return SPECIES_SHAPE[p.prop] || null;
}

/**
 * buildColliders(propList) -> { queryNear, hit, eject, count, cells, builtMs, ... }
 * `propList` is a flat array of prop records, or the Map of chunkKey -> prop array
 * that src/world/map-load.js hands over. The grid is keyed by chunk coordinates.
 */
export function buildColliders(propList) {
  const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
  const grid = new Map();
  const colliders = [];
  const posts = [];
  const lists = propList instanceof Map ? propList.values()
    : (Array.isArray(propList) || ArrayBuffer.isView(propList) ? [propList] : propList);

  let seen = 0, solid = 0, skipped = 0;
  for (const list of lists) {
    if (!list) continue;
    for (let i = 0; i < list.length; i++) {
      const p = list[i];
      if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.z)) { skipped++; continue; }
      seen++;
      const sp = shapeFor(p);
      if (!sp || sp.solid === false) { skipped++; continue; }
      const sc = Number.isFinite(p.scale) && p.scale > 0 ? p.scale : 1;
      const yaw = Number.isFinite(p.yaw) ? p.yaw : 0;
      const c = Math.cos(yaw), s = Math.sin(yaw);
      if (sp.kind === LEGS) {
        // legs either side of the gate's own lateral axis: the checkpoint stays open
        const off = sp.span;
        push(grid, colliders, mkCircle(p.x + c * off, p.z + s * off, sp.r * sc, p));
        push(grid, colliders, mkCircle(p.x - c * off, p.z - s * off, sp.r * sc, p));
        solid += 2;
      } else if (sp.kind === CAPSULE) {
        const half = (sp.len || 1.4) * sc * 0.5;
        push(grid, colliders, mkCapsule(p.x - c * half, p.z - s * half,
          p.x + c * half, p.z + s * half, sp.r * sc, p));
        solid++;
      } else if (sp.kind === BOX) {
        push(grid, colliders, mkBox(p.x, p.z, sp.hx * sc, sp.hz * sc, c, s, p));
        solid++;
      } else {
        if (p.prop === PROP.POST) posts.push(colliders.length);
        push(grid, colliders, mkCircle(p.x, p.z, sp.r * sc, p));
        solid++;
      }
    }
  }

  // Fence lines: link each post to its closest neighbours through the grid, which
  // keeps this linear in the post count instead of quadratic in every prop on stage.
  let fences = 0;
  for (const idx of posts) {
    const a = colliders[idx];
    let links = 0;
    const near = queryNear(grid, a.x, a.z, FENCE_LINK);
    for (let i = 0; i < near.length && links < FENCE_MAX_LINKS; i++) {
      const b = near[i];
      if (b === a || b.prop !== PROP.POST) continue;
      const d = Math.hypot(b.x - a.x, b.z - a.z);
      if (d > FENCE_LINK || d < 1e-3) continue;
      push(grid, colliders, mkCapsule(a.x, a.z, b.x, b.z, FENCE_R, a.ref));
      links++; fences++;
    }
  }

  const t1 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
  return {
    grid, colliders, count: colliders.length, cells: grid.size,
    props: seen, solids: solid, skipped, fences, builtMs: t1 - t0,
    queryNear: (x, z, r) => queryNear(grid, x, z, r),
    hit: (x, z, pr, outHit) => hitNear(grid, x, z, pr, outHit),
    eject: (x, z, pr) => ejectOut(grid, x, z, pr),
  };
}

function mkCircle(x, z, r, ref) {
  return { kind: CIRCLE, x, z, x2: x, z2: z, r, hx: 0, hz: 0, c: 1, s: 0, prop: ref.prop, ref };
}
function mkCapsule(x, z, x2, z2, r, ref) {
  return { kind: CAPSULE, x, z, x2, z2, r, hx: 0, hz: 0, c: 1, s: 0, prop: ref.prop, ref };
}
function mkBox(x, z, hx, hz, c, s, ref) {
  return { kind: BOX, x, z, x2: x, z2: z, r: Math.hypot(hx, hz), hx, hz, c, s, prop: ref.prop, ref };
}

/** Insert a shape into every chunk cell its bounding circle touches. */
function push(grid, colliders, sh) {
  colliders.push(sh);
  const c0 = Math.floor((sh.x - sh.r) / COLLIDER_CELL), c1 = Math.floor((sh.x + sh.r) / COLLIDER_CELL);
  const d0 = Math.floor((sh.z - sh.r) / COLLIDER_CELL), d1 = Math.floor((sh.z + sh.r) / COLLIDER_CELL);
  for (let cz = d0; cz <= d1; cz++) {
    for (let cx = c0; cx <= c1; cx++) {
      const k = chunkKey(cx, cz);
      let arr = grid.get(k);
      if (!arr) { arr = []; grid.set(k, arr); }
      arr.push(sh);
    }
  }
}

/** Colliders of every cell overlapping the query square. One module-level scratch
 *  array, reused: the physics step calls this ~8x per substep without allocating. */
let _qn = [];
export function queryNear(grid, x, z, r) {
  _qn.length = 0;
  const c0 = Math.floor((x - r) / COLLIDER_CELL), c1 = Math.floor((x + r) / COLLIDER_CELL);
  const d0 = Math.floor((z - r) / COLLIDER_CELL), d1 = Math.floor((z + r) / COLLIDER_CELL);
  for (let cz = d0; cz <= d1; cz++) {
    for (let cx = c0; cx <= c1; cx++) {
      const arr = grid.get(chunkKey(cx, cz));
      if (!arr) continue;
      for (let i = 0; i < arr.length; i++) if (_qn.indexOf(arr[i]) < 0) _qn.push(arr[i]);
    }
  }
  return _qn;
}

/** The same sweep without the grid: every collider on the stage. Test-only. */
export function queryNearBrute(colliders, x, z, r) {
  const out = [];
  for (const sh of colliders) {
    if (Math.abs(sh.x - x) <= r + sh.r && Math.abs(sh.z - z) <= r + sh.r) out.push(sh);
  }
  return out;
}

/**
 * Deepest penetration of a point of radius pr into a shape. `out` = {nx, nz, depth},
 * the normal pointing OUT of the shape towards the point. Boxes report the smaller of
 * their two axis overlaps, capsules and circles the radial one: that IS the shortest
 * axis, which is what lets a car that somehow ended up inside a shape get ejected.
 */
export function penetration(sh, px, pz, pr, out) {
  if (sh.kind === BOX) {
    const dx = px - sh.x, dz = pz - sh.z;
    const lx = sh.c * dx + sh.s * dz, lz = -sh.s * dx + sh.c * dz;
    const penX = sh.hx + pr - Math.abs(lx), penZ = sh.hz + pr - Math.abs(lz);
    if (penX <= 0 || penZ <= 0) return 0;
    const sx = lx < 0 ? -1 : 1, sz = lz < 0 ? -1 : 1;
    if (penX < penZ) { out.nx = sx * sh.c; out.nz = sx * sh.s; }
    else { out.nx = -sz * sh.s; out.nz = -sz * sh.c; }
    out.depth = Math.min(penX, penZ);
    return out.depth;
  }
  // capsule: closest point on the axis segment, then the circle test around it
  let cx = sh.x, cz = sh.z;
  if (sh.kind === CAPSULE) {
    const ex = sh.x2 - sh.x, ez = sh.z2 - sh.z;
    const l2 = ex * ex + ez * ez;
    let t = 0;
    if (l2 > 1e-9) t = Math.max(0, Math.min(1, ((px - sh.x) * ex + (pz - sh.z) * ez) / l2));
    cx = sh.x + ex * t; cz = sh.z + ez * t;
  }
  let nx = px - cx, nz = pz - cz;
  const d = Math.hypot(nx, nz);
  const depth = sh.r + pr - d;
  if (depth <= 0) return 0;
  if (d < 1e-4) { nx = 0; nz = -1; }        // dead centre: any axis is the shortest
  else { nx /= d; nz /= d; }
  out.nx = nx; out.nz = nz; out.depth = depth;
  return depth;
}

const _hit = { nx: 0, nz: 0, depth: 0, shape: null };
function hitNear(grid, x, z, pr, outHit) {
  const list = queryNear(grid, x, z, pr + 1.6);
  const o = outHit || _hit;
  let best = 0;
  for (let i = 0; i < list.length; i++) {
    const d = penetration(list[i], x, z, pr, _hit);
    if (d > best) {
      best = d;
      o.nx = _hit.nx; o.nz = _hit.nz; o.depth = d; o.shape = list[i];
    }
  }
  return best;
}

/** No trapping: a point that ends up inside a shape is pushed out along its shortest
 *  axis, bounded passes so a wall of colliders can never loop here. */
export function ejectOut(grid, x, z, pr) {
  const x0 = x, z0 = z;
  for (let k = 0; k < 8; k++) {
    const d = hitNear(grid, x, z, pr, _hit);
    if (d <= 0) break;
    x += _hit.nx * (d + 1e-3);
    z += _hit.nz * (d + 1e-3);
  }
  return { x, z, moved: x !== x0 || z !== z0 };
}
