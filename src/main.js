// Voxel Rally bootstrap: stage -> world -> car -> fixed-step loop (docs/06 §3).
// Nothing here is asset-based: the stage, the terrain, the props and the car are
// all generated from the seed at boot.
import * as THREE from 'three';

import { Renderer } from './render/renderer.js';
import { ChaseCamera } from './render/camera.js';
import { buildCarMesh, syncCarMesh } from './render/carMesh.js';
import { Streaming } from './world/streaming.js';
import { VoxelWorld } from './world/chunk.js';
import { makeTerrain, BIOMES, BIOME_INFO } from './world/terrain-gen.js';
import { buildRoad, planCheckpoints } from './world/road-spline.js';
import { buildCarveIndex, prewarmArea } from './world/road-carve.js';
import { Vehicle } from './car/vehicle.js';
import { Input } from './game/input.js';
import { Hud } from './debug/hud.js';
import { StageRun, planGates, STATE } from './game/stage.js';
import { RallyHud } from './game/hud-rally.js';
import { solveGhost } from './game/ghost.js';
import { buildPaceNotes } from './game/pace-notes.js';
import { Voice } from './game/voice.js';
import { bus } from './core/events.js';
import { DirtSystem } from './dirt/dirt.js';
import { attachDirtLens } from './render/dirt-lens.js';
import { SURFACE_KEYS } from './world/surfaces.js';
import { FrameLoop } from './core/loop.js';
import { DT } from './core/time.js';
import { settings, applyDifficulty, qualityPreset, QUALITY } from './core/settings.js';

// Boot-time yield: the loading steps hand the frame back to the browser so the
// boot text updates. In shot mode (--frames) a headless browser barely ticks
// rAF, so the yields collapse to a timer tick instead of stalling the stage.
const nextFrame = (instant) => new Promise((r) => (instant ? setTimeout(r, 0) : requestAnimationFrame(() => r())));

function params() {
  const q = new URLSearchParams(location.search);
  const seedRaw = q.get('seed');
  const seed = seedRaw !== null && seedRaw !== '' ? (Number(seedRaw) >>> 0) : (Math.floor(Math.random() * 1e9) >>> 0);
  const biome = (q.get('biome') || 'FOREST').toUpperCase();
  const carId = (q.get('car') || 'A').toUpperCase();
  const len = Number(q.get('len') || 3400);
  // Debug knobs used by the dirt acceptance screenshots (docs/07 F3 criterion D):
  // ?surface=<key> repaints the whole road with one surface, ?frames=<substeps>
  // drives the car for a fixed number of sim steps before the first frame is shown
  // (--virtual-time-budget does not drive rAF at 60 Hz, so a fixed frame count is
  // the only deterministic way to get "30 s of driving" into a screenshot).
  const surfaceKey = (q.get('surface') || '').toLowerCase();
  const frames = q.get('frames') !== null ? Math.max(0, Number(q.get('frames')) | 0) : 0;
  const rain = Number(q.get('rain') || 0);
  // ?cam=CHASE|BUMPER|ONBOARD|FREE: the dirt proof needs a close view of the panels.
  const cam = (q.get('cam') || '').toUpperCase();
  // ?ref=<s> reference time for the stage (docs/03 §6 ghost is not wired yet).
  const ref = Number(q.get('ref') || 0);
  // ?tod=<0..1> time of day for the art-direction shots (PLAN §10 criterion 1/4):
  // 0.25 sunrise, 0.5 noon, 0.72 golden hour, 1 night. Default: golden hour.
  const tod = q.has('tod') ? Math.max(0, Math.min(1, Number(q.get('tod')))) : 0.62;
  // ?post=0|1 turns the composite off/on (A/B shots for the pass-cost numbers).
  // Read *after* the quality preset below so the flag always wins.
  const postFlag = q.get('post');
  // ?hud=FULL|MIN|OFF: HUD density (CMR "Game Displays"), for shots and for testing.
  const hudMode = (q.get('hud') || '').toUpperCase();
  if (hudMode === 'MIN' || hudMode === 'MINIMAL') settings.hudMode = 'MINIMAL';
  else if (hudMode === 'OFF') settings.hudMode = 'OFF';
  else if (hudMode === 'FULL') settings.hudMode = 'FULL';
  // ?stats=1 keeps the render-cost read-out on screen (shot-mode harness).
  const stats = q.get('stats') === '1';
  // ?q=LOW|MED|HIGH picks the quality preset before the renderer is built, so the
  // quality tiers are testable from a headless shot (docs/07 §Budżety).
  const qName = (q.get('q') || '').toUpperCase();
  if (qName === 'LOW') qualityPreset(QUALITY.LOW);
  else if (qName === 'MED') qualityPreset(QUALITY.MED);
  else if (qName === 'HIGH') qualityPreset(QUALITY.HIGH);
  if (postFlag === '0') settings.post = false;
  else if (postFlag === '1') settings.post = true;
  // ?menu=off / ?frames=N: the car drives off at boot. ?shot=1 only makes the boot
  // fast for the headless harness - the menu still owns the first screen, so nothing
  // drives until START.
  const autoStart = frames > 0 || q.get('menu') === 'off';
  const shotBoot = autoStart || q.get('shot') === '1';
  const menuScreen = q.get('menu') && q.get('menu') !== 'off' ? q.get('menu') : '';
  return {
    seed, biome: BIOME_INFO[biome] ? biome : 'FOREST', carId, lengthTarget: len,
    autoStart, shotBoot, menuScreen,
    hasTod: q.has('tod'),
    surfaceId: SURFACE_KEYS[surfaceKey] !== undefined ? SURFACE_KEYS[surfaceKey] : null,
    surfaceKey, frames, rain, cam, ref, tod, stats,
  };
}

