// Stage decoration (docs/03 §5): trees, spectators, corner posts, checkpoint gates.
// Placement is deterministic per chunk (hashed scatter, no Math.random) and every
// prop is instanced: one geometry + one InstancedMesh per species.
import { hash01 } from './noise.js';
import { CHUNK, chunkKey } from './chunk.js';
import { SURF } from './surfaces.js';
import { SHOULDER } from './road-carve.js';

export const PROP = { OAK: 0, PINE: 1, DEAD: 2, SPECTATOR: 3, POST: 4, GATE: 5, MARSHAL: 6,
  BIRCH: 7, BUSH: 8, FERN: 9 };
export const PROP_NAMES = ['oak', 'pine', 'dead', 'spectator', 'post', 'gate', 'marshal', 'birch', 'bush', 'fern'];

// Vegetation species that are drawn as crossed alpha quads (sprite billboards),
// which is how CMR 2.0 drew its trees (PLAN §10.2: "drzewa to sprite'y, nie
// polygony"). Everything else stays a voxel prop.
// PROP.DEAD is here too: a snag without a sprite variant had no mid/far band at all,
// so the near voxel build was dropped at the hard 90 m prop limit while oaks and pines
// carried on to vegFar (320 m) - bare trees popped out of the skyline ~90 m before the
// leafy ones, most visible in SWAMP/CANYON where snags are half the stand.
export const SPRITE_PROPS = [PROP.OAK, PROP.PINE, PROP.BIRCH, PROP.BUSH, PROP.FERN, PROP.DEAD];
export const SPRITE_SPEC = {
  [PROP.OAK]: { w: 5.6, h: 7.2, planes: 3 },
  [PROP.PINE]: { w: 4.6, h: 9.4, planes: 3 },
  [PROP.BIRCH]: { w: 4.4, h: 7.8, planes: 3 },
  [PROP.BUSH]: { w: 2.3, h: 1.7, planes: 2 },
  [PROP.FERN]: { w: 1.8, h: 1.3, planes: 2 },
  // Same outer envelope as the near LOD snag (NEAR_LOD_SPEC below) so the near -> mid
  // handover does not move the skyline: the voxel build reaches 1.17 m of limbs to one
  // side and 0.97 m to the other, i.e. ~2.1 m across. Three planes, not two: with the
  // bare trunk painted only 6 texels wide, two planes left the snag reading thinner at
  // 30 m than the voxel tree it replaces at 24 m.
  [PROP.DEAD]: { w: 2.10, h: 5.94, planes: 3 },
};
const SPR = { OAK: 0, PINE: 1, BIRCH: 2, BUSH: 3, FERN: 4, DEAD: 5 };
const TEX_PX = 32;                       // 32x32 near/mid cells, nearest neighbour
// Far billboard cells are painted BIGGER (48x48) and DENSER than the near cells: at
// 150..400 m a whole crown is a handful of texels, so the far band needs crown mass, not
// the near cell's branch-by-branch detail (which read as bare brown sticks).
export const FAR_SPRITE_PX = 48;
// One canvas atlas, painted once at boot: every sprite species lives in its own
// 32x32 cell of a single texture, so the whole forest is one texture and one shader
// program (PLAN §10.2 "zero assetów": still fully procedural, still no file).
const ATLAS = { cols: 4, w: Math.max(TEX_PX * 4, FAR_SPRITE_PX * 4), h: TEX_PX * 2 + FAR_SPRITE_PX * 2 };
const FAR_ATLAS = { cols: 4, x0: 0, y0: TEX_PX * 2 };   // lower half of the same canvas
// Atlas cell painted for each sprite species. DERIVED from SPRITE_PROPS, because
// buildSpriteGeometries/atlasRect address the cell by SPRITE_PROPS.indexOf(): a species
// appended to one list and not the other would silently sample another species' foliage.
const SPR_PAINT = { [PROP.OAK]: SPR.OAK, [PROP.PINE]: SPR.PINE, [PROP.BIRCH]: SPR.BIRCH,
  [PROP.BUSH]: SPR.BUSH, [PROP.FERN]: SPR.FERN, [PROP.DEAD]: SPR.DEAD };
const SPR_CELL = SPRITE_PROPS.map((p) => SPR_PAINT[p]);
/** Atlas layout as the renderer sees it, so a test can prove every sprite species owns
 *  a painted cell and that the atlas is not over-full. */
export const SPRITE_ATLAS = { cellPx: TEX_PX, cols: ATLAS.cols, rows: ATLAS.h / TEX_PX,
  species: SPR_CELL.slice() };
/** The far band's cells: same six species, painted separately at FAR_SPRITE_PX. */
export const FAR_SPRITE_CELLS = SPR_CELL.slice();

/** Atlas cell of one sprite species as [u0,v0,u1,v1], inset by half a texel so a
 *  neighbouring cell can never bleed in at the quad edge. */
/** Far-band atlas cell of one species, in the lower half of the shared canvas. */
export function farAtlasRect(sprIdx) {
  const col = sprIdx % FAR_ATLAS.cols, row = Math.floor(sprIdx / FAR_ATLAS.cols);
  const x = FAR_ATLAS.x0 + col * FAR_SPRITE_PX, y = FAR_ATLAS.y0 + row * FAR_SPRITE_PX;
  return [
    (x + 0.5) / ATLAS.w,
    1 - (y + FAR_SPRITE_PX - 0.5) / ATLAS.h,
    (x + FAR_SPRITE_PX - 0.5) / ATLAS.w,
    1 - (y + 0.5) / ATLAS.h,
  ];
}

export function atlasRect(sprIdx) {
  const col = sprIdx % ATLAS.cols, row = Math.floor(sprIdx / ATLAS.cols);
  return [
    (col * TEX_PX + 0.5) / ATLAS.w,
    1 - (row * TEX_PX + TEX_PX - 0.5) / ATLAS.h,
    (col * TEX_PX + TEX_PX - 0.5) / ATLAS.w,
    1 - (row * TEX_PX + 0.5) / ATLAS.h,
  ];
}

const BUSH_SALT = 0x2c9f7a11;
const FERN_SALT = 0x61b34d0f;

const TREE_SALT = 0x7a1c9f23;
const CLUSTER_SALT = 0x5d17ae29;      // grove field: trees come in patches, not a lattice
const CROWD_SALT = 0x3b5e1177;
const POST_SALT = 0x99ab4d01;

// ---- road corridor veto ---------------------------------------------------
// A prop must never stand inside carriageway + shoulder. The old rule trusted
// `road.lateral()` of the ONE nearest spline sample, and on a tight corner that
// sample belongs to the other branch of the road: a column in the middle of the
// start-line carriageway came out with a large lateral offset and was accepted,
// which is the bush that sat in the middle of the track.
// The samples are 1 m apart, so the centreline is walked as a polyline at that
// spacing and the real point-to-segment distance decides.
export const PROP_CORRIDOR_MARGIN = 1.2;     // m of shoulder past carriageway edge
const CORRIDOR_SCAN = 20;                    // +/- samples (m) walked around the nearest one

// ---- planned forest placement (authored maps) -------------------------------------
// The old scatter was an independent 1-in-N coin flip per 1 m column, so trunks landed
// on top of each other (measured 0.15 m minimum trunk-to-trunk over a shipped map) and
// the forest read as one green wall. Trunk-to-trunk minimums, by species crown:
export const TREE_MIN_SPACING = { [PROP.OAK]: 5.0, [PROP.PINE]: 4.0, [PROP.BIRCH]: 4.2,
  [PROP.BUSH]: 1.6, [PROP.FERN]: 1.0, [PROP.DEAD]: 4.6 };
/** Spacing two trunks must clear: the species minimum, or the sum of their crown radii
 *  when a big pair needs more room than the flat per-species number. */
export function treeSpacingFor(pa, sa, pb, sb) {
  return Math.max(TREE_MIN_SPACING[pa], TREE_MIN_SPACING[pb],
    propFootprint(pa, sa) + propFootprint(pb, sb));
}

export const TREE_GRID = 3.3;            // m, jittered-grid cell pitch (blue noise)
export const TREE_JITTER = 1.3;          // m of sub-cell jitter on each axis
export const TREE_CORRIDOR_HARD = 2.6;   // m past carriageway+shoulder: never a trunk
/** A lone verge specimen must stand alone: nothing nearer than this, or the 8 m tree-free
 *  verge turns into a second treeline and the road reads as a green tunnel. */
