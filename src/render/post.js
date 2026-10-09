// Single-pass post composite (docs/04 §6, docs/07 risk R?: "własny jednopassowy
// composite, nie EffectComposer"). Three custom passes, one fullscreen quad, no
// composer chain, no dependency:
//   1) scene -> rtScene (linear HDR, + depth attachment)
//   2) quarter-res gather: bloom threshold AND the sunshaft optical-depth integral
//      (both read the same taps, so the shafts cost no extra pass)
//   3) quarter-res blur (9-tap spider, shared by bloom and shafts)
//   4) composite: bloom + shafts + ACES + contrast grade with a warm dominant +
//      film grain + vignette -> canvas
//
// Budget notes (docs/07 §Budżety techniczne): the two quarter-res passes touch
// 1/16 of the pixels, so they add well under a millisecond of fill; the composite
// is one full-screen pass. Everything is preallocated: no `new`, no object/array
// literal in composite() (docs/06: no per-frame allocation).
import * as THREE from 'three';

const VERT = `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

// ---- pass 2: gather at 1/4 resolution -------------------------------------
// rgb = bloom source (soft-thresholded scene), a = sunshaft weight.
// The shafts are screen-space: march K taps from the pixel toward the sun's screen
// position and integrate how much *sun-facing air* (bright, sky-lit) lies along
// that path, but only where this pixel is not open sky itself. Dark geometry
// (trunks, banks, the car) fails the mask and blocks the path, which is what makes
// the shafts appear *between* trees and thin out over the road. Mask-based rather
// than depth-based: no DepthTexture (ANGLE/SwiftShader does not always give a
// complete FBO with one attached) and no extra pass.
const GATHER_FRAG = `
varying vec2 vUv;
uniform sampler2D uScene;
uniform vec2 uTexel;        // 1/quarter-resolution
uniform vec2 uSunUV;
uniform float uShaftTaps, uShaftGain, uShaftLen, uShaftFalloff;
uniform float uSkyLo, uSkyHi;
uniform float uTime;
uniform float uThreshold, uKnee;

float lum(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }

void main() {
  vec2 uv = vUv;
  // 5-tap tent downsample: cheaper than a separate resize pass.
  vec3 s = texture2D(uScene, uv).rgb * 0.4;
  s += (texture2D(uScene, uv + vec2(uTexel.x, 0.0)).rgb
      + texture2D(uScene, uv - vec2(uTexel.x, 0.0)).rgb
      + texture2D(uScene, uv + vec2(0.0, uTexel.y)).rgb
      + texture2D(uScene, uv - vec2(0.0, uTexel.y)).rgb) * 0.15;

  float l = lum(s);
  float soft = clamp(l - uThreshold, 0.0, uKnee) / max(1e-4, uKnee);
  vec3 bloom = s * soft * step(uThreshold * 0.6, l);

  // ---- sunshafts ----
  float here = smoothstep(uSkyLo, uSkyHi, l);      // open sky here -> no shaft to draw
  vec2 toSun = uSunUV - uv;
  float sunDist = length(toSun);
  vec2 stepv = toSun / max(1e-4, sunDist) * uShaftLen;
  float acc = 0.0;
  float wsum = 0.0;
  for (int i = 0; i < 8; i++) {
    if (float(i) >= uShaftTaps) break;
    vec2 p = uv + stepv * (float(i) + 0.5);
    if (p.x < 0.0 || p.x > 1.0 || p.y < 0.0 || p.y > 1.0) break;
    float m = smoothstep(uSkyLo, uSkyHi, lum(texture2D(uScene, p).rgb));
    float w = 1.0 - float(i) / max(1e-3, uShaftTaps);
    acc += m * w;
    wsum += w;
  }
  float shaft = acc / max(1e-3, wsum);
  shaft *= (1.0 - here) * exp(-sunDist * uShaftFalloff);
  // Noise break-up so the shafts are not a clean radial smear.
  float n = fract(sin(dot(floor(uv / uTexel), vec2(127.1, 311.7))) * 43758.5453);
  shaft *= 0.60 + 0.80 * n;
  shaft *= uShaftGain;

  gl_FragColor = vec4(bloom, clamp(shaft, 0.0, 2.0));
}
`;

// ---- pass 3: quarter-res blur (shared bloom + shafts) --------------------
const BLUR_FRAG = `
varying vec2 vUv;
uniform sampler2D uSrc;
uniform vec2 uTexel;
void main() {
  vec4 a = texture2D(uSrc, vUv) * 0.24;
  vec2 r1 = uTexel * 2.0, r2 = uTexel * 4.5;
  a += (texture2D(uSrc, vUv + r1) + texture2D(uSrc, vUv - r1)
      + texture2D(uSrc, vUv + vec2(r1.y, -r1.x)) + texture2D(uSrc, vUv - vec2(r1.y, -r1.x))) * 0.14;
  a += (texture2D(uSrc, vUv + r2) + texture2D(uSrc, vUv - r2)
      + texture2D(uSrc, vUv + vec2(r2.y, -r2.x)) + texture2D(uSrc, vUv - vec2(r2.y, -r2.x))) * 0.07;
  gl_FragColor = a;
}
`;

// ---- pass 4: composite ---------------------------------------------------
const COMPOSITE_FRAG = `
varying vec2 vUv;
uniform sampler2D uScene;
uniform sampler2D uGlow;      // rgb bloom, a shafts
uniform float uExposure, uBloom, uShaftColor;
uniform float uContrast, uWarm, uGrain, uVignette, uTime;
uniform vec2 uRes;
uniform vec3 uShaftTint;

