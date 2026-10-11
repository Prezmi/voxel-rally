// FX (docs/06 §2): exhaust backfire flames + ambient particles. Deliberately free
// of any THREE import, exactly like dirt/dirt-map.js: the pools are plain typed
// arrays, so src/debug/tests.js can assert capacity and allocation behaviour
// headless, and render/fx-view.js stays the only place that owns a draw call.
//
// One interleaved Float32Array per system, FIXED capacity, compacted in place:
//   0..2 position, 3..5 velocity, 6 life left (s), 7 ttl (s), 8 size, 9 heat
// `spawn()` returns -1 once the pool is full, so capacity is a hard cap and the
// frame cost never grows with the scene. One draw call per system (fx-view.js
// hands the GPU a view onto the very same buffer, so there is no per-frame copy
// and nothing allocated after construction).
import { bus as defaultBus } from '../core/events.js';
import { clamp, quatToMat3, mul3v } from '../core/math3.js';
import { surface } from '../world/surfaces.js';

export const STRIDE = 10;

/** A downshift only pops below this throttle: an open throttle swallows the
 *  afterburn (this is the number `ExhaustFx.onShift` used to carry inline). */
export const LIFT_THROTTLE = 0.25;
/** The quietest pop the layers voice: a lifted clutch at idle still cracks, just
 *  barely, so a gate that passed never becomes a 0-gain envelope. */
export const POP_FLOOR = 0.08;
/** Fallback engine row for callers that only hold the event, never the car. */
const SHIFT_ENGINE = { idle: 900, redline: 7000 };

/** idle..redline -> 0..1, the same normalization the plume and the pop both use. */
export function rpmNorm(rpm, engine) {
  const e = engine || SHIFT_ENGINE;
  return clamp((rpm || 0) - e.idle, 0, Math.max(1, e.redline - e.idle))
    / Math.max(1, e.redline - e.idle);
}

/**
 * THE gate a gear change has to pass to make a backfire at all. The flame plume
 * here and the crack in src/audio/backfire.js both ask this one function, so the
 * two can never disagree about whether a shift pops. An upshift always pops; a
 * downshift only on throttle lift. The answer is the burst load (0..1, floored at
 * POP_FLOOR) — the same 0.55 x rpm + 0.45 x demand blend the plume prices with —
 * or 0 for "no pop".
 */
export function shiftPop(e, engine) {
  if (!e) return 0;
  if (!(e.up || (e.throttle || 0) < LIFT_THROTTLE)) return 0;   // downshift needs a lift
  const load = 0.55 * rpmNorm(e.rpm, engine) + 0.45 * clamp(e.demand || 0, 0, 1);
  return clamp(Math.max(POP_FLOOR, load), 0, 1);
}
export const F = { X: 0, Y: 1, Z: 2, VX: 3, VY: 4, VZ: 5, LIFE: 6, TTL: 7, SIZE: 8, HEAT: 9 };

/** Default exhaust tip offsets (car-group local: x fwd, y up, z lateral, ground
 *  at y = -comY) used when the glb carries no car_exhaust_* nodes. */
export const EXHAUST_NODES = ['car_exhaust_l', 'car_exhaust_r'];

/** Wheel-dust dial (docs/04 §6 "kurz zza kol"). Capacities are NOT touched — the
 *  plume gets longer, wind-driven and surface-keyed inside the existing pool, and
 *  spawn() still returns -1 at capacity, so the frame cost never grows. */
export const DUST_TUNE = {
  looseMul: 1.00,          // rate gain on a `loose` surface row (gravel, mud, sand..)
  hardMul: 0.10,           // asphalt / stone: almost none, the rally read is loose only
  ttlMin: 0.90,            // s, plume lifetime floor (was 0.50)
  ttlSpan: 1.50,           // s of jitter on top of ttlMin (was 0.90)
  windMul: 0.52,           // fraction of the wind field carried into the plume (was 0.32)
  drag: 0.55,              // age() drag: lower = the plume travels and hangs (was 0.90)
  sizeLoose: 1.55,         // size gain on loose ground (0.20..0.56 -> 0.31..0.87)
  sizeJit: 0.62,           // spread of the size jitter: no two puffs the same (was 0.36)
  outward: 1.15,           // m/s thrown sideways out of the contact patch (was 0)
  gravelDark: 0.78,        // HEAT gain on loose ground: gravel dust is darker dust
};