export const SPEC_ISOLATION = 13.5;
export const TREE_FREE = 8.0;            // m of tree-free verge beside the road
export const TREE_FULL = 20.0;           // normal forest density beyond this
const GROVE_CELL = 26;                   // m, grove / clearing field
const ROUTE_CELL = 110;                  // m of arc, dense-vs-open stretch along the route
const GRID_SALT = 0x2f6b1d07;
const ROUTE_SALT = 0x71c4a9e3;

/** Shortest distance from a world point to the road CENTRELINE polyline. */
function roadAxisDistance(road, x, z) {
  const i = road.nearest(x, z, 1);
  if (i < 0) return Infinity;
  let best = Infinity, bestI = i;
  for (let j = Math.max(0, i - CORRIDOR_SCAN); j <= Math.min(road.n - 1, i + CORRIDOR_SCAN); j++) {
    const ax = road.x[j], az = road.z[j];
    const bx = road.x[j + 1] !== undefined ? road.x[j + 1] : ax;
    const bz = road.z[j + 1] !== undefined ? road.z[j + 1] : az;
    const ex = bx - ax, ez = bz - az;
    const len2 = ex * ex + ez * ez;
    let t = 0;
    if (len2 > 1e-9) t = Math.max(0, Math.min(1, ((x - ax) * ex + (z - az) * ez) / len2));
    const cx = ax + ex * t, cz = az + ez * t;
    const d = Math.hypot(x - cx, z - cz);
    if (d < best) { best = d; bestI = j; }
  }
  road._cAxisI = bestI;
  return best;
}

/** Signed clearance of the corridor at a world point (m past the carriageway edge). */
export function roadCorridorGap(road, x, z) {
  const d = roadAxisDistance(road, x, z);
  return d - road.width[road._cAxisI || 0] / 2;
}

/** True when a prop of this footprint clears carriageway + shoulder + margin. */
export function roadCorridorClear(road, x, z, margin = PROP_CORRIDOR_MARGIN, footprint = 0) {
  return roadCorridorGap(road, x, z) >= margin + footprint;
}

/** Push a point radially out of the corridor; null if it cannot be freed. */
export function resolveOffRoad(road, x, z, need, maxSteps = 40) {
  if (roadCorridorGap(road, x, z) >= need) return { x, z, moved: false };
  for (let k = 0; k < maxSteps; k++) {
    const i = road._cAxisI || road.nearest(x, z, 1);
    let dx = x - road.x[i], dz = z - road.z[i];
    let l = Math.hypot(dx, dz);
    if (l < 0.25) { dx = road.nx[i]; dz = road.nz[i]; l = 1; }   // dead centre: use the normal
    x += (dx / l) * 1.4; z += (dz / l) * 1.4;
    if (roadCorridorGap(road, x, z) >= need) return { x, z, moved: true };
  }
  return null;
}

/** Ground footprint radius of one prop (crown spread, not the trunk). */
export function propFootprint(prop, scale = 1) {
  const sp = SPRITE_SPEC[prop];
  return (sp ? sp.w * 0.27 : 0.35) * scale;
}

/**
 * Deterministic props for one chunk.
 * `stage` = { road, carveIndex, terrain, biome, density }
 */
export function generateChunkProps(cx, cz, stage) {
  const out = [];
  const { road, terrain, density = 1 } = stage;
  const x0 = cx * CHUNK, z0 = cz * CHUNK;
  const seed = stage.seed;
  // Hard per-chunk cap: keeps the prop budget (and therefore the instance budget the
  // streaming layer can actually spend in front of the camera) predictable.
  const TREE_CAP = 44;                   // verge-sprite guard below
  const out2 = [];
  const accepted = [];

  // ---- trees / bushes: PLANNED jittered-grid scatter, not dense random ----
  // One candidate per TREE_GRID world cell, jittered inside its own cell (blue noise by
  // construction: two trunks can never share a cell), then rejected when another already
  // accepted trunk sits inside TREE_MIN_SPACING for either species. A candidate is a pure
  // function of its world cell and every chunk recomputes the 2-cell ring around itself in
  // the same (gz, gx) order, so a pair straddling a chunk border is rejected in both
  // chunks and the spacing holds across the whole map, not just inside one chunk.
  // Ring has to cover the largest rejection radius (SPEC_ISOLATION), not just the crown
  // spacing, or a specimen and its neighbour straddling two chunks disagree about which
  // one of them is too close and the cluster survives on the verge.
  const ring = Math.ceil((SPEC_ISOLATION + 4) / TREE_GRID);
  const gFrom = Math.floor((x0 - ring * TREE_GRID) / TREE_GRID);
  const gTo = Math.floor((x0 + CHUNK + ring * TREE_GRID) / TREE_GRID);
  const bFrom = Math.floor((z0 - ring * TREE_GRID) / TREE_GRID);
  const bTo = Math.floor((z0 + CHUNK + ring * TREE_GRID) / TREE_GRID);
  for (let gz = bFrom; gz <= bTo; gz++) {
    for (let gx = gFrom; gx <= gTo; gx++) {
      const c = treeCandidate(gx, gz, x0, z0, stage);
      if (!c) continue;
      let clear = true;
      // A verge specimen is judged against EVERY other trunk, not just crown spacing:
      // inside the 8 m verge band a tree is only allowed as an isolated singleton.
      const specimen = c.specimen || 0;
      for (const q of accepted) {
        const need = (specimen || q.specimen)
          ? Math.max(SPEC_ISOLATION, treeSpacingFor(c.prop, c.scale, q.prop, q.scale))
          : treeSpacingFor(c.prop, c.scale, q.prop, q.scale);
        if (Math.hypot(c.x - q.x, c.z - q.z) < need) { clear = false; break; }
      }
      if (!clear) continue;
      accepted.push(c);
      if (c.inChunk) out2.push(c);
    }
  }
  // Density varies along the route (ROUTE_CELL hash) and inside each grove, so a stage
  // alternates dense woodland with open stands and bare clearings instead of one even wall.
  out.push(...out2);

  // ---- spectators: groups beside the road ----
  const samples = stage.carveIndex.get(chunkKey(cx, cz)) || null;
  if (samples) {
    for (let k = 0; k < samples.length; k++) {
      const i = samples[k];
      if (i % 37 !== 0) continue;
      const r = hash01(i, 1, CROWD_SALT ^ seed);
      if (r > 0.35) continue;
      const side = hash01(i, 2, CROWD_SALT ^ seed) < 0.5 ? 1 : -1;
      const count = 3 + Math.floor(hash01(i, 3, CROWD_SALT ^ seed) * 7);
      const off = road.width[i] / 2 + SHOULDER + 4 + hash01(i, 4, CROWD_SALT ^ seed) * 8;
      for (let c = 0; c < count; c++) {
        const along = (c % 3) * 1.1 - 1.1;
        const lateral = off + Math.floor(c / 3) * 1.2 + hash01(i * 8 + c, 5, CROWD_SALT ^ seed) * 0.8;
        const px = road.x[i] + road.nx[i] * lateral * side + road.tx[i] * along;
        const pz = road.z[i] + road.nz[i] * lateral * side + road.tz[i] * along;
        if (Math.floor(px / CHUNK) !== cx || Math.floor(pz / CHUNK) !== cz) continue;
        out.push({
          prop: PROP.SPECTATOR, x: px, y: terrain.heightAt(px, pz), z: pz,
          yaw: Math.atan2(-road.nz[i] * side, -road.tx[i]) , scale: 0.92 + hash01(i * 8 + c, 6, CROWD_SALT ^ seed) * 0.2,
          variant: Math.floor(hash01(i * 8 + c, 7, CROWD_SALT ^ seed) * 4),
        });
      }
    }
    // ---- corner posts on the outside of sharp corners, every 8 m ----
    for (let k = 0; k < samples.length; k++) {
      const i = samples[k];
      if (Math.abs(road.kappa[i]) < 0.035) continue;
      if (i % 8 !== 0) continue;
      const side = Math.sign(road.kappa[i]);           // outside of the corner
      const off = road.width[i] / 2 + SHOULDER + 0.6;
      const px = road.x[i] + road.nx[i] * off * -side;
      const pz = road.z[i] + road.nz[i] * off * -side;
      if (Math.floor(px / CHUNK) !== cx || Math.floor(pz / CHUNK) !== cz) continue;
      const postY = stage.world ? stage.world.columnTopAt(Math.floor(px), Math.floor(pz)) : -1;
      out.push({ prop: PROP.POST, x: px, y: postY >= 0 ? postY : terrain.heightAt(px, pz), z: pz, yaw: 0, scale: 1, variant: 0 });
    }
  }

  // ---- road-edge sprites: bracken and bushes right at the verge ----
  // PLAN §10.2: the verge must be busy so the road edge reads. These never enter
  // the corridor: they start past carriageway + shoulder + 1.2 m and props carry
  // no collision at all, so physics is untouched.
  if (samples) {
    for (let k = 0; k < samples.length; k++) {
      const i = samples[k];
      if (out.length >= TREE_CAP + 40) break;
      const hsh = hash01(i, 9, BUSH_SALT ^ seed);
      // Verge vegetation was a thin, even sprinkle; denser so the corridor edge reads
      // as a hedge line rather than a mown lawn with a few ornaments on it.
      if (hsh > 0.74) continue;
      const side = hash01(i, 10, BUSH_SALT ^ seed) < 0.5 ? 1 : -1;
      const along = hash01(i, 11, BUSH_SALT ^ seed) * 2.2 - 1.1;
      const off = road.width[i] / 2 + SHOULDER + 1.2 + hash01(i, 12, BUSH_SALT ^ seed) * 3.4;
      let px = road.x[i] + road.nx[i] * off * side + road.tx[i] * along;
      let pz = road.z[i] + road.nz[i] * off * side + road.tz[i] * along;
      const kind = hash01(i, 13, FERN_SALT ^ seed) < 0.55 ? PROP.FERN : PROP.BUSH;
      // A few deliberately tall tufts (bracken over the verge) instead of one height.
      // Three tuft heights, not two: bracken over the verge, a middling bush and a low
      // clump, so the verge line has a broken silhouette instead of one hedge height.
      const tierHash = hash01(i, 21, BUSH_SALT ^ (seed + 3));
      const tall = tierHash > 0.78 ? 0.60 : tierHash > 0.52 ? 0.24 : 0;
      const bScale = 0.78 + hash01(i, 15, BUSH_SALT ^ (seed + 11)) * 0.55 + tall;
      // Same veto as the trees: the sample normal is exact on a straight but folds on a
      // hairpin, and these are the props that ended up on the carriageway at the start.
      const bfit = resolveOffRoad(road, px, pz, propFootprint(kind, bScale) + PROP_CORRIDOR_MARGIN);
      if (!bfit) continue;
      px = bfit.x; pz = bfit.z;
      if (Math.floor(px / CHUNK) !== cx || Math.floor(pz / CHUNK) !== cz) continue;
      const gy = stage.world ? stage.world.columnTopAt(Math.floor(px), Math.floor(pz)) : -1;
      out.push({
        prop: kind, x: px, y: gy >= 0 ? gy : terrain.heightAt(px, pz), z: pz,
        yaw: hash01(i, 14, BUSH_SALT ^ (seed + 5)) * Math.PI,
        scale: bScale,
        variant: Math.floor(hash01(i, 16, BUSH_SALT ^ (seed + 17)) * 3),
      });
    }
  }

  return out;
}

