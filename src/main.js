// Voxel Rally bootstrap: stage -> world -> car -> fixed-step loop (docs/06 §3).
// Nothing here is asset-based: the stage, the terrain, the props and the car are
// all generated from the seed at boot.
import * as THREE from 'three';

import { Renderer } from './render/renderer.js';
import { ChaseCamera } from './render/camera.js';
import { buildCarMesh, syncCarMesh } from './render/carMesh.js';
import { Streaming } from './world/streaming.js';
import { VoxelWorld, chunkKey } from './world/chunk.js';
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
import { t } from './core/i18n.js';
import { Voice } from './game/voice.js';
import { bus } from './core/events.js';
import { DirtSystem } from './dirt/dirt.js';
import { attachDirtLens } from './render/dirt-lens.js';
import { FxSystem } from './fx/fx.js';
import { BackfirePop } from './audio/backfire.js';
import { buildFxView, syncFxView } from './render/fx-view.js';
import { SURFACE_KEYS } from './world/surfaces.js';
import { FrameLoop } from './core/loop.js';
import { startPerfHarness } from './debug/perf-harness.js';
import { pregenerateStage } from './world/pregen.js';
import { MAP_CATALOG, MAP_SIZE_BUDGET, mapById, mapUrl, fetchMap, applyMap } from './world/map-load.js';
import { buildColliders } from './world/prop-colliders.js';
import { loadStageCache } from './world/stage-cache.js';
import { DT } from './core/time.js';
import { showroomConfig, showroomRoute, showroomPose } from './debug/showroom.js';
import { settings, applyDifficulty, qualityPreset, cycleDrawDistance, cycleBloom, QUALITY, loadSettings, saveSettings } from './core/settings.js';

// Boot-time yield: the loading steps hand the frame back to the browser so the
// boot text updates. In shot mode (--frames) a headless browser barely ticks
// rAF, so the yields collapse to a timer tick instead of stalling the stage.
const nextFrame = (instant) => new Promise((r) => (instant ? setTimeout(r, 0) : requestAnimationFrame(() => r())));

// Mirror a line into the hidden #perflog node the perf harness owns
// (src/debug/perf-harness.js) so `tools/perf-run.mjs` can quote the stage load time.
function perfLog(line) {
  try {
    let el = document.getElementById('perflog');
    if (!el) {
      el = document.createElement('pre');
      el.id = 'perflog';
      el.style.display = 'none';
      document.body.appendChild(el);
    }
    el.textContent += line + '\n';
  } catch (e) { /* DOM not ready: the console line is enough */ }
}

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
  // ?dirtseed=<0..1>: pin the dirt state of every panel and tyre. The showroom freezes
  // the sim, so its car is otherwise always clean and the caked-rubber skin (tyre tread
  // under crust, queue P12) could never be photographed. Debug only: absent means the
  // dirt a real drive makes.
  const dirtSeed = q.has('dirtseed') ? Math.max(0, Math.min(1, Number(q.get('dirtseed')))) : 0;
  // ?cam=CHASE|BUMPER|ONBOARD|FREE: the dirt proof needs a close view of the panels.
  const cam = (q.get('cam') || '').toUpperCase();
  // ?ref=<s> reference time for the stage (docs/03 §6 ghost is not wired yet).
  const ref = Number(q.get('ref') || 0);
  // ?tod=<0..1> time of day for the art-direction shots (PLAN §10 criterion 1/4):
  // 0.25 sunrise, 0.5 noon, 0.72 golden hour, 1 night. Default: golden hour but on
  // the HIGH side of it - the old 0.70 put the sun at 16 deg elevation, behind the
  // treeline for the whole stage (no disc, gloomy frame). 0.62 puts it at ~29 deg:
  // above the canopy, still a long warm key across the carriageway.
  const tod = q.has('tod') ? Math.max(0, Math.min(1, Number(q.get('tod')))) : 0.62;
  // ?post=0|1 turns the composite off/on (A/B shots for the pass-cost numbers).
  // Read *after* the quality preset below so the flag always wins.
  const postFlag = q.get('post');
  // ?hud=FULL|MIN|OFF: HUD density (CMR "Game Displays"), for shots and for testing.
  // Returning player first: restore the persisted payload, migrated + tagged, so an
  // old implicit steer invert can never land on top of the corrected mapping. Every
  // URL flag below wins over a stored value.
  loadSettings();
  const hudMode = (q.get('hud') || '').toUpperCase();
  if (hudMode === 'MIN' || hudMode === 'MINIMAL') settings.hudMode = 'MINIMAL';
  else if (hudMode === 'OFF') settings.hudMode = 'OFF';
  else if (hudMode === 'FULL') settings.hudMode = 'FULL';
  // ?stats=1 keeps the render-cost read-out on screen (shot-mode harness).
  const stats = q.get('stats') === '1';
  // ?perftest=1: the in-game perf harness (src/debug/perf-harness.js). Off unless the
  // flag is present, so nothing here ever runs in a normal game.
  const perftest = q.get('perftest') === '1';
  // ?steer=<-1..1> shot hook: pin an analog steer for the whole drive and hand the
  // lateral loop over to it, so a headless frame proves which way a sign turns the car.
  const steerRaw = q.get('steer');
  const steerForce = steerRaw !== null && steerRaw !== '' && Number.isFinite(Number(steerRaw))
    ? Math.max(-1, Math.min(1, Number(steerRaw))) : null;
  // ?q=LOW|MED|HIGH picks the quality preset before the renderer is built, so the
  // quality tiers are testable from a headless shot (docs/07 §Budżety).
  // ?showroom=1 (+ ?view=side|front|rear|three-quarter): the car-only debug showroom
  // (src/debug/showroom.js) framed like tools/blender/preview_model.py. Flag-gated:
  // without it every one of these fields is the normal game.
  const sheet = showroomConfig(location.search);
  const showroom = sheet.active ? showroomRoute() : null;
  if (showroom) settings.hudMode = showroom.hudMode;   // HUD off before the HUD is built
  const qName = (q.get('q') || '').toUpperCase();
  if (qName === 'LOW') qualityPreset(QUALITY.LOW);
  else if (qName === 'MED') qualityPreset(QUALITY.MED);
  else if (qName === 'HIGH') qualityPreset(QUALITY.HIGH);
  if (postFlag === '0') settings.post = false;
  else if (postFlag === '1') settings.post = true;
  // MAP: the shipped preset stage (assets/maps/<id>.rmap, src/world/map-load.js). A
  // ?map= flag wins over the persisted menu choice; an unknown id falls back to the
  // first catalog entry. '' would keep the procedural boot.
  const mapRaw = (q.get('map') || '').trim().toLowerCase();
  const mapId = MAP_CATALOG.some((m) => m.id === mapRaw) ? mapRaw
    : (MAP_CATALOG.some((m) => m.id === settings.map) ? settings.map : MAP_CATALOG[0].id);
  // ?menu=off / ?frames=N: the car drives off at boot. ?shot=1 only makes the boot
  // fast for the headless harness - the menu still owns the first screen, so nothing
  // drives until START.
  const autoStart = frames > 0 || perftest || q.get('menu') === 'off';
  const shotBoot = autoStart || q.get('shot') === '1';
  const menuScreen = q.get('menu') && q.get('menu') !== 'off' ? q.get('menu') : '';
  return {
    seed, biome: BIOME_INFO[biome] ? biome : 'FOREST', carId, lengthTarget: len, mapId,
    autoStart, shotBoot, menuScreen,
    hasTod: q.has('tod'),
    surfaceId: SURFACE_KEYS[surfaceKey] !== undefined ? SURFACE_KEYS[surfaceKey] : null,
    surfaceKey, frames, rain, dirtSeed, cam, ref, tod, stats, perftest, steerForce,
    showroom: !!showroom, viewName: sheet.view, sheet,
  };
}

