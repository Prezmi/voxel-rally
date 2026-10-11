// Post-composite stack (docs/04 §6, docs/07 §Budżety techniczne). Built in-house,
// no EffectComposer dependency, one fullscreen quad, no per-frame allocation.
//
// Pass graph (the scene render itself is NOT counted: it happens either way, only
// its destination changes):
//   scene -> rtScene           half-float HDR (RGBA16F) + depth
//   1) brightQ                 quarter-res bright pass (soft threshold) + the
//                              horizontal half of the gaussian, prefiltered while
//                              downsampling, so the resize costs no extra pass
//   2) blurQ                   vertical gaussian over the quarter mip
//   3) brightE                 eighth-res bright pass + horizontal gaussian
//   4) blurE                   vertical gaussian over the eighth mip
//   composite (to canvas)      DOF (from the scene depth attachment) -> bloom add
//                              -> AgX tone map -> filmic grade -> sRGB
// Four offscreen passes + one composite. LOW runs the cheapest graph: the eighth
// mip is not allocated or drawn at all (brightQ + blurQ + composite).
//
// Depth of field (queue P14) costs no pass at all: the composite reads rtScene's
// depth attachment and takes a few extra scene taps where the linear distance is
// past the focus plane, exactly like the edge radial blur and the dirty lens before
// it. The bloom mips still come from the sharp scene, so a far light blooms the way
// it always did while its own surface defocuses.
//
// Draw calls: every pass is the same preallocated fullscreen quad; the scene's own
// draw-call count is read straight after the scene render, before any quad runs,
// so renderer.info (and the budget harness) reports the same calls as the raw path.
import * as THREE from 'three';
import { POST_TUNE, BLOOM_LEVELS, passGraph, resolveToneMode, clampNum, ATMO_TUNE,
  sunVisibility, shaftAlpha, lensFlareAlpha, radialBlurAmount,
  DOF_TUNE, dofFocus, dofRadiusPx, dofTapCount } from './tune.js';
import { settings } from '../../core/settings.js';

// The dial table + the pass graph live in tune.js (no THREE import there, so the
// headless suite can pin them). Re-exported here so callers have one entry point.
export { POST_TUNE, BLOOM_LEVELS, passGraph, ATMO_TUNE };

// r169 exports AgXToneMapping, so AgX is the mode of record. The same curve is
// mirrored in the composite below (a raw ShaderMaterial gets no built-in tonemap),
// and the raw (post-off) path sets it on the renderer, so both paths agree.
const _tone = resolveToneMode(THREE);
export const TONE_MODE = _tone.mode;
export const TONE_MODE_NAME = _tone.name;

// Scratch for the sun projection: allocated once, never per frame.
const _sunPos = new THREE.Vector3();
const _sunFwd = new THREE.Vector3();
const _sunNdc = new THREE.Vector3();
const _sunInfo = { uv: null, vis: 0 };


/** Clamp + sanitise a dial read from settings/save, so a stale payload can never
 *  put a NaN or a negative tap count on the GPU. */
const num = clampNum;

/** Pass list for one config. This is the graph the composer really draws, and the
 *  thing tests assert per quality preset. POST off -> zero composer passes: the
 *  renderer keeps the plain direct-to-canvas path it had before. (lives in tune.js) */

const VERT = `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

// ---- bright pass: threshold + horizontal gaussian, downsampled in the same pass --
const BRIGHT_FRAG = `
varying vec2 vUv;
uniform sampler2D uScene;
uniform vec2 uOff;          // one tap, in UV, already scaled to the source
uniform float uTaps, uSigma, uRadius, uThreshold, uKnee, uGain;

float lum(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }

// Soft-knee threshold: below the threshold nothing passes, the knee ramps it in so a
// headlight or a sun-lit bank blooms instead of clipping to a hard disc.
vec3 bright(vec3 c) {
  float l = lum(c);
  float soft = clamp(l - uThreshold, 0.0, uKnee) / max(1e-4, uKnee);
  return c * soft * step(uThreshold * 0.6, l);
}