/** Shift soot (docs/06 §2): a short dark puff off the tips on EVERY gear change,
 *  independent of whether the gate voices a crack. Its capacity is carved out of
 *  the old flame pool, so the FX stack never holds more particles than before. */
export const SOOT_TUNE = {
  rate: 130,             // particles/s while the puff is being laid down
  burst: 0.16,           // s of emission window
  ttlMin: 0.40,          // s, soot lifetime floor
  ttlSpan: 0.30,         // s of jitter -> 0.40..0.70 s, fading not popping
  sizeLo: 0.05,          // m, seed radius (grows with age in fx-view mode 4)
  sizeSpan: 0.11,        // m of size variety
  push: 1.5,             // m/s out of the tip, rearwards
  carry: 0.45,           // fraction of car speed the puff keeps (drifts with the car)
  rise: 0.55,            // m/s of buoyancy
  glowHeat: 0.55,        // HEAT of the warm inner core on a rev-matched downshift
};


/** The exhaust gesture (docs/06 §2): one gear change reads as ONE continuous
 *  plume — a hot near-white core at the tip, a ring of flame that expands outward
 *  from the tip and thins out, then a puff of dark soot that billows and drifts
 *  with the car. The emission window is short (0.26..0.36 s); the gesture outlives
 *  it through the layer lifetimes, so the whole event reads over 0.5..0.8 s.
 *  A rev-matched downshift (a lifted shift taken high in the revs) adds a second
 *  visible pulse. Sizes are world radii in metres, grown in age() so the plume is
 *  about half the car width at its peak and keeps growing as it ages. */
export const BURST_TUNE = {
  winMin: 0.26, winSpan: 0.10,   // s of emission: 0.26..0.36 (was 0.15..0.35)
  coreWin: 0.055, coreMax: 26,   // the hot core only lives in the first 55 ms of it
  coreTtlLo: 0.045, coreTtlSpan: 0.040,   // 0.045..0.085 s, strictly < the soot
  coreSizeLo: 0.045, coreSizeSpan: 0.030, // m, near-white jet at the tip
  coreJet: 5.6, coreJetSpan: 4.6,         // m/s straight out of the tip
  coreHeat: 1.25, coreHeatSpan: 0.35,
  ringTtlLo: 0.16, ringTtlSpan: 0.14,     // 0.16..0.30 s flame ring, < the soot
  ringSizeLo: 0.070, ringSizeSpan: 0.070, // m seed radius, ~0.9 m plume at its peak
  ringPush: 1.7, ringPushSpan: 2.3,       // m/s rearwards out of the tip
  ringOut: 2.2, ringOutSpan: 2.6,         // m/s outward, the ring opening up
  ringHeat: 0.70, ringHeatSpan: 0.55,
  rateLo: 360, rateSpan: 520,             // particles/s at the peak of each pulse
  tail: 0.20,                            // sputter floor between the pulses
  pulse1W: 0.075,                        // 1/s width of the first pulse
  pulse2At: 0.17, pulse2W: 0.060, pulse2Gain: 0.75,  // rev-matched downshift pop
  grow: 2.6,                             // 1/s of size growth (the puff billows)
  curl: 0.9,                             // m/s^2 of upward curl on the flame
  sootCurl: 0.35,                        // m/s^2 on the soot: it rises as it cools
};


export class ParticlePool {
  constructor(capacity) {
    this.capacity = Math.max(1, capacity | 0);
    this.data = new Float32Array(this.capacity * STRIDE);
    this.keep = new Uint8Array(this.capacity);
    this.count = 0;
    this.allocations = 0;      // asserted 0 by the tests: nothing grows after ctor
  }

  /** Next free slot, or -1 at capacity (never grows, never overwrites). */
  spawn() {
    if (this.count >= this.capacity) { this.overflow = (this.overflow || 0) + 1; return -1; }
    return this.count++ * STRIDE;
  }

