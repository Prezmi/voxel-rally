// Procedural rally car (docs/06: zero asset files; PLAN §10.2 car look bible).
// One chamfered/lofted body volume (car-body.js) + one instanced wheel drawn at
// the four real Wheel states + a code-generated livery map (car-livery.js).
// Damage is shown as physically missing / knocked parts, never as a bar.
import * as THREE from 'three';
import { buildBodyGeometry, buildWheelGeometry, carShape } from './car-body.js';
import { loadModelNodes } from './assets.js';
import { ASSET_CAR_MODEL, WHEEL_NODES, buildAssetBody, defaultExhaust, tyreScale } from './car-asset.js';
import { TYRE_BASE } from '../car/car-params.js';
import { buildLiveryTexture } from './car-livery.js';
import { PANELS, PANEL_COUNT, PANEL_INDEX } from '../dirt/panel-dirt.js';
import { TYRE_TREAD, TYRE_TREAD_GLSL, wheelTreadPlan } from './tyre-tread.js';
import { MAP_TEXELS, MAP_METRES } from '../dirt/dirt-map.js';
import { BEAM, BEAM_VERT, BEAM_FRAG, beamAnchors, beamGeometry, beamMaterialSpec, isDark, setBeamGain } from './headlights.js';
import { settings } from '../core/settings.js';

/**
 * Pinned dust-film caps (docs/04). Read headless by src/debug/tests.js and
 * interpolated into the car shader below, so the numbers the test asserts are
 * the numbers the GPU runs. The upper body used to share the sills' 0.95 film
 * ceiling, which is exactly why a few seconds of gravel turned the rear chalky.
 */
export const DUST_FILM = {
  upperCap: 0.16,      // was 0.95 (one flat ceiling over the whole car)
  lowerCap: 0.92,      // sills, arch lids, rear bumper, behind the wheels
  rockerMix: 0.20,     // gHeight where the upper cap starts closing in
  rockerFull: 0.55,    // gHeight where it is fully in force
  archKeep: 0.42,      // gSrcN (distance from the throwing wheel) under which a panel keeps real splatter
  archCeil: 0.80,      // ...but only up to this gHeight, so the roof stays clean
  rearKeep: -0.35,     // vLocal.x behind which the rear keeps splatter (still low only)
  dustGain: 0.34,      // was 0.50: dry dust's share of the film
  windLo: 16.7,        // m/s ~ 60 km/h: dust starts to blow off (was 5.0)
  windHi: 30.0,        // was 26.0
  windMax: 0.86,       // was 0.55: a fast car runs far cleaner than a slow one
  veilCap: 0.14,       // was 0.40: the pale dry veil is a thin sheen now
  veilHeight: 0.30,    // the veil is already 70% gone by this gHeight
  streakMix: 0.70,     // the veil rides the airflow bands instead of a flat haze
  streakKeep: 0.30,    // how much haze survives between the streaks
};

/** GLSL needs a float literal; JS prints 30 as "30" and smoothstep then has no overload. */
export function glslFloat(n) {
  const v = Number(n);
  return Number.isInteger(v) ? v.toFixed(1) : String(v);
}

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

/**
 * The night beams for one car body: a SpotLight pool per lamp, plus an additive open
 * cone shell per lamp so the shaft itself is visible in clear air (a light with nothing
 * in it draws nothing). Aim, reach, blend flags and triangle cost come from
 * render/headlights.js - the suite pins those numbers - only the THREE plumbing lives
 * here. Hung on the car group, so syncCarMesh's pose is all the beams ever need.
 */