/**
 * One jittered-grid tree candidate, or null. Rejects: the road corridor (hard band, then
 * the 8 m tree-free verge except for the odd lone specimen), the clearing / grove field,
 * the route-density field, the reach limit, paved ground and steep slopes. Pure function
 * of (gx, gz, stage), which is what makes the cross-chunk spacing filter sound.
 */
function treeCandidate(gx, gz, x0, z0, stage) {
  const { road, terrain } = stage;
  const seed = stage.seed >>> 0;
  const jx = (hash01(gx, gz, GRID_SALT ^ seed) - 0.5) * (TREE_JITTER * 2);
  const jz = (hash01(gx, gz, GRID_SALT ^ (seed + 23)) - 0.5) * (TREE_JITTER * 2);
  let wx = gx * TREE_GRID + TREE_GRID * 0.5 + jx;
  let wz = gz * TREE_GRID + TREE_GRID * 0.5 + jz;
  let i = road.nearest(wx, wz);
  if (i < 0) return null;
  const edge = road.width[i] / 2 + SHOULDER;
  let toEdge = Math.abs((wx - road.x[i]) * road.nx[i] + (wz - road.z[i]) * road.nz[i]) - edge;
  if (toEdge < TREE_CORRIDOR_HARD) return null;
  const grove = hash01(Math.floor(wx / GROVE_CELL), Math.floor(wz / GROVE_CELL), CLUSTER_SALT ^ seed);
  const route = hash01(Math.floor(road.s[i] / ROUTE_CELL), 7, ROUTE_SALT ^ seed);
  const h = hash01(gx, gz, GRID_SALT ^ (seed + 61));
  // a clearing: the grove drops out entirely on the open stretches
  if (grove < 0.10 + 0.10 * (1 - route)) return null;
  const species = pickSpecies(grove * 0.6 + h * 0.4, stage.biome);
  const scale = (species === PROP.PINE ? 0.72 : 0.60)
    + hash01(gx, gz, GRID_SALT ^ (seed + 7)) * (species === PROP.DEAD ? 1.00 : 1.08);
  const reach = 60 + 58 * grove * grove;
  let odds;
  if (toEdge < TREE_FREE) {
    // the odd lone specimen standing on the verge: a separate hash, so the specimen
    // lottery does not cancel the acceptance odds below
    if (hash01(gx, gz, GRID_SALT ^ (seed + 101)) < 0.88) return null;
    odds = 0.34;
  }
  else if (toEdge <= TREE_FULL) {
    odds = ((toEdge - TREE_FREE) / (TREE_FULL - TREE_FREE)) * (0.85 + 0.40 * route);
  } else if (toEdge <= reach) {
    const open = 1 - (toEdge - TREE_FULL) / (reach - TREE_FULL);
    odds = (0.55 + 0.45 * route) * (0.42 + 0.58 * open) * (0.58 + 0.50 * grove);
  } else odds = 0;
  if (h > odds) return null;
  // Corridor veto: pushed out past carriageway + shoulder + margin, never dropped, then
  // re-checked against the hard band after the push.
  const fit = resolveOffRoad(road, wx, wz, propFootprint(species, scale) + PROP_CORRIDOR_MARGIN);
  if (!fit) return null;
  wx = fit.x; wz = fit.z;
  i = road.nearest(wx, wz);
  toEdge = Math.abs((wx - road.x[i]) * road.nx[i] + (wz - road.z[i]) * road.nz[i])
    - (road.width[i] / 2 + SHOULDER);
  if (toEdge < TREE_CORRIDOR_HARD) return null;
  const pcx = Math.floor(wx), pcz = Math.floor(wz);
  const surf = worldSurface(stage, pcx, pcz);
  if (surf === SURF.ASPHALT || surf === SURF.ICE) return null;
  if (terrain.slopeAt(wx, wz) > 0.75) return null;
  const carved = stage.world ? stage.world.columnTopAt(pcx, pcz) : -1;
  const y = carved >= 0 ? carved : terrain.heightAt(wx, wz);
  return {
    prop: species, x: wx, y, z: wz,
    yaw: hash01(gx, gz, GRID_SALT ^ (seed + 13)) * Math.PI * 2, scale,
    variant: Math.floor(hash01(gx, gz, GRID_SALT ^ (seed + 29)) * 3),
    specimen: toEdge < TREE_FREE ? 1 : 0,
    inChunk: pcx >= x0 && pcx < x0 + CHUNK && pcz >= z0 && pcz < z0 + CHUNK,
  };
}

/**
 * Procedural foliage textures, painted once at boot into small canvases and read
 * with NearestFilter (PLAN §10.2 "tekstura 16x16 lub 32x32 generowana proceduralnie
 * w kodzie (zero assetów)"). No file, no fetch, no per-frame work: the six cells are
 * painted into one shared canvas, so every instance of every species samples it.
 */
