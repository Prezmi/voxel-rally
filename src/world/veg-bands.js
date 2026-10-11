// Vegetation LOD bands + instance budgets, as DATA (no THREE, no renderer).
//
// This table used to live inline inside `Streaming._rebuildProps`, where the only way to
// ask "which preset pays more, LOW or MEDIUM?" was to run the game and read the perf
// harness. The far vegetation band is the axis quality presets move (near/mid radii are
// pinned by the drive: trees have to be readable next to the car), so it is the axis that
// can silently invert the ladder - raise LOW's `vegFarDistance` or its cap multipliers and
// the cheap preset ends up drawing a heavier treeline than the expensive one.
//
// Two things live here:
//   1. `vegBandPlan(quality, settings)` - the radii and per-species instance caps the
//      renderer uses, with a hard clamp that keeps a cheaper preset never heavier than
//      the preset above it;
//   2. `vegCostFromDensity(...)` - the same bands integrated analytically over a measured
//      prop density, so node can state the triangle cost of each preset's treeline
//      without a GPU. Frustum culling is deliberately NOT modelled: it cuts every preset
//      by the same factor, so the ladder comparison is unaffected.
//
// Band radii (props.js owns the per-instance geometry, this file owns how far each band
// reaches and how many instances of it survive):
//   near - the baked voxel/glb build, the only band where a trunk reads. The expensive
//          one: 110-450 tris per instance (NEAR_LOD_TRIS).
//   mid  - the crossed alpha-quad sprite, planes x 2 tris.
//   far  - ONE camera-facing billboard quad, 2 tris. Because it is 2 tris, the RADIUS is
//          the cheap axis and the instance CAP is what bounds the cost.

import { PROP, SPRITE_PROPS, SPRITE_SPEC, NEAR_LOD_TRIS } from './props.js';
import { QUALITY, settings } from '../core/settings.js';

/**
 * Per-species instance capacity: one InstancedMesh (per species, per band) allocated
 * once at boot, so this number is VRAM, not a per-frame cost.
 */
export const PROP_CAPACITY = {
  [PROP.OAK]: 1400, [PROP.PINE]: 1400, [PROP.DEAD]: 700,
  [PROP.SPECTATOR]: 1000, [PROP.POST]: 900, [PROP.MARSHAL]: 40, [PROP.GATE]: 24,
  [PROP.BIRCH]: 900, [PROP.BUSH]: 1400, [PROP.FERN]: 1600,
};

/**
 * The band table, per quality preset. `farMul`/`farAdd` are how the far radius is built
 * off `settings.vegFarDistance` (the player-facing knob); `farDetailOffMul` replaces both
 * when FAR DETAIL is off. Non-sprite species (posts, spectators, marshals) have no sprite
 * or billboard variant, so they ride one band out to `nearRHard` and are dropped beyond.
 */
export const VEG_BANDS = {
  [QUALITY.LOW]: {
    nearR: 18, midR: 62, farMul: 1.0, farDetailOffMul: 0.55, nearRHard: 70,
    nearCapMul: 0.22, midCapMul: 0.45, farCapMul: 0.5, farCapMulNoDetail: 0.45,
  },
  [QUALITY.MED]: {
    nearR: 24, midR: 96, farMul: 1.0, farAdd: 80, farDetailOffMul: 0.55, nearRHard: 90,
    nearCapMul: 0.30, midCapMul: 0.70, farCapMul: 0.8, farCapMulNoDetail: 0.45,
  },
  [QUALITY.HIGH]: {
    nearR: 34, midR: 140, farMul: 1.0, farAdd: 200, farDetailOffMul: 0.55, nearRHard: 110,
    nearCapMul: 0.45, midCapMul: 0.90, farCapMul: 0.95, farCapMulNoDetail: 0.45,
  },
};

/** The band knobs the renderer asks for, resolved against the live settings. */
function rawPlan(q, s) {
  const b = VEG_BANDS[q] || VEG_BANDS[QUALITY.MED];
  // `settings.vegFarDistance` is the knob; drawDistance clamps it, because a prop only
  // exists in a chunk that was actually streamed in, and FAR DETAIL off pulls the band
  // back hard - that is the frame-rate half of the row.
  const vegFar = Math.max(240, Math.min(1200, s.vegFarDistance || 620));
  const farR = Math.round(Math.min(s.farDetail
    ? vegFar * b.farMul + (b.farAdd || 0)
    : vegFar * b.farDetailOffMul, s.drawDistance));
  return {
    quality: q,
    nearR: b.nearR,
    midR: b.midR,
    nearRHard: b.nearRHard,
    farR,
    vegFar,
    nearCapMul: b.nearCapMul,
    midCapMul: b.midCapMul,
    farCapMul: s.farDetail ? b.farCapMul : b.farCapMulNoDetail,
    farDetail: !!s.farDetail,
  };
}

