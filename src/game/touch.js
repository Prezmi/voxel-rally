// Touch controls. Mirrors the keyboard state object, so the car and HUD never
// learn where an action came from. Pointer Events with pointer capture keep
// steering and throttle independent (multi-touch) and never cancel a press when
// a finger slides across the split.
import { drawText, textWidth } from './pixel-font.js';
const MIN_HIT = 72;                 // px, WCAG 2.5.5 minimum target

// Same material as the GUI canvas (src/game/hud-rally.js): #C6C6C6 stone buttons with
// a 2 px #1E1E1E outline and a hard inset bevel, oak planks under the thumb zones, and
// the orange accent for a held state. No translucency, no rounded corners, no font:
// every label is a canvas painted with the game's own pixel font (pixelLabel below).
const STYLE = `
#touch-ui{position:fixed;inset:0;z-index:12;pointer-events:none;
  touch-action:none;opacity:0;transition:opacity .2s;display:none}
#touch-ui.on{display:block;opacity:1}
#touch-ui button{position:absolute;pointer-events:auto;touch-action:none;display:flex;
  align-items:center;justify-content:center;padding:0;
  -webkit-tap-highlight-color:transparent;-webkit-user-select:none;user-select:none;
  border:2px solid #1E1E1E;border-radius:0;background:#C6C6C6;
  box-shadow:inset 2px 2px 0 #FDFDFD,inset -2px -2px 0 #555555}
#touch-ui button:active,#touch-ui button.held{background:#C77B2A;border-color:#1E1E1E;
  box-shadow:inset 2px 2px 0 #E0A45C,inset -2px -2px 0 #7A4A18}
#touch-ui button:focus-visible{outline:3px solid #4C6EA0;outline-offset:-5px}
#touch-ui canvas{display:block;image-rendering:pixelated;image-rendering:crisp-edges}
#touch-ui .tg-zone{position:absolute;border:3px solid #1E1E1E;border-radius:0;
  background:#9C7E4E repeating-linear-gradient(90deg,rgba(0,0,0,0) 0 14px,rgba(58,42,22,.55) 14px 15px);
  box-shadow:inset 2px 2px 0 #B4915C,inset -2px -2px 0 #7A6138}
#touch-ui .tg-zone canvas{position:absolute;left:6px;top:5px}
.tg-steer{left:12px;bottom:24px;width:170px;height:110px}
.tg-arrow{width:82px;height:82px;bottom:38px}
.tg-left{left:16px}.tg-right{left:106px}
.tg-pad{right:12px;bottom:24px;width:170px;height:110px}
.tg-throttle{right:106px;width:76px;height:104px}
.tg-brake{right:20px;width:76px;height:104px}
.tg-hand{right:12px;bottom:146px;width:170px;height:72px}
.tg-mini{width:72px;height:72px}
.tg-camera{right:182px;bottom:146px}.tg-restart{right:182px;bottom:230px}
@media (orientation:landscape){
.tg-steer{bottom:58px;height:96px}.tg-arrow{bottom:66px;width:78px;height:78px}
  .tg-pad{right:12px;bottom:78px;height:96px}
  .tg-throttle,.tg-brake{width:74px;height:96px}
  .tg-hand{bottom:186px;height:58px;width:170px}
  .tg-camera{bottom:186px;right:196px}.tg-restart{bottom:186px;right:276px}
}
@media (max-width:430px){
  .tg-steer,.tg-pad{width:150px}
  .tg-throttle,.tg-brake{width:74px;height:112px}
  .tg-hand{width:150px;bottom:150px}
  .tg-camera,.tg-restart{right:168px}
}
@media (min-width:1000px) and (pointer:fine){.tg-mini{opacity:.55}}
`;

// Chunky 9x5 pixel arrows: the pad glyphs are the same 5x7 grid family as the font, so
// the overlay and the GUI are not two different alphabets.
const ARROW_UP = ['000010000', '000111000', '001111100', '011111110', '111111111'];
function drawArrow(g, dir, s, color) {
  const rows = (dir === 'down') ? ARROW_UP.slice().reverse() : ARROW_UP;
  g.fillStyle = color;
  for (let r = 0; r < rows.length; r++) {
    for (let c = 0; c < 9; c++) {
      if (rows[r][c] !== '1') continue;
      if (dir === 'left' || dir === 'right') {
        const col = dir === 'right' ? (rows.length - 1 - r) : r;
        g.fillRect(col * s, c * s, s, s);
      } else g.fillRect(c * s, r * s, s, s);
    }
  }
}
/** Pixel-font label (or arrow) painted into a canvas the button centres. */
function pixelLabel(host, spec, color) {
  if (!host || typeof document === 'undefined' || !document.createElement) return;
  const s = 2;
  const cv = document.createElement('canvas');
  if (!cv.setAttribute) return;
  const w = spec.icon ? 9 * s : textWidth(spec.text, s);
  cv.width = w; cv.height = 7 * s;
  const g = cv.getContext && cv.getContext('2d');
  if (!g) return;
  g.imageSmoothingEnabled = false;
  if (spec.icon) drawArrow(g, spec.icon, s, color);
  else drawText(g, spec.text, 0, 0, s, color);
  host.appendChild(cv);
}
const LABELS = {
  steerLeft: { icon: 'left' }, steerRight: { icon: 'right' },
  throttle: { icon: 'up' }, brake: { icon: 'down' },
  handbrake: { text: 'RĘCZNY' }, camera: { text: 'KAMERA' }, restart: { text: 'RESET' },
};

const TEMPLATE = `
<div class="tg-zone tg-steer" data-zone="skret"></div>
<button class="tg-arrow tg-left" data-action="steerLeft" aria-label="Skręt w lewo"></button>
<button class="tg-arrow tg-right" data-action="steerRight" aria-label="Skręt w prawo"></button>
<div class="tg-zone tg-pad" data-zone="gaz"></div>
<button class="tg-throttle" data-action="throttle" aria-label="Gaz"></button>
<button class="tg-brake" data-action="brake" aria-label="Hamulec"></button>
<button class="tg-hand" data-action="handbrake" aria-label="Hamulec ręczny"></button>
<button class="tg-mini tg-camera" data-action="camera" aria-label="Zmień kamerę"></button>
<button class="tg-mini tg-restart" data-action="restart" aria-label="Restart odcinka"></button>
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
      // Labels are painted, not typeset: no system/mono font anywhere in the overlay.
      for (const btn of root.querySelectorAll('button')) {
        const spec = LABELS[btn.dataset.action];
        if (spec) pixelLabel(btn, spec, spec.icon ? '#1E1E1E' : '#1E1E1E');
      }
      for (const zone of root.querySelectorAll('.tg-zone')) {
        pixelLabel(zone, { text: zone.dataset.zone }, '#2A2118');
      }

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
      const zone = root.querySelector('.tg-steer');      let zp = null;
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
    /** Hide the pads while a menu modal owns the screen (main.js screen stack). */
    setVisible(on) {
      if (!this.root) return;
      this.root.style.display = on ? '' : 'none';
      if (!on) this.releaseAll();
    },
  };
}
