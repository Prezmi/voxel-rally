// Chunk streaming + LOD rings + prop instancing (docs/03 §1, docs/06 streaming.js).
// Rings: full 0-110 m, simplified 110-200 m, silhouette 200-260 m.
// Remeshing is budgeted per frame so a fast drive never hitches.
import * as THREE from 'three';
import { CHUNK, chunkKey, keyToCx, keyToCz } from './chunk.js';
import { meshChunk, LOD_CELL } from './mesher.js';
import { carveChunk } from './road-carve.js';
import { GeoBuilder } from '../render/primitives.js';
import { generateChunkProps, buildTreeGeometries, buildGateGeometry, buildSpriteGeometries, buildFoliageTextures, buildSpriteMaterials, SPRITE_PROPS, PROP, PROP_NAMES } from './props.js';
import { settings } from '../core/settings.js';

const CAPACITY = {
  [PROP.OAK]: 1400, [PROP.PINE]: 1400, [PROP.DEAD]: 700,
  [PROP.SPECTATOR]: 1000, [PROP.POST]: 900, [PROP.MARSHAL]: 40, [PROP.GATE]: 24,
  [PROP.BIRCH]: 900, [PROP.BUSH]: 1400, [PROP.FERN]: 1600,
};

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

    this._mat4 = new THREE.Matrix4();
    this._quat = new THREE.Quaternion();
    this._scale = new THREE.Vector3();
    this._pos = new THREE.Vector3();
    this._euler = new THREE.Euler();

    this.stats = { chunks: 0, tris: 0, remeshes: 0, props: 0, generated: 0, carved: 0 };
    this._lastRingKey = '';
    this._gatesPlaced = false;
  }

  _ring(dist) {
    if (dist <= settings.fullRadius) return 0;
    if (dist <= settings.simpleRadius) return 1;
    if (dist <= settings.drawDistance) return 2;
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
      }
    }

    // 2) collect work
    const jobs = [];
    for (let dz = -span; dz <= span; dz++) {
      for (let dx = -span; dx <= span; dx++) {
        const cx = cxFocus + dx, cz = czFocus + dz;
        const centerX = cx * CHUNK + CHUNK / 2, centerZ = cz * CHUNK + CHUNK / 2;
        const dist = Math.hypot(centerX - focus.x, centerZ - focus.z);
        if (dist > R) continue;
        const ring = this._ring(dist);
        if (ring < 0) continue;
        jobs.push({ cx, cz, ring, dist });
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
    }
    this.stats.remeshes = remeshes;

    // 4) gates (few, but instanced so they cost one draw call)
    if (!this._gatesPlaced) { this._placeGates(); this._gatesPlaced = true; }

    // 5) rebuild prop instances when the visible chunk set changed
    const ringKey = `${cxFocus},${czFocus},${this.records.size}`;
    if (ringKey !== this._lastRingKey) { this._lastRingKey = ringKey; this._rebuildProps(); }

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

  _rebuildProps() {
    const buckets = new Map();
    for (const rec of this.records.values()) {
      if (!rec.props) continue;
      for (const p of rec.props) {
        let a = buckets.get(p.prop);
        if (!a) { a = []; buckets.set(p.prop, a); }
        a.push(p);
      }
    }
    let total = 0;
    for (const [type, im] of this.propMeshes) {
      if (type === PROP.GATE) continue;
      const list = buckets.get(type) || [];
      const n = Math.min(list.length, CAPACITY[type]);
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
      im.instanceMatrix.needsUpdate = true;
      total += n;
    }
    this.stats.props = total;
  }
}
