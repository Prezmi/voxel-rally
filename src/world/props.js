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
export const SPRITE_PROPS = [PROP.OAK, PROP.PINE, PROP.BIRCH, PROP.BUSH, PROP.FERN];
export const SPRITE_SPEC = {
  [PROP.OAK]: { w: 5.6, h: 7.2, planes: 3 },
  [PROP.PINE]: { w: 4.6, h: 9.4, planes: 3 },
  [PROP.BIRCH]: { w: 4.4, h: 7.8, planes: 3 },
  [PROP.BUSH]: { w: 2.3, h: 1.7, planes: 2 },
  [PROP.FERN]: { w: 1.8, h: 1.3, planes: 2 },
};
const SPR = { OAK: 0, PINE: 1, BIRCH: 2, BUSH: 3, FERN: 4 };
const TEX_PX = 32;                       // 32x32, nearest neighbour (true pixel art)
// One canvas atlas, painted once at boot: every sprite species lives in its own
// 32x32 cell of a single texture, so the whole forest is one texture and one shader
// program (PLAN §10.2 "zero assetów": still fully procedural, still no file).
const ATLAS = { cols: 4, w: TEX_PX * 4, h: TEX_PX * 2 };
const SPR_CELL = [SPR.OAK, SPR.PINE, SPR.BIRCH, SPR.BUSH, SPR.FERN];

