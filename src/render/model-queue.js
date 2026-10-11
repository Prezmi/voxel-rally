// Bounded, retrying, serialized scheduler for the big model requests
// (queue P41). Pure module: no THREE, no DOM, no fetch — the caller supplies the
// attempt function and the wait, so the whole policy is assertable in node
// (src/debug/tests.js T44) while render/assets.js stays the only place that
// touches a loader.
//
// Why it exists: the hero car used to drop to the procedural body in every
// driving capture while a showroom capture loaded the same file fine, and the log
// blamed the file ("no named nodes in the glb"). It is a boot burst. The dev
// server (`python3 -m http.server`, `LISTEN 0 5` on :8090) accepts with a 5-deep
// backlog and answers HTTP/1.0 (no keep-alive), while a boot opens ~60 module
// requests plus three multi-hundred-kilobyte glbs at once: measured 60
// concurrent requests to that server, every one 200 but the slowest ~1.3 s, i.e.
// connections past the backlog wait out a SYN retransmit. props.glb and
// stage_blocks.glb win that race and rally_v2.glb, requested in the same burst,
// is still pending when the shot harness ends its virtual-time budget, so the
// fetch aborts ("Failed to fetch"). One attempt, no queue, no retry: the whole
// visual pass then judges the fallback.
//
// The policy, in order of value:
//   concurrency 1  - one model request in flight, so the three glbs can never
//                    stack onto a boot that already saturates the accept queue.
//                    The 1.6 MB of glbs arrive one after another, which is
//                    cheaper than one of them losing the race.
//   attempts 3     - a refused or starved connection is transient: try again
//                    after a short backoff instead of accepting the fallback.
//   attemptBudget  - a genuinely missing file stays bounded: after
//                    maxSessionAttempts tries for one name the queue stops
//                    asking, so this can never become a retry loop.

export const MODEL_QUEUE = {
  concurrency: 1,             // model fetches at a time (see the backlog note)
  attempts: 3,                // tries per request before giving up
  backoffMs: [150, 600],      // wait after try 1, after try 2, and later
  maxSessionAttempts: 6,      // total tries per name across the session
};

/** Backoff after the n-th failed try (1-based); the last entry repeats. */
export function nextBackoffMs(tryNo, backoff = MODEL_QUEUE.backoffMs) {
  const i = Math.min(Math.max(0, (tryNo | 0) - 1), backoff.length - 1);
  return backoff[i];
}

const defaultWait = (ms) => new Promise((res) => setTimeout(res, ms));

export class ModelQueue {
  constructor(opts = {}) {
    this.concurrency = Math.max(1, opts.concurrency || MODEL_QUEUE.concurrency);
    this.attempts = Math.max(1, opts.attempts || MODEL_QUEUE.attempts);
    this.backoff = opts.backoff || MODEL_QUEUE.backoffMs;
    this.maxSessionAttempts = opts.maxSessionAttempts || MODEL_QUEUE.maxSessionAttempts;
    this.wait = opts.wait || defaultWait;
    this._queue = [];
    this._active = new Map();    // name -> in-flight entry, so a name is asked once
    this._tries = new Map();     // name -> attempts made (never reset: the budget)
    this._failures = new Map();  // name -> last failure reason
    this._inflight = 0;
    this._waiters = 0;           // retries sitting in backoff; they hold no slot
  }

  get inflight() { return this._inflight; }
  get queued() { return this._queue.length; }
  get waiting() { return this._waiters; }
  tries(name) { return this._tries.get(String(name)) || 0; }
  lastFailure(name) { return this._failures.get(String(name)) || ''; }
  stats() {
    let asks = 0;
    for (const n of this._tries.values()) asks += n;
    return { inflight: this._inflight, queued: this._queue.length, waiting: this._waiters,
             names: this._tries.size, asks, concurrency: this.concurrency,
             attemptsPerRequest: this.attempts };
  }

  /**
   * Run `attempt(tryNo)` for `name` under the queue's policy. Resolves with the
   * attempt's value, or rejects with the last error (or the budget error). A
   * second call for a name already in flight joins it instead of firing a
   * duplicate request.
   */
  run(name, attempt) {
    const key = String(name);
    const live = this._active.get(key);
    if (live) return live.promise;

    const entry = { key, attempt };
    entry.promise = new Promise((resolve, reject) => {
      entry.resolve = resolve;
      entry.reject = reject;
    });
    this._active.set(key, entry);
    this._queue.push(entry);
    this._pump();
    return entry.promise;
  }

  _pump() {
    while (this._inflight < this.concurrency && this._queue.length) {
      this._inflight++;
      this._attempt(this._queue.shift());
    }
  }

  // One attempt holds one slot; a retry goes back on the queue after its backoff
  // so the slot is never parked while nothing is in flight, and the cap still
  // bounds the real number of open connections.
  async _attempt(entry) {
    const made = (this._tries.get(entry.key) || 0) + 1;
    this._tries.set(entry.key, made);
    try {
      if (made > this.maxSessionAttempts) {
        throw new Error(`attempt budget (${this.maxSessionAttempts}) spent`);
      }
      const value = await entry.attempt(made);
      this._active.delete(entry.key);
      entry.resolve(value);
    } catch (e) {
      const err = (e && e.message) ? e : new Error(String(e));
      this._failures.set(entry.key, `${err.message} (try ${made}/${this.attempts})`);
      entry.lastError = err;
      if (made >= this.attempts || made > this.maxSessionAttempts) {
        this._active.delete(entry.key);
        entry.reject(entry.lastError);
      } else {
        this._waiters++;
        Promise.resolve(this.wait(nextBackoffMs(made, this.backoff))).then(() => {
          this._waiters--;
          this._queue.push(entry);
          this._pump();
        });
      }
    } finally {
      this._inflight--;
      this._pump();
    }
  }
}
