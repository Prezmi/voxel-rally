// Procedural rally car (docs/06: zero asset files; PLAN §10.2 car look bible).
// One chamfered/lofted body volume (car-body.js) + one instanced wheel drawn at
// the four real Wheel states + a code-generated livery map (car-livery.js).
// Damage is shown as physically missing / knocked parts, never as a bar.
import * as THREE from 'three';
import { buildBodyGeometry, buildWheelGeometry, carShape } from './car-body.js';
import { loadModelNodes } from './assets.js';
import { ASSET_CAR_MODEL, WHEEL_NODES, buildAssetBody, tyreScale } from './car-asset.js';
import { TYRE_BASE } from '../car/car-params.js';
import { buildLiveryTexture } from './car-livery.js';
import { PANELS, PANEL_COUNT } from '../dirt/panel-dirt.js';
import { MAP_TEXELS, MAP_METRES } from '../dirt/dirt-map.js';
import { settings } from '../core/settings.js';

/**
 * Bake one panel index + airflow direction per body vertex (docs/04 §4.2: the
 * dirt layer is per panel and the streaks run along the panel's airflow). The
 * panel index is assigned per volume by car-body.js, so the 16 panels land on
 * the new silhouette exactly where they belong. Build-time only.
 */
function bakeFlowAttributes(geo) {
  const panel = geo.getAttribute('aPanel');
  const n = panel.count;
  const flow = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const f = PANELS[Math.max(0, Math.min(PANEL_COUNT - 1, panel.getX(i)))].flow;
    const l = Math.hypot(f[0], f[1], f[2]) || 1;
    flow[i * 3] = f[0] / l; flow[i * 3 + 1] = f[1] / l; flow[i * 3 + 2] = f[2] / l;
  }
  geo.setAttribute('aFlow', new THREE.BufferAttribute(flow, 3));
}

/**
 * Dirt textures for the car shader. One static graph, built once:
 *  panelTex  16x1 RGBA8: thick, wet, dust, streak  (docs/04 §4.2 A)
 *  panelCol  16x1 RGBA8: current dirt tone per panel
 *  sprayTex  512x512 RGBA8: the world spray field, i.e. the CPU mirror of
 *            dirt/dirt-map.js handed to the GPU as a view onto the same bytes
 * No dynamic indexing of a uniform array: a 16-texel texture is WebGL1-safe and
 * uploading 64 bytes a frame is free.
 */
function buildDirtTextures(dirt) {
  const panelData = new Uint8Array(PANEL_COUNT * 4);
  const panelTex = new THREE.DataTexture(panelData, PANEL_COUNT, 1, THREE.RGBAFormat, THREE.UnsignedByteType);
  panelTex.magFilter = THREE.NearestFilter;
  panelTex.minFilter = THREE.NearestFilter;
  panelTex.generateMipmaps = false;
  panelTex.needsUpdate = true;

  const colData = new Uint8Array(PANEL_COUNT * 4);
  const colTex = new THREE.DataTexture(colData, PANEL_COUNT, 1, THREE.RGBAFormat, THREE.UnsignedByteType);
  colTex.magFilter = THREE.NearestFilter;
  colTex.minFilter = THREE.NearestFilter;
  colTex.generateMipmaps = false;
  colTex.colorSpace = THREE.SRGBColorSpace;
  colTex.needsUpdate = true;

  const sprayTex = new THREE.DataTexture(dirt ? dirt.map.data : new Uint8Array(MAP_TEXELS * MAP_TEXELS * 4),
    MAP_TEXELS, MAP_TEXELS, THREE.RGBAFormat, THREE.UnsignedByteType);
  sprayTex.magFilter = THREE.LinearFilter;
  sprayTex.minFilter = THREE.LinearFilter;
  sprayTex.generateMipmaps = false;
  sprayTex.wrapS = THREE.ClampToEdgeWrapping;
  sprayTex.wrapT = THREE.ClampToEdgeWrapping;
  sprayTex.needsUpdate = true;

  return { panelTex, panelData, colTex, colData, sprayTex, uploadSeq: -1, uploadT: 0 };
}

