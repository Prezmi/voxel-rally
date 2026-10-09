// Procedural rally car mesh (docs/06: zero asset files, everything built in code).
// Body is one merged geometry in car-local coords (X forward, Y up, Z right);
// the four wheels are separate meshes driven from the real Wheel state, so what
// you see is what the suspension is actually doing.
import * as THREE from 'three';
import { GeoBuilder } from './primitives.js';
import { PANELS, PANEL_COUNT, panelBoxes, classifyPanel } from '../dirt/panel-dirt.js';
import { MAP_TEXELS, MAP_METRES } from '../dirt/dirt-map.js';

const PAINT = 0xc7352b;
const PAINT_DARK = 0x8e2119;
const TRIM = 0xe8e4dc;
const GLASS = 0x2b3a44;
const DARK = 0x24262a;

function buildBodyGeometry(p) {
  const g = new GeoBuilder();
  const h = p.hull;

  // Main tub: sits between the hull floor and just under the greenhouse.
  g.box(0.05, h.cy + 0.02, 0, h.x - 0.22, 0.34, h.z - 0.04, PAINT, 1.0);
  // Nose and tail are narrower so the silhouette reads as a car, not a brick.
  g.box(h.x - 0.42, h.cy - 0.04, 0, 0.42, 0.26, h.z - 0.16, PAINT, 1.12);
  g.box(-(h.x - 0.40), h.cy - 0.05, 0, 0.40, 0.24, h.z - 0.14, PAINT_DARK, 1.0);
  // Greenhouse.
  g.box(-0.10, h.cy + 0.46, 0, 0.86, 0.24, h.z - 0.16, TRIM, 1.0);
  g.box(-0.10, h.cy + 0.47, 0, 0.80, 0.22, h.z - 0.20, GLASS, 1.05);
  // Roof panel.
  g.box(-0.14, h.cy + 0.70, 0, 0.72, 0.04, h.z - 0.22, TRIM, 1.18);
  // Livery stripe down each flank.
  g.box(0.10, h.cy + 0.06, h.z - 0.03, h.x - 0.55, 0.07, 0.02, TRIM, 1.0);
  g.box(0.10, h.cy + 0.06, -(h.z - 0.03), h.x - 0.55, 0.07, 0.02, TRIM, 1.0);
  // Bumpers + a rally front bar.
  g.box(h.x - 0.04, h.cy - 0.16, 0, 0.10, 0.10, h.z, DARK, 1.0);
  g.box(-(h.x - 0.04), h.cy - 0.14, 0, 0.10, 0.10, h.z, DARK, 1.0);
  g.box(h.x + 0.06, h.cy - 0.02, 0, 0.06, 0.20, h.z + 0.04, DARK, 0.85);
  // Rear wing on stalks.
  g.box(-(h.x - 0.16), h.cy + 0.52, h.z - 0.14, 0.05, 0.20, 0.05, DARK, 1.0);
  g.box(-(h.x - 0.16), h.cy + 0.52, -(h.z - 0.14), 0.05, 0.20, 0.05, DARK, 1.0);
  g.box(-(h.x - 0.16), h.cy + 0.74, 0, 0.20, 0.035, h.z - 0.04, TRIM, 1.1);
  // Sills.
  g.box(0, h.cy - 0.26, h.z - 0.02, h.x - 0.55, 0.06, 0.05, DARK, 0.9);
  g.box(0, h.cy - 0.26, -(h.z - 0.02), h.x - 0.55, 0.06, 0.05, DARK, 0.9);

  const geo = g.toGeometry(THREE);
  geo.computeVertexNormals();
  return geo;
}

