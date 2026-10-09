# 08 — Zasoby zewnętrzne: skilly agentowe i repo referencyjne

Przeznaczenie pliku: to, co **warto zaimportować lub przeczytać** przed Fazą 0–5, plus to, czego **nie ma nigdzie** i musimy napisać sami.
Wszystkie pozycje poniżej zostały zweryfikowane (istnieją, podana licencja, podane nazwy plików/skillów). Ofiary rate-limitu GitHub API są oznaczone `⚠️ do potwierdzenia`.

---

## 0. Jak to zainstalować w tym projekcie (pi + Claude Code)

Pi odkrywa skille rekurewnie w katalogu użytkownika i projektu, a także w standardowych lokalizacjach Agent Skills:
```
~/.pi/agent/skills/<nazwa>/SKILL.md          # globalnie
.agents/skills/<nazwa>/SKILL.md              # w repozytorium projektu (odkrywane od cwd do roota repo)
~/.agents/skills/<nazwa>/SKILL.md            # globalnie, standard Agent Skills
```
**Rekomendacja:** trzymać skill project-level w `Minecraft-Rally/.agents/skills/` — ten sam katalog działa w pi, Claude Code, Codex i Cursor. Wymaganie portable: katalog `SKILL.md` z frontmatterem (`name`, `description`); nazwa katalogu = `name`.

Uwaga bezpieczeństwa: skill project-level może instruować agenta do uruchamiania skryptów. Przed użyciem przeczytać `SKILL.md` i pliki towarzyszące.

---

## 1. Skill packi — kolejność instalacji

| # | Pack | Licencja | Co dokładnie daje | Do której fazy |
|---|---|---|---|---|
| **1** | **`gamedev-skills/awesome-gamedev-agent-skills`** — 74 skille + router, `npx skills add gamedev-skills/awesome-gamedev-agent-skills` | Apache-2.0 | **Najtrafniejszy pack.** `disciplines/physics-tuning` (fixed vs variable timestep, render interpolation, CCD/tunneling, jitter, mass/drag), `disciplines/procedural-gen` (seeded RNG, value/Perlin/Simplex, heightmap), `disciplines/shader-programming`, `disciplines/audio-design` (bus/mixer, gain w dB, ducking, adaptive music), `disciplines/game-feel` (screen shake, hit-stop, tweening), `disciplines/camera-systems`, `disciplines/input-systems`, `disciplines/performance-optimization`, `disciplines/save-systems`, `disciplines/level-design`, `disciplines/game-ui-ux`, `web-engines/threejs-scene-setup` (import maps, `three/addons`, `setAnimationLoop`, resize), `web-engines/threejs-materials-lighting` | F0–F7 |
| **2** | **`majidmanzarpour/threejs-game-skills`** | MIT | Router `threejs-game-director` + specjaliści: `threejs-gameplay-systems`, `threejs-aaa-graphics-builder`, `threejs-audio-generator`, `threejs-game-ui-designer`, `threejs-debug-profiler`, `threejs-qa-release`, `threejs-3d-generator`, `threejs-image-generator`, `install.sh` | F5 (polish, QA, profiler) |
| **3** | **`Impertio-Studio/Three.js-Claude-Skill-Package`** (24 skille, deterministyczne ALWAYS/NEVER) | MIT | `threejs-core-renderer` (render targets — potrzebne do splat mapy brudu), `threejs-syntax-shaders`, `threejs-syntax-materials`, `threejs-impl-post-processing`, `threejs-impl-audio`, `threejs-impl-physics`, `threejs-errors-performance` | F1, F3, F5 |
| **4** | **`CK42BB/procedural-landscapes-threejs`** | MIT | `noise-algorithms.md` (FBM, ridged multifractal, domain warp), `wgsl-shaders.md`, przepisy na materiały zależne od stoku (slope-based) — dokładnie to, czego potrzebujemy do rzeźbienia drogi i teksturowania terenu | F1 |
| **5** | **`CK42BB/procedural-weather-threejs`** | MIT | `weather-shaders.md`, GPU particle precipitation, mgła wolumetryczna, błyskawice, przejścia stanów — pod F6 (noc/deszcz/mróz) | F5–F6 |
| **6** | **`davila7/claude-code-templates`** → `cli-tool/components/skills/creative-design/game-development/` | MIT | Podkatalogi: `3d-games`, `web-games`, `game-audio`, `game-art`, `game-design`, `2d-games`, `mobile-games`, `multiplayer`, `pc-games`, `vr-ar` — każdy to jeden `SKILL.md`. Dobre jako szkielet konwencji, nie jako wiedza właściwa | F0 |
| **7** | **`FunwayHQ/sound-design-skill`** (`skills/sound-design/`) | MIT | Synteza liczona od fizyki i psychoakustyki, „patch recipes” + uruchamialny kod — pod nasz `audio/` (silnik, granular, opony) | F5 |
| **8** | **`dannyjpwilliams/ui-sound-design-skill`** | MIT | Web Audio API / Tone.js z opisu po angielsku — pod HUD, licznik startu, sygnały checkpointów | F4–F5 |
| **9** | **`anthropics/skills`** | brak SPDX | Tylko `algorithmic-art`, `canvas-design`, `frontend-design`, `webapp-testing`, `skill-creator`, `mcp-builder`, `web-artifacts-builder`. **Zero skillów game/3D.** Wartościowe: `skill-creator` (do napisania naszych własnych skillów z §4) i `webapp-testing` (smoke testy HUD/canvasu) | F0, F7 |
| **10** | Indeksy do kopania, nie do instalacji: `VoltAgent/awesome-agent-skills` (MIT), `hesreallyhim/awesome-claude-code` (NOASSERTION), `skills.sh` (Next.js — indeksowalny tylko przez `sitemap-skills-1.xml`, `sitemap-skills-2.xml`, `sitemap-owners.xml`) | — | W VoltAgent warto sprawdzć: `CloudAI-X/threejs-skills`, `MiniMax-AI/shader-dev`, `openai/develop-web-game`, `ZhangHanDong/makepad-skills` | — |

