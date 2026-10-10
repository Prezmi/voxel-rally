// Input (docs/06 §5). Binary keys become analog: the steering ramps over
// settings.steerRampMs so the car never gets a step input it cannot follow.
// The state object is plain data, so the same code path runs headless in tests.
import { settings } from '../core/settings.js';
import { clamp } from '../core/math3.js';
import { createTouchInput } from './touch.js';

const KEYMAP = {
  KeyW: 'throttle', ArrowUp: 'throttle',
  KeyS: 'brake', ArrowDown: 'brake',
  KeyA: 'steerLeft', ArrowLeft: 'steerLeft',
  KeyD: 'steerRight', ArrowRight: 'steerRight',
  Space: 'handbrake',
  KeyQ: 'shiftDown', KeyE: 'shiftUp',
};

// Pads that are a tap, not a hold: the same consumer path as the keyboard key.
// 'menu' is the touch-only way out of the stage (pause -> menu -> START resumes).
const TOUCH_TAPS = [['camera', 'KeyC'], ['restart', 'KeyR'], ['menu', 'KeyP']];

export class Input {
  constructor() {
    this.state = { throttle: 0, brake: 0, steer: 0, handbrake: 0, shiftUp: 0, shiftDown: 0 };
    this.down = new Set();
    this.oneShot = new Set();
    this.steerVel = 0;          // ramped steering
    this._shiftUp = 0;
    this._shiftDown = 0;
    this.consumers = [];        // (action) => void, for pause/reset/camera keys
    this.touch = createTouchInput();  // touch mirrors the same action state
  }

  attach(target = window) {
    target.addEventListener('keydown', (e) => this._key(e, true));
    target.addEventListener('keyup', (e) => this._key(e, false));
    target.addEventListener('blur', () => this.down.clear());
    this.touch.attach(target);
    return this;
  }

  on(fn) { this.consumers.push(fn); return this; }

  _key(e, isDown) {
    const code = e.code;
    if (KEYMAP[code]) {
      if (isDown) this.down.add(KEYMAP[code]); else this.down.delete(KEYMAP[code]);
      e.preventDefault();
      return;
    }
    if (isDown && !this.down.has(code)) {
      this.down.add(code);
      this.oneShot.add(code);
      for (const fn of this.consumers) fn(code);
    } else if (!isDown) {
      this.down.delete(code);
    }
    if (KEYMAP[code] || ['Escape', 'KeyP', 'KeyR', 'KeyC', 'KeyH', 'KeyF1', 'KeyF2', 'KeyF3'].includes(code)) e.preventDefault();
  }

  consumeTap(code) {
    if (!this.oneShot.has(code)) return false;
    this.oneShot.delete(code);
    return true;
  }

  /** dt is the *sim* step so the ramp is deterministic. */
  sample(dt) {
    const s = this.state;
    const t = this.touch;
    const held = (a) => this.down.has(a) || (t.enabled && t.isHeld(a));
    s.throttle = held('throttle') ? 1 : 0;
    s.brake = held('brake') ? 1 : 0;
    s.handbrake = held('handbrake') ? 1 : 0;
    // Two thumbs on one pedal: braking always wins, the pedals never fight.
    if (s.brake > 0) s.throttle = 0;

    // Touch buttons for camera/restart feed the same consumer path as KeyC/KeyR.
    for (const [name, code] of TOUCH_TAPS) if (t.drain(name)) for (const fn of this.consumers) fn(code);

    // The thumb pad is analog (continuous, deadzoned, curved in touch.js); the
    // keyboard and the pad axes stay binary and ramp below.
    const analog = (t.enabled && typeof t.analogSteer === 'number') ? t.analogSteer : null;
    // Vehicle convention: POSITIVE steer = LEFT. Keyboard left therefore has to be
    // the +1 term (it used to be the minus term, which steered the car right).
    const want = analog !== null
      ? clamp(analog, -1, 1)
      : clamp((held('steerLeft') ? 1 : 0) - (held('steerRight') ? 1 : 0), -1, 1);
    if (settings.keyboardAsPad) {
      // First-order ramp: the same response a wheel with a real rate limit gives.
      const rate = 1000 / Math.max(20, settings.steerRampMs);
      const d = want - s.steer;
      const step = Math.sign(d) * Math.min(Math.abs(d), rate * dt);
      s.steer += step;
      if (Math.abs(s.steer) < settings.deadzone && want === 0) s.steer = 0;
    } else {
      s.steer = want;
    }
    if (settings.invertSteer) s.steer = -s.steer;
    t.steerVisual = s.steer;   // the pad knob shows the value the car got

    s.shiftUp = this._shiftUp; this._shiftUp = 0;
    s.shiftDown = this._shiftDown; this._shiftDown = 0;
    return s;
  }

  tapShift(dir) {
    if (dir > 0) this._shiftUp++; else this._shiftDown++;
  }

  releaseAll() { this.down.clear(); this.touch.releaseAll(); this.state.steer = 0; }
}
