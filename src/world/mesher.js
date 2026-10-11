// Terrain mesher: face culling + greedy merging + vertex AO (docs/03 §1).
//
// Specialisation: our world is a strict heightfield (every column is solid from
// y=0 to its top; docs/03 §1 caches `height[16*16]` for exactly this reason), so
// a 2.5D greedy mesher over the column grid is correct and far cheaper than a
// general 3D voxel sweep. LOD is cell size:
//   lod 0 -> 1 m cells, AO on      ("full")
//   lod 1 -> 2 m cells             ("simplified")
//   lod 2 -> 4 m cells, no AO      ("silhouette")
// One mesh per chunk regardless of material (per-vertex surface id drives the
// procedural material in the shader) -> 1 draw call per chunk.
//
// Winding convention: front faces are CCW when viewed from outside, Y-up world.
import { CHUNK, WORLD_HEIGHT } from './chunk.js';
import { LANE_WEAR_MIN } from './road-carve.js';
import { blockColor, blockSurface } from './palette.js';
import { hash01 } from './noise.js';

// lod 4 -> 16 m cells: the distant hill band. One merged cell per chunk, so a ridge
// 1 km out costs a handful of triangles and still breaks the sky instead of being sky.
export const LOD_CELL = [1, 2, 4, 8, 16];
// AO floor: a crevice may be shaded, never black. 0.56 on the deepest corner, times
// WALL_SHADE, times the shader's crevice band, is what painted a 1-cell square pit.
const AO_LEVELS = [1.0, 0.90, 0.81, 0.72];
const AO_MIN = 0.80;                 // combined-darkening clamp (see vertex())
const RELIEF_SALT = 0x51b7c3d9;
const TONE_SALT = 0x2c9a1f7b;
// Bed lattice for the MESH, in 1/16-block units. A carved road bed has a different
// `fine` on every column (a 2 % grade moves the column top by ~1/32 m per metre), so a
// greedy merge that requires exactly equal heights never merges: one 1x1 panel per
// column, each with its own crevice AO -> the "plywood ribbon" look in the old shot.
// Snapping the rendered grid to 1/8 m lets a run merge for 6-10 m along a grade and
// keeps every remaining wall >= 1/8 m (no open crack), while chunk.fine / columnTop —
// the physics surface — are untouched, so rendered and simulated height differ <= 6 cm.
const BED_GRID = 2;
const snapQ = (q) => Math.round(q / BED_GRID) * BED_GRID;
// Flat-zone relaxation (measured cause of the "plowed field", SYSTEM-NOTES §22):
// across the loaded corridor 8.7 % of adjacent column pairs differ by 6-94 cm and
// 81 % are exactly equal - the sub-block jitter comes from the carved `fine` on every
// corridor column plus `rut`. Every one of those pairs produced a 1x1 top panel, a
// full wall band and crevice AO: 4530 wall quads shorter than 20 cm on ground that is
// flat to within 20 cm. In a near-flat zone the RENDERED lattice is therefore
// coarsened so the greedy merge emits one sheet instead of a field of pitted panels.
// RELAX_FLAT_Q: 3x3 relief that still counts as "near flat".
// A column whose raw top is not a whole block carries a carved `fine`, i.e. it is in
// the corridor: it gets the 25 cm lattice (the bank must keep its sub-block blend onto
// the verge, PLAN §10 criterion 3). Natural ground snaps to the block lattice so
// terrace bands merge instead of each column standing on its own 1x1 panel.
const RELAX_WORN_Q = 16;
const RELAX_NATURAL_Q = 32;
const GRID_WORN = BED_GRID;   // 1/8 m: the graded bed keeps its true steps (see §22)
const GRID_NATURAL = 16;
const RISER_Q = 4;                   // <= 25 cm: a riser, not a wall
const wearOf = (v) => (v > 1 ? 1 : v < 0 ? 0 : v);
// Hard albedo ceiling. The worn-lip chain (mesher `wear` * shader `mix(0.80,1.17,wear)`
// * the worn-bed `sep` boost * the pale GRAVEL tone) clipped gravel panels to a
// near-white albedo, which is what the "floating pale plates" of the reference frame
// were. Every lit channel is capped below the clipping point instead of chasing the
// symptom surface by surface.
const ALBEDO_MAX = 0.70;
// The default rig puts the sun ~16 deg above the horizon: a vertical face takes the key
// light at NdotL ~1.0 while the horizontal ground takes ~0.28, so every wall band
// (shoulder lip, terrace shelf) came out ~3x brighter than the surface it sits on - the
// glowing pale lips of the reference frame. Wall albedo is baked down to compensate and
// the bright end of the sub-band ramp is moved off the lip onto the crevice side.
const WALL_SHADE = 0.66;
const ALBEDO_WALL_MAX = 0.60;