**Czego NIE instalować:** `gamedev-skills/.../web-engines/threejs-gltf-loading` (glTF/GLB, DRACO, KTX2 — stoi w sprzeczności z filarem „zero assetów”), `disciplines/create-game-assets` (art direction + sourcing assetów), `majidmanzarpour/.../threejs-3d-generator` i `threejs-image-generator` (generują pliki GLB/PNG przez API Tripo). `gamedev-skills.github.io/.../web-engines/` jako całość jest glTF-centryczny — bierzemy z niego tylko `threejs-scene-setup` i `threejs-materials-lighting`.

---

## 2. Repo referencyjne — czytać, nie brać jako zależność

### Fizyka per-koło (F2)

| Repo | Licencja | Co wyciągnąć |
|---|---|---|
| **`herdeiroeth/drift-gang`** | MIT | Najbliższy nasz przypadek: vanilla JS + Three.js, **zero silnika fizycznego**, własny Pacejka. Pliki do przeczytania w całości: `src/physics/Tire.js`, `SuspensionCorner.js`, `Wheel.js`, `Car.js`, `CarConfig.js`, łańcuch silnik→sprzęgło→skrzynia→mechanizm, plus `test/tire.test.js` (jak testować model opony) |
| **`aunyks/tread`** | BSD-3 | `Pacejka2002`, `TireProperties`, `computeLateralForce`, `computeLongitudinalForce`, Harsh/Shyrokau 2019 — **służy do walidacji naszych krzywych μ per nawierzchnia**, nie jako biblioteka (nie ma naszego `plough`/`sink`) |
| **`yassinsolim/nordschleife-racer`** | MIT | Najbardziej kompletny analog w Three.js: `RaceVehicle.ts` (~179 KB rdzenia pojazdu), `Ghost/GhostReplay.ts` (serializacja ducha — nasz `game/ghost.js`), `Audio/RaceEngineAudio.ts` (~19 KB, addytywny silnik), `Lap/LapTimer.ts` (sectory), `Effects/DriftSmoke.ts`, `scripts/run-regression-validation.js` (nasz `debug/tests.js`) |
| **`bhubbard/tlab-vehicle-physics-rs`** | — | Czysty Pacejka Magic Formula + drift physics (Rust) — czytać dla matematyki, nie kodu |
| **cannon-es `RaycastVehicle`** ⚠️ do potwierdzenia (ścieżki `main`/`master` zwracały 404 przy weryfikacji) | MIT | Model pól koła, które warto odzwierciedlić w `car/wheel.js`: `suspensionRestLength`, `suspensionLength`, `suspensionStiffness`, `suspensionDamping` (compression/relaxation), `axle`, `chassisConnectionPointLocal`, `slipInfo`, `skidInfo`, `customSlidingRotationalSpeed`. **Uwaga: cannon-es liczy siłę opony uproszczoną krzywą, nie pełnym okręgiem tarcia** — nie kopiować bezrefleksyjnie |
| **rapier3d `DynamicRayCastVehicleController`** | Apache-2.0 / BSD | Dokumentacja: `rapier.rs/docs/user_guides/javascript/vehicle_controller`. API per koło: `addWheel`, `setWheelEngineForce`, `setWheelSteering`, `setWheelSuspensionCompression`, `setWheelSuspensionRelaxation`, `setWheelSuspensionStiffness`, `setWheelBrake`, `axle`, `steering`. Port `btRaycastVehicle`. **Decyzja architektoniczna:** użyć rapier jako silnika ciała+kolizji, a własny `tyre.js` jako modelu opony, czy wszystko własne? → patrz §3 |
| `icurtis1/raycast-vehicle` (MIT), `luke-brous/3d-vehicle-physics-simulation` ⚠️, `Yashparmar1125/Car-Game-ThreeJS` (R3F + Rapier) | MIT / — | Cienkie, ale `icurtis1` ma **live tuning panel** + Gamepad API — dobry wzorzec dla `setup-ui.js` i `input.js` |