export function buildFoliageTextures(THREE) {
  if (typeof document === 'undefined') return null;      // headless: no canvas
  const cv = document.createElement('canvas');
  cv.width = ATLAS.w; cv.height = ATLAS.h;
  cv.style.imageRendering = 'pixelated';
  const ctx = cv.getContext('2d');
  const tmp = document.createElement('canvas');
  tmp.width = TEX_PX; tmp.height = TEX_PX;
  const tctx = tmp.getContext('2d');
  for (let i = 0; i < SPR_CELL.length; i++) {
    const img = tctx.createImageData(TEX_PX, TEX_PX);
    paintFoliage(SPR_CELL[i], img.data);
    tctx.putImageData(img, 0, 0);
    const col = i % ATLAS.cols, row = Math.floor(i / ATLAS.cols);
    ctx.drawImage(tmp, col * TEX_PX, row * TEX_PX);
  }
  // far band: canopy mass at FAR_SPRITE_PX in the lower half of the same canvas
  tmp.width = FAR_SPRITE_PX; tmp.height = FAR_SPRITE_PX;
  for (let i = 0; i < FAR_SPRITE_CELLS.length; i++) {
    const img = tctx.createImageData(FAR_SPRITE_PX, FAR_SPRITE_PX);
    paintFarCanopy(FAR_SPRITE_CELLS[i], img.data, FAR_SPRITE_PX);
    tctx.putImageData(img, 0, 0);
    const col = i % FAR_ATLAS.cols, row = Math.floor(i / FAR_ATLAS.cols);
    ctx.drawImage(tmp, FAR_ATLAS.x0 + col * FAR_SPRITE_PX, FAR_ATLAS.y0 + row * FAR_SPRITE_PX);
  }
  const tex = new THREE.CanvasTexture(cv);
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

/* deterministic tiny hash so the painted foliage is stable between runs */
function ph(x, y, s) {
  let h = (x * 374761393 + y * 668265263 + s * 2246822519) | 0;
  h = (h ^ (h >> 13)) * 1274126177 | 0;
  h = (h ^ (h >> 16)) >>> 0;
  return h / 4294967296;
}

function px(data, x, y, r, g, b, a) {
  const n = Math.round(Math.sqrt(data.length / 4));
  if (x < 0 || y < 0 || x >= n || y >= n) return;
  const k = (y * n + x) * 4;
  data[k] = r; data[k + 1] = g; data[k + 2] = b; data[k + 3] = a;
}

/* Four-tone foliage palette per sprite species: shadow / mid / sunlit / warm rim.
   Baked straight into the atlas cell, so a crossed quad carries its own light. All
   four are darker and more saturated than the old single mint base (the old pine
   base [44, 78, 48] came out at ~[46, 82, 50], i.e. a pale card in the sun): a real
   conifer crown runs from near-black needles in the underside to a warm tip. */
const SPR_TONES = {
  [SPR.PINE]: { shadow: [12, 26, 17], mid: [22, 46, 25], sun: [40, 72, 32], rim: [78, 96, 38], bark: [52, 36, 22] },
  [SPR.OAK]: { shadow: [20, 36, 15], mid: [36, 60, 21], sun: [62, 90, 28], rim: [112, 118, 42], bark: [72, 48, 28] },
  [SPR.BIRCH]: { shadow: [30, 46, 20], mid: [54, 80, 30], sun: [84, 110, 40], rim: [136, 138, 52], bark: [176, 168, 148] },
  [SPR.BUSH]: { shadow: [16, 30, 13], mid: [28, 50, 19], sun: [48, 74, 26], rim: [92, 100, 36], bark: [52, 40, 24] },
  [SPR.FERN]: { shadow: [14, 26, 12], mid: [24, 42, 16], sun: [44, 66, 22], rim: [84, 92, 30], bark: [44, 36, 22] },
};

function paintFoliage(kind, data) {
  data.fill(0);
  const T = SPR_TONES[kind] || SPR_TONES[SPR.OAK];
  // Clustered blob field: three octaves (4x4, 2x2 and 1x1 texels). Per-texel salt is
  // what made the crown read as static; bunches read as needle bunches / leaf clumps.
  const blob = (x, y, s) => 0.55 * ph(x >> 2, y >> 2, s) + 0.28 * ph(x >> 1, y >> 1, s + 3)
    + 0.17 * ph(x, y, s + 5);
  // One shaded texel: the vertical gradient (g = 1 at the top of the sprite, 0.48 at
  // the base) picks the tone, the blob field breaks the tone into bunches, the warm
  // rim only catches the top shell. Interior texels are always opaque - a see-through
  // crown was half of the "flat card" read.
  const leaf = (x, y, s) => {
    const v = blob(x, y, s);
    const g = 1 - 0.52 * (y / (TEX_PX - 1));
    const c = (g < 0.50 || v < 0.22) ? T.shadow : (v > 0.62 && g > 0.60) ? T.sun
      : (v > 0.40 && g > 0.74) ? T.sun : T.mid;
    const tip = y <= 5 && ph(x, y, s + 23) > 0.66;
    const cc = tip ? T.rim : c;
    const t = 0.62 + 0.38 * g + (ph(x, y - 1, s + 11) > 0.80 ? 0.07 : 0);
    px(data, x, y, Math.min(255, cc[0] * t + (tip ? 8 : 0)), Math.min(255, cc[1] * t), Math.min(255, cc[2] * t * 0.96), 255);
  };
  // Silhouette fill: interior texels are solid, only the outer 1-2 texels ragged.
  const fill = (x, y, s, edge) => { if (!edge || ph(x, y, s + 31) > 0.40) leaf(x, y, s); };
  const wood = (x, y, c, s) => {
    if (ph(x, y >> 2, s) < 0.06) return;                    // bark split
    const t = 0.62 + 0.42 * ph(x, y >> 2, s + 7);
    px(data, x, y, c[0] * t, c[1] * t * 0.97, c[2] * t * 0.92, 255);
  };
  // A branch that starts INSIDE the crown mass and runs out to just past the silhouette
  // edge: without it the canopy floats, and the sprite reads as a green lozenge.
  const branch = (x0, y0, dx, dy, len, c, s) => {
    for (let i = 0; i < len; i++) {
      wood(x0 + dx * i, y0 - Math.round(dy * i), c, s);
      if (i > 1) wood(x0 + dx * i, y0 - Math.round(dy * i) + 1, T.shadow, s + 3);
    }
  };

  if (kind === SPR.PINE || kind === SPR.BIRCH) {
    const spruce = kind === SPR.PINE;
    for (let y = 0; y < TEX_PX; y++) {
      const u = y / (TEX_PX - 1);                   // 0 top .. 1 bottom
      if (spruce) {
        // conical stack with jagged tiers, filled solid inside each tier
        const half = 1.5 + 12.5 * Math.pow(u, 1.35);
        const tier = 1 + (y % 4 === 0 ? 1 : 0);
        const jag = ph(y * 3, y, 31) > 0.72 ? tier : 0;
        const h = Math.floor(half) + jag;
        for (let x = 16 - h; x <= 16 + h; x++) fill(x, y, 5, Math.abs(x - 16) >= h - 1);
        if (u > 0.36) {                             // needle sprays on the lower tiers
          const d = y % 8 < 4 ? 1 : -1;
          wood(16 + d * Math.round(h * 0.55), y, T.bark, 43);
          wood(16 + d * Math.round(h * 0.55) + d, y, T.shadow, 47);
        }
        if (u > 0.60) for (let dx = -1; dx <= 1; dx++) wood(16 + dx, y, T.bark, 23);
      } else {
        // birch: rounded crown, pale banded trunk, two visible limbs
        const dy = u - 0.55;
        const h = Math.floor(12 * Math.sqrt(Math.max(0, 1 - dy * dy * 3.4)));
        for (let x = 16 - h; x <= 16 + h; x++) fill(x, y, 9, Math.abs(x - 16) >= h - 1);
        if (u > 0.58) {
          for (let dx = -2; dx <= 2; dx++) wood(16 + dx, y, T.bark, 29);
          if (y % 5 === 2) for (let x = 14; x <= 18; x++) if (ph(x, y, 41) > 0.45) px(data, x, y, 74, 66, 54, 255);
        }
      }
    }
    if (spruce) branch(16, 22, -1, 0.4, 7, T.bark, 61);
    else { branch(16, 18, -1, 0.5, 8, T.bark, 63); branch(16, 20, 1, 0.4, 7, T.bark, 67); }
    return;
  }

  if (kind === SPR.OAK) {
    // rounded mass: three overlapping lobes, filled solid so no light gets through
    const lobes = [[16, 12, 11], [10, 16, 8], [22, 17, 8]];
    for (const [cx0, cy0, r] of lobes) {
      for (let y = cy0 - r; y <= cy0 + r; y++) {
        const dy = (y - cy0) / r;
        const h = Math.round(r * Math.sqrt(Math.max(0, 1 - dy * dy)));
        for (let x = cx0 - h; x <= cx0 + h; x++) fill(x, y, 11, Math.abs(x - cx0) >= h - 1);
      }
    }
    branch(16, 22, -1, 0.55, 8, [96, 66, 40], 19);
    branch(16, 24, 1, 0.5, 7, [96, 66, 40], 27);
    for (let y = 21; y < TEX_PX; y++) {
      const hw = y > 26 ? 3 : 2;
      for (let dx = -hw; dx <= hw; dx++) wood(16 + dx, y, dx < -1 ? [72, 48, 28] : [96, 66, 40], 19);
    }
    return;
  }

  if (kind === SPR.BUSH) {
    for (let y = 12; y < TEX_PX; y++) {
      const dy = (y - 25) / 13;
      const h = Math.round(14 * Math.sqrt(Math.max(0, 1 - dy * dy * 1.9)));
      for (let x = 16 - h; x <= 16 + h; x++) fill(x, y, 15, Math.abs(x - 16) >= h - 1);
    }
    branch(16, 27, -1, 0.6, 5, [52, 40, 24], 21);
    for (let y = 26; y < TEX_PX; y++) for (let dx = -1; dx <= 1; dx++) wood(16 + dx, y, [70, 56, 36], 21);
    return;
  }

  if (kind === SPR.DEAD) return paintSnag(data);

  // FERN / BRACKEN: fronds radiating from the base, drawn as stepped 2-texel strokes so
  // a fern patch has mass instead of a hairline.
  for (let f = 0; f < 7; f++) {
    const lean = (f - 3) * 2.6;
    const len = 12 + Math.floor(ph(f, 1, 33) * 8);
    const s = 71 + f;
    for (let i = 0; i < len; i++) {
      const x = Math.round(16 + lean * (i / len));
      const y = TEX_PX - 2 - i;
      leaf(x, y, s);
      if (i > 2) { leaf(x - 1, y - 1, s); leaf(x + 1, y - 1, s); }
    }
  }
}

// A bare snag: no leaf mass, so the whole silhouette comes from the trunk and the
// broken limbs (palette and trunk widths are the near voxel snag's, so the sprite and
// the near build read as the same tree). Unchanged from the last pass.
/** Paint one atlas cell headless (Uint8ClampedArray), at the near or the far size. */
export function paintFoliageCell(kind, px = TEX_PX) {
  const d = new Uint8ClampedArray(px * px * 4);
  if (px > TEX_PX) paintFarCanopy(kind, d, px); else paintFoliage(kind, d);
  return d;
}

/** How a painted cell splits: opaque coverage of the cell, how much of that mass is
 *  canopy (upper part of the cell) and how much is bark in the lower third. A far cell
 *  that is mostly trunk is the bug this measures. */
export function foliageCellStats(d, n) {
  const barkRow = Math.floor(n * 0.62);
  let opaque = 0, canopy = 0, bark = 0;
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const k = (y * n + x) * 4;
    if (d[k + 3] <= 127) continue;
    opaque++;
    if (y < barkRow) canopy++;
    else if (d[k + 1] < d[k]) bark++;              // g < r: brown bark, not leaf
  }
  const t = Math.max(1, opaque);
  return { coverage: opaque / (n * n), canopyShare: canopy / t, barkShare: bark / t };
}

