// The backfire CRACK (queue P13; docs/05 §1 mixer, §5 transients, §10 budget).
//
// The visual half of a backfire has existed for a long time: the gearbox announces
// every gear change on the shared bus (src/car/powertrain.js `_emitShift`),
// src/fx/fx.js turns that into the flame plume, and nothing in the audio layer ever
// listened — the car lit a 150..350 ms fireball in total silence. This module is the
// missing half: one short synthesized pop per plume.
//
// Everything is synthesized (docs/05 §0 "zero plików. Cały dźwięk to WebAudio").
// One generated noise buffer + `chains` pop chains + a master gain and a limiter,
// built ONCE and lazily, at the first pop that actually wants one — a boot that
// never shifts gear never touches WebAudio at all. After the build a pop only moves
// AudioParams: no createBufferSource / createOscillator / createGain in the frame
// (docs/05 §1 "w klatce zmieniają się wyłącznie param.value / setTargetAtTime.
// Żadnego createOscillator() w pętli"), and every envelope ramps through a finite
// attack instead of stepping (docs/05 §10 "żadnych skoków (klików)").
//
// Two contracts, both pinned by src/debug/tests.js T54:
//   * ONE GATE — `shiftPop()` in src/fx/fx.js answers for the flame AND the crack,
//     so a pop can never fire without a plume, or the other way round;
//   * ONE SWITCH — `settings.fx`, the EFEKTY row in Ustawienia, read at pop time,
//     i.e. the same flag the render loop re-arms for the particle pools.
import { bus as defaultBus } from '../core/events.js';
import { clamp } from '../core/math3.js';
import { settings as defaultSettings } from '../core/settings.js';
import { CARS } from '../car/car-params.js';
import { shiftPop, rpmNorm } from '../fx/fx.js';

/** The pop's voice. Numbers follow docs/05 §5 (transient = noise burst -> bandpass
 *  -> lowpass 6 kHz -> gain) with the band pushed up: a backfire crack sits far
 *  higher than a body hit, which is what makes it read as a crack and not a thud. */
export const BACKFIRE = {
  chains: 3,                 // independent pop chains: two shifts close together never steal one
  noiseSeconds: 2.0,         // generated loop buffer (docs/05 §4 "2 s, wypełniony w JS")
  seed: 0x5f12ab33,          // the noise is deterministic, so a replay sounds identical
  level: 0.30,               // pop-layer bus gain (docs/05 §1 [BACKFIRE] -> BUS_MAIN)
  limiterDb: -3,             // docs/05 §10 "Limiter na masterze (threshold -3 dB, ratio 8)"
  limiterRatio: 8,
  crackLo: 900, crackHi: 2400,      // bandpass centre (Hz) at load 0 / 1
  crackEndLo: 420, crackEndHi: 760, // where the band has closed when the pop dies
  bandQ: 1.15,
  lowpass: 6200,             // docs/05 §5 "lowpass 6 kHz"
  thumpLo: 52, thumpHi: 88,  // the low whump under the crack (docs/05 §5 "clunk 60 Hz")
  thumpEndMul: 0.62,         // and it drops as it decays, like the docs' pitch-drop membrane
  thumpLevel: 0.42,          // fraction of the crack's own gain
  gainLo: 0.22, gainHi: 1.0, // pop gain at load 0 / 1, multiplied into `level`
  attackMax: 0.012, attackMin: 0.005,   // s — a ramp, never a step
  decayLo: 0.055, decayHi: 0.145,       // s per crack: this is a pop, not a firework
  maxPopS: 0.34,             // whole train ceiling; the plume window is 0.15..0.35 s
  cracksMax: 3,              // a real backfire fires a short train, not one hit
  crackGapMin: 0.022,        // s between cracks: below this they merge into one click
  rateLo: 0.86, rateHi: 1.22, // noise read rate per chain: every pop draws a different grain
  nodeBudget: 20,            // docs/05 §10 caps the WHOLE mix at 60 nodes
};

/** Deterministic jitter for the crack train (same reason as fx.js's xorshift: a
 *  replay must sound like the replay). */
let _s = BACKFIRE.seed >>> 0;
function rnd() {
  _s ^= _s << 13; _s ^= _s >>> 17; _s ^= _s << 5; _s >>>= 0;
  return _s / 4294967296;
}

const lerp = (a, b, t) => a + (b - a) * t;

/** rpm of a 'shift' event, normalized the way ExhaustFx.step normalizes the car's. */
export function shiftRpmN(e, engine) { return rpmNorm(e && e.rpm, engine); }

/** How the pop layer voices one pop: `load` is the plume's own burst load from
 *  `shiftPop()` (0..1), `rpmN` only opens the band, never the level. Pure — node
 *  can measure it without a WebAudio implementation. */
