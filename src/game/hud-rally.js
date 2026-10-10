// Rally HUD — Colin McRae Rally OBJECT SET, Minecraft VISUAL LANGUAGE (PLAN.md §10 + §10.1).
//
// Object mapping (CMR manual -> what is drawn here):
//   co-driver signs            -> wooden oak-sign boards with a blocky bend arrow, a big
//                                severity digit, the Polish word and metres counting down
//   revs                       -> hotbar-like row of slots filling left->right, red near
//                                the limit, an over-full MAX GAZ segment
//   gear / max throttle        -> its own item slot + the over-full rev segment
//   speed                      -> blocky dial + big pixel digits
//   water / oil / turbo        -> three item slots with a block fill level (the states this
//                                game actually simulates: engine, front axle, rear axle)
//   damage as broken parts     -> four slots per corner, fill = health, cracked pattern
//   stage progress + car mark  -> Minecraft locator bar: sign blocks per checkpoint,
//                                blocky car tick, active sector lit
//   time + split + limit       -> small stone panel, top-left, pixel digits
//                                (split negative = ahead = green)
//   per-wheel state            -> four slots: green grip / orange slide / red lock / blue air
//
// Everything is drawn into ONE canvas with integer coordinates and integer sizes, nearest
// neighbour only: no gradients, no blur, no rounded corners, no CSS filter, no alpha tricks,
// no system font (src/game/pixel-font.js). Panels are re-drawn only when a value changes,
// the canvas and every sprite/geometry buffer are built once, nothing is allocated per frame.
import { bus } from '../core/events.js';
import { formatSplit, formatTime } from './timing.js';
import { STATE } from './stage.js';
import { settings } from '../core/settings.js';
import { drawText, textWidth } from './pixel-font.js';
import { drawSignBoard, signMetrics, bendKind, signWord } from './sign-board.js';
import { selectNotes } from './pace-notes.js';

const RAD2DEG = 180 / Math.PI;
const DIAL_MAX = 200;          // km/h at the end of the dial sweep (face labels i*10)
const WHEEL_LABELS = ['PRZ L', 'PRZ P', 'TYŁ L', 'TYŁ P'];
const MODES = ['FULL', 'MINIMAL', 'OFF'];

// Vanilla GUI palette (PLAN.md §10.1): grey family + three state accents + wood.
const C = {
  OUT: '#1E1E1E', PANEL: '#C6C6C6', SLOT: '#8B8B8B',
  LIGHT: '#FDFDFD', DARK: '#555555', TEXT: '#1E1E1E', WHITE: '#FDFDFD',
  GREEN: '#2E8B2E', RED: '#B4382E', ORANGE: '#C77B2A', BLUE: '#4C6EA0',
};
const MODE_LABEL = { FULL: 'pełny', MINIMAL: 'minimalny', OFF: 'wyłączony' };
const QUAL_LABEL = { 0: 'niska', 1: 'średnia', 2: 'wysoka' };
const TOUCH_LABEL = { auto: 'auto', on: 'włączone', off: 'wyłączone' };
// Ekrany menu (modalne). Górny ekran stosu decyduje, czy zegar odcinka w ogóle
// idzie - patrz RallyHud.driving(), dzięki temu auto nie jedzie przed STARTem.
const MENU_SCREENS = ['menu', 'settings', 'controls'];
// Oak tones of the pace-note boards (sign-board.js), repeated here so the modal
// framing and the sign language are the same material without a cross-import.
const WOOD = '#9C7E4E', WOOD_LIGHT = '#B4915C', WOOD_DARK = '#7A6138';
// Width of the oak band that frames every modal screen (menu, ustawienia, sterowanie,
// countdown, wynik) - same plank language as the pace-note boards.
const MODAL_FRAME = 6;

/** 1 px near-black outline + 3 px raised bevel (light top/left, dark bottom/right). */
function frameRect(g, x, y, w, h, body, raised) {
  g.fillStyle = C.OUT; g.fillRect(x, y, w, h);
  g.fillStyle = body; g.fillRect(x + 1, y + 1, w - 2, h - 2);
  const lit = raised ? C.LIGHT : C.DARK, dim = raised ? C.DARK : C.LIGHT;
  g.fillStyle = lit;
  g.fillRect(x + 1, y + 1, w - 2, 3);
  g.fillRect(x + 1, y + 1, 3, h - 2);
  g.fillStyle = dim;
  g.fillRect(x + 1, y + h - 3, w - 2, 2);
  g.fillRect(x + w - 3, y + 1, 2, h - 2);
}
/** Item slot: recessed interior (dark top/left, light bottom/right). */
function slotRect(g, x, y, w, h) { frameRect(g, x, y, w, h, C.SLOT, false); }
/** Block fill inside a slot: whole blocks, `frac` of the columns, optional crack pixels. */
function slotFill(g, x, y, w, h, frac, color, crack) {
  const iw = w - 6, ih = h - 6;
  const n = Math.max(0, Math.min(iw, Math.round(frac * iw)));
  g.fillStyle = color;
  if (n > 0) g.fillRect(x + 3, y + h - 3 - ih, n, ih);
  if (crack) {                       // dark 1 px cracks instead of a smooth "warning"
    g.fillStyle = C.OUT;
    for (let i = 0; i < CRACK.length; i++) {
      const k = CRACK[i];
      if (k[0] > n - 1) continue;
      g.fillRect(x + 3 + k[0], y + h - 3 - ih + k[1], 1, 1);
    }
  }
}
const CRACK = [[1, 1], [2, 3], [3, 2], [4, 5], [6, 4], [7, 6], [9, 2], [10, 7], [12, 5]];