function buildWheelGeometry(r, width) {
  // Tyre: a 14-sided drum with its axis along the car's Z (right).
  const tyre = new THREE.CylinderGeometry(r, r, width, 14, 1, false);
  tyre.rotateX(Math.PI / 2);
  const group = new THREE.Group();

  const tyreMat = new THREE.MeshStandardMaterial({ color: 0x1a1b1d, roughness: 0.95, metalness: 0.0 });
  const tyreMesh = new THREE.Mesh(tyre, tyreMat);
  tyreMesh.name = 'tyre';
  group.add(tyreMesh);

  // Hub + one spoke so wheel spin and lock are actually visible.
  const hubGeo = new THREE.CylinderGeometry(r * 0.52, r * 0.52, width + 0.03, 12, 1, false);
  hubGeo.rotateX(Math.PI / 2);
  const hubMesh = new THREE.Mesh(hubGeo, new THREE.MeshStandardMaterial({ color: 0x9aa1a6, roughness: 0.45, metalness: 0.6 }));
  group.add(hubMesh);

  const spoke = new THREE.BoxGeometry(r * 1.5, 0.05, width + 0.05);
  const spokeMesh = new THREE.Mesh(spoke, new THREE.MeshStandardMaterial({ color: 0x6d7479, roughness: 0.5, metalness: 0.5 }));
  spokeMesh.name = 'spoke';
  group.add(spokeMesh);

  group.userData.tyreMat = tyreMat;
  group.userData.tyreBase = tyreMat.color.clone();
  return group;
}

/**
 * Bake one panel index + airflow direction per body vertex (docs/04 §4.2: the
 * dirt layer is per panel, and the streaks run along the panel's airflow).
 * Done once at build time; the shader then only reads a float attribute.
 */
function bakePanelAttributes(geo, params) {
  const boxes = panelBoxes(params);
  const pos = geo.getAttribute('position');
  const n = pos.count;
  const panel = new Float32Array(n);
  const flow = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const p = classifyPanel(pos.getX(i), pos.getY(i), pos.getZ(i), boxes);
    panel[i] = p;
    const f = PANELS[p].flow;
    const l = Math.hypot(f[0], f[1], f[2]) || 1;
    flow[i * 3] = f[0] / l; flow[i * 3 + 1] = f[1] / l; flow[i * 3 + 2] = f[2] / l;
  }
  geo.setAttribute('aPanel', new THREE.BufferAttribute(panel, 1));
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
  const bodyGeo = buildBodyGeometry(p);
  bakePanelAttributes(bodyGeo, p);
  const bodyMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.55, metalness: 0.15 });
  const dtex = buildDirtTextures(dirt);
  attachDirtShader(bodyMat, dtex);
  const body = new THREE.Mesh(bodyGeo, bodyMat);
  body.castShadow = true;
  body.receiveShadow = true;

  const wheelWidth = 0.24;
  const wheels = car.wheels.map((w) => {
    const g = buildWheelGeometry(w.rGeo, wheelWidth);
    g.traverse((o) => { if (o.isMesh) { o.castShadow = true; } });
    return g;
  });

  const group = new THREE.Group();
  group.add(body);
  for (const w of wheels) group.add(w);

  return { group, body, wheels, spin: [0, 0, 0, 0], dtex, mat: bodyMat };
}

/**
 * Dirt layer in the car shader (docs/04 §4.2 "render brudu"): albedo darkening,
 * roughness change, normal perturbation and streaks (smugi) along the panel
 * airflow. Patched once into the standard material, so the car stays one draw
 * call and no material is ever rebuilt at runtime.
 */
