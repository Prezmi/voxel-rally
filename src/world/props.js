// Stage decoration (docs/03 §5): trees, spectators, corner posts, checkpoint gates.
// Placement is deterministic per chunk (hashed scatter, no Math.random) and every
// prop is instanced: one geometry + one InstancedMesh per species.
import { hash01 } from './noise.js';
import { CHUNK, chunkKey } from './chunk.js';
import { SURF } from './surfaces.js';
import { SHOULDER } from './road-carve.js';

export const PROP = { OAK: 0, PINE: 1, DEAD: 2, SPECTATOR: 3, POST: 4, GATE: 5, MARSHAL: 6 };
export const PROP_NAMES = ['oak', 'pine', 'dead', 'spectator', 'post', 'gate', 'marshal'];

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
      if (h > density * (0.035 + 0.30 * grove * grove)) continue;
      const i = road.nearest(wx + 0.5, wz + 0.5);
      const lat = (wx + 0.5 - road.x[i]) * road.nx[i] + (wz + 0.5 - road.z[i]) * road.nz[i];
      const absLat = Math.abs(lat);
      const edge = road.width[i] / 2 + SHOULDER;
      if (absLat < edge + 1.8) continue;                 // keep the corridor clear
      if (absLat > 220) continue;
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
      const scale = (species === PROP.PINE ? 0.95 : 0.78)
        + hash01(wx, wz, TREE_SALT ^ (seed + 7)) * (species === PROP.DEAD ? 0.7 : 1.05);
      out.push({
        prop: species, x: wx + 0.5, y, z: wz + 0.5,
        yaw: hash01(wx, wz, TREE_SALT ^ (seed + 13)) * Math.PI * 2,
        scale, variant: Math.floor(hash01(wx, wz, TREE_SALT ^ (seed + 29)) * 3),
      });
    }
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
      out.push({ prop: PROP.POST, x: px, y: terrain.heightAt(px, pz), z: pz, yaw: 0, scale: 1, variant: 0 });
    }
  }

  return out;
}

function pickSpecies(t, biome) {
  // `t` mixes the grove hash (which species owns the patch) with the per-column hash
  // (the odd one out), so a grove is coherent but not monotonous.
  switch (biome) {
    case 'MOUNTAIN': return t < 0.75 ? PROP.PINE : PROP.DEAD;
    case 'SWAMP': return t < 0.55 ? PROP.DEAD : PROP.OAK;
    case 'CANYON': return t < 0.7 ? PROP.DEAD : PROP.PINE;
    case 'PLATEAU': return t < 0.6 ? PROP.OAK : PROP.DEAD;
    default: return t < 0.5 ? PROP.OAK : (t < 0.85 ? PROP.PINE : PROP.DEAD);
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

  // Oak: a thick trunk that keeps growing into the crown, lobes that interlock.
  const oak = new GeoBuilder();
  oak.box(0, 1.95, 0, 0.27, 1.95, 0.27, 0x5a4326);            // trunk 0 .. 3.9
  oak.box(0.1, 3.5, 0, 0.42, 0.9, 0.42, 0x4b3a22);            // flare into the crown
  oak.box(0, 4.5, 0, 1.55, 1.15, 1.5, 0x3f6b30);
  oak.box(1.05, 3.75, 0.45, 0.95, 0.75, 0.9, 0x477a36);
  oak.box(-0.85, 5.2, -0.6, 0.9, 0.7, 0.85, 0x35602a);
  oak.box(-0.3, 5.9, 0.5, 0.7, 0.5, 0.7, 0x436f33);
  geos[PROP.OAK] = oak.toGeometry(THREE);

  // Pine: conical stack, each tier wider than the one above, trunk visible between.
  const pine = new GeoBuilder();
  pine.box(0, 2.7, 0, 0.21, 2.7, 0.21, 0x4b3a22);             // trunk 0 .. 5.4
  pine.box(0, 3.1, 0, 1.45, 0.8, 1.45, 0x2c5230);
  pine.box(0, 4.35, 0, 1.12, 0.75, 1.12, 0x315c34);
  pine.box(0, 5.5, 0, 0.8, 0.7, 0.8, 0x27482a);
  pine.box(0, 6.5, 0, 0.45, 0.55, 0.45, 0x2f5a2f);
  geos[PROP.PINE] = pine.toGeometry(THREE);

  const dead = new GeoBuilder();
  dead.box(0, 2.1, 0, 0.19, 2.1, 0.19, 0x544535);
  dead.box(0.6, 3.3, 0, 0.62, 0.12, 0.12, 0x4a3d2f);
  dead.box(-0.5, 4.0, 0.2, 0.52, 0.1, 0.1, 0x4a3d2f);
  dead.box(0.1, 4.5, -0.4, 0.12, 0.5, 0.12, 0x4a3d2f);
  geos[PROP.DEAD] = dead.toGeometry(THREE);

  const spec = new GeoBuilder();
  spec.box(0, 0.85, 0, 0.22, 0.55, 0.18, 0x2f3a44);      // body 1.7 m tall block person
  spec.box(0, 1.52, 0, 0.15, 0.15, 0.14, 0xc9a487);      // head
  geos[PROP.SPECTATOR] = spec.toGeometry(THREE);

  const post = new GeoBuilder();
  post.box(0, 0.7, 0, 0.12, 0.7, 0.12, 0xd8dbe0);
  post.box(0, 1.45, 0, 0.3, 0.18, 0.06, 0xd43a2f);
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
  const post = 0xf3f5f8, red = 0xd4382c, dark = 0x1c242c, warm = 0xffd27a;
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
  // Beam + banner across the carriageway.
  g.box(0, 5.62, 0, 5.7, 0.24, 0.30, dark);
  g.box(0, 5.10, 0, 5.35, 0.55, 0.14, post);
  g.box(0, 5.10, 0.16, 5.35, 0.55, 0.03, red);
  // Chequered corner tabs: the shape the eye reads as "checkpoint".
  for (const s of [-1, 1]) {
    g.box(s * 5.0, 5.10, 0.18, 0.55, 0.55, 0.02, red);
    g.box(s * 4.4, 5.10, 0.18, 0.55, 0.55, 0.02, post);
  }
  // Start/finish-style name board, dark on light, readable at ~150 m.
  g.box(0, 4.28, 0.10, 2.6, 0.42, 0.06, dark);
  return g.toGeometry(THREE);
}
