// Stage state machine (docs/06 §2 `game/stage.js`, rules from docs/03 §4):
// PRE_START -> RUNNING -> FINISHED | DNF. Owns the start gate, the checkpoint
// plane tests, sector boundaries, penalties and the time limit, and reports
// everything through the event bus so the HUD (and later pace notes / voice /
// ghost) subscribe instead of polling (docs/06 §4, .agents/skills/game-ui-ux #6).
import { planCheckpoints } from '../world/road-spline.js';
import { bus } from '../core/events.js';
import { Timing } from './timing.js';
import {
  CHECKPOINTS, COUNTDOWN, GATE_ARM_ARC, GATE_LATERAL, GATE_MISS_ARC,
  JUMP_START_SPEED, MAX_MISSED_GATES, STUCK_SPEED, STUCK_TIME,
} from './stage-rules.js';

export const STATE = { PRE_START: 'PRE_START', RUNNING: 'RUNNING', FINISHED: 'FINISHED', DNF: 'DNF' };

/**
 * Checkpoint list for one stage. `planCheckpoints` already places gates every
 * 900-1600 m (docs/03 §4); the slice demands exactly 6 checkpoints (PLAN.md §2),
 * so the longest remaining gap is bisected until the count matches. Deterministic:
 * no RNG, same seed -> same gates (see SYSTEM-NOTES.md).
 */
export function planGates(road, seed, target = CHECKPOINTS) {
  const gates = planCheckpoints(road, seed);
  // Bisect the longest gap until the slice's checkpoint count is reached.
  for (let guard = 0; guard < 16 && gates.length < target; guard++) {
    let bi = 0, best = 0;
    for (let i = 1; i < gates.length; i++) {
      const gap = gates[i].arc - gates[i - 1].arc;
      if (gap > best) { best = gap; bi = i; }
    }
    if (best < 300) break;                       // nowhere left worth splitting
    const arc = (gates[bi - 1].arc + gates[bi].arc) * 0.5;
    gates.splice(bi, 0, { arc, kind: 'sector', index: road.indexAt(arc) });
  }
  let n = 0;
  for (const g of gates) g.number = n++;
  return gates;
}

/** Runtime copy of a gate: signed-distance plane test state (docs/03 §4 "test znaku"). */
class GateRun {
  constructor(g) {
    this.gate = g;
    this.arc = g.arc;
    this.kind = g.kind;
    this.number = g.number;
    this.index = g.index;
    this.armed = false;
    this.prevD = 0;
    this.taken = false;
    this.missed = false;
    this.at = -1;
  }
}

export class StageRun {
  constructor({ road, gates, seed, refTime = 0, timing = null, refSectors = null, emit = bus }) {
    this.road = road;
    this.gates = gates || planGates(road, seed);
    this.seed = seed;
    this.emit = emit;
    this.timing = timing || new Timing({ refTime, refSectors });
    if (!this.timing.sectors.length) this.timing.planSectors(this.gates, refTime);
    this.state = STATE.PRE_START;
    this.gateRuns = [];
    this.reset();
  }

  reset(refTime = this.timing.refTime) {
    this.state = STATE.PRE_START;
    this.countdown = COUNTDOWN;
    this.countdownMark = Math.ceil(this.countdown);
    this.elapsedRun = 0;
    this.missed = 0;
    this.jumpStartPenalty = false;
    this.stuckTime = 0;
    this.arc = 0;
    this.furthest = 0;
    this.nextGate = 1;                 // gates[0] is the start line
    this.result = null;
    this.reason = '';
    if (refTime !== this.timing.refTime && !this.timing.refSectors) {
      this.timing.limit = refTime * this.timing.limitMult;
      this.timing.planSectors(this.gates, refTime);
    }
    this.timing.reset();
    this.gateRuns.length = 0;
    for (const g of this.gates) this.gateRuns.push(new GateRun(g));
    this.gateRuns[0].taken = true;
    this.gateRuns[0].armed = true;
    this.emit.emit('stage-reset', { stage: this });
    return this;
  }

  /** Signed distance along the gate plane and lateral offset from the centreline. */
  _gateSide(g, x, z) {
    const r = this.road, i = g.index;
    const dx = x - r.x[i], dz = z - r.z[i];
    GATE_D = dx * r.tx[i] + dz * r.tz[i];
    GATE_LAT = dx * r.nx[i] + dz * r.nz[i];
    return GATE_D;
  }