  /** Drop the dead: in-place compaction, zero allocation, order preserved. */
  compact() {
    const d = this.data, keep = this.keep;
    let w = 0;
    for (let r = 0; r < this.count; r++) {
      if (!keep[r]) continue;
      if (w !== r) {
        const a = w * STRIDE, b = r * STRIDE;
        for (let k = 0; k < STRIDE; k++) d[a + k] = d[b + k];
      }
      w++;
    }
    this.count = w;
  }
}

// ---------------------------------------------------------------- exhaust
// The gearbox (car/powertrain.js) emits 'shift' on the shared bus; this is the
// only consumer that cares about flames. An upshift always pops; a downshift only
// pops on throttle lift (the open throttle swallows the afterburn).
export class ExhaustFx {
  constructor(pool, emitter = defaultBus, sootPool = null) {
    this.pool = pool;
    this.soot = sootPool;
    this.bus = emitter;
    this.burst = 0;            // s of plume left (150..350 ms window)
    this.rate = 0;             // particles/s while bursting
    this.strength = 0;         // 0..1 burst intensity (length + brightness)
    this.glow = 0;             // 0..1 continuous high-load glow
    this.acc = 0;
    this.burstT = 0;           // s since the burst started (drives the pulses)
    this.pulse2 = 0;           // 1 while a rev-matched downshift voices a 2nd pop
    this.coreN = 0; this.ringN = 0;   // particles laid by the last burst
    this.sootBurst = 0;        // s of soot puff left
    this.sootAcc = 0;
    this.sootRev = 0;          // 1 while a rev-matched downshift lights the core
    this.pending = 0;          // shifts seen since the last step
    this.pUp = 0;
    this.pRev = 0;             // a lifted downshift taken high in the revs
    this.pRpm = 0;
    this.pDemand = 0;
    this._m = new Float32Array(9);
    this._v = { x: 0, y: 0, z: 0 };
    this._off = emitter.on('shift', (e) => this.onShift(e));
  }

  onShift(e) {
    if (!e) return;
    // Soot is not gated by the crack: every gear change pushes a dark puff, and a
    // downshift that was rev-matched (throttle still open) lights a warm core in it.
    this.sootBurst = Math.max(this.sootBurst, SOOT_TUNE.burst);
    this.sootRev = (!e.up && (e.throttle || 0) >= LIFT_THROTTLE) ? 1 : this.sootRev;
    // One gate for both media: src/audio/backfire.js asks shiftPop() the same
    // question, so a plume without a crack (or a crack without a plume) is
    // structurally impossible.
    if (!shiftPop(e, this._engine)) return;
    this.pending++;
    if (e.up) this.pUp++;
    // Rev-matched downshift: let on high in the revs, so the afterburn lights twice.
    const redline = (this._engine || SHIFT_ENGINE).redline;
    if (!e.up && (e.rpm || 0) >= 0.55 * redline) this.pRev = 1;
    this.pRpm = e.rpm || 0;
    this.pDemand = e.demand || 0;
  }

