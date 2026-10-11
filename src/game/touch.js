// Touch controls. Mirrors the keyboard state object, so the car and HUD never
// learn where an action came from. Pointer Events with pointer capture keep
// steering and throttle independent (multi-touch) and never cancel a press when
// a finger slides across the split.
//
// Layout contract (phone landscape = the way this game is played):
//   far left  = ANALOG steering (drag from where the thumb landed),
//   far right = throttle + brake in a thumb arc, handbrake between them & lower,
//   above the steering pad = menu / camera / restart, small.
// That contract is not CSS any more: every pad rect, and the left-handed mirror of
// the whole overlay, is computed in src/game/touch-layout.js and written inline, so
// the suite can prove no pad overlaps another, none leaves the screen, none falls
// under the 72 px minimum target, and left-handed is the exact mirror of right-handed
// (queue P10). Every pad also stays inside the bottom band main.js reserves with
// rally.setTouchInset(input.touch.band()), which is where the HUD lifts the dial, the
// gear readout, the wheel-condition strip, the revs bar and the pace-note boards.
// Every offset carries the env(safe-area-*) inset for the edge it belongs to.
import { drawText, textWidth } from './pixel-font.js';
import { settings } from '../core/settings.js';
import { t } from '../core/i18n.js';
import { padRects, applyPadLayout, parseHandedness, TOUCH_BAND, MIN_HIT } from './touch-layout.js';
export { TOUCH_BAND, MIN_HIT };

export const STEER_DEADZONE = 0.08;  // 8 % of thumb travel is nothing (settings.deadzone)

/**
 * Thumb displacement (-1..1) -> steer command. Dead zone, then a smoothstep so
 * the first centimetres of travel are fine control and full lock only arrives
 * near the rim of the pad — a binary thumb pad is undrivable on dirt.
 */
export function steerCurve(raw, dz = STEER_DEADZONE) {
  const a = Math.max(-1, Math.min(1, raw));
  const s = a < 0 ? -1 : 1, m = Math.abs(a);
  if (m <= dz) return 0;
  const t = (m - dz) / (1 - dz);
  return s * (t * t * (3 - 2 * t));
}