export function buildCarMesh(car, dirt) {
  const p = car.params;
  const shape = carShape(p);
  const built = buildBodyGeometry(car);
  bakeFlowAttributes(built.geo);

  const dtex = buildDirtTextures(dirt);
  const livery = buildLiveryTexture(p.id, THREE);
  const bodyMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.52, metalness: 0.18 });
  attachCarShader(bodyMat, dtex, livery);

  const body = new THREE.Mesh(built.geo, bodyMat);
  body.castShadow = true;
  body.receiveShadow = true;

  // One wheel geometry, four instances: the draw-call budget stays at one call
  // for all four corners while each wheel keeps its own transform and tint.
  const wheel = buildWheelGeometry(p);
  const wheelMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.88, metalness: 0.22 });
  const wheels = new THREE.InstancedMesh(wheel.geo, wheelMat, 4);
  wheels.castShadow = true;
  wheels.receiveShadow = true;
  wheels.frustumCulled = false;
  wheels.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(12).fill(1), 3);

  // Pristine copies of every damage-managed region: applied on change only.
  const pos = built.geo.getAttribute('position');
  const col = built.geo.getAttribute('color');
  const regions = {};
  for (const key in built.ranges) {
    const r = built.ranges[key];
    const n = (r[1] - r[0]) * 3;
    regions[key] = {
      range: r,
      pos: Float32Array.prototype.slice.call(pos.array, r[0] * 3, r[1] * 3),
      col: Float32Array.prototype.slice.call(col.array, r[0] * 3, r[1] * 3),
    };
  }

  const group = new THREE.Group();
  group.add(body);
  group.add(wheels);

  // Headlights only light the road when the stage is dark (per-stage tod).
  const tod = typeof settings.tod === 'number' ? settings.tod : 0.7;
  const night = tod > 0.78 || tod < 0.22;
  const beams = [];
  if (night) {
    for (const z of [shape.hz * 0.6, -shape.hz * 0.6]) {
      const sl = new THREE.SpotLight(0xffeecd, 46, 34, 0.55, 0.62, 1.3);
      sl.position.set(shape.hx + 0.25, shape.floor + 0.34, z);
      sl.target.position.set(shape.hx + 17, shape.floor - 2.0, z * 1.7);
      sl.castShadow = false;
      group.add(sl);
      group.add(sl.target);
      beams.push(sl);
    }
  }

  const view = {
    group, body, wheels, spin: [0, 0, 0, 0], dtex, mat: bodyMat, livery,
    shape, regions, beams, night, dmgKey: -1, brakeOn: -1,
    tris: { body: built.tris, wheel: wheel.tris }, asset: false, carParams: p,
  };
  // Asset-backed car (assets/models/rally_v2.glb): the procedural car above is
  // the fallback and stays in place if the glb or any node is missing.
  adoptAssetCar(view, wheels);
  return view;
}

let assetCarLogged = false;
function logAssetCar(active, detail) {
  if (assetCarLogged) return;
  assetCarLogged = true;
  console.log(`[car] asset car "${ASSET_CAR_MODEL}" ${active ? 'ACTIVE' : 'INACTIVE -> procedural car'} (${detail})`);
}

/**
 * The four exported wheel pivot nodes driven by the existing per-wheel matrix
 * code: setMatrixAt writes the pivot's local matrix (already position + spin +
 * steer + loaded radius), instanceColor writes the tyre tint onto that wheel's
 * own material. No wheel geometry is rebuilt.
 */