/** Atlas cell of one sprite species as [u0,v0,u1,v1], inset by half a texel so a
 *  neighbouring cell can never bleed in at the quad edge. */
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
  const TREE_CAP = 44;
  const cands = [];

  // ---- trees / bushes: grove-field scatter per column ----
  // A 7 m cell hash sets how wooded a patch is, so the stand clumps into groves with
  // gaps between them instead of the even 1-in-6 lattice the old scatter produced
  // (PLAN §10 "las przy drodze, nie siatka"). Species follows the grove, with a per-tree
  // jitter, so a patch reads as one species rather than a chessboard.
  for (let lz = 0; lz < CHUNK; lz++) {
    for (let lx = 0; lx < CHUNK; lx++) {
      const wx = x0 + lx, wz = z0 + lz;
      const grove = hash01(Math.floor(wx / 7), Math.floor(wz / 7), CLUSTER_SALT ^ seed);
      const h = hash01(wx, wz, TREE_SALT ^ seed);
      const i = road.nearest(wx + 0.5, wz + 0.5);
      const lat = (wx + 0.5 - road.x[i]) * road.nx[i] + (wz + 0.5 - road.z[i]) * road.nz[i];
      const absLat = Math.abs(lat);
      const edge = road.width[i] / 2 + SHOULDER;
      if (absLat < edge + 4.2) continue;                  // keep corridor + verge open
      // Forest budget goes to the corridor: the brief is "las przy drodze" (PLAN §10),
      // and the deep-field trees behind the first stand are never seen. Grove field
      // decides how far a stand reaches, so the edge is dense and the far ground thins.
      // The stand stays *out of* the lane sightline: canopies are 3-4 m wide, so the
      // stand begins past the shoulder instead of leaning over the carriageway.
      const reach = 64 + 60 * grove * grove;
      if (absLat > reach) continue;
      const near = absLat < edge + 26 ? 1.15 : 1.0;       // denser right at the verge
      // Forest EDGE, not a wall: past the first stand the acceptance odds fall off, so
      // the deep field thins to singles instead of closing into one even horizon band
      // (that band is what read as a distant city skyline in the driving frames).
      const taper = Math.max(0.16, 1 - Math.max(0, absLat - (edge + 24))
        / Math.max(1, reach - edge - 24));
      if (h > density * near * taper * (0.06 + 0.34 * grove * grove)) continue;
      const surf = worldSurface(stage, wx, wz);
      if (surf === SURF.ASPHALT || surf === SURF.ICE) continue;
      const slope = terrain.slopeAt(wx + 0.5, wz + 0.5);
      if (slope > 0.75) continue;
      // Stand on the *carved* ground where the corridor bank exists: an analytic height
      // leaves the trunk floating a block above a banked verge (the old shot's trees).
      const carved = stage.world ? stage.world.columnTopAt(wx, wz) : -1;
      const y = carved >= 0 ? carved : terrain.heightAt(wx + 0.5, wz + 0.5);
      const species = pickSpecies(grove * 0.6 + h * 0.4, stage.biome);
      // Height/species variation from the seed: same species in a grove, different trees.
      // Sub-cell jitter: on an exact 1 m grid every trunk sits on the same spacing, and
      // at distance that picket regularity is half of the skyline read.
      const jx = (hash01(wx, wz, TREE_SALT ^ (seed + 41)) - 0.5) * 0.86;
      const jz = (hash01(wx, wz, TREE_SALT ^ (seed + 53)) - 0.5) * 0.86;
      // Crown spread: a row of identical heights is the other half of it, so pines run
      // 0.72..1.80 and broadleaves 0.60..1.68 instead of one narrow band.
      const scale = (species === PROP.PINE ? 0.72 : 0.60)
        + hash01(wx, wz, TREE_SALT ^ (seed + 7)) * (species === PROP.DEAD ? 1.00 : 1.08);
      cands.push({
        prop: species, x: wx + 0.5 + jx, y, z: wz + 0.5 + jz,
        yaw: hash01(wx, wz, TREE_SALT ^ (seed + 13)) * Math.PI * 2,
        scale, variant: Math.floor(hash01(wx, wz, TREE_SALT ^ (seed + 29)) * 3),
      });
    }
  }
  // Spend the cap on a stride over the whole chunk, not on the first cells the scan
  // reached: the old `break` parked a full stand in the low-lz half of every chunk, so
  // the props arrived in blocks that lined up across chunk borders.
  if (cands.length <= TREE_CAP) out.push(...cands);
  else {
    const step = cands.length / TREE_CAP;
    for (let k = 0; k < TREE_CAP; k++) out.push(cands[Math.floor(k * step)]);
  }

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
      if (hsh > 0.62) continue;
      const side = hash01(i, 10, BUSH_SALT ^ seed) < 0.5 ? 1 : -1;
      const along = hash01(i, 11, BUSH_SALT ^ seed) * 2.2 - 1.1;
      const off = road.width[i] / 2 + SHOULDER + 1.2 + hash01(i, 12, BUSH_SALT ^ seed) * 3.4;
      const px = road.x[i] + road.nx[i] * off * side + road.tx[i] * along;
      const pz = road.z[i] + road.nz[i] * off * side + road.tz[i] * along;
      if (Math.floor(px / CHUNK) !== cx || Math.floor(pz / CHUNK) !== cz) continue;
      const gy = stage.world ? stage.world.columnTopAt(Math.floor(px), Math.floor(pz)) : -1;
      const kind = hash01(i, 13, FERN_SALT ^ seed) < 0.55 ? PROP.FERN : PROP.BUSH;
      out.push({
        prop: kind, x: px, y: gy >= 0 ? gy : terrain.heightAt(px, pz), z: pz,
        yaw: hash01(i, 14, BUSH_SALT ^ (seed + 5)) * Math.PI,
        scale: 0.8 + hash01(i, 15, BUSH_SALT ^ (seed + 11)) * 0.5,
        variant: Math.floor(hash01(i, 16, BUSH_SALT ^ (seed + 17)) * 3),
      });
    }
  }

  return out;
}