function attachHeadlights(group, shape) {
  const data = beamGeometry();
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(data.position, 3));
  geo.setAttribute('aFade', new THREE.BufferAttribute(data.aFade, 1));
  geo.setIndex(new THREE.BufferAttribute(data.index, 1));
  geo.computeBoundingSphere();
  const spec = beamMaterialSpec();
  const mat = new THREE.ShaderMaterial({
    uniforms: { uColor: { value: new THREE.Color(BEAM.color) }, uGain: { value: BEAM.gain } },
    vertexShader: BEAM_VERT,
    fragmentShader: BEAM_FRAG,
    transparent: spec.transparent,
    blending: THREE[spec.blending],
    depthWrite: spec.depthWrite,
    depthTest: spec.depthTest,
    side: THREE[spec.side],
    toneMapped: spec.toneMapped,
  });

  const lights = [], shells = [];
  const fwd = new THREE.Vector3(1, 0, 0), dir = new THREE.Vector3();
  for (const a of beamAnchors(shape)) {
    const sl = new THREE.SpotLight(BEAM.color, BEAM.spot.intensity, BEAM.spot.distance,
      BEAM.spot.angle, BEAM.spot.penumbra, BEAM.spot.decay);
    sl.position.set(a.pos[0], a.pos[1], a.pos[2]);
    sl.target.position.set(a.pool[0], a.pool[1], a.pool[2]);
    sl.castShadow = false;               // no extra depth pass for a 20 m pool
    group.add(sl);
    group.add(sl.target);
    lights.push(sl);

    const shell = new THREE.Mesh(geo, mat);
    shell.position.set(a.pos[0], a.pos[1], a.pos[2]);
    dir.set(a.dir[0], a.dir[1], a.dir[2]);
    shell.quaternion.setFromUnitVectors(fwd, dir);
    shell.castShadow = false;
    shell.receiveShadow = false;
    group.add(shell);
    shells.push(shell);
  }
  return { lights, shells, mat, geo, tris: data.tris * 2 };
}

export function buildCarMesh(car, dirt) {
  const p = car.params;
  const shape = carShape(p);
  const built = buildBodyGeometry(car);
  bakeFlowAttributes(built.geo);

  const dtex = buildDirtTextures(dirt);
  const livery = buildLiveryTexture(p.id, THREE);
  const bodyMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.52, metalness: 0.18 });
  attachCarShader(bodyMat, dtex, livery, p, built.geo);

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

  // Headlights only light the road when the stage is dark (per-stage tod). A light
  // alone is invisible in clear air, so render/headlights.js adds the shaft too:
  // two additive cone shells, 96 triangles, no shadow map (queue P8).
  const tod = typeof settings.tod === 'number' ? settings.tod : 0.7;
  const night = isDark(tod);
  const headlights = night ? attachHeadlights(group, shape) : null;
  const beams = headlights ? headlights.lights : [];

  const view = {
    group, body, wheels, spin: [0, 0, 0, 0], dtex, mat: bodyMat, livery,
    shape, regions, beams, headlights, night, dmgKey: -1, brakeOn: -1,
    tris: { body: built.tris, wheel: wheel.tris }, asset: false, carParams: p,
    // Exhaust tip points in the car-group frame, for src/fx/fx.js. The asset car
    // overwrites these with the real car_exhaust_l / car_exhaust_r nodes.
    exhaustLocal: defaultExhaust(p),
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
 * steer + loaded radius). No colour of any kind is written here - each wheel
 * keeps the material it was exported with.
 */
function makeWheelPivots(pivots) {
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
      setXYZ() {},                       // neutral: no tyre tint, no material override
    },
  };
}

