// Touch controls. Mirrors the keyboard state object, so the car and HUD never
// learn where an action came from. Pointer Events with pointer capture keep
// steering and throttle independent (multi-touch) and never cancel a press when
// a finger slides across the split.
const MIN_HIT = 72;                 // px, WCAG 2.5.5 minimum target

const STYLE = `
#touch-ui{position:fixed;inset:0;z-index:12;pointer-events:none;
  font:600 15px/1.1 system-ui,sans-serif;touch-action:none;
  opacity:0;transition:opacity .2s;display:none}
#touch-ui.on{display:block;opacity:1}
#touch-ui button{position:absolute;pointer-events:auto;touch-action:none;
  -webkit-tap-highlight-color:transparent;-webkit-user-select:none;user-select:none;
  border:1px solid rgba(255,255,255,.25);border-radius:16px;color:#fff;
  background:rgba(12,16,22,.42);backdrop-filter:blur(3px)}
#touch-ui button.held{background:rgba(255,170,40,.55);border-color:rgba(255,200,90,.8)}
.tg-steer{left:12px;bottom:24px;width:170px;height:110px;border-radius:22px;
  background:rgba(12,16,22,.22);border:1px dashed rgba(255,255,255,.18)}
.tg-arrow{width:82px;height:82px;bottom:38px;font-size:30px;line-height:82px;text-align:center}
.tg-left{left:16px}.tg-right{left:106px}
.tg-pad{right:12px;bottom:24px;width:170px;height:110px;border-radius:22px;
  background:rgba(12,16,22,.22);border:1px dashed rgba(255,255,255,.18)}
.tg-throttle{right:106px;width:76px;height:104px;font-size:34px;line-height:104px;text-align:center}
.tg-brake{right:20px;width:76px;height:104px;font-size:34px;line-height:104px;text-align:center}
.tg-hand{right:12px;bottom:146px;width:170px;height:72px;font-size:14px;letter-spacing:.06em}
.tg-mini{width:72px;height:72px;font-size:13px;letter-spacing:.05em}
.tg-camera{right:182px;bottom:146px}.tg-restart{right:182px;bottom:230px}
@media (orientation:landscape){
.tg-steer{bottom:58px;height:96px}.tg-arrow{bottom:66px;width:78px;height:78px;line-height:78px}
  .tg-pad{right:12px;bottom:78px;height:96px}
  .tg-throttle,.tg-brake{width:74px;height:96px;line-height:96px}
  .tg-hand{bottom:186px;height:58px;width:170px}
  .tg-camera{bottom:186px;right:196px}.tg-restart{bottom:186px;right:276px}
}
@media (max-width:430px){
  .tg-steer,.tg-pad{width:150px}
  .tg-throttle,.tg-brake{width:74px;height:112px;line-height:112px}
  .tg-hand{width:150px;bottom:150px}
  .tg-camera,.tg-restart{right:168px}
}
@media (min-width:1000px) and (pointer:fine){.tg-mini{opacity:.55}}
`;

const TEMPLATE = `
<div class="tg-steer"></div>
<button class="tg-arrow tg-left" data-action="steerLeft" aria-label="Steer left">&#9664;</button>
<button class="tg-arrow tg-right" data-action="steerRight" aria-label="Steer right">&#9654;</button>
<div class="tg-pad"></div>
<button class="tg-throttle" data-action="throttle" aria-label="Throttle">&#9650;</button>
<button class="tg-brake" data-action="brake" aria-label="Brake">&#9660;</button>
<button class="tg-hand" data-action="handbrake" aria-label="Handbrake">HANDBRAKE</button>
<button class="tg-mini tg-camera" data-action="camera" aria-label="Change camera">CAM</button>
<button class="tg-mini tg-restart" data-action="restart" aria-label="Restart stage">RESTART</button>
`;

