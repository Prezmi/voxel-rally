// Block tile selection (the visual paving band of the corridor) as DATA.
//
// This is the exact selection loop that used to live in `Streaming._chunkTiles`; it moved
// here unchanged so the offline baker (tools/bake-map.mjs) can put the same table into a
// shipped map file (src/world/map-load.js) without importing the renderer-side streaming
// module (which pulls THREE and cannot run in node). Streaming now calls this function,
// so there is still exactly one implementation.
import { CHUNK, COLS } from './chunk.js';
import { hash01 } from './noise.js';
import { SURF } from './surfaces.js';
import { SHOULDER } from './road-carve.js';

export const VERGE = 1.7;                 // nominal m past carriageway+shoulder that still counts
export const VERGE_SALT = 0x5177a1e3;
export const BARE_SALT = 0x2be4c07d;
export const PEBBLE_CHANCE = 0.18;        // share of the road-edge band that becomes small stones
/** The carriageway is ONE continuous carved strip (src/world/road-carve.js RUT_DEPTH /
 *  CROWN / EDGE_BREAK), never a lattice of 1 m block plates. The tile layer is a detail
 *  layer only: it exists past the shoulder edge, where it breaks the verge line up with
 *  dirt, pebbles and small stones. Standing plates on the lane is what read as paving
 *  slabs with black gaps, so the carriageway band is skipped outright. */
export const TILE_ON_CARRIAGEWAY = false;
export const FLAG_PEBBLE = 0x80, FLAG_RUT = 0x40, FLAG_CROWN = 0x20, SURF_MASK = 0x1f;
export const TILE_CAP_CHUNK = 192;
/** Surface ids the renderer owns a block node for (streaming.js BLOCK_NODE). Listed here
 *  so the offline baker (tools/bake-map.mjs) can bake the same table node-side; a test
 *  (src/debug/tests.js) proves this list and BLOCK_NODE never drift apart. */
export const TILE_SURFACE_IDS = [SURF.ASPHALT, SURF.GRAVEL, SURF.DIRT, SURF.MUD, SURF.GRASS,
  SURF.STONE, SURF.SAND, SURF.PEAT, SURF.SNOW, SURF.ICE];
export const TILE_RING_STRIDE = [1, 2];      // per-ring column stride, mirrors TILE_STRIDE
export const TILE_RING_CAP = [192, 96];

/**
 * Which columns of one chunk get a tile: the carriageway band plus VERGE beyond it.
 * `surfaces` is the set of surface ids the renderer can actually draw a block for
 * (streaming.js owns that mapping, it is passed in to keep this module renderer-free).
 * Returns a Uint8Array(COLS) of surface id | flag bits, with `.tiles` = count.
 */
export function chunkTiles(world, road, surfaces, cx, cz, stride = 1, cap = TILE_CAP_CHUNK) {
    // Data only: no dependency on the block glb, so pre-generation (boot or the
    // offline cache) can build these tables before stage_blocks.glb has resolved.
    const chunk = world.chunkAt(cx, cz);
    if (!chunk) return null;
    const t = new Uint8Array(COLS);
    t.tiles = 0;
    const x0 = cx * CHUNK, z0 = cz * CHUNK;
    const cand = [];
    for (let c = 0; c < COLS; c++) {
      // Mid distance keeps the same blocks on a sparser grid: 1/9 of the instances of
      // the near ring, so the ramp costs almost nothing but hides the cut-off.
      if (stride > 1 && ((c & (CHUNK - 1)) % stride || (c >> 4) % stride)) continue;
      const wx = x0 + (c & (CHUNK - 1)) + 0.5, wz = z0 + (c >> 4) + 0.5;
      const i = road.nearest(wx, wz);
      const lat = Math.abs((wx - road.x[i]) * road.nx[i] + (wz - road.z[i]) * road.nz[i]);
      const hw = road.width[i] / 2;
      const verge = VERGE * (0.5 + hash01(Math.round(wx), Math.round(wz), VERGE_SALT));
      if (lat > hw + SHOULDER + verge) continue;
      const sid = chunk.surface[c];                        // the id physics already has
      if (!sid || !surfaces.includes(sid)) continue;
      // Detail layer only: the lane and the shoulder get no plate at all.
      if (!TILE_ON_CARRIAGEWAY && lat <= hw + SHOULDER) continue;
      let flags = 0;
      if (lat > hw + SHOULDER * 0.4) {
        // Verge: bare dirt shows between the plates, and the dropout deepens outwards so
        // nothing sits far up the bank where it reads as paving. Grass survives only in
        // the inner half of the verge band; the outer half drops over half its columns.
        const outer = lat > hw + SHOULDER + verge * 0.5;
        if (outer && sid === SURF.GRASS) continue;
        if (hash01(c + cx * 17, cz * 31 + cx, BARE_SALT) < (outer ? 0.55 : 0.22)) continue;
      } else if (lat > hw - 0.55) {
        if (hash01(c + cx * 13, cz * 29 + cx, VERGE_SALT) < PEBBLE_CHANCE) flags = FLAG_PEBBLE;
      } else if (Math.abs(lat - hw * 0.55) < hw * 0.22) {
        flags = FLAG_RUT;                                  // same band the carve wears dark
      } else if (lat < hw * 0.30) {
        flags = FLAG_CROWN;
      }
      cand.push([c, sid | flags, lat]);
    }
    // The cap is fixed, so spend it from the carriageway outwards: stopping at the
    // first 192 columns left raw unbanded strips in the middle of the corridor.
    cand.sort((a, b) => a[2] - b[2]);
    let n = 0;
    for (const [c, sid] of cand) {
      if (n >= cap) break;
      t[c] = sid;
      n++;
    }
    t.tiles = n;                                           // count kept on the same array
    return t;
}