function adoptAssetCar(view, proceduralWheels) {
  return loadModelNodes(ASSET_CAR_MODEL).then((nodes) => {
    if (!nodes || !nodes.size) {
      // An empty map says nothing about the file - it is what the loader returns
      // for a lost fetch just as much as for a nameless glb. Report the reason
      // the loader recorded instead of re-blaming the asset every pass (P41).
      logAssetCar(false, `loader: ${(nodes && nodes.reason) || 'empty node map'}`);
      return false;
    }
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
    if (built.exhaust) view.exhaustLocal.set(built.exhaust);

    // Wheels: the exported pivots, uniformly scaled so the tyre radius lands on
    // TYRE_BASE.r; positions come from the physics state every frame anyway.
    const ts = tyreScale(nodes, TYRE_BASE.r, WHEEL_NODES[0]);
    const pivots = [];
    for (let i = 0; i < 4; i++) {
      const node = wheelRecs[i].node;
      if (node.parent) node.parent.remove(node);
      node.position.set(0, 0, 0);
      node.scale.set(ts, ts, ts);
      node.castShadow = true;
      node.receiveShadow = true;
      // Keep the wheel's OWN materials. Collapsing the multi-primitive wheel onto
      // material[0] plus the arch-dirt patch is what turned every wheel into one
      // flat brown disc: rubber, alloy face, spokes and hub nut all shared a single
      // tinted material (shots/showroom.png). Rubber/sidewall alone take the dirt
      // response; the alloy, spokes and the nut stay clean and keep their contrast.
      const archKey = ['archFL', 'archFR', 'archRL', 'archRR'][i] || 'archRL';
      const parts = [];
      node.traverse((c) => {                   // multi-primitive wheel: Group of meshes
        if (!c.isMesh) return;
        c.castShadow = true;
        c.receiveShadow = true;
        parts.push(c);
      });
      const isRubber = (c) => {
        const src = Array.isArray(c.material) ? c.material[0] : c.material;
        return /tyre|rubber|sidewall/i.test(String((src && src.name) || c.name || ''));
      };
      // One tread plan per wheel, measured over the whole rubber family. Deriving it from
      // each primitive's own bbox (the old behaviour) renormalizes the tyre radius per
      // part, and the crown mask then decides the outboard rubber faces ARE the tread:
      // the shipped sidewall ring (radius 0.21-0.25 m) drew 27 lugs across the flank, at
      // a pitch that did not line up with the 38 lugs of the rolling band.
      const rubber = parts.filter(isRubber);
      const plan = rubber.length ? wheelTreadPlan(rubber.map((c) => geometrySize(c.geometry))) : null;
      const tyreMats = [];
      for (const c of parts) {
        const src = Array.isArray(c.material) ? c.material[0] : c.material;
        const mat = src && src.clone ? src.clone() : new THREE.MeshStandardMaterial({ roughness: 0.9, metalness: 0.08 });
        mat.vertexColors = false;
        const nm = String(mat.name || (src && src.name) || '');
        if (/tyre|rubber|sidewall/i.test(nm)) {
          attachTyreDirt(mat, view.dtex, PANEL_INDEX[archKey], c.geometry, plan);
          tyreMats.push(mat);
        }
        c.material = mat;
      }
      node.material = null;
      (view.tyreMats || (view.tyreMats = []))[i] = tyreMats;
      const pivot = new THREE.Object3D();
      pivot.matrixAutoUpdate = false;
      pivot.add(node);
      view.group.add(pivot);
      pivots.push(pivot);
    }
    view.group.remove(proceduralWheels);
    view.wheels = makeWheelPivots(pivots);
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
function attachCarShader(mat, dtex, livery, p, geo) {
  geo.computeBoundingBox();
  const bb = geo.boundingBox;
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
    shader.uniforms.uCar = { value: new THREE.Vector4(bb.min.y + 0.02, bb.max.y,
      p.wheelbase / 2, (p.trackFront + p.trackRear) / 4) };
    shader.uniforms.uHub = { value: new THREE.Vector4(bb.min.y + TYRE_BASE.r, TYRE_BASE.r,
      p.hull.x, p.hull.z) };

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
uniform vec4 uCar;   // rocker Y, roof Y, half wheelbase, half track
uniform vec4 uHub;   // hub Y, tyre radius, hull X, hull Z
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
// Per-fragment dirt shape, computed once in the roughness hook and reused.
float gCov = 0.0, gWind = 0.0, gSrcN = 0.0, gHeight = 0.0, gSpatter = 0.0, gFilmCap = 1.0;
float dhash1(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float dhash3(vec3 p) { return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453); }
// Cheap value noise: the splatter has to be stationary in car space, never a
// scrolling screen pattern.
float vnoise(vec3 p) {
  vec3 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = mix(mix(dhash3(i), dhash3(i + vec3(1.0, 0.0, 0.0)), f.x),
                mix(dhash3(i + vec3(0.0, 1.0, 0.0)), dhash3(i + vec3(1.0, 1.0, 0.0)), f.x), f.y);
  float b = mix(mix(dhash3(i + vec3(0.0, 0.0, 1.0)), dhash3(i + vec3(1.0, 0.0, 1.0)), f.x),
                mix(dhash3(i + vec3(0.0, 1.0, 1.0)), dhash3(i + vec3(1.0, 1.0, 1.0)), f.x), f.y);
  return mix(a, b, f.z);
}
`)
      .replace('#include <color_fragment>', `#include <color_fragment>
{
  // Livery (PLAN §10.2): the generated map IS the paint of a body panel. The
  // old line multiplied the exported red by the map red, so every painted panel
  // came out as red^2 (muddy, dark, and the pale decals went grey). Painted
  // panels now take the map colour directly; unpainted parts (glass, trim,
  // carbon, lamps) keep the exported material colour via vLiv = 0.
  vec3 lv = texture2D(uLivery, clamp(vLivUv, 0.03, 0.97)).rgb;
  diffuseColor.rgb = mix(diffuseColor.rgb, lv, vLiv);
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

  // --- WHERE dirt may sit on this fragment (docs/04 "render brudu") ---------
  // Never a uniform film: height above the rocker, distance travelled from the
  // throwing wheels, and two octaves of stationary noise that break the plate
  // into droplets, runs and patches.
  float span = max(0.05, uCar.y - uCar.x);
  gHeight = clamp((vLocal.y - uCar.x) / span, 0.0, 1.0);
  vec3 c0 = vLocal - vec3(uCar.z, uHub.x, uCar.w);
  vec3 c1 = vLocal - vec3(uCar.z, uHub.x, -uCar.w);
  vec3 c2 = vLocal - vec3(-uCar.z, uHub.x, uCar.w);
  vec3 c3 = vLocal - vec3(-uCar.z, uHub.x, -uCar.w);
  float near = min(min(length(c0), length(c1)), min(length(c2), length(c3)));
  gSrcN = clamp(max(0.0, near - uHub.y) / max(0.05, uCar.z * 1.55), 0.0, 1.0);

  float grime = mix(1.45, 0.10, smoothstep(0.06, 0.62, gHeight))   // low panels caked
    * mix(1.30, 0.28, smoothstep(0.0, 0.92, gSrcN))                // thrown from the wheels
    * (1.0 + 0.30 * smoothstep(0.25, -0.85, vLocal.x) * (1.0 - gHeight)); // rear flank
  grime *= 1.0 - 0.62 * clamp(vObjNormal.y, 0.0, 1.0) * smoothstep(0.22, 0.72, gHeight);

  float blobs = vnoise(vLocal * vec3(3.0, 4.4, 3.0));
  float speck = vnoise(vLocal * vec3(11.5, 13.5, 11.5));
  gSpatter = 0.22 + 1.10 * smoothstep(0.30, 0.88, blobs * 0.62 + speck * 0.48);
  // Loose dry dust blows off progressively from ~60 km/h up, so a fast car is
  // cleaner than a slow one instead of ending the stage powdered.
  gWind = 1.0 - ${glslFloat(DUST_FILM.windMax)} * smoothstep(${glslFloat(DUST_FILM.windLo)}, ${glslFloat(DUST_FILM.windHi)}, uSpeed);

  // Ceiling on the film, keyed to where dust may physically sit. Only the low
  // zone - sills and lower flanks, the arch lids, the rear bumper, everything
  // right behind a throwing wheel - may hold a real splatter plate; above the
  // rocker line the same dust is capped to a thin sheen, so the red survives.
  float lowH = 1.0 - smoothstep(${glslFloat(DUST_FILM.rockerMix)}, ${glslFloat(DUST_FILM.rockerFull)}, gHeight);
  float arch = (1.0 - smoothstep(0.0, ${glslFloat(DUST_FILM.archKeep)}, gSrcN))
    * (1.0 - smoothstep(${glslFloat(DUST_FILM.archCeil)}, ${glslFloat(DUST_FILM.archCeil)} + 0.2, gHeight));
  float rear = (1.0 - smoothstep(${glslFloat(DUST_FILM.rearKeep)}, ${glslFloat(DUST_FILM.rearKeep)} + 0.45, vLocal.x)) * lowH;
  gFilmCap = mix(${glslFloat(DUST_FILM.upperCap)}, ${glslFloat(DUST_FILM.lowerCap)}, clamp(max(lowH, max(arch, rear)), 0.0, 1.0));
  gCov = clamp((gThick * 0.95 + gDust * ${glslFloat(DUST_FILM.dustGain)} * gWind) * grime * gSpatter, 0.0, gFilmCap);

  // docs/04: rough = mix(rough, mix(0.95, 0.35, wet), thick) - wet mud glints.
  roughnessFactor = mix(roughnessFactor, mix(0.95, 0.35, gWet), clamp(gCov * 1.10 + gDust * 0.30 * gWind, 0.0, 1.0));
}
`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
{
  vec3 dirtCol = gDirtCol * (1.0 - 0.25 * gWet);
  float film = gCov;

  // Streaks: bands across the panel's airflow, dragged rearwards, only while the
  // panel is wet enough and the car is moving (docs/04 "smugi").
  float along = dot(vLocal, vFlow);
  vec3 perp3 = vLocal - vFlow * along;
  float bandF = (perp3.x * 1.4 + perp3.y * 4.0 + perp3.z * 6.0) * 5.0;
  float band = floor(bandF);
  float h = dhash1(vec2(band, 7.13));
  float wdt = 0.14 + 0.40 * h;                                       // runs differ in width
  float across = 1.0 - smoothstep(wdt * 0.5, wdt * 0.5 + 0.16, abs(fract(bandF + h * 0.31) - 0.5));
  float tail = pow(fract(-along * 0.26 + h * 0.55), 0.45);            // long, fading tails
  float streakMask = step(0.45, h) * gStreak * across * tail
    * (0.40 + 0.95 * (1.0 - gSrcN)) * (0.30 + 0.95 * (1.0 - gHeight))
    * smoothstep(0.15, 0.50, gThick + gWet * 0.5) * smoothstep(3.0, 13.0, uSpeed);

  vec3 col = mix(diffuseColor.rgb, dirtCol, film);
  col = mix(col, dirtCol * 0.85, clamp(streakMask, 0.0, 0.85));
  // Dry dust is a pale veil, not a dark plate - that is what keeps gravel dust
  // looking like dust rather than like mud (docs/04 risk R4).
  float veil = clamp(gDust * 0.30 * gWind, 0.0, ${glslFloat(DUST_FILM.veilCap)}) * clamp(film * 2.2, 0.0, 1.0)
    * (0.35 + 0.65 * gSpatter) * (1.0 - gWet)
    * (1.0 - 0.7 * smoothstep(0.0, ${glslFloat(DUST_FILM.veilHeight)}, gHeight));
  // Streaky, never a uniform haze: the dry veil rides the same airflow bands as
  // the wet runs, so it reads as brushed-off streaks with clean panel between.
  float haze = ${DUST_FILM.streakKeep} + (1.0 - ${DUST_FILM.streakKeep}) * clamp(across * 1.8, 0.0, 1.0);
  veil *= mix(1.0, haze, ${DUST_FILM.streakMix});
  col = mix(col, dirtCol * 1.22 + vec3(0.14), veil);

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
  normal = normalize(normal + vec3(relief, relief * 0.6, -relief) * gCov * 0.45 * (1.0 - 0.5 * gWet));
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

/** Axis-aligned extents of a geometry, as [x, y, z] metres. */
function geometrySize(geo) {
  geo.computeBoundingBox();
  const b = geo.boundingBox;
  return [b.max.x - b.min.x, b.max.y - b.min.y, b.max.z - b.min.z];
}

/**
 * Tyre dirt response (docs/04 §4.2): the exported tyre material keeps its own
 * maps, but the rubber reads the same per-panel dirt state the body reads - the
 * arch of that corner - and lays it on the sidewall and the inner face only.
 * Fresh rubber stays near-black; caked rubber takes the panel's brown-grey.
 *
 * `wheelPlan` is the WHEEL's tread plan (wheelTreadPlan over its rubber family), not
 * this primitive's: the shader normalizes both the radius (`rr`) and the axial position
 * (`side`) by it, so a part measured on its own ruler grows tread where the tyre has
 * none - which is the half of P12 this patch had left open.
 */
function attachTyreDirt(mat, dtex, panelIdx, geo, wheelPlan) {
  geo.computeBoundingBox();
  const s = geo.boundingBox.getSize(new THREE.Vector3());
  // The rolling axis is still read off this part, because the two tread directions are
  // per-geometry tangents; only the pattern's RULER is shared (wheelTreadPlan).
  const axis = new THREE.Vector3(0, 0, 0);
  let ai = 0;
  if (s.y < s.x && s.y < s.z) ai = 1; else if (s.z < s.x && s.z < s.y) ai = 2;
  axis.setComponent(ai, 1);
  // Angle zero for the tread field: any in-plane unit axis, so that
  // cross(axis, u) is the second one and atan2 gives the bearing around the wheel.
  const uAxis = new THREE.Vector3();
  uAxis.setComponent(ai === 0 ? 1 : 0, 1);
  // The pattern's ruler, once per wheel. Everything below reads its pitch, its crown
  // bands and its relief depths off this one object.
  const plan = wheelPlan || wheelTreadPlan([s.x, s.y, s.z]);
  const halfW = plan.halfW, rMax = plan.rMax;

  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uPanelTex = { value: dtex.panelTex };
    shader.uniforms.uPanelCol = { value: dtex.colTex };
    shader.uniforms.uTyreUv = { value: new THREE.Vector2((panelIdx + 0.5) / PANEL_COUNT, 0.5) };
    shader.uniforms.uTyreAxis = { value: axis };
    shader.uniforms.uTyreU = { value: uAxis };
    shader.uniforms.uTyreDims = { value: new THREE.Vector2(Math.max(1e-3, halfW), Math.max(1e-3, rMax)) };
    shader.uniforms.uTyreTread = { value: new THREE.Vector4(...plan.tread) };
    shader.uniforms.uTyreCrown = { value: new THREE.Vector4(...plan.crown) };
    shader.uniforms.uTyreRelief = { value: new THREE.Vector4(...plan.relief) };
    shader.uniforms.uTyreRib = { value: plan.rib };
    shader.uniforms.uTyreGroove = { value: plan.groove };
    shader.uniforms.uSpeed = { value: 0 };
    shader.uniforms.uRubber = { value: 0 };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
uniform vec3 uTyreAxis;
uniform vec3 uTyreU;
uniform vec4 uTyreCrown;
varying vec3 vTyreP;
varying vec3 vTyreN;
varying vec3 vTyreT1;
varying vec3 vTyreT2;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
vTyreP = transformed;
vTyreN = objectNormal;
{
  // The two tread directions, taken to view space here because normalMatrix only
  // exists in this stage - the fragment shader gets unit vectors it can tilt the normal
  // with directly, instead of the body shader's object-space fudge.
  vec3 rv = transformed - dot(transformed, uTyreAxis) * uTyreAxis;
  vec3 tg = cross(uTyreAxis, rv);
  float tl = length(tg);
  vTyreT1 = normalMatrix * (tl > 1e-5 ? tg / tl : uTyreU);
  vTyreT2 = normalMatrix * uTyreAxis;
}`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
uniform sampler2D uPanelTex;
uniform sampler2D uPanelCol;
uniform vec2 uTyreUv;
uniform vec3 uTyreAxis;
uniform vec3 uTyreU;
uniform vec2 uTyreDims;
uniform float uSpeed;
uniform float uRubber;
varying vec3 vTyreP;
varying vec3 vTyreN;
varying vec3 vTyreT1;
varying vec3 vTyreT2;
float gTyreCaked = 0.0;
float gTyreWet = 0.0;
float gTyreH = 0.0, gTyreCrown = 0.0, gTyreSide = 0.0;
vec2 gTyrePat = vec2(0.0);
${TYRE_TREAD_GLSL}
float dhash3(vec3 p) { return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453); }
float vnoise(vec3 p) {
  vec3 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = mix(mix(dhash3(i), dhash3(i + vec3(1.0, 0.0, 0.0)), f.x),
                mix(dhash3(i + vec3(0.0, 1.0, 0.0)), dhash3(i + vec3(1.0, 1.0, 0.0)), f.x), f.y);
  float b = mix(mix(dhash3(i + vec3(0.0, 0.0, 1.0)), dhash3(i + vec3(1.0, 0.0, 1.0)), f.x),
                mix(dhash3(i + vec3(0.0, 1.0, 1.0)), dhash3(i + vec3(1.0, 1.0, 1.0)), f.x), f.y);
  return mix(a, b, f.z);
}
`)
      .replace('#include <map_fragment>', `#include <map_fragment>
{
  vec4 pd = texture2D(uPanelTex, uTyreUv);
  float thick = clamp(pd.r, 0.0, 1.0);
  float dust = clamp(pd.b, 0.0, 1.0);
  float wet = clamp(pd.g, 0.0, 1.0);
  vec3 dc = texture2D(uPanelCol, uTyreUv).rgb;

  float ax = dot(vTyreP, uTyreAxis);
  vec3 rad = vTyreP - ax * uTyreAxis;
  float rr = length(rad) / uTyreDims.y;          // 1 at the tread, 0 at the hub
  float side = abs(ax) / uTyreDims.x;            // 1 outboard / inboard
  float facing = 1.0 - clamp(abs(dot(normalize(vTyreN + vec3(1e-4)), uTyreAxis)), 0.0, 1.0);

  float sidewall = smoothstep(0.30, 0.90, side) * smoothstep(0.60, 0.95, rr);
  float inner = smoothstep(0.70, 0.42, rr) * (1.0 - facing * 0.35);
  float spatter = 0.25 + 1.0 * smoothstep(0.28, 0.86, vnoise(vTyreP * vec3(13.0, 13.0, 13.0)));
  float wind = 1.0 - 0.45 * smoothstep(6.0, 30.0, uSpeed);
  float amt = clamp((thick * 1.05 + dust * 1.00) * wind * spatter, 0.0, 1.0);
  gTyreCaked = clamp(amt * (0.30 + 0.95 * clamp(sidewall + inner, 0.0, 1.0)), 0.0, 0.92);
  gTyreWet = wet;

  // The block tread (queue P12). A height field in the wheel's own coordinates, so it
  // spins with the wheel and adds no geometry: 0 triangles, and it is what makes a tyre
  // read as rubber with lugs rather than as a drum, clean or caked.
  gTyreSide = clamp(side, 0.0, 1.0);
  gTyreCrown = tyreCrown(rr, gTyreSide);
  float ang = atan(dot(rad, cross(uTyreAxis, uTyreU)), dot(rad, uTyreU));
  gTyrePat = vec2(ang * uTyreTread.x, ax * uTyreTread.y);
  gTyreH = tyreTreadCell(gTyrePat.x, gTyrePat.y, gTyreCrown, gTyreSide);

  vec3 caked = mix(dc * 0.55 + vec3(0.10, 0.085, 0.065), vec3(0.20, 0.155, 0.115), 0.45);
  // Mud packs in the grooves and wears off the block tops, so a caked tyre keeps the
  // pattern's own contrast instead of becoming one flat brown band.
  caked *= mix(1.0 - 0.55 * uTyreGroove, 1.0 + 0.35 * uTyreGroove, gTyreH);
  diffuseColor.rgb = mix(diffuseColor.rgb * (1.0 - 0.22 * clamp(uRubber, 0.0, 1.0)), caked, gTyreCaked);
}
`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
{
  // Damper, glossier mud down in the groove; dry crust on the worn block tops.
  float rough = mix(0.86, 0.97, gTyreCaked) * mix(1.0 - 0.18 * uTyreGroove, 1.0, gTyreH);
  roughnessFactor = mix(roughnessFactor, rough, clamp(gTyreCaked + 0.25 * clamp(uRubber, 0.0, 1.0), 0.0, 1.0));
}
`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
{
  // Tread relief (queue P12): the forward-difference gradient of the height field,
  // mapped from pattern units to metres of tyre surface, tilts the normal by the lug
  // depth that survives the crust. The tyre used to write colour and roughness only and
  // never touched the normal at all, which is why a caked wheel had no shape.
  if (gTyreCrown > 0.0) {
    float e = ${TYRE_TREAD.fd};
    float dhb = (tyreTreadCell(gTyrePat.x + e, gTyrePat.y, gTyreCrown, gTyreSide) - gTyreH) / e;
    float dhc = (tyreTreadCell(gTyrePat.x, gTyrePat.y + e, gTyreCrown, gTyreSide) - gTyreH) / e;
    vec3 g = vTyreT1 * (dhb * uTyreTread.x / max(1e-3, uTyreDims.y)) + vTyreT2 * (dhc * uTyreTread.y);
    float amp = uTyreRelief.x
      * mix(1.0, uTyreRelief.z, clamp(gTyreCaked, 0.0, 1.0))
      * (1.0 - uTyreRelief.w * clamp(gTyreWet, 0.0, 1.0))
      * gTyreCrown;
    vec3 off = g * amp;
    float m = length(off);
    off *= min(1.0, uTyreRelief.y / max(m, 1e-4));
    normal = normalize(normal - off);
  }
}
`);
    mat.userData.shader = shader;
  };
  mat.customProgramCacheKey = () => 'vr-car-tyre';
}

const _m4 = new THREE.Matrix4();
const _v = new THREE.Vector3();
const _b1 = new THREE.Vector3();
const _b2 = new THREE.Vector3();
const _b3 = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _qi = new THREE.Quaternion();
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
  // A smashed lamp cluster has to stop throwing light, not just stop glowing: the
  // pool and the shaft follow the same state as the uHead emissive term.
  setBeamGain(view.headlights, view.lightsOut ? BEAM.dimmed : 1);

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

  // Tyres are drawn with the material the glb exported; the dirt response is a
  // shader patch on those same materials, fed the corner's panel state (no
  // per-wheel colour, so rubber and alloy can never read as one flat tint).
  if (view.tyreMats) {
    for (let i = 0; i < 4; i++) {
      const list = Array.isArray(view.tyreMats[i]) ? view.tyreMats[i] : [view.tyreMats[i]];
      for (const m of list) {
        const ts = m && m.userData && m.userData.shader;
        if (!ts) continue;
        ts.uniforms.uSpeed.value = car.body.groundSpeed;
        ts.uniforms.uRubber.value = panels.rubber ? clamp01(panels.rubber[i]) : 0;
      }
    }
  }
}
function clamp01(v) { return v < 0 ? 0 : (v > 1 ? 1 : v); }