/**
 * Procedural foliage textures, painted once at boot into small canvases and read
 * with NearestFilter (PLAN §10.2 "tekstura 16x16 lub 32x32 generowana proceduralnie
 * w kodzie (zero assetów)"). No file, no fetch, no per-frame work: the five
 * canvases are shared by every instance of the species.
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
  if (x < 0 || y < 0 || x >= TEX_PX || y >= TEX_PX) return;
  const k = (y * TEX_PX + x) * 4;
  data[k] = r; data[k + 1] = g; data[k + 2] = b; data[k + 3] = a;
}

function paintFoliage(kind, data) {
  data.fill(0);
  const leaf = (x, y, base, spread, s) => {
    // Three tones per sprite: lit tips, mid mass, shaded underside, plus a hard
    // silhouette jitter so the edge is ragged rather than a cut-out ellipse.
    const n = ph(x, y, s);
    // Wider tone band than the old 1.18/1.0/0.78 split, and the crown is lighter toward
    // the top (y grows downward in the sprite): flat, evenly lit crowns read as one
    // stacked slab instead of a forest.
    const t = (n < 0.22 ? 1.28 : n < 0.70 ? 1.03 : 0.66) + 0.14 * (1 - y / TEX_PX);
    const warm = n < 0.12 ? 12 : 0;
    px(data, x, y, Math.min(255, base[0] * t + warm), Math.min(255, base[1] * t), Math.min(255, base[2] * t * 0.96), 255);
    if (spread && n > 0.86) px(data, x + 1, y, base[0] * 0.7, base[1] * 0.7, base[2] * 0.7, 255);
  };
  const trunk = (x, y, w, c, s) => {
    for (let dx = -w; dx <= w; dx++) {
      const n = ph(x + dx, y, s);
      if (n < 0.10) continue;                        // bark splits
      const t = 0.72 + 0.5 * ph(x + dx, y >> 2, s + 7);
      px(data, x + dx, y, c[0] * t, c[1] * t, c[2] * t, 255);
    }
  };

  if (kind === SPR.PINE || kind === SPR.BIRCH) {
    const spruce = kind === SPR.PINE;
    const base = spruce ? [44, 78, 48] : [120, 158, 74];
    const bark = spruce ? [74, 52, 34] : [206, 198, 176];
    for (let y = 0; y < TEX_PX; y++) {
      const u = y / (TEX_PX - 1);                   // 0 top .. 1 bottom
      if (spruce) {
        // conical stack with jagged tiers
        const half = spruce ? 1.5 + 12.5 * Math.pow(u, 1.35) : 4 + 8 * Math.sin(Math.min(1, u * 1.15) * Math.PI * 0.85);
        const tier = 1 + (y % 4 === 0 ? 1 : 0);
        const jag = ph(y * 3, y, 31) > 0.72 ? tier : 0;
        for (let x = 16 - Math.floor(half) - jag; x <= 16 + Math.floor(half); x++) {
          if (ph(x, y, 17) > 0.14) leaf(x, y, base, true, 5);
        }
        if (u > 0.62) trunk(16, y, spruce ? 1 : 2, bark, 23);
      } else {
        // birch: rounded pale crown, pale banded trunk
        const dy = u - 0.55;
        const half = 12 * Math.sqrt(Math.max(0, 1 - dy * dy * 3.4));
        for (let x = 16 - Math.floor(half); x <= 16 + Math.floor(half); x++) {
          if (ph(x, y, 13) > 0.10) leaf(x, y, base, true, 9);
        }
        if (u > 0.58) {
          trunk(16, y, 2, bark, 29);
          if (y % 5 === 2) for (let x = 14; x <= 18; x++) if (ph(x, y, 41) > 0.45) px(data, x, y, 96, 88, 74, 255);
        }
      }
    }
    return;
  }

  if (kind === SPR.OAK) {
    const base = [78, 118, 52];
    // rounded mass: three overlapping lobes so the crown has no flat side
    const lobes = [[16, 12, 11], [10, 16, 8], [22, 17, 8]];
    for (const [cx0, cy0, r] of lobes) {
      for (let y = cy0 - r; y <= cy0 + r; y++) {
        const dy = (y - cy0) / r;
        const half = r * Math.sqrt(Math.max(0, 1 - dy * dy));
        for (let x = cx0 - half; x <= cx0 + half; x++) {
          if (ph(x, y, 3) > 0.12) leaf(x, y, base, true, 11);
        }
      }
    }
    for (let y = 21; y < TEX_PX; y++) trunk(16, y, y > 26 ? 3 : 2, [96, 66, 40], 19);
    return;
  }

  if (kind === SPR.BUSH) {
    const base = [70, 104, 46];
    for (let y = 12; y < TEX_PX; y++) {
      const dy = (y - 25) / 13;
      const half = 14 * Math.sqrt(Math.max(0, 1 - dy * dy * 1.9));
      for (let x = 16 - half; x <= 16 + half; x++) if (ph(x, y, 7) > 0.16) leaf(x, y, base, true, 15);
    }
    for (let y = 26; y < TEX_PX; y++) trunk(16, y, 1, [70, 56, 36], 21);
    return;
  }

  // FERN / BRACKEN: fronds radiating from the base, drawn as stepped strokes.
  const base = [64, 96, 40];
  for (let f = 0; f < 7; f++) {
    const lean = (f - 3) * 2.6;
    const len = 12 + Math.floor(ph(f, 1, 33) * 8);
    for (let s = 0; s < len; s++) {
      const x = Math.round(16 + lean * (s / len));
      const y = TEX_PX - 2 - s;
      px(data, x, y, base[0], base[1], base[2], 255);
      if (s > 2) { px(data, x - 1, y - 1, base[0] * 1.2, base[1] * 1.2, base[2], 255); px(data, x + 1, y - 1, base[0] * 0.8, base[1] * 0.85, base[2], 255); }
    }
  }
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
  [PROP.PINE]: 264, [PROP.OAK]: 228, [PROP.BIRCH]: 270, [PROP.BUSH]: 132, [PROP.DEAD]: 90,
};
const NEAR_LOD_SPEC = {
  // tiers x perTier boxes of foliage on one trunk box, sized to the baked envelope.
  [PROP.PINE]: { w: 4.58, h: 9.44, bark: 0x3d2c19, leaf: 0x2f4a2c, tiers: 5, perTier: 4, cone: 1 },
  [PROP.OAK]: { w: 4.84, h: 7.37, bark: 0x5c4127, leaf: 0x3f6b30, tiers: 3, perTier: 5, base: 0.46 },
  [PROP.BIRCH]: { w: 3.74, h: 7.96, bark: 0x8d8577, leaf: 0x4a7a3a, tiers: 3, perTier: 5, base: 0.50 },
  [PROP.BUSH]: { w: 2.00, h: 1.57, bark: 0x35602c, leaf: 0x35602c, tiers: 2, perTier: 5, base: 0.05, trunk: 0 },
  [PROP.DEAD]: { w: 2.02, h: 5.94, bark: 0x6a5843, leaf: 0x5b4c39, snag: 1 },
};

/**
 * Cheap near geometry per species. A conifer is a trunk plus a conical stack of
 * pinwheeled tiers; a broadleaf/bush is a trunk plus a stacked blob; the dead snag is
 * a tapering trunk with three limbs. Same outer envelope as the baked node, so the
 * skyline of a stand does not move — only the block count inside it halves.
 */