async function generateStage(cfg, hud) {
  const world = new VoxelWorld(cfg.seed);

  hud.boot(`VOXEL RALLY\nseed ${cfg.seed}  biome ${cfg.biome}\nterrain…`);
  await nextFrame(cfg.shotBoot);
  const terrain = makeTerrain(cfg.seed, cfg.biome);

  hud.boot(`VOXEL RALLY\nseed ${cfg.seed}  biome ${cfg.biome}\nroad spline…`);
  await nextFrame(cfg.shotBoot);
  const road = buildRoad({ seed: cfg.seed, lengthTarget: cfg.lengthTarget, terrainHeightAt: terrain.heightAt, biome: cfg.biome });
  // Repainting the spline's own surface attribute is enough: road-carve builds the
  // road block from road.surfaceId at carve time (docs/03), so the whole streamed
  // stage follows it. No geometry is generated twice.
  if (cfg.surfaceId !== null) road.surfaceId.fill(cfg.surfaceId);
  const gates = planGates(road, cfg.seed);   // 6 checkpoints (PLAN.md §2), see SYSTEM-NOTES.md
  const carveIndex = buildCarveIndex(road);

  // Terrain has to exist in a chunk before it can be carved, so the start line is
  // filled + carved here and Streaming streams the rest of the stage lazily.
  hud.boot(`VOXEL RALLY\nseed ${cfg.seed}  road ${road.length.toFixed(0)} m\nfilling the start line…`);
  await nextFrame(cfg.shotBoot);
  prewarmArea(world, terrain, road, carveIndex, road.x[0], road.z[0], 140);

  return { seed: cfg.seed, biome: cfg.biome, world, terrain, road, gates, carveIndex, roadLength: road.length };
}

const STAGE_LABEL = { FOREST: 'Leśny', MOUNTAIN: 'Górski', SWAMP: 'Bagno', PLATEAU: 'Wyżyna', CANYON: 'Wąwóz' };

