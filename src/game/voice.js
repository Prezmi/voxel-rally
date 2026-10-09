// Co-driver voice (docs/05 §7, docs/07 F4 "voice.js (speechSynthesis + fallback)").
//
// Two output paths, one queue:
//   A. window.speechSynthesis when the browser has voices (rate 1.35 / pitch 0.95,
//      docs/05 §7) — the text is always the Polish rally notation.
//   B. deterministic fallback: a short pre-allocated click (band-passed burst) plus
//      the written note in the HUD. The queue and its timings are identical either
//      way, so the note scheduling is testable headless and never depends on a
//      voice pack being installed (docs/05 §7 "Wariant B").
//
// The queue is priority-based (docs/05 §7 "nowa notatka przerywa starszą jeśli
// pilniejsza (CAUTION)"): a hazard note preempts a routine one, a routine note that
// cannot be finished before its corner is merged/dropped instead of talked over.
// No nodes are created in the frame: the click graph is built once, lazily, at the
// first note (docs/05 "graf węzłów jest budowany raz").
import { PRIORITY } from './pace-notes.js';

const MAX_QUEUE = 8;             // a stage never needs more notes "in the air" than this
const CLICK_POOL = 3;            // pre-allocated burst chains (docs/05 §10: <= 60 nodes)

export class Voice {
  /**
   * @param notes  PaceTrack or the raw note array
   * @param emit   event bus ('pace-note' / 'pace-note-spoken')
   * @param audio  optional audio graph handle: { ctx, masterGain, duck(f) } (F5)
   */
  constructor(opts = {}) {
    this.list = opts.notes && opts.notes.list ? opts.notes.list : (opts.notes || []);
    this.emit = opts.emit || null;
    this.audio = opts.audio || null;
    this.enabled = opts.enabled !== false;
    this.muted = false;
    this.useSpeech = opts.useSpeech !== false;
    this.synth = (this.useSpeech && typeof speechSynthesis !== 'undefined' && typeof SpeechSynthesisUtterance !== 'undefined')
      ? speechSynthesis : null;
    this.voice = null;
    if (this.synth) this._pickVoice();

    // Pre-allocated queue slots: pushing a note never allocates (docs/07 budgets).
    this.slots = new Array(MAX_QUEUE);
    for (let i = 0; i < MAX_QUEUE; i++) this.slots[i] = { note: null, at: 0, remaining: 0, priority: 0, started: false, active: false, spokeAt: 0 };
    this.queue = new Array(MAX_QUEUE).fill(null);
    this.qLen = 0;
    this.speaking = null;         // {slot} currently being spoken
    this.speakRemaining = 0;
    this.speakTotal = 0;          // audit: total spoken seconds over the stage
    this.interrupted = 0;
    this.lost = 0;                // notes that could not fit before their corner
    this.spokenLog = [];          // deterministic record for the headless audit
    this.clickCtx = null;
    this.clickNodes = null;
    this.clickNext = 0;
    this._nextIdx = 0;            // geometry cursor (advance() walks the note list)
    this.ducked = false;
    this.currentText = '';        // what the HUD sign shows
    this.currentUntil = 0;        // stage-clock time the sign stays up
    this.clock = 0;
  }

  _pickVoice() {
    const apply = () => {
      const vs = this.synth.getVoices ? this.synth.getVoices() : [];
      if (!vs.length) return;
      const pref = vs.find((v) => /^pl/i.test(v.lang)) || vs.find((v) => /^en/i.test(v.lang)) || vs[0];
      this.voice = pref;
    };
    apply();
    if (!this.voice && this.synth.onvoiceschanged !== undefined) {
      try { this.synth.onvoiceschanged = apply; } catch { /* no voice list yet */ }
    }
  }

  reset() {
    this._nextIdx = 0;
    this.qLen = 0;
    for (let i = 0; i < MAX_QUEUE; i++) { const s = this.slots[i]; s.note = null; s.remaining = 0; s.started = false; s.priority = 0; s.active = false; this.queue[i] = null; }
    this.speaking = null; this.speakRemaining = 0; this.speakTotal = 0;
    this.interrupted = 0; this.lost = 0; this.spokenLog.length = 0;
    this.currentText = ''; this.currentUntil = 0; this.clock = 0;
    if (this.synth) { try { this.synth.cancel(); } catch { /* nothing queued */ } }
    this._unduck();
  }