  /** `tips` is 6 world coords: [lx,ly,lz, rx,ry,rz] of the two exhaust nodes. */
  step(dt, car, tips) {
    const P = this.pool, d = P.data, e = car.params.engine;
    this._engine = e;
    const rpm = clamp(car.rpm || this.pRpm || e.idle, 0, e.redline);
    const rpmN = rpmNorm(rpm, e);
    const thr = this.throttle || 0;

    // High load keeps a faint glow alive at the tips even between shifts.
    const want = clamp((rpmN - 0.62) * 2.2 + (thr - 0.7) * 1.4, 0, 1);
    this.glow += (want - this.glow) * Math.min(1, dt * 4);

    if (this.pending > 0) {
      const load = clamp(0.55 * rpmN + 0.45 * this.pDemand, 0, 1);
      const dur = BURST_TUNE.winMin + BURST_TUNE.winSpan * load;
      this.burst = Math.max(this.burst, dur);
      this.burstT = 0;
      this.strength = clamp(0.30 + 0.70 * load, 0, 1);
      this.rate = (BURST_TUNE.rateLo + BURST_TUNE.rateSpan * load) * (this.pUp ? 1 : 0.9);
      this.pulse2 = this.pRev ? 1 : 0;                // two visible pulses
      this.coreN = 0; this.ringN = 0;
      this.pending = 0; this.pUp = 0; this.pRev = 0;
    }

    // Body frame: rear = -local X, up = local Y. Reused scratch, no allocation.
    quatToMat3(car.body.quat, this._m);
    const rx = -this._m[0], ry = -this._m[3], rz = -this._m[6];
    const ux = this._m[1], uy = this._m[4], uz = this._m[7];
    // Third body axis (car-local +Z) so the ring can open outward around the jet.
    const sx = this._m[2], sy = this._m[5], sz = this._m[8];

    let emit = 0, core = false;
    if (this.burst > 0) {
      this.burst -= dt;
      this.burstT += dt;
      const t = this.burstT;
      // Two gaussian pulses (the second only on a rev-matched downshift) over a
      // sputter tail: one gesture, not a bag of independent dots.
      const e1 = Math.exp(-(t * t) / (BURST_TUNE.pulse1W * BURST_TUNE.pulse1W));
      const e2 = this.pulse2
        ? BURST_TUNE.pulse2Gain * Math.exp(-((t - BURST_TUNE.pulse2At) ** 2)
          / (BURST_TUNE.pulse2W * BURST_TUNE.pulse2W))
        : 0;
      const win = BURST_TUNE.winMin + BURST_TUNE.winSpan * this.strength;
      this.acc += this.rate * dt * (e1 + e2 + BURST_TUNE.tail * (1 - Math.min(1, t / win)));
      emit = Math.floor(this.acc);
      this.acc -= emit;
      core = t <= BURST_TUNE.coreWin && this.coreN < BURST_TUNE.coreMax;
      if (this.burst <= 0) { this.burst = 0; this.strength = 0; this.rate = 0; this.pulse2 = 0; }
    } else if (this.glow > 0.05) {                    // the faint continuous glow
      this.acc += 14 * this.glow * dt;
      emit = Math.floor(this.acc);
      this.acc -= emit;
    }

    // ---- shift soot: dark grey to black, expands, drifts with the car, gone in
    // 0.4..0.7 s. Its own pool, carved out of the old flame capacity. ----
    if (this.soot && this.sootBurst > 0 && tips) {
      this.sootBurst -= dt;
      if (this.sootBurst <= 0) { this.sootBurst = 0; this.sootRev = 0; }
      const S = this.soot, sd = S.data;
      const spd = car.body.groundSpeed || 0;
      const rev = this.sootRev;
      this.sootAcc += SOOT_TUNE.rate * dt;
      let sn = Math.floor(this.sootAcc); this.sootAcc -= sn;
      for (let i = 0; i < sn; i++) {
        const o = S.spawn();
        if (o < 0) break;
        const tip = (i & 1) * 3;
        const jx = rnd() - 0.5, jy = rnd() - 0.5, jz = rnd() - 0.5;
        sd[o + F.X] = tips[tip] + jx * 0.05;
        sd[o + F.Y] = tips[tip + 1] + jy * 0.03;
        sd[o + F.Z] = tips[tip + 2] + jz * 0.05;
        sd[o + F.VX] = rx * SOOT_TUNE.push + this._m[0] * spd * SOOT_TUNE.carry + jx * 0.9;
        sd[o + F.VY] = SOOT_TUNE.rise * (0.6 + 0.8 * rnd()) + jy * 0.4;
        sd[o + F.VZ] = rz * SOOT_TUNE.push + this._m[6] * spd * SOOT_TUNE.carry + jz * 0.9;
        const ttl = SOOT_TUNE.ttlMin + SOOT_TUNE.ttlSpan * rnd();
        sd[o + F.LIFE] = ttl; sd[o + F.TTL] = ttl;
        sd[o + F.SIZE] = SOOT_TUNE.sizeLo + SOOT_TUNE.sizeSpan * rnd();
        sd[o + F.HEAT] = rev ? SOOT_TUNE.glowHeat * (0.6 + 0.4 * rnd()) : 0.06 * rnd();
      }
    }

    if (!emit || !tips) return;

    for (let i = 0; i < emit; i++) {
      const o = P.spawn();
      if (o < 0) break;
      const strong = this.burst > 0 ? this.strength : this.glow * 0.35;
      const tip = (i & 1) * 3;
      const hot = core && this.burst > 0;
      const jx = (rnd() - 0.5), jy = (rnd() - 0.5), jz = (rnd() - 0.5);
      if (hot) {
        // Hot core: a tight near-white jet down the middle of the plume, gone
        // inside 85 ms so it never fights the smoke for the silhouette.
        const sp = BURST_TUNE.coreJet + BURST_TUNE.coreJetSpan * strong;
        d[o + F.X] = tips[tip] + jx * 0.02;
        d[o + F.Y] = tips[tip + 1] + jy * 0.02;
        d[o + F.Z] = tips[tip + 2] + jz * 0.02;
        d[o + F.VX] = rx * sp + jx * 0.5;
        d[o + F.VY] = ry * sp + jy * 0.5 + uy * 0.2;
        d[o + F.VZ] = rz * sp + jz * 0.5;
        const ttl = BURST_TUNE.coreTtlLo + BURST_TUNE.coreTtlSpan * rnd();
        d[o + F.LIFE] = ttl; d[o + F.TTL] = ttl;
        d[o + F.SIZE] = BURST_TUNE.coreSizeLo + BURST_TUNE.coreSizeSpan * rnd();
        d[o + F.HEAT] = clamp(BURST_TUNE.coreHeat + BURST_TUNE.coreHeatSpan * rnd() + 0.2 * rpmN, 0, 1.6);
        this.coreN++;
      } else {
        // Flame ring: laid around the jet axis at the tip and thrown outward, so it
        // reads as one ring opening up and thinning out with an upward curl.
        const a = i * 2.399976 + rnd() * 0.5;               // golden step, no clumps
        const ca = Math.cos(a), sa = Math.sin(a);
        const rr = 0.03 + 0.025 * rnd();
        const ox = sx * ca + ux * sa, oy = sy * ca + uy * sa, oz = sz * ca + uz * sa;
        const push = BURST_TUNE.ringPush + BURST_TUNE.ringPushSpan * strong;
        const out = BURST_TUNE.ringOut + BURST_TUNE.ringOutSpan * strong;
        d[o + F.X] = tips[tip] + ox * rr + jx * 0.03;
        d[o + F.Y] = tips[tip + 1] + oy * rr + jy * 0.02;
        d[o + F.Z] = tips[tip + 2] + oz * rr + jz * 0.03;
        d[o + F.VX] = rx * push + ox * out + jx * 0.7;
        d[o + F.VY] = ry * push + oy * out + jy * 0.5;
        d[o + F.VZ] = rz * push + oz * out + jz * 0.7;
        const ttl = BURST_TUNE.ringTtlLo + BURST_TUNE.ringTtlSpan * rnd();
        d[o + F.LIFE] = ttl; d[o + F.TTL] = ttl;
        d[o + F.SIZE] = BURST_TUNE.ringSizeLo + BURST_TUNE.ringSizeSpan * rnd();
        d[o + F.HEAT] = clamp(BURST_TUNE.ringHeat + BURST_TUNE.ringHeatSpan * strong + 0.3 * rpmN, 0, 1.15);
        this.ringN++;
      }
    }
  }

