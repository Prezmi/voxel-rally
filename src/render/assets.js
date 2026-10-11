// Asset pipeline loader (PLAN.md §11).
// Loads real 3D assets from assets/models/<name>.glb and ALWAYS falls back to the
// caller's procedural geometry, so a missing or broken file can never break a drive.
// No DOM access, no work at import time, safe to import from any render module.
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/addons/mergeGeometries.js';
import { ModelQueue } from './model-queue.js';

const MODELS_DIR = 'assets/models/';
const cache = new Map(); // name -> Promise<{ name, root, source, reason }>
let loader = null;

// One model request at a time, retried when the connection is starved. The dev
// server accepts with a 5-deep backlog (`LISTEN 0 5` on :8090) while a boot
// opens ~60 module requests, so firing three glbs in the same burst is how the
// hero car ended up fetching nothing in every driving capture (queue P41;
// policy and proof in model-queue.js, src/debug/tests.js T44).
const queue = new ModelQueue();

function gltfLoader() {
  if (!loader) loader = new GLTFLoader();
  return loader;
}

export function modelPath(name) {
  return `${MODELS_DIR}${name}.glb`;
}

// One request. It never resolves with a fallback, it rejects, so model-queue.js
// can retry it. A glb that parses to no scene is a failure too: the caller's
// procedural geometry is what actually renders, so calling that a success is how
// a broken asset goes silent.
function fetchModel(key) {
  return new Promise((resolve, reject) => {
    let l = null;
    try {
      l = gltfLoader();
    } catch (e) {
      reject(new Error(`GLTFLoader unavailable: ${e && e.message}`));
      return;
    }
    try {
      l.load(
        modelPath(key),
        (gltf) => {
          if (!gltf || !gltf.scene) { reject(new Error('loaded with no scene')); return; }
          resolve({ name: key, root: gltf.scene, source: 'glb', reason: '' });
        },
        undefined,
        (err) => reject(new Error(err && err.message ? err.message : 'load failed'))
      );
    } catch (e) {
      reject(new Error(`load threw: ${e && e.message}`));
    }
  });
}

// Resolve a model by name. On any failure the promise resolves with
// { root: fallbackFactory(), source: 'procedural', reason } and warns exactly
// once per request. `reason` names WHICH failure it was: the old bare fallback
// let a lost fetch read as "the glb has no named nodes" and sent two review
// passes down the wrong path (queue P33 then P41, same fetch, two diagnoses).
export function loadModel(name, fallbackFactory) {
  const key = String(name);
  if (cache.has(key)) return cache.get(key);

  const pending = queue.run(key, () => fetchModel(key)).catch((err) => {
    const reason = `unavailable (${(err && err.message) || 'load failed'}, ${queue.tries(key)} attempts)`;
    console.warn(`[assets] "${key}" ${reason}, using procedural fallback`);
    const root = typeof fallbackFactory === 'function' ? fallbackFactory() : null;
    return { name: key, root, source: 'procedural', reason };
  });

  // A failure must never be the cached answer. One starved connection at boot
  // used to pin the procedural car for the whole session, because every later
  // caller got the same rejected promise back. delete() only drops the entry if
  // it is still ours, so a retry is possible without a thundering herd.
  pending.then((res) => {
    if (res && res.source !== 'glb' && cache.get(key) === pending) cache.delete(key);
  });

  cache.set(key, pending);
  return pending;
}

// Resolve a model into Map<node name, { geometry, material, node }>. Reuses the
// same cache as loadModel, never throws, and on any failure resolves with an empty
// Map after warning exactly once per name.
const nodeWarned = new Set();
export function loadModelNodes(name) {
  const key = String(name);
  return loadModel(key, null).then((res) => {
    const nodes = new Map();
    // What the caller reports if it keeps the procedural geometry: WHICH of the
    // three distinct failures happened (fetch lost, scan threw, or a file whose
    // meshes carry no names). Never blame the asset for a fetch that never ran.
    nodes.source = (res && res.source) || 'procedural';
    nodes.reason = (res && res.reason) || '';
    if (!res || !res.root) {
      if (!nodes.reason) nodes.reason = 'no scene in the loaded model';
      return nodes;
    }
    try {
      // A multi-material part exports as one mesh with several primitives, and
      // GLTFLoader splits it into a Group (carrying the exported node name) of
      // child meshes named "<name>_1", "<name>_2"… Fold those primitives back
      // under the exported name so parts are addressed by the name the asset
      // declares, with one material slot per primitive group.
      const parts = new Map(); // exported name -> { node, geos: [], mats: [] }
      res.root.traverse((o) => {
        if (!o || (!o.isMesh && !o.isInstancedMesh) || !o.geometry) return;
        const p = o.parent;
        const pn = p && p.isGroup && p.userData && p.userData.name ? String(p.userData.name) : '';
        const own = o.name ? String(o.name) : '';
        const isPrimitive = !!pn && !!own && own !== pn && own.indexOf(`${pn}_`) === 0;
        const n = isPrimitive ? pn : own;
        if (!n) return;
        let rec = parts.get(n);
        if (!rec) {
          if (!isPrimitive && nodes.has(n)) return;
          rec = { node: isPrimitive ? p : o, geos: [], mats: [] };
          parts.set(n, rec);
        }
        rec.geos.push(o.geometry);
        rec.mats.push(Array.isArray(o.material) ? (o.material[0] || null) : (o.material || null));
      });
      for (const [n, rec] of parts) {
        let geometry = rec.geos[0];
        let material = rec.mats[0] || null;
        if (rec.geos.length > 1) {
          const merged = mergeGeometries(rec.geos, true);
          if (merged) { geometry = merged; material = rec.mats; }
        }
        if (!geometry) continue;
        nodes.set(n, { geometry, material, node: rec.node });
      }
    } catch (e) {
      nodes.source = 'scan-failed';
      nodes.reason = `node scan failed (${e && e.message ? e.message : 'scan failed'})`;
      if (!nodeWarned.has(key)) {
        nodeWarned.add(key);
        console.warn(`[assets] "${key}" ${nodes.reason}`);
      }
      return nodes;
    }
    if (!nodes.size) {
      nodes.reason = `no named mesh nodes in ${modelPath(key)}`;
      if (!nodeWarned.has(key)) {
        nodeWarned.add(key);
        console.warn(`[assets] "${key}" ${nodes.reason}, using procedural fallback`);
      }
    }
    return nodes;
  });
}

// Await a model that is already in the cache; never triggers a new request.
export function cachedModel(name) {
  return cache.get(String(name)) || null;
}

export function modelLoaded(name) {
  return cache.has(String(name));
}

export function clearModelCache() {
  cache.clear();
}

// Copy the materials of a loaded GLB onto a matching procedural mesh so a swap can
// keep the existing shader patches (dirt, livery) instead of replacing them.
export function adoptMaterials(from, to) {
  if (!from || !to) return 0;
  let n = 0;
  from.traverse((o) => {
    if (o.isMesh && o.material) n++;
  });
  if (!n) return 0;
  to.traverse((o) => {
    if (!o.isMesh) return;
    let src = null;
    from.traverse((c) => {
      if (!src && c.isMesh && c.material) src = c;
    });
    if (src) {
      o.material = src.material;
      n++;
    }
  });
  return n;
}