export function createTouchInput() {
  const actions = { throttle: 0, brake: 0, steerLeft: 0, steerRight: 0, handbrake: 0 };
  return {
    enabled: false, root: null,
    oneshot: [], pointers: new Map(),
    get steer() { return actions.steerRight - actions.steerLeft; },
    isHeld(name) { return actions[name] === 1; },
    releaseAll() { for (const k in actions) actions[k] = 0; this.oneshot.length = 0; },
    setAction(name, on) { actions[name] = on ? 1 : 0; },
    tap(action) { this.oneshot.push(action); },
    drain(action) { const i = this.oneshot.indexOf(action); if (i < 0) return false; this.oneshot.splice(i, 1); return true; },
    attach(target = window) {
      if (!target || typeof target.addEventListener !== 'function') return;
      let live = false;
      const go = () => { if (!live && !this.enabled) this.enable(target); live = true; };
      target.addEventListener('touchstart', go, { once: true, passive: true });
      if (target.matchMedia?.('(pointer: coarse)').matches) go();
      target.addEventListener('rally:touch', go);
      // settings toggle: ?touch=on forces the overlay, ?touch=off suppresses it, else auto-detect
      const want = typeof location !== 'undefined' ? (location.search.match(/[?&]touch=(on|off)/) || [])[1] : null;
      if (want === 'on') go(); else if (want === 'off') live = true;
    },
    enable(target = window) {
      if (this.enabled || typeof document === 'undefined' || !document.body) return;
      this.enabled = true;
      if (!document.getElementById('touch-style')) {
        const st = document.createElement('style'); st.id = 'touch-style'; st.textContent = STYLE;
        document.head.appendChild(st);
      }
      if (!document.querySelector('.safety')) {
        const s = document.createElement('div'); s.className = 'safety';
        s.style.cssText = 'position:fixed;left:0;right:0;bottom:0;height:env(safe-area-inset-bottom,0px);z-index:11;pointer-events:none';
        document.body.appendChild(s);
      }
      const root = document.createElement('div');
      root.id = 'touch-ui'; root.className = 'on';
      root.innerHTML = TEMPLATE;
      document.body.appendChild(root);
      this.root = root;

      const hold = (btn, down) => {
        const action = btn.dataset.action;
        if (!down) { btn.classList.remove('held'); if (action in actions) this.setAction(action, false); return; }
        btn.classList.add('held');
        if (action in actions) {
          this.setAction(action, true);
          const id = this.pointers.get(action);
          if (id != null) btn.setPointerCapture?.(id);
        } else this.tap(action);
      }
      for (const btn of root.querySelectorAll('button')) {
        btn.addEventListener('pointerdown', (e) => {
          e.preventDefault();
          this.pointers.set(btn.dataset.action, e.pointerId);
          hold(btn, true);
        });
        btn.addEventListener('pointerup', () => hold(btn, false));
        btn.addEventListener('pointercancel', () => hold(btn, false));
      }
      // Left-thumb drag zone: a horizontal drag is a steer hold, so it stacks
      // with the right thumb on the throttle.
      const zone = root.querySelector('.tg-steer');
      let zp = null;
      zone.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        zp = e.pointerId; zone.setPointerCapture?.(e.pointerId);
        this.setAction(Math.abs(e.offsetX - zone.clientWidth / 2) < 12 ? 'steerRight'
          : (e.offsetX < zone.clientWidth / 2 ? 'steerLeft' : 'steerRight'), true);
      });
      zone.addEventListener('pointerup', () => { zp = null; this.setAction('steerLeft', false); this.setAction('steerRight', false); });
      zone.addEventListener('pointercancel', () => { zp = null; this.setAction('steerLeft', false); this.setAction('steerRight', false); });
      window.addEventListener('pointerdown', (e) => { if (e.pointerType === 'mouse') this.enabled && root.classList.remove('on'); }, { passive: true });
      document.documentElement.style.touchAction = 'manipulation';
    },
    disable() { this.root?.remove(); this.root = null; this.enabled = false; this.pointers.clear(); },
  };
}