  /** Driven from the sim step: the current throttle pedal, no allocation. */
  setLoad(throttle) { this.throttle = throttle; }
}

// ---------------------------------------------------------------- ambient
// dust off the four contact patches (slip x speed), leaves/needles adrift in the
// treeline under a cheap wind field, and a thin field of dust motes that read in
// the sunlight. Three fixed pools, one draw call each.
export class AmbientFx {
  constructor(dust, leaves, motes) {
    this.dust = dust; this.leaves = leaves; this.motes = motes;
    this.dacc = 0; this.lacc = 0; this.macc = 0;
    this.t = 0;
    this._m = new Float32Array(9);
    this._l = { x: 0, y: 0, z: 0 };   // local scratch (mul3v is not in-place safe)
    this._p = { x: 0, y: 0, z: 0 };
  }

  /** A scenery hit feeds the existing wheel-dust accumulator: same particles, same
   *  wind field, no second emission path. n is in particles. */
  bumpDust(n) { this.dacc += Math.max(0, Math.min(28, n)); }

  /** env = { trees, wind, sun, rain } — all plain numbers, mutated by the caller. */
  step(dt, car, env) {
    this.t += dt;
    const b = car.body, p = car.params;
    const spd = b.groundSpeed;
    quatToMat3(b.quat, this._m);

    // ---- wheel dust: proportional to slip and speed, and to what the tyres are
    // actually standing on. Loose ground (gravel/mud/sand/...) gets the plume;
    // asphalt and stone get nearly none, which is what makes a stage read as loose.
    let slipSum = 0, looseSum = 0;
    for (let i = 0; i < 4; i++) {
      slipSum += Math.abs(car.wheels[i].slip || 0);
      const sfc = surface(car.wheels[i].surfaceId);
      looseSum += (sfc && sfc.loose) ? 1 : 0;
    }
    const looseN = looseSum / 4;
    const surfMul = DUST_TUNE.hardMul + (DUST_TUNE.looseMul - DUST_TUNE.hardMul) * looseN;
    const rate = ((4 + 2.4 * clamp(spd * 0.045, 0, 1)) * slipSum * clamp(spd * 0.14, 0, 1)
      + 3.2 * clamp(spd * 0.035, 0, 1))            // rolling dust even off throttle: speed feel
      * surfMul * (1 - 0.6 * (env.rain || 0));
    this.dacc += rate * dt;
    let n = Math.floor(this.dacc); this.dacc -= n;
    const groundY = b.pos.y - (p.comY || 0.5) + 0.04;
    // Same wind field the leaves drift on, so the plume leans with the stage wind.
    const windX = Math.cos(this.t * 0.33 + b.pos.z * 0.05) * (env.wind || 3);
    const windZ = Math.sin(this.t * 0.27 + b.pos.x * 0.05) * (env.wind || 3) * 0.7;
    for (let i = 0; i < n; i++) {
      const o = this.dust.spawn();
      if (o < 0) break;
      const w = i & 3;
      const fx = (w < 2 ? p.wheelbase : -p.wheelbase) * 0.5;
      const lz = (w === 0 || w === 2 ? 1 : -1) * (w < 2 ? p.trackFront : p.trackRear) * 0.5;
      this._l.x = fx; this._l.y = 0; this._l.z = lz;
      mul3v(this._m, this._l, this._p);                // reused scratch, no alloc
      const d = this.dust.data;
      const s = Math.abs(car.wheels[w].slip || 0);
      const loose = !!(surface(car.wheels[w].surfaceId) || {}).loose;
      const rough = loose ? 1 : 0.7;
      d[o + F.X] = b.pos.x + this._p.x + (rnd() - 0.5) * 0.3;
      d[o + F.Y] = groundY + rnd() * 0.1;
      d[o + F.Z] = b.pos.z + this._p.z + (rnd() - 0.5) * 0.3;
      // Out of the contact patch first (sideways off the tyre, more with slip),
      // then rearwards; the wind field takes over as the plume ages (low drag).
      const out = DUST_TUNE.outward * (0.6 + 1.2 * s) * (lz > 0 ? 1 : -1);
      d[o + F.VX] = -(this._m[0]) * (1.2 + 3.2 * s) + this._m[2] * out + (rnd() - 0.5) * 1.4 + windX * DUST_TUNE.windMul;
      d[o + F.VY] = 0.7 + 1.9 * s + rnd() * 0.7;
      d[o + F.VZ] = -(this._m[6]) * (1.2 + 3.2 * s) + this._m[8] * out + (rnd() - 0.5) * 1.4 + windZ * DUST_TUNE.windMul;
      const ttl = DUST_TUNE.ttlMin + DUST_TUNE.ttlSpan * rnd();
      d[o + F.LIFE] = ttl; d[o + F.TTL] = ttl;
      d[o + F.SIZE] = (0.20 + DUST_TUNE.sizeJit * rnd()) * DUST_TUNE.sizeLoose * rough;
      d[o + F.HEAT] = clamp((0.35 + 0.6 * s + 0.02 * spd) * (loose ? DUST_TUNE.gravelDark : 1.0), 0, 1);
    }

    // ---- leaves / needles near the treeline, drifting on the wind field -----
    const trees = env.trees || 0;
    this.lacc += 9 * trees * dt;
    n = Math.floor(this.lacc); this.lacc -= n;
    for (let i = 0; i < n; i++) {
      const o = this.leaves.spawn();
      if (o < 0) break;
      const d = this.leaves.data;
      const a = rnd() * 6.2832, rad = 7 + 19 * rnd();
      const wx = Math.cos(this.t * 0.33 + b.pos.z * 0.05) * (env.wind || 3);
      const wz = Math.sin(this.t * 0.27 + b.pos.x * 0.05) * (env.wind || 3) * 0.7;
      d[o + F.X] = b.pos.x + Math.cos(a) * rad;      d[o + F.Y] = groundY + 2.0 + 4.5 * rnd();
      d[o + F.Z] = b.pos.z + Math.sin(a) * rad;
      d[o + F.VX] = wx * (0.25 + 0.35 * rnd());
      d[o + F.VY] = -(0.5 + 0.5 * rnd());
      d[o + F.VZ] = wz * (0.25 + 0.35 * rnd());
      const ttl = 3.5 + 3.5 * rnd();
      d[o + F.LIFE] = ttl; d[o + F.TTL] = ttl;
      d[o + F.SIZE] = 0.05 + 0.05 * rnd();
      d[o + F.HEAT] = rnd();                              // species/tint pick
    }

    // ---- dust motes: a thin field that catches the sunlight -----------------
    this.macc += (26 + 26 * clamp(spd * 0.035, 0, 1)) * dt * (0.35 + 0.65 * (env.sun || 1));
    n = Math.floor(this.macc); this.macc -= n;
    for (let i = 0; i < n; i++) {
      const o = this.motes.spawn();
      if (o < 0) break;
      const d = this.motes.data;
      const a = rnd() * 6.2832, rad = 2 + 11 * rnd();
      d[o + F.X] = b.pos.x + Math.cos(a) * rad;
      d[o + F.Y] = groundY + 0.3 + 2.4 * rnd();
      d[o + F.Z] = b.pos.z + Math.sin(a) * rad;
      d[o + F.VX] = (rnd() - 0.5) * 0.5 + (env.wind || 3) * 0.12;
      d[o + F.VY] = (rnd() - 0.5) * 0.18;
      d[o + F.VZ] = (rnd() - 0.5) * 0.5;
      const ttl = 2.2 + 2.6 * rnd();
      d[o + F.LIFE] = ttl; d[o + F.TTL] = ttl;
      d[o + F.SIZE] = 0.022 + 0.036 * rnd();
      d[o + F.HEAT] = (env.sun || 1) * (0.5 + 0.6 * rnd());
    }
  }
}

