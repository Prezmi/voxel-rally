// Chunk streaming + LOD rings + prop instancing (docs/03 §1, docs/06 streaming.js).
// Rings: full 0-110 m, simplified 110-200 m, silhouette 200-260 m.
// Remeshing is budgeted per frame so a fast drive never hitches.
import * as THREE from 'three';
import { CHUNK, COLS, chunkKey, keyToCx, keyToCz } from './chunk.js';
import { meshChunk, LOD_CELL } from './mesher.js';
import { carveChunk, SHOULDER } from './road-carve.js';
import { SURF } from './surfaces.js';
import { GeoBuilder } from '../render/primitives.js';
import { generateChunkProps, buildTreeGeometries, buildGateGeometry, buildSpriteGeometries, buildFoliageTextures, buildSpriteMaterials, SPRITE_PROPS, PROP, PROP_NAMES } from './props.js';
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
// ring 2 -> ring 3 (8 m silhouette) switch point: outer half of the silhouette band
const farRingRadius = () => settings.simpleRadius + (settings.drawDistance - settings.simpleRadius) * 0.5;
const TILE_FAR_ABS = 150;          // m from the car, hard cut regardless of ring
const TILE_FAR_ABS_LOW = 90;       // LOW: the tiles are 0.18 m slabs, they read to ~90 m