  /** Queue one note (priority insertion: highest priority is spoken first). */
  push(note) {
    if (!note || !this.enabled || this.muted) return false;
    let slot = null;
    for (let i = 0; i < MAX_QUEUE; i++) if (!this.slots[i].active) { slot = this.slots[i]; break; }
    if (!slot) { this.lost++; return false; }        // mic fully booked: a note is dropped, never piled up
    slot.note = note; slot.priority = note.priority; slot.remaining = note.duration;
    slot.at = this.clock; slot.active = true; slot.started = false;
    let i = this.qLen;
    while (i > 0 && this.queue[i - 1].priority <= note.priority) i--;
    for (let j = Math.min(this.qLen, MAX_QUEUE - 1); j > i; j--) this.queue[j] = this.queue[j - 1];
    this.queue[i] = slot;
    if (this.qLen < MAX_QUEUE) this.qLen++;
    // Preemption: a hazard takes the mic from a routine note that has not got much
    // left to say; a routine note never interrupts anything (docs/05 §7).
    if (this.speaking && note.priority > this.speaking.priority && this.speakRemaining <= 0.55 * this.speaking.duration) {
      this.interrupted++;
      this._speakEnd(this.speaking, this.clock, true);
      this.speaking = null; this.speakRemaining = 0;
      if (this.synth) { try { this.synth.cancel(); } catch { /* ignore */ } }
    }
    return true;
  }

  /** Fixed-step advance: `arc` is the stage distance reached, `dt` the sim dt. */
  advance(arc, dt) {
    this.clock += dt;
    const L = this.list;
    while (this._nextIdx < L.length && L[this._nextIdx].triggerArc <= arc) {
      const note = L[this._nextIdx];
      this._nextIdx++;
      if (this.emit) this.emit.emit('pace-note', note);
      this.push(note);
    }
    // Service the mic.
    if (this.speaking) {
      this.speakRemaining -= dt;
      if (this.speakRemaining <= 0) { this._speakEnd(this.speaking, this.clock, false); this.speaking = null; this.speakRemaining = 0; }
    }
    if (!this.speaking && this.qLen > 0) {
      const slot = this.queue[0];
      for (let i = 1; i < this.qLen; i++) if (this.queue[i].priority > slot.priority) slot = this.queue[i];
      // Never start a call that would finish after the corner it warns about
      // (docs/07 F4: >= 1.2 s of lead time, so a too-late note is useless).
      const deadline = slot.note.apexArc - slot.note.ghostSpeed * 1.2;
      if (slot.note.kind === 'straight' || arc <= deadline) {
        this._unlink(slot);              // leaves the queue, keeps slot.note for the mic
        slot.started = true;
        this.speaking = slot;
        this.speakRemaining = slot.remaining;
        this._speakStart(slot);
      } else {
        slot.note.micLost = (slot.note.micLost || 0) + 1;
        this.lost++;
        this._speakEnd(slot, this.clock, false);
      }
    }
    if (this.currentText && this.clock > this.currentUntil) this.currentText = '';
    return this.currentText;
  }

  _unlink(slot) {
    const i = this.queue.indexOf(slot);
    if (i >= 0) {
      for (let j = i; j < this.qLen - 1; j++) this.queue[j] = this.queue[j + 1];
      this.qLen--;
    }
    this.queue[this.qLen] = null;
  }

  /** Back to the pool: the slot object is reused, never re-created. */
  _release(slot) {
    this._unlink(slot);
    slot.note = null; slot.started = false; slot.remaining = 0; slot.priority = 0; slot.active = false;
  }

  _speakStart(slot) {
    const note = slot.note;
    this.currentText = note.text;
    this.currentUntil = this.clock + note.duration + 0.35;
    if (!this.muted) {
      if (this.synth) this._say(note.text);
      else this._click(note);
      this._duck(true);
    }
    slot.spokeAt = this.clock;
  }