// ---------------------------------------------------------------- façade
// main.js: new FxSystem({ scale }), fx.step(dt, car, env) in the sim step,
// render/fx-view.js draws the pools.
// The soot pool is carved out of the old 384-slot flame pool: five pools, the
// same total particle budget as before.
export const FX_CAPACITY = { flame: 256, soot: 128, dust: 768, leaves: 256, motes: 512 };

export class FxSystem {
  constructor(opts = {}) {
    const s = clamp(opts.scale === undefined ? 1 : opts.scale, 0.25, 1);
    this.scale = s;
    this.enabled = opts.enabled !== false;
    this.flame = new ParticlePool(Math.round(FX_CAPACITY.flame * s));
    this.soot = new ParticlePool(Math.round(FX_CAPACITY.soot * s));
    this.dust = new ParticlePool(Math.round(FX_CAPACITY.dust * s));
    this.leaves = new ParticlePool(Math.round(FX_CAPACITY.leaves * s));
    this.motes = new ParticlePool(Math.round(FX_CAPACITY.motes * s));
    this.exhaust = new ExhaustFx(this.flame, opts.bus || defaultBus, this.soot);
    this.ambient = new AmbientFx(this.dust, this.leaves, this.motes);
    this.maxLive = Math.round(0.75 * (this.flame.capacity + this.soot.capacity + this.dust.capacity
      + this.leaves.capacity + this.motes.capacity));
    this.tips = new Float32Array(6);      // world coords of the two exhaust tips
    this.localTips = new Float32Array(6);
    this._m = new Float32Array(9);
    this._src = { x: 0, y: 0, z: 0 };
    this._dst = { x: 0, y: 0, z: 0 };
    this.env = { trees: 0, wind: 3, sun: 1, rain: 0 };
  }