/** Far billboard cell: a dense clustered crown in the species tones, the trunk only in
 *  the lower third, and a dithered base so the quad does not end in a hard cut-out edge.
 *  The silhouette is filled - no daylight inside the crown, because at 150..400 m a
 *  see-through crown reads as a stick. */
function paintFarCanopy(kind, data, N) {
  data.fill(0);
  const T = SPR_TONES[kind] || SPR_TONES[SPR.OAK];
  const mid = N * 0.5;
  const blob = (x, y, s) => 0.62 * ph(x >> 1, y >> 1, s) + 0.38 * ph(x, y, s + 3);
  const leaf = (x, y, s) => {
    const v = blob(x, y, s);
    const g = 1 - 0.50 * (y / (N - 1));
    const c = (g < 0.50 || v < 0.20) ? T.shadow : (v > 0.58 && g > 0.58) ? T.sun
      : (v > 0.38 && g > 0.72) ? T.sun : T.mid;
    const tip = y <= N * 0.16 && ph(x, y, s + 23) > 0.60;
    const cc = tip ? T.rim : c;
    const t = 0.60 + 0.40 * g;
    px(data, x, y, Math.min(255, cc[0] * t + (tip ? 8 : 0)), Math.min(255, cc[1] * t),
      Math.min(255, cc[2] * t * 0.96), 255);
  };
  const wood = (x, y, c, s) => {
    if (ph(x, y >> 2, s) < 0.06) return;
    const t = 0.60 + 0.44 * ph(x, y >> 2, s + 7);
    px(data, x, y, c[0] * t, c[1] * t * 0.97, c[2] * t * 0.92, 255);
  };
  const conifer = kind === SPR.PINE;
  const snag = kind === SPR.DEAD;
  const crownTop = Math.round(N * 0.04);
  const crownBot = Math.round(N * (conifer ? 0.72 : 0.66));
  const wide = snag ? 0.22 : conifer ? 0.30 : 0.34;
  // 1) the envelope, filled solid: conifer cone, broadleaf lobed ellipse
  for (let y = crownTop; y <= crownBot; y++) {
    const u = (y - crownTop) / Math.max(1, crownBot - crownTop);
    let half;
    if (conifer || snag) half = wide * N * Math.pow(u, snag ? 0.9 : 1.25) + N * 0.03;
    else half = wide * N * Math.sqrt(Math.max(0, 1 - Math.pow((u - 0.40) / 0.64, 2)));
    const h = Math.round(half);
    for (let x = Math.round(mid - h); x <= Math.round(mid + h); x++) leaf(x, y, 5);
  }
  // 2) cluster lumps over the outline: a crown is a crowd of bunches, and the lumps
  //    bulge past the envelope so the silhouette is ragged rather than a curve
  const lumps = snag ? 7 : 15;
  for (let k = 0; k < lumps; k++) {
    const u = 0.10 + ph(k, 5, 73) * 0.86;
    const env = (conifer || snag)
      ? wide * N * Math.pow(u, snag ? 0.9 : 1.25) + N * 0.03
      : wide * N * Math.sqrt(Math.max(0, 1 - Math.pow((u - 0.40) / 0.64, 2)));
    const side = ph(k, 9, 79) < 0.5 ? -1 : 1;
    const cx1 = mid + side * env * (0.45 + ph(k, 11, 83) * 0.62);
    const cy1 = crownTop + u * (crownBot - crownTop);
    const r = N * (0.07 + ph(k, 13, 89) * (snag ? 0.05 : 0.09));
    for (let y = Math.round(cy1 - r); y <= Math.round(cy1 + r); y++) {
      const dy = (y - cy1) / Math.max(1, r);
      const h = Math.round(r * Math.sqrt(Math.max(0, 1 - dy * dy)));
      for (let x = Math.round(cx1 - h); x <= Math.round(cx1 + h); x++) {
        if (snag && ph(x, y, k + 91) < 0.45) continue;      // snags stay open-worked
        leaf(x, y, k);
      }
    }
  }
  // 3) trunk: lower third only, plus a base flare. The trunk never runs up the cell.
  const trunkTop = Math.round(N * 0.66);
  const tw = Math.max(1, Math.round(N * (snag ? 0.055 : 0.042)));
  for (let y = snag ? Math.round(N * 0.18) : trunkTop; y < N; y++) {
    const flare = y > N - 5 ? 1 : 0;
    for (let dx = -(tw + flare); dx <= tw + flare; dx++) wood(Math.round(mid + dx), y, T.bark, 23);
  }
  if (snag) for (let k = 0; k < 5; k++) {                          // snag limbs
    const y0 = Math.round(N * (0.20 + ph(k, 17, 97) * 0.5));
    const sd = k % 2 ? 1 : -1;
    for (let i = 1; i <= Math.round(N * 0.16); i++) wood(Math.round(mid + sd * i), y0 - i, T.bark, 29);
  }
  // 4) soft base: the last rows dither out, so the quad meets the ground as grass and
  //    not as a cut-out card.
  for (let y = N - 4; y < N; y++) {
    const keep = 1.0 - (y - (N - 4)) * 0.26;
    for (let x = 0; x < N; x++) {
      if (ph(x, y, 111) > keep) { const k4 = (y * N + x) * 4; data[k4 + 3] = 0; }
    }
  }
  if (kind === SPR.FERN || kind === SPR.BUSH) {                   // low clumps, no trunk
    for (let y = Math.round(N * 0.62); y < N - 3; y++) {
      const h = Math.round(N * 0.30 * Math.sqrt(Math.max(0, 1 - Math.pow((y - N * 0.9) / (N * 0.34), 2))));
      for (let x = Math.round(mid - h); x <= Math.round(mid + h); x++) leaf(x, y, 7);
    }
  }
}