function makeWheelPivots(pivots, mats) {
  // The per-wheel tint is a MULTIPLIER on each part's own material colour (the
  // procedural wheels multiplied their baked vertex colours by the same ratio),
  // so a dark tyre stays dark and the alloy stays bright.
  const base = mats.map((m) => (m && m.color ? { r: m.color.r, g: m.color.g, b: m.color.b } : null));
  return {
    isAssetWheels: true,
    setMatrixAt(i, m) {
      const p = pivots[i];
      if (!p) return;
      p.matrix.copy(m);
      p.matrixWorldNeedsUpdate = true;
    },
    instanceMatrix: { needsUpdate: false },
    instanceColor: {
      needsUpdate: false,
      setXYZ(i, r, g, b) {
        const m = mats[i]; if (!m) return;
        const b0 = base[i] || { r: 1, g: 1, b: 1 };
        m.color.setRGB(b0.r * r, b0.g * g, b0.b * b);
      },
    },
  };
}

function adoptAssetCar(view, proceduralWheels) {
  return loadModelNodes(ASSET_CAR_MODEL).then((nodes) => {
    if (!nodes || !nodes.size) { logAssetCar(false, 'no named nodes in the glb'); return false; }
    const built = buildAssetBody(nodes, view.carParams);
    const wheelRecs = WHEEL_NODES.map((n) => nodes.get(n));
    const gone = WHEEL_NODES.filter((n, i) => !wheelRecs[i] || !wheelRecs[i].geometry || !wheelRecs[i].node);
    if (!built.tris || built.missing.length || gone.length) {
      logAssetCar(false, `missing nodes: ${[...built.missing, ...gone].join(', ') || 'no body triangles'}`);
      return false;
    }

    // One body BufferGeometry carrying the whole dirt/livery/damage contract.
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(built.position, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(built.normal, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(built.color, 3));
    geo.setAttribute('aPanel', new THREE.BufferAttribute(built.aPanel, 1));
    geo.setAttribute('aLivUv', new THREE.BufferAttribute(built.aLivUv, 2));
    geo.setAttribute('aLiv', new THREE.BufferAttribute(built.aLiv, 1));
    geo.setAttribute('aLamp', new THREE.BufferAttribute(built.aLamp, 1));
    bakeFlowAttributes(geo);
    geo.computeBoundingSphere();
    const oldGeo = view.body.geometry;
    view.body.geometry = geo;                       // keeps the patched material
    if (oldGeo && oldGeo.dispose) oldGeo.dispose();
    view.tris.body = built.tris;

    const pos = geo.getAttribute('position');
    const col = geo.getAttribute('color');
    const regions = {};
    for (const key in built.ranges) {
      const r = built.ranges[key];
      regions[key] = {
        range: r,
        pos: Float32Array.prototype.slice.call(pos.array, r[0] * 3, r[1] * 3),
        col: Float32Array.prototype.slice.call(col.array, r[0] * 3, r[1] * 3),
      };
    }
    view.regions = regions;

    // Wheels: the exported pivots, uniformly scaled so the tyre radius lands on
    // TYRE_BASE.r; positions come from the physics state every frame anyway.
    const ts = tyreScale(nodes, TYRE_BASE.r, WHEEL_NODES[0]);
    const pivots = [], mats = [];
    for (let i = 0; i < 4; i++) {
      const node = wheelRecs[i].node;
      if (node.parent) node.parent.remove(node);
      node.position.set(0, 0, 0);
      node.scale.set(ts, ts, ts);
      node.castShadow = true;
      node.receiveShadow = true;
      const src = Array.isArray(wheelRecs[i].material) ? wheelRecs[i].material[0] : wheelRecs[i].material;
      const mat = src && src.clone ? src.clone() : new THREE.MeshStandardMaterial({ roughness: 0.9, metalness: 0.08 });
      mat.vertexColors = false;
      node.material = mat;
      node.traverse((c) => {                   // multi-primitive wheel: Group of meshes
        if (!c.isMesh) return;
        c.material = mat;
        c.castShadow = true;
        c.receiveShadow = true;
      });
      mats.push(mat);
      const pivot = new THREE.Object3D();
      pivot.matrixAutoUpdate = false;
      pivot.add(node);
      view.group.add(pivot);
      pivots.push(pivot);
    }
    view.group.remove(proceduralWheels);
    view.wheels = makeWheelPivots(pivots, mats);
    view.asset = true;
    logAssetCar(true, `body tris=${built.tris} fit=${built.scale.toFixed(3)} tyre=${ts.toFixed(3)} regions=${Object.keys(regions).length}`);
    return true;
  }).catch((e) => {
    logAssetCar(false, e && e.message ? e.message : 'asset path threw');
    return false;
  });
}

/**
 * Car shader: dirt layer (docs/04 §4.2 "render brudu") + the code-generated
 * livery + emissive lamps + pixel cracks under damage. Patched once into the
 * standard material, so the car stays one draw call and no material is ever
 * rebuilt at runtime.
 */
function attachCarShader(mat, dtex, livery) {
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uPanelTex = { value: dtex.panelTex };
    shader.uniforms.uPanelCol = { value: dtex.colTex };
    shader.uniforms.uSprayTex = { value: dtex.sprayTex };
    shader.uniforms.uSprayOrigin = { value: new THREE.Vector2(0, 0) };
    shader.uniforms.uLivery = { value: livery };
    shader.uniforms.uSpeed = { value: 0 };
    shader.uniforms.uHead = { value: 0.18 };
    shader.uniforms.uTail = { value: 0.25 };
    shader.uniforms.uDamage = { value: 0 };

    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aPanel;\nattribute vec3 aFlow;\nattribute vec2 aLivUv;\nattribute float aLiv;\nattribute float aLamp;\nvarying float vPanel;\nvarying vec3 vFlow;\nvarying vec2 vLivUv;\nvarying float vLiv;\nvarying float vLamp;\nvarying vec3 vLocal;\nvarying vec3 vWPos;\nvarying vec3 vObjNormal;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvPanel = aPanel;\nvFlow = aFlow;\nvLivUv = aLivUv;\nvLiv = aLiv;\nvLamp = aLamp;\nvLocal = transformed;\nvObjNormal = normal;\nvWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;');

    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
uniform sampler2D uPanelTex;
uniform sampler2D uPanelCol;
uniform sampler2D uSprayTex;
uniform sampler2D uLivery;
uniform vec2 uSprayOrigin;
uniform float uSpeed;
uniform float uHead;
uniform float uTail;
uniform float uDamage;
varying float vPanel;
varying vec3 vFlow;
varying vec2 vLivUv;
varying float vLiv;
varying float vLamp;
varying vec3 vLocal;
varying vec3 vWPos;
varying vec3 vObjNormal;
// Dirt read once per fragment, reused by the roughness and the albedo/normal hook.
vec2 gPanelUv = vec2(0.0);
float gThick = 0.0, gWet = 0.0, gDust = 0.0, gStreak = 0.0;
vec3 gDirtCol = vec3(0.0);
float dhash1(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
`)
      .replace('#include <color_fragment>', `#include <color_fragment>
{
  // Livery (PLAN §10.2): paint, stripes, sponsor blocks and the number roundel
  // come from the generated map; the vertex colour carries the part's own tone.
  vec3 lv = texture2D(uLivery, clamp(vLivUv, 0.03, 0.97)).rgb;
  diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * lv * 1.05, vLiv);
}
`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
{
  gPanelUv = vec2((vPanel + 0.5) / 16.0, 0.5);
  vec4 pd = texture2D(uPanelTex, gPanelUv);
  gThick = clamp(pd.r, 0.0, 1.0);
  gWet = clamp(pd.g, 0.0, 1.0);
  gDust = clamp(pd.b, 0.0, 1.0);
  gStreak = clamp(pd.a, 0.0, 1.0);
  gDirtCol = texture2D(uPanelCol, gPanelUv).rgb;

  // Airborne spray from the world field (docs/04 §4.2 B). Only the surfaces that
  // face down- and rearwards catch it, so the roof does not get mud on it.
  vec2 uv = (vWPos.xz - uSprayOrigin) / float(${MAP_METRES});
  float spray = texture2D(uSprayTex, uv).r;
  float catchRear = clamp(-vObjNormal.x * 0.6 + (1.0 - clamp(vObjNormal.y, 0.0, 1.0)) * 0.8, 0.0, 1.4);
  gThick = clamp(gThick + spray * 0.9 * catchRear, 0.0, 1.0);

  // docs/04: rough = mix(rough, mix(0.95, 0.35, wet), thick) - wet mud glints.
  roughnessFactor = mix(roughnessFactor, mix(0.95, 0.35, gWet), clamp(gThick * 1.15 + gDust * 0.45, 0.0, 1.0));
}
`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
{
  vec3 dirtCol = gDirtCol * (1.0 - 0.25 * gWet);
  float film = clamp(gThick * 1.35 + gDust * 0.55, 0.0, 0.92);

  // Streaks: bands across the panel's airflow, dragged rearwards, only while the
  // panel is wet enough and the car is moving (docs/04 "smugi").
  float along = dot(vLocal, vFlow);
  vec3 perp3 = vLocal - vFlow * along;
  float band = floor((perp3.x * 1.4 + perp3.y * 4.0 + perp3.z * 6.0) * 5.0);
  float h = dhash1(vec2(band, 7.13));
  float tail = smoothstep(0.0, 1.0, fract(-along * 0.42 + h * 0.55));
  float streakMask = step(0.60, h) * gStreak * tail * smoothstep(0.22, 0.60, gThick + gWet * 0.5)
    * smoothstep(4.0, 16.0, uSpeed);

  vec3 col = mix(diffuseColor.rgb, dirtCol, film);
  col = mix(col, dirtCol * 0.88, clamp(streakMask, 0.0, 0.85));
  // Dry dust is a pale veil, not a dark plate - that is what keeps gravel dust
  // looking like dust rather than like mud (docs/04 risk R4).
  col = mix(col, dirtCol * 1.35 + vec3(0.22), gDust * 0.35 * (1.0 - gWet));

  // Damage as a surface state of the panel (docs/02 §8): pixel cracks, not a bar.
  if (uDamage > 0.10) {
    float c1 = dhash1(floor(vLocal.xy * 13.0) + vec2(vLocal.z * 7.0));
    float c2 = dhash1(floor(vLocal.yz * 5.0) + vec2(3.71));
    float crack = step(1.0 - uDamage * 0.30, c1) * step(0.45, c2);
    col *= 1.0 - crack * (0.30 + 0.35 * uDamage);
  }
  diffuseColor.rgb = col;

  // Micro-relief from the crust; moisture smooths it out.
  float n1 = dhash1(vLocal.xy * 190.0 + vLocal.z * 61.0 + gWet * 3.0);
  float n2 = dhash1(vLocal.yz * 97.0 - vLocal.x * 43.0);
  float relief = (n1 * 0.65 + n2 * 0.35 - 0.5);
  normal = normalize(normal + vec3(relief, relief * 0.6, -relief) * gThick * 0.35 * (1.0 - 0.5 * gWet));
}
`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
{
  float head = step(0.5, vLamp) * step(vLamp, 1.5);
  float tail = step(1.5, vLamp);
  totalEmissiveRadiance += vec3(1.0, 0.93, 0.72) * uHead * head + vec3(0.95, 0.07, 0.03) * uTail * tail;
}
`);
    mat.userData.shader = shader;
  };
  mat.customProgramCacheKey = () => 'vr-car-dirt';
}