async function main() {
  const hud = new Hud();
  const cfg = params();
  const stage = await generateStage(cfg, hud);

  const canvas = document.getElementById('c');
  const renderer = new Renderer(canvas);
  renderer.setBiome(BIOME_INFO[cfg.biome], cfg.biome);
  // Pora dnia i pogoda to feature of the stage (PLAN §10.2); ?tod= only overrides it
  // for art-direction shots.
  const climate = stage.road.climate || { tod: cfg.tod, wet: 0, haze: 1, weather: 0 };
  renderer.setTimeOfDay(cfg.hasTod ? cfg.tod : climate.tod);
  renderer.setClimate(climate);
  renderer.setQuality(settings.quality);
  if (cfg.cam) settings.cameraMode = cfg.cam;

  const stream = new Streaming(stage.world, stage.terrain, stage.road, stage.carveIndex, renderer, stage);
  // Shim for a carry-over bug in world/chunk.js: surfaceAt/rutAt index the column
  // with a *fractional* local offset (x - cx*CHUNK), so at any real contact point
  // they return undefined and every wheel reads the 'unknown' surface. Fixed here
  // with a prototype-derived view instead of editing chunk.js (owned by F1): the
  // car gets the same object, only those two lookups are floored.
  const carWorld = Object.create(stage.world);
  carWorld.surfaceAt = (x, z) => stage.world.surfaceAt(Math.floor(x), Math.floor(z));
  carWorld.rutAt = (x, z) => stage.world.rutAt(Math.floor(x), Math.floor(z));
  const car = new Vehicle(cfg.carId, carWorld, { assists: { ...settings.assists } });
  const dirt = new DirtSystem();
  dirt.rain(cfg.rain);
  const view = buildCarMesh(car, dirt);
  renderer.scene.add(view.group);
  const view3d = new ChaseCamera(renderer);
  const lensView = attachDirtLens(renderer);
  dirt.lens.setAmount(settings.lensDirt);
  const input = new Input().attach(window);

  // ---- rally loop: state machine + clock + HUD (docs/07 F4, docs/03 §4) ----
  // refTime now comes from the offline solver over the road geometry (docs/03 §6,
  // ghost.js): friction-circle corner speeds integrated with the car's own accel and
  // braking envelope. The old roadLength / REF_SPEED placeholder made a 1124 m sector
  // "16 s" and DNF'd every honest drive on the limit. ?ref= still overrides it.
  stage.gates = planGates(stage.road, cfg.seed);
  const ghost = solveGhost(stage.road, { seed: cfg.seed, gates: stage.gates, carId: cfg.carId, wetness: cfg.rain });
  const refTime = cfg.ref > 0 ? cfg.ref : ghost.refTime;
  const refSectors = cfg.ref > 0 ? null : ghost.refSectors;
  const stageRun = new StageRun({ road: stage.road, gates: stage.gates, seed: cfg.seed, refTime, refSectors });
  // Pace notes from geometry + the ghost speed the note is timed against (docs/07 F4).
  const notes = buildPaceNotes(stage.road, ghost);
  const voice = new Voice({ notes: notes.notes, emit: bus });
  const stageName = `ODCINEK ${cfg.biome === 'FOREST' ? 'LEŚNY' : cfg.biome} · SZUTER · ${cfg.seed}`;
  const rally = new RallyHud(document, { bus, stages: BIOMES.map((b) => ({ key: b, label: STAGE_LABEL[b] || b })) });
  rally.stageIdx = Math.max(0, BIOMES.indexOf(cfg.biome));
  function restartRun() {
    resetCar();
    view3d.shake = 0;
    voice.reset();
    stageRun.reset(refTime);
  }
  // Menu action, shared by ENTER, the pad "A" and a tap on a menu row (docs/06 §5).
  // Everything the HUD can do to itself (back / screens / HUD density / etap) is
  // already resolved inside RallyHud.activate(); only world+render acts come here.
  function activateMenu() {
    const it = rally.activate();
    if (!it) return;
    if (it.act === 'start') startRun();
    else if (it.act === 'restart') restartRun();
    else if (it.act === 'toggle:blockTiles') settings.blockTiles = !settings.blockTiles;
    else if (it.act === 'toggle:showCoDriverArrows') {
      settings.showCoDriverArrows = !settings.showCoDriverArrows;
      rally.arrows = settings.showCoDriverArrows;
    } else if (it.act === 'cycle:touchOverlay') {
      const order = ['auto', 'on', 'off'];
      settings.touchOverlay = order[(order.indexOf(settings.touchOverlay) + 1) % order.length];
      applyTouch();
    } else if (it.act === 'quality') {
      const q = (settings.quality + 1) % 3;
      qualityPreset(q);
      renderer.setQuality(q);
    }
    rally.refreshMenu();          // a toggle row re-labels itself (wł./wył.)
  }
  // START: a different etap means a different stage, so reload with ?biome=... and
  // land straight in the countdown; otherwise the frozen clock just starts running.
  function startRun() {
    const want = rally.stageKey();
    if (want && want !== cfg.biome) {
      const u = new URL(location.href);
      u.searchParams.set('biome', want);
      u.searchParams.delete('shot'); u.searchParams.delete('frames'); u.searchParams.delete('menu');
      location.href = u.href;
      return;
    }
    if (input.touch.enabled) input.touch.setVisible(true);
  }
  // Ustawienia dotyku: 'auto' = auto-detekcja input.touch, 'on'/'off' = wola gracza.
  function applyTouch() {
    const want = settings.touchOverlay;
    if (want === 'on') input.touch.enable(window);
    else if (want === 'off' && input.touch.enabled) input.touch.disable();
    rally.setTouchInset(input.touch.enabled ? 240 : 0);   // HUD podnosi dolne panele
  }

  // A few metres along the arc: at arc 0 the rear axle still straddles the uncarved terrain behind the start line.
  const startIdx = 12;
  const startYaw = -stage.road.heading[startIdx];
  function resetCar() {
    car.placeAt(stage.road.x[startIdx], stage.road.z[startIdx], startYaw, stage.road.h[startIdx]);
    car.wheels.forEach((w) => { w.omega = 0; });
  }
  resetCar();

  const ctx = { car, stream, stage, input, hud, arc: 0, dirt, renderer };
  // Fixed-frame driver for the screenshots (?frames=...): the same code path the
  // real loop uses, so the dirt in the PNG is the dirt the game would have made.
  const driveIn = { throttle: 0, brake: 0, steer: 0, handbrake: 0, shiftUp: 0, shiftDown: 0 };
  let stuckDrive = 0;
  function autoDrive(i) {
    // Pure pursuit along the spline (same pattern as tools/smoke.mjs), with a
    // recovery re-place so a screenshot always shows the car on the tested lane.
    let idx = stage.road.nearest(car.body.pos.x, car.body.pos.z);
    if (idx < 0) idx = 12;
    const lat = Math.hypot(car.body.pos.x - stage.road.x[idx], car.body.pos.z - stage.road.z[idx]);
    const roll = Math.abs(Math.asin(Math.max(-1, Math.min(1, -car.body.m[7]))) * 180 / Math.PI);
    if (lat > 6 || roll > 20) {
      const k = Math.min(stage.road.n - 2, idx + 2);
      car.placeAt(stage.road.x[k], stage.road.z[k], -stage.road.heading[k], stage.road.h[k]);
      car.wheels.forEach((w) => { w.omega = car.body.groundSpeed / w.rEff; });
      idx = k;
    }
    if (car.body.groundSpeed < 1.2) stuckDrive++; else stuckDrive = 0;
    if (stuckDrive > 180) {              // the player's R (docs/06 §5 zakotwiczenie)
      const k = Math.min(stage.road.n - 2, idx + 5);
      car.placeAt(stage.road.x[k], stage.road.z[k], -stage.road.heading[k], stage.road.h[k]);
      car.wheels.forEach((w) => { w.omega = 6; });
      stuckDrive = 0;
    }
    const sp = Math.max(1, car.body.groundSpeed);
    // Rally pace model (docs/03 §6 step 2 in miniature): v = sqrt(a_lat / kappa) at
    // the tightest point ahead with the braking distance folded in, so the shot car
    // actually gets through a hairpin instead of bogging in it.
    const r = stage.road;
    let vLim = 26, kAhead = 1e-4;
    for (let q = idx; q <= Math.min(r.n - 1, idx + 140); q++) {
      const k = Math.abs(r.kappa[q]);
      const vl = k > 1e-4 ? Math.min(26, Math.sqrt(9 / k)) : 26;
      const allowed = Math.sqrt(vl * vl + 14 * (r.s[q] - r.s[idx]));
      if (allowed < vLim) vLim = allowed;
      if (k > kAhead) kAhead = k;
    }
    let look = Math.max(12, Math.min(26, 10 + sp * 1.1));
    look = Math.min(look, Math.max(12, 0.45 / kAhead));
    const j = Math.min(r.n - 1, idx + Math.max(1, Math.round(look / (r.s[1] - r.s[0]))));
    const want = Math.atan2(r.z[j] - car.body.pos.z, r.x[j] - car.body.pos.x);
    let dA = want - Math.atan2(car.body.forward.z, car.body.forward.x);
    while (dA > Math.PI) dA -= 2 * Math.PI;
    while (dA < -Math.PI) dA += 2 * Math.PI;
    const st = Math.max(-1, Math.min(1, -Math.atan(2 * car.params.wheelbase * Math.sin(dA) / look) / car.params.steerMax));
    const go = stageRun.state !== STATE.PRE_START;
    driveIn.throttle = go ? (sp < vLim * 0.95 ? 0.85 : sp < vLim * 1.08 ? 0.35 : 0.1) : 0;
    driveIn.brake = go ? (sp > vLim * 1.1 ? Math.min(0.85, (sp - vLim) * 0.07) : 0) : 1;
    driveIn.steer = st;
    driveIn.handbrake = (i % 1000) < 40 ? 0.30 : 0;   // a short slide so slip dirt shows too
    driveIn.shiftUp = 0; driveIn.shiftDown = 0;
    return driveIn;
  }

  // ---- controls (docs/06 §5) ----
  input.on((code) => {
    if (code === 'KeyC') {
      const modes = ['CHASE', 'ONBOARD', 'BUMPER', 'FREE'];
      settings.cameraMode = modes[(modes.indexOf(settings.cameraMode) + 1) % modes.length];
    } else if (code === 'KeyH') hud.toggle();
    else if (code === 'Escape') {
      // ESC cofa w menu, w grze pauzuje (skills/game-ui-ux #5: wyjście zawsze)
      if (!rally.driving()) { rally.back(); rally._dirtyAll = true; }
      else loop.time.paused = !loop.time.paused;
    }
    else if (code === 'KeyR') { restartRun(); }
    else if (code === 'KeyN') {
      // Gęstość HUD-u jak w opcjach CMR: pełny -> minimalny -> wyłączony (PLAN §10).
      const m = rally.cycleMode();
      hud.boot(`HUD: ${{ FULL: 'pełny', MINIMAL: 'minimalny', OFF: 'wyłączony' }[m]}`);
      setTimeout(() => hud.boot(null), 1600);
    }
    // M = pilot w/l (the co-driver channel, docs/05 §7).
    else if (code === 'KeyM') {
      voice.muted = !voice.muted;
      hud.boot(voice.muted ? 'pilot wyciszony' : 'pilot: notatki na żywo');
      setTimeout(() => hud.boot(null), 1800);
    }
    else if (code === 'Tab') rally.moveFocus(1);
    else if (code === 'ArrowUp' && !rally.driving()) rally.moveFocus(-1);
    else if (code === 'ArrowDown' && !rally.driving()) rally.moveFocus(1);
    else if (code === 'Enter') activateMenu();
    else if (code === 'KeyQ') input.tapShift(-1);
    else if (code === 'KeyE') input.tapShift(1);
    else if (code === 'KeyT') { hud.boot('tests: run `node src/debug/tests.js` in the project shell'); setTimeout(() => hud.boot(null), 2500); }
    // Brud: X = mycie auta, V = wycieraczka (docs/04 §4.2 "czyszczenie").
    else if (code === 'KeyX') { dirt.washFull(1); hud.boot('auto umyte — guma na oponach zostaje'); setTimeout(() => hud.boot(null), 2000); }
    else if (code === 'KeyV') dirt.wipeLens();
    // L = siła brudu na obiektywie: 0.45 domyślnie, 0 = wyłączone (PLAN.md §8 #5).
    else if (code === 'KeyL') {
      settings.lensDirt = settings.lensDirt === 0.45 ? 0 : (settings.lensDirt === 0 ? 1 : 0.45);
      dirt.lens.setAmount(settings.lensDirt);
      hud.boot(`obiektyw: ${settings.lensDirt === 0 ? 'czysty' : settings.lensDirt === 1 ? 'pełny' : 'dyskretny'}`);
      setTimeout(() => hud.boot(null), 1800);
    }
    else if (code === 'KeyB') { dirt.rain(dirt.env.rain > 0 ? 0 : 0.7); }
    else if (code === 'F1') { applyDifficulty('NOVICE'); car.assists = { ...settings.assists }; }
    else if (code === 'F2') { applyDifficulty('RALLY'); car.assists = { ...settings.assists }; }
    else if (code === 'F3') { applyDifficulty('PRO'); car.assists = { ...settings.assists }; }
    else if (code === 'Digit1') { qualityPreset(QUALITY.LOW); renderer.setQuality(QUALITY.LOW); }
    else if (code === 'Digit2') { qualityPreset(QUALITY.MED); renderer.setQuality(QUALITY.MED); }
    else if (code === 'Digit3') { qualityPreset(QUALITY.HIGH); renderer.setQuality(QUALITY.HIGH); }
  });

  window.addEventListener('resize', () => renderer.onResize());

  let padsShown = true;
  function framePads() {
    const want = rally.driving();
    if (want !== padsShown) { input.touch.setVisible(want); padsShown = want; }
  }

  // ---- the loop: fixed sim, interpolated render (docs/06 §3) ----
  const loop = new FrameLoop({
    stepSim(dt) {
      car.assists = { ...settings.assists, ...(car.assistsOverride || {}) };
      // Menu screen on top = the stage clock never advances and the car is parked on
      // the handbrake, so the stage cannot start before the player presses START.
      const driving = rally.driving();
      const smp = input.sample(dt);
      if (!driving) { smp.throttle = 0; smp.brake = 0; smp.steer = 0; smp.handbrake = 1; }
      car.setInput(smp);
      const events = car.step(dt);
      for (const e of events) {
        if (e.type === 'impact') view3d.addShake(Math.min(0.6, e.impulse / 90000) * settings.cameraShake);
      }
      dirt.step(car, dt);
      // Stage clock + gates advance on the same fixed step as the physics, so the
      // stage times a replay produces are identical (PLAN.md §8 #7).
      if (driving) stageRun.step(dt, car);
      const i = stage.road.nearest(car.body.pos.x, car.body.pos.z);
      ctx.arc = i >= 0 ? stage.road.s[i] : ctx.arc;
      // Co-driver runs on the same fixed step as the physics: the note a replayed
      // drive hears is the note the first drive heard (PLAN.md §8 #7).
      if (driving) voice.advance(ctx.arc, dt);
    },
    render(alpha) {
      syncCarMesh(view, car, alpha, dirt);
      stream.update(car.body.pos, 6);
      view3d.update(car, alpha * DT + DT, settings.cameraMode);
      renderer.fitShadow(car.body.pos);
      renderer.render();
      dirt.lens.setAmount(settings.lensDirt);
      lensView.update(dirt.lens);
      lensView.draw(renderer);
    },
    onFrame(l) {
      // A throwing debug overlay must not stop the game: an exception here escapes
      // into the rAF callback and kills the loop (black viewport, HUD only).
      try {
        hud.tick(1 / 60, { ...ctx, loop: l });
        framePads();
        rally.update(1 / 60, { car, stage: stageRun, notes: notes.notes, voice, stageName });
        if (rally.pendingActivate) { rally.pendingActivate = false; activateMenu(); }
      } catch (e) {
        hud.boot(`HUD: ${e.message}`);
      }
    },
  });

  // Shot mode: run the whole drive synchronously at boot, then freeze the sim.
  // --virtual-time-budget does not drive rAF at 60 Hz on a headless box, so a
  // fixed number of *sim* steps up front is the only reproducible way to get
  // "30 s of driving" into a screenshot.
  if (cfg.frames > 0) {
    hud.boot(`tryb zrzutu: ${cfg.frames} kroków symulacji (1/120 s)\nnawierzchnia ${cfg.surfaceKey || cfg.biome}`);
    const idle = { throttle: 0, brake: 0, steer: 0, handbrake: 0, shiftUp: 0, shiftDown: 0 };
    for (let i = 0; i < cfg.frames; i++) {
      car.setInput(autoDrive(i));
      car.step(DT);
      dirt.step(car, DT);
      stageRun.step(DT, car);                 // the rally loop runs in shot mode too
      voice.advance(stageRun.arc, DT);        // so a shot shows a live pace-note sign
      if (i % 30 === 29) stream.update(car.body.pos, 60);   // keep ground under the car
      if (i % 8 === 7) dirt.frame(car);
    }
    car.setInput(idle);
    dirt.frame(car);
    // The shot only renders once, so spend the streaming budget up front: one
    // update(…, 6) per frame would leave the far ring unbuilt in the PNG.
    for (let k = 0; k < 10; k++) stream.update(car.body.pos, 120);
    // HUD shows the state the drive reached: three calls at the panel rates so the
    // 12 Hz sign strip, the 20 Hz clock and the 8 Hz lists are all flushed in the shot.
    for (let k = 0; k < 3; k++) rally.update(1 / 8, { car, stage: stageRun, notes: notes.notes, voice, stageName });
    // Shot mode doubles as the render-cost harness (docs/07 "Budżety techniczne"):
    // 36 back-to-back renders of the frozen frame give a mean/p95 for the render
    // pass, and renderer.info gives the draw-call + triangle budget check. The
    // numbers are printed into the boot overlay so a headless PNG carries them.
    loop.time.paused = true;   // the picture stays exactly where the drive ended
  }
  if (cfg.frames > 0) {
    // Per-pass cost of the new pipeline: full composite, composite without the
    // sunshafts, raw render (docs/07 "Budżety techniczne": render <= 13 ms).
    const full = renderer.measureFrame(36);
    const shaftsWas = renderer.post.shafts;
    renderer.post.shafts = false;
    const noShaft = renderer.measureFrame(36);
    renderer.post.shafts = shaftsWas;
    const postWas = renderer.post.enabled;
    renderer.post.enabled = false;
    const raw = renderer.measureFrame(36);
    renderer.post.enabled = postWas;
    renderer.render();
    const m = { mean: full.mean, p95: full.p95, noShaft: noShaft.mean, raw: raw.mean };
    window.__vrStats = m;
    const rig = renderer.rig;
    hud.boot(`render ${m.mean.toFixed(2)} ms mean / ${m.p95.toFixed(2)} p95 | bez shaft ${m.noShaft.toFixed(2)} | bez post ${m.raw.toFixed(2)} | calls ${renderer.info.calls} | tris ${renderer.info.tris} | post ${postWas ? 'on' : 'off'} | tod ${cfg.tod.toFixed(2)} exp ${rig.exposure.toFixed(2)} key ${rig.keyIntensity.toFixed(2)} amb ${rig.ambIntensity.toFixed(2)} fill ${rig.fillIntensity.toFixed(2)} elev ${rig.elevationDeg.toFixed(0)}`);
  }
  // #boot is a full-viewport opaque panel (index.html: inset 0 + background #0b0d10),
  // so leaving it up in shot mode paints over the WebGL frame and every headless
  // screenshot reads as a black viewport. The render-cost numbers stay available on
  // window.__vrStats + renderer.info for the shot harness.
  applyTouch();
  if (!cfg.autoStart) {
    // ?menu=settings / ?menu=controls otwieraja dany ekran (harness zrzutow)
    if (cfg.menuScreen === 'settings' || cfg.menuScreen === 'controls') rally.openScreen(cfg.menuScreen);
    else rally.openMenu();                             // boot -> menu, START odpala odliczanie
  }
  hud.boot(null);
  loop.attach((fn) => renderer.renderer.setAnimationLoop(fn));
  window.__rally = { car, stage, loop, settings, renderer, stream, view, dirt, lensView, stageRun, rally, ghost, notes, voice };
}

main().catch((err) => {
  const el = document.getElementById('boot');
  if (el) { el.classList.remove('hidden'); el.innerHTML = `<span class="warn">boot failed</span>\n${String(err && err.stack || err)}`; }
  console.error(err);
});