export function buildNearLodGeometries(GeoBuilder, THREE) {
  const geos = {};
  for (const [key, sp] of Object.entries(NEAR_LOD_SPEC)) {
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
      if (sp.trunk !== 0) b.box(0, sp.h * 0.17, 0, 0.16, sp.h * 0.17, 0.16, sp.bark);
      const base = sp.base !== undefined ? sp.base : 0.30;
      for (let k = 0; k < sp.tiers; k++) {
        const t = sp.tiers > 1 ? k / (sp.tiers - 1) : 0;
        const rad = sp.w * 0.5 * (1 - (sp.cone ? 0.74 : 0.30) * t);
        const y = sp.h * (base + (0.94 - base) * t);
        const hy = sp.h * (sp.cone ? 0.075 : 0.11) * (1 - 0.25 * t);
        for (let j = 0; j < sp.perTier; j++) {
          const a = (j / sp.perTier) * Math.PI * 2 + k * 0.7;
          const off = j === 0 ? 0 : rad * 0.42;
          const hx = j % 2 ? rad * 0.40 : rad * 0.56;
          const hz = j % 2 ? rad * 0.56 : rad * 0.40;
          b.box(Math.cos(a) * off, y, Math.sin(a) * off, hx, hy, hz, sp.leaf);
        }
      }
    }
    geos[Number(key)] = b.toGeometry(THREE);
  }
  return geos;
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
    const wd = sp.w * 1.18, ht = sp.h * 1.02;
    const [u0, v0, u1, v1] = atlasRect(SPRITE_PROPS.indexOf(prop));
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