const _m4 = new THREE.Matrix4();
const _v = new THREE.Vector3();
const _b1 = new THREE.Vector3();
const _b2 = new THREE.Vector3();
const _b3 = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _qi = new THREE.Quaternion();
const _up = new THREE.Vector3();
const _col = new THREE.Color();
const _col2 = new THREE.Color();

/**
 * Drive the visuals from the physics state. `alpha` is the fixed-step
 * interpolation factor from TimeState, so the car renders smoothly even though
 * the sim runs at 120 Hz (docs/06 §3).
 */
export function syncCarMesh(view, car, alpha, dirt) {
  if (dirt) updateCarDirt(view, car, dirt);
  const b = car.body;
  const px = b.prevPos.x + (b.pos.x - b.prevPos.x) * alpha;
  const py = b.prevPos.y + (b.pos.y - b.prevPos.y) * alpha;
  const pz = b.prevPos.z + (b.pos.z - b.prevPos.z) * alpha;

  // Slerp-ish: lerp the quaternion then normalise; at 1/120 s the angle is tiny.
  let qx = b.prevQuat.x + (b.quat.x - b.prevQuat.x) * alpha;
  let qy = b.prevQuat.y + (b.quat.y - b.prevQuat.y) * alpha;
  let qz = b.prevQuat.z + (b.quat.z - b.prevQuat.z) * alpha;
  let qw = b.prevQuat.w + (b.quat.w - b.prevQuat.w) * alpha;
  const n = Math.hypot(qx, qy, qz, qw) || 1;
  _q.set(qx / n, qy / n, qz / n, qw / n);

  view.group.position.set(px, py, pz);
  view.group.quaternion.copy(_q);
  view.group.visible = true;
  _qi.copy(_q).invert();

  for (let i = 0; i < 4; i++) {
    const w = car.wheels[i];
    view.spin[i] += w.omega * (1 / 120);
    if (view.spin[i] > 1e6) view.spin[i] %= (2 * Math.PI);

    // The wheel state is in WORLD frame; the mesh is a child of the car group,
    // so the hub and the wheel axes are taken back into car-local space.
    _v.set(w.hub.x - px, w.y - py, w.hub.z - pz).applyQuaternion(_qi);
    const lx = _v.x, ly = _v.y, lz = _v.z;
    _v.set(w.forward.x, w.forward.y, w.forward.z).applyQuaternion(_qi);
    const fx = _v.x, fy = _v.y, fz = _v.z;
    _v.set(w.right.x, w.right.y, w.right.z).applyQuaternion(_qi);
    const rx = _v.x, ry = _v.y, rz = _v.z;
    _up.set(ry * fz - rz * fy, rz * fx - rx * fz, rx * fy - ry * fx).normalize();

    const a = view.spin[i];
    const ca = Math.cos(a), sa = Math.sin(a);
    // Loaded radius shows up as a squashed tyre, so a soft landing reads soft.
    const sc = Math.max(0.90, Math.min(1.06, w.rEff / w.rGeo));
    // Three distinct vectors: makeBasis reads them after all three are built.
    _b1.set(fx * ca + _up.x * sa, fy * ca + _up.y * sa, fz * ca + _up.z * sa).normalize().multiplyScalar(sc);
    _b2.set(-fx * sa + _up.x * ca, -fy * sa + _up.y * ca, -fz * sa + _up.z * ca).normalize().multiplyScalar(sc);
    _b3.set(rx, ry, rz).normalize().multiplyScalar(sc);
    _m4.makeBasis(_b1, _b2, _b3);
    _m4.setPosition(lx, ly, lz);
    view.wheels.setMatrixAt(i, _m4);
  }
  view.wheels.instanceMatrix.needsUpdate = true;

  applyDamage(view, car);

  const sh = view.mat.userData.shader;
  if (sh) {
    const braking = car.input && car.input.brake > 0.05 ? 1 : 0;
    if (braking !== view.brakeOn) {
      view.brakeOn = braking;
      sh.uniforms.uTail.value = braking ? 2.2 : 0.4;
    }
    sh.uniforms.uHead.value = view.night ? (view.lightsOut ? 0.05 : 1.9) : 0.18;
    sh.uniforms.uDamage.value = car.damage ? car.damage.severityPct : 0;
  }
}

