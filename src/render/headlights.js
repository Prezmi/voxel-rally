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
// At 4 rings / 12 segments that is 144 triangles on a frame budget of ~220k (docs/07
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

  // Spot light: the pool on the road. The cone has to be the *same object* as the
  // shaft drawn under it, so the width and the cut-off are derived from the shaft,
  // not chosen freely: the shaft fans out to `rings[last].r` at `reach`, i.e.
  // atan(2.35/20) = 6.7 deg, so the cone is a little wider than that (10.3 deg) and
  // cut off a little past it (26 m against a 20 m shaft).
  //
  // The numbers the car shipped with (angle 0.55 rad = 31.5 deg, distance 34) threw
  // a 550 m2 wedge: one lamp alone lit a 12.5 m-wide strip at 10 m and 28 m wide at
  // 25 m, i.e. the whole 10.5 m corridor (road-carve.js: 7.5 m carriageway + 1.5 m
  // shoulder) plus both banks and the treeline, at 1.2x the night ambient out to
  // 18 m. The frame never went dark and the 4.7 m-wide shaft was drawing inside a
  // 25 m-wide glow that had nothing to do with it (queue P8). These numbers put the
  // pool back inside the corridor (3 m across at 6 m, 7.5 m at 20 m) over 119 m2,
  // and let the world past the shaft fall back to ambient. T30 pins the agreement.
  spot: { intensity: 50, distance: 26, angle: 0.18, penumbra: 0.62, decay: 1.3 },
  color: 0xffeecd,

  // Where the lamps sit on the car body and where they aim: ahead of the nose, down
  // onto the road, and splayed outward so the two pools merge past ~20 m.
  lamp: { ahead: 0.25, up: 0.34, side: 0.6 },
  aim: { ahead: 17, drop: 2.0, spread: 1.7 },

  // The visible volume: rings run from the lens to `reach` (must stay inside the spot
  // cut-off, or the shaft would reach past the light that is supposed to be causing
  // it). The ramp is the whole look, and the first night frame (seed 95, DUSK,
  // bumper cam, queue P8) showed what the old one did wrong: it opened at a=0.34 *at
  // the lens*, and every driver camera sits at lamp height *inside* the cone, so the
  // near wall of both shells filled the lower half of the frame as two solid pale
  // cards welded to the nose - geometry, not light - while the far half, where the
  // pool actually is, was the dim part of the ramp.
  //
  // So the ramp now starts at nothing at the lens, peaks at 55 % of the reach (over
  // the middle of the light pool, 11 m out) and dies to nothing at the far end. One
  // more band costs 48 triangles and buys both ends of the curve.
  reach: 20,
  rings: [{ t: 0, r: 0.10, a: 0 }, { t: 0.20, r: 0.70, a: 0.40 },
          { t: 0.55, r: 1.55, a: 0.85 }, { t: 1, r: 2.35, a: 0 }],
  segments: 12,
  // Peak additive alpha per shell wall. A ray down the axis crosses every band twice,
  // so the core lands near 2 * peak ring alpha * this = 0.22 (was 0.32: brighter than
  // the road it was drawing over). T41 pins the core band, not this number alone.
  gain: 0.13,
  // Smashed lamp cluster (car/damage.js -> carMesh applyDamage `lightsOut`): the beam
  // does not go fully black (one bulb survives) but it stops throwing a shaft.
  dimmed: 0.10,
};

/** car-body.js carShape(): `floor = ground + 0.15`, so the road plane in the car
 *  frame sits this far under the floor band the lamps are welded to. */
export const GROUND_UNDER_FLOOR = 0.15;

/** Irradiance one lamp throws on the road plane at (x, z) in the car frame, using
 *  the same falloff three compiles for a SpotLight (1/d^decay windowed by the
 *  cut-off). Ignores the penumbra ramp: it is what bounds the pool, not its edge. */