// Same material as the GUI canvas (src/game/hud-rally.js): #C6C6C6 stone buttons with
// a hard outline + inset bevel, oak planks under the thumb zones, the orange accent for
// a held state, oxblood planks for the handbrake. Readability over BOTH bright grass and
// dark asphalt comes from a solid dark 2 px halo around every control (0 0 0 2px), not
// from translucency. No rounded corners, no font: labels are canvases painted with the
// game's own pixel font (pixelLabel below).
//
// NOTHING HERE POSITIONS A PAD. Box geometry (left/bottom/width/height, and the
// handedness mirror) is computed in src/game/touch-layout.js and written as inline
// styles, because a CSS override cannot be verified: no layout engine runs in node, so
// the old `#touch-ui.lefty { transform: scaleX(-1) } + counter-flip` overlay could
// silently overlap, leave the screen or fall under the 72 px target and nothing would
// notice (queue P10, pinned by T43). `--s` is written from the same resolved scale so
// the in-pad parts below stay proportional to the box they live in.
const STYLE = `
#touch-ui{position:fixed;inset:0;z-index:12;pointer-events:none;touch-action:none;
  overscroll-behavior:none;-webkit-touch-callout:none;-webkit-user-select:none;user-select:none;
  opacity:0;transition:opacity .2s;display:none;--s:1}
#touch-ui.on{display:block;opacity:1}
#touch-ui button{position:absolute;pointer-events:auto;touch-action:none;display:flex;
  align-items:center;justify-content:center;padding:0;
  -webkit-tap-highlight-color:transparent;-webkit-user-select:none;user-select:none;
  border:3px solid #14120F;border-radius:0;background:#C6C6C6;
  box-shadow:0 0 0 2px rgba(16,13,10,.9),inset 2px 2px 0 #FDFDFD,inset -2px -2px 0 #555555}
#touch-ui button:active,#touch-ui button.held{background:#C77B2A;border-color:#14120F;
  box-shadow:0 0 0 2px rgba(16,13,10,.9),inset 2px 2px 0 #E0A45C,inset -2px -2px 0 #7A4A18}
#touch-ui button:focus-visible{outline:3px solid #4C6EA0;outline-offset:-6px}
#touch-ui canvas{display:block;image-rendering:pixelated;image-rendering:crisp-edges}
#touch-ui .tg-box{position:absolute}
/* ---- steering: oak plank + analog track + knob that reads the live steer ---- */
#touch-ui .tg-steer{pointer-events:auto;touch-action:none;
  border:3px solid #14120F;background:#9C7E4E
    repeating-linear-gradient(90deg,rgba(0,0,0,0) 0 14px,rgba(58,42,22,.55) 14px 15px);
  box-shadow:0 0 0 2px rgba(16,13,10,.9),inset 2px 2px 0 #B4915C,inset -2px -2px 0 #7A6138}
#touch-ui .tg-steer canvas{position:absolute;left:7px;top:6px}
#touch-ui .tg-track{position:absolute;left:calc(12px*var(--s));right:calc(12px*var(--s));
  bottom:calc(11px*var(--s));height:calc(24px*var(--s));background:#2A2118;border:2px solid #14120F}
#touch-ui .tg-dz{position:absolute;left:50%;top:0;bottom:0;width:calc(15px*var(--s));
  transform:translateX(-50%);background:#6B5335}
#touch-ui .tg-knob{position:absolute;left:50%;top:calc(50% - 24px*var(--s));
  width:calc(48px*var(--s));height:calc(48px*var(--s));margin-left:calc(-24px*var(--s));
  border:3px solid #14120F;background:#C6C6C6;
  box-shadow:0 0 0 2px rgba(16,13,10,.9),inset 2px 2px 0 #FDFDFD,inset -2px -2px 0 #555555}
#touch-ui .tg-knob.on{background:#C77B2A;box-shadow:0 0 0 2px rgba(16,13,10,.9),inset 2px 2px 0 #E0A45C,inset -2px -2px 0 #7A4A18}
/* ---- the handbrake reads as oxblood with a diagonal hatch, wherever it lands ---- */
#touch-ui .tg-hand{background:#8E3A22 repeating-linear-gradient(135deg,rgba(0,0,0,0) 0 9px,rgba(20,12,8,.5) 9px 11px);
  color:#FFF4E2}
#touch-ui .tg-hand.held,#touch-ui .tg-hand:active{background:#C77B2A}
@media (min-width:1000px) and (pointer:fine){#touch-ui{opacity:.6}}
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
  const s = spec.s || 2;
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
// The three utility pads are the 72 px minimum, so their words go at pixel scale 1:
// a <button> clips its content, and 'KAMERA' at scale 2 (72 px) was cut to "AMER".
// The words are i18n KEYS (src/core/i18n.js); pixelLabel gets them resolved at build.
const LABELS = {
  throttle: { icon: 'up' }, brake: { icon: 'down' },
  handbrake: { text: 'touch.handbrake' }, camera: { text: 'touch.camera', s: 1 }, restart: { text: 'touch.restart', s: 1 },
  menu: { text: 'touch.menu', s: 1 },
};

const TEMPLATE = () => `
<div class="tg-box tg-steer" data-zone="skret">
  <div class="tg-track"><div class="tg-dz"></div><div class="tg-knob"></div></div>
</div>
<div class="tg-box tg-cluster">
  <button class="tg-throttle" data-action="throttle" aria-label="${t('touch.aGas')}"></button>
  <button class="tg-brake" data-action="brake" aria-label="${t('touch.aBrake')}"></button>
  <button class="tg-hand" data-action="handbrake" aria-label="${t('touch.aHand')}"></button>
</div>
<div class="tg-box tg-rail">
  <button class="tg-mini tg-menu" data-action="menu" aria-label="${t('touch.aMenu')}"></button>
  <button class="tg-mini tg-camera" data-action="camera" aria-label="${t('touch.aCam')}"></button>
  <button class="tg-mini tg-restart" data-action="restart" aria-label="${t('touch.aRestart')}"></button>
