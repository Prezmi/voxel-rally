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
  // Hard per-chunk cap: keeps the prop budget (and therefore the instance budget the
  // streaming layer can actually spend in front of the camera) predictable.
  const TREE_CAP = 44;

  // ---- trees / bushes: grove-field scatter per column ----
  // A 7 m cell hash sets how wooded a patch is, so the stand clumps into groves with
  // gaps between them instead of the even 1-in-6 lattice the old scatter produced
  // (PLAN §10 "las przy drodze, nie siatka"). Species follows the grove, with a per-tree
  // jitter, so a patch reads as one species rather than a chessboard.
  for (let lz = 0; lz < CHUNK; lz++) {
    for (let lx = 0; lx < CHUNK; lx++) {
      if (out.length >= TREE_CAP) break;
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
      if (h > density * near * (0.06 + 0.34 * grove * grove)) continue;
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
      const scale = (species === PROP.PINE ? 0.82 : 0.66)
        + hash01(wx, wz, TREE_SALT ^ (seed + 7)) * (species === PROP.DEAD ? 0.6 : 0.85);
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
      const postY = stage.world ? stage.world.columnTopAt(Math.floor(px), Math.floor(pz)) : -1;
      out.push({ prop: PROP.POST, x: px, y: postY >= 0 ? postY : terrain.heightAt(px, pz), z: pz, yaw: 0, scale: 1, variant: 0 });
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

  // Oak (broadleaf, "birch/oak" tone family): a trunk that keeps growing into the
  // crown, then a canopy whose lobes interlock through the trunk top so the mass has
  // no daylight gaps. Greens are blue-poor (the blue hemisphere was turning the old
  // 0x3f6b30 canopies teal); trunks are red-brown and differ per species.
  const oak = new GeoBuilder();
  oak.box(0, 2.15, 0, 0.28, 2.15, 0.28, 0x5c4127);            // trunk 0 .. 4.3
  oak.box(0, 4.05, 0, 0.34, 0.9, 0.34, 0x463320);            // flare into the crown
  oak.box(0, 4.75, 0, 1.6, 1.25, 1.55, 0x2f5a24);
  oak.box(1.1, 3.95, 0.45, 0.95, 0.85, 0.9, 0x36612a);
  oak.box(-0.9, 5.35, -0.6, 0.95, 0.8, 0.9, 0x28501f);
  oak.box(-0.3, 6.05, 0.5, 0.75, 0.6, 0.75, 0x3a6630);
  oak.box(0.45, 5.1, -0.75, 0.8, 0.7, 0.7, 0x2c5524);
  geos[PROP.OAK] = oak.toGeometry(THREE);

  // Pine / spruce tone family: darker, blue-green needles, conical stack where every
  // tier overlaps the one below, trunk visible between tiers and running up into the
  // top of the crown.
  const pine = new GeoBuilder();
  pine.box(0, 3.0, 0, 0.22, 3.0, 0.22, 0x3d2c19);             // trunk 0 .. 6.0
  pine.box(0, 2.55, 0, 1.05, 0.75, 1.05, 0x22421f);
  pine.box(0, 3.55, 0, 1.45, 0.95, 1.45, 0x1f3d1f);
  pine.box(0, 4.7, 0, 1.12, 0.9, 1.12, 0x27492a);
  pine.box(0, 5.8, 0, 0.8, 0.85, 0.8, 0x214122);
  pine.box(0, 6.85, 0, 0.45, 0.65, 0.45, 0x2c5230);
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
  const post = new GeoBuilder();
  post.box(0, 0.7, 0, 0.12, 0.7, 0.12, 0x534838);
  post.box(0, 1.45, 0, 0.26, 0.18, 0.05, 0xa43226);
  post.box(0, 1.15, 0.02, 0.10, 0.06, 0.04, 0x8f2b21);
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