function paintSnag(data) {
  const pale = [106, 88, 67], mid = [91, 76, 57], dark = [76, 63, 46];
  const wood = (x, y, c, s) => {
    // Bark tone plus a vertical banding noise: flat wood at 300 m is a pale stick.
    const t = 0.68 + 0.5 * ph(x, y >> 2, s + 5);
    px(data, x, y, c[0] * t, c[1] * t * 0.97, c[2] * t * 0.92, 255);
  };
  // Trunk: tapers from 3 texels half-width (0.4 m, the real snag diameter) at the
  // ground to 2 texels under the snapped crown. Never thinner than 2: one texel is
  // 6 cm, which is sub-pixel past 150 m and the far band turns into a sparkle.
  for (let y = 5; y < TEX_PX; y++) {
    const u = (y - 5) / (TEX_PX - 6);
    const half = Math.max(2, Math.round(1.6 + 1.6 * u));
    const lean = Math.round(1.4 * u * (ph(y, 3, 11) > 0.5 ? 1 : -1));
    for (let dx = -half; dx <= half; dx++) wood(16 + lean + dx, y, dx < 0 ? pale : mid, 17);
    if (y % 6 === 3) for (let dx = -half; dx <= half; dx++) px(data, 16 + lean + dx, y, dark[0], dark[1], dark[2], 255);
  }
  // Limbs start INSIDE the trunk (a limb starting at the trunk face is a floating
  // stick at distance) and step up, or droop for the lowest one.
  const limb = (y0, dir, len, up) => {
    for (let s = 0; s < len; s++) {
      const y = up ? y0 - Math.floor(s / 2) : y0 + Math.floor(s / 3);
      wood(16 + dir * s, y, mid, 23);
      if (s > 1) wood(16 + dir * s, y + 1, dark, 29);      // shaded underside
    }
  };
  limb(13, -1, 11, true);
  limb(18, 1, 12, true);
  limb(24, -1, 9, false);
  // Nubs and the snapped top: the ragged edge is what stops the far band reading as a
  // row of toothpicks.
  for (const [x, y] of [[5, 9], [27, 12], [7, 20], [26, 19], [16, 4], [18, 3]]) wood(x, y, pale, 37);
}

/** Per-instance tone jitter for vegetation (a few percent of hue and lightness) so a
 *  stand of one sprite species is not a copy of one tree. Deterministic from position,
 *  allocation-free, multiplied into the instance colour in streaming.js. */
export function vegToneJitter(x, z, salt = 0, out = null) {
  const ix = Math.round(x * 3), iz = Math.round(z * 3);
  const a = hash01(ix, iz, 7717 ^ salt), b = hash01(ix, iz, 9257 ^ salt);
  const lift = 0.94 + 0.12 * a;                       // lightness +/-6%
  const warm = 0.96 + 0.08 * b;                       // hue: warm <-> cool +/-4%
  const o = out || [0, 0, 0];
  o[0] = lift * warm; o[1] = lift; o[2] = lift * (2 - warm);
  return o;
}

/**
 * Crossed-plane sprite geometry (NOT camera facing: fixed intersecting planes, so a
 * stand of trees does not swim when the camera swings, and the silhouette changes
 * as you drive past - exactly the CMR 2.0 look). Built once per species.
 */
// ---- near level of detail for vegetation (perf) --------------------------------
// The baked props.glb trees are 444-528 triangles each (37-44 voxel blocks: see
// assets/models/props.manifest.json) and the near band puts ~470 of them on screen:
// 230 k of the ~309 k triangles a MED frame drew. NEAR_LOD_TRIS is the per-species
// near budget; a species whose near geometry is over it gets the build below instead,
// which is roughly half the trunk and foliage blocks of the baked node spread over
// the same envelope (width/height straight from the manifest, matching SPRITE_SPEC so
// the near -> sprite handover keeps the same silhouette). Mid and far bands untouched.
export const NEAR_LOD_TRIS = {
  // Raised from 320/240/270/150/90: at 240-320 tris a crown is 19-25 boxes, too few to
  // fill a cone, so every near tree read as a flat stack. The builds below now spend
  // 444 (pine) / 300 (oak, birch) / 168 (bush) / 96 (snag) inside the same envelopes;
  // the frame total is bounded by the band radii + instance caps (streaming.js), not by
  // these numbers: ~220 k drawn tris at MED.
  [PROP.PINE]: 450, [PROP.OAK]: 330, [PROP.BIRCH]: 330, [PROP.BUSH]: 190, [PROP.DEAD]: 110,
};
const NEAR_LOD_SPEC = {
  // tiers x perTier boxes of foliage on one trunk box, sized to the baked envelope.
  // leafT is the three-tone foliage ramp (lit crown / mid mass / shaded underside):
  // a single flat leaf colour made the near canopies read as pale, flat cards.
  [PROP.PINE]: { w: 4.58, h: 9.44, bark: 0x3d2c19, leaf: 0x2f4a2c, leafT: [0x38562f, 0x2f4a2c, 0x1e3120], tiers: 6, perTier: 6, cone: 1, taper: 0.80, trunkH: 0.24 },
  [PROP.OAK]: { w: 4.84, h: 7.37, bark: 0x5c4127, leaf: 0x3f6b30, leafT: [0x4e7a33, 0x3f6b30, 0x2a4a20], tiers: 4, perTier: 6, base: 0.46 },
  [PROP.BIRCH]: { w: 3.74, h: 7.96, bark: 0x8d8577, leaf: 0x4a7a3a, leafT: [0x568343, 0x4a7a3a, 0x30522a], tiers: 4, perTier: 6, base: 0.50 },
  [PROP.BUSH]: { w: 2.00, h: 1.57, bark: 0x35602c, leaf: 0x35602c, leafT: [0x3e6b33, 0x35602c, 0x21401c], tiers: 2, perTier: 7, base: 0.05, trunk: 0 },
  [PROP.DEAD]: { w: 2.02, h: 5.94, bark: 0x6a5843, leaf: 0x5b4c39, snag: 1 },
};

/**
 * Cheap near geometry per species. A conifer is a trunk plus a conical stack of
 * pinwheeled tiers; a broadleaf/bush is a trunk plus a stacked blob; the dead snag is
 * a tapering trunk with three limbs. Same outer envelope as the baked node, so the
 * skyline of a stand does not move — only the block count inside it halves.
 */
function lodGeo(sp, GeoBuilder) {
    const b = new GeoBuilder();
    if (sp.snag) {
      let y = 0;
      for (let k = 0; k < 4; k++) {
        const hy = sp.h * (0.16 - 0.02 * k);
        b.box(0, y + hy, 0, 0.15 - 0.022 * k, hy, 0.15 - 0.022 * k, sp.bark);
        y += hy * 2;
      }
      b.box(sp.w * 0.22, sp.h * 0.56, 0, sp.w * 0.22, 0.07, 0.06, sp.leaf);
      b.box(-sp.w * 0.19, sp.h * 0.70, sp.w * 0.09, sp.w * 0.19, 0.06, 0.06, sp.leaf);
      b.box(0.05, sp.h * 0.86, -sp.w * 0.14, 0.06, sp.h * 0.10, 0.06, sp.leaf);
    } else {
      if (sp.trunk !== 0) {
        const th = sp.h * (sp.trunkH || 0.17);
        b.box(0, th * 0.5, 0, 0.16, th * 0.5, 0.16, sp.bark);
      }
      const base = sp.base !== undefined ? sp.base : 0.30;
      // Three foliage tones, darkest at the lowest tier (the shaded underside of the
      // crown) and on the interior core box, lit on the outer shell of the top tier.
      // One flat tone was what made a near canopy read as a pale card.
      const T = sp.leafT;
      const tone = (k, j) => {
        if (!T) return sp.leaf;
        if (k === 0) return T[2];                       // underside
        if (j === 0) return T[2];                       // interior core, never visible lit
        if (k === sp.tiers - 1) return T[0];            // lit crown
        return T[1];                                    // mid mass
      };
      for (let k = 0; k < sp.tiers; k++) {
        const t = sp.tiers > 1 ? k / (sp.tiers - 1) : 0;
        const rad = sp.w * 0.5 * (1 - (sp.cone ? (sp.taper || 0.80) : 0.30) * t);
        const y = sp.h * (base + (0.94 - base) * t);
        const hy = sp.h * (sp.cone ? 0.085 : 0.11) * (1 - 0.25 * t);
        for (let j = 0; j < sp.perTier; j++) {
          const a = (j / sp.perTier) * Math.PI * 2 + k * 0.7;
          const off = j === 0 ? 0 : rad * 0.40;
          const hx = j % 2 ? rad * 0.40 : rad * 0.54;
          const hz = j % 2 ? rad * 0.54 : rad * 0.40;
          b.box(Math.cos(a) * off, y, Math.sin(a) * off, hx, hy, hz, tone(k, j));
        }
      }
    }
  return b;
}

