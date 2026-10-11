// Chunk streaming + LOD rings + prop instancing (docs/03 §1, docs/06 streaming.js).
// Rings: full 0-110 m, simplified 110-200 m, silhouette 200-260 m.
// Remeshing is budgeted per frame so a fast drive never hitches.
import * as THREE from 'three';
import { CHUNK, COLS, chunkKey, keyToCx, keyToCz } from './chunk.js';
import { meshChunk, LOD_CELL } from './mesher.js';
import { carveChunk, SHOULDER } from './road-carve.js';
import { SURF } from './surfaces.js';
import { PALETTE } from './palette.js';
import { GeoBuilder } from '../render/primitives.js';
import { generateChunkProps, buildTreeGeometries, buildGateGeometry, buildSpriteGeometries, buildBillboardGeometries, buildFoliageTextures, buildSpriteMaterials, SPRITE_PROPS, PROP, PROP_NAMES, NEAR_LOD_TRIS, buildNearLodGeometries } from './props.js';
import { settings, QUALITY } from '../core/settings.js';
import { loadModelNodes } from '../render/assets.js';

// Species -> glb node name (assets/models/props.glb, tools/blender/build_stage_props.py).
// A species with no entry, or a node the glb does not have, keeps its procedural geo.
const ASSET_NODES = {
  [PROP.PINE]: 'prop_tree_pine',
  [PROP.OAK]: 'prop_tree_deciduous',
  [PROP.DEAD]: 'prop_tree_dead',
  [PROP.BUSH]: 'prop_bush',
  [PROP.SPECTATOR]: 'prop_spectator',
  [PROP.MARSHAL]: 'prop_marshal_post',
  [PROP.BIRCH]: 'prop_tree_birch',
  [PROP.POST]: 'prop_fence_post',
  [PROP.GATE]: 'prop_gate_checkpoint',
};

// Start-line furniture (tools/blender/build_stage_props.py): glb node -> instance cap.
const START_NODES = {
  prop_start_gantry: 1, prop_banner_arch: 1, prop_marshal_tent: 2, prop_spectator_fence: 30,
};

const CAPACITY = {
  [PROP.OAK]: 1400, [PROP.PINE]: 1400, [PROP.DEAD]: 700,
  [PROP.SPECTATOR]: 1000, [PROP.POST]: 900, [PROP.MARSHAL]: 40, [PROP.GATE]: 24,
  [PROP.BIRCH]: 900, [PROP.BUSH]: 1400, [PROP.FERN]: 1600,
};

// ---- block tile layer (visual only) ---------------------------------------
// The carve already writes a surface id into every corridor column
// (chunk.surface[c], read by physics). This layer instances the matching node of
// assets/models/stage_blocks.glb over that same column, top face laid on the
// column's own carved top, so the carriageway reads as asphalt/dirt blocks and the
// verge as gravel/grass blocks. Heightfield, `fine`/`rut` and physics are untouched.
const BLOCK_NODE = {
  [SURF.ASPHALT]: 'block_asphalt',
  [SURF.GRAVEL]: 'block_gravel',
  [SURF.DIRT]: 'block_dirt',
  [SURF.MUD]: 'block_mud',
  [SURF.GRASS]: 'block_grass',
  [SURF.STONE]: 'block_stone',
  [SURF.SAND]: 'block_sand',
  [SURF.PEAT]: 'block_peat',
  [SURF.SNOW]: 'block_snow',
  [SURF.ICE]: 'block_ice',
};
const BLOCK_SURFACES = Object.keys(BLOCK_NODE).map(Number);
// Hard caps: 192 tiles per chunk (a 16x16 chunk crossed by an 18 m corridor cannot
// carry more, and the cap makes the instance budget fixed), one InstancedMesh per
// surface type with a fixed capacity allocated once at boot. No allocation per frame.
const TILE_CAP_CHUNK = 192;
const TILE_CAPACITY = 4096;
const VERGE = 2.4;                 // m past carriageway+shoulder that still counts
const TILE_LIFT = 0.02;            // hairline gap so a tile never z-fights the terrain
// Distance ramp, not a hard cut. TILE_RING_MAX = 0 gave a visible wall where the block
// detail simply stopped at ~110 m. Ring 0 keeps one block per corridor column (full
// detail on the road you are driving on), ring 1 gets every 3rd column - a coarser,
// cheaper band that still reads as a banded carriageway at mid distance - and ring 2+
// gets nothing. Instance count therefore stays bounded by the resident chunk count:
// ring 0 ~9 chunks x <=192, ring 1 ~16 chunks x <=72, i.e. a plateau, not growth.
const TILE_STRIDE = [1, 2];        // index = ring; absent entry = no tiles on that ring
const TILE_CAP_RING = [192, 96];   // per-chunk instance cap on that ring
// Distance + frustum culling for the tiles (perf run: 6.3 M tris/frame at LOW).
// A tile beyond TILE_FAR, or outside the camera frustum, is never instanced.
const TILE_FAR = [130, 130, 0, 0];  // index = ring
// Band switch points. The outer bands are 8 m and 16 m cell silhouettes, so growing the
// radius costs triangles linearly in area at a fixed, tiny per-chunk price - it is the
// near/mid bands that carry the frame, and those radii are unchanged.
const bandRadius = (f) => settings.simpleRadius + (settings.drawDistance - settings.simpleRadius) * f;
// ring 2 (4 m) -> ring 3 (8 m silhouette) switch point
export const farRingRadius = () => bandRadius(0.28);
// ring 3 (8 m) -> ring 4 (16 m distant hill band) switch point; with FAR DETAIL off the
// 8 m band simply runs out to the draw distance and the 16 m hill band is never built.
export const hillFarRadius = () => (settings.farDetail ? bandRadius(0.62) : settings.drawDistance);
const TILE_FAR_ABS = 150;          // m from the car, hard cut regardless of ring
const TILE_FAR_ABS_LOW = 90;       // LOW: the tiles are 0.18 m slabs, they read to ~90 m
// A baked block-tile node above this triangle count is replaced by a shared unit box:
// the layer is 1 334 instances, so the per-tile budget is what the whole frame is made
// of (measured: 4.29 M of the 4.53 M triangles at LOW came from these slabs).
const TILE_MAX_TRIS = 96;
const SPRITE_SET = new Set(SPRITE_PROPS);   // species drawn as sprites at the far bands