function attachDirtShader(mat, dtex) {
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uPanelTex = { value: dtex.panelTex };
    shader.uniforms.uPanelCol = { value: dtex.colTex };
    shader.uniforms.uSprayTex = { value: dtex.sprayTex };
    shader.uniforms.uSprayOrigin = { value: new THREE.Vector2(0, 0) };
    shader.uniforms.uSpeed = { value: 0 };

    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aPanel;\nattribute vec3 aFlow;\nvarying float vPanel;\nvarying vec3 vFlow;\nvarying vec3 vLocal;\nvarying vec3 vWPos;\nvarying vec3 vObjNormal;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvPanel = aPanel;\nvFlow = aFlow;\nvLocal = transformed;\nvObjNormal = normal;\nvWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;');

    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
uniform sampler2D uPanelTex;
uniform sampler2D uPanelCol;
uniform sampler2D uSprayTex;
uniform vec2 uSprayOrigin;
uniform float uSpeed;
varying float vPanel;
varying vec3 vFlow;
varying vec3 vLocal;
varying vec3 vWPos;
varying vec3 vObjNormal;
// Dirt read once per fragment, reused by the roughness and the albedo/normal hook.
vec2 gPanelUv = vec2(0.0);
float gThick = 0.0, gWet = 0.0, gDust = 0.0, gStreak = 0.0;
vec3 gDirtCol = vec3(0.0);
float dhash1(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
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
  diffuseColor.rgb = col;

  // Micro-relief from the crust; moisture smooths it out.
  float n1 = dhash1(vLocal.xy * 190.0 + vLocal.z * 61.0 + gWet * 3.0);
  float n2 = dhash1(vLocal.yz * 97.0 - vLocal.x * 43.0);
  float relief = (n1 * 0.65 + n2 * 0.35 - 0.5);
  normal = normalize(normal + vec3(relief, relief * 0.6, -relief) * gThick * 0.35 * (1.0 - 0.5 * gWet));
}
`);
    mat.userData.shader = shader;
  };
  mat.customProgramCacheKey = () => 'vr-car-dirt';
}

const _m4 = new THREE.Matrix4();
const _v = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _up = new THREE.Vector3();

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

  for (let i = 0; i < car.wheels.length; i++) {
    const w = car.wheels[i];
    const g = view.wheels[i];
    view.spin[i] += w.omega * (1 / 120);
    if (view.spin[i] > 1e6) view.spin[i] %= (2 * Math.PI);

    // Basis: forward, up, right taken from the wheel's own axes so steer,
    // roll and pitch all show up on the tyre.
    const fx = w.forward.x, fy = w.forward.y, fz = w.forward.z;
    const rx = w.right.x, ry = w.right.y, rz = w.right.z;
    _up.set(ry * fz - rz * fy, rz * fx - rx * fz, rx * fy - ry * fx).normalize();

    const a = view.spin[i];
    const ca = Math.cos(a), sa = Math.sin(a);
    _m4.makeBasis(
      _v.set(fx * ca + _up.x * sa, fy * ca + _up.y * sa, fz * ca + _up.z * sa).normalize(),
      _v.set(-fx * sa + _up.x * ca, -fy * sa + _up.y * ca, -fz * sa + _up.z * ca).normalize(),
      _v.set(rx, ry, rz).normalize(),
    );
    g.position.set(w.hub.x, w.y, w.hub.z);
    g.quaternion.setFromRotationMatrix(_m4);
  }
}

// Wheel -> the arch panel of that wheel, for caked dirt on the tyre.
const WHEEL_ARCH = [8, 9, 10, 11];
const TYRE_BASE_R = 0.102, TYRE_BASE_G = 0.106, TYRE_BASE_B = 0.114;

/**
 * Push the dirt state into the shader textures and the tyre materials.
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

  // Tyres: rubber darkens and polishes the tread and survives washing
  // (docs/04 §4.2 "kanał gumy na oponach"); caked dirt does the opposite.
  for (let i = 0; i < view.wheels.length; i++) {
    const mat = view.wheels[i].userData.tyreMat;
    if (!mat) continue;
    const rubber = clamp01(panels.rubber[i]);
    const arch = WHEEL_ARCH[i];
    const caked = clamp01(panels.thick[arch] * 0.8 + panels.dust[arch] * 0.5);
    const dr = panels.cr[arch], dg = panels.cg[arch], db = panels.cb[arch];
    // Rubber: towards a shiny black. Caked dirt: towards the surface colour.
    const rr = TYRE_BASE_R * (1 - caked) * (1 - rubber) + dr * caked * 0.9 + 0.020 * rubber;
    const gg = TYRE_BASE_G * (1 - caked) * (1 - rubber) + dg * caked * 0.9 + 0.020 * rubber;
    const bb = TYRE_BASE_B * (1 - caked) * (1 - rubber) + db * caked * 0.9 + 0.024 * rubber;
    mat.color.setRGB(rr, gg, bb);
    mat.roughness = 0.95 - 0.42 * rubber + 0.04 * caked;
  }
}

function clamp01(v) { return v < 0 ? 0 : (v > 1 ? 1 : v); }