export class RallyHud {
  /** `doc` is a document-like object so tools/stagetest.mjs can run the HUD headless;
   *  with a stub DOM there is no canvas and the class only runs its value mirrors. */
  constructor(doc, opts = {}) {
    this.doc = doc;
    this.bus = opts.bus || bus;
    this.mode = settings.hudMode || 'FULL';
    this.arrows = settings.showCoDriverArrows !== false;
    this._root = doc.getElementById('rally') || doc.createElement('div');
    this._root.className = 'rally mode-' + this.mode.toLowerCase();
    if (!this._root.parentNode && doc.body) doc.body.appendChild(this._root);

    this.cv = doc.createElement('canvas');
    this.cv.className = 'rly-canvas';
    if (this.cv.setAttribute) { this.cv.width = 2; this.cv.height = 2; }
    this._root.appendChild(this.cv);
    this.g = this.cv.getContext ? this.cv.getContext('2d') : null;

    // Modal is DOM (it owns keyboard/gamepad focus) but its visible text is drawn on the
    // canvas in the pixel font; the DOM rows are the focus targets.
    this.modal = doc.createElement('div');
    this.modal.className = 'rly-modal';
    this._root.appendChild(this.modal);
    this.menu = [];
    this._rows = [];
    this._bigTitle = '';
    this.stages = opts.stages || [];
    this.stageIdx = 0;
    this.touchInset = 0;        // CSS px the touch overlay reserves along the bottom
    this.menuItems = [];
    for (let i = 0; i < 8; i++) {
      const el = doc.createElement('div');
      el.className = 'menu-item off';
      if (el.setAttribute) el.setAttribute('role', 'button');
      if (el.addEventListener) {
        el.addEventListener('pointerdown', (e) => {
          if (e && e.preventDefault) e.preventDefault();
          if (i >= this._rows.length) return;
          this.focus = i;
          this._syncFocus();
          this.pendingActivate = true;      // same path as ENTER / pad A
        });
      }
      this.modal.appendChild(el);
      this.menuItems.push(el);
    }
    this.focus = 0;

    // Mirror of the four wheel states (screen readers + tools/stagetest.mjs C3 audit).
    this.gauges = [];
    for (let i = 0; i < 4; i++) this.gauges.push({ val: { textContent: '' } });

    this.stack = ['hud'];
    this._modalOpen = false;
    this._dirtyAll = true;
    this._keys = {};
    this._acc = 0; this._accGauge = 0; this._accSign = 0; this._accSlow = 0; this._accWheel = 0;
    this._events = { checkpoints: [], penalties: [], result: null, countdown: -1 };
    this._padPrev = [false, false, false, false];
    this._popFrames = [0, 0, 0, 0];   // 2-frame board pop (hard steps, no easing)
    this._wheelCol = ['', '', '', ''];
    this._wheelLabel = ['', '', '', ''];
    this._signKey = ['', '', '', ''];
    this._modalText = ['', '', ''];
    this._info = [];              // [klawisz, akcja] pairs drawn on the sterowanie screen
    this._menuRect = [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]];
    this.pendingActivate = false;
    this._subscribe();
    this._resize();
    if (typeof window !== 'undefined' && window.addEventListener) {
      window.addEventListener('resize', () => this._resize());
    }
  }

  // ---------- canvas geometry: integer buffer, whole-integer upscale ----------
  _safeInsets() {
    const probe = this.doc.getElementById ? this.doc.getElementById('rly-safe') : null;
    if (!probe || typeof getComputedStyle !== 'function') return [0, 0, 0, 0];
    const s = getComputedStyle(probe);
    const px = (v) => { const n = parseFloat(v); return n > 0 ? n : 0; };
    return [px(s.paddingTop), px(s.paddingRight), px(s.paddingBottom), px(s.paddingLeft)];
  }
  _resize() {
    if (!this.g) return;
    const vw = (typeof window !== 'undefined' && window.innerWidth) || 640;
    const vh = (typeof window !== 'undefined' && window.innerHeight) || 360;
    // UI scale = whole pixels per logical GUI pixel (Minecraft GUI scale), never fractional.
    this.uiScale = Math.max(1, Math.min(4, Math.round(Math.min(vw, vh) / 300)));
    const W = Math.max(240, Math.round(vw / this.uiScale));
    const H = Math.max(160, Math.round(vh / this.uiScale));
    this.cv.width = W; this.cv.height = H;
    this.g = this.cv.getContext('2d');
    this.g.imageSmoothingEnabled = false;
    const s = this._safeInsets();
    this.W = W; this.H = H;
    const m = 4 + Math.round(s[3] / this.uiScale);
    // The touch pads live in the two bottom corners; lift every bottom-anchored panel
    // above them so the dial / revs / damage never sit under a thumb.
    const lift = Math.round((this.touchInset || 0) / this.uiScale);
    const M = {
      x: m, y: 4 + Math.round(s[0] / this.uiScale),
      r: W - m - Math.round(s[1] / this.uiScale),
      b: H - 4 - Math.round(s[2] / this.uiScale) - lift,
    };
    this.M = M;
    const wide = W >= 560;
    this.L = {
      meta: { x: M.x, y: M.y, w: Math.min(200, textWidth(this._stageName || 'ODCINEK', 1) + 10), h: 13 },
      signs: { x: M.x + Math.min(200, textWidth(this._stageName || 'ODCINEK', 1) + 14), y: M.y, w: 0, h: 34 },
      time: { x: M.x, y: M.y + 40, w: 96, h: 33 },
      prog: { x: M.x, y: M.y + 92, w: Math.min(210, Math.max(120, Math.round(W * 0.32))), h: 26 },
      dial: { x: M.r - 72, y: M.b - 4 - 22 - 4 - 72, w: 72, h: 72 },
      speed: { x: M.r - 72 - 6 - 62, y: M.b - 4 - 22 - 4 - 40, w: 62, h: 40 },
      states: { x: M.r - 114, y: M.b - 26, w: 114, h: 22 },
      revs: { x: M.x, y: M.b - 16, w: 134, h: 16 },
      wheels: { x: M.x, y: M.b - 50, w: 132, h: 22 },
      damage: { x: M.x, y: M.b - 84, w: 132, h: 30 },
      wide,
    };
    this._buildDialFace();
    this._dirtyAll = true;
    for (const k in this._keys) this._keys[k] = '';
    this._syncFocus();
  }

  // ---------- static dial face: a ring of tick BLOCKS, built once ----------
  _buildDialFace() {
    const L = this.L.dial;
    if (!this.g || !L) return;
    const face = this.doc.createElement('canvas');
    face.width = L.w; face.height = L.h;
    const g = face.getContext('2d');
    if (!g) return;
    g.imageSmoothingEnabled = false;
    frameRect(g, 0, 0, L.w, L.h, C.PANEL, true);
    const cx = 36, cy = 40, START = 135, SWEEP = 270;
    this._dialGeo = { cx, cy, START, SWEEP, red: [] };
    for (let i = 0; i <= 20; i++) {                       // one tick block group / 10 km/h
      const a = (START + (i / 20) * SWEEP) * Math.PI / 180;
      const major = i % 5 === 0;
      const r0 = major ? 20 : 24, r1 = 30;
      const hot = i >= 17;                                 // redline arc
      for (let r = r0; r <= r1; r += 2) {
        const x = Math.round(cx + Math.cos(a) * r), y = Math.round(cy + Math.sin(a) * r);
        if (hot) this._dialGeo.red.push([x - 1, y - 1, 2, 2]);
        else { g.fillStyle = C.OUT; g.fillRect(x - 1, y - 1, 2, 2); }
      }
      if (major) {
        const x = Math.round(cx + Math.cos(a) * 14), y = Math.round(cy + Math.sin(a) * 14);
        drawText(g, String(i * 10), x - 7, y - 3, 1, C.TEXT);
      }
    }
    g.fillStyle = C.OUT; g.fillRect(cx - 3, cy - 3, 6, 6);   // hub
    for (const r of this._dialGeo.red) { g.fillStyle = C.RED; g.fillRect(r[0], r[1], r[2], r[3]); }
    this._dialFace = face;
  }

  // ---------- event-driven state (skills/game-ui-ux #6) ----------
  _subscribe() {
    const ev = this._events;
    this.bus.on('countdown', (p) => { ev.countdown = p.value; });
    this.bus.on('start', () => { ev.countdown = 0; this._pop('countdown'); this._keys.sectors = ''; });
    this.bus.on('checkpoint', () => { this._keys.sectors = ''; this._keys.prog = ''; });
    this.bus.on('penalty', (p) => { ev.penalties.push(p); this._keys.limit = ''; });
    this.bus.on('finished', (r) => { ev.result = r; this._showResult(r); });
    this.bus.on('dnf', (r) => { ev.result = r; this._showResult(r); });
    this.bus.on('stage-reset', () => this._reset());
  }
  _reset() {
    const ev = this._events;
    ev.checkpoints.length = 0; ev.penalties.length = 0; ev.result = null; ev.countdown = -1;
    this.stack.length = 1; this.stack[0] = 'hud';
    for (const k in this._keys) this._keys[k] = '';
    this._dirtyAll = true;
    this._setModal(false);
  }
  /** Pop a screen off the stack (main.js calls this on ESC over the result). */
  _pop(name) { const i = this.stack.indexOf(name); if (i >= 0) this.stack.splice(i, 1); this._syncStack(); }
  _pushStack(name) { if (!this.stack.includes(name)) this.stack.push(name); this._syncStack(); }
  top() { return this.stack[this.stack.length - 1]; }
  _syncStack() { this._setModal(this.top() !== 'hud'); }
  _setModal(open) {
    if (open === this._modalOpen) return;
    this._modalOpen = open;
    this.modal.className = open ? 'rly-modal open' : 'rly-modal';
    this._dirtyAll = true;
  }

  _showResult(r) {
    const title = r.result === STATE.FINISHED ? 'META' : 'DNF';
    const why = r.result === STATE.FINISHED ? ''
      : ({ limit: 'limit czasu', gates: 'dwa brakujące checkpointy', stuck: 'auto stanęło' }[r.reason] || r.reason);
    this._modalText[0] = `${title}  ${formatTime(r.total)}`;
    let rows = `CZAS ${formatTime(r.total)}  SPLIT ${formatSplit(r.split)}  LIMIT ${formatTime(r.limit)}`;
    for (const s of r.sectors) rows += `\nS${s.index}  ${s.time >= 0 ? formatTime(s.time) : '—'}  ${formatSplit(s.split)}`;
    for (const p of r.penalties) rows += `\nKARA +${p.seconds}s  ${p.label}`;
    if (why) rows += `\n${why.toUpperCase()}`;
    this._modalText[1] = rows;
    this._bigTitle = '';
    this._info = [];
    this._buildMenu([
      { label: 'Restart odcinka  (enter)', act: 'restart' },
      { label: 'Wróć do gry  (esc)', act: 'back' },
    ]);
    this._pushStack('result');
  }

  // ---------- ekran głowny / ustawienia / sterowanie ----------
  /** The stage clock may only run on these screens: a menu screen never drives. */
  driving() { const t = this.top(); return t === 'hud' || t === 'countdown' || t === 'result'; }
  openMenu() { this._rowsFor('menu'); this._pushStack('menu'); }
  openScreen(name) { this._rowsFor(name); this._pushStack(name); }
  /** START closes every menu screen; main.js then lets the countdown run. */
  startStage() { while (this.stack.length > 1) this.stack.pop(); this._bigTitle = ''; this._syncStack(); }
  back() {
    const t = this.top();
    if (t === 'hud' || t === 'countdown') return null;
    this._pop(t);
    const n = this.top();
    if (MENU_SCREENS.indexOf(n) >= 0) this._rowsFor(n);
    this._dirtyAll = true;
    return n;
  }
  stageKey() { return this.stages.length ? this.stages[this.stageIdx].key : ''; }
  rowIndex(act) { for (let i = 0; i < this._rows.length; i++) if (this._rows[i].act === act) return i; return -1; }
  refreshMenu() { const t = this.top(); if (MENU_SCREENS.indexOf(t) >= 0) this._rowsFor(t); }
  setTouchInset(px) { if (px === this.touchInset) return; this.touchInset = px; this._resize(); }
  /** Rows of one screen. Every row carries an `act` the state machine resolves. */
  _rowsFor(name) {
    const on = (v) => (v ? 'wł.' : 'wył.');
    const rows = [];
    this._bigTitle = '';
    this._info = [];
    this._modalText[0] = name === 'menu' ? 'Menu główne' : (name === 'settings' ? 'Ustawienia' : 'Sterowanie');
    this._modalText[1] = '';
    if (name === 'menu') {
      this._bigTitle = 'VOXEL RALLY';
      rows.push({ label: 'Start  (enter)', act: 'start' });
      rows.push({ label: `Etap: ${this.stages.length ? this.stages[this.stageIdx].label : '—'}`, act: 'stage' });
      rows.push({ label: 'Ustawienia', act: 'screen:settings' });
      rows.push({ label: 'Sterowanie', act: 'screen:controls' });
    } else if (name === 'settings') {
      rows.push({ label: `Bloki nawierzchni: ${on(settings.blockTiles)}`, act: 'toggle:blockTiles' });
      rows.push({ label: `Sterowanie dotykiem: ${TOUCH_LABEL[settings.touchOverlay] || 'auto'}`, act: 'cycle:touchOverlay' });
      rows.push({ label: `Kciuk sterujący: ${settings.touchHandedness === 'left' ? 'lewy' : 'prawy'}`, act: 'cycle:touchHandedness' });
      rows.push({ label: `Strzałki pilota: ${on(settings.showCoDriverArrows)}`, act: 'toggle:showCoDriverArrows' });
      rows.push({ label: `HUD: ${MODE_LABEL[this.mode]}`, act: 'hudmode' });
      rows.push({ label: `Jakość: ${QUAL_LABEL[settings.quality] || '—'}`, act: 'quality' });
      rows.push({ label: 'Wróć  (esc)', act: 'back' });
    } else if (name === 'controls') {
      // Two columns of KLAWISZ + AKCJA drawn at the same readable scale as the menu rows
      // (the row list is only the one focusable WRÓĆ target: keyboard/gamepad focus,
      // the table itself is information, not a control).
      this._info = [
        ['W', 'gaz'], ['S', 'hamulec'], ['A/D', 'skręt'], ['SPC', 'ręczny'],
        ['Q/E', 'bieg'], ['R', 'reset'], ['ENTER', 'start'], ['ESC', 'wróć'],
        ['C', 'kamera'], ['N', 'hud'], ['M', 'pilot'], ['P', 'pauza'],
        ['H', 'DEV panel'], ['L2/R2', 'pad gaz'], ['LEWA', 'skręt'], ['PRAWA', 'gaz, ham'],
      ];
      rows.push({ label: 'Wróć  (esc)', act: 'back' });
    }
    this._buildMenu(rows);
  }

  /** Focus navigation: something is always focused while a modal is open (skill #4). */
  _buildMenu(rows) {
    this._rows = rows;
    this.menu.length = 0;
    for (let i = 0; i < this.menuItems.length; i++) {
      const el = this.menuItems[i];
      if (i < rows.length) {
        el.textContent = rows[i].label;
        el.className = 'menu-item';
        this.menu.push({ el, label: rows[i].label, act: rows[i].act });
      } else { el.textContent = ''; el.className = 'menu-item off'; }
    }
    if (this.focus >= rows.length) this.focus = 0;
    this._syncFocus();
  }
  _syncFocus() {
    const sc = this.uiScale || 1;
    for (let i = 0; i < this.menu.length; i++) {
      const el = this.menu[i].el;
      el.className = i === this.focus ? 'menu-item focus' : 'menu-item';
      const r = this._menuRect[i];
      if (el.style && r && r[2] > 0) {
        // Hit area is never smaller than 72 CSS px on either axis (WCAG 2.5.5), the
        // drawn button stays centred inside it.
        const dw = r[2] * sc, dh = r[3] * sc;
        const w = Math.max(72, dw), h = Math.max(72, dh);
        el.style.left = Math.round(r[0] * sc + (dw - w) / 2) + 'px';
        el.style.top = Math.round(r[1] * sc + (dh - h) / 2) + 'px';
        el.style.width = w + 'px';
        el.style.height = h + 'px';
      }
    }
  }
  moveFocus(d) {
    if (!this.menu.length) return null;
    this.focus = (this.focus + d + this.menu.length) % this.menu.length;
    this._syncFocus();
    this._keys.modal = '';
    return this.menu[this.focus];
  }
  activate() {
    if (!this._rows || !this._rows.length) return null;
    const row = this._rows[this.focus];
    if (!row) return null;
    const act = row.act;
    if (act === 'back') { this.back(); return null; }
    if (act === 'hudmode') { this.cycleMode(); this.refreshMenu(); return null; }
    if (act.indexOf('screen:') === 0) { this.openScreen(act.slice(7)); return null; }
    if (act === 'stage') {
      if (this.stages.length) this.stageIdx = (this.stageIdx + 1) % this.stages.length;
      this.refreshMenu();
      return null;
    }
    if (act === 'noop') return null;
    if (act === 'start') { this.startStage(); return row; }
    return row;                // main.js applies restart / toggle:* / cycle:* / quality
  }
  /** Rows the caller may still act on (result screen, settings toggles). */
  pendingRow() { return this._rows[this.focus] || null; }

  _pollPad() {
    if (typeof navigator === 'undefined' || !navigator.getGamepads) return 0;
    const pads = navigator.getGamepads();
    for (let p = 0; p < pads.length; p++) {
      const gp = pads[p];
      if (!gp || !gp.buttons) continue;
      const up = gp.buttons[12] && gp.buttons[12].pressed;
      const down = gp.buttons[13] && gp.buttons[13].pressed;
      const a = gp.buttons[0] && gp.buttons[0].pressed;
      const b = gp.buttons[1] && gp.buttons[1].pressed;
      let d = 0;
      if (down && !this._padPrev[1]) d = 1;
      else if (up && !this._padPrev[0]) d = -1;
      this._padPrev[0] = up; this._padPrev[1] = down;
      if (a && !this._padPrev[3]) return 100;      // A = ENTER
      this._padPrev[3] = a;
      if (b && !this._padPrev[2]) return 101;      // B = WRÓĆ
      this._padPrev[2] = b;
      if (d) return d;
    }
    return 0;
  }

  // ---------- density modes (CMR "Game Displays: Full / Minimal / Off") ----------
  setMode(m) {
    if (MODES.indexOf(m) < 0) return this.mode;
    this.mode = m;
    settings.hudMode = m;
    this._root.className = 'rally mode-' + m.toLowerCase();
    this._dirtyAll = true;
    return m;
  }
  cycleMode() { return this.setMode(MODES[(MODES.indexOf(this.mode) + 1) % MODES.length]); }
  toggle() { return this.cycleMode(); }

  /** Low-rate update. `dt` is a frame dt (render rate), never the sim dt. */
  update(dt, ctx) {
    if (!ctx || !ctx.stage) return;
    const st = ctx.stage;
    if (st.state === STATE.PRE_START && this.top() === 'hud') {
      this._modalText[0] = `START ZA ${Math.max(0, st.countdown).toFixed(1)} s`;
      this._modalText[1] = '';
      this._info = [];
      this._buildMenu([]);
      this._pushStack('countdown');
    }
    // Ekran menu zajmuje caly viewport: zadnych paneli HUD pod nim, zeby modal nie
    // fights the 8/12/20 Hz panel redraws for the same pixels.
    if (MENU_SCREENS.indexOf(this.top()) >= 0) {
      this._stageName = ctx.stageName || 'ODCINEK';
      this._pollMenu();
      this._drawModal(ctx);
      return;
    }
    // A modal owns the frame it sits on. The countdown panel spans the middle of the
    // screen and used to be painted straight over the meta strip, the pace-note boards
    // and the locator bar, leaving half-erased labels ("SEKTOR" -> "OSTRZF"). While any
    // modal is up those boards are cleared once and skipped; closing the modal forces a
    // full redraw so they come back whole.
    if (this._modalOpen && this.L) {
      if (this._keys.boards !== 'hidden') {
        this._keys.boards = 'hidden';
        const mx = this.L.meta.x, my = this.L.meta.y;
        this._clear({ x: mx, y: my, w: this.W - mx - 2, h: this.L.prog.y + this.L.prog.h - my });
        this._keys.meta = ''; this._keys.signs = ''; this._keys.prog = ''; this._keys.time = '';
      }
    } else if (this._keys.boards === 'hidden') {
      this._keys.boards = '';
      this._dirtyAll = true;
    }
    if (this._dirtyAll && this.g) {
      this.g.clearRect(0, 0, this.W, this.H);
      this._dirtyAll = false;
      // A full-canvas clear (modal, resize, mode change) must invalidate every cached
      // value, otherwise the panels whose number did not change stay erased - that is
      // what left the stage/meta strip and the pace-note boards blank.
      for (const k in this._keys) this._keys[k] = '';
    }
    if (this.mode === 'OFF') {
      if (this.top() !== 'hud') { this._drawModal(ctx); this._pollMenu(); }
      return;
    }
    this._stageName = ctx.stageName || 'ODCINEK';
    this._acc += dt;
    this._accGauge += dt;
    if (this._acc >= 1 / 30) {
      this._acc = 0;
      this._drawCluster(ctx);
      this._drawTime(ctx);
      if (this.mode === 'FULL' && this.L && this.L.wide) { this._drawRevs(ctx); this._drawDamage(ctx); this._drawStates(ctx); }
    }
    if (this._accGauge >= 1 / 20) { this._accGauge = 0; this._drawProg(ctx); }
    this._accSign += dt;
    if (this._accSign >= 1 / 20) { this._accSign = 0; this._drawSigns(ctx); }
    this._accSlow += dt;
    if (this._accSlow >= 1 / 8) {
      this._accSlow = 0;
      this._pollMenu();
      if (this.mode === 'FULL') this._drawMeta(ctx);
      if (this.top() !== 'hud') this._drawModal(ctx);
    }
    this._accWheel += dt;
    if (this._accWheel >= 1 / 20) {
      this._accWheel = 0;
      if (this.mode === 'FULL') this._drawWheels(ctx);
    }
    if (this.top() !== 'hud') this._drawModal(ctx);
  }
  _pollMenu() {
    const d = this._pollPad();
    if (d === 100) this.pendingActivate = true;
    else if (d === 101) { this.back(); this._dirtyAll = true; }
    else if (d) this.moveFocus(d);
  }

  _clear(r) { if (this.g) this.g.clearRect(r.x, r.y, r.w, r.h); }
  _key(name, value) { if (this._keys[name] === value) return false; this._keys[name] = value; return true; }

  // ---------- 1. meta strip (stage / sector) ----------
  _drawMeta(ctx) {
    if (!this.g || this._keys.boards === 'hidden') return;
    const t = ctx.stage.timing, sec = t.activeSector;
    const line = `${this._stageName}  ·  SEKTOR ${sec ? sec.index : t.sectors.length}/${t.sectors.length}`;
    const r = this.L.meta;
    r.w = Math.min(this.W - 8, textWidth(line, 1) + 10);
    // The note row begins after this panel, so its x is recomputed on EVERY update, not
    // only when the text changes: the 20 Hz sign strip clears everything right of its
    // own x, and a stale (too small) x wiped the meta panel and drifted the boards over it.
    this.L.signs.x = Math.min(this.W - 40, r.x + r.w + 4);
    if (!this._key('meta', line)) return;
    this._clear({ x: r.x, y: r.y, w: r.w, h: r.h });
    frameRect(this.g, r.x, r.y, r.w, r.h, C.PANEL, true);
    drawText(this.g, line, r.x + 5, r.y + 3, 1, C.TEXT);
  }

  // ---------- 2. pace notes as wooden sign boards ----------
  // Exactly one board for the corner being approached + one small preview. The metre
  // count and the seconds countdown come from the real distance to that apex at the
  // car's current speed (src/game/pace-notes.js selectNotes), not from the ghost lead.
  _drawSigns(ctx) {
    if (this._keys.boards === 'hidden') return;
    const st = ctx.stage;
    const list = ctx.notes || [];
    const v = ctx.car && ctx.car.body ? ctx.car.body.groundSpeed : 0;
    const sel = selectNotes(list, st.arc || 0, v);
    const spoken = ctx.voice && ctx.voice.currentText ? ctx.voice.currentText : '';
    const picks = [];
    if (sel.active) picks.push({ n: sel.active, d: sel.activeDist, eta: sel.activeEta, big: true });
    if (sel.preview && this.mode === 'FULL') picks.push({ n: sel.preview, d: sel.previewDist, eta: sel.previewEta, big: false });
    let key = '';
    for (const p of picks) key += `${p.n.apexArc}:${p.d}:${p.eta.toFixed(1)}${p.n.text === spoken ? '*' : ''}|`;
    if (!this._key('signs', key)) { for (let i = 0; i < this._popFrames.length; i++) if (this._popFrames[i] > 0) this._popFrames[i]--; }
    if (!this.g) return;
    const S = this.L.signs;
    this._clear({ x: S.x, y: S.y, w: Math.max(1, this.W - S.x - 2), h: S.h + 4 });
    let x = S.x;
    for (let i = 0; i < picks.length; i++) {
      const a = picks[i].n;
      if (this._signKey[i] !== a.apexArc) { this._signKey[i] = a.apexArc; this._popFrames[i] = 2; }
      else if (this._popFrames[i] > 0) this._popFrames[i]--;
      const spec = {
        // the glyph is the corner itself: plain / sharp / hairpin, always carrying the
        // side of the bend the spline makes at this distance
        kind: a.kind === 'corner' ? bendKind(a.severity, a.hairpin, a.dir) : 'straight',
        dir: a.dir, sev: a.severity, big: picks[i].big, dim: !picks[i].big,
        word: signWord(a),
        dist: `${Math.max(0, Math.round(picks[i].d / 5) * 5)} M`,
        eta: `${picks[i].eta.toFixed(1)} s`,
        spoken: !!spoken && a.text === spoken, pop: this._popFrames[i],
      };
      const w = signMetrics(spec).w;
      if (x + w > this.W - 4) break;
      drawSignBoard(this.g, x, S.y, spec);
      x += w + 4;
    }
    for (let i = picks.length; i < this._signKey.length; i++) this._signKey[i] = '';
  }

  // ---------- 3. blocky speedometer + gear slot + big speed digits ----------
  _drawCluster(ctx) {
    const car = ctx.car, pt = car.powertrain || car.engine || null;
    const redline = (car.params && car.params.engine && car.params.engine.redline) || 7000;
    const maxRpm = Math.ceil(redline / 1000) * 1000;
    const rpm = Math.max(0, pt ? pt.rpm : 0);
    const fr = Math.max(0, Math.min(1, rpm / maxRpm));
    // ONE speed source: the body's ground speed, scaled to km/h exactly once. The dial
    // face is labelled in km/h, so its needle must read that same number (it used to
    // sweep on the rev fraction, so dial and digits disagreed).
    const kmh = Math.round((car.body ? car.body.groundSpeed : (car.speed || 0)) * 3.6);
    const f = Math.max(0, Math.min(1, kmh / DIAL_MAX));
    const gear = pt ? pt.gear : 0;
    const gl = kmh > 2 ? String(gear + 1) : 'N';
    if (this._key('cluster', `${f.toFixed(3)}|${kmh}|${gl}|${fr.toFixed(3)}|${this.mode}`) || this._dirtyAll) {
      if (this.g && this._dialFace) {
        const D = this.L.dial, G2 = this.g;
        this._clear(D);
        G2.drawImage(this._dialFace, D.x, D.y);
        const geo = this._dialGeo;
        const deg = geo.START + f * geo.SWEEP;
        // needle = stacked 2x2 blocks along the radius, not an antialiased line
        G2.fillStyle = fr >= 0.93 ? C.WHITE : C.OUT;
        for (let r = 2; r <= 28; r += 2) {
          const a = deg * Math.PI / 180;
          G2.fillRect(D.x + Math.round(geo.cx + Math.cos(a) * r) - 1, D.y + Math.round(geo.cy + Math.sin(a) * r) - 1, 2, 2);
        }
        G2.fillStyle = C.OUT;
        G2.fillRect(D.x + geo.cx - 2, D.y + geo.cy - 2, 4, 4);
        if (fr >= 0.93) {                        // rev limiter flash: red / white blocks
          G2.fillStyle = (this._flash = !this._flash) ? C.WHITE : C.RED;
          for (const r of geo.red) G2.fillRect(D.x + r[0], D.y + r[1], r[2], r[3]);
        }
        // speed in big pixel digits + km/h unit, then the gear in its own item slot
        const S = this.L.speed;
        this._clear(S);
        frameRect(G2, S.x, S.y, S.w, S.h, C.PANEL, true);
        drawText(G2, String(kmh), S.x + S.w - 5 - textWidth(String(kmh), 3), S.y + 4, 3, C.TEXT);
        drawText(G2, 'KM/H', S.x + 5, S.y + S.h - 11, 1, C.TEXT);
        const gx = S.x - 24, gy = S.y + S.h - 22;
        slotRect(G2, gx, gy, 20, 20);
        drawText(G2, gl, gx + 8, gy + 3, 2, gl === 'N' ? C.TEXT : (gl === '6' ? C.RED : C.TEXT));
      }
    }
  }

  /** Revs as a hotbar: 10 slots filling left->right, red near the limit, MAX GAZ over-full. */
  _drawRevs(ctx) {
    if (!this.g) return;
    const car = ctx.car, pt = car.powertrain || car.engine || null;
    const redline = (car.params && car.params.engine && car.params.engine.redline) || 7000;
    const maxRpm = Math.ceil(redline / 1000) * 1000;
    const rpm = Math.max(0, pt ? pt.rpm : 0);
    const thr = car.input ? Math.max(0, Math.min(1, car.input.throttle || 0)) : 0;
    const f = Math.max(0, Math.min(1, rpm / maxRpm));
    const maxThr = thr > 0.95 && f > 0.9;
    if (!this._key('revs', `${f.toFixed(3)}|${maxThr}`)) return;
    const R = this.L.revs;
    this._clear({ x: R.x - 2, y: R.y - 10, w: 202, h: 28 });
    frameRect(this.g, R.x - 2, R.y - 10, 202, 28, C.PANEL, true);
    drawText(this.g, 'OBROTY', R.x, R.y - 8, 1, C.TEXT);
    for (let i = 0; i < 10; i++) {
      const x = R.x + i * 13, frac = Math.max(0, Math.min(1, f * 10 - i));
      slotRect(this.g, x, R.y, 12, 14);
      if (frac > 0) {
        const col = i >= 8 ? C.RED : (i >= 6 ? C.ORANGE : C.GREEN);
        const n = Math.round(frac * 8);
        this.g.fillStyle = col;
        this.g.fillRect(x + 2, R.y + 11 - 10, n > 0 ? n : 0, 10);
      }
    }
    // CMR shows "gear change / max throttle": an over-full segment at the end of the bar
    const gx = R.x + 10 * 13 + 4;
    slotRect(this.g, gx, R.y, 12, 14);
    if (maxThr) { this.g.fillStyle = C.WHITE; this.g.fillRect(gx + 2, R.y + 2, 8, 10); }
    drawText(this.g, 'MAX GAZ', gx + 16, R.y + 4, 1, maxThr ? C.TEXT : C.DARK);
  }

  /** State gauges as item slots (CMR water / oil / turbo -> what this game simulates). */
  _drawStates(ctx) {
    if (!this.g) return;
    const dm = ctx.car.damage;
    const vals = [
      ['SILNIK', dm ? dm.enginePowerScale : 1],
      ['PRZÓD', dm ? (dm.susp[0] + dm.susp[1]) * 0.5 : 1],
      ['TYŁ', dm ? (dm.susp[2] + dm.susp[3]) * 0.5 : 1],
    ];
    let key = '';
    for (const v of vals) key += v[1].toFixed(2) + '|';
    if (!this._key('states', key)) return;
    const S = this.L.states;
    this._clear({ x: S.x - 2, y: S.y - 2, w: S.w + 4, h: 26 });
    frameRect(this.g, S.x - 2, S.y - 2, S.w + 4, 26, C.PANEL, true);
    for (let i = 0; i < vals.length; i++) {
      const x = S.x + i * 38, v = Math.max(0, Math.min(1, vals[i][1]));
      drawText(this.g, vals[i][0], x, S.y, 1, C.TEXT);
      slotRect(this.g, x, S.y + 9, 34, 13);
      slotFill(this.g, x, S.y + 9, 34, 13, v, v > 0.94 ? C.GREEN : (v > 0.8 ? C.ORANGE : C.RED), v <= 0.8);
    }
  }

  /** CMR "damage as broken parts": one slot per corner, fill = health, cracked pattern. */
  _drawDamage(ctx) {
    if (!this.g) return;
    const dm = ctx.car.damage;
    let key = '';
    for (let i = 0; i < 4; i++) key += (dm ? dm.susp[i].toFixed(2) : '1.00') + '|';
    key += dm ? dm.enginePowerScale.toFixed(2) : '';
    if (!this._key('damage', key)) return;
    const D = this.L.damage;
    this._clear({ x: D.x - 2, y: D.y - 2, w: 121, h: 34 });
    frameRect(this.g, D.x - 2, D.y - 2, 121, 34, C.PANEL, true);
    drawText(this.g, 'USZKODZENIA', D.x, D.y, 1, C.TEXT);
    for (let i = 0; i < 4; i++) {
      const x = D.x + i * 33, v = dm ? Math.max(0, Math.min(1, dm.susp[i])) : 1;
      slotRect(this.g, x, D.y + 9, 18, 13);
      slotFill(this.g, x, D.y + 9, 18, 13, v, v > 0.94 ? C.GREEN : (v > 0.8 ? C.ORANGE : C.RED), v < 0.94);
      drawText(this.g, WHEEL_LABELS[i], x, D.y + 23, 1, C.TEXT);
    }
  }

  // ---------- 4. time cluster: stone panel, pixel digits ----------
  _drawTime(ctx) {
    if (this._keys.boards === 'hidden') return;
    const t = ctx.stage.timing;
    const rem = t.limitRemaining;
    const warn = t.limit > 0 && rem < 15;
    const split = t.liveSplit;
    const pen = t.penaltyTotal ? `  KARY +${t.penaltyTotal}s` : '';
    const key = `${t.total.toFixed(2)}|${split.toFixed(2)}|${rem.toFixed(1)}|${warn}|${pen}`;
    if (!this._key('time', key)) return;
    if (!this.g) return;
    const R = this.L.time;
    this._clear(R);
    frameRect(this.g, R.x, R.y, R.w, R.h, C.PANEL, true);
    const g = this.g;
    drawText(g, `CZAS ${formatTime(t.total)}`, R.x + 5, R.y + 3, 1, C.TEXT);
    drawText(g, `SPLIT ${formatSplit(split)}`, R.x + 5, R.y + 13, 1, split <= 0 ? C.GREEN : C.RED);
    drawText(g, `LIMIT ${t.limit > 0 ? (rem >= 0 ? formatTime(rem) : '00:00.00') : '—'}${warn ? ' !' : ''}${pen}`,
      R.x + 5, R.y + 23, 1, warn ? C.RED : C.TEXT);
  }

  // ---------- 5. stage progress as a locator bar ----------
  _drawProg(ctx) {
    if (!this.g || this._keys.boards === 'hidden') return;
    const st = ctx.stage, t = st.timing;
    const gates = st.gates || [];
    const total = gates.length ? (gates[gates.length - 1].arc || 1) : 1;
    const pos = Math.max(0, Math.min(1, st.furthest / total));
    const sec = t.activeSector;
    // Sector stores fromArc / toArc (docs/03 §4) — the arcs the locator bar is scaled on.
    const sFrom = sec ? sec.fromArc : 0, sTo = sec ? sec.toArc : 0;
    let key = `${pos.toFixed(4)}|${sec ? sec.index : 0}|${sFrom.toFixed(0)}|${sTo.toFixed(0)}`;
    for (const g2 of gates) key += '|' + g2.arc.toFixed(0);
    if (!this._key('prog', key)) return;
    const R = this.L.prog;
    this._clear({ x: R.x, y: R.y, w: R.w, h: R.h + 4 });
    drawText(this.g, sec ? `SEKTOR ${sec.index}/${t.sectors.length}  ${Math.round(st.furthest)} M`
      : `POSTĘP ${Math.round(pos * 100)}%`, R.x, R.y, 1, C.TEXT);
    const bx = R.x, by = R.y + 11, bw = R.w, bh = 8;
    frameRect(this.g, bx, by, bw, bh, C.SLOT, false);
    if (sec) {                                  // active sector: a lighter block band
      const x0 = bx + 1 + Math.round((sFrom / total) * (bw - 2));
      const x1 = bx + 1 + Math.round((sTo / total) * (bw - 2));
      this.g.fillStyle = C.PANEL;
      this.g.fillRect(Math.max(bx + 3, x0), by + 3, Math.max(1, x1 - x0), bh - 6);
    }
    for (let i = 1; i < gates.length; i++) {    // checkpoints as little sign blocks
      const x = bx + 1 + Math.round((gates[i].arc / total) * (bw - 2));
      this.g.fillStyle = '#2A1F10'; this.g.fillRect(x - 3, by - 4, 7, 8);
      this.g.fillStyle = '#9C7E4E'; this.g.fillRect(x - 2, by - 3, 5, 6);
      this.g.fillStyle = '#7A6138'; this.g.fillRect(x - 2, by + 1, 5, 1);
    }
    const cx = bx + 1 + Math.round(pos * (bw - 2));   // the car: a block tick on the bar
    this.g.fillStyle = C.OUT;
    this.g.fillRect(cx - 1, by - 6, 3, bh + 6);
    this.g.fillStyle = C.WHITE;
    this.g.fillRect(cx, by - 5, 1, bh + 2);
  }

  // ---------- 6. four wheel-state slots (PLAN.md §8 #2) ----------
  _drawWheels(ctx) {
    const ws = ctx.car.wheels;
    let key = '';
    for (let i = 0; i < 4; i++) {
      const w = ws[i];
      const air = (w.airborneFrames || 0) > 0 || w.airborne;
      const alphaDeg = w.alpha * RAD2DEG;
      let s;
      if (air) s = { label: 'POWIETRZE', color: C.BLUE };
      else if (w.kappa <= -0.85) s = { label: 'BLOKADA', color: C.RED };
      else if (Math.abs(alphaDeg) > 9 || w.slipEnergy > 12000) s = { label: 'UŚLIZG', color: C.ORANGE };
      else if (w.kappa >= 0.7) s = { label: 'NAPĘD', color: C.GREEN };
      else s = { label: 'CZEPNE', color: C.GREEN };
      const num = air ? ''
        : s.label === 'BLOKADA' || s.label === 'NAPĘD' ? `K${w.kappa.toFixed(2)}`
        : Math.abs(alphaDeg) > 9 ? `${Math.abs(alphaDeg).toFixed(0)}°` : `${(w.N / 1000).toFixed(1)}KN`;
      const label = `${s.label} ${num}`.trim();
      if (this.gauges[i].val.textContent !== label) this.gauges[i].val.textContent = label;  // a11y + stagetest C3
      this._wheelCol[i] = s.color;
      this._wheelLabel[i] = label;
      key += label + '|';
    }
    if (!this._key('wheels', key)) return;
    if (!this.g) return;
    const W = this.L.wheels;
    this._clear({ x: W.x - 2, y: W.y - 2, w: 121, h: 26 });
    frameRect(this.g, W.x - 2, W.y - 2, 121, 26, C.PANEL, true);
    drawText(this.g, 'KOŁA', W.x, W.y, 1, C.TEXT);
    for (let i = 0; i < 4; i++) {
      const x = W.x + i * 33;
      slotRect(this.g, x, W.y + 9, 18, 13);
      this.g.fillStyle = this._wheelCol[i];
      this.g.fillRect(x + 3, W.y + 12, 12, 7);
    }
  }

  // ---------- modal screen stack (menu / ustawienia / countdown / result) ----------
  _rowsKey() {
    let k = '';
    for (const r of this._rows) k += r.label + '|';
    for (const p of this._info) k += p[0] + '=' + p[1] + '|';
    return k;
  }
  /** Oak frame with a stone GUI panel inside: the modal's own banner material, used
   *  for every modal screen so the countdown and the menu cannot read as strangers. */
  _woodFrame(g, x, y, w, h) {
    const F = MODAL_FRAME;
    g.fillStyle = C.OUT; g.fillRect(x, y, w, h);
    g.fillStyle = WOOD_DARK; g.fillRect(x + 1, y + 1, w - 2, h - 2);
    g.fillStyle = WOOD; g.fillRect(x + 2, y + 2, w - 4, h - 4);
    g.fillStyle = WOOD_LIGHT;
    g.fillRect(x + 2, y + 2, w - 4, 2); g.fillRect(x + 2, y + 2, 2, h - 4);
    g.fillStyle = WOOD_DARK;
    g.fillRect(x + 2, y + h - 4, w - 4, 2); g.fillRect(x + w - 4, y + 2, 2, h - 4);
    for (let sx = x + 11; sx < x + w - 5; sx += 15) g.fillRect(sx, y + 4, 1, h - 8);
    for (let sy = y + 11; sy < y + h - 5; sy += 15) g.fillRect(x + 4, sy, w - 8, 1);
    frameRect(g, x + F, y + F, w - 2 * F, h - 2 * F, C.PANEL, true);
  }
  /** One row of the sterowanie table: a recessed key cap + the action beside it. */
  _infoRow(g, x, y, key, act, TS) {
    const kw = textWidth(key, TS) + 6, h = 9 * TS + 2;
    slotRect(g, x, y, kw, h);
    drawText(g, key, x + 3, y + 3, TS, C.WHITE);
    drawText(g, act, x + kw + 5, y + 3, TS, C.TEXT);
  }
  _drawModal(ctx) {
    if (!this.g || !this._modalOpen) return;
    const title = this._modalText[0], body = this._modalText[1];
    const items = this._rows || [];
    const info = this._info || [];
    const W = this.W, H = this.H, ui = this.uiScale || 1;
    const wide = W >= 480;
    // Skala modala: na telefonie uiScale = 1, więc 7-px glif byłby nieczytelny -
    // modal podnosi własną skalę tekstu, a rozmiar klawiszy i tak liczy 72 CSS px.
    const TS = ui >= 2 ? 1 : 2;
    const tScale = Math.max(TS + 1, wide ? 3 : 2);
    let bScale = 4;
    if (this._bigTitle) {                      // the title owns the panel: as big as fits
      bScale = wide ? 8 : 6;
      while (bScale > 3 && textWidth(this._bigTitle, bScale) > W * 0.72) bScale--;
    }
    const rowH = 9 * TS + 8;                   // drawn button box
    const pitch = Math.max(rowH + 4, Math.ceil(72 / ui));   // hit box >= 72 CSS px
    let key = `${title}\n${body}\n${this._rowsKey()}\n${this.focus}\n${this.mode}\n${W}x${H}`;
    if (!this._key('modal', key)) return;
    // Only a menu may dim the whole world. The countdown sits over a live start line, so
    // the half-black full-screen checker is replaced by a scrim pad behind its own
    // frame: the start shot stopped reading as a muddy dithered frame.
    const fullScrim = this.top() !== 'countdown';
    if (fullScrim) this.g.clearRect(0, 0, W, H);
    // Dithered scrim instead of an alpha panel (PLAN.md §10.1: no translucent boxes):
    // a hard 2x2 checker of near-black pixels, one pattern fill, dims the world behind
    // the menu without a single gradient.
    if (!this._dither) {
      const pc = this.doc.createElement('canvas');
      pc.width = 2; pc.height = 2;
      const pg = pc.getContext ? pc.getContext('2d') : null;
      if (pg) {
        pg.fillStyle = C.OUT; pg.fillRect(0, 0, 1, 1); pg.fillRect(1, 1, 1, 1);
        this._dither = this.g.createPattern ? this.g.createPattern(pc, 'repeat') : null;
      }
    }
    if (this._dither) {
      this.g.fillStyle = this._dither;
      if (fullScrim) this.g.fillRect(0, 0, W, H);
    }
    const lines = body ? body.split('\n') : [];
    const F = MODAL_FRAME;
    const limit = W - 2 * (F + 5);             // widest inner panel that fits the screen
    // Two columns of key + action. Each column is measured on its own half of the
    // table, so the phone's narrow width still gets two columns when the labels fit.
    const nCol = Math.ceil(info.length / 2);
    const colWid = [0, 1].map((c) => {
      let k = 0, a = 0;
      for (const p of info.slice(c * nCol, (c + 1) * nCol)) { k = Math.max(k, textWidth(p[0], TS)); a = Math.max(a, textWidth(p[1], TS)); }
      return k + 6 + 5 + a;
    });
    const twoCol = info.length > 6 && (colWid[0] + colWid[1] + 10 <= limit);
    let iw = 0;
    if (this._bigTitle) iw = Math.max(iw, textWidth(this._bigTitle, bScale));
    if (title) iw = Math.max(iw, textWidth(title, tScale) + 8);
    for (const l of lines) iw = Math.max(iw, textWidth(l, TS));
    for (const it of items) iw = Math.max(iw, textWidth(it.label, TS) + 16);
    if (info.length) iw = Math.max(iw, twoCol ? colWid[0] + colWid[1] + 10 : colWid[0]);
    // A menu is a piece of furniture, not a band: on a wide screen it takes a real
    // share of the viewport even when the labels are short.
    iw = Math.min(Math.max(iw, wide ? Math.min(limit, 330) : Math.min(limit, W - 2 * (F + 5))), limit);
    const w = iw + 2 * (F + 5);
    const bigH = this._bigTitle ? 8 * bScale + 4 : 0;
    const banH = title ? 8 * tScale + 6 : 0;
    const rowsInfo = info.length ? (twoCol ? nCol : info.length) : 0;
    const infoH = info.length ? rowsInfo * (9 * TS + 6) + 4 : 0;
    const h = 2 * (F + 5) + bigH + banH + lines.length * (9 * TS) + infoH + items.length * pitch + 6;
    const x = Math.round((W - w) / 2);
    // The countdown sits high (the boards above it are hidden while it is up) so the
    // car at the start line stays visible below the panel instead of behind it.
    const y = this.top() === 'countdown'
      ? Math.round(H * 0.12)
      : Math.round((H - h) / 2);
    if (this._dither && !fullScrim) {
      this.g.clearRect(x - 12, y - 12, w + 24, h + 24);
      this.g.fillStyle = this._dither;
      this.g.fillRect(x - 12, y - 12, w + 24, h + 24);
    }
    this._woodFrame(this.g, x, y, w, h);
    // One content column: the banner, every row and the sterowanie table share its left
    // edge and the same gap, so nothing sits "off" under the banner.
    const cx = x + F + 5, cw = w - 2 * (F + 5);
    let cy = y + F + 5;
    if (this._bigTitle) {
      const bw2 = textWidth(this._bigTitle, bScale);
      drawText(this.g, this._bigTitle, Math.round(cx + (cw - bw2) / 2), cy, bScale, C.TEXT);
      cy += bigH;
    }
    if (title) {                       // wood banner: the oak of the pace-note boards
      const bx = cx, bw = cw, by = cy, bh = banH - 6;
      this.g.fillStyle = C.OUT; this.g.fillRect(bx, by, bw, bh);
      this.g.fillStyle = WOOD; this.g.fillRect(bx + 1, by + 1, bw - 2, bh - 2);
      this.g.fillStyle = WOOD_LIGHT; this.g.fillRect(bx + 1, by + 1, bw - 2, 2);
      this.g.fillStyle = WOOD_DARK; this.g.fillRect(bx + 1, by + bh - 3, bw - 2, 2);
      for (let sx = bx + 11; sx < bx + bw - 4; sx += 16) this.g.fillRect(sx, by + 2, 1, bh - 4);
      drawText(this.g, title, Math.round(bx + (bw - textWidth(title, tScale)) / 2), by + 3, tScale, '#2A2118');
      cy += banH;
    }
    for (let i = 0; i < lines.length; i++) drawText(this.g, lines[i], cx, cy + i * (9 * TS), TS, C.TEXT);
    cy += lines.length * (9 * TS);
    if (info.length) {
      const step = 9 * TS + 6;
      for (let i = 0; i < info.length; i++) {
        const col = twoCol ? (i < nCol ? 0 : 1) : 0;
        const r = twoCol ? (i < nCol ? i : i - nCol) : i;
        const x0 = cx + (col ? colWid[0] + 10 : 0);
        this._infoRow(this.g, x0, cy + r * step, info[i][0], info[i][1], TS);
      }
      cy += rowsInfo * step + 4;
    }
    for (let i = 0; i < items.length; i++) {
      const ry = cy + i * pitch, lw = cw, rh = rowH;
      const ty = ry + Math.round((rh - 7 * TS) / 2);
      const tx = Math.round(cx + (lw - textWidth(items[i].label, TS)) / 2);
      if (i === this.focus) {
        frameRect(this.g, cx, ry, lw, rh, C.DARK, true);
        // Visible keyboard focus: a blue ring drawn INSIDE the row. The DOM hit box is
        // >= 72 CSS px (it must be), so a DOM outline would spill onto the row above.
        this.g.fillStyle = C.BLUE;
        this.g.fillRect(cx + 3, ry + 3, lw - 6, 2); this.g.fillRect(cx + 3, ry + rh - 5, lw - 6, 2);
        this.g.fillRect(cx + 3, ry + 3, 2, rh - 6); this.g.fillRect(cx + lw - 5, ry + 3, 2, rh - 6);
        drawText(this.g, items[i].label, tx, ty, TS, C.WHITE);
      } else {
        frameRect(this.g, cx, ry, lw, rh, C.PANEL, false);
        drawText(this.g, items[i].label, tx, ty, TS, C.TEXT);
      }
      if (!this._menuRect[i]) this._menuRect[i] = [0, 0, 0, 0];
      this._menuRect[i][0] = cx; this._menuRect[i][1] = ry;
      this._menuRect[i][2] = lw; this._menuRect[i][3] = rh;
    }
    this._syncFocus();
  }
}

export { MODE_LABEL };