/** Checkpoint gate: two posts at the road edge + a banner over the lane + lamps
 *  (PLAN §10 "checkpointy stoją przy drodze": a gate, not a map dot). Built to be
 *  read from ~150 m: 11 m span, 6 m tall, high-contrast chequering, a warm lamp
 *  panel the bloom pass picks up, pennants on top so the silhouette is a gate and
 *  not a signpost. Half-span 5.4 m clears the carriageway + SHOULDER. */
export function buildGateGeometry(GeoBuilder, THREE) {
  const g = new GeoBuilder();
  // post colour anchored down from 0xf3f5f8: a near-white 10.7 x 1.1 m banner plus 6 m
  // banded poles read as pale plates against the dark forest at a distance.
  const post = 0xcbb691, red = 0xb8362c, dark = 0x1c242c, warm = 0xe8b45c;
  for (const s of [-1, 1]) {
    // Post: 0.42 m square, 6.2 m tall, banded so it reads at distance.
    g.box(s * 5.4, 3.1, 0, 0.21, 3.1, 0.21, post);
    g.box(s * 5.4, 1.15, 0, 0.24, 0.45, 0.24, red);
    g.box(s * 5.4, 2.65, 0, 0.24, 0.45, 0.24, red);
    g.box(s * 5.4, 4.15, 0, 0.24, 0.35, 0.24, red);
    // Guy wire / brace so the post has a base, not a floating stick.
    g.box(s * 5.4, 0.16, 0, 0.52, 0.16, 0.52, dark);
    // Lamp: warm panel facing down the road, plus its housing.
    g.box(s * 4.7, 5.28, 0, 0.42, 0.20, 0.30, dark);
    g.box(s * 4.7, 5.02, 0, 0.32, 0.10, 0.22, warm);
    // Pennant on top of the post (moves in the wind of a passing car visually).
    g.boxRot(s * 5.4, 6.55, 0.34, 0.55, 0.30, 0.03, 0.25, s < 0 ? red : post);
  }
  // Beam + banner across the carriageway. The old build stacked three near-coplanar
  // slabs (pale plate z 0, red plate z 0.16, 1.1 m chequered tabs z 0.18) over the same
  // 10.7 m span: the depth pass could not separate them and the whole banner came back
  // as a white/red checkerboard. One solid plate per face now, every face at least 4 cm
  // clear of the next, plus dark lettering blocks so it reads as a named start board.
  g.box(0, 5.62, 0, 5.7, 0.24, 0.30, dark);
  g.box(0, 5.10, 0, 5.35, 0.55, 0.12, post);            // solid banner plate (opaque)
  // Lettering and end tabs are carried on BOTH faces: the gantry is placed with a
  // road-tangent normal, so a single-sided board came back blank from the start line.
  for (const sz of [-1, 1]) {
    g.box(0, 5.10, sz * 0.17, 5.35, 0.55, 0.05, post);
    for (const s of [-1, 1]) g.box(s * 4.95, 5.10, sz * 0.24, 0.40, 0.55, 0.06, red);
    // Five dark name blocks across the plate, wide enough to read as text at 100 m.
    for (let k = 0; k < 5; k++) g.box(-3.1 + k * 1.55, 5.10, sz * 0.24, 0.34, 0.24, 0.06, dark);
  }
  g.box(0, 4.28, 0.10, 2.6, 0.42, 0.06, dark);
  return g.toGeometry(THREE);
}
