// Lens dirt overlay (docs/04 §6 "brud na obiektywie"): one fullscreen quad drawn
// after the scene, so it costs exactly one draw call and never touches the car
// shader. The look is deliberately different from panel dirt — out-of-focus
// blobs and a haze, not streaks on a surface.
import * as THREE from 'three';
import { LENS_BLOBS } from '../dirt/lens.js';

const VERT = `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

const FRAG = `
varying vec2 vUv;
uniform float uSmudge;   // overall haze 0..1
uniform float uGrime;    // dried splatter 0..1
uniform float uWet;      // water film 0..1
uniform float uPhase;    // wiper sweep position, 0 = idle
uniform float uTime;
uniform vec4 uBlobs[${LENS_BLOBS}];

float blob(vec2 p, vec4 b) {
  vec2 d = (p - b.xy) / max(0.012, b.z);
  // Soft, out-of-focus: a smooth kernel, no hard edge anywhere.
  return exp(-dot(d, d) * 1.6) * b.w;
}

void main() {
  vec2 p = vUv;
  float dirt = 0.0;

  for (int i = 0; i < ${LENS_BLOBS}; i++) {
    vec4 b = uBlobs[i];
    if (i >= ${LENS_BLOBS}) break;
    dirt += blob(p, b);
  }

  // Splatter speckle: high-frequency dots that only appear with dried grime.
  vec2 cell = floor(p * 90.0);
  float h = fract(sin(dot(cell, vec2(127.1, 311.7))) * 43758.5453);
  float speck = step(0.93 - 0.10 * uGrime, h) * uGrime;

  // Grime smeared across the whole frame + the haze.
  float smear = uGrime * (0.12 + 0.07 * fract(sin(dot(floor(p * 22.0), vec2(41.7, 91.3))) * 24634.1));
  // Weights are deliberately low: this quad sits between the player and the road,
  // and docs/04 §6 is about flavour, not about losing the corner entry (PLAN.md §8 #5).
  float total = clamp(dirt * 0.75 + speck * 0.35 + smear + uSmudge * 0.38, 0.0, 0.72);

  // Wiper: a clean band sweeping across the frame, dirt cleared behind it.
  if (uPhase > 0.0) {
    float x = uPhase * 1.35 - 0.18;
    float cleared = smoothstep(x - 0.16, x + 0.02, p.x);
    total *= mix(1.0, 0.12, cleared);
  }

  // Water film is a colour shift, not just a darkening.
  float a = clamp(total * 0.55 + uWet * 0.20, 0.0, 0.60);
  vec3 col = mix(vec3(0.22, 0.19, 0.15), vec3(0.55, 0.62, 0.68), uWet);
  gl_FragColor = vec4(col * (0.55 + 0.45 * total), a);
}
`;

/**
 * Returns an object main.js calls after the main render: `draw(renderer)`.
 * Uniforms are created once and written in place (no per-frame allocation).
 */
export function attachDirtLens(renderer) {
  const scene = new THREE.Scene();
  const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const blobs = [];
  for (let i = 0; i < LENS_BLOBS; i++) blobs.push(new THREE.Vector4(0, 0, 0.05, 0));
  const mat = new THREE.ShaderMaterial({
    vertexShader: VERT,
    fragmentShader: FRAG,
    transparent: true,
    depthTest: false,
    depthWrite: false,
    uniforms: {
      uSmudge: { value: 0 }, uGrime: { value: 0 }, uWet: { value: 0 },
      uPhase: { value: 0 }, uTime: { value: 0 }, uBlobs: { value: blobs },
    },
  });
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat);
  quad.frustumCulled = false;
  scene.add(quad);

  return {
    quad,
    update(lens) {
      mat.uniforms.uSmudge.value = lens.smudge;
      mat.uniforms.uGrime.value = lens.grime;
      mat.uniforms.uWet.value = lens.wet;
      mat.uniforms.uPhase.value = lens.wiperPhase;
      for (let i = 0; i < LENS_BLOBS; i++) {
        const b = blobs[i];
        b.set(lens.blobs[i * 4], lens.blobs[i * 4 + 1], lens.blobs[i * 4 + 2] || 0.05, lens.blobs[i * 4 + 3]);
      }
    },
    draw(r) {
      // Exclusive with the composite's sun-keyed lens flare (composer.js COMPOSITE_FRAG,
      // uLensAmt): with POST on the flare already carries the dirt, so drawing this quad
      // on top doubles the smudge. With POST off the composite never runs, so the quad
      // is the only lens there is.
      const post = r && r.post;
      if (post && post.enabled) return;
      const gl = r.renderer || r;
      mat.uniforms.uTime.value = performance.now() * 0.001;
      const prev = gl.autoClear;
      gl.autoClear = false;
      gl.render(scene, cam);
      gl.autoClear = prev;
    },
  };
}