  /**
   * One fixed sim step. `dt` must be the fixed DT (docs/06 §3) — every timer here
   * accumulates dt, so a replayed drive produces identical stage times.
   */
  step(dt, car) {
    const r = this.road, b = car.body;
    const idx = r.nearest(b.pos.x, b.pos.z);
    if (idx >= 0) {
      this.arc = r.s[idx];
      if (this.arc > this.furthest) this.furthest = this.arc;
    }

    if (this.state === STATE.PRE_START) {
      this.countdown -= dt;
      const mark = Math.ceil(Math.max(0, this.countdown));
      if (mark !== this.countdownMark) {
        this.countdownMark = mark;
        this.emit.emit('countdown', { value: mark });
      }
      if (!this.jumpStartPenalty && b.groundSpeed > JUMP_START_SPEED) {
        this.jumpStartPenalty = true;
        const rec = this.timing.addPenalty('jump-start', this.timing.penaltyJumpStart, 'skok ze startu');
        this.emit.emit('penalty', { kind: 'jump-start', record: rec, total: this.timing.total });
      }
      if (this.countdown <= 0) {
        this.state = STATE.RUNNING;
        this.timing.start();
        this.emit.emit('start', { at: 0, gates: this.gates.length });
      }
      return;
    }

    if (this.state !== STATE.RUNNING) return;

    this.timing.step(dt);
    this.elapsedRun = this.timing.elapsed;

    // ---- checkpoints: sequence is enforced, one pending gate at a time ----
    const g = this.gateRuns[this.nextGate];
    if (g && !g.taken && !g.missed) {
      const d = this._gateSide(g, b.pos.x, b.pos.z);
      const lat = GATE_LAT;
      if (!g.armed && this.furthest >= g.arc - GATE_ARM_ARC) { g.armed = true; g.prevD = d; }
      if (g.armed) {
        const atEnd = this.furthest >= r.length - 20;
        if ((g.prevD < 0 && d >= 0 && Math.abs(lat) <= GATE_LATERAL) || (g.kind === 'finish' && atEnd)) {
          this._takeGate(g);
        } else if (this.furthest > g.arc + GATE_MISS_ARC) {
          this._missGate(g);
        }
        g.prevD = d;
      }
    }

    // ---- DNF: time limit, too many missed gates, or stalled off the stage ----
    if (this.state !== STATE.RUNNING) return;
    const t = this.timing;
    if (t.limit > 0 && t.total > t.limit) return this.dnf('limit');
    if (b.groundSpeed < STUCK_SPEED) this.stuckTime += dt; else this.stuckTime = 0;
    if (this.stuckTime > STUCK_TIME) return this.dnf('stuck');
  }

  _takeGate(g) {
    g.taken = true;
    g.at = this.timing.total;
    const sector = this.timing.closeSector(g.arc, g.kind);
    const payload = {
      number: g.number, kind: g.kind, arc: g.arc, at: g.at,
      sector: sector ? { index: sector.index, time: sector.time, split: sector.split, refTime: sector.refTime } : null,
      total: this.timing.total,
      split: sector ? sector.split : this.timing.liveSplit,
      limitRemaining: this.timing.limitRemaining,
    };
    this.emit.emit('checkpoint', payload);
    this.nextGate++;
    if (g.kind === 'finish') this.finish();
  }

  _missGate(g) {
    g.missed = true;
    this.missed++;
    const rec = this.timing.addPenalty(
      'gate', this.timing.penaltyGate,
      `brak checkpointu ${g.number}`, g.number,
    );
    this.emit.emit('penalty', {
      kind: 'gate', record: rec, gateNumber: g.number,
      missed: this.missed, total: this.timing.total,
    });
    this.nextGate++;
    if (this.missed >= MAX_MISSED_GATES) this.dnf('gates');
  }

  finish() {
    if (this.state !== STATE.RUNNING) return this.result;
    this.state = STATE.FINISHED;
    this.timing.closed = true;
    this.result = this.timing.classify('FINISHED', '');
    this.emit.emit('finished', this.result);
    return this.result;
  }

  dnf(reason) {
    if (this.state === STATE.DNF) return this.result;
    this.state = STATE.DNF;
    this.timing.closed = true;
    this.reason = reason;
    this.result = this.timing.classify('DNF', reason);
    this.emit.emit('dnf', { ...this.result, reason });
    return this.result;
  }
}

// Scratch for the plane test: module-level so the per-step gate check allocates
// nothing (PLAN.md §7 "pula obiektów", no per-frame allocation in the hot loop).
let GATE_D = 0, GATE_LAT = 0;