export function meshChunk(world, chunk, lod = 0) {
  const cs = LOD_CELL[lod] || 1;
  const N = CHUNK / cs;
  const x0 = chunk.cx * CHUNK, z0 = chunk.cz * CHUNK;

  // Relaxation is keyed on WORLD coordinates and on the raw column tops only, so a
  // cell gets the same rendered height from either side of a chunk border (no seam)
  // and topOutside() can reproduce its neighbour chunk's value exactly.
  const rawTopQAt = (wx, wz) => { const q = world.columnTopQAt(wx, wz); return q < 0 ? 0 : q; };
  const range3x3 = (wx, wz) => {
    let lo = 1 << 20, hi = -(1 << 20);
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const q = rawTopQAt(wx + dx, wz + dz);
        if (q < lo) lo = q; if (q > hi) hi = q;
      }
    }
    return hi - lo;
  };
  const relaxQ = (q, wx, wz) => {
    if (q <= 0) return 0;
    const worn = q % 16 !== 0;                 // a carved `fine` -> corridor column
    const range = range3x3(wx, wz);
    const g = worn ? (range <= RELAX_WORN_Q ? GRID_WORN : BED_GRID)
      : (range <= RELAX_NATURAL_Q ? GRID_NATURAL : BED_GRID);
    const r = Math.round(q / g) * g;
    return r < 0 ? 0 : r;
  };

  // ---- LOD height/material grid ----
  // Heights are carried in 1/16-block units so a carved road bed merges greedily
  // like a flat one instead of being snapped to whole metres.
  const topQ = new Int16Array(N * N);   // surface height in 1/16-block units
  const bid = new Uint8Array(N * N);
  const wearG = new Uint8Array(N * N);  // corridor wear (render-only, see chunk.js)
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      let sum = 0, cnt = 0, mode = 0, modeCount = 0, peak = 0;
      for (let dz = 0; dz < cs; dz++) {
        for (let dx = 0; dx < cs; dx++) {
          const c = (j * cs + dz) * CHUNK + (i * cs + dx);
          const hc = chunk.wear ? chunk.wear[c] : 0;
          if (hc > wearG[j * N + i]) wearG[j * N + i] = hc;
          const h = chunk.height[c];
          const tq = h < 0 ? 0 : chunk.columnTopQ(c);
          sum += tq; cnt++;
          if (tq > peak) peak = tq;
          const b = h < 0 ? 0 : chunk.blocks[c * WORLD_HEIGHT + h];
          if (b === mode) modeCount++;
          else if (modeCount === 0) { mode = b; modeCount = 1; }
          else modeCount--;
        }
      }
      // Full and simplified LODs keep cliffs honest (max); silhouette averages.
      const rawH = lod >= 2 ? Math.round(sum / Math.max(1, cnt)) : peak;
      const wx = x0 + i * cs + (cs >> 1), wz = z0 + j * cs + (cs >> 1);
      topQ[j * N + i] = lod >= 2 ? snapQ(rawH) : relaxQ(rawH, wx, wz);
      bid[j * N + i] = mode;
    }
  }

  const pos = [], nor = [], col = [], sur = [], idx = [];
  const cCol = [0, 0, 0];
  const cNb = [0, 0, 0];

  const solidAt = (wx, wy, wz) => {
    if (wy < 0 || wy >= WORLD_HEIGHT) return false;
    const t = world.columnTopAt(wx, wz);
    return t >= 0 && wy <= t - 1;
  };
  // AO samples live in the plane offset by the face normal.
  const aoTop = (bx, by, bz, tx, tz) => {
    const y = by + 1;
    const s1 = solidAt(bx + tx, y, bz) ? 1 : 0;
    const s2 = solidAt(bx, y, bz + tz) ? 1 : 0;
    const c = solidAt(bx + tx, y, bz + tz) ? 1 : 0;
    return (s1 && s2) ? 3 : s1 + s2 + c;
  };
  const aoWallX = (bx, by, bz, ty, tz) => {
    const x = bx + 1;
    const s1 = solidAt(x, by + ty, bz) ? 1 : 0;
    const s2 = solidAt(x, by, bz + tz) ? 1 : 0;
    const c = solidAt(x, by + ty, bz + tz) ? 1 : 0;
    return (s1 && s2) ? 3 : s1 + s2 + c;
  };
  const aoWallZ = (bx, by, bz, tx, ty) => {
    const z = bz + 1;
    const s1 = solidAt(bx, by + ty, z) ? 1 : 0;
    const s2 = solidAt(bx, by, z + tx) ? 1 : 0;
    const c = solidAt(bx + tx, by + ty, z) ? 1 : 0;
    return (s1 && s2) ? 3 : s1 + s2 + c;
  };

  const vertex = (x, y, z, nx, ny, nz, r, g, b, ao, surfId, wear) => {
    pos.push(x, y, z);
    nor.push(nx, ny, nz);
    // One face may be darkened by AO, by the wall tone ramp and by the shader's crevice
    // band, but the product of the baked terms is floored: a 1-cell dark square is the
    // pit illusion, and it is the *product* that creates it, not any one term.
    const a = ao < AO_MIN ? AO_MIN : ao;
    col.push(r * a, g * a, b * a);
    // aSurface carries the surface id in its integer part and the edge-weathering
    // factor in its fraction: one attribute instead of two, and streaming.js keeps
    // its single `aSurface` buffer (docs/03 §1).
    sur.push(surfId + wearOf(wear));
  };

  // Neighbour-chunk wear band, for a wall on the last plane of this chunk (a lane that
  // crosses a chunk border must stay suppressed across it).
  const wearOutside = (i, j) => {
    const wx = Math.floor(x0 + i * cs + cs * 0.5), wz = Math.floor(z0 + j * cs + cs * 0.5);
    const c = world.chunkAt(Math.floor(wx / CHUNK), Math.floor(wz / CHUNK));
    if (!c || !c.wear) return 0;
    const lx = ((wx % CHUNK) + CHUNK) % CHUNK, lz = ((wz % CHUNK) + CHUNK) % CHUNK;
    return c.wear[lz * CHUNK + lx];
  };

  const topOutside = (i, j) => {
    const wx = Math.floor(x0 + i * cs + cs * 0.5), wz = Math.floor(z0 + j * cs + cs * 0.5);
    const tq = world.columnTopQAt(wx, wz);
    return tq < 0 ? 0 : (lod >= 2 ? snapQ(tq) : relaxQ(tq, wx, wz));
  };

  let quads = 0;

  // ---------------- TOP FACES ----------------
  const visited = new Uint8Array(N * N);
  const wPanel = new Uint8Array(N * N);
  // Panel merging must not swallow the wear bands: the wheel-line ruts are only
  // readable if the rut strip is its own panel (PLAN §10.2 "continuous ruts along
  // the driving line"). Quantised to 32 levels so noise in the field does not
  // shatter the corridor into per-column panels.
  const wearBkt = new Uint8Array(N * N);
  // Lane suppression: the corridor surface is a continuous ribbon mesh built by
  // src/world/road-ribbon.js (1 m x 0.5 m quad grid), NOT voxel top panels. Left alone,
  // the mesher stepped the carved heightfield in per-column faces *along the lane* - one
  // raised plate per column with a deep seam between them, which is the fault this kills.
  // Marking the cell visited before the merge both skips its top face and stops a merged
  // panel from running into the ribbon.
  const laneCell = new Uint8Array(N * N);
  for (let c = 0; c < N * N; c++) {
    wearBkt[c] = wearG[c] >> 5;
    // The ribbon is only built for rings 0/1 (streaming.js), so the far silhouette LODs
    // keep their voxel top panels - suppressing them there would open a hole in the lane.
    if (wearG[c] >= LANE_WEAR_MIN && lod <= 1) { laneCell[c] = 1; visited[c] = 1; }
  }
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const c0 = j * N + i;
      if (visited[c0]) continue;
      const hq = topQ[c0], b = bid[c0];
      visited[c0] = 1;
      wPanel[c0] = wearG[c0];
      if (hq <= 0 || b === 0) continue;

      const wb0 = wearBkt[c0];
      let w = 1;
      while (i + w < N && !visited[c0 + w] && topQ[c0 + w] === hq && bid[c0 + w] === b
        && wearBkt[c0 + w] === wb0) w++;
      let hh = 1;
      outer: while (j + hh < N) {
        for (let k = 0; k < w; k++) {
          const c = (j + hh) * N + i + k;
          if (visited[c] || topQ[c] !== hq || bid[c] !== b || wearBkt[c] !== wb0) break outer;
        }
        hh++;
      }
      for (let dz = 0; dz < hh; dz++) for (let dx = 0; dx < w; dx++) visited[(j + dz) * N + i + dx] = 1;

      const y = hq / 16, by = Math.floor(y) - 1;
      const ax = x0 + i * cs, az = z0 + j * cs;
      const bx1 = x0 + (i + w) * cs, bz1 = z0 + (j + hh) * cs;
      const surfId = blockSurface(b);
      blockColor(b, cCol);
      const r = cCol[0], g = cCol[1], bb = cCol[2];
      // Panel-level tone, keyed by the panel anchor in WORLD coordinates: the same patch
      // of ground gets the same tone from any chunk or LOD (no seam at a chunk border),
      // and one long merged panel reads as one slab, not a checkerboard.
      // Panel tone keyed on an 8 m lattice in WORLD space: one patch of ground keeps
      // its tone across chunks and LODs, and neighbouring panels of the same surface
      // differ by the coarse field (>= 12 % value spread), not by per-cell noise.
      const pn = hash01(ax >> 3, az >> 3, TONE_SALT);
      const pn2 = hash01(ax >> 1, az >> 1, TONE_SALT ^ 0x2f1b3d77);
      // +/-6 % panel variation: enough that a field of one surface is not a dead slab,
      // small enough that neighbouring 1 m panels never read as a checkerboard.
      const pv = 1 + (pn - 0.5) * 0.06 + (pn2 - 0.5) * 0.02;  // value spread ~ +/-3.5 %
      const pf = hash01(az + 7, ax - 3, TONE_SALT ^ 0x5bd1e995);
      const ph = (pf - 0.5) * 0.12;                           // warm/cool hue drift
      const pw = wPanel[c0] / 255;                            // 0 natural .. 1 worn bed

      // CCW seen from +Y: (ax,az) -> (ax,bz1) -> (bx1,bz1) -> (bx1,az)
      const base = pos.length / 3;
      const corners = [[ax, az], [ax, bz1], [bx1, bz1], [bx1, az]];
      for (const [cx, cz] of corners) {
        const bx = cx === ax ? ax : bx1 - 1;
        const bz = cz === az ? az : bz1 - 1;
        const tx = cx === ax ? -1 : 1;
        const tz = cz === az ? -1 : 1;
        const ao = lod >= 2 ? 1 : AO_LEVELS[aoTop(bx, by, bz, tx, tz)];

        // Local grid cell for this corner + the diagonal neighbour it borders.
        const ci = cx === ax ? i : i + w - 1;
        const cj = cz === az ? j : j + hh - 1;
        const ni = ci + tx, nj = cj + tz;
        const inside = ni >= 0 && ni < N && nj >= 0 && nj < N;
        const nb = inside ? bid[nj * N + ni] : b;
        const nh = inside ? topQ[nj * N + ni] : hq;
        const h1 = hash01(bx, bz, RELIEF_SALT);
        const h2 = hash01(bz, bx, RELIEF_SALT + 3);

        // Edge weathering: a corner that borders a lower panel or a different
        // material is a worn lip (brighter in the shader), an interior corner is
        // not. Crevice darkening is the AO term above.
        const drop = Math.max(0, hq - nh) / 8;
        // pw dominates on the corridor: the carve wear band *is* the tone of the
        // carriageway (rut dark, shoulder pale), the geometry terms only add the
        // worn lip on top of it.
        // On the corridor the carve wear band alone decides the tone; letting the
        // per-corner height drop and the material-change term feed it too made every
        // step and every block boundary its own light/dark cell (the checkerboard).
        const roadCell = pw > 0.45;
        const wear = lod >= 2 ? 0.5 : wearOf(0.10
          + drop * (roadCell ? 0.07 : 0.22)
          + (nb !== b ? (roadCell ? 0.04 : 0.12) : 0)
          + pw * 0.60);

        // Surface-to-surface transition: a road panel sharing a corner with grass
        // pulls 1/3 of the grass colour, so the edge is a gradient, not a step.
        let cr = r, cg = g, cb = bb;
        if (nb !== b && wear > 0.4) {
          blockColor(nb, cNb);
          cr = r * 0.68 + cNb[0] * 0.32;
          cg = g * 0.68 + cNb[1] * 0.32;
          cb = bb * 0.68 + cNb[2] * 0.32;
        }

        // Per-corner grit on top of the panel tone (the same world hashes the relief
        // wobble below uses, so it costs nothing extra). Adjacent panels of ONE surface
        // end up differing in value well past the 12 % of PLAN §10 criterion 2 before
        // the terrain shader adds its own world-space fbm tone on top.
        // Grit stays *under* the panel tone: a per-cell flicker on top of a per-cell
        // tone is exactly the camo the brief wants gone.
        const grit = pv * (1 + (h1 - 0.5) * 0.06);
        // Worked-vs-natural separation: a carved wheel line is scoured to its pale
        // aggregate and pressed dark, the natural verge next to it is pushed greener,
        // so the racing line reads instantly against the grass (PLAN §10 criterion 1).
        const sep = 1 + (pw - 0.5) * 0.10;
        cr = cr * grit * sep * (1 + ph + (h2 - 0.5) * 0.05);
        cg = cg * grit * (1 + (pw - 0.5) * 0.10);
        cb = cb * grit * sep * (1 - ph - (h2 - 0.5) * 0.05);
        if (cr > ALBEDO_MAX) cr = ALBEDO_MAX;
        if (cg > ALBEDO_MAX) cg = ALBEDO_MAX;
        if (cb > ALBEDO_MAX) cb = ALBEDO_MAX;

        // Baked relief: tilt the normal toward the local slope of the height field
        // plus a small hashed wobble. Free at draw time, keyed by world position so
        // it cannot produce a chunk seam (PLAN §10 "zero szwu").
        let tnx = 0, tnz = 0;
        if (lod < 2) {
          const hi = Math.min(N - 1, ci + 1), lo = Math.max(0, ci - 1);
          const hj = Math.min(N - 1, cj + 1), lj = Math.max(0, cj - 1);
          const sX = (topQ[cj * N + hi] - topQ[cj * N + lo]) / (16 * Math.max(1, hi - lo));
          const sZ = (topQ[hj * N + ci] - topQ[lj * N + ci]) / (16 * Math.max(1, hj - lj));
          tnx = -(sX * 0.95 + (h1 - 0.5) * 0.12);
          tnz = -(sZ * 0.95 + (h2 - 0.5) * 0.12);
        }
        const inv = 1 / Math.hypot(tnx, 1, tnz);
        vertex(cx, y, cz, tnx * inv, inv, tnz * inv, cr, cg, cb, ao, surfId, wear);
      }
      idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
      quads++;
    }
  }

  // ---------------- WALL FACES (+x and +z planes) ----------------
  // A wall is the band between this column's surface and the neighbour's, both in
  // 1/16-block units: a sub-block road edge is a 6 cm step, not a 1 m cliff.
  const bandB = new Int8Array(N);
  const bandLo = new Int16Array(N);
  const bandHi = new Int16Array(N);
  const bandNb = new Int8Array(N);
  const seen = new Uint8Array(N);

  for (let axis = 0; axis < 2; axis++) {
    for (let p = 0; p < N; p++) {
      bandB.fill(-1);
      let any = false;
      const lastPlane = (p + 1 >= N);
      for (let q = 0; q < N; q++) {
        let ha, hb, b, nb;
        if (axis === 0) {
          ha = topQ[q * N + p];
          hb = lastPlane ? topOutside(p + 1, q) : topQ[q * N + p + 1];
          b = bid[q * N + p];
          nb = lastPlane ? 0 : bid[q * N + p + 1];
        } else {
          ha = topQ[p * N + q];
          hb = lastPlane ? topOutside(q, p + 1) : topQ[(p + 1) * N + q];
          b = bid[p * N + q];
          nb = lastPlane ? 0 : bid[(p + 1) * N + q];
        }
        if (ha === hb) continue;
        // No riser inside the lane either: a step between two ribbon-covered columns is
        // exactly the "stepped column faces along the lane" the ribbon replaces. The
        // blocky voxel edge survives, because a wall is still drawn wherever only one
        // side of the step is in the band (the outer half metre of the ribbon).
        let la, lb;
        if (axis === 0) { la = laneCell[q * N + p]; lb = lastPlane ? (wearOutside(p + 1, q) >= LANE_WEAR_MIN ? 1 : 0) : laneCell[q * N + p + 1]; }
        else { la = laneCell[p * N + q]; lb = lastPlane ? (wearOutside(q, p + 1) >= LANE_WEAR_MIN ? 1 : 0) : laneCell[(p + 1) * N + q]; }
        if (la && lb) continue;
        // A heightfield step has to be walled whichever way it faces. The old test
        // only emitted the band when the *left/−z* column was higher, so every step
        // that rises towards −x or −z had no wall at all: viewed from the low side at a
        // grazing angle the ray slipped through the missing face and out the other
        // side, which is exactly the pale sky-coloured dashes along the terrace edges
        // of the corridor (diagnosed by sampling those pixels: they equal the sky).
        let bh, bl, bblk, bnb;
        if (ha > hb) { bh = ha; bl = hb; bblk = b; bnb = nb; }
        else { bh = hb; bl = ha; bblk = nb > 0 ? nb : b; bnb = b; }
        if (bblk === 0 || bh <= 0) continue;
        bandB[q] = bblk; bandLo[q] = bl; bandHi[q] = bh; bandNb[q] = bnb; any = true;
      }
      if (!any) continue;
      seen.fill(0);

      for (let q = 0; q < N; q++) {
        if (bandB[q] < 0 || seen[q]) continue;
        const v = bandB[q], lo = bandLo[q], hi = bandHi[q];

        let wq = 1;
        while (q + wq < N && bandB[q + wq] === v && bandLo[q + wq] === lo && bandHi[q + wq] === hi && !seen[q + wq]) wq++;
        for (let a = 0; a < wq; a++) seen[q + a] = 1;

        blockColor(v, cCol);
        const rB = cCol[0], gB = cCol[1], bB = cCol[2];
        const surfId = blockSurface(v);
        const pw = (axis === 0 ? wearG[q * N + p] : wearG[p * N + q]) / 255;
        const yBot = lo / 16, yTop = hi / 16;
        const spanAll = yTop - yBot;
        // A step of <= 25 cm is a *riser*, not a wall: it gets the surface tone at
        // almost full value and no AO. Before this, every 6-25 cm step in the carved
        // bed took WALL_SHADE * AO * the shader crevice band and read as a dark pit.
        const isRiser = (hi - lo) <= RISER_Q;
        // Sub-banding a 1 m riser into three 33 cm bands with independent hashed ramps
        // is literally the "carpet of 1-block shelves" in the reference frame: only a
        // genuinely tall bank face gets a gradient.
        const parts = isRiser ? 1 : (spanAll > 1.6 ? 2 : 1);
        const shade = isRiser ? 0.74 : WALL_SHADE;
        const wmBase = isRiser ? 0.62 : 0.34;     // never the darkest band in the shader
        // The surface below the wall (verge under a road lip, grass under a
        // terrace): its colour bleeds into the base of the band, so a material
        // change reads as a gradient instead of a hard 1-block step (PLAN §10).
        const nbi = bandNb[q];
        let nrr = 0, ngg = 0, nbb = 0, hasNb = false;
        if (nbi > 0 && nbi !== v) { blockColor(nbi, cNb); nrr = cNb[0]; ngg = cNb[1]; nbb = cNb[2]; hasNb = true; }
        const u0 = z0 + q * cs, u1 = z0 + (q + wq) * cs;

        for (let s = 0; s < parts; s++) {
        const yLo = yBot + spanAll * (s / parts);
        const yHi = yBot + spanAll * ((s + 1) / parts);
        const spanY = yHi - yLo;
        const ramp = isRiser ? 1 : 1 + 0.14 * ((s + 0.5) / parts - 0.5)
          + (hash01(q * 4 + s, p + axis * 31, RELIEF_SALT + 17) - 0.5) * 0.05;
        let r = rB * ramp * shade, g = gB * ramp * shade, bb = bB * ramp * shade;
        const cap = isRiser ? ALBEDO_MAX : ALBEDO_WALL_MAX;
        if (r > cap) r = cap;
        if (g > cap) g = cap;
        if (bb > cap) bb = cap;
        const base = pos.length / 3;

        if (axis === 0) {
          const plane = x0 + (p + 1) * cs, inB = x0 + p * cs;
          // CCW seen from +X: (u0,yLo) -> (u0,yHi) -> (u1,yHi) -> (u1,yLo)
          const cs2 = [[u0, yLo], [u0, yHi], [u1, yHi], [u1, yLo]];
          for (const [u, vy] of cs2) {
            const bz = u === u0 ? u0 : u1 - 1;
            const by = vy === yLo ? Math.floor(yLo) : Math.ceil(yHi) - 1;
            const tz = u === u0 ? -1 : 1;
            const ty = vy === yLo ? -1 : 1;
            const ao = lod >= 2 || s > 0 || isRiser ? 1 : AO_LEVELS[aoWallX(inB, by, bz, ty, tz)];
            const f = spanY > 1e-4 ? (vy - yLo) / spanY : 1;      // 0 in the crevice, 1 at the lip
            const wm = wmBase + (1 - wmBase) * f;
            const wear = lod >= 2 ? 0.5 : wm;
            let cr = r * (1 + (pw - 0.5) * 0.22), cg = g, cb = bb * (1 + (pw - 0.5) * 0.22);
            if (hasNb) { const k = 0.4 * (1 - wm); cr = r * (1 - k) + nrr * k; cg = g * (1 - k) + ngg * k; cb = bb * (1 - k) + nbb * k; }
            const jy = lod >= 2 ? 0 : (hash01(bz, by, RELIEF_SALT + 7) - 0.5) * 0.12;
            const jz = lod >= 2 ? 0 : (hash01(by, bz, RELIEF_SALT + 11) - 0.5) * 0.14;
            const inv = 1 / Math.hypot(1, jy, jz);
            vertex(plane, vy, u, inv, jy * inv, jz * inv, cr, cg, cb, ao, surfId, wear);
          }
        } else {
          const plane = z0 + (p + 1) * cs, inB = z0 + p * cs;
          const x0u = x0 + q * cs, x1u = x0 + (q + wq) * cs;
          // CCW seen from +Z: (x0u,yLo) -> (x1u,yLo) -> (x1u,yHi) -> (x0u,yHi)
          const cs2 = [[x0u, yLo], [x1u, yLo], [x1u, yHi], [x0u, yHi]];
          for (const [u, vy] of cs2) {
            const bx = u === x0u ? x0u : x1u - 1;
            const by = vy === yLo ? Math.floor(yLo) : Math.ceil(yHi) - 1;
            const tx = u === x0u ? -1 : 1;
            const ty = vy === yLo ? -1 : 1;
            const ao = lod >= 2 || s > 0 || isRiser ? 1 : AO_LEVELS[aoWallZ(bx, by, inB, tx, ty)];
            const f = spanY > 1e-4 ? (vy - yLo) / spanY : 1;
            const wm = wmBase + (1 - wmBase) * f;
            const wear = lod >= 2 ? 0.5 : wm;
            let cr = r * (1 + (pw - 0.5) * 0.22), cg = g, cb = bb * (1 + (pw - 0.5) * 0.22);
            if (hasNb) { const k = 0.4 * (1 - wm); cr = r * (1 - k) + nrr * k; cg = g * (1 - k) + ngg * k; cb = bb * (1 - k) + nbb * k; }
            const jy = lod >= 2 ? 0 : (hash01(bx, by, RELIEF_SALT + 7) - 0.5) * 0.12;
            const jx = lod >= 2 ? 0 : (hash01(by, bx, RELIEF_SALT + 13) - 0.5) * 0.14;
            const inv = 1 / Math.hypot(1, jy, jx);
            vertex(u, vy, plane, jx * inv, jy * inv, inv, cr, cg, cb, ao, surfId, wear);
          }
        }
        idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
        quads++;
        }
      }
    }
  }

  return {
    lod,
    position: new Float32Array(pos),
    normal: new Float32Array(nor),
    color: new Float32Array(col),
    surface: new Float32Array(sur),
    index: new Uint32Array(idx),
    quads,
    triangles: idx.length / 3,
  };
}
