// Asset pipeline loader (PLAN.md §11).
// Loads real 3D assets from assets/models/<name>.glb and ALWAYS falls back to the
// caller's procedural geometry, so a missing or broken file can never break a drive.
// No DOM access, no work at import time, safe to import from any render module.
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/addons/mergeGeometries.js';

const MODELS_DIR = 'assets/models/';
const cache = new Map(); // name -> Promise<{ name, root, source }>
let loader = null;

function gltfLoader() {
  if (!loader) loader = new GLTFLoader();
  return loader;
}

export function modelPath(name) {
  return `${MODELS_DIR}${name}.glb`;
}

// Resolve a model by name. On any failure the promise resolves with
// { root: fallbackFactory(), source: 'procedural' } and warns exactly once.
export function loadModel(name, fallbackFactory) {
  const key = String(name);
  if (cache.has(key)) return cache.get(key);

  const pending = new Promise((resolve) => {
    const fallback = () => {
      const root = typeof fallbackFactory === 'function' ? fallbackFactory() : null;
      resolve({ name: key, root, source: 'procedural' });
    };

    let l = null;
    try {
      l = gltfLoader();
    } catch (e) {
      console.warn(`[assets] GLTFLoader unavailable for "${key}": ${e && e.message}`);
      fallback();
      return;
    }

    try {
      l.load(
        modelPath(key),
        (gltf) => {
          if (!gltf || !gltf.scene) {
            console.warn(`[assets] "${key}" loaded with no scene, using procedural fallback`);
            fallback();
            return;
          }
          resolve({ name: key, root: gltf.scene, source: 'glb' });
        },
        undefined,
        (err) => {
          const msg = err && err.message ? err.message : 'load failed';
          console.warn(`[assets] "${key}" unavailable (${msg}), using procedural fallback`);
          fallback();
        }
      );
    } catch (e) {
      console.warn(`[assets] "${key}" load threw (${e && e.message}), using procedural fallback`);
      fallback();
    }
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
    if (!res || !res.root) return nodes;
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
      if (!nodeWarned.has(key)) {
        nodeWarned.add(key);
        console.warn(`[assets] "${key}" node scan failed (${e && e.message ? e.message : 'scan failed'})`);
      }
      return new Map();
    }
    if (!nodes.size && !nodeWarned.has(key)) {
      nodeWarned.add(key);
      console.warn(`[assets] "${key}" has no named mesh nodes, using procedural fallback`);
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