/** Triangles of a geometry, indexed or not. */
function geoTris(geo) {
  if (!geo) return 0;
  if (geo.index) return geo.index.count / 3;
  const p = geo.attributes && geo.attributes.position;
  return p ? p.count / 3 : 0;
}

/** Upload only the used prefix of an instance buffer, not the whole capacity.
 *  Accepts the InstancedMesh (-> its instanceMatrix) or a raw BufferAttribute, so the
 *  colour channel can be paid for at 3 floats/instance instead of 16. */
function upload(target, n, itemSize = 16) {
  const a = target && target.isInstancedMesh ? target.instanceMatrix : target;
  if (!a) return;
  if (a.clearUpdateRange && a.addUpdateRange) { a.clearUpdateRange(); a.addUpdateRange(0, Math.max(1, n) * itemSize); }
  a.needsUpdate = true;
}

export class Streaming {
  constructor(world, terrain, road, carveIndex, renderer, stage) {
    this.world = world; this.terrain = terrain; this.road = road;
    this.carveIndex = carveIndex; this.renderer = renderer; this.stage = stage;

    this.records = new Map();          // key -> { cx, cz, lod, mesh, props }
    this.propMeshes = new Map();
    this.propGeos = buildTreeGeometries(GeoBuilder, THREE);
    this.propGeos[PROP.GATE] = buildGateGeometry(GeoBuilder, THREE);
    // Vegetation is a sprite: crossed alpha quads with a procedurally painted foliage
    // texture (PLAN §10.2), one InstancedMesh + one Lambert material per species.
    this.spriteGeos = buildSpriteGeometries(THREE);
    this.billGeos = buildBillboardGeometries(THREE);
    this.spriteMats = buildSpriteMaterials(THREE, buildFoliageTextures(THREE));

    for (const p of [PROP.OAK, PROP.PINE, PROP.DEAD, PROP.SPECTATOR, PROP.POST, PROP.MARSHAL, PROP.GATE,
      PROP.BIRCH, PROP.BUSH, PROP.FERN]) {
      const sprite = this.spriteMats && this.spriteMats[p];
      const im = new THREE.InstancedMesh(sprite ? this.spriteGeos[p] : this.propGeos[p],
        sprite || renderer.propMaterial, CAPACITY[p]);
      im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      im.castShadow = true;
      im.receiveShadow = true;
      im.count = 0;
      im.frustumCulled = false;
      renderer.scene.add(im);
      this.propMeshes.set(p, im);
    }

    // ---- prop distance LOD (perf: the glb tree nodes are ~600 tris each, and
    // 1 400 of them per species is what put millions of triangles in one frame).
    // Near band: the baked glb/voxel geo. Mid band: the crossed alpha-quad sprite.
    // Far band: ONE camera-facing billboard quad. Beyond farR: nothing.
    // One InstancedMesh per species per band => at most one draw call per species per
    // LOD level, and a band with no visible instance is switched off (count 0 +
    // visible false), so the whole batch leaves the draw-call list.
    this.midMeshes = new Map();
    this.billMeshes = new Map();
    for (const p of SPRITE_PROPS) {
      const mat = this.spriteMats && this.spriteMats[p];
      if (!mat || !this.spriteGeos[p] || !this.billGeos[p]) continue;
      const mid = new THREE.InstancedMesh(this.spriteGeos[p], mat, CAPACITY[p]);
      const bill = new THREE.InstancedMesh(this.billGeos[p], mat, CAPACITY[p]);
      for (const im of [mid, bill]) {
        im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        im.castShadow = false; im.receiveShadow = false;
        im.count = 0; im.frustumCulled = false;   // instance culling is done by hand
        // Per-instance distance fade (ramp toward the horizon) instead of a hard pop:
        // instanceColor costs one extra attribute, no extra material, no extra pass.
        im.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(CAPACITY[p] * 3), 3);
        im.instanceColor.setUsage(THREE.DynamicDrawUsage);
        renderer.scene.add(im);
      }
      this.midMeshes.set(p, mid);
      this.billMeshes.set(p, bill);
    }
    this._frustum = new THREE.Frustum();
    this._projScreen = new THREE.Matrix4();
    this._sphere = new THREE.Sphere();

    // Asset-backed props: swap container geometry/material once the glb resolves.
    // Instancing, CAPACITY and the placement code below are untouched; a missing
    // glb or a missing node leaves the procedural container in place.
    this.assetsApplied = false;
    loadModelNodes('props').then((nodes) => { this._adoptAssetProps(nodes); });

    // Block tiles: one InstancedMesh per surface type, allocated once, never per frame.
    // A missing glb or a missing node leaves this.map empty and the layer does nothing.
    this.blockMeshes = new Map();     // surface id -> InstancedMesh
    this.blockOff = new Map();        // surface id -> {x,y,z} fit offset of the node geo
    this._tileCount = new Map();      // scratch counters, reused every rebuild
    this.blockActive = false;
    this._tilesOn = false;
    if (settings.blockTiles) loadModelNodes('stage_blocks').then((nodes) => this._adoptBlockTiles(nodes));

    this._mat4 = new THREE.Matrix4();
    this._quat = new THREE.Quaternion();
    this._scale = new THREE.Vector3();
    this._pos = new THREE.Vector3();
    this._euler = new THREE.Euler();
    this._col = new THREE.Color();

