// Stage clock: elapsed time, sector times, splits against a reference, penalties
// (docs/03 §4). Fixed-step safe on purpose: every accumulation uses the *sim* dt
// handed in by the fixed loop, never performance.now(), so the same drive replayed
// with the same inputs gives the same times (PLAN.md §8 #7, docs/02 determinism).
import { LIMIT_MULT, PENALTY_GATE, PENALTY_JUMP_START } from './stage-rules.js';

/** mm:ss.ss — the format a rally clock uses. Polish/EU decimal point kept as '.' for the monospace grid. */
export function formatTime(t) {
  const neg = t < 0;
  let a = Math.abs(t);
  const m = Math.floor(a / 60);
  const s = a - m * 60;
  return `${neg ? '-' : ''}${String(m).padStart(2, '0')}:${s < 10 ? '0' : ''}${s.toFixed(2)}`;
}

/** +0.7s / -1.23s — the split line the HUD shows after every gate (docs/07 F4). */
export function formatSplit(d) {
  const sign = d >= 0 ? '+' : '-';
  const a = Math.abs(d);
  return a < 0.005 ? '0.00s' : `${sign}${a.toFixed(2)}s`;
}

/**
 * One sector boundary bookkeeping entry. Created at gate-plan time, never in the
 * hot loop, so the running stage allocates nothing per frame.
 */
export class Sector {
  constructor(index, fromArc, toArc, refTime) {
    this.index = index;         // 1-based, matches the checkpoint number the HUD prints
    this.fromArc = fromArc;
    this.toArc = toArc;
    this.refTime = refTime;     // reference for this sector (ghost agent supplies real ones later)
    this.time = -1;             // real sector time, -1 = not driven yet
    this.split = 0;             // cumulative time - cumulative reference, at the end of this sector
    this.at = -1;               // stage clock at the moment the gate was taken
    this.penaltyHere = 0;       // penalties banked while driving this sector
  }
}

export class Timing {
  /**
   * opts:
   *  refTime      reference total (docs/03 §6 ghost; a number is enough for now)
   *  refSectors   optional per-sector reference times (same order as sectors)
   *  limit        explicit stage limit, else refTime * 1.6 (docs/03 §4)
   *  penaltyGate / penaltyJumpStart / limitMult  balance knobs (docs/03 §4 defaults)
   */
  constructor(opts = {}) {
    this.penaltyGate = opts.penaltyGate ?? PENALTY_GATE;
    this.penaltyJumpStart = opts.penaltyJumpStart ?? PENALTY_JUMP_START;
    this.limitMult = opts.limitMult ?? LIMIT_MULT;
    this.refTime = opts.refTime ?? 0;
    this.refSectors = opts.refSectors ?? null;
    this.limit = opts.limit ?? (this.refTime > 0 ? this.refTime * this.limitMult : opts.limitPlaceholder ?? 0);

    this.elapsed = 0;        // sim-time since the start gate, excludes penalties
    this.penaltyTotal = 0;
    this.penalties = [];     // {kind, seconds, at, label, gateIndex} — event-time only
    this.sectors = [];       // Sector[] laid out at reset()
    this.running = false;
    this.closed = false;
    this._activeSector = -1;
    this._clockAtSectorStart = 0;
    this._penaltyAtSectorStart = 0;
  }

  /**
   * Lay out the sectors from the checkpoint list (start gate + finish gate included).
   * Reference per sector falls back to a share of refTime proportional to the sector
   * length until the ghost agent produces real per-sector refs (docs/03 §6).
   */
  planSectors(gates, refTime = this.refTime) {
    this.refTime = refTime;
    if (!this.limit) this.limit = this.refTime > 0 ? this.refTime * this.limitMult : 0;
    this.sectors.length = 0;
    let totalArc = 0;
    for (let i = 1; i < gates.length; i++) totalArc += gates[i].arc - gates[i - 1].arc;
    for (let i = 1; i < gates.length; i++) {
      const from = gates[i - 1].arc, to = gates[i].arc;
      const share = totalArc > 0 ? (to - from) / totalArc : 0;
      const ref = this.refSectors && this.refSectors[i - 1] !== undefined
        ? this.refSectors[i - 1]
        : this.refTime * share;
      this.sectors.push(new Sector(i, from, to, ref));
    }
    return this.sectors;
  }

