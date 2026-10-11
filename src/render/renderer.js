// Renderer shell: WebGLRenderer, light rig, sky/fog, procedural terrain material,
// quality scaling, shadow fit, post composite (docs/06 §2 render/renderer.js).
// Lighting + tone decisions follow docs/04 §1 and PLAN.md §10 (Colin McRae Rally:
// warm key, cool sky fill, long shadows, saturated-but-earthly palette).
import * as THREE from 'three';
import { QUALITY, settings, fogNearFor, fogFarFor } from '../core/settings.js';
import { createLightRig, lightingFor } from './lighting.js';
import { PostComposer, POST_TUNE, TONE_MODE } from './post/composer.js';
import { surfaceTones } from '../world/palette.js';
import { ROAD_TONE, RUT_GLOSS } from './road-skin.js';

const SHADOW_PRESET = [
  // LOW / MED / HIGH. `span` is the half-extent of the orthographic shadow frustum
  // centred on the car: smaller span -> bigger texels of detail -> the contact
  // shadow and the corner posts read instead of dissolving (PLAN §10 criterion 4).
  { span: 58, map: 1024, dist: 150, bias: -0.0009, normalBias: 0.055, type: THREE.PCFShadowMap },
  { span: 36, map: 2048, dist: 150, bias: -0.00045, normalBias: 0.028, type: THREE.PCFSoftShadowMap },
  { span: 38, map: 2048, dist: 140, bias: -0.00035, normalBias: 0.030, type: THREE.PCFSoftShadowMap },
];

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = TONE_MODE;
    this.renderer.toneMappingExposure = POST_TUNE.exposure;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(62, 1, 0.25, 900);

    // ---- light rig: warm key + cool sky fill + hemisphere ambient (docs/04 §1) ----
    this.rig = createLightRig();
    this.tod = 0.68;                      // golden hour is the reference look (PLAN §10)
    this.biome = 'FOREST';

    this.hemi = new THREE.HemisphereLight(0xb4cde2, 0x3f4636, 0.92);
    this.scene.add(this.hemi);

    this.sun = new THREE.DirectionalLight(0xffe3bd, 2.4);
    this._warmKey = new THREE.Color(0xffb35c);            // warm key tint, see applyRig
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
    this.scene.fog = new THREE.Fog(this.fogColor, fogNearFor(settings.drawDistance), fogFarFor(settings.drawDistance));

    // ---- sky dome -----------------------------------------------------------------
    // One procedural backdrop instead of a flat background colour: a graded horizon
    // haze that carries the *exact* fog colour at the horizon line (so the fog has
    // somewhere to dissolve into and the far ring stops reading as a pale sheet),
    // plus a sun disc at the real rig direction and a soft glow with enough HDR headroom
    // for the bloom pass to pick up. Cost: one 80-tri icosahedron, one draw call,
    // no texture, no extra pass. depthTest off + renderOrder -2 = it is the backdrop,
    // never an occluder, and terrain/trees occlude the sun naturally (drawn first).
    this.sky = new THREE.Mesh(
      new THREE.IcosahedronGeometry(1, 1),
      new THREE.ShaderMaterial({
        side: THREE.BackSide, depthWrite: false, depthTest: false, fog: false,
        uniforms: {
          uZenith: { value: new THREE.Color(0x2f5f92) },
          uHorizon: { value: new THREE.Color(0x9db4c4) },
          uSunCol: { value: new THREE.Color(0xffca92) },
          uSunDir: { value: new THREE.Vector3(0.4, 0.3, 0.8) },
          uSunPow: { value: 26.0 },       // HDR: the composite bloom threshold is ~0.95
          uHaze: { value: 0.62 },
        },
        vertexShader: `
varying vec3 vDir;
void main() { vDir = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
`,
        fragmentShader: `
varying vec3 vDir;
uniform vec3 uZenith, uHorizon, uSunCol, uSunDir;
uniform float uSunPow, uHaze;
void main() {
  vec3 d = normalize(vDir);
  float h = clamp(d.y, -1.0, 1.0);
  // Graded haze: fog colour ON the horizon, deepening to the zenith colour overhead.
  float band = pow(1.0 - max(h, 0.0), 3.0);
  vec3 col = mix(uZenith, uHorizon, band);
  // Under the horizon the dome is the haze floor: a carve lip or a hairline crack must
  // never show a hard-cut value through it.
  col = mix(col, uHorizon * 0.86, smoothstep(0.0, -0.14, h));
  vec3 sd = normalize(uSunDir);
  float c = dot(d, sd);
  float up = smoothstep(-0.05, 0.09, sd.y);        // sun below the horizon = no disc
  float disc = smoothstep(0.99932, 0.99976, c);
  float glow = 1.45 * pow(max(c, 0.0), 420.0)
             + 0.34 * pow(max(c, 0.0), 24.0)
             + 0.11 * pow(max(c, 0.0), 3.2);
  // Warm horizon wash on the sun's side of the sky: the air between camera and sun.
  col += uSunCol * (0.30 * uHaze) * pow(max(c, 0.0), 2.4) * (1.0 - band * 0.35) * up;
  col += uSunCol * (glow * (0.55 + 0.45 * uHaze) + disc * uSunPow) * up;
  gl_FragColor = vec4(max(col, vec3(0.0)), 1.0);
}
`,
      })
    );
    this.sky.renderOrder = -2;
    this.sky.frustumCulled = false;
    this.scene.add(this.sky);

    this.terrainMaterial = null;
    this.propMaterial = null;
    this.carMaterial = null;
    this._buildMaterials();

    this.post = new PostComposer(this.renderer);
    this.post.setConfig({ post: settings.post, bloom: settings.bloom, grade: settings.grade, exposure: POST_TUNE.exposure });

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
      shader.uniforms.uDap = { value: 0 };      // dapple clock (seconds), set per frame
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
uniform float uDap;

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
  // field swings brightness by 12% about 1.0 (PLAN §10 criterion 2 wants >= 12%,
  // spatially coherent: the spread lives in metre-scale features, not per cell).
  // The old 0.82 -> 1.22 swing was a 49% band whose midpoint sat above 1.0, so whole
  // 2.5 m panels of the near-field carriageway came out lifted into pale patches
  // (queue P7). The swing is interpolated from ROAD_TONE, so the number the suite pins
  // (T28) is literally the number the shader runs on.
  vec3 hue = mix(ta, tb, patchv);
  float tone = ${ROAD_TONE.base} + ${ROAD_TONE.swing} * tile;
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
  float band = mix(0.58, 1.00, rutT);
  // A faint cross-band grain inside the carriageway so a rut is not a dead flat strip.
  band *= 0.94 + 0.12 * fbm1(vec2(wp.x * 1.9 + wp.y * 0.35, wp.y * 1.9));
  diffuseColor.rgb *= mix(natural, band, roadish);
  diffuseColor.rgb += vec3(0.010, 0.008, 0.004) * wear * (1.0 - roadish);
  // The bright edge line against grass: only the very top of the band gets the lift.
  diffuseColor.rgb += vec3(0.020, 0.019, 0.016) * roadish * smoothstep(0.82, 1.0, wear);

  // Dappled canopy light (the stage may not read uniformly lit). Two slow drifting
  // noise fields multiplied, so the patch pattern breaks up instead of scrolling as a
  // tile; ground-facing faces take the full swing, walls only a quarter of it. The
  // swing is warm-biased so a sun patch carries the key colour, unlike a flat gain.
  float dapA = vnoise(vWPos.xz * 0.21 + vec2(uDap * 0.028, -uDap * 0.016));
  float dapB = vnoise(vWPos.xz * 0.67 - vec2(uDap * 0.011, uDap * 0.023));
  float dapM = smoothstep(0.28, 0.72, dapA * dapB * 2.35);
  float upFace = an.y > 0.5 ? 1.0 : 0.22;
  diffuseColor.rgb *= 1.0 + upFace * (dapM * vec3(0.30, 0.26, 0.19) - (1.0 - dapM) * vec3(0.055, 0.058, 0.062));
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
  // A wheel-line rut is compacted ground on EVERY road surface, not only asphalt: the
  // low end of the packed wear band loses a little roughness, so the rut sells itself in
  // the specular once the value spread came down (queue P7). Sheen, not a reflection.
  float rutRoad = (sidx == 2 || sidx == 3 || sidx == 8 || sidx == 10) ? 1.0 : 0.0;
  r *= 1.0 - (1.0 - ${RUT_GLOSS.road}) * rutRoad
         * (1.0 - smoothstep(${RUT_GLOSS.from}, ${RUT_GLOSS.to}, fract(vSurface)));
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
    m.customProgramCacheKey = () => 'vr-terrain-g1';
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
    // Warmer key (0.20 -> 0.32 of the warm key tint) and a stronger key gain:
    // three's directional shadow is already at full attenuation, so the only headroom
    // for a readable contact shadow is the key/fill ratio, not the shadow map.
    this.sun.color.copy(rig.sunColor).lerp(this._warmKey, 0.32);
    this.sun.intensity = rig.keyIntensity * 1.34 * (1 - 0.52 * oc);
    this.hemi.color.copy(rig.hemiSky);
    this.hemi.groundColor.copy(rig.hemiGround);
    // Ambient fill up (1.16 -> 1.42): the forest floor and the shaded flank of the
    // treeline lift out of black while the sun's direct term keeps the contrast.
    this.hemi.intensity = rig.ambIntensity * 1.42 * (1 + 0.22 * oc);
    this.fill.color.copy(rig.fillColor);
    // The fill points back at the shadow side, so it is also the light that erases the
    // car/prop contact shadow. It goes slightly DOWN; the crush lift is carried by the
    // hemisphere and by the composite's shadowLift instead (plan §10 "cien nie jest czarny").
    this.fill.intensity = rig.fillIntensity * 1.04 * (1 + 0.30 * oc);

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
    // Sky dome follows the same rig: the horizon band IS the fog colour (so the fog
    // dissolves into the haze instead of hitting a wall), the zenith is the saturated
    // sky pushed deeper, and the sun disc sits on rig.sunDir - so it swings with the
    // time of day exactly like the key light.
    const sku = this.sky.material.uniforms;
    sku.uSunDir.value.copy(rig.sunDir);
    sku.uSunCol.value.copy(rig.sunColor);
    sku.uHorizon.value.copy(this.fogColor);
    sku.uZenith.value.copy(this.skyColor).multiplyScalar(0.60);
    sku.uZenith.value.b = Math.min(1.4, sku.uZenith.value.b * 1.30);
    sku.uHaze.value = 0.42 + 0.58 * rig.warmth;
    sku.uSunPow.value = 14.0 + 22.0 * Math.max(0, Math.min(1, rig.sunDir.y * 3.0));
    const far = settings.drawDistance;
    // Fog is short by design (PLAN §10.2 "teren jasny, tylko horyzont mglisty"):
    // mid-distance terrain must stay crisp, only the outer silhouette ring hazes. Both
    // edges follow the draw distance setting (settings.fogNearFor/fogFarFor), so the
    // horizon never shows a hard wall however far the row is set.
    this.scene.fog.near = Math.min(520, Math.max(120, fogNearFor(far) * (1 - 0.18 * rig.hazeMul) / this.hazeBias));
    this.scene.fog.far = fogFarFor(far) * (0.96 + 0.14 * rig.hazeMul);

    // Built-in tone mapping only when the composite is off: with post on, the scene
    // lands in a linear half-float target and the composite tone maps + grades it
    // (docs/04 §6). Same curve either way (AgX in both, composer.js mirrors it).
    this.renderer.toneMapping = this.post.enabled ? THREE.NoToneMapping : TONE_MODE;
    // Post off: the built-in curve carries the whole grade, so AgX gets the same
    // small pull-back the old ACES path had. Post on: the composite owns exposure.
    const exposure = rig.exposure * (this.post.enabled ? 1 : (TONE_MODE === THREE.AgXToneMapping ? POST_TUNE.exposure : 1.02));
    this.renderer.toneMappingExposure = exposure;
    this.post.exposure = POST_TUNE.exposure;
    this.post.setRig(rig);
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
    // The camera far plane has to clear the whole streamed disc or the far hill band is
    // clipped away and the horizon is a hard cut again.
    this.camera.far = Math.max(q === QUALITY.LOW ? 420 : 900, settings.drawDistance * 1.1);
    this.camera.updateProjectionMatrix();
    // Keep the dome inside the far plane, otherwise its far vertices clip and the
    // horizon opens up as a hole.
    this._skyRadius = Math.max(80, Math.min(this.camera.far * 0.85, 2200));
    this.sky.scale.setScalar(this._skyRadius);

    // Post stack: POST / GRADE rows plus the driver gate (composer.ok). LOW keeps
    // it on but runs the cheapest graph (one mip, 3 taps); BLOOM sets the row.
    this.post.setConfig({ post: settings.post, bloom: settings.bloom, grade: settings.grade, exposure: POST_TUNE.exposure });
    this.renderer.toneMapping = this.post.enabled ? THREE.NoToneMapping : TONE_MODE;
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
    // The dome rides with the camera (it is a backdrop, not a distant object), and the
    // canopy dapple clock only exists once the terrain program is compiled.
    this.sky.position.copy(this.camera.position);
    const shD = this.terrainMaterial.userData && this.terrainMaterial.userData.shader;
    if (shD && shD.uniforms.uDap) shD.uniforms.uDap.value = this._time;
    if (this.post.enabled) {
      this.post.render(this.scene, this.camera, this.rig, this._time);
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