    this.stats = { chunks: 0, tris: 0, remeshes: 0, props: 0, generated: 0, carved: 0, tiles: 0 };
    this.stats.breakdown = { terrain: 0, treesNear: 0, treesFar: 0, propsNear: 0, propsFar: 0, tiles: 0, other: 0 };
    this.stats.species = {};
    this._lastInst = 0;              // 4 Hz gate on the instance rebuild/upload
    this._lastCx = null; this._lastCz = null; this._lastCount = -1; this._lastCamQ = null;
    this._gatesPlaced = false;
    // Start-line furniture: one InstancedMesh per extra props.glb node, allocated once.
    this.startMeshes = new Map();
    this._startPlaced = false;
  }

  /** Swap a species container's procedural geo for the baked glb node geo. */
  _adoptAssetProps(nodes) {
    if (!nodes || !nodes.size || this.assetsApplied) return false;
    const cheaper = [];
    for (const [type, im] of this.propMeshes) {
      const name = ASSET_NODES[type];
      if (!name) continue;
      const rec = nodes.get(name);
      if (!rec || !rec.geometry) continue;                 // node absent -> keep procedural
      const mat = rec.material;
      if (mat && !Array.isArray(mat) && mat.vertexColors && !rec.geometry.getAttribute('color')) {
        mat.vertexColors = false;                          // nothing to feed USE_COLOR
      }
      // Near LOD budget (props.js): the near band is the one band where a driver
      // resolves a trunk, and it paid 444-528 triangles per tree ~470 times a frame
      // (230 k of the ~309 k triangles of a MED frame). Over budget, the near instance
      // gets the half-block build instead: same envelope, so the silhouette stays.
      const nodeTris = geoTris(rec.geometry);
      const budget = NEAR_LOD_TRIS[type];
      const lod = budget ? (this.nearLodGeos || (this.nearLodGeos = buildNearLodGeometries(GeoBuilder, THREE)))[type] : null;
      if (budget && lod && nodeTris > budget && geoTris(lod) <= budget) {
        im.geometry = lod;
        im.material = this.renderer.propMaterial;
        cheaper.push(`${PROP_NAMES[type]} ${nodeTris}->${geoTris(lod)}`);
      } else {
        im.geometry = rec.geometry;
        if (mat) im.material = mat;
      }
    }
    if (cheaper.length) console.log(`[props] near LOD tris/instance ${cheaper.join(' ')}`);
    this._buildStartProps(nodes);
    this.assetsApplied = true;
    return true;
  }

  /**
   * Adopt the stage_blocks.glb nodes: one InstancedMesh per surface id the carve can
   * assign. The node slab is fitted so its TOP face lands on the instance origin
   * (origin + (0,0,0) == top of the block) and its centre is on the column centre,
   * whatever corner the exported geometry was built around. Silent on any absence.
   */
  _adoptBlockTiles(nodes) {
    if (!settings.blockTiles) {
      console.log('[blocks] block tile layer: off (settings.blockTiles = false)');
      return false;
    }
    for (const sid of BLOCK_SURFACES) {
      const rec = nodes && nodes.size ? nodes.get(BLOCK_NODE[sid]) : null;
      if (!rec || !rec.geometry) continue;                 // node absent -> no tiles
      const geo = rec.geometry;
      if (!geo.boundingBox) geo.computeBoundingBox();
      const bb = geo.boundingBox;
      if (!bb || !isFinite(bb.min.x) || !isFinite(bb.max.y)) continue;
      // A baked paver node costs a few thousand triangles. A block tile is a slab: at
      // the ~130 m this layer reaches, the bevel is invisible and the slab is 3000x the
      // cost of the whole forest, so the geometry is swapped for one shared unit box
      // fitted to the node bounding box (same material, same footprint, same top face).
      const h = Math.max(0.02, bb.max.y - bb.min.y);
      const useBox = geoTris(geo) > TILE_MAX_TRIS;
      const drawGeo = useBox ? (this._tileBox || (this._tileBox = new THREE.BoxGeometry(1, 1, 1))) : geo;
      this.blockOff.set(sid, {
        x: -0.5 * (bb.min.x + bb.max.x),
        y: useBox ? -h * 0.5 : -bb.max.y,
        z: -0.5 * (bb.min.z + bb.max.z),
        w: Math.min(1.4, Math.max(0.6, bb.max.x - bb.min.x)),
        d: Math.min(1.4, Math.max(0.6, bb.max.z - bb.min.z)),
        h: useBox ? h : 1,
      });
      const srcMat = rec.material || this.renderer.propMaterial;
      const mat = srcMat.clone();
      mat.vertexColors = false;
      // The baked slabs carry their own vertex colours from an older, wider palette.
      // Repaint every surface with its palette base tone so the tile layer and the
      // terrain it stands on are one continuous surface tone (FAULT 1): where a tile is
      // culled or capped out, the block underneath is the same colour, not a dark one.
      const pal = PALETTE.find((p) => p.surface === sid);
      // setHex, not setRGB: the loader keeps materials in working (linear) space, and
      // the flat palette value read as cream against the darker terrain next to it.
      if (pal) mat.color.setHex(pal.color);
      if (mat.vertexColors && !geo.getAttribute('color')) mat.vertexColors = false;
      const im = new THREE.InstancedMesh(drawGeo, mat, TILE_CAPACITY);
      im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      // Per-tile tint channel: the tile must carry the *same* rut/crown band as the
      // terrain it stands on, otherwise a slab of one flat colour sits over the banded
      // carriageway and the road reads as a patchwork again.
      im.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(TILE_CAPACITY * 3), 3);
      im.instanceColor.setUsage(THREE.DynamicDrawUsage);
      im.castShadow = false;                                // a 0.18 m slab: no own shadow
      im.receiveShadow = true;
      im.count = 0;
      im.visible = false;
      im.frustumCulled = false;
      this.renderer.scene.add(im);
      this.blockMeshes.set(sid, im);
      this._tileCount.set(sid, 0);
    }
    this.blockActive = this.blockMeshes.size > 0;
    console.log(`[blocks] block tile layer: ${this.blockActive ? `active (${this.blockMeshes.size} surfaces, ${TILE_CAP_CHUNK} tiles/chunk)` : 'inactive (stage_blocks.glb or its block_* nodes missing)'}`);
    if (this.blockActive) {
      // Chunks streamed before the glb resolved carry empty tile tables: drop them so
      // the next update fills them.
      for (const rec of this.records.values()) rec.tiles = null;
      this._lastCx = null; this._lastCount = -1; this._lastCamQ = null;   // force one rebuild now
    }
    return this.blockActive;
  }

  /** Which columns of one chunk get a tile: the carriageway band plus VERGE beyond it. */
  _chunkTiles(cx, cz, stride = 1, cap = TILE_CAP_CHUNK) {
    // Data only: no dependency on the block glb, so pre-generation (boot or the
    // offline cache) can build these tables before stage_blocks.glb has resolved.
    const chunk = this.world.chunkAt(cx, cz);
    if (!chunk) return null;
    const t = new Uint8Array(COLS);
    t.tiles = 0;
    const x0 = cx * CHUNK, z0 = cz * CHUNK;
    const road = this.road;
    const cand = [];
    for (let c = 0; c < COLS; c++) {
      // Mid distance keeps the same blocks on a sparser grid: 1/9 of the instances of
      // the near ring, so the ramp costs almost nothing but hides the cut-off.
      if (stride > 1 && ((c & (CHUNK - 1)) % stride || (c >> 4) % stride)) continue;
      const wx = x0 + (c & (CHUNK - 1)) + 0.5, wz = z0 + (c >> 4) + 0.5;
      const i = road.nearest(wx, wz);
      const lat = Math.abs((wx - road.x[i]) * road.nx[i] + (wz - road.z[i]) * road.nz[i]);
      if (lat > road.width[i] / 2 + SHOULDER + VERGE) continue;
      const sid = chunk.surface[c];                        // the id physics already has
      if (!sid || !BLOCK_SURFACES.includes(sid)) continue;
      cand.push([c, sid, lat]);
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

  /**
   * Ring-specific tile table for one chunk, cached on the stage. Pre-generation
   * (src/world/pregen.js) fills the same cache, so a chunk the car drives into costs
   * no world work at all - only mesh building below.
   */
  tileTable(cx, cz, ring) {
    const tables = this.stage.tileTables || (this.stage.tileTables = new Map());
    const key = chunkKey(cx, cz) * 4 + ring;
    let t = tables.get(key);
    if (t !== undefined) return t;
    const stride = TILE_STRIDE[ring];
    t = stride ? (this._chunkTiles(cx, cz, stride, TILE_CAP_RING[ring]) || null) : null;
    tables.set(key, t);
    return t;
  }

  /** Refill the instanced buffers from the streamed chunks. Allocation-free. */
  _rebuildTiles(focus) {
    const on = settings.blockTiles && this.blockActive;
    for (const [sid, im] of this.blockMeshes) { this._tileCount.set(sid, 0); im.count = 0; }
    if (on) {
      const low = settings.quality === QUALITY.LOW;
      const farAbs = low ? TILE_FAR_ABS_LOW : TILE_FAR_ABS;
      for (const rec of this.records.values()) {
        const t = rec.tiles;
        if (!t || !t.tiles) continue;
        const chunk = this.world.chunkAt(rec.cx, rec.cz);
        if (!chunk) continue;
        const ring = rec.lod >= 0 ? rec.lod : 0;
        const far = Math.min(farAbs, TILE_FAR[ring] || farAbs);
        const x0 = rec.cx * CHUNK, z0 = rec.cz * CHUNK;
        for (let c = 0, seen = 0; c < COLS && seen < t.tiles; c++) {
          const sid = t[c];
          if (!sid) continue;
          seen++;
          const im = this.blockMeshes.get(sid);
          const off = this.blockOff.get(sid);
          if (!im || !off) continue;
          const used = this._tileCount.get(sid);
          if (used >= TILE_CAPACITY) continue;
          const y = chunk.columnTop(c);                    // tile stands on the real ground
          if (y < 0) continue;
          const wx = x0 + (c & (CHUNK - 1)) + 0.5, wz = z0 + (c >> 4) + 0.5;
          // distance + frustum cull: a tile the car will never reach, or that is
          // behind / beside the camera, costs nothing.
          if (focus && Math.hypot(wx - focus.x, wz - focus.z) > far) continue;
          if (focus) {
            this._sphere.center.set(wx, y + 0.3, wz);
            this._sphere.radius = 1.6;
            if (!this._frustum.intersectsSphere(this._sphere)) continue;
          }
          this._pos.set(wx + off.x, y + TILE_LIFT + off.y, wz + off.z);
          this._quat.identity();
          this._scale.set(off.w, off.h, off.d);
          this._mat4.compose(this._pos, this._quat, this._scale);
          im.setMatrixAt(used, this._mat4);
          // Tone agreement with the ground under the tile: chunk.wear is the very band
          // the mesher packs into aSurface, so a tile over a wheel rut is as dark as the
          // rut and one over the crown / outer edge as light as that band.
          const tc = this._tileCol || (this._tileCol = new THREE.Color());
          const w01 = (chunk.wear ? chunk.wear[c] : 0) / 255;
          const tint = 0.94 + 0.12 * w01;
          im.setColorAt(used, tc.setRGB(tint, tint, tint));
          this._tileCount.set(sid, used + 1);
        }
      }
    }
    let total = 0;
    for (const [sid, im] of this.blockMeshes) {
      const n = this._tileCount.get(sid) || 0;
      im.count = n;
      im.visible = n > 0;
      upload(im, n);
      if (im.instanceColor) upload(im.instanceColor, n, 3);
      total += n;
    }
    this._tilesOn = on;
    this.stats.tiles = total;
  }

  _ring(dist) {
    if (dist <= settings.fullRadius) return 0;
    if (dist <= settings.simpleRadius) return 1;
    // Ring 2 (lod 2, 4 m cells) was the largest single cost left: the outer silhouette
    // band is ~1.5 M of the ~4.7 M triangles for ground the camera never reads closer
    // than 200 m. The outer half of that band now gets lod 3 (8 m cells) - 4x fewer
    // cells per chunk - which flattens the far-field triangle growth.
    if (dist <= farRingRadius()) return 2;
    if (dist <= hillFarRadius()) return 3;
    // Ring 4: the 16 m distant hill band. It exists only while FAR DETAIL is on, and it
    // is what puts a ridge on the horizon instead of sky at 700-1600 m.
    if (dist <= settings.drawDistance && settings.farDetail) return 4;
    return -1;
  }

  update(focus, budgetMs = 6) {
    const t0 = performance.now();
    const R = settings.drawDistance;
    const cxFocus = Math.floor(focus.x / CHUNK), czFocus = Math.floor(focus.z / CHUNK);
    const span = Math.ceil(R / CHUNK) + 1;

    // 1) drop far chunks
    for (const [key, rec] of this.records) {
      const dx = (rec.cx - cxFocus) * CHUNK, dz = (rec.cz - czFocus) * CHUNK;
      const d = Math.hypot(dx, dz);
      if (d > R + CHUNK * 2) {
        if (rec.mesh) { this.renderer.scene.remove(rec.mesh); rec.mesh.geometry.dispose(); }
        this.records.delete(key);
        if (this.stage.preGen) {
          // Pre-generated stage: the chunk data is the point of the pre-generation, so
          // only the render geometry above is destroyed. `generated` stays 0 while
          // driving because nothing has to be regenerated on the way past.
          this.stats.kept = (this.stats.kept || 0) + 1;
        } else {
          // The voxel columns go the same way as their mesh: generation + carve are
          // deterministic in (cx,cz,seed), so keeping them forever only grew the Map
          // (~16 KB of column arrays per chunk, 293 chunks in 30 s of driving).
          this.world.dropChunk(rec.cx, rec.cz);
          if (this.stage.tileTables) {
            this.stage.tileTables.delete(key * 4);
            this.stage.tileTables.delete(key * 4 + 1);
          }
        }
      }
    }

    // 2) collect work. The job list and its records are pooled: this ran ~60 times a
    // second and allocated a fresh array plus one object per candidate chunk (up to
    // ~120 objects/frame) every time.
    const jobs = this._jobs || (this._jobs = []);
    const pool = this._jobPool || (this._jobPool = []);
    jobs.length = 0;
    for (let dz = -span; dz <= span; dz++) {
      for (let dx = -span; dx <= span; dx++) {
        const cx = cxFocus + dx, cz = czFocus + dz;
        const centerX = cx * CHUNK + CHUNK / 2, centerZ = cz * CHUNK + CHUNK / 2;
        const dist = Math.hypot(centerX - focus.x, centerZ - focus.z);
        if (dist > R) continue;
        const ring = this._ring(dist);
        if (ring < 0) continue;
        let job = pool[jobs.length];
        if (!job) job = pool[jobs.length] = { cx: 0, cz: 0, ring: 0, dist: 0 };
        job.cx = cx; job.cz = cz; job.ring = ring; job.dist = dist;
        jobs.push(job);
      }
    }
    jobs.sort((a, b) => a.dist - b.dist);

    // 3) generate / carve / mesh with a per-frame budget
    let remeshes = 0;
    for (const job of jobs) {
      if (performance.now() - t0 > budgetMs) break;
      const key = chunkKey(job.cx, job.cz);
      let rec = this.records.get(key);
      if (!rec) {
        rec = { cx: job.cx, cz: job.cz, lod: -1, mesh: null, props: null };
        this.records.set(key, rec);
      }
      const chunk = this.world.chunkAt(job.cx, job.cz);
      if (!chunk) { this.terrain.generateChunk(this.world, job.cx, job.cz); this.stats.generated++; }
      const c = this.world.chunkAt(job.cx, job.cz);
      if (!c.generated) { this.terrain.generateChunk(this.world, job.cx, job.cz); this.stats.generated++; }
      if (!c.carved) { carveChunk(this.world, job.cx, job.cz, this.road, this.carveIndex, this.terrain); c.carved = true; this.stats.carved++; }

      if (rec.lod !== job.ring || c.dirty) {
        // The tile table is ring-specific (stride + cap), so it is rebuilt with the
        // mesh. It used to be computed once per chunk and then kept forever, which
        // left full-detail tiles on chunks the car had driven away from.
        rec.tiles = null;
        if (rec.mesh) { this.renderer.scene.remove(rec.mesh); rec.mesh.geometry.dispose(); rec.mesh = null; }
        const data = meshChunk(this.world, c, job.ring);
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.Float32BufferAttribute(data.position, 3));
        g.setAttribute('normal', new THREE.Float32BufferAttribute(data.normal, 3));
        g.setAttribute('color', new THREE.Float32BufferAttribute(data.color, 3));
        g.setAttribute('aSurface', new THREE.Float32BufferAttribute(data.surface, 1));
        g.setIndex(new THREE.BufferAttribute(data.index, 1));
        g.computeBoundingSphere();
        const mesh = new THREE.Mesh(g, this.renderer.terrainMaterial);
        mesh.castShadow = job.ring === 0;
        mesh.receiveShadow = true;
        mesh.matrixAutoUpdate = false;
        this.renderer.scene.add(mesh);
        rec.mesh = mesh;
        rec.lod = job.ring;
        c.dirty = false;
        c.lod = job.ring;
        remeshes++;
      }
      if (!rec.props) {
        // Pre-generated prop list when the stage has one; the runtime scatter stays as
        // the fallback for anything outside the pre-generated set (cache mismatch).
        const pre = this.stage.propTables && this.stage.propTables.get(key);
        rec.props = pre !== undefined ? pre : generateChunkProps(job.cx, job.cz, this.stage);
      }
      if (!rec.tiles) rec.tiles = this.tileTable(job.cx, job.cz, job.ring);
    }
    this.stats.remeshes = remeshes;

    // 4) gates (few, but instanced so they cost one draw call)
    if (!this._gatesPlaced) { this._placeGates(); this._gatesPlaced = true; }
    if (!this._startPlaced) this._placeStartProps();

    // 5) rebuild prop instances when the visible chunk set changed. Numeric key:
    // the template string this used to build cost an allocation on every frame.
    // Throttled to 4 Hz: while the car is moving the trigger above is true on
    // *every* frame, and each rebuild re-uploads the full instance buffers of 9
    // tile meshes (4096 x 64 B each) plus 9 prop meshes - ~3 MB of bufferSubData
    // per frame, growing with the resident chunk count. A quarter-second of
    // latency on a far-ring pop-in is free; the upload at frame rate is not.
    const nowMs = performance.now();
    // The instance set now also depends on where the camera LOOKS (frustum cull),
    // so a 15 deg turn has to re-collect it, not just a change of chunk.
    const cam = this.renderer.camera;
    cam.updateMatrixWorld();
    const camQ = Math.round(Math.atan2(cam.matrixWorld.elements[8], cam.matrixWorld.elements[10]) / (Math.PI / 12));
    if ((cxFocus !== this._lastCx || czFocus !== this._lastCz || camQ !== this._lastCamQ ||
        this.records.size !== this._lastCount ||
        this._tilesOn !== (settings.blockTiles && this.blockActive)) &&
        nowMs - this._lastInst >= 150) {
      this._lastInst = nowMs;
      this._lastCx = cxFocus; this._lastCz = czFocus; this._lastCount = this.records.size; this._lastCamQ = camQ;
      this._rebuildProps(focus);
      this._rebuildTiles(focus);
    }

    let tris = 0;
    for (const rec of this.records.values()) if (rec.mesh) tris += rec.mesh.geometry.index.count / 3;
    this.stats.chunks = this.records.size;
    this.stats.tris = tris;
    this._breakdown();
    return performance.now() - t0;
  }

  /**
   * Per-category triangle + instance cost, the `bd=` / `sp=` columns the perf harness
   * prints (?perftest=1). One pass over the ~25 instanced meshes the layer owns, so it
   * is cheaper than the chunk loop above and runs on every update. The point is to be
   * able to say which layer eats the frame: vegetation, ground, block tiles, gates and
   * start furniture, or the car (counted by the harness, not here).
   */
  _breakdown() {
    const bd = this.stats.breakdown || (this.stats.breakdown = {
      terrain: 0, treesNear: 0, treesFar: 0, propsNear: 0, propsFar: 0, tiles: 0, other: 0,
    });
    const sp = this.stats.species || (this.stats.species = {});
    for (const k of Object.keys(sp)) sp[k] = null;
    bd.terrain = this.stats.tris;
    bd.treesNear = bd.treesFar = bd.propsNear = bd.propsFar = bd.tiles = bd.other = 0;
    for (const [type, im] of this.propMeshes) {
      const name = PROP_NAMES[type] || String(type);
      const t = geoTris(im.geometry) * im.count;
      const spriteFar = this.midMeshes.has(type);
      if (type === PROP.GATE) bd.other += t; else bd.propsNear += t;
      if (SPRITE_PROPS.includes(type)) { bd.treesNear += t; bd.propsNear -= t; }
      sp[name] = im.count;
      const fim = this.midMeshes.get(type);
      if (fim) {
        const ft = geoTris(fim.geometry) * fim.count;
        bd.propsFar += ft;
        if (SPRITE_PROPS.includes(type)) bd.treesFar += ft;
        sp[name] += fim.count;
      }
      const bim = this.billMeshes.get(type);
      if (bim) {
        const bt = geoTris(bim.geometry) * bim.count;
        bd.propsFar += bt;
        if (SPRITE_PROPS.includes(type)) bd.treesFar += bt;
        sp[name] += bim.count;
      }
    }
    for (const im of this.startMeshes.values()) bd.other += geoTris(im.geometry) * im.count;
    bd.tileUnit = 0;
    for (const im of this.blockMeshes.values()) {
      bd.tiles += geoTris(im.geometry) * im.count;
      bd.tileUnit = Math.max(bd.tileUnit, geoTris(im.geometry));
    }
  }

  _placeGates() {
    const gates = this.stage.gates || [];
    const list = [];
    for (const g of gates) {
      const i = g.index;
      this._mat4.compose(
        new THREE.Vector3(this.road.x[i], this.road.h[i], this.road.z[i]),
        new THREE.Quaternion().setFromEuler(new THREE.Euler(0, -Math.atan2(this.road.nz[i], this.road.nx[i]), 0)),
        new THREE.Vector3(1, 1, 1),
      );
      list.push(this._mat4.clone());
    }
    const im = this.propMeshes.get(PROP.GATE);
    for (let i = 0; i < list.length && i < CAPACITY[PROP.GATE]; i++) im.setMatrixAt(i, list[i]);
    im.count = Math.min(list.length, CAPACITY[PROP.GATE]);
    im.instanceMatrix.needsUpdate = true;
  }

  /** Start-line furniture: one InstancedMesh per glb node, allocated once. */
  _buildStartProps(nodes) {
    if (!nodes || !nodes.size) return false;
    let built = 0;
    for (const [name, cap] of Object.entries(START_NODES)) {
      const rec = nodes.get(name);
      if (!rec || !rec.geometry) continue;                 // node absent -> nothing placed
      const geo = rec.geometry;
      // A baked node can carry one material or one per primitive: clone whichever shape
      // the loader handed over, otherwise the whole start layer dies on .clone of an array.
      // Force the adopted materials opaque: a baked prop is a solid stack of closed boxes
      // and must have no alpha channel in the depth pass. It no longer has to be patched
      // single-sided too - props.glb and stage_blocks.glb now export with Blender backface
      // culling on, so every material arrives FrontSide from the file (the exporter writes
      // doubleSided = not use_backface_culling). The double-sided interior faces that used
      // to land on the same depth as the face in front of them - the banner board dithered
      // into a white/red checker - cannot come back without failing the export gate
      // (tools/blender/build_stage_props.py) or T27 in src/debug/tests.js.
      const opaque = (m) => {
        if (!m || !m.clone) return this.renderer.propMaterial;
        const c = m.clone();
        if (c.vertexColors && !geo.getAttribute('color')) c.vertexColors = false;
        c.transparent = false;
        c.opacity = 1;
        c.alphaTest = 0;
        return c;
      };
      let mat;
      if (Array.isArray(rec.material)) {
        mat = rec.material.map(opaque);
      } else if (rec.material && rec.material.clone) {
        mat = opaque(rec.material);
      } else {
        mat = this.renderer.propMaterial;
      }
      const im = new THREE.InstancedMesh(geo, mat, cap);
      im.castShadow = true;
      im.receiveShadow = true;
      im.count = 0;
      im.visible = false;
      im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      this.renderer.scene.add(im);
      this.startMeshes.set(name, im);
      built++;
    }
    if (built) this._startPlaced = false;      // the road may not be ready yet
    return built > 0;
  }

  /**
   * Put the start furniture where the opening frame reads as a rally start: gantry on
   * the line, banner arch 26 m down the lane, a marshal tent on each verge and a fence
   * line running along both sides. Runs once - the stage road never moves.
   */
  _placeStartProps() {
    if (!this.startMeshes.size) return false;
    const gates = this.stage.gates || [];
    const start = gates.find((g) => g.kind === 'start') || gates[0];
    if (!start) return false;
    this._startPlaced = true;
    const r = this.road, i = start.index;
    const nx = r.nx[i], nz = r.nz[i];
    const gx = r.x[i], gz = r.z[i], gy = r.h[i];
    // Down-lane direction straight off the spline: the tangent at the first node can
    // point either way, and an arch placed "26 m ahead" landed behind the camera.
    const j = Math.min(r.x.length - 1, i + 40);
    let tx = r.x[j] - gx, tz = r.z[j] - gz;
    const tl = Math.hypot(tx, tz) || 1;
    tx /= tl; tz /= tl;
    const half = r.width[i] / 2 + SHOULDER;
    const across = Math.atan2(-nz, nx);        // model +X -> road normal (as _gate)
    const along = Math.atan2(-tz, tx);         // model +X -> road tangent
    const put = (name, px, pz, yaw, s = 1) => {
      const im = this.startMeshes.get(name);
      if (!im || im.count >= im.instanceMatrix.count) return;
      const slot = im.count;
      this._pos.set(px, gy, pz);
      this._euler.set(0, yaw, 0);
      this._quat.setFromEuler(this._euler);
      this._scale.set(s, s, s);
      this._mat4.compose(this._pos, this._quat, this._scale);
      im.setMatrixAt(slot, this._mat4);
      im.count = slot + 1;
    };
    put('prop_start_gantry', gx, gz, across);
    put('prop_banner_arch', gx + tx * 34, gz + tz * 34, across);
    for (const s of [-1, 1]) {
      // Marshal huts sit clear of the fence line (fence centred at half + 1.4, 0.44 m
      // deep; hut half-span 1.7 m) with a 2 m apron, and their yaw puts the model +Z
      // face - the door, since export_yup maps Blender -Y to +Z - straight back at the
      // carriageway. The old 5.8 m marquee at half + 5.5 overlapped the tree line.
      put('prop_marshal_tent', gx + nx * (half + 4.0) * s + tx * 14,
        gz + nz * (half + 4.0) * s + tz * 14, Math.atan2(-nx * s, -nz * s));
      for (let k = 0; k < 14; k++) {
        const d = -14 + k * 4.1;
        put('prop_spectator_fence', gx + tx * d + nx * (half + 1.4) * s,
          gz + tz * d + nz * (half + 1.4) * s, along);
      }
    }
    for (const im of this.startMeshes.values()) {
      im.instanceMatrix.needsUpdate = true;
      im.visible = im.count > 0;
      if (!im.geometry.boundingSphere) im.geometry.computeBoundingSphere();
    }
    console.log(`[start] ${[...this.startMeshes.entries()].map(([n, im]) => `${n}=${im.count}`).join(' ')} at ${gx.toFixed(0)},${gz.toFixed(0)} yaw ${across.toFixed(2)}`);
    return true;
  }

  /**
   * Bound the prop load instead of letting it grow with the drive:
   *  - three LOD bands (baked geometry near, crossed alpha quads mid, ONE camera-facing
   *    billboard quad far, nothing beyond farR) -> at most one instanced draw call per
   *    species per band, all of them on one shared foliage atlas and one material;
   *  - camera-frustum culling per instance, and a band with zero surviving instances is
   *    switched off, so a species the camera cannot see costs no draw call at all;
   *  - a fixed per-species instance budget spent by DISTANCE PRIORITY (nearest first),
   *    so a full stand truncates the far edge of the forest, never random trees;
   *  - a per-instance colour ramp past midR, so the forest fades into the haze instead
   *    of popping out at farR.
   * Called at <=6.7 Hz, allocation-free: the buckets, the arrays and both instance
   * buffers are reused, and each buffer is uploaded once per rebuild (not per frame).
   */
  _rebuildProps(focus) {
    const q = settings.quality;
    const low = q === QUALITY.LOW, high = q === QUALITY.HIGH;
    // Band radii. LOW keeps the baked voxel/glb tree only within 18 m of the car, which
    // is where a viewer can actually read a trunk; past that the sprite/quad carries it.
    // (Measured at MEDIUM: the old 45 m near band put 230 k of the 309 k frame
    // triangles into trees that were too far away to read anything.)
    const nearR = low ? 18 : (high ? 34 : 24);
    const midR = low ? 62 : (high ? 140 : 104);
    // Far band: ONE camera-facing billboard quad = 2 triangles per tree, so the radius
    // is the cheap axis and the INSTANCE CAP is what bounds the cost (the old 135 m far
    // ring faded the forest out inside a short radius: the drive read as a clearing).
    // `settings.vegFarDistance` is the knob; drawDistance clamps it, because a prop only
    // exists in a chunk that was actually streamed in, and FAR DETAIL off pulls the band
    // back hard - that is the frame-rate half of the row.
    const vegFar = Math.max(240, Math.min(1200, settings.vegFarDistance || 620));
    const farR = Math.min(settings.farDetail
      ? (low ? vegFar : (high ? vegFar + 200 : vegFar + 80))
      : vegFar * 0.55, settings.drawDistance);
    // Posts and spectators have no sprite/billboard variant (they are too small to
    // billboard) but they are ~100 tris each, so they keep a longer single band: corner
    // markers have to be readable early or the corner reads as empty air.
    // Absolute per-species instance budgets (the CAPACITY arrays are allocated once).
    const nearCapMul = low ? 0.22 : (high ? 0.45 : 0.3);
    // The two alpha-quad bands are capped instead of open-ended: widening midR/farR adds
    // instances, the caps decide how many of them survive, and the cap spend is already
    // distance-prioritised, so a cut always drops the far edge of a species, not a
    // random hole in the middle of the stand.
    const midCapMul = low ? 0.45 : (high ? 0.9 : 0.7);
    const farCapMul = !settings.farDetail ? 0.45 : (low ? 0.5 : (high ? 0.95 : 0.8));
    const nearRHard = low ? 70 : (high ? 110 : 90);
    const cam = this.renderer.camera;
    this._projScreen.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    this._frustum.setFromProjectionMatrix(this._projScreen);

    // Pooled buckets: this used to allocate a Map plus one array per species on
    // every rebuild, which is what made the GC churn visible as a hitch.
    const nearB = this._buckets || (this._buckets = new Map());
    const midB = this._midBuckets || (this._midBuckets = new Map());
    const billB = this._billBuckets || (this._billBuckets = new Map());
    for (const rec of this.records.values()) {
      if (!rec.props) continue;
      for (const p of rec.props) {
        const d = Math.hypot(p.x - focus.x, p.z - focus.z);
        if (d > farR) continue;
        this._sphere.center.set(p.x, p.y + 2.4 * p.scale, p.z);
        this._sphere.radius = 3.6 * p.scale;
        if (!this._frustum.intersectsSphere(this._sphere)) continue;
        p._d = d;                                    // scratch: distance priority below
        const isTree = SPRITE_SET.has(p.prop);
        const map = d <= (isTree ? nearR : nearRHard) ? nearB : (d <= midR ? midB : billB);
        let a = map.get(p.prop);
        if (!a) { a = []; map.set(p.prop, a); }
        a.push(p);
      }
    }
    let total = 0;
    // Distance priority: the buckets are sorted nearest-first so a budget cut drops the
    // far end of the species band and never the trees the driver is actually aiming at.
    const prio = (list) => { if (list.length > 1) list.sort((a, b) => a._d - b._d); return list; };
    const put = (im, list, n, camFacing, fade0, fade1, farRef, fadeMin) => {
      for (let i = 0; i < n; i++) {
        const p = list[i];
        this._pos.set(p.x, p.y, p.z);
        // A billboard squares up to the camera; a crossed-quad / voxel prop keeps the
        // yaw it was placed with, so a stand does not swim when the camera swings.
        this._euler.set(0, camFacing ? Math.atan2(cam.position.x - p.x, cam.position.z - p.z) : p.yaw, 0);
        this._quat.setFromEuler(this._euler);
        this._scale.set(p.scale, p.scale, p.scale);
        this._mat4.compose(this._pos, this._quat, this._scale);
        im.setMatrixAt(i, this._mat4);
        if (im.instanceColor) {
          // Distance fade, not a pop: 1.0 at the inner edge of the band down to fadeMin
          // at its outer edge, multiplied into the Lambert diffuse and then pushed into
          // the scene fog. The billboard band fades hardest, which is what lets a 2-tri
          // quad at 320 m read as haze instead of as a cut edge.
          const t = Math.max(0, Math.min(1, (p._d - fade0) / Math.max(1, fade1 - fade0)));
          const f = 1 - (1 - fadeMin) * t * farRef;
          this._col.setRGB(f, f, f);
          im.setColorAt(i, this._col);
        }
      }
      im.count = n;
      im.visible = n > 0;
      upload(im, n);
      if (im.instanceColor) upload(im.instanceColor, n, 3);
      total += n;
    };
    for (const [type, im] of this.propMeshes) {
      if (type === PROP.GATE) continue;
      const cap = CAPACITY[type];
      const nl = nearB.get(type), ml = midB.get(type), bl = billB.get(type);
      const near = prio(nl || this._empty);
      const mid = prio(ml || this._empty);
      const bill = prio(bl || this._empty);
      // Whole-batch distance cull: the buckets are sorted nearest-first, so once the
      // CLOSEST member of a band sits past that band's radius the entire batch switches
      // off - no instance written, no buffer uploaded, no draw call.
      const nearLim = SPRITE_SET.has(type) ? nearR : nearRHard;
      const nN = (near.length && near[0]._d > nearLim) ? 0 : this._budget(near, Math.floor(cap * nearCapMul));
      const mN = (mid.length && mid[0]._d > midR) ? 0 : this._budget(mid, Math.floor(cap * midCapMul));
      const bN = (bill.length && bill[0]._d > farR) ? 0 : this._budget(bill, Math.floor(cap * farCapMul));
      put(im, near, nN, false, 0, 0, 0, 0.78);
      const mim = this.midMeshes.get(type);
      if (mim) put(mim, mid, mN, false, midR * 0.55, midR, 1, 0.72);
      const bim = this.billMeshes.get(type);
      if (bim) put(bim, bill, bN, true, farR * 0.5, farR, 1, 0.4);
    }
    this.stats.props = total;
    for (const a of nearB.values()) a.length = 0;      // keep the arrays, drop the items
    for (const a of midB.values()) a.length = 0;
    for (const a of billB.values()) a.length = 0;
  }

  /** Shared empty bucket, so a species with nothing visible allocates nothing. */
  get _empty() { return this._emptyList || (this._emptyList = []); }

  /** Distance-priority budget: spend the instance cap on the nearest props. */
  _budget(list, cap) {
    if (list.length > cap) list.sort((a, b) => a._d - b._d);
    return Math.min(list.length, cap);
  }
}
