# 06 — Architektura kodu

## 1. Zasady

- **ES modules + import map**, Three.js z CDN lub lokalnie (`vendor/three.module.js`). Działa z `python3 -m http.server`. Vite opcjonalny (dev only), brak zależności runtime poza Three.js.
- **Zero assetów**: brak `assets/`, brak `fetch()` czegokolwiek poza modułami JS.
- **Stały krok czasu** dla fizyki i logiki gry; render swobodny.
- **Pule obiektów** wszędzie tam, gdzie coś się tworzy w klatce (cząstki, splaty, transienty audio, decale).
- **Determinizm**: jeden `seed` per odcinek; RNG własny (mulberry32), seedowany, z osobnymi strumieniami (`sim`, `fx`, `audio`, `world`).
- **Warstwy nie mieszają się**: `world` nie zna `car`, `car` nie zna `ui`, `render` czyta stan, nigdy go nie pisze.

---

## 2. Struktura

```
mc-rally/
  index.html                 import map, canvas, boot
  PLAN.md  docs/
  src/
    main.js                  boot, rejestr systemów, pętla
    core/
      loop.js                requestAnimationFrame + akumulator, stały krok
      time.js                fixed dt, substeps, pauza, slow-mo (replay)
      rng.js                 mulberry32, strumienie
      events.js              emitter (bez DOM events w hot path)
      settings.js            jakość, sterowanie, difficulty, audio
      save.js                localStorage: sezony, czasy, duchy, uszkodzenia
    world/
      palette.js             bloki: id, kolor, roughness, surface_id, loose, pattern
      surfaces.js            tabela nawierzchni (jedno źródło prawdy, patrz 02 §4)
      noise.js               value/simplex, fbm, warp, voronoi crack
      terrain-gen.js         biome + heightfield
      road-spline.js         walker, Catmull-Rom, atrybuty segmentu, sampling po łuku
      road-carve.js          rzeźbienie drogi w chunkach, pobocza, kamber
      props.js               drzewa, kibice, słupy, znaki, checkpointy
      chunk.js               dane chunka, height/rut, dirty flag
      mesher.js              face culling + greedy meshing + vertex AO
      streaming.js           ringi LOD, kolejka remeshingu
      pace-notes.js          generator notatek z splajnu (03 §7)
    car/
      body.js                stan ciała, integracja, masa/bezwładność
      wheel.js               stan koła: omega, kontakt, N, slip, damage
      suspension.js          spring/damper/ARB, travel, masa nieresorowana
      tyre.js                Pacejka + okrąg tarcia + roll + plough  ← rdzeń
      diff.js                open/viscous/locked, split przód-tył
      powertrain.js          silnik, skrzynia, cut, redline
      steering.js            steer ratio, Ackermann uproszczony, speed-sensitive
      damage.js              progi impulsów → parametry → wizualia
      car-params.js          4 auta + tuning (tabele)
      raycast-terrain.js     heightfield → blok, krawędzie, deformacja
    dirt/
      dirt-map.js            RT 512², splaty, ewolucja (schnięcie/odpadanie)
      panel-dirt.js          16 paneli, logika "gdzie się brudzi"
      emitters.js            slip_energy → splaty i cząstki per nawierzchnia
      wash.js                mycie, czyszczenie częściowe
    render/
      renderer.js            RT HDR, passy, resize, skalowanie jakości
      shaders/              terrain.glsl, car.glsl, sky.glsl, particle.glsl, composite.glsl
      shadow.js              2 kaskady, fit do auta
      post.js                bloom, motion blur, grade LUT, grain, CA, vignette, lens dirt
      particles.js         pule per typ, InstancedMesh / Points
      decals.js            ślady opon, plamy, koleiny (ring buffer)
      camera.js             CHASE/ONBOARD/BUMPER/CINEMATIC, shake, lookAhead
      hud.js                canvas atlas glifów, overlay ortho, wskaźniki per koło
    audio/
      graph.js              stały graf węzłów, bus, limiter, reverb send
      engine-synth.js       harmonic bank, firing envelope, load
      tyre-synth.js         4 tory per koło
      granular.js           pula 16 grainów, generowany buffer szumu
      impacts.js            transient generator, FM clang
      ambience.js           wiatr, deszcz, biome bed
      voice.js              speechSynthesis + fallback sylabiczny
      music.js              procedural score, adaptive intensity
      ir.js                 generowany impulse response per scena
    game/
      stage.js              definicja odcinka, stan, lifecycle
      timing.js             start, checkpointy, sectory, kary, limit, DNF
      championship.js       punkty, progresja, odblokowania
      ghost.js              zapis/odtwarzanie ducha (30 Hz, ~40 KB)
      replay.js             powtórki, kamera cinematic, eksport czasu
      setup-ui.js           tuning + preview
      input.js              klawiatura, gamepad, mapowanie, deadzone, kalibracja
    debug/
      physics-hud.js        wektory sił, N_i, kappa_i, alpha_i
      tests.js              regresja fizyki (02 §11), determinizm, wydajność
```

