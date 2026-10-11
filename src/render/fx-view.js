// The five FX pools drawn: one THREE.Points per pool, one draw call each, over a
// view onto the pool's own Float32Array (render-side never copies, never
// allocates). The flame gradient, the soot puff, the dust puff, the leaf and the
// mote are all procedural in the fragment shader - no texture asset, no atlas.
import * as THREE from 'three';
import { STRIDE, F } from '../fx/fx.js';

const VERT = `
attribute float aLife;
attribute float aTtl;
attribute float aSize;
attribute float aHeat;
uniform float uScale;
uniform float uFog;
uniform int uMode;
varying float vAge;
varying float vHeat;
varying float vFog;
void main() {
  vAge = 1.0 - clamp(aLife / max(aTtl, 0.0001), 0.0, 1.0);
  vHeat = aHeat;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  float dist = max(0.5, -mv.z);
  vFog = 1.0 - exp(-dist * uFog);
  gl_Position = projectionMatrix * mv;
  // Soot (mode 4) expands as it cools; everything else keeps its seed size.
  float grow = (uMode == 4) ? 1.0 + vAge * 1.7 : 1.0;
  gl_PointSize = max(1.0, aSize * grow * uScale * 260.0 / dist);
}`;

// MODE 0 flame, 1 dust, 2 leaf, 3 mote, 4 shift soot. Same program family, one
// uniform switch, so the whole FX stack is five programs at most and never a
// material per particle.
const FRAG = `
precision mediump float;
uniform int uMode;
uniform float uOpacity;
uniform vec3 uTint;
varying float vAge;
varying float vHeat;
varying float vFog;
void main() {
  vec2 p = gl_PointCoord - 0.5;
  float r = length(p) * 2.0;
  vec3 c = uTint;
  float a = 0.0;
  if (uMode == 0) {                    // backfire plume: white core -> amber -> ember
    float t = clamp(vHeat, 0.0, 1.6);
    vec3 hot = mix(vec3(1.0, 0.93, 0.70), vec3(1.0, 0.55, 0.16), vAge);
    vec3 mid = mix(vec3(1.0, 0.62, 0.22), vec3(0.55, 0.12, 0.04), vAge);
    c = mix(hot, mid, clamp(vAge * 1.4, 0.0, 1.0)) * (0.55 + 0.45 * t);
    a = (1.0 - smoothstep(0.15, 1.0, r)) * (1.0 - vAge) * (0.55 + 0.45 * t);
  } else if (uMode == 1) {             // wheel dust: big soft grey-brown puff
    c = uTint * (0.85 + 0.35 * vHeat);
    // Soft edge, eases in, fades out on a curve - it never pops out of existence.
    a = (1.0 - smoothstep(0.12, 1.05, r)) * smoothstep(0.0, 0.12, vAge)
      * (1.0 - vAge * vAge) * 0.55 * (0.4 + 0.6 * vHeat);
  } else if (uMode == 4) {             // shift soot: dark grey to black, expanding
    c = mix(vec3(0.035, 0.035, 0.04), vec3(0.24, 0.235, 0.225), clamp(vAge * 0.85, 0.0, 1.0));
    // Warm inner core, only for a rev-matched downshift (vHeat is its 0..1 flag).
    c += vec3(0.75, 0.30, 0.08) * clamp(vHeat, 0.0, 1.0) * (1.0 - r) * (1.0 - vAge);
    a = (1.0 - smoothstep(0.10, 1.0, r)) * smoothstep(0.0, 0.10, vAge)
      * (1.0 - vAge * vAge) * (0.78 - 0.30 * vAge);
  } else if (uMode == 2) {             // leaf / needle: small tumbling quad-ish flake
    float e = max(abs(p.x), abs(p.y)) * 2.0;
    float wob = 0.55 + 0.45 * abs(sin(vAge * 9.0 + vHeat * 20.0));
    c = mix(vec3(0.34, 0.42, 0.16), vec3(0.62, 0.44, 0.14), vHeat) * (0.7 + 0.5 * wob);
    a = (1.0 - smoothstep(0.55 * wob, 1.0, e)) * (1.0 - vAge * vAge) * 0.9;
  } else {                             // mote: pinpoint that flares in the sunlight
    a = pow(max(0.0, 1.0 - r), 8.0) * vHeat * (0.35 + 0.65 * sin(vAge * 3.0 + 1.2));
    c = uTint;
  }
  a *= uOpacity * (1.0 - vFog);
  if (a <= 0.004) discard;
  gl_FragColor = vec4(c, a);
}`;

function makeSystem(pool, mode, tint, opacity, additive) {
  const buf = new THREE.InterleavedBuffer(pool.data, STRIDE);
  buf.setUsage(THREE.DynamicDrawUsage);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.InterleavedBufferAttribute(buf, 3, F.X));
  geo.setAttribute('aLife', new THREE.InterleavedBufferAttribute(buf, 1, F.LIFE));
  geo.setAttribute('aTtl', new THREE.InterleavedBufferAttribute(buf, 1, F.TTL));
  geo.setAttribute('aSize', new THREE.InterleavedBufferAttribute(buf, 1, F.SIZE));
  geo.setAttribute('aHeat', new THREE.InterleavedBufferAttribute(buf, 1, F.HEAT));
  const mat = new THREE.ShaderMaterial({
    vertexShader: VERT,
    fragmentShader: FRAG,
    uniforms: {
      uMode: { value: mode },
      uOpacity: { value: opacity },
      uScale: { value: 1 },
      uFog: { value: 0.006 },
      uTint: { value: new THREE.Color(tint) },
    },
    transparent: true,
    depthWrite: false,
    blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
  });
  const pts = new THREE.Points(geo, mat);
  pts.frustumCulled = false;          // the pool buffer is not a bounded cloud
  pts.renderOrder = additive ? 3 : 2;
  return { pts, geo, mat, buf, pool };
}

/** Five systems, five draw calls, added once to the scene. */
export function buildFxView(fx) {
  const group = new THREE.Group();
  group.matrixAutoUpdate = false;
  const flame = makeSystem(fx.flame, 0, 0xffb066, 1.0, true);
  const dust = makeSystem(fx.dust, 1, 0xb59c7e, 0.75, false);
  const leaves = makeSystem(fx.leaves, 2, 0x7d8a3c, 0.9, false);
  const motes = makeSystem(fx.motes, 3, 0xfff2d2, 0.85, true);
  const soot = makeSystem(fx.soot, 4, 0x141414, 0.9, false);   // normal blend: it darkens
  group.add(flame.pts, dust.pts, leaves.pts, motes.pts, soot.pts);
  return { group, flame, dust, leaves, motes, soot, live: -1 };
}

/** Per-frame: hand the (in-place updated) pool buffer to the GPU. No allocation. */
export function syncFxView(view, fx, env) {
  const sys = [view.flame, view.dust, view.leaves, view.motes, view.soot];
  for (let i = 0; i < sys.length; i++) {
    const s = sys[i];
    const on = fx.enabled && s.pool.count > 0;
    s.pts.visible = on;
    if (!on) continue;
    s.geo.setDrawRange(0, s.pool.count);
    s.buf.needsUpdate = true;
  }
  view.flame.mat.uniforms.uOpacity.value = 0.55 + 0.35 * fx.exhaust.strength;  // a pop, not a torch
  view.motes.mat.uniforms.uOpacity.value = 0.35 + 0.5 * ((env && env.sun) || 1);
  view.dust.mat.uniforms.uOpacity.value = 0.7;
}
