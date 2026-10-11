// Headlight beams for a dark stage (docs/04 §1 "światło", PLAN §10 "noc i deszcz nie
// moga byc osobnym kodem"). A night frame needs two things from the lamps: the road in
// front has to be lit (a real SpotLight, which feeds the same MeshStandardMaterial
// graph the terrain already uses), and the beam itself has to be visible in the air,
// which no light can do - it takes geometry. Two open cone shells per lamp, additive,
// depth-tested but never depth-writing: with DoubleSide a ray through the middle of a
// shell crosses it twice, so the core of the shaft is denser than its edge for free
// (path length without any normal maths, no texture, no post pass).
//
// Cost is bounded and counted: 2 lamps x (rings-1) bands x `segments` quads x 2 tris.
// At 3 rings / 12 segments that is 96 triangles on a frame budget of ~220k (docs/07
// §Budżety), one extra draw call per lamp, and no shadow map: a shadowed spot would
// buy a 20 m pool of light a whole extra depth pass.
//
// Deliberately THREE-free (same reason as render/road-skin.js, world/props.js and
// render/car-asset.js): it exports plain typed arrays plus a material spec, so
// src/debug/tests.js (T29) can pin the numbers, the geometry and the blend contract
// headless while render/carMesh.js is the only place that touches THREE.
export const BEAM = {
  // When the stage is dark enough for the lamps to be worth drawing at all. DUSK
  // stages roll tod 0.80-0.87 (world/road-spline.js stageClimate), the lighting rig's
  // night key stop sits at 0.92-1.00, so both halves of that band are "dark".
  darkAbove: 0.78,
  darkBelow: 0.22,

  // Spot light: the pool on the road. Kept at the values the car shipped with.
  spot: { intensity: 46, distance: 34, angle: 0.55, penumbra: 0.62, decay: 1.3 },
  color: 0xffeecd,

  // Where the lamps sit on the car body and where they aim: ahead of the nose, down
  // onto the road, and splayed outward so the two pools merge past ~20 m.
  lamp: { ahead: 0.25, up: 0.34, side: 0.6 },
  aim: { ahead: 17, drop: 2.0, spread: 1.7 },

  // The visible volume: rings run from the lens to `reach` (must stay inside the spot
  // cut-off, or the shaft would reach past the light that is supposed to be causing
  // it). Alpha peaks at the middle ring so the beam does not start as a hard disc at
  // the lens and dies to nothing at the far end instead of a cut in mid-air.
  reach: 20,
  rings: [{ t: 0, r: 0.10, a: 0.34 }, { t: 0.30, r: 0.95, a: 1.0 }, { t: 1, r: 2.35, a: 0 }],
  segments: 12,
  // Peak additive alpha per shell wall. A ray down the axis crosses every band twice,
  // so the core lands near (rings-1) * 2 * this.
  gain: 0.16,
  // Smashed lamp cluster (car/damage.js -> carMesh applyDamage `lightsOut`): the beam
  // does not go fully black (one bulb survives) but it stops throwing a shaft.
  dimmed: 0.10,
};

/** Blend contract of the shell material, as THREE constant NAMES so the suite can pin
 *  them without pulling THREE into Node (carMesh.js resolves the names). */
export function beamMaterialSpec() {
  return {
    transparent: true,
    depthWrite: false,     // never occludes the world behind the beam
    depthTest: true,       // a hill between the car and the beam still blocks it
    blending: 'AdditiveBlending',
    side: 'DoubleSide',    // the doubled crossing IS the depth cue
    toneMapped: false,
  };
}

/** Is a stage time-of-day dark enough to run the beams? */
export function isDark(tod) {
  const t = typeof tod === 'number' ? tod : 0.7;
  return t > BEAM.darkAbove || t < BEAM.darkBelow;
}

/**
 * Lamp anchors in the car-group frame (forward is +X): position, unit aim direction,
 * and where the pool's centre lands. Pure math, so the geometry contract - the shaft
 * and its light are the same object, aimed down the road, splayed outward - is
 * checkable without a renderer.
 */
export function beamAnchors(shape) {
  const out = [];
  for (const side of [1, -1]) {
    const z = shape.hz * BEAM.lamp.side * side;
    const px = shape.hx + BEAM.lamp.ahead;
    const py = shape.floor + BEAM.lamp.up;
    const tx = shape.hx + BEAM.aim.ahead;
    const ty = shape.floor - BEAM.aim.drop;
    const tz = z * BEAM.aim.spread;
    const dx = tx - px, dy = ty - py, dz = tz - z;
    const l = Math.hypot(dx, dy, dz) || 1;
    out.push({
      pos: [px, py, z],
      dir: [dx / l, dy / l, dz / l],
      pool: [px + (dx / l) * BEAM.reach, py + (dy / l) * BEAM.reach, z + (dz / l) * BEAM.reach],
    });
  }
  return out;
}

/** Triangle cost of the volumes for one car. */
export function beamTriangleCount() {
  return 2 * (BEAM.rings.length - 1) * BEAM.segments * 2;
}

/**
 * One open cone shell along +X, as typed arrays: `position`, `aFade` (per-vertex alpha
 * ramp) and `index`. No normals: the shell is unlit, its brightness is the ramp times
 * the uniform gain.
 */
export function beamGeometry() {
  const rings = BEAM.rings, seg = BEAM.segments;
  const verts = rings.length * (seg + 1);
  const position = new Float32Array(verts * 3);
  const fade = new Float32Array(verts);
  let k = 0;
  for (const ring of rings) {
    for (let i = 0; i <= seg; i++) {
      const a = (i / seg) * Math.PI * 2;
      position[k * 3] = BEAM.reach * ring.t;
      position[k * 3 + 1] = Math.cos(a) * ring.r;
      position[k * 3 + 2] = Math.sin(a) * ring.r;
      fade[k] = ring.a;
      k++;
    }
  }
  const index = new Uint16Array((rings.length - 1) * seg * 6);
  let n = 0;
  for (let b = 0; b < rings.length - 1; b++) {
    const a0 = b * (seg + 1), b0 = a0 + seg + 1;
    for (let i = 0; i < seg; i++) {
      index[n++] = a0 + i; index[n++] = b0 + i; index[n++] = b0 + i + 1;
      index[n++] = a0 + i; index[n++] = b0 + i + 1; index[n++] = a0 + i + 1;
    }
  }
  return { position, aFade: fade, index, tris: index.length / 3 };
}

export const BEAM_VERT = `
attribute float aFade;
varying float vFade;
void main() {
  vFade = aFade;
  gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
}`;

export const BEAM_FRAG = `
uniform vec3 uColor;
uniform float uGain;
varying float vFade;
void main() {
  float a = uGain * vFade;
  if ( a <= 0.002 ) discard;
  gl_FragColor = vec4( uColor * a, a );
}`;

/**
 * Mute or restore pool and shaft together (smashed lamp cluster). Called on a
 * damage-state change only, never per frame. Duck-typed on the objects carMesh.js
 * builds, which is what lets the suite exercise it headless.
 */
export function setBeamGain(beams, gain) {
  if (!beams) return;
  for (const light of beams.lights) light.intensity = BEAM.spot.intensity * gain;
  if (beams.mat) beams.mat.uniforms.uGain.value = BEAM.gain * gain;
  for (const shell of beams.shells) shell.visible = gain > 0.002;
}
