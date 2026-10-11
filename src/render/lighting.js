// Lighting rig: one warm directional key + a cool sky fill + hemisphere ambient,
// dialled per biome and per time of day (docs/04 §1 "światło", PLAN §10
// "Oświetlenie i cień": ciepła key + chłodny fill, hemisphere ambient zależny od
// biomy i pory dnia).
//
// Everything here is a *parameter set*: night and rain (F6) are supposed to be the
// same material graph with different numbers (PLAN §10), so the rig is data, not
// code paths. No textures, no fetch.
import * as THREE from 'three';

/**
 * Time-of-day key stops. `t` is 0..1 across a stage day: 0.25 sunrise, 0.5 noon,
 * 0.72 golden hour (the reference look), 0.85 dusk, 1 night.
 * elevation in degrees, `key` = sun intensity, `ambient` = hemisphere intensity.
 */
const STOPS = [
  { t: 0.00, elev: -6, key: 0.14, keyCol: 0x2b3d5c, amb: 0.60, ambSky: 0x1d2839, ambGround: 0x14171c, fog: 0.55, exposure: 1.55, warm: 0.05 },
  { t: 0.22, elev: 4, key: 2.55, keyCol: 0xffa866, amb: 1.30, ambSky: 0x86a6c8, ambGround: 0x3f3527, fog: 0.72, exposure: 1.34, warm: 0.95 },
  { t: 0.38, elev: 22, key: 3.72, keyCol: 0xffe0ae, amb: 1.74, ambSky: 0xb4d1ea, ambGround: 0x464836, fog: 0.44, exposure: 1.31, warm: 0.62 },
  { t: 0.50, elev: 52, key: 3.88, keyCol: 0xfff7ea, amb: 1.84, ambSky: 0xd2e6f4, ambGround: 0x454d3c, fog: 0.32, exposure: 1.22, warm: 0.28 },
  // Golden hour (t 0.68-0.80) is the reference look: the key is *low* so shadows
  // stretch across the carriageway (PLAN §10 criterion 1/4) rather than falling
  // straight down under the car the way noon does. Bright, high-key (PLAN §10.2:
  // CMR 2.0 was praised for a brighter palette) - the old values washed the frame
  // to flat grey once the fog was added on top.
  { t: 0.68, elev: 18, key: 4.20, keyCol: 0xffca92, amb: 1.86, ambSky: 0xbdd4ec, ambGround: 0x4c452f, fog: 0.40, exposure: 1.44, warm: 0.86 },
  { t: 0.80, elev: 7, key: 3.10, keyCol: 0xff9048, amb: 1.52, ambSky: 0x93a6cc, ambGround: 0x3d3424, fog: 0.72, exposure: 1.40, warm: 1.00 },
  { t: 0.92, elev: -4, key: 0.30, keyCol: 0x38506f, amb: 0.72, ambSky: 0x27324a, ambGround: 0x181b21, fog: 0.80, exposure: 1.48, warm: 0.30 },
  { t: 1.00, elev: -6, key: 0.14, keyCol: 0x2b3d5c, amb: 0.60, ambSky: 0x1d2839, ambGround: 0x14171c, fog: 0.55, exposure: 1.55, warm: 0.05 },
];

/**
 * Per-b biome offsets (PLAN §10 "biome-matched haze"): the sky/fog colour the biome
 * generator already owns is kept, only multiplied by the time-of-day wash, plus a
 * saturation bias so the CANYON reads warm and the MOUNTAIN cold.
 */
const BIOME_BIAS = {
  FOREST: { sat: 1.06, haze: 1.00, ground: 0x3c4136, shaft: 1.00 },
  MOUNTAIN: { sat: 0.94, haze: 0.78, ground: 0x42443f, shaft: 0.85 },
  SWAMP: { sat: 0.90, haze: 1.35, ground: 0x2f382e, shaft: 1.15 },
  PLATEAU: { sat: 1.10, haze: 0.85, ground: 0x5a5140, shaft: 0.90 },
  CANYON: { sat: 1.14, haze: 0.95, ground: 0x57483a, shaft: 1.05 },
};