void main() {
  vec3 acc = vec3(0.0);
  float wsum = 0.0;
  for (int i = 0; i < 8; i++) {
    if (float(i) >= uTaps) break;
    float o = float(i) * uRadius;
    float w = exp(-0.5 * (o * o) / max(1e-3, uSigma * uSigma));
    vec2 d = uOff * o;
    vec3 s = bright(texture2D(uScene, vUv + d).rgb) + bright(texture2D(uScene, vUv - d).rgb);
    acc += s * w;
    wsum += (i == 0) ? w : 2.0 * w;
  }
  gl_FragColor = vec4(acc / max(1e-3, wsum) * uGain, 1.0);
}
`;

// ---- separable gaussian, either mip, either axis ------------------------------
const BLUR_FRAG = `
varying vec2 vUv;
uniform sampler2D uSrc;
uniform vec2 uDir;          // axis * one tap, in UV
uniform float uTaps, uSigma, uRadius;
void main() {
  vec3 acc = texture2D(uSrc, vUv).rgb * 1.0;
  float wsum = 1.0;
  for (int i = 1; i < 8; i++) {
    if (float(i) >= uTaps) break;
    float o = float(i) * uRadius;
    float w = exp(-0.5 * (o * o) / max(1e-3, uSigma * uSigma));
    vec2 d = uDir * o;
    // two bilinear taps per gaussian step: the half-offset pair approximates the
    // wide tail without more samples
    acc += (texture2D(uSrc, vUv + d).rgb + texture2D(uSrc, vUv - d).rgb) * w;
    wsum += 2.0 * w;
  }
  gl_FragColor = vec4(acc / wsum, 1.0);
}
`;

// ---- sun shafts: one eighth-res quad, a radial march back toward the sun --------
// No depth, no shadow access, no extra geometry: the streak samples the HDR scene
// along the ray from the pixel to the sun, so whatever the canopy left bright there is
// what leaks through. A procedural 2-D noise modulates it per ray and per sample, so
// the beams dapple instead of reading as a flat wash, and the whole term is scaled by
// an alpha that is 0 the moment the sun leaves the frame.
const SHAFT_FRAG = `
varying vec2 vUv;
uniform sampler2D uScene;
uniform vec2 uSunUv;
uniform float uAmt, uTime, uDecay, uDensity, uDrift, uContrast, uSpread, uFalloff, uSamples;

float h13(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(h13(i), h13(i + vec2(1.0, 0.0)), f.x),
             mix(h13(i + vec2(0.0, 1.0)), h13(i + vec2(1.0, 1.0)), f.x), f.y);
}

void main() {
  if (uAmt <= 0.0002) { gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0); return; }
  vec2 d = vUv - uSunUv;
  float len = length(d);
  vec2 dirv = d / max(1e-4, len);
  float ang = atan(dirv.y, dirv.x);
  float acc = 0.0, wsum = 0.0, w = 1.0;
  for (int i = 0; i < 8; i++) {
    if (float(i) >= uSamples) break;
    float t = float(i) / max(1.0, uSamples - 1.0) * uSpread;
    vec2 s = vUv - dirv * t;
    float l = dot(texture2D(uScene, s).rgb, vec3(0.2126, 0.7152, 0.0722));
    float leak = 0.55 + 0.45 * vnoise(vec2(ang * 5.0 + uTime * uDrift, t * uDensity * 8.0 + uTime * uDrift));
    acc += min(l, 4.0) * leak * w;
    wsum += w;
    w *= uDecay;
  }
  // Per-ray static wobble: distinct beams, not one uniform glow.
  float ray = 0.45 + 0.55 * vnoise(vec2(ang * 11.0, uTime * uDrift * 0.6));
  float gain = acc / max(1e-3, wsum);
  gl_FragColor = vec4(vec3(gain) * mix(1.0, ray, uContrast) * exp(-len * uFalloff) * uAmt, 1.0);
}
`;

// ---- composite: DOF -> shafts -> lens -> bloom -> radial blur -> AgX -> grade -> sRGB
const COMPOSITE_FRAG = `
varying vec2 vUv;
uniform sampler2D uScene;
uniform sampler2D uBloomQ;
uniform sampler2D uBloomE;
uniform float uBloomQ_W, uBloomE_W, uExposure, uTime;
uniform float uContrast, uShadowLift, uWarmAmt, uCoolAmt, uSatGreen, uSatBrown;
uniform float uVignette, uGrain, uGrainSpeed;
uniform vec3 uWarmHi, uCoolSh;
uniform vec2 uRes;
// rally atmosphere: sun shafts, sun-keyed dirty lens, edge radial blur
uniform sampler2D uShaft;
uniform float uShaftW;
uniform float uRadial, uRBInner, uRBOuter;
uniform vec2 uSunUv;
uniform float uLensAmt, uLensSmudge, uLensFlare, uLensHalo, uLensBlobs, uLensGhosts;
// depth of field: the scene depth attachment + the focus plane, in metres
uniform sampler2D uDepth;
uniform float uNearP, uFarP, uFocus, uDofNear, uDofSpan, uDofPx, uDofTaps;