const KEYS = ['nearR', 'midR', 'nearRHard', 'farR', 'nearCapMul', 'midCapMul', 'farCapMul'];

/** Cheaper preset may never reach further or instance more than the one above it. */
function clampUnder(plan, ceiling) {
  for (const k of KEYS) if (plan[k] > ceiling[k]) plan[k] = ceiling[k];
  return plan;
}

/**
 * The plan the renderer and the suite both read. The clamp is the point: the LOW row can
 * never buy a heavier treeline than MED, and MED never more than HIGH, whatever a saved
 * `vegFarDistance` / `drawDistance` / `farDetail` says.
 */
export function vegBandPlan(q = settings.quality, s = settings) {
  const plan = rawPlan(q, s);
  if (q === QUALITY.LOW) return clampUnder(plan, rawPlan(QUALITY.MED, s));
  if (q === QUALITY.MED) return clampUnder(plan, rawPlan(QUALITY.HIGH, s));
  return plan;
}

/** Tris per instance of one species in one band, from the geometry props.js builds. */
export function vegTrisPerInstance(type, band) {
  if (band === 'far') return 2;                                  // one camera-facing quad
  if (band === 'mid') return (SPRITE_SPEC[type] && SPRITE_SPEC[type].planes * 2) || 0;
  // Near: the baked build, capped by NEAR_LOD_TRIS (streaming swaps a glb node that
  // busts the budget for the near-LOD build). A species with no near LOD entry - fern -
  // keeps its sprite quad in the near batch, which is what it costs there.
  const lod = NEAR_LOD_TRIS[type];
  if (lod) return lod;
  return (SPRITE_SPEC[type] && SPRITE_SPEC[type].planes * 2) || 0;
}

/** True when that species has a mesh in that band (posts/spectators have no sprite band). */
export function vegBandHas(type, band) {
  if (band === 'near') return true;
  return SPRITE_PROPS.includes(type);
}

/**
 * Measure a real placement: props per square metre, per species, from generated chunks.
 * `countsBySpecies[type] = props in the sampled chunks`, `chunks` = chunks sampled.
 */
export function vegDensity(countsBySpecies, chunks, chunkArea) {
  const d = {};
  const area = Math.max(1, chunks * chunkArea);
  for (const [type, n] of Object.entries(countsBySpecies)) d[Number(type)] = n / area;
  return d;
}

const annulus = (r0, r1) => Math.max(0, Math.PI * (r1 * r1 - r0 * r0));

/**
 * Integrate the bands of one plan over a measured density: how many instances survive
 * the caps, and what they cost in triangles. Whole-disc (no frustum cull), which is the
 * upper bound and the same treatment for every preset.
 */
export function vegCostFromDensity(plan, density, capacity = PROP_CAPACITY) {
  let near = 0, mid = 0, far = 0, instances = 0;
  for (const key of Object.keys(density)) {
    const type = Number(key);
    const d = density[type];
    // Furniture (posts, spectators, marshals) has no sprite/billboard build and no near
    // LOD budget entry, so its per-instance cost is not carried by this knob at all -
    // counting it as 0 tris would make a preset look cheaper than it is.
    if (!d || (!SPRITE_PROPS.includes(type) && !NEAR_LOD_TRIS[type])) continue;
    const nearR = SPRITE_PROPS.includes(type) ? plan.nearR : plan.nearRHard;
    const bands = [
      ['near', annulus(0, Math.min(nearR, plan.farR)), plan.nearCapMul],
      ['mid', annulus(nearR, Math.max(nearR, Math.min(plan.midR, plan.farR))), plan.midCapMul],
      ['far', annulus(Math.max(nearR, plan.midR), plan.farR), plan.farCapMul],
    ];
    for (const [band, area, mul] of bands) {
      if (!area || !vegBandHas(type, band)) continue;
      const cap = Math.floor((capacity[type] || 0) * mul);
      const n = Math.min(d * area, cap);
      if (band === 'near') near += n * vegTrisPerInstance(type, band);
      else if (band === 'mid') mid += n * vegTrisPerInstance(type, band);
      else far += n * vegTrisPerInstance(type, band);
      instances += n;
    }
  }
  return { near, mid, far, total: near + mid + far, instances };
}