export function poolIlluminance(shape, x, z) {
  const gy = shape.floor - GROUND_UNDER_FLOOR;
  const cosA = Math.cos(BEAM.spot.angle);
  let best = 0;
  for (const a of beamAnchors(shape)) {
    const dx = x - a.pos[0], dy = gy - a.pos[1], dz = z - a.pos[2];
    const d = Math.hypot(dx, dy, dz);
    if (!(d > 1e-6) || d > BEAM.spot.distance) continue;
    const c = (dx * a.dir[0] + dy * a.dir[1] + dz * a.dir[2]) / d;
    if (c < cosA) continue;
    let f = 1 / Math.max(Math.pow(d, BEAM.spot.decay), 1e-4);
    const w = Math.max(0, 1 - Math.pow(d / BEAM.spot.distance, 4));
    f *= w * w * BEAM.spot.intensity;
    if (f > best) best = f;
  }
  return best;
}

/**
 * The ground footprint of both lamps together: how far the light actually reaches
 * down the road, and how wide it lies across it. Marched on a step-m grid in the
 * car frame, so the pool the SpotLight throws can be pinned against the shaft the
 * beam geometry draws (T30) instead of being judged from a screenshot alone.
 * `spanAt(X)` is the full across-road width of the lit band centred on X metres
 * ahead of the car.
 */
export function beamFootprint(shape, step = 0.25) {
  const x0 = shape.hx - 1;
  const x1 = shape.hx + BEAM.spot.distance + 1;
  const zLim = BEAM.spot.distance;
  let area = 0, near = Infinity, far = -Infinity, peak = 0;
  const bands = new Map();
  for (let x = x0; x <= x1; x += step) {
    for (let z = -zLim; z <= zLim; z += step) {
      const e = poolIlluminance(shape, x, z);
      if (e <= 0) continue;
      area += step * step;
      if (x < near) near = x;
      if (x > far) far = x;
      if (e > peak) peak = e;
      const b = Math.round(x);
      const r = bands.get(b) || [z, z];
      if (z < r[0]) r[0] = z;
      if (z > r[1]) r[1] = z;
      bands.set(b, r);
    }
  }
  const spanAt = (X) => {
    let lo = Infinity, hi = -Infinity, hit = 0;
    for (const b of bands.keys()) {
      if (Math.abs(b - X) > 1) continue;
      const r = bands.get(b);
      if (r[0] < lo) lo = r[0];
      if (r[1] > hi) hi = r[1];
      hit++;
    }
    return hit ? hi - lo : 0;
  };
  return { area, near, far, peak, spanAt };
}

/** Ring-space alpha one shell wall carries at `t` (0..1 along `reach`), the rings
 *  interpolated - the shader multiplies this by `uGain` per fragment. A view down the
 *  beam crosses the shell twice, so double it (times gain) for the core brightness. */
export function shaftWallAlpha(t) {
  const rings = BEAM.rings;
  if (!(t > 0)) return rings[0].a;
  if (t >= 1) return rings[rings.length - 1].a;
  for (let i = 1; i < rings.length; i++) {
    if (t <= rings[i].t) {
      const a = rings[i - 1], b = rings[i];
      const k = (t - a.t) / Math.max(1e-6, b.t - a.t);
      return a.a + (b.a - a.a) * k;
    }
  }
  return rings[rings.length - 1].a;
}

/** Where the shaft is brightest, and how bright: `{ t, wall, core }` with `core` the
 *  alpha down the axis (two shell walls, both gain-scaled). The night frame is judged
 *  on these two numbers: `t` says whether the bright part of the shaft sits over the
 *  light pool or on the dashboard, `core` says whether the shaft outranks the road. */
export function shaftPeak() {
  let best = { t: 0, wall: -1 };
  for (let i = 0; i <= 200; i++) {
    const t = i / 200, wall = shaftWallAlpha(t);
    if (wall > best.wall) best = { t, wall };
  }
  return { t: best.t, wall: best.wall * BEAM.gain, core: 2 * best.wall * BEAM.gain };
}

/** Half-angle the drawn shaft fans out to at its far ring, in radians: the cone of
 *  light is supposed to be the thing causing that shaft, so it can never be narrower. */
export function shaftHalfAngle() {
  const last = BEAM.rings[BEAM.rings.length - 1];
  return Math.atan2(last.r, BEAM.reach * last.t);
}

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