/**
 * Damage as physical state (PLAN §10.2 "uszkodzone/brakujace elementy"):
 * a knocked bumper is offset out of true, a smashed front lamp is dark and
 * cracked and, after enough hits, the lamp volume is simply gone. Runs only
 * when the damage state actually changes - no per-frame geometry writes.
 */
function applyDamage(view, car) {
  const d = car.damage;
  if (!d) return;
  const key = d.frontHits * 8 + (d.lights[0] ? 0 : 4) + (d.susp[0] < 0.85 ? 1 : 0) + (d.susp[2] < 0.85 ? 2 : 0);
  if (key === view.dmgKey) return;
  view.dmgKey = key;

  const geo = view.body.geometry;
  const pos = geo.getAttribute('position');
  const col = geo.getAttribute('color');
  view.lightsOut = !d.lights[0] && d.frontHits >= 3;

  for (const name of ['lampFL', 'lampFR']) {
    const r = view.regions[name];
    if (!r) continue;
    // "Zbita lampa = jeden element mniej": after enough front hits the whole
    // lamp volume is collapsed to a point (degenerate triangles, gone).
    const dead = view.lightsOut;
    let cx = 0, cy = 0, cz = 0;
    const cnt = r.pos.length / 3;
    for (let i = 0; i < r.pos.length; i += 3) { cx += r.pos[i]; cy += r.pos[i + 1]; cz += r.pos[i + 2]; }
    cx /= cnt; cy /= cnt; cz /= cnt;
    for (let i = r.range[0]; i < r.range[1]; i++) {
      const k = (i - r.range[0]) * 3;
      if (dead) pos.setXYZ(i, cx, cy, cz);
      else pos.setXYZ(i, r.pos[k], r.pos[k + 1], r.pos[k + 2]);
      const f = dead ? 0.2 : 1;
      col.setXYZ(i, r.col[k] * f, r.col[k + 1] * f, r.col[k + 2] * f);
    }
  }
  const bf = view.regions.bumperF;
  if (bf) {
    // Centroid of the pristine bumper: the dent is a rotation + offset about it.
    let cx = 0, cy = 0, cz = 0, count = 0;
    for (let i = 0; i < bf.pos.length; i += 3) { cx += bf.pos[i]; cy += bf.pos[i + 1]; cz += bf.pos[i + 2]; count++; }
    cx /= count; cy /= count; cz /= count;
    const hits = Math.min(3, d.frontHits);
    const gone = hits >= 3;
    const yaw = 0.10 * hits, dx = -0.055 * hits, dy = -0.03 * hits, dz = 0.05 * hits;
    const co = Math.cos(yaw), si = Math.sin(yaw);
    for (let i = bf.range[0]; i < bf.range[1]; i++) {
      const k = (i - bf.range[0]) * 3;
      const lx = bf.pos[k] - cx, ly = bf.pos[k + 1] - cy, lz = bf.pos[k + 2] - cz;
      if (gone) pos.setXYZ(i, cx, cy, cz);
      else pos.setXYZ(i, cx + lx * co - lz * si + dx, cy + ly + dy, cz + lx * si + lz * co + dz);
      const f = gone ? 1 : 1 - 0.18 * hits;
      col.setXYZ(i, bf.col[k] * f, bf.col[k + 1] * f, bf.col[k + 2] * f);
    }
  }
  pos.needsUpdate = true;
  col.needsUpdate = true;
  view.body.geometry.computeBoundingSphere();
}