### Voxel / teren (F1)

| Repo | Licencja | Co wyciągnąć |
|---|---|---|
| **`AThilenius/greedy_meshing`** | MIT | `greedy_meshing.ts` — czytelny greedy mesher (porządek implementacji Mikoli Lysenki). Do diffowania z naszym `world/mesher.js` |
| **`vercidium-patreon/meshing`** | MIT | Greedy meshing w C# z osobnym `VoxelShader.cs` — struktura (chunk → mesh → porównanie wariantów) jest cenniejsza niż język |
| `dgreenheck/ez-tree` | MIT | Proceduralny generator drzew w Three.js z 30+ parametrami. **Nie wokselowy** — bierzemy z niego logikę rozgałęzień i LOD, nie meshy; nasze drzewa zostają blokowe |
| `YigitGunduc/voxel-engine` | ⚠️ | Prosty silnik wokselowy w Three.js — tylko jako punkt startowy pętli chunków |
| Lektura: `fluff.blog/2023-04-24/greedy-meshing-visually` (wizualny opis algorytmu), `discourse.threejs.org/t/how-to-make-a-ultra-optimized-voxel-terrain.../83315` (porównanie podejść: greedy meshing vs SVO vs raymarching) | — | Uzasadnia wybór z `03 §2` (face culling + greedy + vertex AO, bez SVO) |

### Audio proceduralne (F5)

| Repo | Licencja | Co wyciągnąć |
|---|---|---|
| **`Antonio-R1/engine-sound-generator`** | ⚠️ MIT do potwierdzenia | **Najcenniejsze audio-reno w tej liście.** Generator dźwięku silnika oparty na publikacji o fizycznie uwarunkowanej syntezie dźwięku silnika samochodowego: intake / exhaust / wibracje bloku, konfiguracja parametrów, warianty z **AudioWorklet** i **WASM**, osobno Doppler przez `DelayNode`. Czytać: `src/engine_sound_generator/` |
| **`VinZu17/Engine-Sound-Simulator`** | ⚠️ | TypeScript, **zero zależności audio**, własna fizyka pojazdu + proceduralny dźwięk silnika + dashboard w czasie rzeczywistym (presety silników, biegi, throttle → RPM). Dokładnie nasz split „sim → parametry audio” |
| `cemrich/js-motor-sound-generation` | ⚠️ | Dynamiczny dźwięk silnika w Web Audio — proste, czytelne szkielety oscylatorów |
| `gamedev44/Torque` (Torque.JS) | ⚠️ | System symulacji dźwięku silnika, dwie wersje (JS / TS + wizualizer) — dobre do porównania krzywych obciążenia |
| Lektura: `salivity.github.io/game-development/article/simulating-tyre-slip-using-pacejka-s-magic-formula` | — | Czyste wyjaśnienie slip angle / slip ratio / friction ellipse — do `02 §3` |

### Rajd / stage / ghost

Brak dobrego repo. `TensorDriftStudio/OpenRally` (MIT, 535 plików) istnieje, ale jest **asset-based** (`public/models/vehicles/*.glb`, `public/images/stages/*.jpg`) — sprzeczność z filarem P4. Czytać wyłącznie dla struktury danych odcinka i UI, nic więcej.

---

## 3. Decyzja, którą te repo wymuszają (do podjęcia w F1, nie później)

**Własna fizyka czy silnik (rapier3d / cannon-es)?**

| Opcja | Za | Przeciw |
|---|---|---|
| **A. Własna (plan `02` w całości)** | pełna kontrola nad `plough`, `sink`, `rut`, per-nawierzchnią μ, determinizmem 1/120 s, uszkodzeniami zmieniającymi `k`/`c`; zero zależności; kolizje z wokslami liczone z heightfieldu | ~1200–1800 linii fizyki, ryzyko R1 (stabilność) jest w pełni na nas |
| **B. rapier3d do ciała i kolizji + własny `tyre.js`** | stabilny integrator, CCD, zderzenia z trimesh terenu, gotowy `DynamicRayCastVehicleController` do porównań | rapier jest WASM (~1–2 MB), jego `VehicleController` ma **własny** model opony, który trzeba obejść; determinizm WASM trudniejszy do udowodnienia; kolizje z deformowanym heightfieldem = ciągłe przebudowy colliderów |
| C. cannon-es `RaycastVehicle` | najprościej, MIT, czysty JS do czytania | uproszczony model opony bez okręgu tarcia, znane problemy ze stabilnością przy sztywnych zawieszeniach |