vec3 aces(vec3 x) {
  const float a = 0.0243, b = 0.0300, c = 0.2837, d = 0.2047, e = 0.0583;
  return clamp((x * (x + a) - b) / (x * (c * x + d) - e), 0.0, 1.0);
}

void main() {
  vec3 c = texture2D(uScene, vUv).rgb;
  vec4 g = texture2D(uGlow, vUv);

  c += g.rgb * uBloom;
  // Shafts are light in the air, so they add warm scatter and desaturate a little.
  c += uShaftTint * g.a * uShaftColor;

  c *= uExposure;
  c = aces(c);

  // Contrast grade with a warm dominant (PLAN §10 "grade: krzywa kontrastu +
  // ciepła dominanta"): split-tone — warm highlights, cool shadows lifted by sky.
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  vec3 warm = vec3(1.075, 1.005, 0.885);
  c = mix(c, c * warm, 0.55 * uWarm * smoothstep(0.10, 0.85, l));
  vec3 cool = vec3(0.86, 0.94, 1.10);
  c = mix(c, c * cool, 0.30 * uWarm * smoothstep(0.30, 0.02, l));
  vec3 d = c - 0.5;
  c = 0.5 + d * (1.0 + uContrast * (1.0 - 1.15 * abs(d)));

  // Vignette: gentle, keeps the road readable (PLAN §8 #5 — no "swimming").
  vec2 q = (vUv - 0.5) * vec2(1.0, 1.0);
  float v = 1.0 - uVignette * dot(q, q) * 1.35;
  c *= clamp(v, 0.55, 1.0);

  // Film grain (docs/04 §6): hashed per pixel, animated at frame rate, luminance
  // weighted so it does not dirty the mid greys of the road.
  float gi = fract(sin(dot(floor(vUv * uRes) + floor(uTime * 60.0), vec2(12.9898, 78.233))) * 43758.5453);
  c += (gi - 0.5) * uGrain * (0.35 + 0.85 * (1.0 - l));

  // Manual linear -> sRGB: this ShaderMaterial bypasses three's colorspace pass.
  c = max(c, vec3(0.0));
  c = mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
  gl_FragColor = vec4(c, 1.0);
}
`;

export class PostChain {
  constructor(renderer) {
    this.renderer = renderer;
    this.enabled = false;
    this.shafts = false;
    this.ok = false;
    this.forceLDR = false;      // ?rt8=1 diagnostic / driver fallback
    this.calls = 0; this.tris = 0;

    this.geo = new THREE.PlaneGeometry(2, 2);
    this.quad = new THREE.Mesh(this.geo, null);
    this.quad.frustumCulled = false;
    this.passScene = new THREE.Scene();
    this.passScene.add(this.quad);
    this.passCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

    this.gatherMat = new THREE.ShaderMaterial({
      vertexShader: VERT, fragmentShader: GATHER_FRAG, depthTest: false, depthWrite: false,
      uniforms: {
        uScene: { value: null }, uTexel: { value: new THREE.Vector2(0.004, 0.004) },
        uSunUV: { value: new THREE.Vector2(0.5, 0.5) },
        uShaftTaps: { value: 6 }, uShaftGain: { value: 0 }, uShaftLen: { value: 0.09 }, uShaftFalloff: { value: 2.4 },
        uSkyLo: { value: 0.40 }, uSkyHi: { value: 0.80 },
        uTime: { value: 0 }, uThreshold: { value: 0.62 }, uKnee: { value: 0.55 },
      },
    });
    this.blurMat = new THREE.ShaderMaterial({
      vertexShader: VERT, fragmentShader: BLUR_FRAG, depthTest: false, depthWrite: false,
      uniforms: { uSrc: { value: null }, uTexel: { value: new THREE.Vector2(0.004, 0.004) } },
    });
    this.compositeMat = new THREE.ShaderMaterial({
      vertexShader: VERT, fragmentShader: COMPOSITE_FRAG, depthTest: false, depthWrite: false,
      uniforms: {
        uScene: { value: null }, uGlow: { value: null }, uExposure: { value: 1.05 }, uBloom: { value: 0.55 },
        uShaftColor: { value: 0.9 }, uShaftTint: { value: new THREE.Vector3(1.0, 0.82, 0.58) },
        uContrast: { value: 0.22 }, uWarm: { value: 0.7 }, uGrain: { value: 0.035 },
        uVignette: { value: 0.30 }, uTime: { value: 0 }, uRes: { value: new THREE.Vector2(1280, 720) },
      },
    });

    this.rtScene = null; this.rtA = null; this.rtB = null;
    this._v3 = new THREE.Vector3();
    this._w = new THREE.Vector3();
    this._size = new THREE.Vector2();
    this._hdr = false;
    this.setSize(1280, 720);
  }

  setSize(w, h) {
    // Half-float only where the driver actually lets you render into it: on a
    // driver without EXT_color_buffer_float(½) the FBO would be incomplete and
    // the whole frame would come out black (docs/04 §6 must degrade, not die).
    const caps = this.renderer.capabilities;
    const hasExt = (n) => (typeof this.renderer.extensions.has === 'function' ? this.renderer.extensions.has(n) : false);
    const canHalf = caps.isWebGL2 && (hasExt('EXT_color_buffer_half_float') || hasExt('EXT_color_buffer_float'));
    const type = (canHalf && !this.forceLDR) ? THREE.HalfFloatType : THREE.UnsignedByteType;
    const dispose = [this.rtScene, this.rtA, this.rtB];
    for (const rt of dispose) if (rt) rt.dispose();
    this.rtScene = new THREE.WebGLRenderTarget(w, h, {
      type, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
      format: THREE.RGBAFormat, depthBuffer: true, stencilBuffer: false,
    });
    const qw = Math.max(1, Math.round(w / 4)), qh = Math.max(1, Math.round(h / 4));
    this.rtA = new THREE.WebGLRenderTarget(qw, qh, { type, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, format: THREE.RGBAFormat, depthBuffer: false });
    this.rtB = new THREE.WebGLRenderTarget(qw, qh, { type, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, format: THREE.RGBAFormat, depthBuffer: false });
    this._size.set(w, h);
    this.gatherMat.uniforms.uTexel.value.set(1 / qw, 1 / qh);
    this.blurMat.uniforms.uTexel.value.set(1 / qw, 1 / qh);
    this.compositeMat.uniforms.uRes.value.set(w, h);
    this._hdr = canHalf;
    this.ok = true;
  }

  /**
   * Anchor the shafts on the sun: project a far point along the sun direction into
   * screen UV. Preallocated vectors only — this runs every frame.
   */
  setSun(camera, dir, gain) {
    const c = camera;
    this._v3.copy(dir).multiplyScalar(600).add(c.position);
    this._v3.project(c);
    const u = this.gatherMat.uniforms.uSunUV.value;
    u.x = Math.max(-0.6, Math.min(1.6, this._v3.x * 0.5 + 0.5));
    u.y = Math.max(-0.6, Math.min(1.6, this._v3.y * 0.5 + 0.5));
    // Facing term: shafts read strongest when the key is in front of the camera.
    c.getWorldDirection(this._w);
    const facing = Math.max(0, this._w.dot(dir));
    this.gatherMat.uniforms.uShaftGain.value = gain * (0.30 + 0.70 * facing);
  }

  composite(scene, camera, rig, time) {
    const r = this.renderer;
    const u = this.compositeMat.uniforms;

    r.setRenderTarget(this.rtScene);
    r.render(scene, camera);
    // renderer.info is reset by every render() call, so the scene's own cost has
    // to be read here or the composite quad would be reported as the whole frame.
    this.calls = r.info.render.calls;
    this.tris = r.info.render.triangles;

    this.gatherMat.uniforms.uScene.value = this.rtScene.texture;
    this.gatherMat.uniforms.uTime.value = time;
    this.quad.material = this.gatherMat;
    r.setRenderTarget(this.rtA);
    r.render(this.passScene, this.passCam);

    this.blurMat.uniforms.uSrc.value = this.rtA.texture;
    this.quad.material = this.blurMat;
    r.setRenderTarget(this.rtB);
    r.render(this.passScene, this.passCam);

    u.uScene.value = this.rtScene.texture;
    u.uGlow.value = this.rtB.texture;
    u.uExposure.value = rig.exposure;
    u.uWarm.value = rig.warmth;
    u.uTime.value = time;
    if (this.shafts) {
      u.uShaftColor.value = 0.9;
      this._v3.copy(rig.sunColor).multiplyScalar(0.55).addScaledVector(rig.hemiSky, 0.15);
      u.uShaftTint.value.set(
        Math.min(2.2, this._v3.r * 1.35 + 0.22),
        Math.min(2.2, this._v3.g * 1.2 + 0.15),
        Math.min(2.2, this._v3.b * 0.95 + 0.08),
      );
    } else {
      u.uShaftColor.value = 0.0;
    }
    this.quad.material = this.compositeMat;
    r.setRenderTarget(null);
    r.render(this.passScene, this.passCam);
  }
}