/**
 * Boot a shipped preset map: fetch assets/maps/<id>.rmap and let the loader fill the
 * world (terrain data, road table, surfaces, prop placements, gates). Nothing is
 * generated here - the file already holds all of it. null = the file is missing, over
 * budget or failed its magic/version/checksum, and the caller falls back to the
 * procedural boot (with a loud warning).
 */
async function loadMapStage(cfg, hud) {
  const entry = mapById(cfg.mapId);
  if (!entry) return null;
  hud.boot(`VOXEL RALLY\n${entry.name}\n${t('boot.map')}`);
  await nextFrame(cfg.shotBoot);
  const t0 = performance.now();
  const f = await fetchMap(cfg.mapId);
  const loadMs = performance.now() - t0;
  if (!f || !f.bytes || !f.bytes.length) {
    console.warn(`[map] ${mapUrl(entry.id)} is not reachable: ${t('boot.mapFallback')}`);
    hud.boot(`VOXEL RALLY\n${entry.name}\n${t('boot.mapFallback')}`);
    return null;
  }
  if (f.bytes.length > MAP_SIZE_BUDGET) {
    console.warn(`[map] ${mapUrl(entry.id)} is ${(f.bytes.length / 1e6).toFixed(1)} MB, over the `
      + `${(MAP_SIZE_BUDGET / 1e6).toFixed(0)} MB budget: ${t('boot.mapFallback')}`);
    hud.boot(`VOXEL RALLY\n${entry.name}\n${t('boot.mapFallback')}`);
    return null;
  }
  const world = new VoxelWorld(entry.seed);
  let lastPct = 0;
  const res = applyMap(world, f.bytes, { onProgress: (done) => {
    const pct = Math.round(done / (f.bytes.length / 1400));   // ~64 chunks per 1400 B
    if (pct !== lastPct) {
      lastPct = pct;
      hud.boot(`VOXEL RALLY\n${entry.name}\n${t('boot.mapPct', done)}\n${Math.min(100, pct)} %`);
    }
  } });
  if (!res) {
    console.warn(`[map] ${mapUrl(entry.id)} failed magic/version/checksum: ${t('boot.mapFallback')}`);
    hud.boot(`VOXEL RALLY\n${entry.name}\n${t('boot.mapFallback')}`);
    return null;
  }
  await nextFrame(cfg.shotBoot);
  const carveIndex = buildCarveIndex(res.road);
  // Every chunk the file covers gets a prop list, even an empty one: past the bake's
  // PROP_REACH the runtime scatter would otherwise re-plant props while driving, which
  // is exactly the generation this path is meant to remove.
  for (const c of world.chunks.values()) {
    const k = chunkKey(c.cx, c.cz);
    if (!res.propTables.has(k)) res.propTables.set(k, []);
  }
  const biome = res.meta.biome || entry.biome;
  // The shipped file is a CORRIDOR along the whole route (near band fully authored, far
  // band heightfield + far vegetation), not a disc around the start, so the streaming
  // reach is no longer clamped to a bake radius: drawDistance and fog follow the
  // settings again. Jobs that fall outside the authored corridor are skipped, never
  // generated (src/world/streaming.js), so stream.stats.generated (perf `gen=`) stays 0.
  const cov = res.meta.coverage || { near: entry.nearRadius, far: entry.farRadius };
  console.log(`[map] ${entry.id} ${entry.name}: ${(f.bytes.length / 1e6).toFixed(2)} MB in `
    + `${loadMs.toFixed(0)} ms · ${res.stats.chunks} chunks (${res.stats.near} near + ${res.stats.far} far) · `
    + `${res.stats.props} props · `
    + `${res.stats.tiles} tiles · road ${res.road.length.toFixed(0)} m · corridor ${cov.near}/${cov.far} m`);
  // Scenery is solid (src/world/prop-colliders.js): the authored prop list becomes a
  // chunk-keyed collider grid once, here at load, and the physics step queries it.
  const propColliders = buildColliders(res.propTables);
  console.log(`[props] colliders ${propColliders.count} solid / ${propColliders.props} props `
    + `(${propColliders.skipped} non-solid, ${propColliders.fences} fence links) in ` 
    + `${propColliders.builtMs.toFixed(1)} ms over ${propColliders.cells} cells`);
  return {
    seed: entry.seed, biome, world, road: res.road, gates: res.gates, carveIndex,
    propColliders,
    roadLength: res.road.length, propTables: res.propTables, tileTables: res.tileTables,
    preGen: true, mapEntry: entry, mapCoverage: cov,
    mapStats: { chunks: res.stats.chunks, near: res.stats.near, far: res.stats.far, filled: 0, carved: 0, props: res.stats.propLists, tiles: res.stats.tileLists, bytes: f.bytes.length, loadMs },
    // No terrain generator on this path: every chunk the loader filled is already
    // `generated` + `carved`, so Streaming never asks for one. A call here would be a
    // hole in the file, and it says so instead of quietly generating a second world.
    terrain: {
      seed: entry.seed, biome, heightAt: () => 0,
      generateChunk: (w, cx, cz) => {
        console.warn(`[map] ${entry.id}: chunk ${cx},${cz} is outside the baked coverage - not generated`);
      },
    },
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

// Stage names go through the translation layer (src/core/i18n.js): English default,
// Polish one tap away. Resolved per call, so a LANGUAGE switch re-labels the menu and
// the stage title on the next boot; an unknown biome falls back to its raw id.
const stageLabel = (b) => { const k = 'stage.' + String(b).toLowerCase(); const s = t(k); return s === k ? String(b) : s; };

async function main() {
  const hud = new Hud();
  const cfg = params();
  // Preset map first: when one is selected the stage comes out of the file. A missing
  // or corrupt file falls back to the procedural boot below, warning loudly.
  let stage = cfg.showroom ? null : await loadMapStage(cfg, hud);
  if (!stage) stage = await generateStage(cfg, hud);
  const worldBiome = stage.biome || cfg.biome;

  const canvas = document.getElementById('c');
  const renderer = new Renderer(canvas);
  // No streaming reach clamp: the shipped map is authored as a corridor along the whole
  // route, so drawDistance and fog are the player's settings at every metre of it.
  renderer.setBiome(BIOME_INFO[worldBiome] || BIOME_INFO[cfg.biome], worldBiome);
  // Pora dnia i pogoda to feature of the stage (PLAN §10.2); ?tod= only overrides it
  // for art-direction shots.
  const climate = stage.road.climate || { tod: cfg.tod, wet: 0, haze: 1, weather: 0 };
  renderer.setTimeOfDay(cfg.hasTod ? cfg.tod : climate.tod);
  renderer.setClimate(climate);
  renderer.setQuality(settings.quality);
  if (cfg.cam) settings.cameraMode = cfg.cam;

  const stream = new Streaming(stage.world, stage.terrain, stage.road, stage.carveIndex, renderer, stage);

  // ---- stage pre-generation: the loading screen is a real load, not a splash ----
  // Heightfield + surface ids for every chunk the draw distance can ask for, the road
  // carve silhouette, the prop list and the block tile list are all built here, in
  // bounded slices with progress, before the first frame is drawn. A cache generated
  // offline (tools/gen-stage-cache.mjs -> assets/world/stage-<seed>-<biome>.bin) is
  // used when it exists for this exact seed + biome; a missing file or a mismatched
  // seed falls back to generating the same data now. After either path Streaming only
  // ever builds and destroys render geometry, never terrain data.
  const loadT0 = performance.now();
  // Showroom: the world is never streamed, so it is never loaded or generated either.
  // A loaded map is already the whole stage: no cache read, no generation pass.
  const cached = (cfg.showroom || stage.mapEntry) ? null : await loadStageCache(stage.world, cfg.seed, cfg.biome);
  hud.boot(cached
    ? `VOXEL RALLY\nseed ${cfg.seed}  biome ${cfg.biome}\n${t('boot.cached')}\n${(cached.bytes / 1e6).toFixed(1)} ${t('boot.megabytes')} · ${cached.chunks} ${t('boot.chunks')}`
    : `VOXEL RALLY\nseed ${cfg.seed}  biome ${cfg.biome}\n${t('boot.generate')}`);
  await nextFrame(cfg.shotBoot);
  const pre = stage.mapEntry ? stage.mapStats
    : cfg.showroom ? { chunks: 0, filled: 0, carved: 0, props: 0, tiles: 0 }
    : await pregenerateStage(stream, settings.drawDistance, {
    yieldFn: () => nextFrame(cfg.shotBoot),
    onProgress: (p, done, total) => hud.boot(
      `VOXEL RALLY\nseed ${cfg.seed}  biome ${cfg.biome}\n`
      + t(cached ? 'boot.cachedPct' : 'boot.generatePct', Math.round(p * 100)) + '\n'
      + `${done} / ${total} ${t('boot.chunks')}`,
    ),
  });
  const loadS = (performance.now() - loadT0) / 1000;
  const loadLine = `[stage] ${stage.mapEntry ? `map ${stage.mapEntry.id} (${(stage.mapStats.bytes / 1e6).toFixed(2)} MB, ${stage.mapStats.loadMs.toFixed(0)} ms)` : cached ? `cache ${cached.url}` : 'generated'} · ${pre.chunks} chunks `
    + `(${pre.filled} terrain, ${pre.carved} carve) · ${pre.props} prop lists · ${pre.tiles} tile lists `
    + `· load ${loadS.toFixed(1)} s`;
  console.log(loadLine);
  perfLog(loadLine);
  // Shim for a carry-over bug in world/chunk.js: surfaceAt/rutAt index the column
  // with a *fractional* local offset (x - cx*CHUNK), so at any real contact point
  // they return undefined and every wheel reads the 'unknown' surface. Fixed here
  // with a prototype-derived view instead of editing chunk.js (owned by F1): the
  // car gets the same object, only those two lookups are floored.
  const carWorld = Object.create(stage.world);
  carWorld.surfaceAt = (x, z) => stage.world.surfaceAt(Math.floor(x), Math.floor(z));
  carWorld.rutAt = (x, z) => stage.world.rutAt(Math.floor(x), Math.floor(z));
  const car = new Vehicle(cfg.carId, carWorld, { assists: { ...settings.assists } });
  car.setPropColliders(stage.propColliders);
  const dirt = new DirtSystem();
  dirt.rain(cfg.rain);
  if (cfg.dirtSeed > 0) dirt.seedPanels(cfg.dirtSeed);
  const view = buildCarMesh(car, dirt);
  renderer.scene.add(view.group);
  // ---- particle FX (src/fx): backfire plumes off the two exhaust nodes, wheel
  //      dust, treeline leaves, dust motes. One switch for weak devices: OFF with
  //      `fx`, and `fxScale` cuts the pool capacity. Desktop runs the full field,
  //      a coarse-pointer device starts on at half capacity.
  if (typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches && settings.fxScale > 0.5) settings.fxScale = 0.5;
  const fx = new FxSystem({ scale: settings.fxScale, bus, enabled: settings.fx !== false });
  fx.setLocalTips(view.exhaustLocal);
  fx.env.trees = (BIOME_INFO[cfg.biome] && BIOME_INFO[cfg.biome].trees) || 0;
  fx.env.rain = cfg.rain || 0;
  fx.env.sun = Math.max(0.15, 1 - Math.abs((cfg.hasTod ? cfg.tod : climate.tod) - 0.5) * 1.9);
  const fxView = buildFxView(fx);
  renderer.scene.add(fxView.group);
  // The sound half of the same backfire (docs/05 §5, queue P13): the gearbox shouts
  // 'shift' on the bus, src/fx turns it into flames and this turns it into a short
  // synthesized crack. One gate (fx.js shiftPop) and one switch (settings.fx, read at
  // pop time), so the EFEKTY row can never leave a bang behind the flames. The graph is
  // built lazily at the first pop, so a stage that never shifts pays nothing.
  const backfire = new BackfirePop({ bus, settings, engine: car.params.engine });
  backfire.arm(window);
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
  const stageName = `${t('hud.stage')} ${stageLabel(worldBiome).toUpperCase()} · ${t('hud.gravel')} · ${cfg.seed}`;
  const rally = new RallyHud(document, {
    bus,
    stages: BIOMES.map((b) => ({ key: b, label: stageLabel(b) })),
    // MAP row: the shipped stage plus its length and dominant surface, so the choice is
    // readable without loading it first. One DOM hit box per row (touch) as always.
    maps: MAP_CATALOG.map((m) => ({ key: m.id, label: `${m.name} · ${m.lengthTarget} m · ${m.surface}` })),
  });
  rally.stageIdx = Math.max(0, BIOMES.indexOf(cfg.biome));
  rally.mapIdx = Math.max(0, MAP_CATALOG.findIndex((m) => m.id === cfg.mapId));
  function restartRun() {
    // Rolled over: RESET rights the car where it lies instead of re-placing it at the
    // start line. The stage clock keeps running and the damage already taken stands, so
    // the recovery costs real time rather than buying a free re-run. 0.35 s is the
    // "instantly" the player asked for, still a slerp so it reads as motion.
    if (car.rolled()) { car.rightNow(0.35); return; }
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
    // MAP row: the cycle itself is the HUD's; the choice is persisted here and takes
    // effect on START (which reloads with ?map=, same as the STAGE row).
    else if (it.act === 'map') { settings.map = rally.mapKey(); saveSettings(); }
    else if (it.act === 'toggle:blockTiles') settings.blockTiles = !settings.blockTiles;
    // EFEKTY row: the particle field switch (src/fx). fx.step() emits and ages nothing
    // while disabled and render/fx-view.js hides the pools, so this is one flag.
    else if (it.act === 'toggle:fx') {
      settings.fx = !settings.fx;
      fx.enabled = settings.fx;
    }
    else if (it.act === 'toggle:showCoDriverArrows') {
      settings.showCoDriverArrows = !settings.showCoDriverArrows;
      rally.arrows = settings.showCoDriverArrows;
    } else if (it.act === 'cycle:touchOverlay') {
      const order = ['auto', 'on', 'off'];
      settings.touchOverlay = order[(order.indexOf(settings.touchOverlay) + 1) % order.length];
      applyTouch();
    } else if (it.act === 'cycle:touchHandedness') {
      settings.touchHandedness = settings.touchHandedness === 'left' ? 'right' : 'left';
      input.touch.setHandedness(settings.touchHandedness);
    } else if (it.act === 'cycle:invertSteer') {
      // KIEROWNICA NORMALNA <-> ODWROTNA. input.sample() re-reads this every frame, so
      // it is live; saveSettings() writes it explicitly so no stored payload can ever
      // hold it implicitly again.
      settings.invertSteer = !settings.invertSteer;
      hud.boot(t('toast.steer', t(settings.invertSteer ? 'val.steerInvert' : 'val.steerNormal')));
      setTimeout(() => hud.boot(null), 1800);
    } else if (it.act === 'cycle:drawDistance') {
      // 400 -> 700 -> 1000 -> 1600 -> wrap. setQuality() re-derives fog (from the new
      // drawDistance) and the camera far plane; Streaming re-rings the chunks by itself
      // on the next update, remeshing only what changes band.
      cycleDrawDistance();
      renderer.setQuality(settings.quality);
    } else if (it.act === 'toggle:farDetail') {
      settings.farDetail = !settings.farDetail;
      renderer.setQuality(settings.quality);
    } else if (it.act === 'toggle:post') {
      settings.post = !settings.post;
      renderer.setQuality(settings.quality);
    } else if (it.act === 'cycle:bloom') {
      cycleBloom();
      renderer.setQuality(settings.quality);
    } else if (it.act === 'toggle:grade') {
      settings.grade = !settings.grade;
      renderer.setQuality(settings.quality);
    } else if (it.act === 'quality') {
      const q = (settings.quality + 1) % 3;
      qualityPreset(q);
      renderer.setQuality(q);
    }
    rally.refreshMenu();          // a toggle row re-labels itself (wł./wył.)
    if (/^(toggle:|cycle:|quality$)/.test(it.act)) saveSettings();   // persist immediately
  }
  // START: a different etap means a different stage, so reload with ?biome=... and
  // land straight in the countdown; otherwise the frozen clock just starts running.
  function startRun() {
    const want = rally.stageKey();
    const wantMap = rally.mapKey();
    if (wantMap && wantMap !== cfg.mapId) {
      const u = new URL(location.href);
      u.searchParams.set('map', wantMap);
      u.searchParams.delete('shot'); u.searchParams.delete('frames'); u.searchParams.delete('menu');
      location.href = u.href;
      return;
    }
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
    // The HUD lifts its bottom panels by exactly what the overlay costs, which the
    // layout model reports (src/game/touch-layout.js) instead of a bare 240.
    rally.setTouchInset(input.touch.enabled ? input.touch.band() : 0);   // HUD podnosi dolne panele
  }

  // A few metres along the arc: at arc 0 the rear axle still straddles the uncarved terrain behind the start line.
  const startIdx = 12;
  const startYaw = -stage.road.heading[startIdx];
  function resetCar() {
    if (cfg.showroom) {
      // Showroom: a flat pad at the origin, not the start line.
      car.placeAt(0, 0, 0, 0);
      car.wheels.forEach((w) => { w.omega = 0; });
      return;
    }
    car.placeAt(stage.road.x[startIdx], stage.road.z[startIdx], startYaw, stage.road.h[startIdx]);
    car.wheels.forEach((w) => { w.omega = 0; });
  }
  resetCar();

  // ---- debug showroom (?showroom=1): pad + fixed sheet camera, world never drawn ----
  const padMesh = cfg.showroom ? buildShowroomPad() : null;
  if (padMesh) renderer.scene.add(padMesh);
  const _box = new THREE.Box3();
  let sheetPose = null;
  function sheetCamera() {
    if (!sheetPose) {
      _box.makeEmpty();
      _box.expandByObject(view.group);
      sheetPose = showroomPose(cfg.viewName, {
        min: { x: _box.min.x, y: _box.min.y, z: _box.min.z },
        max: { x: _box.max.x, y: _box.max.y, z: _box.max.z },
      }, renderer.camera.aspect || 16 / 9, (cfg.sheet && cfg.sheet.dist) || 0);
      // The sheet's 45 mm lens on a 36 mm sensor, converted to three's vertical fov.
      renderer.camera.fov = sheetPose.fovDeg;
      renderer.camera.updateProjectionMatrix();
      console.log(`[showroom] view ${sheetPose.view} dist ${sheetPose.dist.toFixed(2)} m `
        + `cam ${sheetPose.pos.x.toFixed(2)},${sheetPose.pos.y.toFixed(2)},${sheetPose.pos.z.toFixed(2)} `
        + `look ${sheetPose.look.x.toFixed(2)},${sheetPose.look.y.toFixed(2)},${sheetPose.look.z.toFixed(2)} fov ${sheetPose.fovDeg.toFixed(1)}`);
    }
    const cam = renderer.camera;
    cam.up.set(0, 1, 0);
    cam.position.set(sheetPose.pos.x, sheetPose.pos.y, sheetPose.pos.z);
    cam.lookAt(sheetPose.look.x, sheetPose.look.y, sheetPose.look.z);
  }

  const ctx = { car, stream, stage, input, hud, arc: 0, dirt, renderer };
  // Fixed-frame driver for the screenshots (?frames=...): the same code path the
  // real loop uses, so the dirt in the PNG is the dirt the game would have made.
  const driveIn = { throttle: 0, brake: 0, steer: 0, handbrake: 0, shiftUp: 0, shiftDown: 0 };
  let stuckDrive = 0;
  let simTick = 0;                    // perftest only: step counter for the pilot
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

  // ?steer= shot hook: the pure-pursuit driver writes driveIn.steer (line 285) and so
  // overwrites anything else a shot tried to force. Pinning it here, with the driver's
  // own throttle/brake/handbrake kept, is the only way to get "steer = -0.8 all the way
  // down the straight" into a reproducible frame.
  function pilot(i) {
    const p = autoDrive(i);
    if (cfg.steerForce !== null) { p.steer = cfg.steerForce; p.handbrake = 0; }
    return p;
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
    // KeyP = touch pad MENU (and the keyboard equivalent): the only way back to the
    // menu without a keyboard. openMenu() pushes a menu screen, so driving() goes
    // false and the stage clock + car freeze the same way as on any menu screen.
    else if (code === 'KeyP') { if (rally.driving()) rally.openMenu(); else rally.back(); }
    else if (code === 'KeyN') {
      // Gęstość HUD-u jak w opcjach CMR: pełny -> minimalny -> wyłączony (PLAN §10).
      const m = rally.cycleMode();
      hud.boot(t('toast.hud', t({ FULL: 'val.hudFull', MINIMAL: 'val.hudMinimal', OFF: 'val.hudOff' }[m])));
      setTimeout(() => hud.boot(null), 1600);
    }
    // M = pilot w/l (the co-driver channel, docs/05 §7).
    else if (code === 'KeyM') {
      voice.muted = !voice.muted;
      hud.boot(t(voice.muted ? 'toast.notesOff' : 'toast.notesOn'));
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
    else if (code === 'KeyX') { dirt.washFull(1); hud.boot(t('toast.wash')); setTimeout(() => hud.boot(null), 2000); }
    else if (code === 'KeyV') dirt.wipeLens();
    // Particle FX (src/fx) has no key: P above is the menu/pause key, and the FX branch
    // that used to sit here was a second `KeyP` in the same if-chain, i.e. dead code that
    // never ran. The switch is the EFEKTY row in Ustawienia (activateMenu) plus the
    // persisted settings.fx, which the render loop re-reads every frame.
    // L = siła brudu na obiektywie: 0.45 domyślnie, 0 = wyłączone (PLAN.md §8 #5).
    else if (code === 'KeyL') {
      settings.lensDirt = settings.lensDirt === 0.45 ? 0 : (settings.lensDirt === 0 ? 1 : 0.45);
      dirt.lens.setAmount(settings.lensDirt);
      hud.boot(t('toast.lens', t(settings.lensDirt === 0 ? 'val.lensClean' : settings.lensDirt === 1 ? 'val.lensFull' : 'val.lensSoft')));
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

  window.addEventListener('resize', () => { renderer.onResize(); applyTouch(); });

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
      if (!driving && !cfg.perftest) { smp.throttle = 0; smp.brake = 0; smp.steer = 0; smp.handbrake = 1; }
      if (cfg.steerForce !== null && driving) {   // ?steer= live hook
        smp.steer = cfg.steerForce;
        if (!smp.throttle && !smp.brake) smp.throttle = 0.85;
      }
      if (cfg.perftest) {                          // harness pilot, flag-gated
        simTick++;
        const p = autoDrive(simTick);
        p.handbrake = 0;
        car.setInput(p);
      } else car.setInput(smp);
      const events = car.step(dt);
      // Only a real landing moves the camera. The solver emits an `impact` every
      // substep a corner is unloading (impulse ~3e3 N at 4 m/s), which used to pin
      // `shake` at its cap on flat road; 18 kN is below anything but a jump.
      for (const e of events) {
        if (e.type === 'impact' && e.impulse > 18000) {
          view3d.addShake(Math.min(0.45, (e.impulse - 18000) / 130000) * settings.cameraShake);
        } else if (e.type === 'propHit') {
          // Scenery contact: the same shake budget as a landing, and the existing
          // wheel-dust field gets a kick so the hit is visible as well as audible.
          view3d.addShake(Math.min(0.45, e.impulse / 90000) * settings.cameraShake);
          fx.ambient.bumpDust(6 + Math.round(e.speed * 2));
        }
      }
      dirt.step(car, dt);
      // FX run on the fixed sim clock, so the plume and the dust field come out
      // identical at 30 and at 144 fps (docs/06 §3). Allocation-free in steady state.
      fx.env.wind = dirt.env.wind || 3;
      fx.env.rain = dirt.env.rain || 0;
      fx.step(dt, car, smp.throttle);
      // Stage clock + gates advance on the same fixed step as the physics, so the
      // stage times a replay produces are identical (PLAN.md §8 #7).
      if (driving || cfg.perftest) stageRun.step(dt, car);
      const i = stage.road.nearest(car.body.pos.x, car.body.pos.z);
      ctx.arc = i >= 0 ? stage.road.s[i] : ctx.arc;
      if (driving) {
        // Co-driver runs on the same fixed step as the physics: the note a replayed
        // drive hears is the note the first drive heard (PLAN.md §8 #7).
        // Rolled over, the channel is muted for the duration - the cursor still walks,
        // so the first note after the recovery is the one the road is actually asking
        // for. The player's own M mute is restored, never overwritten.
        const wasMuted = voice.muted;
        if (car.rolled()) voice.muted = true;
        voice.advance(ctx.arc, dt);
        voice.muted = wasMuted;
      }
    },
    render(alpha, frameDt) {
      syncCarMesh(view, car, alpha, dirt);
      fx.enabled = settings.fx !== false;
      syncFxView(fxView, fx, fx.env);
      if (!cfg.showroom) stream.update(car.body.pos, 6);
      // Camera smoothing runs on the frame's (already clamped) dt, not on a fixed
      // DT per rendered frame: at 120 Hz a per-frame DT advanced the springs twice
      // as much wall-clock time as at 60 Hz.
      if (cfg.showroom) sheetCamera();
      else view3d.update(car, frameDt || DT, settings.cameraMode);
      // The composer owns the edge radial blur and the far-field depth of field, and
      // only ever sees a speed and a focus distance, so the frame loop is the one
      // place that pushes both (post.setSpeed / post.setFocus).
      if (renderer.post && renderer.post.setSpeed) renderer.post.setSpeed(car.body.groundSpeed);
      if (renderer.post && renderer.post.setFocus) {
        renderer.post.setFocus(renderer.camera.position.distanceTo(car.body.pos));
      }
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
        // HUD/menu timers run on accumulated SIM time, never on a per-frame 1/60:
        // a 120 Hz display used to fade menus and tick the stage clock twice as fast.
        const simDt = l.time.frameSimDt;
        hud.tick(simDt, { ...ctx, loop: l });
        framePads();
        rally.update(simDt, { car, stage: stageRun, notes: notes.notes, voice, stageName });
        if (rally.pendingActivate) { rally.pendingActivate = false; activateMenu(); }
      } catch (e) {
        hud.boot(`HUD: ${e.message}`);
      }
    },
  });

  // ?perftest=1: the in-game perf harness. Flag-gated, so a normal boot never
  // wraps the loop and never logs.
  if (cfg.perftest) {
    // Prime the chunk cache before the harness clock starts, otherwise the 10/30/60 s
    // marks measure the cache filling up rather than steady-state driving.
    for (let k = 0; k < 12; k++) stream.update(car.body.pos, 120);
    startPerfHarness({ loop, renderer, stream, dirt, carGroup: view.group });
  }

  // Shot mode: run the whole drive synchronously at boot, then freeze the sim.
  // --virtual-time-budget does not drive rAF at 60 Hz on a headless box, so a
  // fixed number of *sim* steps up front is the only reproducible way to get
  // "30 s of driving" into a screenshot.
  // ---- showroom boot: nothing drives, nothing streams, the sim stays frozen ----
  if (cfg.showroom) {
    car.setInput({ throttle: 0, brake: 0, steer: 0, handbrake: 1, shiftUp: 0, shiftDown: 0 });
    dirt.frame(car);
    syncCarMesh(view, car, 0, dirt);
    sheetCamera();
    renderer.fitShadow(car.body.pos);
    renderer.render();
    loop.time.paused = true;
  }
  if (cfg.frames > 0 && !cfg.perftest && !cfg.showroom) {
    hud.boot(`${t('toast.shot', cfg.frames)}\n${t('boot.surface')} ${cfg.surfaceKey || cfg.biome}`);
    const idle = { throttle: 0, brake: 0, steer: 0, handbrake: 0, shiftUp: 0, shiftDown: 0 };
    for (let i = 0; i < cfg.frames; i++) {
      car.setInput(pilot(i));
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
    if (!cfg.showroom) for (let k = 0; k < 10; k++) stream.update(car.body.pos, 120);
    // HUD shows the state the drive reached: three calls at the panel rates so the
    // 12 Hz sign strip, the 20 Hz clock and the 8 Hz lists are all flushed in the shot.
    for (let k = 0; k < 3; k++) rally.update(1 / 8, { car, stage: stageRun, notes: notes.notes, voice, stageName });
    // Shot mode doubles as the render-cost harness (docs/07 "Budżety techniczne"):
    // 36 back-to-back renders of the frozen frame give a mean/p95 for the render
    // pass, and renderer.info gives the draw-call + triangle budget check. The
    // numbers are printed into the boot overlay so a headless PNG carries them.
    loop.time.paused = true;   // the picture stays exactly where the drive ended
  }
  if (cfg.frames > 0 && !cfg.perftest && !cfg.showroom) {
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
  if (!cfg.autoStart && !cfg.showroom) {
    // ?menu=settings / ?menu=controls otwieraja dany ekran (harness zrzutow)
    if (cfg.menuScreen === 'settings' || cfg.menuScreen === 'controls') rally.openScreen(cfg.menuScreen);
    else rally.openMenu();                             // boot -> menu, START odpala odliczanie
  }
  hud.boot(null);
  // The shot's HUD flush above runs inside one synchronous boot task, and the shot
  // loop is paused from then on, so the HUD canvas is never presented on a compositor
  // frame: every ?frames= PNG came back with NO HUD at all (no countdown modal, no
  // meta strip, no pace boards, no locator bar). Draw the panels again from a real
  // animation frame so the layer is committed before the screenshot.
  if (cfg.frames > 0 && !cfg.perftest && !cfg.showroom && typeof requestAnimationFrame === 'function') {
    const flush = () => {
      rally.update(1 / 8, { car, stage: stageRun, notes: notes.notes, voice, stageName });
      rally.update(1 / 8, { car, stage: stageRun, notes: notes.notes, voice, stageName });
    };
    requestAnimationFrame(() => requestAnimationFrame(flush));
  }
  loop.attach((fn) => renderer.renderer.setAnimationLoop(fn));
  window.__rally = { car, stage, loop, settings, renderer, stream, view, dirt, lensView, stageRun, rally, ghost, notes, voice, fx, fxView, backfire, showroom: cfg.showroom ? { view: cfg.viewName, pose: () => sheetPose } : null };
}

// The showroom's flat pad: a plain quad under the car, no chunks, no props. The dirt
// road colour from the design sheet (preview_model.py "stage_dirt") so the pad reads
// the same in both renders.
function buildShowroomPad() {
  const g = new THREE.PlaneGeometry(60, 60, 1, 1);
  g.rotateX(-Math.PI / 2);
  const m = new THREE.MeshStandardMaterial({ color: new THREE.Color(0.115, 0.078, 0.048), roughness: 0.95, metalness: 0 });
  const mesh = new THREE.Mesh(g, m);
  mesh.receiveShadow = true;
  mesh.name = 'showroom-pad';
  return mesh;
}

main().catch((err) => {
  const el = document.getElementById('boot');
  if (el) { el.classList.remove('hidden'); el.innerHTML = `<span class="warn">boot failed</span>\n${String(err && err.stack || err)}`; }
  console.error(err);
});