  /** Car-local tip offsets from the glb (car-asset.js buildAssetBody). */
  setLocalTips(arr) {
    if (!arr) return;
    for (let i = 0; i < 6; i++) this.localTips[i] = arr[i];
  }

  live() {
    return this.flame.count + this.soot.count + this.dust.count + this.leaves.count
      + this.motes.count;
  }

  /** Fixed-step tick. Allocation-free in steady state. */
  step(dt, car, load) {
    if (!this.enabled) return;
    this.exhaust.setLoad(load || 0);
    const b = car.body;
    quatToMat3(b.quat, this._m);
    for (let i = 0; i < 2; i++) {
      this._src.x = this.localTips[i * 6];
      this._src.y = this.localTips[i * 6 + 1];
      this._src.z = this.localTips[i * 6 + 2];
      mul3v(this._m, this._src, this._dst);
      this.tips[i * 3] = b.pos.x + this._dst.x;
      this.tips[i * 3 + 1] = b.pos.y + this._dst.y;
      this.tips[i * 3 + 2] = b.pos.z + this._dst.z;
    }
    this.exhaust.step(dt, car, this.tips);
    this.ambient.step(dt, car, this.env);

    // Age + compact every pool: one in-place pass each, no allocation.
    age(this.flame, dt, 0.9, BURST_TUNE.curl, BURST_TUNE.grow);
    age(this.soot, dt, 1.1, BURST_TUNE.sootCurl);
    age(this.dust, dt, DUST_TUNE.drag);
    age(this.leaves, dt, 0.0);
    age(this.motes, dt, 0.0);

    // Total live cap: over budget, the cheapest system (motes) gives first.
    let over = this.live() - this.maxLive;
    if (over > 0) over -= killOldest(this.motes, over);
    if (over > 0) over -= killOldest(this.leaves, over);
    if (over > 0) over -= killOldest(this.soot, over);
    if (over > 0) killOldest(this.dust, over);
  }
}

