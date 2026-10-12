// VOXEL RALLY — main game orchestration.
// State machine: menu (orbit backdrop) / countdown / race / pause /
// finished / results. Physics runs on a fixed 1/120 step.

import * as THREE from 'three';
import { generateStage, STAGES } from './world/stage.js';
import { meshChunk, chunkGeometry, CHUNK } from './world/mesher.js';
import { createAtlasTexture } from './world/textures.js';
import { atlasMaterial } from './render/voxel.js';
import { buildPropsGeometry } from './render/props.js';
import { buildCar, LIVERIES } from './render/car.js';
import { buildSky, todPreset } from './render/sky.js';
import { buildFarGeometry, farMaterial } from './render/far.js';
import { DustSystem } from './render/particles.js';
import { createCar, stepCar } from './car/physics.js';
import { SURFACE, SURFACE_DUST, isRoadSurface } from './world/tiles.js';
import { GameAudio } from './game/audio.js';
import { Input } from './game/input.js';

const $ = (id) => document.getElementById(id);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const angNorm = (a) => ((a + Math.PI * 3) % (Math.PI * 2)) - Math.PI;

function fmtTime(t) {
  if (t == null || !Number.isFinite(t)) return '--:--.-';
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${m}:${s.toFixed(1).padStart(4, '0')}`;
}
function fmtDelta(d) {
  return `${d <= 0 ? '-' : '+'}${Math.abs(d).toFixed(1)}`;
}

// ---------- persistent settings / selection ----------
const store = {
  get(k, d) { try { const v = localStorage.getItem('voxelRally2.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('voxelRally2.' + k, JSON.stringify(v)); } catch { /* noop */ } },
};
const settings = {
  quality: store.get('quality', null) ?? (() => {
    // First run: phones and small touch screens default to Low so the
    // frame rate stays smooth; everything else gets Medium.
    const coarse = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
    const small = Math.min(window.innerWidth, window.innerHeight) < 520;
    return coarse && small ? 'low' : 'med';
  })(),
  sound: store.get('sound', true),
};
const QUALITY = {
  low: { view: 95, shadow: 1024, dust: 0.45, pixel: 1 },
  med: { view: 140, shadow: 2048, dust: 1, pixel: 1.5 },
  high: { view: 205, shadow: 2048, dust: 1.6, pixel: 2 },
};
const sel = {
  stageId: store.get('stageId', 'finland'),
  tod: store.get('tod', 'auto'),
  biome: store.get('biome', 'forest'),
  length: store.get('length', 'medium'),
  seed: store.get('seed', 7),
  livery: store.get('livery', 0),
};
const bestKey = () => (sel.stageId ? `best.stage.${sel.stageId}` : `best.${sel.biome}.${sel.length}.${sel.seed}`);

// ---------- renderer / scene ----------
let renderer;
try {
  renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
} catch (e) {
  $('load-label').textContent = 'WebGL is not available in this browser.';
  $('loading').classList.add('on');
  throw e;
}
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.12;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
$('app').appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(62, 1, 0.1, 4200);
camera.rotation.order = 'YXZ';

const hemi = new THREE.HemisphereLight(0xbfd8ff, 0x54503c, 0.85);
scene.add(hemi);
const sun = new THREE.DirectionalLight(0xfff2d8, 2.0);
sun.castShadow = true;
sun.shadow.camera.left = -58; sun.shadow.camera.right = 58;
sun.shadow.camera.top = 58; sun.shadow.camera.bottom = -58;
sun.shadow.camera.near = 5; sun.shadow.camera.far = 260;
sun.shadow.bias = -0.0006;
sun.shadow.normalBias = 0.02;
scene.add(sun); scene.add(sun.target);

const atlasTex = createAtlasTexture(THREE);
const terrainMat = atlasMaterial(THREE, atlasTex);
const propsMat = atlasMaterial(THREE, atlasTex);

const audio = new GameAudio();
audio.setMuted(!settings.sound);
const input = new Input();
const steerState = { value: 0 };

// ---------- world state ----------
let stage = null;
let worldGroup = null;
let skyObj = null;
let worldKey = '';
let carMesh = null;
let carState = null;
let dust = null;
let currentTod = todPreset('day');
let dirtDist = 0;
const stageActuals = new Map(); // stageId -> { km, cps } once generated

const selectionKey = () => (sel.stageId ? `stage:${sel.stageId}` : `free:${sel.biome}|${sel.length}|${sel.seed}`);
const effectiveTodKey = () => (sel.tod === 'auto' ? (stage ? stage.tod : 'day') : sel.tod);

// ---------- chunk streaming ----------
// Detailed voxel chunks exist only around the camera focus; the far
// shell covers everything beyond. Build queue is distance sorted and
// processed a couple of chunks per frame to avoid hitches.
const chunkMap = new Map(); // "cx,cz" -> { terrain, props|null }
let streamQueue = [];
const chunkKeyOf = (cx, cz) => `${cx},${cz}`;

function buildChunkNow(cx, cz) {
  const key = chunkKeyOf(cx, cz);
  if (chunkMap.has(key)) return;
  const geo = chunkGeometry(THREE, meshChunk(stage, cx, cz));
  const terrain = new THREE.Mesh(geo, terrainMat);
  terrain.receiveShadow = true;
  terrain.matrixAutoUpdate = false;
  worldGroup.add(terrain);
  let propsMesh = null;
  const list = stage.propsByChunk.get(key);
  if (list && list.length) {
    propsMesh = new THREE.Mesh(buildPropsGeometry(stage, THREE, list), propsMat);
    propsMesh.castShadow = true;
    propsMesh.receiveShadow = true;
    propsMesh.matrixAutoUpdate = false;
    worldGroup.add(propsMesh);
  }
  chunkMap.set(key, { terrain, props: propsMesh });
}

function disposeChunk(key) {
  const entry = chunkMap.get(key);
  if (!entry) return;
  for (const m of [entry.terrain, entry.props]) {
    if (!m) continue;
    worldGroup.remove(m);
    m.geometry.dispose();
  }
  chunkMap.delete(key);
}

function updateStreaming(fx, fz, immediate = false) {
  if (!stage || !worldGroup) return;
  const view = QUALITY[settings.quality].view;
  const buildR = view + 52;
  const keepR = buildR + 130;
  const ccx = Math.floor(fx / CHUNK), ccz = Math.floor(fz / CHUNK);
  const cr = Math.ceil(buildR / CHUNK);
  const wanted = new Set();
  const missing = [];
  for (let cz = ccz - cr; cz <= ccz + cr; cz++) {
    for (let cx = ccx - cr; cx <= ccx + cr; cx++) {
      const mx = cx * CHUNK + CHUNK / 2, mz = cz * CHUNK + CHUNK / 2;
      const d2 = (mx - fx) * (mx - fx) + (mz - fz) * (mz - fz);
      if (d2 > buildR * buildR) continue;
      const key = chunkKeyOf(cx, cz);
      wanted.add(key);
      if (!chunkMap.has(key)) missing.push({ key, cx, cz, d2 });
    }
  }
  missing.sort((a, b) => a.d2 - b.d2);
  streamQueue = missing;
  if (immediate) {
    for (const m of streamQueue) buildChunkNow(m.cx, m.cz);
    streamQueue = [];
  }
  for (const key of [...chunkMap.keys()]) {
    if (wanted.has(key)) continue;
    const [cx, cz] = key.split(',').map(Number);
    const mx = cx * CHUNK + CHUNK / 2, mz = cz * CHUNK + CHUNK / 2;
    if ((mx - fx) * (mx - fx) + (mz - fz) * (mz - fz) > keepR * keepR) disposeChunk(key);
  }
}

function processStreamQueue() {
  let n = 0;
  while (streamQueue.length && n < 2) {
    const m = streamQueue.shift();
    buildChunkNow(m.cx, m.cz);
    n++;
  }
}

// ---------- environment (time of day) ----------
function applyEnvironment() {
  if (!stage) return;
  currentTod = todPreset(effectiveTodKey());
  if (skyObj) {
    scene.remove(skyObj.group);
    skyObj.group.traverse((o) => { if (o.geometry) o.geometry.dispose(); if (o.material && o.material.dispose) o.material.dispose(); });
  }
  skyObj = buildSky(THREE, effectiveTodKey());
  scene.add(skyObj.group);
  scene.fog = new THREE.Fog(currentTod.fog, 42, QUALITY[settings.quality].view + 80);
  hemi.color.set(currentTod.hemiSky);
  hemi.groundColor.set(currentTod.hemiGround);
  hemi.intensity = currentTod.hemiInt;
  sun.color.set(currentTod.sunColor);
  sun.intensity = currentTod.sunInt;
  renderer.toneMappingExposure = currentTod.exposure;
  if (carMesh) carMesh.setLights(currentTod.lights);
}

function disposeWorld() {
  if (worldGroup) {
    worldGroup.traverse((o) => { if (o.geometry) o.geometry.dispose(); });
    scene.remove(worldGroup);
  }
  if (skyObj) { scene.remove(skyObj.group); skyObj.group.traverse((o) => { if (o.geometry) o.geometry.dispose(); if (o.material && o.material.dispose) o.material.dispose(); }); skyObj = null; }
  worldGroup = null;
  chunkMap.clear();
  streamQueue = [];
}

async function buildWorld() {
  window.__vr.events.push(['buildWorld', sel.stageId ?? sel.biome, Math.round(performance.now())]);
  disposeWorld();
  stage = sel.stageId
    ? generateStage({ stageId: sel.stageId })
    : generateStage({ biome: sel.biome, seed: sel.seed, length: sel.length });
  if (sel.stageId) stageActuals.set(sel.stageId, { km: stage.totalLength / 1000, cps: stage.checkpoints.length });
  worldGroup = new THREE.Group();
  scene.add(worldGroup);

  $('load-bar').style.width = '30%';
  await new Promise((r) => requestAnimationFrame(r));
  const farMesh = new THREE.Mesh(buildFarGeometry(stage, THREE), farMaterial(THREE));
  farMesh.matrixAutoUpdate = false;
  worldGroup.add(farMesh);
  $('load-bar').style.width = '52%';
  await new Promise((r) => requestAnimationFrame(r));

  applyEnvironment();
  if (!dust) { dust = new DustSystem(THREE, 800); scene.add(dust.points); }
  placeCarAtStart();
  updateStreaming(stage.startPose.x, stage.startPose.z, true);
  worldKey = selectionKey();
  $('load-bar').style.width = '100%';
}

function placeCarAtStart() {
  if (!stage) return;
  if (carMesh) { scene.remove(carMesh.group); carMesh.group.traverse((o) => { if (o.geometry) o.geometry.dispose(); }); }
  carMesh = buildCar(THREE, atlasTex, sel.livery);
  carMesh.group.rotation.order = 'YXZ';
  carMesh.setLights(currentTod.lights);
  carMesh.setDirt(0);
  dirtDist = 0;
  scene.add(carMesh.group);
  carState = createCar(stage.startPose);
  lastIdx = 0;
  syncCarMesh(0);
  steerState.value = 0;
}

// ---------- race state ----------
let mode = 'boot';
let pausedFrom = 'race';
let raceTime = 0, penalties = 0, countdownT = 0, lastCount = 4;
let lastIdx = 0, nextCp = 0, splits = [];
let best = store.get(bestKey(), null);
let bannerUntil = 0, toastUntil = 0, finishAt = 0;
let shakeAmp = 0, dustAcc = 0, streamTimer = 0;
let camMode = 0; // 0 chase, 1 hood
const camPos = new THREE.Vector3(0, 30, 60);
let camInit = false;
let prevSpeedF = 0;

// Test/debug hook: automated checks watch the state machine here.
let lastModeLogged = '';
window.__vr = {
  events: [],
  mode: () => mode,
  raceTime: () => raceTime,
  nextCp: () => nextCp,
  worldKey: () => worldKey,
  carPos: () => (carState ? [Math.round(carState.x), Math.round(carState.z)] : null),
};

const envFor = () => ({
  groundHeight: stage.groundHeight,
  surfaceAt: stage.surfaceAt,
  bounds: stage.bounds,
  params: LIVERIES[sel.livery].params,
});

function nearestIdx() {
  const path = stage.path;
  let bestI = lastIdx, bestD = Infinity;
  const lo = Math.max(0, lastIdx - 40);
  const hi = Math.min(path.length - 1, lastIdx + 90);
  for (let i = lo; i <= hi; i++) {
    const dx = path[i].x - carState.x, dz = path[i].z - carState.z;
    const d = dx * dx + dz * dz;
    if (d < bestD) { bestD = d; bestI = i; }
  }
  lastIdx = bestI;
  return bestI;
}
const progressDist = () => stage.path[lastIdx].dist;

function showBanner(html, secs = 2.2) {
  const b = $('banner');
  b.innerHTML = html;
  b.style.display = 'block';
  bannerUntil = performance.now() / 1000 + secs;
}
function showToast(text, secs = 2) {
  const t = $('toast');
  t.textContent = text;
  t.style.display = 'block';
  toastUntil = performance.now() / 1000 + secs;
}

function startCountdown() {
  window.__vr.events.push(['countdown', Math.round(performance.now())]);
  best = store.get(bestKey(), null);
  raceTime = 0; penalties = 0; splits = []; nextCp = 0;
  lastIdx = 0; dustAcc = 0; shakeAmp = 0;
  carState = createCar(stage.startPose);
  steerState.value = 0;
  camInit = false;
  countdownT = 3.7; lastCount = 4;
  mode = 'countdown';
  showScreen(null);
  $('hud').classList.add('on');
  updateTouchVisibility();
  $('hud-time').querySelector('.best').textContent = best ? `BEST ${fmtTime(best.total)}` : '';
  $('hud-cp').textContent = '';
  showToast(`${stage.name.toUpperCase()}${stage.country ? ' · ' + stage.country.toUpperCase() : ''} · ${(stage.totalLength / 1000).toFixed(1)} KM`, 2.8);
  audio.ensure();
}

function finishStage() {
  mode = 'finished';
  finishAt = performance.now() / 1000;
  const total = raceTime + penalties;
  splits.push(total);
  const isBest = !best || total < best.total;
  if (isBest) { best = { total, splits: [...splits] }; store.set(bestKey(), best); }
  showBanner('FINISH', 1.6);
  audio.beep(880, 0.3, 'square', 0.2);
  setTimeout(() => {
    if (mode !== 'finished') return;
    mode = 'results';
    $('res-time').textContent = fmtTime(total);
    $('res-newbest').style.display = isBest ? 'inline-block' : 'none';
    $('res-best').textContent = `Best ${fmtTime(best.total)} · ${stage.name}${stage.country ? ' · ' + stage.country : ''}${stage.id ? '' : ` · seed ${stage.seed}`}`;
    const rows = [];
    const labels = stage.checkpoints.map((c, i) => `Checkpoint ${i + 1}`);
    labels.push('Finish');
    const prev = store.get(bestKey(), null);
    for (let i = 0; i < splits.length; i++) {
      let delta = '';
      if (prev && prev.splits && prev.splits[i] != null && !isBest) {
        const d = splits[i] - prev.splits[i];
        delta = `<span class="${d <= 0 ? 'good' : 'bad'}">${fmtDelta(d)}</span>`;
      } else if (isBest && i < splits.length - 1) delta = '<span class="good">best</span>';
      rows.push(`<tr><td>${labels[i] || `Split ${i + 1}`}</td><td class="d">${fmtTime(splits[i])}</td><td class="d">${delta}</td></tr>`);
    }
    $('res-splits').innerHTML = rows.join('');
    showScreen('results');
    $('hud').classList.remove('on');
    updateTouchVisibility();
  }, 1500);
}

function checkRaceProgress() {
  nearestIdx();
  const pd = progressDist();
  const cps = stage.checkpoints;
  if (nextCp < cps.length && pd >= cps[nextCp].dist) {
    const t = raceTime + penalties;
    splits.push(t);
    let sub = `SPLIT ${fmtTime(t)}`;
    if (best && best.splits && best.splits[nextCp] != null) {
      const d = t - best.splits[nextCp];
      sub += ` · <span class="${d <= 0 ? 'good' : 'bad'}">${fmtDelta(d)}</span>`;
    }
    showBanner(`CHECKPOINT ${nextCp + 1}`, 2.2);
    $('banner').innerHTML += `<small>${sub}</small>`;
    audio.beep(740, 0.14, 'square', 0.16);
    setTimeout(() => audio.beep(990, 0.18, 'square', 0.16), 110);
    nextCp++;
  }
  if (pd >= stage.path[stage.finishIdx].dist && mode === 'race') finishStage();
}

function resetToRoad() {
  const p = stage.path[lastIdx];
  carState.x = p.x; carState.z = p.z;
  carState.y = stage.groundHeight(p.x, p.z);
  carState.heading = p.heading;
  carState.vx = 0; carState.vz = 0; carState.vy = 0;
  carState.grounded = true;
  penalties += 5;
  showToast('RESET · +5 s penalty');
  audio.beep(240, 0.2, 'sawtooth', 0.14);
}

// ---------- car visuals ----------
function syncCarMesh(dt) {
  if (!carMesh || !carState || !stage) return;
  const c = carState;
  const fx = Math.sin(c.heading), fz = -Math.cos(c.heading);
  const rx = Math.cos(c.heading), rz = Math.sin(c.heading);
  const hA = stage.groundHeight(c.x + fx * 1.4, c.z + fz * 1.4);
  const hB = stage.groundHeight(c.x - fx * 1.4, c.z - fz * 1.4);
  const hL = stage.groundHeight(c.x - rx * 0.9, c.z - rz * 0.9);
  const hR = stage.groundHeight(c.x + rx * 0.9, c.z + rz * 0.9);
  const g = carMesh.group;
  let bounce = 0;
  const speedKmh = c.speed * 3.6;
  if (c.grounded && !isRoadSurface(c.surface) && speedKmh > 12)
    bounce = Math.sin(performance.now() * 0.045) * 0.016 * Math.min(1, speedKmh / 70);
  g.position.set(c.x, c.y + 0.02 + bounce, c.z);
  g.rotation.y = Math.PI - c.heading;
  const airTilt = c.grounded ? 1 : 0.25;
  g.rotation.x = Math.atan2(hB - hA, 2.8) * airTilt + clamp((prevSpeedF - c.speedF) * 0.0035, -0.035, 0.045);
  g.rotation.z = Math.atan2(hL - hR, 1.8) * airTilt * 0.85 + clamp(-c.slip * 0.004, -0.05, 0.05);
  prevSpeedF = c.speedF;
  carMesh.update(dt, c.speedF, c.steerVis);
  carMesh.setBraking(input.held.has('down') || input.touch.down);
}

// ---------- camera ----------
function updateCamera(dt, t) {
  if (!carState) return;
  const c = carState;
  if (mode === 'menu' || mode === 'boot') {
    const sp = stage.startPose;
    const gy = stage.groundHeight(sp.x, sp.z);
    const a = t * 0.07;
    camera.position.set(sp.x + Math.sin(a) * 24, gy + 9.5 + Math.sin(t * 0.11) * 1.6, sp.z + Math.cos(a) * 24);
    camera.lookAt(sp.x, gy + 1.6, sp.z);
    camera.fov += (55 - camera.fov) * Math.min(1, dt * 3);
    camera.updateProjectionMatrix();
    return;
  }
  const fx = Math.sin(c.heading), fz = -Math.cos(c.heading);
  if (camMode === 1) {
    // Hood cam.
    camera.position.set(c.x + fx * 0.85, c.y + 1.28, c.z + fz * 0.85);
    camera.lookAt(c.x + fx * 22, c.y + 0.9, c.z + fz * 22);
    return;
  }
  const speedKmh = c.speed * 3.6;
  const back = 8.4 + c.speed * 0.075;
  const tx = c.x - fx * back;
  const tz = c.z - fz * back;
  const ty = stage.groundHeight(tx, tz) + 3.4 + c.speed * 0.012;
  if (!camInit) { camPos.set(tx, Math.max(ty, c.y + 3.4), tz); camInit = true; }
  const k = 1 - Math.exp(-dt * 6.2);
  camPos.x += (tx - camPos.x) * k;
  camPos.z += (tz - camPos.z) * k;
  camPos.y += (Math.max(ty, c.y + 2.2) - camPos.y) * (1 - Math.exp(-dt * 4.2));
  let sx = 0, sy = 0;
  if (shakeAmp > 0.002) {
    sx = (Math.random() - 0.5) * shakeAmp;
    sy = (Math.random() - 0.5) * shakeAmp * 0.7;
  }
  camera.position.set(camPos.x + sx, camPos.y + sy, camPos.z);
  camera.lookAt(c.x + fx * 7, c.y + 1.35, c.z + fz * 7);
  const targetFov = 62 + clamp(speedKmh / 135, 0, 1) * 13;
  camera.fov += (targetFov - camera.fov) * Math.min(1, dt * 4);
  camera.updateProjectionMatrix();
}

// ---------- HUD ----------
const SURF_NAMES = {
  [SURFACE.TARMAC]: '', [SURFACE.GRAVEL]: '', [SURFACE.DIRT]: 'DIRT',
  [SURFACE.GRASS]: 'OFF ROAD', [SURFACE.MUD]: 'MUD · OFF ROAD', [SURFACE.SAND]: 'SAND · OFF ROAD',
  [SURFACE.PACKED_SNOW]: '', [SURFACE.SNOW]: 'DEEP SNOW', [SURFACE.ROCK]: 'ROCK · OFF ROAD',
};
let lastHudSpeed = -1, lastHudTime = '';
function updateHUD() {
  const c = carState;
  const kmh = Math.round(c.speed * 3.6);
  if (kmh !== lastHudSpeed) {
    lastHudSpeed = kmh;
    $('hud-speed').querySelector('.num').textContent = kmh;
    const surf = $('hud-speed').querySelector('.surf');
    const txt = c.drifting ? 'DRIFT' : (SURF_NAMES[c.surface] || '');
    if (surf.textContent !== txt) surf.textContent = txt;
  }
  const t = fmtTime(raceTime + penalties);
  if (t !== lastHudTime) {
    lastHudTime = t;
    $('hud-time').querySelector('.now').textContent = t;
  }
  const pd = progressDist();
  $('progress-fill').style.width = `${clamp((pd / stage.totalLength) * 100, 0, 100)}%`;
  $('hud-cp').textContent = `CHECKPOINT ${Math.min(nextCp + 1, stage.checkpoints.length + 1)} / ${stage.checkpoints.length + 1}`;
  // Wrong way.
  const ph = stage.path[lastIdx].heading;
  const wrong = Math.abs(angNorm(c.heading - ph)) > 1.95 && c.speed > 4 && mode === 'race';
  $('wrongway').style.display = wrong ? 'block' : 'none';
  // Pace note for the next corner.
  const pace = $('pace');
  let shown = false;
  for (const corner of stage.corners) {
    if (corner.atDist <= pd + 9) continue;
    const d = corner.atDist - pd;
    if (d < 150) {
      const n = corner.severity <= 2 ? 3 : corner.severity <= 4 ? 2 : 1;
      pace.querySelector('.arr').textContent = (corner.dir === 'R' ? '❯' : '❮').repeat(n);
      pace.querySelector('.sev').textContent = `${corner.severity} ${corner.dir === 'R' ? 'RIGHT' : 'LEFT'}`;
      pace.querySelector('.dist').textContent = `${Math.round(d)} m`;
      pace.style.display = 'block';
      shown = true;
    }
    break;
  }
  if (!shown) pace.style.display = 'none';
}

// ---------- screens / UI ----------
const SCREENS = ['menu', 'panel-stage', 'panel-car', 'panel-settings', 'panel-help', 'pause-menu', 'results'];
function showScreen(id) {
  for (const s of SCREENS) $(s).classList.toggle('on', s === id);
}
function updateTouchVisibility() {
  const touch = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
  $('touch').classList.toggle('on', touch && (mode === 'race' || mode === 'countdown'));
}
function buildStageList() {
  const wrap = $('stage-list');
  if (!wrap) return;
  wrap.innerHTML = '';
  for (const def of STAGES) {
    const act = stageActuals.get(def.id);
    const km = act ? act.km.toFixed(1) : def.lengthKm.toFixed(1);
    const cps = act ? act.cps : Math.round(def.lengthKm * 1000 / def.cpSpacing);
    const row = document.createElement('button');
    row.className = 'stage-row' + (sel.stageId === def.id ? ' sel' : '');
    row.dataset.stageId = def.id;
    row.innerHTML =
      `<span class="sr-top"><span class="sr-name">${def.name}</span><span class="sr-country">${def.country}</span></span>` +
      `<span class="sr-meta">${def.surface} · ${km} km · ${cps} checkpoints</span>` +
      `<span class="sr-note">${def.note}</span>`;
    row.addEventListener('click', () => {
      sel.stageId = def.id;
      store.set('stageId', def.id);
      refreshSelectionUI();
    });
    wrap.appendChild(row);
  }
  const fp = $('free-play');
  if (fp) fp.classList.toggle('active', !sel.stageId);
}

function refreshSelectionUI() {
  buildStageList();
  document.querySelectorAll('#tod-seg button').forEach((el) => el.classList.toggle('sel', el.dataset.tod === sel.tod));
  document.querySelectorAll('#biome-cards .card').forEach((el) => el.classList.toggle('sel', el.dataset.biome === sel.biome));
  document.querySelectorAll('#length-seg button').forEach((el) => el.classList.toggle('sel', el.dataset.length === sel.length));
  document.querySelectorAll('#quality-seg button').forEach((el) => el.classList.toggle('sel', el.dataset.quality === settings.quality));
  document.querySelectorAll('#sound-seg button').forEach((el) => el.classList.toggle('sel', (el.dataset.sound === 'on') === settings.sound));
  $('seed-val').textContent = sel.seed;
  const b = store.get(bestKey(), null);
  $('stage-best').textContent = b ? `Best on this stage: ${fmtTime(b.total)}` : 'No best time yet on this stage.';
  buildCarCards();
}
function buildCarCards() {
  const wrap = $('car-cards');
  wrap.innerHTML = '';
  LIVERIES.forEach((liv, i) => {
    const card = document.createElement('div');
    card.className = 'card' + (i === sel.livery ? ' sel' : '');
    const stat = (label, v) => `<div class="stat"><span style="width:44px">${label}</span><span class="bar"><i style="width:${v}%"></i></span><span>${v}</span></div>`;
    card.innerHTML = `<div class="sw" style="background:${liv.swatch}"></div><div class="nm">${liv.name}</div>` +
      stat('SPEED', liv.stats.speed) + stat('GRIP', liv.stats.grip) + stat('DRIFT', liv.stats.drift);
    card.addEventListener('click', () => {
      sel.livery = i;
      store.set('livery', i);
      refreshSelectionUI();
      if (stage) placeCarAtStart();
    });
    wrap.appendChild(card);
  });
}

function applyQuality() {
  const q = QUALITY[settings.quality];
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, q.pixel));
  if (sun.shadow.mapSize.x !== q.shadow) {
    sun.shadow.mapSize.set(q.shadow, q.shadow);
    if (sun.shadow.map) { sun.shadow.map.dispose(); sun.shadow.map = null; }
  }
  if (scene.fog) scene.fog.far = q.view + 80;
  resize();
  if (stage && carState) updateStreaming(carState.x, carState.z);
}

async function startRace() {
  audio.ensure();
  if (worldKey !== selectionKey()) {
    $('loading').classList.add('on');
    $('load-label').textContent = 'Building stage';
    await buildWorld();
    $('loading').classList.remove('on');
  } else {
    placeCarAtStart();
  }
  startCountdown();
}

function quitToMenu() {
  mode = 'menu';
  placeCarAtStart();
  showScreen('menu');
  $('hud').classList.remove('on');
  updateTouchVisibility();
  refreshSelectionUI();
}

document.querySelectorAll('[data-act]').forEach((el) => {
  el.addEventListener('click', () => {
    audio.ensure();
    const act = el.dataset.act;
    if (act === 'start') startRace();
    else if (act === 'stage') { refreshSelectionUI(); showScreen('panel-stage'); }
    else if (act === 'car') { refreshSelectionUI(); showScreen('panel-car'); }
    else if (act === 'settings') { refreshSelectionUI(); showScreen('panel-settings'); }
    else if (act === 'help') showScreen('panel-help');
    else if (act === 'back') showScreen(mode === 'results' ? 'results' : 'menu');
    else if (act === 'resume') { mode = pausedFrom; showScreen(null); }
    else if (act === 'restart') startRace();
    else if (act === 'again') startRace();
    else if (act === 'quit') quitToMenu();
  });
});
document.querySelectorAll('#biome-cards .card').forEach((el) =>
  el.addEventListener('click', () => { sel.biome = el.dataset.biome; sel.stageId = null; store.set('biome', sel.biome); store.set('stageId', null); refreshSelectionUI(); }));
document.querySelectorAll('#length-seg button').forEach((el) =>
  el.addEventListener('click', () => { sel.length = el.dataset.length; sel.stageId = null; store.set('length', sel.length); store.set('stageId', null); refreshSelectionUI(); }));
document.querySelectorAll('#tod-seg button').forEach((el) =>
  el.addEventListener('click', () => {
    sel.tod = el.dataset.tod;
    store.set('tod', sel.tod);
    refreshSelectionUI();
    if (stage) applyEnvironment();
  }));
document.querySelectorAll('#quality-seg button').forEach((el) =>
  el.addEventListener('click', () => { settings.quality = el.dataset.quality; store.set('quality', settings.quality); applyQuality(); refreshSelectionUI(); }));
document.querySelectorAll('#sound-seg button').forEach((el) =>
  el.addEventListener('click', () => { settings.sound = el.dataset.sound === 'on'; store.set('sound', settings.sound); audio.setMuted(!settings.sound); refreshSelectionUI(); }));
$('btn-seed').addEventListener('click', () => { sel.seed = 1 + Math.floor(Math.random() * 9998); sel.stageId = null; store.set('seed', sel.seed); store.set('stageId', null); refreshSelectionUI(); });
$('btn-stage-start').addEventListener('click', () => startRace());

input.bindTouchButton($('t-left'), 'left');
input.bindTouchButton($('t-right'), 'right');
input.bindTouchButton($('t-up'), 'up');
input.bindTouchButton($('t-down'), 'down');
input.bindTouchButton($('t-hb'), 'handbrake');
$('t-pause').addEventListener('pointerdown', (e) => { e.preventDefault(); if (mode === 'race' || mode === 'countdown') pauseGame(); });
$('t-cam').addEventListener('pointerdown', (e) => {
  e.preventDefault();
  if (mode === 'race' || mode === 'countdown') { camMode = (camMode + 1) % 2; showToast(camMode === 1 ? 'HOOD CAM' : 'CHASE CAM', 1.2); }
});

function pauseGame() {
  if (mode !== 'race' && mode !== 'countdown') return;
  pausedFrom = mode;
  mode = 'pause';
  showScreen('pause-menu');
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden && (mode === 'race' || mode === 'countdown')) pauseGame();
});

// ---------- resize ----------
function resize() {
  const w = window.innerWidth, h = window.innerHeight;
  renderer.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);
window.addEventListener('orientationchange', () => setTimeout(resize, 60));

// ---------- main loop ----------
const STEP = 1 / 120;
let acc = 0, lastT = performance.now() / 1000;

function frame() {
  requestAnimationFrame(frame);
  const now = performance.now() / 1000;
  let dt = Math.min(0.1, now - lastT);
  lastT = now;
  const t = now;
  if (mode !== lastModeLogged) {
    window.__vr.events.push(['mode', lastModeLogged || 'boot', mode, Math.round(now * 1000)]);
    lastModeLogged = mode;
  }

  // Edge actions.
  if (input.pressed('pause')) {
    if (mode === 'race' || mode === 'countdown') pauseGame();
    else if (mode === 'pause') { mode = pausedFrom; showScreen(null); }
  }
  if (input.pressed('camera') && (mode === 'race' || mode === 'countdown')) camMode = (camMode + 1) % 2;
  if (input.pressed('reset') && mode === 'race') resetToRoad();
  if (input.pressed('mute')) {
    settings.sound = !settings.sound;
    store.set('sound', settings.sound);
    audio.setMuted(!settings.sound);
    showToast(settings.sound ? 'SOUND ON' : 'SOUND OFF');
  }

  const drive = input.poll(dt, steerState);

  if (mode === 'countdown') {
    countdownT -= dt;
    const n = Math.ceil(countdownT);
    if (n !== lastCount && n >= 0) {
      lastCount = n;
      const cd = $('countdown');
      cd.style.display = 'flex';
      cd.textContent = n === 0 ? 'GO!' : String(n);
      cd.style.color = n === 0 ? '#51e07a' : '#fff';
      audio.beep(n === 0 ? 880 : 440, n === 0 ? 0.3 : 0.13, 'square', 0.18);
    }
    if (countdownT <= -0.55) {
      mode = 'race';
      $('countdown').style.display = 'none';
    }
  }

  if ((mode === 'race' || mode === 'finished') && carState) {
    acc = Math.min(acc + dt, 0.12);
    const inp = mode === 'race' ? drive : { throttle: 0, brake: 0.4, steer: 0, handbrake: false };
    let steps = 0;
    while (acc >= STEP && steps < 16) {
      const beforeY = carState.y;
      stepCar(carState, inp, STEP, envFor());
      if (carState.lastImpact > 2.4) {
        shakeAmp = Math.min(0.4, carState.lastImpact * 0.045);
        if (dust) for (let i = 0; i < 8; i++)
          dust.spawn(carState.x, carState.y + 0.3, carState.z, SURFACE_DUST[carState.surface], 1.6, 1.2, 1);
        audio.beep(120, 0.16, 'sawtooth', 0.1);
        carState.lastImpact = 0;
      }
      void beforeY;
      acc -= STEP; steps++;
      if (mode === 'race') raceTime += STEP;
      if (mode === 'race') checkRaceProgress();
    }
    // Dirt builds up on the lower body off road and on loose surfaces.
    if (carMesh && carState.grounded && carState.speed > 2) {
      const s = carState.surface;
      if (carState.offroad || s === SURFACE.DIRT || s === SURFACE.MUD || s === SURFACE.RED_DIRT || s === SURFACE.SAND || s === SURFACE.GRAVEL) {
        dirtDist += carState.speed * dt;
        carMesh.setDirt(Math.min(1, dirtDist / 1100));
      }
    }
    // Dust from the rear wheels.
    if (dust && carState.grounded && carState.speed > 3.5) {
      const c = carState;
      const need = c.drifting || !isRoadSurface(c.surface) || (drive.throttle > 0 && c.slip > 2.2) || (!isRoadSurface(c.surface) && drive.throttle > 0);
      if (need) {
        dustAcc += dt * (c.drifting ? 46 : 26) * QUALITY[settings.quality].dust;
        const fx = Math.sin(c.heading), fz = -Math.cos(c.heading);
        const rx = Math.cos(c.heading), rz = Math.sin(c.heading);
        while (dustAcc >= 1) {
          dustAcc -= 1;
          const side = Math.random() < 0.5 ? -0.75 : 0.75;
          dust.spawn(
            c.x - fx * 1.5 + rx * side, c.y + 0.18, c.z - fz * 1.5 + rz * side,
            SURFACE_DUST[c.surface], 1, c.surface === SURFACE.SNOW || c.surface === SURFACE.PACKED_SNOW ? 1.1 : 1.6, 1);
        }
      }
    }
  }

  if (carState) syncCarMesh(dt);
  if (dust) dust.update(dt);
  if (skyObj && carState) {
    skyObj.update(dt, t);
    skyObj.setCenter(carState.x, carState.z);
  }
  if (carState) {
    const sd = skyObj ? skyObj.sunDir : { x: 0.48, y: 0.78, z: 0.34 };
    const sunH = currentTod === todPreset('overcast') ? 190 : 150;
    sun.position.set(carState.x + sd.x * sunH, carState.y + sd.y * sunH, carState.z + sd.z * sunH);
    sun.target.position.set(carState.x, carState.y, carState.z);
    sun.target.updateMatrixWorld();
  }
  streamTimer -= dt;
  if (streamTimer <= 0) {
    streamTimer = 0.25;
    if (carState) updateStreaming(carState.x, carState.z);
    else if (stage) updateStreaming(stage.startPose.x, stage.startPose.z);
  }
  processStreamQueue();
  shakeAmp *= Math.exp(-5.5 * dt);

  updateCamera(dt, t);
  if (mode === 'race' || mode === 'countdown' || mode === 'finished') updateHUD();

  if (bannerUntil && t > bannerUntil) { $('banner').style.display = 'none'; bannerUntil = 0; }
  if (toastUntil && t > toastUntil) { $('toast').style.display = 'none'; toastUntil = 0; }

  // Audio follows the car.
  if (carState) {
    const rpm = clamp(Math.abs(carState.speed) / 34 * 0.72 + drive.throttle * 0.3, 0, 1);
    const running = mode === 'race' || mode === 'countdown' || mode === 'finished';
    audio.update(rpm, mode === 'race' ? drive.throttle : 0, carState.speed * 3.6,
      !isRoadSurface(carState.surface), carState.drifting, running);
  }

  input.postFrame();
  renderer.render(scene, camera);
}

// ---------- boot ----------
(async function boot() {
  resize();
  applyQuality();
  refreshSelectionUI();
  $('loading').classList.add('on');
  $('load-label').textContent = 'Building stage';
  await new Promise((r) => setTimeout(r, 30));
  await buildWorld();
  $('loading').classList.remove('on');
  mode = 'menu';
  showScreen('menu');
  frame();
})();
