// The road skin's value + roughness tuning. src/render/renderer.js interpolates these
// numbers straight into the terrain material's fragment shader, and src/debug/tests.js
// (T28) pins them - which is why this module is deliberately free of any THREE import,
// the same reason render/car-asset.js stays THREE-free: the shipped numbers have to be
// assertable headless, and a constant that lives only inside a GLSL string is not.
//
// PLAN §10 criterion 2: "różnica tonażu między panelami tej samej nawierzchni >= 12%"
// (nothing may read as a flat, uniform slab). The ceiling is the near-field one: a tile
// swing whose midpoint sits above 1.0 lifts whole panels of the carriageway into blown
// pale patches, which is what queue P7 is about.

export const ROAD_TONE = {
  base: 0.94,                        // tile = 0  -> darkest panel
  swing: 0.12,                       // tile = 1  -> 1.06, so the band is 0.94..1.06
};

// Wheel-line rut. The mesher packs edge/corridor wear into the surface attribute
// (LOW = compacted wheel line, HIGH = pale shoulder), and a rut is compacted ground:
// it sits darker AND slightly glossier than the panel around it. `road` is the
// roughness multiplier at the bottom of that band for the loose-surfaced road family
// (gravel / mud / peat / dirt); asphalt keeps its own, much stronger compaction term
// in the shader because a worn asphalt wheel line is genuinely polished.
export const RUT_GLOSS = {
  from: 0.10,                        // wear at or below this is fully in the rut
  to: 0.45,                          // wear at or above this is back to panel roughness
  road: 0.80,                        // 20% glossier inside the rut: sheen, not a mirror
};

/** The tone band the shader multiplies a panel by, as measured numbers. */
export function roadToneRange() {
  const min = ROAD_TONE.base;
  const max = ROAD_TONE.base + ROAD_TONE.swing;
  return {
    min,
    max,
    mid: (min + max) / 2,
    spreadPct: (max / min - 1) * 100,   // the "tonal difference between panels" metric
  };
}

export function smoothstep01(a, b, x) {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

/** Roughness multiplier the road family gets across the wear band (1 = untouched). */
export function roadRutRoughness(wear) {
  return 1 - (1 - RUT_GLOSS.road) * (1 - smoothstep01(RUT_GLOSS.from, RUT_GLOSS.to, wear));
}
