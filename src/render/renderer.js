// Renderer shell: WebGLRenderer, light rig, sky/fog, procedural terrain material,
// quality scaling, shadow fit, post composite (docs/06 §2 render/renderer.js).
// Lighting + tone decisions follow docs/04 §1 and PLAN.md §10 (Colin McRae Rally:
// warm key, cool sky fill, long shadows, saturated-but-earthly palette).
import * as THREE from 'three';
import { QUALITY, settings } from '../core/settings.js';
import { createLightRig, lightingFor } from './lighting.js';
import { PostChain } from './post.js';
import { surfaceTones } from '../world/palette.js';

const SHADOW_PRESET = [
  // LOW / MED / HIGH. `span` is the half-extent of the orthographic shadow frustum
  // centred on the car: smaller span -> bigger texels of detail -> the contact
  // shadow and the corner posts read instead of dissolving (PLAN §10 criterion 4).
  { span: 58, map: 1024, dist: 150, bias: -0.0009, normalBias: 0.055, type: THREE.PCFShadowMap },
  { span: 46, map: 1536, dist: 150, bias: -0.00055, normalBias: 0.042, type: THREE.PCFSoftShadowMap },
  { span: 38, map: 2048, dist: 140, bias: -0.00035, normalBias: 0.030, type: THREE.PCFSoftShadowMap },
];

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(62, 1, 0.25, 900);

    // ---- light rig: warm key + cool sky fill + hemisphere ambient (docs/04 §1) ----
    this.rig = createLightRig();
    this.tod = 0.68;                      // golden hour is the reference look (PLAN §10)
    this.biome = 'FOREST';

    this.hemi = new THREE.HemisphereLight(0xbcd4e6, 0x40473a, 1.05);
    this.scene.add(this.hemi);

    this.sun = new THREE.DirectionalLight(0xfff2dc, 2.1);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(1536, 1536);
    this.sun.shadow.camera.near = 1;
    this.sun.shadow.camera.far = 320;
    this.sun.shadow.camera.left = -46; this.sun.shadow.camera.right = 46;
    this.sun.shadow.camera.top = 46; this.sun.shadow.camera.bottom = -46;
    this.sun.shadow.bias = -0.00055;
    this.sun.shadow.normalBias = 0.042;
    this.scene.add(this.sun);
    this.scene.add(this.sun.target);

    // Cool fill from the opposite side of the key so shadow sides never go black
    // (PLAN §10 "chłodny fill"). No shadows: it costs no shadow map.
    this.fill = new THREE.DirectionalLight(0x9fc0e0, 0.55);
    this.scene.add(this.fill);

    this.skyColor = new THREE.Color(0x8fb4cc);
    this.fogColor = new THREE.Color(0x9db4c4);
    this.wet = 0;
    this.hazeBias = 1;
    this.overcast = 0;
    this.biomeSky = new THREE.Color(0x8fb4cc);
    this.biomeFog = new THREE.Color(0x9db4c4);
    this.scene.background = this.skyColor;
    this.scene.fog = new THREE.Fog(this.fogColor, 130, settings.drawDistance * 1.5);

    this.terrainMaterial = null;
    this.propMaterial = null;
    this.carMaterial = null;
    this._buildMaterials();

    this.post = new PostChain(this.renderer);
    this.post.shafts = true;

    this.info = { calls: 0, tris: 0 };
    this._time = 0;
    this._snap = new THREE.Vector3();
    this._right = new THREE.Vector3();
    this._up = new THREE.Vector3();
    this._center = new THREE.Vector3();
    this._shadowSpan = 46;
    this._satCol = new THREE.Color();
    this.setBiome({ sky: 0x8fb4cc, fog: 0x9db4c4 }, 'FOREST');
    this.setQuality(settings.quality);
  }

  _buildMaterials() {
    // Terrain: palette colour + baked vertex AO + baked normal tilt from the mesher,
    // then multi-octave value noise in the shader keyed by WORLD position (never
    // chunk-local: a per-chunk seed is exactly what makes a visible chunk seam).
    // The corridor skin is not watertight: the mesh height grid is snapped to 1/8 m
    // (mesher BED_GRID) and neighbouring chunks are meshed at different LODs, so at
    // the seams and at a carve lip there are hairline vertical cracks. With
    // FrontSide a crack is a hole and the frame shows the empty-scene colour
    // (measured sRGB 191,188,191) straight through it - those were the "pale
    // plates": they survived every terrain/prop material test because they were
    // never a surface at all. DoubleSide renders the far wall of the crack instead:
    // same triangles, same draw calls, no new asset.
    const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.92, metalness: 0.0, side: THREE.DoubleSide });
    const tonePairs = surfaceTones();
    const ta = [], tb = [];
    for (let i = 0; i < tonePairs.a.length; i++) { ta.push(new THREE.Color(tonePairs.a[i])); tb.push(new THREE.Color(tonePairs.b[i])); }
    m.onBeforeCompile = (shader) => {
      shader.uniforms.uTintA = { value: ta };
      shader.uniforms.uTintB = { value: tb };
      shader.uniforms.uWet = { value: 0 };      // stage weather wetness (PLAN §10.2)
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nattribute float aSurface;\nvarying float vSurface;\nvarying vec3 vWPos;\nvarying vec3 vWNormal;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvSurface = aSurface;\nvWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;\nvWNormal = (modelMatrix * vec4(objectNormal, 0.0)).xyz;');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>
varying float vSurface;
varying vec3 vWPos;
varying vec3 vWNormal;
uniform vec3 uTintA[11];
uniform vec3 uTintB[11];
uniform float uWet;

// Integer hash -> [0,1): cheaper than the sin-hash it replaces, and it is a pure
// function of world position, so a panel gets the same tone from any chunk or LOD.
float h21(vec2 p) {
  p = fract(p * vec2(127.1, 311.7));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = h21(i), b = h21(i + vec2(1.0, 0.0));
  float c = h21(i + vec2(0.0, 1.0)), d = h21(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}
// Three octaves: 6 m patches (hue drift), 2 m tiles (tone), 25 cm grit.
float fbm3(vec2 p) {
  return 0.55 * vnoise(p) + 0.30 * vnoise(p * 2.7 + 13.1) + 0.15 * vnoise(p * 6.3 - 7.7);
}
float fbm1(vec2 p) { return vnoise(p); }
`)
        .replace('#include <color_fragment>', `#include <color_fragment>
{
  float sid = floor(vSurface + 0.001);
  float wear = vSurface - sid;          // packed edge weathering (see mesher)
  int sidx = int(sid + 0.5);
  vec3 ta = uTintA[sidx];
  vec3 tb = uTintB[sidx];

  // Triplanar pick so wall faces get relief too instead of a stretched smear.
  vec3 an = abs(vWNormal);
  vec2 wp = an.y > 0.5 ? vWPos.xz : (an.x > an.z ? vec2(vWPos.z, vWPos.y) : vec2(vWPos.x, vWPos.y));

  float patchv = fbm1(wp * 0.13);        // big hue drift (~8 m patches)
  float tile  = fbm1(wp * 0.40 + 41.0);  // panel tone: 2.5 m features, so a run of
                                         // carriageway reads as ONE worked surface
                                         // instead of 1 m camo cells
  float grit  = fbm1(wp * 3.2 - 17.0);   // aggregate / pebble character

  // Hue AND value: the two palette anchors mix across the patch field, then the tile
  // field swings brightness ~+-20% (PLAN §10 criterion 2 wants >= 12%, spatially
  // coherent: the spread lives in metre-scale features, not per cell).
  vec3 hue = mix(ta, tb, patchv);
  float tone = 0.82 + 0.40 * tile;
  diffuseColor.rgb *= hue * tone;

  // Per-surface character (docs/04 §3): asphalt has aggregate + patches of old
  // patch, gravel reads as pebbles, snow scatters, grass clumps, stone bands.
  float gritAmt = 0.10;
  if (sidx == 1) {                       // asphalt
    gritAmt = 0.18;
    diffuseColor.rgb *= 0.90 + 0.22 * step(0.55, patchv);
    diffuseColor.rgb += vec3(0.012, 0.010, 0.006) * step(0.78, grit);
  } else if (sidx == 2) {                // gravel / shoulder
    gritAmt = 0.22;
    diffuseColor.rgb *= 0.95 + 0.12 * step(0.52, grit);
  } else if (sidx == 3 || sidx == 8 || sidx == 10) {   // mud / peat / dirt
    gritAmt = 0.16;
    diffuseColor.rgb *= 0.93 + 0.16 * vnoise(wp * 1.1);
  } else if (sidx == 4) {                // snow
    gritAmt = 0.07;
    diffuseColor.rgb += vec3(0.03, 0.035, 0.05) * step(0.6, tile);
  } else if (sidx == 5) {                // grass
    gritAmt = 0.20;
    diffuseColor.rgb *= 0.91 + 0.20 * vnoise(wp * 1.7);
  } else if (sidx == 6) {                // sand
    gritAmt = 0.12;
    diffuseColor.rgb *= 0.94 + 0.14 * vnoise(wp * 0.8 + vec2(7.0, 3.0));
  } else if (sidx == 7 || sidx == 9) {   // stone / ice
    gritAmt = 0.14;
    diffuseColor.rgb *= 0.94 + 0.14 * vnoise(wp * 0.4);
  } else {
    diffuseColor.rgb *= 0.95 + 0.12 * vnoise(wp * 0.6);
  }
  diffuseColor.rgb *= 1.0 + (grit - 0.5) * gritAmt;

  // Edge weathering: top edges and corners wear lighter, the base of a wall and
  // any crevice stays darker (the crevice part is the baked AO in diffuseColor).
  // Narrow range: the old 0.80 -> 1.17 ramp, multiplied by the baked AO of the same
  // quad, made a 1 m wall read as a pale plate floating over a dark band.
  // Edge weathering + the CMR road skin (PLAN §10.2 "Droga"): the corridor tone comes
  // from the carve wear band, where LOW = compacted wheel-line rut (darker than the
  // surface) and HIGH = pale shoulder / edge line. Natural ground keeps the narrow,
  // gentle ramp so a wall lip never turns into a pale plate floating over a dark band.
  float roadish = (sidx == 1 || sidx == 2 || sidx == 3 || sidx == 8 || sidx == 10) ? 1.0 : 0.0;
  float natural = mix(0.88, 1.04, wear);
  // Ruts: down to 0.62 of the surface tone, feathered by the fbm fields above so the
  // band reads as worked ground rather than a decal.
  float rutT = wear;
  float band = mix(0.70, 1.06, rutT);
  // A faint cross-band grain inside the carriageway so a rut is not a dead flat strip.
  band *= 0.94 + 0.12 * fbm1(vec2(wp.x * 1.9 + wp.y * 0.35, wp.y * 1.9));
  diffuseColor.rgb *= mix(natural, band, roadish);
  diffuseColor.rgb += vec3(0.010, 0.008, 0.004) * wear * (1.0 - roadish);
  // The bright edge line against grass: only the very top of the band gets the lift.
  diffuseColor.rgb += vec3(0.020, 0.019, 0.016) * roadish * smoothstep(0.82, 1.0, wear);
}
`)
        .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
{
  float sid = floor(vSurface + 0.001);
  int sidx = int(sid + 0.5);
  float r = 0.95;
  if (sidx == 1) {
    r = 0.50;                            // asphalt
    // Worn wheel lines on asphalt are compacted: a faint sheen, not a reflection.
    r *= mix(0.55, 1.0, smoothstep(0.10, 0.40, fract(vSurface)));
  }
  else if (sidx == 2) r = 0.98;         // gravel
  else if (sidx == 3) r = 1.0;          // mud
  else if (sidx == 4) r = 0.76;         // snow
  else if (sidx == 5) r = 0.92;         // grass
  else if (sidx == 6) r = 0.97;         // sand
  else if (sidx == 7) r = 0.66;         // stone
  else if (sidx == 8) r = 1.0;          // peat
  else if (sidx == 9) r = 0.38;         // ice
  else if (sidx == 10) r = 0.96;        // dirt
  // Roughness varies across the panel too: a uniform slab is what the reference
  // never has (PLAN §10). Worn edges are polished slightly.
  float wob = 0.92 + 0.16 * fbm1(vWPos.xz * 0.85 + 5.0);
  roughnessFactor = min(1.0, roughnessFactor * r * wob * mix(1.0, 0.88, fract(vSurface)));
  // Wet stage (rain): the carriageway loses roughness, the verge does not.
  int siw = int(floor(vSurface + 0.001) + 0.5);
  float roadishw = (siw == 1 || siw == 2 || siw == 3 || siw == 10) ? 1.0 : 0.0;
  roughnessFactor = clamp(roughnessFactor * (1.0 - 0.55 * uWet * roadishw), 0.05, 1.0);
}
`);
      m.userData.shader = shader;
    };
    m.customProgramCacheKey = () => 'vr-terrain-f9';
    this.terrainMaterial = m;

    // Standard, not Lambert: props take the same lighting model as the car body so
    // instanceColor and the baked vertex colours still feed USE_INSTANCING_COLOR /
    // USE_COLOR in the standard shader (both materials support them).
    this.propMaterial = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, metalness: 0.0 });
    this.carMaterial = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.42, metalness: 0.25 });
  }

  setBiome(info, biomeName) {
    this.biome = biomeName || this.biome;
    this.biomeSky.set(info.sky);
    this.biomeFog.set(info.fog);
    this.applyRig();
  }

  /**
   * Stage climate from the generator (road.climate, PLAN §10.2): wetness darkens and
   * glosses the carriageway, overcast flattens the key, haze lengthens the fog. Same
   * material graph, different numbers (PLAN §10 "noc i deszcz nie moga byc osobnym kodem").
   */
  setClimate(cl) {
    this.wet = cl && cl.wet ? cl.wet : 0;
    this.hazeBias = cl && cl.haze ? cl.haze : 1;
    this.overcast = cl && cl.weather === 1 ? 1 : 0;
    const sh = this.terrainMaterial.userData && this.terrainMaterial.userData.shader;
    if (sh && sh.uniforms.uWet) sh.uniforms.uWet.value = this.wet;
    this.applyRig();
  }

  /** Time of day 0..1 (0.25 sunrise, 0.5 noon, 0.72 golden hour, 1 night). */
  setTimeOfDay(t) {
    this.tod = Math.max(0, Math.min(1, t));
    // render/carMesh.js decides at build time whether the headlights get real
    // beams: the stage's tod is the only source it needs, and it is set before
    // the car is built (docs/06 §2 order of boot).
    settings.tod = this.tod;
    lightingFor(this.biome, this.tod, this.rig);
    this.applyRig();
  }

  applyRig() {
    const rig = this.rig;
    lightingFor(this.biome, this.tod, rig);

    const oc = this.overcast || 0;
    this.sun.color.copy(rig.sunColor);
    this.sun.intensity = rig.keyIntensity * 1.34 * (1 - 0.52 * oc);
    this.hemi.color.copy(rig.hemiSky);
    this.hemi.groundColor.copy(rig.hemiGround);
    this.hemi.intensity = rig.ambIntensity * 1.42 * (1 + 0.22 * oc);
    this.fill.color.copy(rig.fillColor);
    this.fill.intensity = rig.fillIntensity * 1.38 * (1 + 0.30 * oc);

    // Biome-matched haze, but *directional*: the sky keeps a warm key-lit cast and the
    // fog stays a tint rather than a grey sheet, so mid-distance terrain still reads as
    // gravel and grass (PLAN §10 criterion 1/4: read the road and the nearest checkpoint
    // in under a second; distant ground may wash out, the racing line may not).
    this.fogColor.copy(this.biomeFog).lerp(rig.hemiSky, 0.14).lerp(rig.sunColor, 0.34 * rig.warmth);
    this.skyColor.copy(this.biomeSky).lerp(rig.hemiSky, 0.30).lerp(rig.sunColor, 0.34 * rig.warmth);
    // Saturated sky (PLAN §10.2 "mocno nasycone niebo"): push the blue away from grey
    // instead of letting the haze wash the whole frame to one value.
    const skyL = 0.2126 * this.skyColor.r + 0.7152 * this.skyColor.g + 0.0722 * this.skyColor.b;
    this._satCol.setRGB(skyL * 0.55, skyL * 0.85, Math.min(1, skyL * 1.5));
    this.skyColor.lerp(this._satCol, 0.45);
    this.skyColor.r = Math.min(1, this.skyColor.r * rig.saturation);
    this.skyColor.g = Math.min(1, this.skyColor.g * rig.saturation);
    this.skyColor.b = Math.min(1, this.skyColor.b * rig.saturation);
    this.scene.fog.color.copy(this.fogColor);
    const far = settings.drawDistance;
    // Fog is short by design (PLAN §10.2 "teren jasny, tylko horyzont mglisty"):
    // mid-distance terrain must stay crisp, only the outer silhouette ring hazes.
    this.scene.fog.near = Math.max(120, far * (0.70 - 0.12 * rig.hazeMul) / this.hazeBias);
    this.scene.fog.far = far * (1.05 + 0.30 * rig.hazeMul);

    // Built-in ACES only when the composite is off: with post on, the scene lands
    // in a linear render target and the composite grades it (docs/04 §6).
    this.renderer.toneMapping = this.post.enabled ? THREE.NoToneMapping : THREE.ACESFilmicToneMapping;
    // The composite is gated off on this driver, so the built-in ACES carries the whole
    // grade: a small pull-back so low-sun key light does not blow the frame to grey.
    const exposure = rig.exposure * (this.post.enabled ? 1 : 1.02);
    this.renderer.toneMappingExposure = exposure;
    this.post.compositeMat.uniforms.uExposure.value = exposure;
    this.post.compositeMat.uniforms.uWarm.value = 0.35 + 0.65 * rig.warmth;
    this.post.compositeMat.uniforms.uBloom.value = 0.35 + 0.35 * rig.warmth;
    this.post.shafts = settings.quality !== QUALITY.LOW;
    // Late shader compile: the wetness uniform only exists once the program is built.
    const shT = this.terrainMaterial.userData && this.terrainMaterial.userData.shader;
    if (shT && shT.uniforms.uWet) shT.uniforms.uWet.value = this.wet;
  }

  setQuality(q) {
    const scale = q === QUALITY.LOW ? 0.75 : 1.0;
    this.renderer.setPixelRatio(Math.min((window.devicePixelRatio || 1) * scale, 2));
    const p = SHADOW_PRESET[q];
    this.renderer.shadowMap.enabled = settings.shadows && q !== QUALITY.LOW;
    this.sun.castShadow = settings.shadows && q !== QUALITY.LOW;
    this.renderer.shadowMap.type = p.type;
    this.sun.shadow.mapSize.set(p.map, p.map);
    this.sun.shadow.bias = p.bias;
    this.sun.shadow.normalBias = p.normalBias;
    this._shadowSpan = p.span;
    const s = p.span;
    this.sun.shadow.camera.left = -s; this.sun.shadow.camera.right = s;
    this.sun.shadow.camera.top = s; this.sun.shadow.camera.bottom = -s;
    this.sun.shadow.camera.far = p.dist + 190;
    this.sun.shadow.camera.updateProjectionMatrix();
    this.camera.far = q === QUALITY.LOW ? 420 : 900;
    this.camera.updateProjectionMatrix();

    // Post composite: on at MED/HIGH, off at LOW (docs/07 §Budżety).
    this.post.enabled = settings.post && q !== QUALITY.LOW;
    this.post.shafts = q !== QUALITY.LOW;
    this.post.gatherMat.uniforms.uShaftTaps.value = q === QUALITY.HIGH ? 7 : 5;
    this.post.compositeMat.uniforms.uGrain.value = q === QUALITY.HIGH ? 0.040 : 0.030;
    this.renderer.toneMapping = this.post.enabled ? THREE.NoToneMapping : THREE.ACESFilmicToneMapping;
    this.onResize();
    this.applyRig();
  }

  onResize() {
    const w = window.innerWidth, h = window.innerHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
    const db = this.renderer.getDrawingBufferSize(this._size || (this._size = new THREE.Vector2()));
    this.post.setSize(db.x, db.y);
  }

  /**
   * Keep the shadow frustum tight on the car AND snap it to the shadow-map texel
   * grid. Without the snap every camera step re-samples the scene at a sub-texel
   * offset and the shadow edges crawl ("acne/migotanie", PLAN §10 criterion 4).
   */
  fitShadow(target) {
    const dir = this.rig.sunDir;
    const span = this._shadowSpan;
    const texel = (2 * span) / this.sun.shadow.mapSize.x;

    // Light basis (right, up, -dir is the view axis of the shadow camera).
    this._right.set(dir.z, 0, -dir.x);
    if (this._right.lengthSq() < 1e-6) this._right.set(1, 0, 0);
    this._right.normalize();
    this._up.crossVectors(dir, this._right).normalize();

    this._center.copy(target);
    const xr = Math.round(this._center.dot(this._right) / texel) * texel;
    const yr = Math.round(this._center.dot(this._up) / texel) * texel;
    this._snap.copy(this._center)
      .addScaledVector(this._right, xr - this._center.dot(this._right))
      .addScaledVector(this._up, yr - this._center.dot(this._up));

    const dist = this.sun.shadow.camera.far * 0.42;
    this.sun.target.position.copy(this._snap);
    this.sun.position.copy(this._snap).addScaledVector(dir, dist);
    this.sun.target.updateMatrixWorld();

    // The key light swings with the day; the fill always looks back from the other
    // side so the shadow side keeps a cool read.
    this.fill.position.copy(this.sun.position).multiplyScalar(-0.6);
    this.fill.target.position.copy(this._snap);
    this.fill.target.updateMatrixWorld();
  }

  /** Render-cost probe used by shot mode / the budget harness (docs/07 §Budżety). */
  measureFrame(n) {
    const t = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const t0 = performance.now();
      this.render();
      t[i] = performance.now() - t0;
    }
    t.sort();
    let sum = 0;
    for (let i = 0; i < n; i++) sum += t[i];
    return { mean: sum / n, p95: t[Math.min(n - 1, Math.max(0, Math.round(n * 0.95) - 1))], min: t[0], max: t[n - 1] };
  }

  render() {
    this._time = performance.now() * 0.001;
    if (this.post.enabled) {
      this.post.setSun(this.camera, this.rig.sunDir, this.rig.shaftGain);
      this.post.composite(this.scene, this.camera, this.rig, this._time);
      this.info.calls = this.post.calls;
      this.info.tris = this.post.tris;
    } else {
      this.renderer.render(this.scene, this.camera);
      const info = this.renderer.info.render;
      this.info.calls = info.calls;
      this.info.tris = info.triangles;
    }
  }
}