</div>
`;

/**
 * A thumb drag on screen -> a steer command. Screen x grows to the RIGHT while the
 * steer convention is positive = left, so the screen delta is negated here: a thumb
 * dragged left gives a positive (left) steer, the same sign the arrow/pad buttons and
 * the keyboard give.
 */
export function dragToSteer(dxPx, travelPx) {
  const t = Math.max(8, travelPx || 1);
  return Math.max(-1, Math.min(1, -dxPx / t));
}

/** Knob x-offset in px for a steer value: positive (left) steer moves it LEFT (< 0). */
export function knobOffset(steer, half) {
  return -Math.max(-1, Math.min(1, steer || 0)) * half;
}

export function createTouchInput() {
  const actions = { throttle: 0, brake: 0, steerLeft: 0, steerRight: 0, handbrake: 0 };
  return {
    enabled: false, root: null,
    oneshot: [], pointers: new Map(),
    analogSteer: null,       // live analog steer from the thumb (curved), null = no thumb
    steerVisual: 0,          // the value the car actually got -> drives the knob
    layout: null,            // resolved pad rects for the live viewport (touch-layout.js)
    placed: 0,               // DOM boxes the last layout wrote
    handOverride: null,      // ?hand=left|right verification hook, else follow settings
    _raw: 0, _raf: 0,
    // Vehicle convention: POSITIVE steer = a LEFT turn (see car/steering.js: a
    // positive angle turns the front wheels towards body -X, i.e. to the left).
    // This used to be steerRight - steerLeft, which handed a left press -1 and
    // therefore turned the car RIGHT.
    get steer() { return this.analogSteer ?? (actions.steerLeft - actions.steerRight); },
    isHeld(name) { return actions[name] === 1; },
    releaseAll() {
      for (const k in actions) actions[k] = 0;
      this.oneshot.length = 0; this.releaseSteer(); this.steerVisual = 0;
    },
    setAction(name, on) { actions[name] = on ? 1 : 0; },
    tap(action) { this.oneshot.push(action); },
    drain(action) { const i = this.oneshot.indexOf(action); if (i < 0) return false; this.oneshot.splice(i, 1); return true; },
    // ---- geometry: the resolved pad rects for the live viewport (touch-layout.js) ----
    /** px along the bottom the HUD has to keep clear (src/game/hud-rally.js lift). */
    band() { return this.layout ? this.layout.band : TOUCH_BAND; },
    /** env(safe-area-inset-*) read through a throwaway probe: CSS owns those values,
     *  and the layout needs them as numbers. 0 anywhere the browser will not tell us. */
    _safeInsets() {
      const out = { left: 0, right: 0, bottom: 0 };
      if (typeof document === 'undefined' || !document.createElement) return out;
      let probe = null;
      try {
        probe = document.createElement('div');
        probe.style.cssText = 'position:fixed;top:0;left:0;width:0;height:0;visibility:hidden;pointer-events:none;' +
          'padding-left:env(safe-area-inset-left,0px);padding-right:env(safe-area-inset-right,0px);' +
          'padding-bottom:env(safe-area-inset-bottom,0px)';
        document.body.appendChild(probe);
        const cs = getComputedStyle(probe);
        for (const k of ['left', 'right', 'bottom']) out[k] = parseFloat(cs['padding' + k[0].toUpperCase() + k.slice(1)]) || 0;
      } catch { /* headless or unsupported env(): the insets are zero, the layout still fits */ }
      probe?.remove?.();
      return out;
    },
    /** Resolve + apply the whole overlay. Called on enable, on handedness, on resize. */
    _layout() {
      if (!this.root) return null;
      const w = Math.max(1, window.innerWidth || (typeof document !== 'undefined' && document.documentElement?.clientWidth) || 1);
      const h = Math.max(1, window.innerHeight || (typeof document !== 'undefined' && document.documentElement?.clientHeight) || 1);
      const want = this.handOverride || settings.touchHandedness;
      this.layout = padRects({ width: w, height: h, handedness: want, safe: this._safeInsets() });
      this.placed = applyPadLayout(this.root, this.layout);
      return this.layout;
    },
    // ---- analog steering: raw = thumb displacement / travel, -1..1 ----
    setSteerRaw(raw) {
      this._raw = Math.max(-1, Math.min(1, raw || 0));
      this.analogSteer = steerCurve(this._raw, settings.deadzone);
    },
    releaseSteer() { this._raw = 0; this.analogSteer = null; },
    _syncKnob() {
      const knob = this._knob, track = this._track;
      if (!knob || !track) return;
      const half = Math.max(8, (track.clientWidth - knob.offsetWidth) / 2);
      const v = Math.max(-1, Math.min(1, this.steerVisual || 0));
      knob.style.transform = `translateX(${knobOffset(v, half).toFixed(1)}px)`;
      if (v !== 0) knob.classList.add('on'); else knob.classList.remove('on');
    },
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
      // ?hand=left|right: the verification hook for the mirrored overlay (same family
      // as ?touch= / ?steer=), so a headless shot can show the left-handed layout.
      const hand = typeof location !== 'undefined' ? parseHandedness(location.search) : null;
      if (hand) this.handOverride = hand;
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
        s.draggable = false; s.setAttribute('unselectable', 'on');
        s.style.cssText = 'position:fixed;left:0;right:0;bottom:0;height:env(safe-area-inset-bottom,0px);z-index:11;pointer-events:none';
        document.body.appendChild(s);
      }
      // Long-press selection / the copy popup / the context menu: a thumb parked on a
      // pad for two seconds used to raise them. Killed on the canvas, on the overlay
      // and on the body, plus selectstart at the document (the root element is what
      // offers the selection, so the CSS on the children alone does not help).
      const swallowMenu = (e) => { e.preventDefault(); return false; };
      for (const t of [document.body, document.getElementById('c')]) t?.addEventListener('contextmenu', swallowMenu, { passive: false });
      document.addEventListener('selectstart', (e) => {
        if (e.target?.closest?.('input,textarea')) return;
        e.preventDefault(); return false;
      }, { passive: false });
      document.body.addEventListener('selectstart', swallowMenu, { passive: false });
      const root = document.createElement('div');
      root.id = 'touch-ui'; root.className = 'on';
      root.innerHTML = TEMPLATE();
      document.body.appendChild(root);
      this.root = root;
      // Labels are painted, not typeset: no system/mono font anywhere in the overlay.
      root.draggable = false; root.setAttribute('unselectable', 'on');
      root.addEventListener('contextmenu', swallowMenu, { passive: false });
      root.addEventListener('selectstart', swallowMenu, { passive: false });
      for (const btn of root.querySelectorAll('button')) {
        btn.draggable = false; btn.setAttribute('unselectable', 'on');
        btn.addEventListener('contextmenu', (e) => e.preventDefault());
        const spec = LABELS[btn.dataset.action];
        if (spec) pixelLabel(btn, spec.text ? { ...spec, text: t(spec.text) } : spec, spec.icon ? '#1E1E1E' : '#1E1E1E');
      }
      pixelLabel(root.querySelector('.tg-steer'), { text: t('touch.steer') }, '#2A2118');
      this._track = root.querySelector('.tg-track');
      this._knob = root.querySelector('.tg-knob');
      this.setHandedness(this.handOverride || settings.touchHandedness);
      if (!this._onResize) {
        this._onResize = () => { if (this.root) this._layout(); };
        window.addEventListener('resize', this._onResize);
        window.addEventListener('orientationchange', this._onResize);
      }
      // Verification hook: ?steer=<-1..1> pins an analog thumb value so the knob
      // position (requirement: the pad must show the current steer) is checkable in a
      // headless shot without faking a finger. Never set in normal play.
      const sv = typeof location !== 'undefined' ? (location.search.match(/[?&]steer=(-?[\d.]+)/) || [])[1] : null;
      if (sv != null && sv !== '') this.analogSteer = steerCurve(Number(sv) || 0, settings.deadzone);

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
      // Left-thumb analog steering: the thumb can land anywhere on the plank, the
      // steer value is its displacement from THAT landing point, and capture keeps
      // it alive while the right thumb works the throttle.
      const zone = root.querySelector('.tg-steer');
      let zp = null, originX = 0, travel = 80;
      zone.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        zp = e.pointerId; originX = e.clientX; zone.setPointerCapture?.(e.pointerId);
        const half = Math.max(8, (this._track.clientWidth - this._knob.offsetWidth) / 2);
        travel = half;
        this.setSteerRaw(0);
      });
      zone.addEventListener('pointermove', (e) => {
        if (zp !== null && e.pointerId === zp) this.setSteerRaw(dragToSteer(e.clientX - originX, travel));
      });
      const lift = (e) => { if (zp === null || e.pointerId === zp) { zp = null; this.releaseSteer(); } };
      zone.addEventListener('pointerup', lift);
      zone.addEventListener('pointercancel', lift);
      window.addEventListener('pointerdown', (e) => { if (e.pointerType === 'mouse') this.enabled && root.classList.remove('on'); }, { passive: true });
      // ---- page zoom / pan lockdown (phone) ------------------------------------
      // CSS on the overlay is not enough: iOS still fires gesturestart/gesturechange for a
      // pinch that begins on the canvas, and Chrome Android still honours double-tap zoom.
      // So the gestures are swallowed at the document level as well, and the canvas and the
      // overlay controls both preventDefault their touchstart/pointerdown.
      const lock = document.documentElement.style;
      lock.touchAction = 'none'; lock.overscrollBehavior = 'none'; lock.height = '100%';
      if (document.body) {
        document.body.style.touchAction = 'none';
        document.body.style.overscrollBehavior = 'none';
        document.body.style.position = 'fixed';   // height lock: the page cannot scroll
        document.body.style.inset = '0';
        document.body.style.height = '100%';
        document.body.style.overflow = 'hidden';
      }
      const swallow = (e) => { e.preventDefault(); return false; };
      root.addEventListener('touchstart', swallow, { passive: false });
      const canvas = document.getElementById('c');
      canvas?.addEventListener('touchstart', swallow, { passive: false });
      canvas?.addEventListener('pointerdown', (e) => { if (e.pointerType !== 'mouse') e.preventDefault(); }, { passive: false });
      if (!this._gestureLock) {          // window-level: installed once per session
        this._gestureLock = true;
        for (const g of ['gesturestart', 'gesturechange', 'gestureend']) {
          document.addEventListener(g, swallow, { passive: false });
        }
        // Double tap is an IN-GAME action (camera, the same one as the tg-camera pad),
        // never a page zoom; dblclick is swallowed so it cannot zoom either.
        let lastTap = 0, lastX = 0, lastY = 0;
        const dbl = (e) => {
          e.preventDefault();
          const now = performance.now();
          const x = e.clientX || 0, y = e.clientY || 0;
          if (now - lastTap < 320 && Math.hypot(x - lastX, y - lastY) < 32) this.tap('camera');
          lastTap = now; lastX = x; lastY = y;
        };
        document.addEventListener('dblclick', (e) => e.preventDefault(), { passive: false });
        document.addEventListener('pointerup', (e) => {
          if (e.pointerType === 'mouse' || !this.enabled || !this.root) return;
          if (e.target?.closest?.('#touch-ui')) return;   // pads have their own handlers
          dbl(e);
        }, { passive: false });
      }
      // The knob follows the steer the CAR got, so it visibly self-centres.
      if (typeof requestAnimationFrame === 'function') {
        const tick = () => { if (!this.root) return; this._syncKnob(); this._raf = requestAnimationFrame(tick); };
        this._raf = requestAnimationFrame(tick);
      }
    },
    setHandedness(h) {
      this.handOverride = (h === 'left' || h === 'right') ? h : null;
      if (!this.root) return;
      // Not a class toggle any more: the rects themselves are mirrored, so the hit
      // areas, the visuals and the suite all agree on one geometry.
      this.root.classList.toggle('lefty', (this.handOverride || settings.touchHandedness) === 'left');
      this._layout();
    },
    disable() {
      if (this._raf && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(this._raf);
      this._raf = 0;
      this.root?.remove(); this.root = null; this.enabled = false; this.pointers.clear();
      this._knob = this._track = null; this.layout = null; this.placed = 0;
    },
    /** Hide the pads while a menu modal owns the screen (main.js screen stack). */
    setVisible(on) {
      if (!this.root) return;
      this.root.style.display = on ? '' : 'none';
      if (!on) this.releaseAll();
    },
  };
}