export function popVoice(load, rpmN = 0, V = BACKFIRE) {
  const s = clamp(load, 0, 1);
  const t = clamp(rpmN, 0, 1);
  const g = lerp(V.gainLo, V.gainHi, s);
  return {
    gain: g * V.level,
    band: lerp(V.crackLo, V.crackHi, 0.65 * s + 0.35 * t),
    bandEnd: lerp(V.crackEndLo, V.crackEndHi, s),
    q: V.bandQ * (1 + 0.35 * s),
    lowpass: V.lowpass,
    thump: lerp(V.thumpLo, V.thumpHi, s),
    thumpEnd: lerp(V.thumpLo, V.thumpHi, s) * V.thumpEndMul,
    thumpGain: V.thumpLevel * g * V.level,
    attack: lerp(V.attackMax, V.attackMin, s),
    decay: Math.min(V.decayHi, lerp(V.decayLo, V.decayHi, s)),
    rate: lerp(V.rateLo, V.rateHi, s),
    cracks: 1 + Math.round(s * (V.cracksMax - 1)),
  };
}

/** The crack train: `n` hits inside one pop window, the first at 0 and each later
 *  one quieter and lower, starting only after the previous envelope has finished —
 *  two overlapping envelopes on one chain would be truncated by the next
 *  setValueAtTime, i.e. a click, which docs/05 §10 forbids. Pure + bounded, so node
 *  can assert the whole envelope (docs/05 §10 test 3) with no audio device. */
export function crackTrain(v, V = BACKFIRE, rand = rnd) {
  const n = Math.max(1, Math.min(V.cracksMax, v.cracks | 0));
  const out = [];
  for (let i = 0; i < n; i++) {
    const decay = i === 0 ? v.decay : v.decay * 0.78;
    let at = 0;
    if (i > 0) {
      const prev = out[i - 1];
      at = prev.at + Math.max(V.crackGapMin, prev.decay) + rand() * prev.decay * 0.35;
      if (at + decay > V.maxPopS) break;      // no room left inside the pop window
    }
    const falloff = 1 / (1 + i * 0.9);
    out.push({
      at,
      gain: v.gain * falloff,
      thumpGain: v.thumpGain * falloff,
      band: i === 0 ? v.band : v.band * (1 - 0.12 * i),
      decay,
    });
  }
  return out;
}

/**
 * The pop layer. Subscribe it to the same bus the gearbox shouts on; it builds its
 * graph at the first pop and after that a pop is nothing but parameter ramps.
 */
export class BackfirePop {
  constructor(opts = {}) {
    this.bus = opts.bus || defaultBus;
    this.settings = opts.settings || defaultSettings;
    this.engine = opts.engine || CARS.A.engine;
    this.enabled = opts.enabled !== false;
    this.V = opts.voice || BACKFIRE;
    this.Ctor = opts.Ctor || null;    // injected by the suite's stub device
    this.audio = opts.audio || null;  // { ctx, bus } when the game grows a mixer
    this.ctx = null;
    this.chains = null;
    this.out = null;
    this.next = 0;
    this.nodes = 0;              // counted at build time, asserted <= nodeBudget
    this.pops = 0;               // pops actually scheduled
    this.gated = 0;              // 'shift' events the plume's gate refused (open throttle)
    this.muted = 0;              // refused by fx off / no WebAudio
    this.builds = 0;             // must stay 1: the graph is built once
    this.buffers = 0;            // the one generated noise buffer
    this.stolen = 0;             // pops that landed on a chain still ringing (want 0)
    this._off = this.bus.on('shift', (e) => this.onShift(e));
  }

  /** The plume's own answer for this event: 0 = no pop at all, else the burst load.
   *  Independent of every switch — that is what makes it comparable with the flame. */
  wants(e) { return shiftPop(e, this.engine); }

  /** The one switch: the same `settings.fx` the render loop re-arms for the pools. */
  silenced() { return !this.enabled || this.settings.fx === false; }

  onShift(e) {
    const load = this.wants(e);
    if (!load) { this.gated++; return false; }        // the plume refuses it too
    if (this.silenced()) { this.muted++; return false; }
    return this.pop(load, shiftRpmN(e, this.engine));
  }

