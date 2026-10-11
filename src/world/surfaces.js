// SURFACE TABLE — the single source of truth (docs/02 §4, docs/06 §4).
// Physics, dirt and rendering all read this. Values from docs/02 §4; the three
// extra entries (stone / peat / dirt) are derived neighbours, flagged as such.
// Units: mu = peak friction coefficient, Crr = rolling resistance coefficient,
// plough = bulldozing coefficient (docs/02 §3.5), sink = tyre sink depth (m).
//
// LOOSE-SURFACE DRAG BAND (2026-10-11). Gravel was re-fitted (see its row) against a
// modern rally car's terminal speed, but nobody followed it through the family, so the
// soft rows kept the pre-retune scale and the taper turned into a cliff: measured on
// the flat straight, mud reached 81 kph, sand 92 and peat 68 against gravel's 186 -
// stage surfaces the car can never build pace on. `crr` and `sink` only were re-fitted
// on the same basis (terminal speed of car 'A' on a flat straight, pinned by T23 in
// src/debug/tests.js); `mu` and `plough` are untouched, so cornering, drift and
// handbrake behaviour are unchanged. The two drag columns now rise monotonically along
// the softness ladder and terminal speed falls monotonically with it:
//   gravel 186 > grass 150 > dirt 141 > snow 132 > sand 122 > mud 103 > peat 90 kph

export const SURF = {
  UNKNOWN: 0,
  ASPHALT: 1,
  GRAVEL: 2,
  MUD: 3,
  SNOW: 4,
  GRASS: 5,
  SAND: 6,
  STONE: 7,
  PEAT: 8,
  ICE: 9,
  DIRT: 10,
};

export const SURFACES = [
  {
    id: SURF.UNKNOWN, key: 'unknown', name: '—',
    mu: 0.70, muWet: 0.55, muIce: 0.28,
    crr: 0.070, plough: 1.5, sink: 0.030,
    curveFactor: 0.90, stiffFactor: 0.82,
    stick: 0.30, dirtColor: 0x6b5a44,
    loose: true, roughness: 0.9, color: 0x7a6a52,
  },
  {
    id: SURF.ASPHALT, key: 'asphalt', name: 'ASFALT',
    mu: 1.18, muWet: 0.86, muIce: 0.30,
    crr: 0.011, plough: 0.0, sink: 0.000,
    curveFactor: 1.00, stiffFactor: 1.12,
    stick: 0.04, dirtColor: 0x3a3a38,
    loose: false, roughness: 0.55, color: 0x3d3d3c,
    kink: true, aquaplane: true,
  },
  {
    id: SURF.GRAVEL, key: 'gravel', name: 'SZUTER',
    mu: 0.80, muWet: 0.62, muIce: 0.28,
    // crr / sink re-fitted against a modern rally car's terminal speed on loose
    // surface (~190 kph); the bulldozing term (plough) and mu are untouched, so
    // cornering, drift and handbrake behaviour are unchanged.
    crr: 0.034, plough: 1.9, sink: 0.008,
    curveFactor: 0.92, stiffFactor: 0.86,
    stick: 0.42, dirtColor: 0x8d7a5f,
    loose: true, roughness: 0.95, color: 0x9c8a6d,
    looseLayer: true, grainHz: 24, grainAmp: 0.06,
  },
  {
    id: SURF.MUD, key: 'mud', name: 'BŁOTO',
    mu: 0.55, muWet: 0.42, muIce: 0.24,
    crr: 0.084, plough: 3.6, sink: 0.042,
    curveFactor: 0.80, stiffFactor: 0.70,
    stick: 0.88, dirtColor: 0x4a3524,
    loose: true, roughness: 1.0, color: 0x4f3a28,
    rut: true,
  },
  {
    id: SURF.SNOW, key: 'snow', name: 'ŚNIEG',
    mu: 0.45, muWet: 0.40, muIce: 0.22,
    crr: 0.050, plough: 2.4, sink: 0.022,
    curveFactor: 0.86, stiffFactor: 0.78,
    stick: 0.14, dirtColor: 0xdfe6ea,
    loose: true, roughness: 0.75, color: 0xe7edf1,
    ridgeBuild: true,
  },
  {
    id: SURF.GRASS, key: 'grass', name: 'TRAWA',
    mu: 0.72, muWet: 0.55, muIce: 0.30,
    crr: 0.045, plough: 1.4, sink: 0.017,
    curveFactor: 0.90, stiffFactor: 0.82,
    stick: 0.30, dirtColor: 0x4f6b34,
    loose: true, roughness: 0.92, color: 0x4f6b34,
  },
  {
    id: SURF.SAND, key: 'sand', name: 'PIASEK',
    mu: 0.62, muWet: 0.50, muIce: 0.26,
    crr: 0.070, plough: 2.9, sink: 0.030,
    curveFactor: 0.84, stiffFactor: 0.74,
    stick: 0.20, dirtColor: 0xc2a878,
    loose: true, roughness: 0.98, color: 0xc9b184,
  },
  // --- derived (not in docs/02 §4; marked so tuning tests own them) ---
  {
    id: SURF.STONE, key: 'stone', name: 'SKAŁA', derived: true,
    mu: 0.92, muWet: 0.70, muIce: 0.26,
    crr: 0.016, plough: 0.2, sink: 0.000,
    curveFactor: 1.02, stiffFactor: 1.10,
    stick: 0.08, dirtColor: 0x5c5c58,
    loose: false, roughness: 0.65, color: 0x6b6b66,
  },
  {
    id: SURF.PEAT, key: 'peat', name: 'TORF', derived: true,
    mu: 0.50, muWet: 0.40, muIce: 0.24,
    crr: 0.086, plough: 3.2, sink: 0.050,
    curveFactor: 0.78, stiffFactor: 0.68,
    stick: 0.80, dirtColor: 0x35281c,
    loose: true, roughness: 1.0, color: 0x3b2f22,
    rut: true,
  },
  {
    id: SURF.ICE, key: 'ice', name: 'LÓD', derived: true,
    mu: 0.22, muWet: 0.20, muIce: 0.18,
    crr: 0.020, plough: 0.1, sink: 0.000,
    curveFactor: 1.05, stiffFactor: 1.15,
    stick: 0.02, dirtColor: 0xbcd2dc,
    loose: false, roughness: 0.35, color: 0xa8c6d4,
  },
  {
    id: SURF.DIRT, key: 'dirt', name: 'ZIEMIA', derived: true,
    mu: 0.66, muWet: 0.50, muIce: 0.26,
    crr: 0.048, plough: 2.2, sink: 0.020,
    curveFactor: 0.85, stiffFactor: 0.78,
    stick: 0.55, dirtColor: 0x6b4f32,
    loose: true, roughness: 0.96, color: 0x6b4f32,
  },
];

export function surface(id) { return SURFACES[id] || SURFACES[0]; }

/**
 * Effective peak mu for a surface given stage conditions.
 * wetness 0..1, frozen 0..1. Asphalt `kink` (docs/02 §4) is applied by the
 * tyre model through tyreTemp, not here.
 */
export function effectiveMu(s, wetness = 0, frozen = 0) {
  const w = Math.max(0, Math.min(1, wetness));
  const f = Math.max(0, Math.min(1, frozen));
  let mu = s.mu + (s.muWet - s.mu) * w;
  mu += (s.muIce - mu) * f;
  return mu;
}

export const SURFACE_KEYS = SURFACES.reduce((m, s) => (m[s.key] = s.id, m), {});