float h13(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }

vec3 agx(vec3 color) {
  const mat3 LINEAR_SRGB_TO_LINEAR_REC2020 = mat3(
    vec3(0.6274, 0.0691, 0.0164), vec3(0.3293, 0.9195, 0.0880), vec3(0.0433, 0.0113, 0.8956));
  const mat3 LINEAR_REC2020_TO_LINEAR_SRGB = mat3(
    vec3(1.6605, -0.1246, -0.0182), vec3(-0.5876, 1.1329, -0.1006), vec3(-0.0728, -0.0083, 1.1187));
  const mat3 AgXInsetMatrix = mat3(
    vec3(0.856627153315983, 0.137318972929847, 0.11189821299995),
    vec3(0.0951212405381588, 0.761241990602591, 0.0767994186031903),
    vec3(0.0482516061458583, 0.101439036467562, 0.811302368396859));
  const mat3 AgXOutsetMatrix = mat3(
    vec3(1.1271005818144368, -0.1413297634984383, -0.14132976349843826),
    vec3(-0.11060664309660323, 1.157823702216272, -0.11060664309660294),
    vec3(-0.016493938717834573, -0.016493938717834257, 1.2519364065950405));
  const float AgxMinEv = -12.47393;
  const float AgxMaxEv = 4.026069;
  color *= uExposure;
  color = LINEAR_SRGB_TO_LINEAR_REC2020 * color;
  color = AgXInsetMatrix * color;
  color = max(color, vec3(1e-10));
  color = log2(color);
  color = (color - AgxMinEv) / (AgxMaxEv - AgxMinEv);
  color = clamp(color, 0.0, 1.0);
  vec3 x2 = color * color, x4 = x2 * x2;
  color = 15.5 * x4 * x2 - 40.14 * x4 * color + 31.96 * x4 - 6.868 * x2 * color + 0.4298 * x2 + 0.1191 * color - 0.00232;
  color = AgXOutsetMatrix * color;
  color = pow(max(vec3(0.0), color), vec3(2.2));
  color = LINEAR_REC2020_TO_LINEAR_SRGB * color;
  return clamp(color, 0.0, 1.0);
}