  /** One pop on the next free chain. Returns false when there is no audio device
   *  (node, or a browser that has not unlocked WebAudio yet) — never throws. */
  pop(load, rpmN = 0) {
    const ctx = this._ensure();
    if (!ctx) { this.muted++; return false; }
    const v = popVoice(load, rpmN, this.V);
    const c = this.chains[this.next % this.chains.length];
    this.next++;
    const t = ctx.currentTime;
    // A chain still ringing means a clipped pop: the new envelope would truncate the
    // old one mid-decay. Counted, not hidden — T54 drives a real lap and wants 0.
    if (t < (c.end || 0) - 1e-4) this.stolen++;
    const train = crackTrain(v, this.V);
    const last = train[train.length - 1];
    const end = t + last.at + last.decay;
    c.end = end;

    c.band.frequency.cancelScheduledValues(t);
    c.thump.frequency.cancelScheduledValues(t);
    for (const k of train) {
      const at = t + k.at;
      c.band.frequency.setValueAtTime(k.band, at);
      c.band.frequency.exponentialRampToValueAtTime(Math.max(60, k.band * 0.45), at + k.decay);
      c.gain.gain.setValueAtTime(0.0001, at);
      c.gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, k.gain), at + v.attack);
      c.gain.gain.exponentialRampToValueAtTime(0.0001, at + k.decay);
      c.thumpGain.gain.setValueAtTime(0.0001, at);
      c.thumpGain.gain.exponentialRampToValueAtTime(Math.max(0.0002, k.thumpGain), at + v.attack * 2);
      c.thumpGain.gain.exponentialRampToValueAtTime(0.0001, at + k.decay * 0.8);
      c.thump.frequency.setValueAtTime(v.thump, at);
      c.thump.frequency.exponentialRampToValueAtTime(Math.max(20, v.thumpEnd), at + k.decay);
    }
    // The chain's own colour: a different grain per pop, moved as a parameter.
    c.src.playbackRate.setValueAtTime(v.rate, t);
    c.band.Q.setValueAtTime(v.q, t);
    if (end > this.lastEnd) this.lastEnd = end;
    this.pops++;
    return true;
  }

  /** Lazily unlock the context: browsers only let it run from a user gesture, so the
   *  first tap/keypress is what actually starts the layer. */
  arm(target) {
    const w = target || (typeof window !== 'undefined' ? window : null);
    if (!w || !w.addEventListener || this._armed) return;
    this._armed = true;
    const go = () => { if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume().catch(() => {}); };
    w.addEventListener('pointerdown', go);
    w.addEventListener('keydown', go);
  }

  /** Build the graph once. Nodes: chains x 6 + master gain + limiter. */
  _ensure() {
    if (this.ctx) return this.ctx;
    const Ctor = this.Ctor || (typeof AudioContext !== 'undefined' ? AudioContext
      : (typeof webkitAudioContext !== 'undefined' ? webkitAudioContext : null));
    if (!Ctor) return null;
    const V = this.V;
    try {
      const ctx = (this.audio && this.audio.ctx) || new Ctor();
      const mk = (kind, ...args) => { this.nodes++; return ctx[kind](...args); };

      // One generated noise loop, shared by every chain (docs/05 §4). A buffer is
      // not a node, so it is counted apart from the node budget.
      const sr = ctx.sampleRate || 48000;
      const n = Math.max(1, Math.round(V.noiseSeconds * sr));
      const buf = ctx.createBuffer(1, n, sr);
      this.buffers = (this.buffers || 0) + 1;
      const ch = buf.getChannelData(0);
      for (let i = 0; i < n; i++) ch[i] = (rnd() - 0.5) * 2;

      const out = mk('createGain');
      out.gain.value = V.level;
      // docs/05 §10: the synth is easy to overblow, so the layer ends in a limiter.
      let tail = out;
      if (ctx.createDynamicsCompressor) {
        const lim = mk('createDynamicsCompressor');
        lim.threshold.value = V.limiterDb;
        lim.ratio.value = V.limiterRatio;
        lim.attack.value = 0.003;
        lim.release.value = 0.12;
        out.connect(lim);
        tail = lim;
      }
      tail.connect(this.audio && this.audio.bus ? this.audio.bus : ctx.destination);

      this.chains = [];
      for (let i = 0; i < V.chains; i++) {
        const src = mk('createBufferSource');
        const band = mk('createBiquadFilter');
        const lp = mk('createBiquadFilter');
        const gain = mk('createGain');
        const thump = mk('createOscillator');
        const thumpGain = mk('createGain');
        src.buffer = buf;
        src.loop = true;
        src.loopStart = i * (V.noiseSeconds / V.chains);
        src.loopEnd = src.loopStart + V.noiseSeconds / V.chains;
        band.type = 'bandpass'; band.frequency.value = V.crackLo; band.Q.value = V.bandQ;
        lp.type = 'lowpass'; lp.frequency.value = V.lowpass;
        gain.gain.value = 0.0001;               // silent until a pop ramps it
        thump.type = 'sine'; thump.frequency.value = V.thumpLo;
        thumpGain.gain.value = 0.0001;
        src.connect(band); band.connect(lp); lp.connect(gain); gain.connect(out);
        thump.connect(thumpGain); thumpGain.connect(out);
        src.start(0);                           // the loop runs; the gain owns the sound
        thump.start(0);
        this.chains.push({ src, band, lp, gain, thump, thumpGain });
      }
      this.ctx = ctx;
      this.out = out;
      this.lastEnd = 0;
      this.builds++;
      if (ctx.state === 'suspended' && ctx.resume) ctx.resume().catch(() => {});
      if (this.nodes > V.nodeBudget) this.overBudget = this.nodes;
      return ctx;
    } catch { this.ctx = null; this.chains = null; return null; }
  }

  /** Total scheduled pop seconds — an audit number, and the bound the frame never
   *  hears more of than `chains` overlapping pops. */
  activeChains() { return Math.min(this.chains ? this.chains.length : 0, this.pops); }
  close() {
    if (this._off) this._off();
    if (this.ctx && this.ctx.close) this.ctx.close().catch(() => {});
    this.ctx = null; this.chains = null;
  }
}