/** One near build per species (the band default). */
export function buildNearLodGeometries(GeoBuilder, THREE) {
  const geos = {};
  for (const [key, sp] of Object.entries(NEAR_LOD_SPEC)) geos[Number(key)] = lodGeo(sp, GeoBuilder).toGeometry(THREE);
  return geos;
}

/** Real pine size classes instead of one geometry scaled up and down: an understory
 *  sapling, the standard mid-canopy tree and a dominant, each its own near build (own
 *  tier count, taper, trunk height), so a stand has three silhouettes rather than one
 *  silhouette in three sizes. All three stay inside NEAR_LOD_TRIS[PINE].
 */
export const NEAR_LOD_VARIANTS = {
  [PROP.PINE]: [
    Object.assign({}, NEAR_LOD_SPEC[PROP.PINE], { w: 3.10, h: 6.60, tiers: 5, perTier: 5, base: 0.30, trunkH: 0.20 }),
    Object.assign({}, NEAR_LOD_SPEC[PROP.PINE]),
    Object.assign({}, NEAR_LOD_SPEC[PROP.PINE], { w: 5.10, h: 11.00, tiers: 6, perTier: 6, base: 0.34, trunkH: 0.28, taper: 0.78 }),
  ],
};

export function buildNearLodVariantGeometries(GeoBuilder, THREE) {
  const out = {};
  for (const [key, list] of Object.entries(NEAR_LOD_VARIANTS)) {
    out[Number(key)] = list.map((sp) => lodGeo(sp, GeoBuilder).toGeometry(THREE));
  }
  return out;
}