  reset() {
    this.elapsed = 0;
    this.penaltyTotal = 0;
    this.penalties.length = 0;
    this.running = false;
    this.closed = false;
    this._activeSector = -1;
    this._clockAtSectorStart = 0;
    this._penaltyAtSectorStart = 0;
    for (const s of this.sectors) { s.time = -1; s.split = 0; s.at = -1; s.penaltyHere = 0; }
  }

  /** The clock starts when the countdown reaches GO — not at boot (docs/03 §4). */
  start() {
    this.running = true;
    this._activeSector = 0;
    this._clockAtSectorStart = 0;
    this._penaltyAtSectorStart = 0;
  }

  /** Called once per fixed sim step while the stage is RUNNING (docs/06 §3). */
  step(dt) {
    if (this.running && !this.closed) this.elapsed += dt;
  }

  /** Total as classified: driven time + penalties (docs/03 §4). */
  get total() { return this.elapsed + this.penaltyTotal; }

  get limitRemaining() { return this.limit - this.total; }

  /** Split of the *current*, unfinished sector against the reference. */
  get liveSplit() {
    const s = this.sectors[this._activeSector];
    if (!s) return this.total - this.refTime;
    let refSum = 0;
    for (let i = 0; i <= this._activeSector; i++) refSum += this.sectors[i].refTime;
    return this.total - refSum;
  }

  get activeSector() { return this.sectors[this._activeSector] || null; }

  /** Bank a penalty. `label` is Polish because the player reads it. */
  addPenalty(kind, seconds, label, gateIndex = -1) {
    const rec = { kind, seconds, at: this.elapsed, label, gateIndex };
    this.penalties.push(rec);
    this.penaltyTotal += seconds;
    const s = this.sectors[this._activeSector];
    if (s) s.penaltyHere += seconds;
    return rec;
  }

  /** Close the active sector at a gate crossing and start the next one. */
  closeSector(gateArc, kind) {
    const s = this.sectors[this._activeSector];
    if (!s) return null;
    s.time = this.total - s.penaltyHere - (this._sectorTotalAtStart());
    s.at = this.total;
    let refSum = 0;
    for (let i = 0; i <= this._activeSector; i++) refSum += this.sectors[i].refTime;
    s.split = this.total - refSum;
    this._activeSector++;
    this._clockAtSectorStart = this.elapsed;
    this._penaltyAtSectorStart = this.penaltyTotal;
    return s;
  }

  _sectorTotalAtStart() { return this._clockAtSectorStart + this._penaltyAtSectorStart; }

  /** Cumulative reference time up to (and including) sector `index` (0-based). */
  refUpTo(index) {
    let r = 0;
    for (let i = 0; i <= index && i < this.sectors.length; i++) r += this.sectors[i].refTime;
    return r;
  }

  /** Final classification; `result` is 'FINISHED' | 'DNF' (stage.js decides which). */
  classify(result = 'FINISHED', reason = '') {
    let refSum = 0;
    const sectors = [];
    for (const s of this.sectors) {
      refSum += s.refTime;
      sectors.push({
        index: s.index, time: s.time, split: s.split, refTime: s.refTime,
        penaltyHere: s.penaltyHere, toArc: s.toArc,
      });
    }
    return {
      result, reason,
      total: this.total,
      elapsed: this.elapsed,
      penaltyTotal: this.penaltyTotal,
      split: this.total - (refSum || this.refTime),
      refTime: this.refTime,
      limit: this.limit,
      sectors,
      penalties: this.penalties.slice(),
    };
  }
}