  _speakEnd(slot, at, interrupted) {
    const note = slot.note;
    this._release(slot);
    if (!note) return;
    const dur = slot.remaining > 0 ? note.duration - slot.remaining : note.duration;
    this.speakTotal += Math.max(0, dur);
    this.spokenLog.push({ text: note.text, kind: note.kind, arc: note.apexArc, trigger: note.triggerArc, at, dur, interrupted: !!interrupted });
    slot.note = null; slot.started = false; slot.remaining = 0; slot.priority = 0;
    if (!interrupted) this._duck(false);
    if (this.emit) this.emit.emit('pace-note-spoken', note);
  }

  /** Variant A (docs/05 §7). */
  _say(text) {
    try {
      const u = new SpeechSynthesisUtterance(text);
      u.rate = 1.35; u.pitch = 0.95; u.volume = 0.9;
      if (this.voice) u.voice = this.voice;
      if (this.voice && this.voice.lang) u.lang = this.voice.lang;
      this.synth.speak(u);
    } catch { this._click(this.speaking && this.speaking.note); }
  }

  /** Variant B: one burst from a pre-built pool, no node creation per frame. */
  _click(note) {
    const ctx = this._ensureClick();
    if (!ctx) return;                       // no WebAudio available (headless node)
    const chain = this.clickNodes[this.clickNext % CLICK_POOL];
    this.clickNext++;
    const t = ctx.currentTime;
    const hz = note && note.priority === PRIORITY.HIGH ? 1500 : (note && note.severity >= 5 ? 900 : 1150);
    chain.osc.frequency.setValueAtTime(hz, t);
    chain.gain.gain.cancelScheduledValues(t);
    chain.gain.gain.setValueAtTime(0.0001, t);
    chain.gain.gain.exponentialRampToValueAtTime(0.22, t + 0.012);
    chain.gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.10);
    chain.osc.stop(t + 0.14);
    chain.osc.start(t);
  }

  _ensureClick() {
    if (this.clickCtx) return this.clickCtx;
    const Ctor = this.audio && this.audio.ctx
      ? null : (typeof AudioContext !== 'undefined' ? AudioContext : (typeof webkitAudioContext !== 'undefined' ? webkitAudioContext : null));
    try {
      const ctx = (this.audio && this.audio.ctx) || (Ctor ? new Ctor() : null);
      if (!ctx) return null;
      this.clickCtx = ctx;
      this.clickNodes = [];
      // 3 x (osc -> bandpass -> gain) = 9 nodes, built once, dry bus (docs/05 §1).
      for (let i = 0; i < CLICK_POOL; i++) {
        const osc = ctx.createOscillator();
        const bp = ctx.createBiquadFilter();
        const gain = ctx.createGain();
        osc.type = 'square';
        bp.type = 'bandpass'; bp.frequency.value = 1200; bp.Q.value = 2.2;   // helmet intercom (docs/05 §7)
        gain.gain.value = 0.0001;
        osc.connect(bp); bp.connect(gain);
        gain.connect(this.audio && this.audio.voiceBus ? this.audio.voiceBus : ctx.destination);
        this.clickNodes.push({ osc, bp, gain });
      }
      return ctx;
    } catch { this.clickCtx = null; return null; }
  }

  /** Duck the rest of the mix while the co-driver talks (docs/05 §1 "[VOICE] duckuje resztę o 3 dB"). */
  _duck(on) {
    const a = this.audio;
    if (!a) return;
    const bus = a.masterGain || a.bus || a.musicGain;
    if (!bus || !bus.gain || !bus.gain.setTargetAtTime) return;
    if (on === this.ducked) return;
    this.ducked = on;
    const base = a.baseGain !== undefined ? a.baseGain : 0.8;
    try { bus.gain.setTargetAtTime(on ? base * 0.707 : base, this.clickCtx ? this.clickCtx.currentTime : 0, 0.03); } catch { /* graph not ready */ }
  }
  _unduck() { if (this.ducked) this._duck(false); }
}