export function buildSpriteGeometries(THREE) {
  const geos = {};
  for (const prop of SPRITE_PROPS) {
    const sp = SPRITE_SPEC[prop];
    const pos = [], uv = [], nrm = [], idx = [];
    for (let p = 0; p < sp.planes; p++) {
      // The planes used to all pass through the trunk axis, so a stand collapsed into a
      // wall of flat slabs from a low view. Each plane is pushed along its own normal
      // and runs a little shorter and narrower than the last, which gives the crown real
      // depth and keeps the silhouette changing as you drive past.
      const a = (p * Math.PI) / sp.planes + p * 0.19;
      const wd = sp.w * (1 - 0.07 * p), ht = sp.h * (1 - 0.10 * p);
      const dx = Math.cos(a) * wd * 0.5, dz = Math.sin(a) * wd * 0.5;
      const nx = Math.sin(a), nz = -Math.cos(a);
      const ox = nx * (p - (sp.planes - 1) / 2) * sp.w * 0.17;
      const oz = nz * (p - (sp.planes - 1) / 2) * sp.w * 0.17;
      const base = pos.length / 4;
      const [u0, v0, u1, v1] = atlasRect(SPRITE_PROPS.indexOf(prop));
      // bottom-left, bottom-right, top-right, top-left
      pos.push(-dx + ox, 0, -dz + oz, dx + ox, 0, dz + oz,
        dx + ox, ht, dz + oz, -dx + ox, ht, -dz + oz);
      uv.push(u0, v0, u1, v0, u1, v1, u0, v1);
      for (let k = 0; k < 4; k++) nrm.push(nx, 0, nz);
      idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
    g.setIndex(idx);
    g.computeBoundingSphere();
    geos[prop] = g;
  }
  return geos;
}

/** One material for every sprite species, fed by the single foliage atlas: no
 *  per-instance material variation, one shader program for the whole forest.
 *  Lambert so the sprites darken in shade instead of glowing, alphaTest instead of
 *  transparency (no sorting artifacts, and the shadow depth pass respects alphaTest
 *  so the shadow is the leaf, not the quad). Keyed by species so callers keep their
 *  per-species lookups while sharing the same material object. */
export function buildSpriteMaterials(THREE, tex) {
  if (!tex) return null;
  const mats = {};
  const shared = new THREE.MeshLambertMaterial({
    map: tex, alphaTest: 0.5, side: THREE.DoubleSide, vertexColors: false,
  });
  for (const prop of SPRITE_PROPS) mats[prop] = shared;
  return mats;
}

/**
 * Far LOD: ONE camera-facing quad per tree (2 triangles, the cheapest thing that can
 * still read as a tree at 60 m+). Built once per species; the yaw is written per
 * instance at rebuild time so the quad squares up to the camera. The crown is drawn
 * a little wider than the crossed-quad LOD so a distant stand keeps the same skyline
 * mass even with a third of the geometry.
 */
export function buildBillboardGeometries(THREE) {
  const geos = {};
  for (const prop of SPRITE_PROPS) {
    const sp = SPRITE_SPEC[prop];
    // Crown mass comes from the 48x48 far cell, so the quad can be a touch wider: same
    // 2 triangles, more canopy on screen at 150..400 m.
    const wd = sp.w * 1.26, ht = sp.h * 1.04;
    const [u0, v0, u1, v1] = farAtlasRect(SPRITE_PROPS.indexOf(prop));
    const pos = [], uv = [], nrm = [], idx = [];
    pos.push(-wd / 2, 0, 0, wd / 2, 0, 0, wd / 2, ht, 0, -wd / 2, ht, 0);
    uv.push(u0, v0, u1, v0, u1, v1, u0, v1);
    for (let k = 0; k < 4; k++) nrm.push(0, 0, 1);
    idx.push(0, 1, 2, 0, 2, 3);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
    g.setIndex(idx);
    g.computeBoundingSphere();
    geos[prop] = g;
  }
  return geos;
}

function pickSpecies(t, biome) {
  // `t` mixes the grove hash (which species owns the patch) with the per-column hash
  // (the odd one out), so a grove is coherent but not monotonous.
  switch (biome) {
    case 'MOUNTAIN': return t < 0.75 ? PROP.PINE : PROP.DEAD;
    case 'SWAMP': return t < 0.55 ? PROP.DEAD : PROP.OAK;
    case 'CANYON': return t < 0.7 ? PROP.DEAD : PROP.PINE;
    case 'PLATEAU': return t < 0.6 ? PROP.OAK : PROP.DEAD;
    default: return t < 0.42 ? PROP.OAK : (t < 0.72 ? PROP.PINE : (t < 0.88 ? PROP.BIRCH : PROP.DEAD));
  }
}

function worldSurface(stage, x, z) {
  return stage.world ? stage.world.surfaceAt(x, z) : 0;
}

/** Blocky tree geometry variants (docs/03 §2: trunks as columns, canopy as a blob).
 *  Boxes are half-extents around a centre, so every canopy box is written to *overlap*
 *  the trunk it sits on: a gap between trunk top and canopy is what made the old trees
 *  read as floating green crates (PLAN §10 criterion 5). */
export function buildTreeGeometries(GeoBuilder, THREE) {
  const geos = {};

  // Oak (broadleaf, "birch/oak" tone family): a trunk that keeps growing into the
  // crown, then a canopy whose lobes interlock through the trunk top so the mass has
  // no daylight gaps. Greens are blue-poor (the blue hemisphere was turning the old
  // 0x3f6b30 canopies teal); trunks are red-brown and differ per species.
  // Oak and pine are drawn as crossed alpha sprites now (PLAN §10.2 "vegetation as
  // sprite billboards"); the voxel canopy boxes are gone. What remains voxel is the
  // trunk, painted into the sprite and backed by a short voxel stub so the base of
  // a tree still meets the ground like a solid object (see buildSpriteGeometries).
  const oak = new GeoBuilder();
  oak.box(0, 0.55, 0, 0.30, 0.55, 0.30, 0x5c4127);
  geos[PROP.OAK] = oak.toGeometry(THREE);

  // Pine / spruce tone family: darker, blue-green needles, conical stack where every
  // tier overlaps the one below, trunk visible between tiers and running up into the
  // top of the crown.
  const pine = new GeoBuilder();
  pine.box(0, 0.6, 0, 0.24, 0.6, 0.24, 0x3d2c19);
  geos[PROP.PINE] = pine.toGeometry(THREE);

  // Dead / birch-family snag: pale warm bark with darker bands, a few limbs that
  // start *inside* the trunk instead of floating beside it.
  const dead = new GeoBuilder();
  dead.box(0, 2.2, 0, 0.19, 2.2, 0.19, 0x6a5843);
  dead.box(0, 1.15, 0, 0.21, 0.22, 0.21, 0x4c3f2e);
  dead.box(0, 3.2, 0, 0.17, 0.5, 0.17, 0x5b4c39);
  dead.box(0.55, 3.35, 0, 0.62, 0.13, 0.13, 0x463a2a);
  dead.box(-0.45, 4.05, 0.2, 0.52, 0.11, 0.11, 0x463a2a);
  dead.box(0.1, 4.5, -0.35, 0.13, 0.55, 0.13, 0x4f4130);
  geos[PROP.DEAD] = dead.toGeometry(THREE);

  const spec = new GeoBuilder();
  spec.box(0, 0.85, 0, 0.22, 0.55, 0.18, 0x2f3a44);      // body 1.7 m tall block person
  spec.box(0, 1.52, 0, 0.15, 0.15, 0.14, 0xc9a487);      // head
  geos[PROP.SPECTATOR] = spec.toGeometry(THREE);

  // Corner post: dark timber with a dark-red reflector tab. The tab used to be
  // near-white 0xd8dbe0: lit by the low key light it came out as a flat neutral grey
  // ~ (186,183,186) and, standing every 8 m along the verge, it read as the pale
  // plates / dashes of the reference frame (measured: that grey is the single most
  // common colour in the lower half of the frame, ~10k px).
  // Corner marker: a 1.6 m timber post with a real flag panel on the outside of the
  // corner (PLAN §10.2 "stolpki z flagami po zewnetrznej - znak zakretu, nie plakietka
  // HUD-u"). Red/white panel, angled to the line of sight of the approaching car,
  // big enough (0.62 x 0.42 m) to read from a hundred metres.
  const post = new GeoBuilder();
  post.box(0, 0.8, 0, 0.12, 0.8, 0.12, 0x4b4030);
  post.box(0, 0.14, 0, 0.30, 0.14, 0.30, 0x2b3339);
  post.box(0.22, 1.36, 0, 0.31, 0.21, 0.04, 0xb23a2b);
  post.box(0.22, 1.36, 0.045, 0.31, 0.10, 0.012, 0xd9d2c4);
  post.box(-0.16, 1.05, 0, 0.14, 0.10, 0.03, 0xb23a2b);
  geos[PROP.POST] = post.toGeometry(THREE);

  const marshal = new GeoBuilder();
  marshal.box(0, 0.8, 0, 0.24, 0.55, 0.2, 0x2a4a2c);
  marshal.box(0, 1.5, 0, 0.16, 0.16, 0.15, 0xc9a487);
  marshal.box(0.4, 1.5, 0, 0.22, 0.14, 0.03, 0xe8c34a);
  geos[PROP.MARSHAL] = marshal.toGeometry(THREE);

  return geos;
}

/** Depth planes for the gate, in metres from the road plane along the lane axis.
 *  A colour lives on exactly one plane, and no plane is shared by two colours whose
 *  footprints overlap - the depth pass (near 0.25 / far 900) cannot separate faces
 *  closer than about 12 cm at the 150 m this board has to read from. */
export const GATE_PLANES = {
  core: 0.14,     // the banner core, and the banded posts
  band: 0.32,     // name blocks and lamps - proud of the core on both faces
  rib: 0.26,      // the sub-board rib under the banner
  beam: 0.46,     // the top beam and the lamp housings it hangs from
};

/** Checkpoint / start gate: two posts at the road edge + a banner over the lane +
 *  lamps (PLAN §10 "checkpointy stoją przy drodze": a gate, not a map dot). Built to
 *  be read from ~150 m: 11 m span, 6 m tall, high-contrast banding, a warm lamp panel
 *  the bloom pass picks up, pennants on top so the silhouette is a gate and not a
 *  signpost. Half-span 5.4 m clears the carriageway + SHOULDER.
 *
 *  Solidness: this is ONE solid core per element with the coloured bands running clean
 *  THROUGH it, never a plate glued onto a plate. The previous build was a 0.12 m pale
 *  core with a 0.05 m pale face plate at z 0.17 (its inner face landing exactly on the
 *  core face at z 0.12), 0.06 m red tabs and 0.06 m dark name blocks at z 0.24, and a
 *  0.30 m beam / 0.30 m lamp housing sharing the same z faces - 32 pairs of same-facing,
 *  differently coloured faces sat within 2 cm of one plane across the same 10.7 m span,
 *  which is what came back as a white/red checkerboard. Every element here is a solid
 *  box, the coloured bands are full-depth (they enclose the core instead of standing on
 *  it), and the only coplanar pairs left are same-colour or footprint-disjoint.
 *  T21 enforces that on this geometry. */
export function buildGateGeometry(GeoBuilder, THREE) {
  const g = new GeoBuilder();
  // post colour anchored down from 0xf3f5f8: a near-white 10.7 x 1.1 m banner plus 6 m
  // banded poles read as pale plates against the dark forest at a distance.
  const post = 0xcbb691, red = 0xb8362c, dark = 0x1c242c, warm = 0xe8b45c;
  const CORE = GATE_PLANES.core, BAND = GATE_PLANES.band, RIB = GATE_PLANES.rib, BEAM = GATE_PLANES.beam;
  for (const s of [-1, 1]) {
    // Post: 0.36 m square, 6.5 m tall, starting inside its own base pad so the pad top
    // and the post bottom never share the ground plane. 0.36 m (not 0.42) also keeps the
    // pale post 12 cm clear of the red band plane it stands next to. It starts at the top
    // of the base pad and runs up past the pennant, so nothing floats or shares a face.
    g.box(s * 5.4, 3.46, 0, 0.18, 3.14, 0.18, post);
    // Bands are fatter than the post and enclose it - colour through the core.
    g.box(s * 5.4, 1.15, 0, 0.30, 0.45, 0.30, red);
    g.box(s * 5.4, 2.65, 0, 0.30, 0.45, 0.30, red);
    g.box(s * 5.4, 4.15, 0, 0.30, 0.35, 0.30, red);
    // The board's red ends are the posts themselves: this band runs 13 cm past the
    // banner core in every direction, so the core butts into it instead of having a red
    // plate pasted over its end.
    g.box(s * 5.4, 5.10, 0, 0.30, 0.68, 0.30, red);
    // Base pad so the post has a footing, not a floating stick.
    g.box(s * 5.4, 0.16, 0, 0.52, 0.16, 0.52, dark);
    // Lamp bank: a warm column inboard of the post band, sitting on the band plane and
    // tied into the beam. The old warm panel sat inside a dark housing (0.22 m panel in a
    // 0.30 m box), so an 11 cm sliver of it was ever visible from the road.
    g.box(s * 4.70, 5.10, 0, 0.34, 0.68, BAND, warm);
    // Pennant on top of the post (moves in the wind of a passing car visually).
    g.boxRot(s * 5.4, 6.55, 0.34, 0.55, 0.30, 0.03, 0.25, s < 0 ? red : post);
  }
  // Beam + banner across the carriageway: one deep beam above, one solid core, and
  // full-depth name blocks running through it. Nothing is a plate on a plate any more.
  g.box(0, 5.75, 0, 5.46, 0.20, BEAM, dark);               // top beam, ends buried in the posts
  g.box(0, 5.10, 0, 5.20, 0.55, CORE, post);             // solid banner core, 0.28 m
  // Five dark name blocks across the core, wide enough to read as text at 100 m, and
  // full-depth so they read as relief from either direction along the lane (the gate is
  // placed on a road tangent, so it is seen from both sides over a run).
  for (let k = 0; k < 5; k++) g.box(-3.1 + k * 1.55, 5.10, 0, 0.34, 0.24, BAND, dark);
  // Sub-board rib under the banner, also full-depth instead of a 0.12 m sheet.
  g.box(0, 4.28, 0, 2.6, 0.40, RIB, dark);
  return g.toGeometry(THREE);
}
