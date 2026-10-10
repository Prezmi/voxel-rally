// Fixed simulation timestep + render interpolation alpha (docs/06 §3,
// .agents/skills/physics-tuning: "run physics on a fixed timestep, interpolate
// rendering between physics ticks").
export const DT = 1 / 120;          // s, docs/02 §2
export const MAX_FRAME_DT = 0.25;   // anti-spiral clamp
export const MAX_STEPS_PER_FRAME = 12;

export class TimeState {
  constructor() {
    this.acc = 0;
    this.last = 0;
    this.alpha = 0;          // 0..1 position between prevSim and lastSim
    this.simTime = 0;        // deterministic sim clock (drives stage timing)
    this.rawDt = 0;          // this frame's wall dt, already clamped to MAX_FRAME_DT
    this.frameSimDt = 0;     // sim seconds this frame actually advanced (n * DT)
    this.stepCount = 0;
    this.timeScale = 1;      // slow-mo for debug / replay
    this.paused = false;
  }

  /**
   * Advance the accumulator and return how many fixed steps to run this frame.
   * `nowMs` is a wall clock in ms.
   */
  begin(nowMs) {
    if (!this.last) { this.last = nowMs; return 0; }
    let dt = (nowMs - this.last) / 1000;
    this.last = nowMs;
    if (dt < 0) dt = 0;
    if (dt > MAX_FRAME_DT) dt = MAX_FRAME_DT;   // load hitch / breakpoint guard
    this.rawDt = dt;                             // never hand an unclamped dt to logic
    if (this.paused) { this.alpha = 0; this.frameSimDt = 0; return 0; }
    this.acc += dt * this.timeScale;
    let n = Math.floor(this.acc / DT);
    if (n > MAX_STEPS_PER_FRAME) n = MAX_STEPS_PER_FRAME;  // never spiral
    return n;
  }

  consume(n) {
    this.frameSimDt = n * DT;
    this.acc -= n * DT;
    if (this.acc < 0) this.acc = 0;
    this.alpha = this.acc / DT;
    this.simTime += n * DT;
    this.stepCount += n;
  }
}