// Wheel -> the arch panel of that wheel, for caked dirt on the tyre.
const WHEEL_ARCH = [8, 9, 10, 11];
const TYRE_BASE_R = 0.102, TYRE_BASE_G = 0.106, TYRE_BASE_B = 0.114;
// Linear tone the tyre tread is baked with (car-body.js CAR_MAT.rubber); the
// instance colour is the multiplier that turns it into dirty or polished rubber.
const BAKE = new THREE.Color(0x15161a);

/**
 * Push the dirt state into the shader textures and the tyre instances.
 * Called once per rendered frame, never allocates: the texel arrays and the
 * materials already exist and are written in place (docs/06 §1 "pule obiektów").
 */
export function updateCarDirt(view, car, dirt) {
  const pd = view.dtex;
  const panels = dirt.panels;

  for (let i = 0; i < PANEL_COUNT; i++) {
    const k = i * 4;
    pd.panelData[k] = Math.round(clamp01(panels.thick[i]) * 255);
    pd.panelData[k + 1] = Math.round(clamp01(panels.wet[i]) * 255);
    pd.panelData[k + 2] = Math.round(clamp01(panels.dust[i]) * 255);
    pd.panelData[k + 3] = Math.round(clamp01(panels.streak[i]) * 255);
    // A clean panel shows the paint tone, so a washed car really reads clean.
    const dirty = panels.load(i);
    if (dirty < 0.02) {
      pd.colData[k] = 255; pd.colData[k + 1] = 255; pd.colData[k + 2] = 255;
    } else {
      pd.colData[k] = Math.round(clamp01(panels.cr[i]) * 255);
      pd.colData[k + 1] = Math.round(clamp01(panels.cg[i]) * 255);
      pd.colData[k + 2] = Math.round(clamp01(panels.cb[i]) * 255);
    }
    pd.colData[k + 3] = 255;
  }
  pd.panelTex.needsUpdate = true;
  pd.colTex.needsUpdate = true;

  // The 1 MB spray field is a world field: it only needs a new upload when the
  // map actually changed, and at most every 100 ms (docs/07 render budget).
  if (dirt.map.dirtySeq !== pd.uploadSeq) {
    pd.uploadT += 1;
    if (pd.uploadT >= 6) { pd.uploadT = 0; pd.uploadSeq = dirt.map.dirtySeq; pd.sprayTex.needsUpdate = true; }
  }

  const sh = view.mat.userData.shader;
  if (sh) {
    sh.uniforms.uSpeed.value = car.body.groundSpeed;
    sh.uniforms.uSprayOrigin.value.set(dirt.map.originX, dirt.map.originZ);
  }

  // Tyres: rubber darkens and polishes the tread, caked dirt does the opposite
  // (docs/04 §4.2 "kanał gumy na oponach"). Per-instance colour multiply, so
  // one instanced draw call still shows four differently dirty wheels.
  const inst = view.wheels.instanceColor;
  for (let i = 0; i < 4; i++) {
    const rubber = clamp01(panels.rubber[i]);
    const arch = WHEEL_ARCH[i];
    const caked = clamp01(panels.thick[arch] * 0.8 + panels.dust[arch] * 0.5);
    const dr = panels.cr[arch], dg = panels.cg[arch], db = panels.cb[arch];
    const rr = TYRE_BASE_R * (1 - caked) * (1 - rubber) + dr * caked * 0.9 + 0.020 * rubber;
    const gg = TYRE_BASE_G * (1 - caked) * (1 - rubber) + dg * caked * 0.9 + 0.020 * rubber;
    const bb = TYRE_BASE_B * (1 - caked) * (1 - rubber) + db * caked * 0.9 + 0.024 * rubber;
    _col.setRGB(rr, gg, bb, THREE.SRGBColorSpace);
    _col2.setRGB(clampRatio(_col.r / BAKE.r), clampRatio(_col.g / BAKE.g), clampRatio(_col.b / BAKE.b));
    inst.setXYZ(i, _col2.r, _col2.g, _col2.b);
  }
  inst.needsUpdate = true;
}

function clampRatio(v) { return v < 0.25 ? 0.25 : (v > 2.2 ? 2.2 : v); }
function clamp01(v) { return v < 0 ? 0 : (v > 1 ? 1 : v); }