**Rekomendacja: A**, z `drift-gang` i `tread` jako referencją matematyczną oraz `physics-tuning` z packu #1 jako checklistem stabilności. Powód: filar P2 i P3 (per-koło + nawierzchnia jako dane świata) wymaga modelu opony, którego żaden z gotowych silników nie ma — a kolizje z **deformowanym** wokselowym terenem (koleiny, wyrwane bloki) są w silniku fizycznym droższe niż własny raycast z heightfieldu.

---

## 4. Czego NIE ma żaden z tych zasobów → musimy napisać sami

Zweryfikowana luka (żadne przejrzone repo ani skill tego nie pokrywa):

1. **Brud zależny od nawierzchni** — splat map w render targetcie, maski per panel, schnięcie/odpadanie, reguły „gdzie się brudzi” per nawierzchnia. Zero referencji.
2. **Tabele μ / Crr / plough / sink per nawierzchnia** — nigdzie nie ma gotowych wartości dla szotru, błota i śniegu w grze arcade; `tread` ma opony asfaltowe/turingowe, nie rajdowe. Nasza tabela z `02 §4` jest pierwotna i musi być strojna testami.
3. **Opór odspajania gruntu (`plough`) i koleiny w heightfieldzie** — nigdzie nie znalezione.
4. **Notatki pilota generowane z geometrii trasy** — brak implementacji open source; `OpenRally` ma notatki wpisane ręcznie.
5. **Voxel + vertex AO + drogi rzeźbione ze splajnu + drzewa blokowe** — greedy meshery istnieją, ale połączenie z „road carving” i AO nie istnieje nigdzie.
6. **Granularny szuter i 4 niezależne tory opon w WebAudio** — `engine-sound-generator` robi silnik, nie opony; nikt nie robi per-koło audio.
7. **Determinizm 1/120 s + ghost replay w świecie, który gracz deformuje** — ghost replay istnieje (`nordschleife-racer`), ale nie na zmiennym terenie.

### Rekomendacja: napisz własne 4 skille project-level

Zamiast tylko trzymać te fakty w `docs/`, zamienić je w ładowalne skille (format `SKILL.md`, katalog `.agents/skills/`), żeby agent w każdej fazie ładował właściwą wiedzę bez wpychania wszystkiego do kontekstu:

```
.agents/skills/
  rally-tyre-model/SKILL.md        ← z docs/02-physics.md §3–§5 (Pacejka, okrąg tarcia, plough, diff)
  voxel-rally-world/SKILL.md       ← z docs/03-world.md (chunk, greedy meshing, AO, road carving, pace notes)
  procedural-rally-audio/SKILL.md  ← z docs/05-audio.md (stały graf, firing envelope, granular, IR)
  car-dirt-system/SKILL.md         ← z docs/04-rendering.md §4.2 (splat map, panele, ewolucja, mycie)
```
Każdy z `description` w frontmatterze sformułowanym tak, żeby trafiał w zadanie z danej fazy (pi i Claude Code dobierają skill po opisie). Do napisania użyć `anthropics/skills → skill-creator`.

---

## 5. Plan działania (konkretny, 4 kroki)

1. **Zainstalować** pack #1 (`gamedev-skills/awesome-gamedev-agent-skills`) do `.agents/skills/`, ale **wyłączyć** `threejs-gltf-loading`, `create-game-assets`, `threejs-3d-generator`, `threejs-image-generator` (są asset-based).
2. **Pobrać do `reference/` (read-only, poza buildem)** i przeczytać przed F2: `drift-gang/src/physics/*`, `tread` (model opony), `AThilenius/greedy_meshing/greedy_meshing.ts`, `Antonio-R1/engine-sound-generator/src/*`, `nordschleife-racer` → `GhostReplay.ts`, `RaceEngineAudio.ts`, `run-regression-validation.js`.
3. **Napisać 4 własne skille** z §4 przed F1 — to jest największy zwrot z inwestycji, bo przenosi nasze tabele parametrów do formy, którą agent ładuje automatycznie.
4. **Potwierdzić** ⚠️ pozycje (cannon-es `RaycastVehicle`, licencje `Antonio-R1`, `VinZu17`, `luke-brous`, `Torque`) przy najbliższej okazji — weryfikacja blokowała się na rate-limicie GitHub API (60/60 zapytań na nieautoryzowane API).