void main() {
  // Depth of field (queue P14), folded in here like the two effects below it. The
  // window depth is linearised with the same projection identity the built-in
  // depth chunks use, then ramped by dofCoc() mirrored from tune.js: nothing inside
  // focus+uDofNear takes a single extra sample, so the car, the road and the pace
  // note boards stay pixel-sharp and only the far corridor softens.
  vec3 c = texture2D(uScene, vUv).rgb;
  if (uDofPx > 0.02) {
    float zw = texture2D(uDepth, vUv).x;
    float dist = -((uNearP * uFarP) / max(1e-3, (uFarP - uNearP) * zw - uFarP));
    float a = uFocus + uDofNear;
    if (dist > a) {
      float x = clamp((dist - a) / max(1e-3, uDofSpan), 0.0, 1.0);
      float rad = (x * x * (3.0 - 2.0 * x)) * uDofPx;
      if (rad > 0.35) {
        // Equal-area ring on the golden angle: a disc, not four points on one circle.
        vec3 acc = c;
        float ws = 1.0;
        for (int i = 1; i < 5; i++) {
          if (float(i) > uDofTaps) break;
          float ang = float(i) * 2.39996;
          float rf = sqrt((float(i) + 0.5) / (uDofTaps + 1.0));
          acc += texture2D(uScene, vUv + vec2(cos(ang), sin(ang)) * rf * rad / uRes).rgb;
          ws += 1.0;
        }
        c = acc / ws;
      }
    }
  }

  // Edge radial blur, folded in here so it costs no pass of its own: the weight ramps
  // from 0 inside uRBInner to 1 at uRBOuter, so the car and the road centre (screen
  // centre) stay perfectly sharp however fast the car is.
  vec2 rc = vUv - vec2(0.5);
  float rr = length(rc);
  float sm = uRadial * smoothstep(uRBInner, uRBOuter, rr);
  if (sm > 0.0004) {
    vec3 acc = c;
    float ws = 1.0;
    for (int i = 1; i < 4; i++) {
      float t = sm * float(i) * 0.030;
      float w = 1.0 - float(i) * 0.16;
      acc += texture2D(uScene, vUv + rc * t).rgb * w;
      ws += w;
    }
    c = acc / ws;
  }
  // One eighth-res quad of fake canopy shafts, added in linear HDR.
  c += texture2D(uShaft, vUv).rgb * uShaftW;

  // Dirty lens (docs/04 §6): procedural smudge + ghosts along the sun->centre axis,
  // generated in-shader (no texture) and keyed on the sun being in or near the frame,
  // with settings.lensDirt as the player dial. Zero when the sun is out of frame.
  if (uLensAmt > 0.0004) {
    vec2 sd = vUv - uSunUv;
    float halo = exp(-dot(sd, sd) * 11.0);
    float smudge = 0.0, flare = 0.0;
    for (int i = 0; i < 5; i++) {
      if (float(i) >= uLensBlobs) break;
      vec2 c0 = vec2(h13(vec2(float(i) + 1.3, 3.7)), h13(vec2(float(i) + 8.1, 9.4)));
      float r = 0.045 + 0.085 * h13(vec2(float(i) + 4.0, 2.6));
      vec2 q = (vUv - c0) / r;
      smudge += exp(-dot(q, q) * 1.6) * (0.45 + 0.55 * h13(vec2(float(i) + 12.0, 5.5)));
    }
    for (int i = 1; i < 4; i++) {
      if (float(i) > uLensGhosts) break;
      vec2 gp = mix(uSunUv, vec2(1.0) - uSunUv, float(i) / (uLensGhosts + 1.0));
      vec2 q = (vUv - gp) / (0.018 + 0.026 * float(i));
      flare += exp(-dot(q, q) * 1.35) * (0.5 + 0.5 * h13(vec2(float(i), 7.3)));
    }
    float veil = clamp(smudge, 0.0, 1.6) * uLensSmudge * uLensAmt;
    float vl = dot(c, vec3(0.2126, 0.7152, 0.0722));
    c = mix(c, mix(c, vec3(vl), 0.55) + vec3(0.016, 0.014, 0.011), veil);
    c += (flare * uLensFlare + halo * uLensHalo) * uLensAmt * vec3(1.06, 0.93, 0.74);
  }

  // Two mips: the quarter carries the tight halo, the eighth the wide wash.
  c += texture2D(uBloomQ, vUv).rgb * uBloomQ_W + texture2D(uBloomE, vUv).rgb * uBloomE_W;

  c = agx(c);

  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));

  // Split-tone filmic grade: warm highlights, cool sky-lit shadows.
  c = mix(c, c * uWarmHi, uWarmAmt * smoothstep(0.10, 0.85, l));
  c = mix(c, c * uCoolSh, uCoolAmt * smoothstep(0.30, 0.02, l));
  c += uShadowLift * (1.0 - smoothstep(0.0, 0.38, l));

  // Gentle contrast S curve around the mid grey.
  vec3 d = c - 0.5;
  c = 0.5 + d * (1.0 + uContrast * (1.0 - 1.15 * abs(d)));

  // Saturation lift keyed on hue families only: greens (verge, hedge) and browns
  // (gravel, mud, the car's dirt). Skies stay where they are, so the grade never
  // turns the treeline into neon.
  float green = clamp(c.g - max(c.r, c.b), 0.0, 0.45) * 2.222;
  float brown = clamp(c.r - c.g, 0.0, 0.35) * clamp(c.g - c.b, 0.0, 0.35) * 8.163 * (1.0 - smoothstep(0.45, 0.85, l));
  float m = clamp(green * uSatGreen + brown * uSatBrown, 0.0, 0.60);
  c = mix(vec3(l), c, 1.0 + m);

  // Vignette: gentle, off-centre weight so the road band never darkens under way.
  vec2 q = vUv - 0.5;
  float v = 1.0 - uVignette * dot(q, q) * 1.35;
  c *= clamp(v, 0.55, 1.0);

  // Very subtle animated grain (docs/04 §6), luminance weighted.
  float gi = fract(sin(dot(floor(vUv * uRes * 0.5) + floor(uTime * uGrainSpeed), vec2(12.9898, 78.233))) * 43758.5453);
  c += (gi - 0.5) * uGrain * (0.30 + 0.55 * (1.0 - l));

  // Manual linear -> sRGB: a raw ShaderMaterial bypasses three's colorspace pass.
  c = max(c, vec3(0.0));
  c = mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
  gl_FragColor = vec4(c, 1.0);
}
`;

export class PostComposer {
  constructor(renderer) {
    this.renderer = renderer;
    this.enabled = false;          // POST row AND the driver gate below
    this.shafts = false;           // compat shim: shot-mode A/B probes still poke it
    this.ok = false;
    this.forceLDR = false;
    this.level = 'MEDIUM';
    this.shaftsOn = true;        // the one extra quad; passGraph gates it
    this.speedIn = 0;            // ground speed, pushed by camera.js for the radial blur
    this.gradeOn = true;
    this.exposure = POST_TUNE.exposure;
    this.calls = 0; this.tris = 0;
    this.time = 0;

    this.geo = new THREE.PlaneGeometry(2, 2);
    this.quad = new THREE.Mesh(this.geo, null);
    this.quad.frustumCulled = false;
    this.passScene = new THREE.Scene();
    this.passScene.add(this.quad);
    this.passCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

    this.brightMat = new THREE.ShaderMaterial({
      vertexShader: VERT, fragmentShader: BRIGHT_FRAG, depthTest: false, depthWrite: false,
      uniforms: {
        uScene: { value: null }, uOff: { value: new THREE.Vector2(0.004, 0.004) },
        uTaps: { value: 5 }, uSigma: { value: 1.3 }, uRadius: { value: 1.25 },
        uThreshold: { value: 0.78 }, uKnee: { value: 0.5 }, uGain: { value: 1 },
      },
    });
    this.blurMat = new THREE.ShaderMaterial({
      vertexShader: VERT, fragmentShader: BLUR_FRAG, depthTest: false, depthWrite: false,
      uniforms: {
        uSrc: { value: null }, uDir: { value: new THREE.Vector2(0, 0.004) },
        uTaps: { value: 5 }, uSigma: { value: 1.3 }, uRadius: { value: 1.25 },
      },
    });
    this.compositeMat = new THREE.ShaderMaterial({
      vertexShader: VERT, fragmentShader: COMPOSITE_FRAG, depthTest: false, depthWrite: false,
      uniforms: {
        uScene: { value: null }, uBloomQ: { value: null }, uBloomE: { value: null },
        uBloomQ_W: { value: 0.32 }, uBloomE_W: { value: 0.20 },
        uExposure: { value: POST_TUNE.exposure }, uTime: { value: 0 },
        uContrast: { value: 0.24 }, uShadowLift: { value: 0.026 },
        uWarmAmt: { value: 0.55 }, uCoolAmt: { value: 0.32 },
        uWarmHi: { value: new THREE.Vector3(1.075, 1.005, 0.885) },
        uCoolSh: { value: new THREE.Vector3(0.855, 0.940, 1.110) },
        uSatGreen: { value: 0.18 }, uSatBrown: { value: 0.14 },
        uVignette: { value: 0.30 }, uGrain: { value: 0.018 }, uGrainSpeed: { value: 20 },
        uRes: { value: new THREE.Vector2(1280, 720) },
        uShaft: { value: null }, uShaftW: { value: 1 },
        uRadial: { value: 0 }, uRBInner: { value: ATMO_TUNE.blur.inner }, uRBOuter: { value: ATMO_TUNE.blur.outer },
        uSunUv: { value: new THREE.Vector2(0.5, 0.5) },
        uLensAmt: { value: 0 }, uLensSmudge: { value: ATMO_TUNE.lens.smudge },
        uLensFlare: { value: ATMO_TUNE.lens.flare }, uLensHalo: { value: ATMO_TUNE.lens.halo },
        uLensBlobs: { value: ATMO_TUNE.lens.blobs }, uLensGhosts: { value: ATMO_TUNE.lens.ghosts },
        uDepth: { value: null }, uNearP: { value: 0.25 }, uFarP: { value: 900 },
        uFocus: { value: DOF_TUNE.minFocus }, uDofNear: { value: DOF_TUNE.nearFlat },
        uDofSpan: { value: DOF_TUNE.farSpan }, uDofPx: { value: 0 },
        uDofTaps: { value: dofTapCount('MEDIUM') },
      },
    });
    // One extra quad, eighth res: the sun-shaft radial streak (see SHAFT_FRAG).
    this.shaftMat = new THREE.ShaderMaterial({
      vertexShader: VERT, fragmentShader: SHAFT_FRAG, depthTest: false, depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: {
        uScene: { value: null }, uSunUv: { value: new THREE.Vector2(0.5, 0.5) },
        uAmt: { value: 0 }, uTime: { value: 0 },
        uDecay: { value: ATMO_TUNE.shafts.decay }, uDensity: { value: ATMO_TUNE.shafts.density },
        uDrift: { value: ATMO_TUNE.shafts.drift }, uContrast: { value: ATMO_TUNE.shafts.contrast },
        uSpread: { value: ATMO_TUNE.shafts.spread }, uFalloff: { value: ATMO_TUNE.shafts.falloff },
        uSamples: { value: ATMO_TUNE.shafts.samples },
      },
    });

    this.rtScene = null; this.rtBQ = null; this.rtQB = null; this.rtBE = null; this.rtEB = null; this.rtShaft = null;
    this.focusIn = DOF_TUNE.minFocus;   // auto-focus, pushed by the frame loop
    this.dofPx = 0;                     // device-px blur radius this frame (0 = DOF off)
    this._size = new THREE.Vector2();
    this.graph = [];
    this.setSize(1280, 720);
  }

  /** POST / BLOOM / GRADE rows land here. Cheap to call: it only re-derives the
   *  graph and the dial table, targets are re-made only when the mip set changes. */
  setConfig(cfg = {}) {
    this.level = BLOOM_LEVELS.includes(cfg.bloom) ? cfg.bloom : 'MEDIUM';
    this.gradeOn = cfg.grade !== false;
    this.shaftsOn = cfg.shafts !== false;
    this.enabled = !!cfg.post && this.ok;
    this.graph = passGraph({ post: this.enabled, bloom: this.level, shafts: this.shaftsOn });
    const b = POST_TUNE.bloom[this.level];
    const g = POST_TUNE.grade;
    const e = num(cfg.exposure, 0.4, 2.2, this.exposure);
    this.exposure = e;

    const u = this.compositeMat.uniforms;
    const warm = this.gradeOn ? 1 : 0;
    u.uBloomQ_W.value = b.intensity * 0.62;
    u.uBloomE_W.value = b.mips >= 2 ? b.intensity * 0.38 : 0.0;
    u.uExposure.value = e;
    u.uContrast.value = g.contrast * warm;
    u.uShadowLift.value = g.shadowLift * warm;
    u.uWarmAmt.value = g.warmAmt * warm;
    u.uCoolAmt.value = g.coolAmt * warm;
    u.uSatGreen.value = g.satGreen * warm;
    u.uSatBrown.value = g.satBrown * warm;
    u.uVignette.value = g.vignette * warm;
    u.uGrain.value = g.grain * warm;
    u.uGrainSpeed.value = g.grainSpeed;
    u.uWarmHi.value.set(g.warmHi[0], g.warmHi[1], g.warmHi[2]);
    u.uCoolSh.value.set(g.coolSh[0], g.coolSh[1], g.coolSh[2]);
    for (const m of [this.brightMat, this.blurMat]) {
      m.uniforms.uTaps.value = b.taps;
      m.uniforms.uSigma.value = b.sigma;
      m.uniforms.uRadius.value = b.radius;
    }
    this.brightMat.uniforms.uThreshold.value = b.threshold;
    this.brightMat.uniforms.uKnee.value = b.knee;
    this._allocMip = b.mips >= 2;
    return this.graph;
  }

  /** Called by the light rig so the grade tracks the day: warmth rides the split
   *  tone amounts, exposure rides the rig. */
  setRig(rig) {
    if (!rig) return;
    const g = POST_TUNE.grade;
    const u = this.compositeMat.uniforms;
    const warm = this.gradeOn ? 1 : 0;
    const w = num(rig.warmth, 0, 1, 0.5);
    u.uWarmAmt.value = g.warmAmt * warm * (0.55 + 0.75 * w);
    u.uCoolAmt.value = g.coolAmt * warm * (1.35 - 0.55 * w);
    u.uExposure.value = this.exposure * (0.90 + 0.10 * (rig.exposure || 1));
  }

  setSize(w, h) {
    const caps = this.renderer.capabilities;
    const hasExt = (n) => (typeof this.renderer.extensions.has === 'function' ? this.renderer.extensions.has(n) : false);
    const canHalf = caps.isWebGL2 && (hasExt('EXT_color_buffer_half_float') || hasExt('EXT_color_buffer_float'));
    const type = (canHalf && !this.forceLDR) ? THREE.HalfFloatType : THREE.UnsignedByteType;
    const opts = { type, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, format: THREE.RGBAFormat };
    const old = [this.rtScene, this.rtBQ, this.rtQB, this.rtBE, this.rtEB, this.rtShaft];
    for (const rt of old) if (rt) rt.dispose();
    // The DOF taps need to READ the depth, so the scene target carries a sampled
    // depth attachment (nearest, no mips: depth buffers are not filterable).
    this.rtScene = new THREE.WebGLRenderTarget(w, h, {
      ...opts, depthBuffer: true, stencilBuffer: false,
      depthTexture: new THREE.DepthTexture(w, h),
    });
    const qw = Math.max(1, Math.round(w / 4)), qh = Math.max(1, Math.round(h / 4));
    const ew = Math.max(1, Math.round(w / 8)), eh = Math.max(1, Math.round(h / 8));
    this.rtBQ = new THREE.WebGLRenderTarget(qw, qh, { ...opts, depthBuffer: false });
    this.rtQB = new THREE.WebGLRenderTarget(qw, qh, { ...opts, depthBuffer: false });
    this.rtBE = new THREE.WebGLRenderTarget(ew, eh, { ...opts, depthBuffer: false });
    this.rtEB = new THREE.WebGLRenderTarget(ew, eh, { ...opts, depthBuffer: false });
    this.rtShaft = new THREE.WebGLRenderTarget(ew, eh, { ...opts, depthBuffer: false });
    this._size.set(w, h);
    this._texel = { s: [1 / w, 1 / h], q: [1 / qw, 1 / qh], e: [1 / ew, 1 / eh] };
    this.compositeMat.uniforms.uRes.value.set(w, h);
    // Half-float only where the driver can actually complete an FBO with it; on a
    // driver without it the composite would come out black, so gate the whole stack.
    this.ok = !!canHalf;
    if (this.enabled) this.graph = passGraph({ post: this.ok, bloom: this.level, shafts: this.shaftsOn });
    this.setConfig({ bloom: this.level, grade: this.gradeOn, post: this.enabled, exposure: this.exposure });
  }

  /** Ground speed, pushed by render/camera.js every frame. Clamped here, never
   *  trusted; radialBlurAmount() does the rest. */
  setSpeed(v) { this.speedIn = num(v, 0, 200, 0); }

  /** Auto-focus distance in metres (camera -> car), pushed by the frame loop next to
   *  setSpeed. Clamped by dofFocus(): a bumper cam 0.5 m off the nose still focuses
   *  on the road ahead of it instead of putting the whole frame in the blur band. */
  setFocus(v) { this.focusIn = dofFocus(v); }

  /** Screen-space sun + the 0..1 "is it in (or near) the frame" term the shafts, the
   *  lens flare and the blur all key off. Uses the camera matrices the scene render
   *  just left current, so no extra matrix work. */
  _sunOnScreen(camera, rig) {
    const dir = rig && rig.sunDir;
    _sunInfo.uv = null; _sunInfo.vis = 0;
    if (!dir) return _sunInfo;
    _sunPos.set(camera.position.x + dir.x * 400, camera.position.y + dir.y * 400, camera.position.z + dir.z * 400);
    camera.getWorldDirection(_sunFwd);
    const inFront = (_sunFwd.x * dir.x + _sunFwd.y * dir.y + _sunFwd.z * dir.z) > 0.0;
    _sunNdc.copy(_sunPos).project(camera);
    if (!Number.isFinite(_sunNdc.x) || !Number.isFinite(_sunNdc.y)) return _sunInfo;
    _sunInfo.vis = sunVisibility(_sunNdc.x, _sunNdc.y, inFront, ATMO_TUNE.shafts.edgeFade);
    _sunInfo.uv = _sunNdc;
    return _sunInfo;
  }

  render(scene, camera, rig, time) {
    const r = this.renderer;
    const b = POST_TUNE.bloom[this.level];
    const T = this._texel;
    const twoMip = b.mips >= 2;

    r.setRenderTarget(this.rtScene);
    r.render(scene, camera);
    // info resets on every render(), so the scene's cost is read here, before the
    // quads: the reported draw calls are identical to the raw path.
    this.calls = r.info.render.calls;
    this.tris = r.info.render.triangles;

    const bu = this.brightMat.uniforms;
    bu.uScene.value = this.rtScene.texture;
    bu.uGain.value = 1;

    // 1) bright + horizontal gaussian, quarter
    bu.uOff.value.set(T.q[0] * 0.5, T.q[1] * 0.5);
    this.quad.material = this.brightMat;
    r.setRenderTarget(this.rtBQ);
    r.render(this.passScene, this.passCam);

    // 2) vertical gaussian, quarter
    const lu = this.blurMat.uniforms;
    lu.uSrc.value = this.rtBQ.texture;
    lu.uDir.value.set(0, T.q[1]);
    this.quad.material = this.blurMat;
    r.setRenderTarget(this.rtQB);
    r.render(this.passScene, this.passCam);

    const u = this.compositeMat.uniforms;
    u.uBloomQ.value = this.rtQB.texture;

    // ---- sun shafts: the one extra quad (eighth res), 0 alpha when the sun is off
    // frame, so it never lights a frame the sun is not in.
    const sun = this._sunOnScreen(camera, rig);
    const su = this.shaftMat.uniforms;
    const sAmt = this.shaftsOn
      ? shaftAlpha({ post: this.enabled, bloom: this.level, sunVis: sun.vis,
        sun: num(rig && (rig.sunAmount !== undefined ? rig.sunAmount : rig.sunIntensity), 0, 1, 1) })
      : 0;
    if (sun.uv) su.uSunUv.value.set(sun.uv.x * 0.5 + 0.5, sun.uv.y * 0.5 + 0.5);
    su.uScene.value = this.rtScene.texture;
    su.uAmt.value = sAmt;
    su.uTime.value = time || 0;
    if (this.shaftsOn) {
      this.quad.material = this.shaftMat;
      r.setRenderTarget(this.rtShaft);
      r.render(this.passScene, this.passCam);
    }
    u.uShaft.value = this.rtShaft.texture;
    u.uShaftW.value = 1;

    // ---- lens dirt + edge blur: folded into the composite, zero extra passes.
    if (sun.uv) u.uSunUv.value.copy(su.uSunUv.value);
    u.uLensAmt.value = lensFlareAlpha({ post: this.enabled, sunVis: sun.vis, lensDirt: settings.lensDirt });
    u.uRadial.value = radialBlurAmount({
      post: this.enabled, speed: this.speedIn,
      gain: this.level === 'LOW' ? 0.55 : (this.level === 'HIGH' ? 1.0 : 0.85),
    });

    // ---- depth of field: no pass, one depth read and up to 4 scene taps per pixel,
    // and only for pixels the depth ramp says are far. Zero with POST off or without
    // a sampled depth attachment, so the cheap path is the old path exactly.
    const dp = this.rtScene.depthTexture;
    const px = dp ? dofRadiusPx({ post: this.enabled, level: this.level, height: this._size.y }) : 0;
    this.dofPx = px;
    u.uDepth.value = dp || null;
    u.uDofPx.value = px;
    u.uDofTaps.value = dofTapCount(this.level);
    u.uFocus.value = this.focusIn;
    u.uDofNear.value = DOF_TUNE.nearFlat;
    u.uDofSpan.value = DOF_TUNE.farSpan;
    u.uNearP.value = camera.near;
    u.uFarP.value = camera.far;

    if (twoMip) {
      // 3) bright + horizontal gaussian, eighth (wider taps: 2 source texels apart)
      bu.uOff.value.set(T.e[0], T.e[1]);
      this.quad.material = this.brightMat;
      r.setRenderTarget(this.rtBE);
      r.render(this.passScene, this.passCam);
      // 4) vertical gaussian, eighth
      lu.uSrc.value = this.rtBE.texture;
      lu.uDir.value.set(0, T.e[1] * 1.4);
      this.quad.material = this.blurMat;
      r.setRenderTarget(this.rtEB);
      r.render(this.passScene, this.passCam);
      u.uBloomE.value = this.rtEB.texture;
      u.uBloomE_W.value = b.intensity * 0.38;
    } else {
      u.uBloomE.value = this.rtQB.texture;
      u.uBloomE_W.value = 0.0;
    }

    u.uScene.value = this.rtScene.texture;
    this.setRig(rig);
    u.uTime.value = time || 0;
    this.quad.material = this.compositeMat;
    r.setRenderTarget(null);
    r.render(this.passScene, this.passCam);
  }
}

export const clampTune = num;