/** Upload only the used prefix of an instance buffer, not the whole capacity. */
function upload(im, n) {
  const a = im.instanceMatrix;
  if (a.clearUpdateRange && a.addUpdateRange) { a.clearUpdateRange(); a.addUpdateRange(0, Math.max(1, n) * 16); }
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

    // ---- prop distance LOD (perf: the glb tree nodes are ~1-2 k tris each, and
    // 1 400 of them per species is what put 6.3 M triangles in one frame).
    // Near ring: the baked glb geo on the mesh above. Far ring: the crossed-quad
    // sprite of the same species, a handful of tris. Beyond PROP_FAR: nothing.
    this.farMeshes = new Map();
    for (const p of [PROP.OAK, PROP.PINE, PROP.BIRCH, PROP.BUSH, PROP.FERN]) {
      const geo = this.spriteGeos[p], mat = this.spriteMats && this.spriteMats[p];
      if (!geo || !mat) continue;
      const im = new THREE.InstancedMesh(geo, mat, CAPACITY[p]);
      im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      im.castShadow = false; im.receiveShadow = false;
      im.count = 0; im.frustumCulled = false;
      renderer.scene.add(im);
      this.farMeshes.set(p, im);
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

    this.stats = { chunks: 0, tris: 0, remeshes: 0, props: 0, generated: 0, carved: 0, tiles: 0 };
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
    for (const [type, im] of this.propMeshes) {
      const name = ASSET_NODES[type];
      if (!name) continue;
      const rec = nodes.get(name);
      if (!rec || !rec.geometry) continue;                 // node absent -> keep procedural
      const mat = rec.material;
      if (mat && !Array.isArray(mat) && mat.vertexColors && !rec.geometry.getAttribute('color')) {
        mat.vertexColors = false;                          // nothing to feed USE_COLOR
      }
      im.geometry = rec.geometry;
      if (mat) im.material = mat;
    }
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
      this.blockOff.set(sid, {
        x: -0.5 * (bb.min.x + bb.max.x),
        y: -bb.max.y,
        z: -0.5 * (bb.min.z + bb.max.z),
        w: Math.min(1.4, Math.max(0.6, bb.max.x - bb.min.x)),
        d: Math.min(1.4, Math.max(0.6, bb.max.z - bb.min.z)),
      });
      const mat = rec.material ? rec.material.clone() : this.renderer.propMaterial;
      if (mat.vertexColors && !geo.getAttribute('color')) mat.vertexColors = false;
      const im = new THREE.InstancedMesh(geo, mat, TILE_CAPACITY);
      im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
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
    const chunk = this.world.chunkAt(cx, cz);
    if (!chunk || !this.blockActive) return null;
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
      if (!sid || !this.blockMeshes.has(sid)) continue;
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
          this._scale.set(off.w, 1, off.d);
          this._mat4.compose(this._pos, this._quat, this._scale);
          im.setMatrixAt(used, this._mat4);
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
    if (dist <= settings.drawDistance) return 3;
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
        // The voxel columns go the same way as their mesh: generation + carve are
        // deterministic in (cx,cz,seed), so keeping them forever only grew the Map
        // (~16 KB of column arrays per chunk, 293 chunks in 30 s of driving).
        this.world.dropChunk(rec.cx, rec.cz);
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
        rec.props = generateChunkProps(job.cx, job.cz, this.stage);
      }
      if (!rec.tiles) {
        const stride = TILE_STRIDE[job.ring];
        if (stride) {
          rec.tiles = this._chunkTiles(job.cx, job.cz, stride, TILE_CAP_RING[job.ring]) || null;
        } else {
          rec.tiles = null;
        }
      }
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
    return performance.now() - t0;
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
      let mat;
      if (Array.isArray(rec.material)) {
        mat = rec.material.map((m) => (m && m.clone ? m.clone() : this.renderer.propMaterial));
      } else if (rec.material && rec.material.clone) {
        mat = rec.material.clone();
        if (mat.vertexColors && !geo.getAttribute('color')) mat.vertexColors = false;
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
      put('prop_marshal_tent', gx + nx * (half + 5.5) * s + tx * 12,
        gz + nz * (half + 5.5) * s + tz * 12, Math.atan2(-nx * s, -nz * s));
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
   * Bound the prop load instead of letting it grow with the drive: distance LOD
   * (glb geo near, sprite quad far, nothing beyond), camera-frustum culling, and
   * the fixed per-species caps. Called at <=6.7 Hz, allocation-free.
   */
  _rebuildProps(focus) {
    const low = settings.quality === QUALITY.LOW;
    const nearR = low ? 45 : 85;
    const farR = low ? 95 : 170;
    const capMul = low ? 0.55 : 1;      // LOW also trims the near instance budget
    const cam = this.renderer.camera;
    this._projScreen.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    this._frustum.setFromProjectionMatrix(this._projScreen);

    // Pooled buckets: this used to allocate a Map plus one array per species on
    // every rebuild, which is what made the GC churn visible as a hitch.
    const buckets = this._buckets || (this._buckets = new Map());
    const farBuckets = this._farBuckets || (this._farBuckets = new Map());
    for (const rec of this.records.values()) {
      if (!rec.props) continue;
      for (const p of rec.props) {
        const d = Math.hypot(p.x - focus.x, p.z - focus.z);
        if (d > farR) continue;
        this._sphere.center.set(p.x, p.y + 2.4 * p.scale, p.z);
        this._sphere.radius = 3.6 * p.scale;
        if (!this._frustum.intersectsSphere(this._sphere)) continue;
        const map = d <= nearR ? buckets : farBuckets;
        let a = map.get(p.prop);
        if (!a) { a = []; map.set(p.prop, a); }
        a.push(p);
      }
    }
    let total = 0;
    for (const [type, im] of this.propMeshes) {
      if (type === PROP.GATE) continue;
      const list = buckets.get(type) || [];
      const n = Math.min(list.length, Math.floor(CAPACITY[type] * capMul));
      for (let i = 0; i < n; i++) {
        const p = list[i];
        this._pos.set(p.x, p.y, p.z);
        this._euler.set(0, p.yaw, 0);
        this._quat.setFromEuler(this._euler);
        this._scale.set(p.scale, p.scale, p.scale);
        this._mat4.compose(this._pos, this._quat, this._scale);
        im.setMatrixAt(i, this._mat4);
      }
      im.count = n;
      im.visible = n > 0;
      upload(im, n);
      total += n;
      // far LOD: same placement on the sprite mesh; species without a sprite geo
      // simply drop out past nearR (posts and spectators are too small to matter)
      const fim = this.farMeshes.get(type);
      if (fim) {
        const fl = farBuckets.get(type) || [];
        const fn = Math.min(fl.length, CAPACITY[type]);
        for (let i = 0; i < fn; i++) {
          const p = fl[i];
          this._pos.set(p.x, p.y, p.z);
          this._euler.set(0, p.yaw, 0);
          this._quat.setFromEuler(this._euler);
          this._scale.set(p.scale, p.scale, p.scale);
          this._mat4.compose(this._pos, this._quat, this._scale);
          fim.setMatrixAt(i, this._mat4);
        }
        fim.count = fn;
        fim.visible = fn > 0;
        upload(fim, fn);
        total += fn;
      }
    }
    this.stats.props = total;
    for (const a of buckets.values()) a.length = 0;      // keep the arrays, drop the items
    for (const a of farBuckets.values()) a.length = 0;
  }
}