---

## 3. Pętla główna

```js
const DT = 1/120;
let acc = 0, last = performance.now();
function frame(now) {
  const dt = Math.min((now - last)/1000, 0.25);   // anti-spiral
  last = now; acc += dt;
  while (acc >= DT) { sim.step(DT); acc -= DT; }  // logika + fizyka
  render(interpolate(lastSim, prevSim, acc/DT));  // interpolacja = brak jitteru
  requestAnimationFrame(frame);
}
```
Render interpoluje stany (położenie/obrót auta, kamery), fizyka nigdy nie zależy od `dt` klatki. To daje: identyczne czasy przy 30 i 144 FPS.

---

## 4. Przepływ danych (najważniejsze krawędzie)

```
world.surfaces[surface_id] ──→ car/tyre.js        (μ, Crr, plough, sink, stick)
car/wheel[i] {N, kappa, alpha, slip_energy} ──→ dirt/emitters.js
car/wheel[i] {kappa, alpha} ──→ render/decals.js, audio/tyre-synth.js, hud.js
world.chunk.rut ──→ car/raycast-terrain.js        (koleiny wpływają na fizykę)
car/damage ──→ car/suspension.js (k, c) ──→ fizyka  (pętla zwrotna, celowa)
road-spline ──→ pace-notes ──→ audio/voice + hud
stage/sectory ──→ championship ──→ save
```

---

## 5. Wejście

| Akcja | Klawiatura | Gamepad |
|---|---|---|
| Gaz / hamulec | W / S lub ↑/↓ | RT / LT (analog) |
| Kierownica | A / D lub ←/→ | LX (analog) |
| Ręczny | Space | A |
| Bieg +/− lub auto | Q / E | RB / LB |
| Kamera | C | — |
| Reset / zakotwiczenie | R | Start |
| Pauza / tuning | Esc / T | Start |

- Deadzone 0.08, krzywa kierownicy `smoothstep` z progresją (pełna czułość w środku, mniej na krańcach), `steer_rate_limit` zależny od prędkości.
- Kalibracja gamepada przy pierwszym podłączeniu.
- Opcja "klawiatura = pada" (binary → analog z rampą 120 ms), żeby klawiatura nie była karą.
- Force feedback (jeśli `GamepadActuator` dostępny): `rumble = f(surface.roughness, slip_energy, impact)`.

---

## 6. Zapis

`localStorage`, klucz `mc-rally.v1`:
```
{ version, seed, championship: {stageResults[], points, unlocked[]},
  stageBest: {stageId: {time, sectors[], ghostRef(base64)}},
  carSetup: {carId: {ride, damp, arb, lock, bias, compound}},
  damage: {carId: {...}}, settings: {...} }
```
Duch jako base64 z `Uint8Array` (pozycja 3 × f32, quaternion 4 × f16, prędkość 2 × f16, 30 Hz).

---

## 7. Testy i narzędzia deweloperskie

- `debug/physics-hud.js`: narysowane wektory sił per koło, liczby `N/kappa/alpha`, kolorowane koła. **To jest narzędzie, które pozwala dostroić fizykę, nie zgadnąć.**
- `debug/tests.js`: 7 testów regresji z `02 §11`, uruchamiane klawiszem `F9` i w CI lokalnym (`node` + headless, bez GPU: tylko sim).
- `F3` profiler: czas sim, czas render, liczba draw calls, cząstki, chunki, węzły audio.
- `F4` "surface probe": pod autem wyświetla `surface_id` i aktualne μ — pozwala wykryć, że odcinek ma zły materiał.
- Tryb "slow-mo 0.25×" do debugowania poślizgów i do powtórek.
