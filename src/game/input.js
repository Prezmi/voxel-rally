// Keyboard + touch input. Exposes a polled driving state each frame and
// an edge-trigger set the game loop consumes (pause, camera, reset...).

const KEYMAP = {
  ArrowUp: 'up', KeyW: 'up',
  ArrowDown: 'down', KeyS: 'down',
  ArrowLeft: 'left', KeyA: 'left',
  ArrowRight: 'right', KeyD: 'right',
  Space: 'handbrake',
};

export class Input {
  constructor() {
    this.held = new Set();
    this.touch = { up: false, down: false, left: false, right: false, handbrake: false };
    this.justPressed = new Set();
    window.addEventListener('keydown', (e) => {
      if (e.code === 'Space' || e.code.startsWith('Arrow')) e.preventDefault();
      if (!e.repeat) this.justPressed.add(e.code);
      const k = KEYMAP[e.code];
      if (k) this.held.add(k);
      if (e.code === 'KeyR') this.justPressed.add('reset');
      if (e.code === 'KeyC') this.justPressed.add('camera');
      if (e.code === 'Escape') this.justPressed.add('pause');
      if (e.code === 'KeyM') this.justPressed.add('mute');
      if (e.code === 'Enter') this.justPressed.add('confirm');
    });
    window.addEventListener('keyup', (e) => {
      const k = KEYMAP[e.code];
      if (k) this.held.delete(k);
    });
    window.addEventListener('blur', () => this.held.clear());
  }

  pressed(name) {
    return this.justPressed.has(name);
  }

  postFrame() {
    this.justPressed.clear();
  }

  // Steering eases toward the target so taps do not snap the wheel.
  poll(dt, steerState) {
    const left = this.held.has('left') || this.touch.left;
    const right = this.held.has('right') || this.touch.right;
    const target = (left ? -1 : 0) + (right ? 1 : 0);
    const rate = target !== 0 ? 6.5 : 9;
    let s = steerState.value;
    s += (target - s) * Math.min(1, dt * rate);
    if (Math.abs(s) < 0.002 && target === 0) s = 0;
    steerState.value = s;
    return {
      throttle: (this.held.has('up') || this.touch.up) ? 1 : 0,
      brake: (this.held.has('down') || this.touch.down) ? 1 : 0,
      steer: s,
      handbrake: this.held.has('handbrake') || this.touch.handbrake,
    };
  }

  bindTouchButton(el, name) {
    if (!el) return;
    const on = (e) => { e.preventDefault(); this.touch[name] = true; el.classList.add('on'); };
    const off = (e) => { e.preventDefault(); this.touch[name] = false; el.classList.remove('on'); };
    el.addEventListener('pointerdown', on);
    el.addEventListener('pointerup', off);
    el.addEventListener('pointerleave', off);
    el.addEventListener('pointercancel', off);
  }
}