const _a = new THREE.Color();
const _b = new THREE.Color();
const _w = new THREE.Color();

function lerp(a, b, k) { return a + (b - a) * k; }

/**
 * Fill `out` (a preallocated rig object) for biome + time of day. Called on biome
 * or time change only, never per frame — the object it writes into is reused so a
 * live time-of-day drive allocates nothing (docs/06 "no allocation in the loop").
 */
export function lightingFor(biome, tod, out) {
  const t = Math.max(0, Math.min(1, tod));
  let i = 0;
  while (i < STOPS.length - 2 && STOPS[i + 1].t < t) i++;
  const s0 = STOPS[i], s1 = STOPS[i + 1];
  const k = (t - s0.t) / Math.max(1e-4, s1.t - s0.t);

  out.elevationDeg = lerp(s0.elev, s1.elev, k);
  out.keyIntensity = lerp(s0.key, s1.key, k);
  // The atmosphere layer reads the sun as a 0..1 amount (post/composer.js shaftAlpha
  // clamps its `sun` term to that range), so the rig has to emit it: keyIntensity is a
  // physical-ish 0..4.2 dial, sunAmount is the same number normalised into 0..1.
  // Without these two the shafts fall back to 1 and time of day never moves them.
  out.sunIntensity = out.keyIntensity;
  out.sunAmount = Math.max(0, Math.min(1, out.keyIntensity / 4.2));
  out.ambIntensity = lerp(s0.amb, s1.amb, k);
  out.exposure = lerp(s0.exposure, s1.exposure, k);
  out.warmth = lerp(s0.warm, s1.warm, k);
  out.hazeMul = lerp(s0.fog, s1.fog, k);

  _a.setHex(s0.keyCol); _b.setHex(s1.keyCol);
  out.sunColor.copy(_a).lerp(_b, k);
  _a.setHex(s0.ambSky); _b.setHex(s1.ambSky);
  out.hemiSky.copy(_a).lerp(_b, k);
  _a.setHex(s0.ambGround); _b.setHex(s1.ambGround);
  out.hemiGround.copy(_a).lerp(_b, k);

  // Sun direction: the arc runs across the sky so the key light swings with the
  // day (long shadows at low elevation = the Colin McRae frame, PLAN §10).
  const az = -2.35 + t * 3.4;
  const e = out.elevationDeg * Math.PI / 180;
  const ce = Math.cos(e), se = Math.sin(e);
  out.sunDir.set(ce * Math.sin(az), se, ce * Math.cos(az)).normalize();

  const bias = BIOME_BIAS[biome] || BIOME_BIAS.FOREST;
  out.groundTint.setHex(bias.ground);
  out.hemiGround.lerp(out.groundTint, 0.55);
  out.saturation = bias.sat;
  out.hazeMul *= bias.haze;
  out.shaftGain = bias.shaft;

  // Cool sky fill (PLAN §10: "chłodny fill", shadow sides must not go black): a
  // second directional light pointing back from the sun's opposite side.
  _w.copy(out.hemiSky).multiplyScalar(1.25);
  _w.r = Math.min(1, _w.r * 0.72); _w.g = Math.min(1, _w.g * 0.82); _w.b = Math.min(1, _w.b * 1.12);
  out.fillColor.copy(_w);
  // Higher base than before: with a low key most of the frame is in shadow, and the
  // fill is what keeps those faces cool instead of black (PLAN §10 "cien nie jest czarny").
  out.fillIntensity = 1.08 + 1.05 * Math.max(0, Math.min(1, se));
  return out;
}

/** Fresh rig object (boot time only). */
export function createLightRig() {
  return {
    elevationDeg: 30, keyIntensity: 2, sunIntensity: 2, sunAmount: 0.48, ambIntensity: 1, exposure: 1.05, warmth: 0.5,
    hazeMul: 0.7, saturation: 1, shaftGain: 1,
    sunColor: new THREE.Color(), hemiSky: new THREE.Color(), hemiGround: new THREE.Color(),
    fillColor: new THREE.Color(), groundTint: new THREE.Color(),
    sunDir: new THREE.Vector3(0.5, 0.7, 0.4), fillIntensity: 0.5,
  };
}