// `drag` bleeds velocity, `lift` m/s^2 curls the plume up, `grow` 1/s billsows it
// out (the flame grows in the pool, so the headless test can watch it).
function age(P, dt, drag, lift = 0, grow = 0) {
  const d = P.data, keep = P.keep;
  let dead = false;
  for (let i = 0; i < P.count; i++) {
    const o = i * STRIDE;
    let l = d[o + F.LIFE] - dt;
    if (l <= 0) { keep[i] = 0; dead = true; continue; }
    d[o + F.LIFE] = l;
    const k = 1 - Math.min(1, dt * drag);
    d[o + F.X] += d[o + F.VX] * dt;
    d[o + F.Y] += d[o + F.VY] * dt;
    d[o + F.Z] += d[o + F.VZ] * dt;
    d[o + F.VX] *= k; d[o + F.VY] = d[o + F.VY] * k + lift * dt; d[o + F.VZ] *= k;
    if (grow) d[o + F.SIZE] *= 1 + grow * dt;
    keep[i] = 1;
  }
  if (dead) P.compact();
}

/** Drop the k oldest (index 0 is the oldest after compact()). */
function killOldest(P, n) {
  const k = Math.min(n, P.count);
  if (k <= 0) return 0;
  const d = P.data;
  for (let r = k; r < P.count; r++) {
    const a = (r - k) * STRIDE, b = r * STRIDE;
    for (let s = 0; s < STRIDE; s++) d[a + s] = d[b + s];
  }
  P.count -= k;
  return k;
}

// xorshift: no Math.random in the sim, so a replay reproduces the particle field.
let _s = 0x9e3779b9;
function rnd() {
  _s ^= _s << 13; _s ^= _s >>> 17; _s ^= _s << 5;
  return (_s >>> 0) / 4294967296;
}
