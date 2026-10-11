# SYSTEM-NOTES — deviations and measured numbers (F4, rally loop)

Same voice as `PHYSICS-NOTES.md`: what the doc says, what the code does now, why, and the number.

## 1. Checkpoint count vs gate spacing

- **Doc.** `docs/03 §4`: gates every 900–1600 m. `PLAN.md §2`: the slice has **6 checkpointy** on a 4.2 km stage.
- **Code.** `planCheckpoints` (world/road-spline.js, untouched) emits start + 3 sector gates + finish = **5 gates** on 4.2 km. `planGates` in `src/game/stage.js` bisects the longest remaining gap until the stage has **6 gates** (start + 4 sectors + finish), which lands the spacing at ~700–1150 m.
- **Why.** Two docs disagree; the slice criterion (6 checkpoints) is the acceptance one, so the padding happens in the *stage* module and `world/road-spline.js` is left alone. Padding is deterministic (no RNG): same seed → same gates. Measured (seed 12345, 4.2 km): gate arcs 0 / 1124 / 2048 / 2621 / 3195 / 4209.

## 2. Reference time and per-sector reference

- **Doc.** `docs/03 §6`: `ref_time` comes from an offline AI ghost; the limit is `ref * 1.6`.
- **Code.** The ghost agent has not landed yet, so `Timing` takes `refTime` as a parameter. `main.js` falls back to `roadLength / 15 m/s` (override with `?ref=<s>`); `tools/stagetest.mjs` passes `4200/15 = 280 s`. With no `refSectors`, a sector's reference is `refTime * (sectorLength / stageLength)`.
- **Measured.** The harness drive takes **281.76 s** (4.2 km, seed 12345) → total split **+1.76 s**, sector splits `+5.84 / -7.41 / -1.76 / +8.22 / +1.76 s`. Replace `refTime`/`refSectors` with the ghost output when F4-part-2 lands; no other module changes.

## 3. Gate detection

- **Doc.** `docs/03 §4`: "przekroczenie płaszczyzny bramki przez CoM auta (test znaku, bez siatki)".
- **Code.** `_gateSide()` does exactly that signed test against the gate plane (tangent at `gate.index`), armed from `arc - 60 m`, judged **missed** at `arc + 70 m`, and a crossing further than **26 m** off the centreline is not counted as the gate (otherwise a car cutting a field would "take" a gate it never saw). Sequence is enforced by evaluating only the next pending gate.
- **Measured.** Skipping gate 2 → one `+30 s` penalty, run still FINISHES (`04:41.76 → 05:17.47`, Δ +35.7 s incl. the slower recovery). Skipping gates 2 and 4 → **DNF (gates)** at +60 s of penalties.

## 4. Clock is sim-time, not wall-time

- **Doc.** `docs/06 §3` fixed step; `PLAN.md §8 #7` repeatability.
- **Code.** `Timing.step(dt)` is called once per fixed `DT` from `StageRun.step(dt, car)` inside `stepSim`; `elapsed`, countdown, stuck timer and limit all accumulate `dt`. Nothing in `stage.js`/`timing.js` reads `performance.now()`.
- **Measured.** Two identical drives: total 281.758333 vs 281.758333 s, max sector diff **0.000000 s** (`tools/stagetest.mjs` B1).

## 5. Rally HUD update model

- **Doc.** `docs/07 F4`: "zegar, split, limit, uszkodzenia, 4 wskaźniki kół"; `.agents/skills/game-ui-ux` #5/#6 (screen stack, event-driven HUD).
- **Code.** `src/game/hud-rally.js` subscribes to `bus` (`checkpoint`, `penalty`, `finished`, `dnf`, `countdown`, `start`, `stage-reset`) for structural state, and `update(dt, ctx)` only paces the text: wheel gauges + clock at 20 Hz, lists + damage + pad polling at 8 Hz. Every DOM write is guarded by a cached string, so a value that did not change costs nothing. Layout is anchored in CSS (`index.html`) with `vmin` sizes and `env(safe-area-inset-*)` insets — no per-resize JS.
- **Measured (Node, stub DOM, 600 `update()` calls).** **0.0014 ms/frame** (budget 0.3 ms), heap growth **~900 B/frame**, all of it from the 20 Hz text rebuild — the per-frame path (`update` → early return or cached comparison) creates no objects. 35 DOM nodes total.

## 6. Headless driving harness

- **Doc.** `docs/07 F4` acceptance wants a full-stage drive; `tools/smoke.mjs` only has an 8 s drive with a fixed 0.8 throttle.
- **Code.** `tools/stagetest.mjs` reuses the pure-pursuit pattern and adds the pace model `v = sqrt(a_lat / κ)` over the next 140 m with the braking distance folded in (the same idea as `docs/03 §6` step 2), a curvature-scaled lookahead, and two guards the *player* also has (`docs/06 §5` "R = reset / zakotwiczenie"): re-place when lateral > 6 m or roll > 22°, and re-anchor after 1.25 s below 1.2 m/s. `main.js` shot mode uses the same pace model so `?frames=` screenshots stay on the stage.
- **Measured.** Clean full-stage drive: 34172 sim steps, `arc 4208 / 4229 m`, end speed 24.7 m/s, `nan false`, 28 re-anchors, max |lateral| 6.1 m, max airborne wheels 4. Stage generation 282–348 ms (budget 1200 ms).

## 7. What is NOT measurable headlessly

Draw calls, streamed mesh count and triangles are properties of `Streaming` + `Renderer` (browser, WebGL). `tools/stagetest.mjs` only prints `world.chunkCount` (chunks *materialized along the stage*, 3421 for the whole 4.2 km) — that is the world cache, not the scene's mesh count, and must not be compared with the `≤ 90 meshy` row of `docs/07`. The in-browser `F3` profiler (`hud` panel, `stream.stats.chunks / tris / props`) remains the source for those rows; the F4 change adds no draw calls (the rally HUD is DOM-only, `pointer-events: none` unless a modal is open).

## 8. Shot-mode screenshots

`?frames=` steps the sim synchronously, then renders. Software WebGL (swiftshader) renders black at some late-stage camera poses on this seed (the camera clips into terrain at the last crest/jump), so the reported proofs are the frames that do render: `shots/f4_mid.png` (seed 12345, len 4200, `?frames=12000`) and `shots/f3000_28000.png` (len 3000, `?frames=28000`, shows `KARY +30s` and a sliding wheel gauge). The finish frame (`?frames=34300`) reproduces the result modal correctly but renders black at that camera pose.

---

# F4 part 2 — ghost (ref_time), pace notes, co-driver voice, tablice strip

## 9. `ghost.js` — what the doc asks, what the code does, and the one knob

- **Doc.** `docs/03 §6` ("duch / offline solver → ref_time"), `docs/02 §3.4` (friction
  circle), `docs/07 F4` ("ghost.js + duch AI (offline solver) → ref_time i limity").
- **Code.** `solveGhost(road, { seed, gates, carId })` walks the 1 m spline samples:
  `mu_eff = effectiveMu(surface) * TYRE_BASE.gain` (the exact product `src/car/tyre.js`
  uses), corner limit `sqrt(mu_eff * g / R)` with a camber bonus that is *clamped by*
  that limit, then a forward (acceleration) pass from `car-params` 'A' (traction
  `mu·g`, power `P/v` with `P = maxTorque·peakRpm·π/30·efficiency` = 150 kW,
  rolling + aero drag) and a backward (braking) pass from `brakeMax / r_tyre` capped by
  `mu·g`. `t[i] = Σ ds / v` → `refTime`, `refSectors[]`, `ghostPath{x,z,t}`.
- **The knob (`GHOST_TUNE.referenceSpeedMargin = 0.73`).** A friction-circle-perfect
  solve on this stage is **168.97 s (90.1 km/h avg, max 33.5 m/s)** — it assumes a line
  that uses the whole 7.5 m corridor, no sight-line limit and no mistakes. With `limit =
  ref · 1.6` (`docs/03 §4`) that reference would make the *harness* driver (222.83 s)
  DNF on the limit (1.6 · 168.97 = 270.4 s), i.e. the stage would be unfinishable for a
  reference the player is supposed to chase. The margin is a single, explicit
  speed-space scale of the envelope (never above 1, so no corner ever exceeds
  `sqrt(mu_eff·g·R)`: measured worst ratio **0.721**). Calibrated on seed 12345 /
  4200 m against a lap of the shared headless pace driver
  (`src/debug/pace-driver.js`): **ghost 218.21 s (69.8 km/h avg) vs driver 222.83 s →
  2.1 % quicker**, a +5.45 s split, limit 05:49.13. Re-read the number whenever the car
  or a surface row is retuned: `src/debug/tests.js` T25 drives that lap inside the
  suite and fails when the reference stops being quicker than the car, while
  `tools/stagetest.mjs` E1/E3/A6 bound it to **ref in 215 s … 223 s** (quicker than the
  lap and within 25 % of it, within 20 s of split, and > 5 s away from the
  LEN/20 = 210 s constant-speed placeholder). `0.58` sat outside that envelope once the
  loose-surface drag retune made the car ~21 % quicker: ref 268.16 s, 20.3 % *slower*
  than the driver, a -44.30 s split, and a stage limit 28 % too generous.
- **Measured.** solve **3.8–7.8 ms** for the whole 4.2 km (budget 200 ms), 4230 nodes,
  5 sector refs `66.8 / 42.9 / 30.1 / 27.8 / 49.8 s`. Determinism: second solve over
  the same road → max |Δv| = 0, max |Δt| = 0 (`tools/pacenote-test.mjs` D1).
- **Doubt the orchestrator should know about.** `docs/07 F4` criterion A assumes a
  4.2 km drive of 110–190 s (90–130 km/h avg). The harness driver tops out at 26 m/s
  and averages 68 km/h *including* hairpins of R = 9–17 m, so it measures 222.83 s; the
  ghost is calibrated to it rather than to that band. Making the drive 110–190 s is a
  driver/AI-task (the pursuit driver would have to follow the ghost speed plan), not a
  reference-time problem.

## 10. `pace-notes.js` — geometry only, time-based triggers

- **Doc.** PLAN §2 ("notatki generowane z geometrii trasy"), `docs/03 §6`, `docs/07 F4`
  ("0 fałszywych, margines czasu ≥ 1.2 s przed zakrętem").
- **Code.** Candidates are the local maxima of raw `road.kappa` tighter than
  `FLAT_RADIUS = 200 m` (±20 m comparison window). Radius → class 1..6, sign of κ →
  `L`/`R` (κ > 0 turns toward `normal = t × up`, i.e. to the driver's right), turn angle
  over the group ≥ 150° or `FEATURE.HAIRPIN` → `DON’T CUT`, `road.feature` →
  `GARB / DOŁ / SKOK / WODA / MOST`, camber sign → `PÓŁTORA / NEGATYW`, class 1 →
  `UWAGA` (the doc's "Caution"), flat runs ≥ 260 m → `HANT`. Trigger point is a time
  rule: `lead = max(v_ghost·1.45 s, v²/2a_brake, 22 m)` where `v_ghost` is the speed the
  ghost carries *at that corner's apex*, so lead time scales with the corner instead of
  being a fixed distance. Triggers are pushed apart by `NOTE_MIN_GAP = 34 m`; a corner
  that cannot fit gets merged into the previous call as `"5L → 4R"`.
- **Measured (`tools/pacenote-test.mjs`, seed 12345).** 32 notes (23 corner, 9 feature),
  **0 false, 0 misses** over 41 raw curvature extrema, min lead **1.45 s** (max 4.83 s,
  requirement 1.2 s), min trigger gap **57.0 m = 3.98 s**, 0 merges, 0 dropped, ordered.
  Same seed → identical notes (D2: 0 differing).

## 11. `voice.js` — queue, preemption, fallback

- **Doc.** `docs/05 §7` (speechSynthesis variant A + deterministic variant B, "[VOICE]
  duckuje resztę o 3 dB", "nowa notatka przerywa starszą jeśli pilniejsza").
- **Code.** `Voice.advance(arc, dt)` runs on the fixed sim step (`main.js stepSim`), so a
  replayed drive triggers the same notes. Priority queue over 8 pre-allocated slots
  (`LOW/NORMAL/HIGH`); a HIGH note preempts a routine one that has ≤ 55 % of its
  estimated duration left; a note that could not finish before its corner
  (`apex − 1.2·v`) is *dropped*, never talked over. Variant A: `speechSynthesis`
  (`rate 1.35, pitch 0.95, volume 0.9`, Polish voice preferred). Variant B: 3-slot
  pre-built `osc → bandpass(1200 Hz, Q 2.2) → gain` burst pool, built lazily on the first
  note (no nodes created in the frame) + the identical text on the HUD sign. Ducking is
  a `setTargetAtTime` on `audio.masterGain` when an audio graph is handed in — `settings.audioEnabled` is still `false`, so in the browser today the co-driver is speech + HUD text; the click graph exists and is wired for F5.
- **Measured.** Driven at ghost speed over the stage (266.9 s of stage time): 32/32 notes
  spoken, **0 overlaps**, total spoken **36.6 s (13.7 %** of the stage), max queue depth
  0, 0 preemptions needed.

## 12. Tablice strip (PLAN §10) + `refTime` rewiring

- `src/game/hud-rally.js` adds `.rly-signs`: stage name, sector, split, limit remaining
  and four sign chips (the called note + the next three with the distance to the corner).
  CSS caps the strip at `max-height: 10vh`, anchored to `env(safe-area-inset-top)`, and the
  clock moved *below* it (`top: 11vh`) so the two never stack and the strip never covers the
  racing line. Redrawn at 12 Hz with per-chip string caches; `tools/stagetest.mjs` measures
  the whole HUD at 0.0014 ms/frame with the strip active.
- `src/main.js` no longer computes `roadLength / REF_SPEED`: `solveGhost` supplies
  `refTime` **and** `refSectors`, `?ref=` still overrides both, and the co-driver is stepped
  in `stepSim` (`voice.advance(ctx.arc, dt)`), reset with the stage, muted with `M`.
- **Screenshots.** `shots/f4b_sign.png` (seed 12345, len 4200, `?frames=1500`): strip shows
  `ODCINEK LEŚNY · SZUTER · 12345 · SEKTOR 1/5 · SPLIT −24.64s · LIMIT 05:42.57` with chips
  `MOST` (called), `UWAGA 1R DON’T CUT PÓŁTORA 60 m`, `5L NEGATYW 130 m`, `DOŁ 280 m`.
  `shots/f4b_finish.png` (seed 12345, len 700, `?frames=8000`): result modal `META 00:42.88`,
  `split vs referencja −2.99s`, `limit 01:15.72`. A full 4.2 km finish frame was not captured:
  the shot mode steps the sim synchronously and 34k steps exceed a practical headless-Chrome
  budget on this box; the short-stage frame exercises the same code path.
- **Not verified in this pass.** Actual audio output (no voice pack / no audio device in
  headless Chrome) and the click graph's sound — only its node count and queue timings are
  measurable headlessly.

## 13. Headless shot recipe (corrected 2026-10-09)

`--use-gl=angle --use-angle=swiftshader` alone no longer gives WebGL in headless Chrome: the driver
logs `Automatic fallback to software WebGL has been deprecated` and the 3D viewport renders **black
while the DOM HUD still draws**. The recipe now needs the opt-in:

```
google-chrome --headless=new --use-gl=angle --use-angle=swiftshader --enable-unsafe-swiftshader \
  --enable-webgl --enable-logging=stderr --window-size=1280,720 \
  --screenshot=shots/<name>.png "http://localhost:8123/index.html?frames=<substeps>&shot=1&stats=1"
```

Three failure modes that look like "the renderer is broken":
- missing `--enable-unsafe-swiftshader` -> black viewport, no JS error;
- an exception inside `FrameLoop.onFrame` escapes into the rAF callback and **kills the loop**, leaving
  a black viewport with a live HUD. `main.js` now wraps the HUD updates in try/catch for that reason
  (a debug overlay must never own game state);
- `hud.js` read `stage.arc`, which does not exist (`main.js` owns the arc in `ctx.arc`). That throw is
  what produced the two blank `shots/f5b_*.png` frames.

## 14. HUD rajdowy w układzie Colin McRae Rally (PLAN.md §10)

**Co faktycznie sprawdzono.** Zlecone przez orchestratora źródła (instrukcja CMR1 PS1 w
gamesdatabase.org, CMR04 na Scribd, cheatbook.de, taliagual.com, kcimgdryannothard.wordpress.com)
**nie były dostępne dla tego agenta** — brak narzędzia do pobierania treści
(tylko odczyt plików lokalnych). Opis tych źródeł w zleceniu potraktowano jako dane wejściowe,
a ich treść uzgodniono z lokalnym `docs/07` (F4: zegar, split, limit, uszkodzenia, 4 wskaźniki kół)
i z `pace-notes.js`/`voice.js` (semantyka notatek: niższa liczba = wolniejszy zakręt, metry,
UWAGA/DON'T CUT/garb). **Do zweryfikowania przez kogoś z dostępem do sieci** — jeśli któryś
z punktów poniżej mija się z instrukcją, poprawiamy HUD, nie filozofię.

**Co pokazują HUD-y CMR (wg opisu źródeł + własnego modelu rajdu):**
- 1-gracz: czas bieżący, obroty, prędkość, bieg, **strzałka pilota**, postęp w odcinku, split i najlepszy split.
- opcje **Game Displays: Full / Minimal / Off** oraz **Co-driver arrows On/Off** — gracz decyduje o gęstości.
- CMR04 dopisuje: pasek postępu z **znacznikiem reprezentującym auto**, split liczony
  w dół do noty pilota, **wartość ujemna = szybciej niż referencja**, małe wskaźniki water/oil/turbo.
- notatki: `6` ≈ pełny gaz, `1` = ostrzeżenie/zakręt wolny, metry do zakrętu, Care/Crest/Jump/Don't cut.

**Skopiowano 1:1:** pasek tablic u góry z rysowanym symbolem zakrętu + cyfrą 1..6 + licznikiem
metrów; cluster prędkościomierza w prawym dolnym rogu (tarcza ze strefą czerwoną, wskazówka,
duża cyfra km/h, okno biegu); pasek postępu odcinka z checkpointami i znaczkiem auta; mały zegar
i split u góry po lewej (ujemny = przód, kolor); trzy tryby gęstości Full/Minimal/Off na jeden klawisz.

**Zadaptowano (bo inna symulacja niż CMR):** zamiast water/oil/turbo pokazujemy to, co naprawdę
symulujemy — **SILNIK** (`damage.enginePowerScale`), **ZAWIS PRZ / ZAWIS TYŁ** (średnia `damage.susp`
na oś) — jako małe paski przy tarczy; tarcza ma skalę od `params.engine.redline` (czerwona strefa
od 86 % skali, bo `redline` zawsze wypada w ostatnim dziesiątniku wyświetlanej skali) oraz pulsujący
napis **SHIFT** przy 93 % skali (docs/05: audio-wizualny sygnał zmiany biegu); cztery wskaźniki kół
zostały, ale jako małe segmenty kolorem (czepne/uślizg/blokada/powietrze), liczby tylko w FULL.
Notatki **nie są drugą implementacją** — HUD czyta kolejność i priorytety z `pace-notes.js`,
a karta „mówiona teraz" jest podświetlana przez `voice.currentText`. Znacznik severity → łuk strzałki
jest liczony z krzywizny (`turnGlyph(150 - (sev-1)*22)`), hairpin dostaje własny łuk 200°.
Znaki rysowane są ścieżkami SVG generowanymi z matematyki — zero plików, zero `fetch()`.

**Architektura:** DOM budowany raz w konstruktorze (95 węzłów w teście), w klatce tylko
mutowane cache'owane teksty / klasy / `style.left|width` / jeden `transform` wskazówki;
atesty: tacho+zegar 30 Hz, koła 20 Hz, tablice 20 Hz, listy i pad 8 Hz. `settings.hudMode`
(FULL|MINIMAL|OFF) + `settings.showCoDriverArrows` trzymają wybór; klawisz **N** cykluje
peony → minimalny → wyłączony (`?hud=min|off` do zrzutów). Nakładka fizyki (`src/debug/hud.js`)
jest teraz **domyślnie zamknięta** (`settings.showPhysicsHud`), ma własną etykietę „DEV · FIZYKA",
kropkowaną ramkę, inny krój i `z-index` pod HUD-em gry — żeby zrzut HUD-u nie wyglądał jak teks-ciawka.

**Koszt (tools/stagetest.mjs, stub DOM, 600 wywołań):** `0.0027 ms/frame` (budżet ≤ 0.3),
`1488 B/frame` sterty (budżet ≤ 2048), 95 węzłów DOM, C1/C2/C3 PASS.

**Niedokończone / do poprawy:**
1. **Zrzuty pokazują czarny kadry 3D** —_recipe_ headless (`--use-gl=angle --use-angle=swiftshader(-webgl)`)
   zwraca mean jasności 1.4–9.2 na 255 (stare zrzuty w `shots/` mają mean 154), więc ocenić można
   tylko układ HUD-u, nie jego czytność na prawdziwym kadrze. Do naprawy w sesji z roboczym WebGL.
2. Nie ma jeszcze **najlepszego splitu** osobno (CMR1 pokazuje „best split") — `timing.js` go nie liczy.
3. Pasek postępu nie pokazuje **nazw checkpointów** (bram) ani ich koloru po przejechaniu;
   znaczniki S1..S5 są liczbowe.
4. `showCoDriverArrows` jest w settings, ale nie ma jeszcze klawisza/menu opcji (ekran opcji to inny task).
5. Tryb OFF nie pokazuje licznika startu jako osobnego kadr (licznik jest modalem) — celowe, zgodne
   z „OFF = tylko countdown i modal meta".

## 15. Czarny kadr 3D w zrzutach — diagnoza i naprawa (sesja F5)

**Przyczyna 1 (pomiarowa, dominująca):** `#boot` to pełnoekranowa, nieprzezroczysta
nakładka (`position: fixed; inset: 0; background: #0b0d10`). W trybie zrzutu ścieżka
statystyk wywoływała `hud.boot(<tekst render>)`, a `hud.boot(null)` był pomijany, gdy
`?stats=1`. Reguła bramek zrzutów zawsze zawiera `stats=1`, więc każdy kadr był
przykryty płytą `#0b0d10`/`--plate rgba(10,12,15,.62)`. HUD (`z-index 5`) świecił,
kadry WebGL „były czarne”. Naprawa: `src/main.js` — na końcu trybu zrzutu bezwarunkowe
`hud.boot(null)`; liczby renderu zostają na `window.__vrStats` (+ `renderer.info`).

**Przyczyna 2 (prawdziwa, w pipeline F5):** `PostChain` composituje scenę do
`rtScene` (RGBA16F) i dopiero blituje fullscreen quadem na domyślny bufor. Na
ANGLE/SwiftShader scena do RT renderuje się poprawnie (odczyt `readPixels`: mean 0.31,
max 0.48, lit 80 %, alpha 1), ale **żaden quad nie trafia na canvas** — nawet testowy
passthrough/`constant`: canvas mean 0.0000, alpha 0.000, przy `calls 1`, FBO
`FRAMEBUFFER_COMPLETE` i braku błędu GL/kompilacji. Ten sam quad do `rtA`/`rtB` rysuje
siępoprawnie. Efekt: `?post=1` => czarny kadr, ścieżka bez composite => poprawny kadr.
Gate: `settings.post = false` (domyślnie + presety MED/HIGH, `src/core/settings.js`),
`?post=1` włącza composite świadomie. `renderer.applyRig/setQuality` dobiera wtedy
`ACESFilmicToneMapping` + `toneMappingExposure` z riga (ścieżka wbudowana).

**Kolejność flag:** `?post=0/1` w `params()` jest czytane PO `?q=` (preset nadpisywał
`settings.post`), więc dawniejsze `?post=0` nie wyłączało composite przy `?q=MED|HIGH`.

**Artefakt zrzutu przy MED/HIGH:** kadr MED/HIGH (cienie 1536–2048, ~250 draw calli na
SwiftShader) jest liczony tak długo, że zrzut bez `--virtual-time-budget` trafia w
wyczyszczony bufor. Z `--virtual-time-budget=25000` kadr jest pełny.

**Jasność (PIL, pas 200..520000, mean/bright%/pas górnego nieba):**
| kadr | przed | po |
|---|---|---|
| `frames=200` MED, `stats=1` | 13.1 / 1.6 % / — | 25.2 / 14.5 % / 41.6 (`g_med200_vtb`, vtb=25 s) |
| `frames=8000` MED | 13.2 / 0.4 % | **121.1 / 88.4 % / 173.4** (`g_med8000_vtb`) |
| `?q=high` | 13.2 / 0.4 % | 31.7 / 19.8 % / 54.9 (`g_high_vtb`) |
| `?q=low` | 14.5 | **41.5 / 47.6 % / 58.8** (`g_low`, bez vtb) |
| `?post=1` | 13.1 | 8.5 / 1.3 % (`g_post1`) — composite nadal wyłączone |
Baseline: `shots/x_15000.png` 154, `shots/t_noon.png` 43.7.

**Wyłączone świadomie:** composite F5 (bloom/grade/grain/sunshafts) — `PostChain`
nienaprawiony w tym budżecie; działa tylko przy `?post=1` i tylko na sterowniku,
który naprawdę blituje RT na canvas. Oświetlenie (rig, fog, biome sky), cienie, ACES i
tonowanie działają w ścieżce bazowej.

## 17. Poprawka art (placki / drzewa / tarasy) — pomiar, nie zgadowanie

**Czego chce PLAN §10:** nawierzchnia czytelna i brudna, nie "płyta"; panele tej samej
nawierzchni różnią się wartością i odcieniem ≥12%; las przy drodze, nie siatka; zero
"płytkujących" jasnych elementów nad terenem.

**Diagnostyka (probe `tools/plates.mjs`, seed 12345/FOREST, korytarz startowy):**
kolor krawędzi płaskich ≈ sRGB (191,188,191), **stały piksel-w-piksel** (16+ pikseli
identycznych), podczas gdy nawierzchnia terenu w tym samym wierszu zmienia się co piksel
(fbm w shaderze). Płaska, neutralnie szara plama = **nie** materiał terenu.
Test A/B na tym samym seedzie (`?seed=471304713`):
`shots/art5_before_fixed.png` (przed) vs `shots/art6_after.png` (po) vs
`shots/art7_noprops.png` (po + wyłączony POST/SPECTATOR/GATE) — placki **nie zniknęły
nawet przy wyłączonych propsach** (1643 vs 1745 px). Źródło placków leży więc poza
moim zakresem plików: warstwa renderowana po stronie `src/dirt/` / `src/car/`
(najpewniej `src/dirt/dirt-map.js` — dekał/ślady na drodze, neutralna szarość, lekki
offset nad powierzchnią). `src/world/mesher.js` NIE jest źródłem.

**Co realnie zmieniłem (i co to dało):**
- `src/world/mesher.js`: `AO_LEVELS` [1,0.74,0.54,0.36] → [1,0.82,0.68,0.56]; worn-lip
  `wear` na topach skrócony (0.18+0.8·drop → 0.12+0.32·drop, `sep` ±0.34 → ±0.14);
  twarde albedo `ALBEDO_MAX = 0.70` na topach; **`WALL_SHADE = 0.66` +
  `ALBEDO_WALL_MAX = 0.50` na ścianach** (przy `tod 0.70` słońce ma 16° elewacji, więc
  face pionowy bierze NdotL≈1.0 a poziomy ≈0.28 — ściana była ~3× jaśniejsza od gruntu);
  rampa tónu pasma odwrócona (jasna strona na crevice, nie na lip);
  **podział wysokiej ściany na podpasma** (`parts ≤ 3`, ≥1/3 m) z niezależnym tónem →
  półka 1 m nie jest już jednym płaskim quadem; wypiekane normalne nachylenia
  0.55 → 0.95 (miększy sylwetka tarasu).
  Efekt w proberze: quady o min-kanał ≥0.45 w korytarzu **1202 → 19**.
- `src/world/palette.js`: GRAVEL 0xa8977a → 0x8b7c62, tone [0x9d8d72,0x6f6149];
  SHOULDER 0x8f7f65 → 0x7c6e56, tone [0x8c7f66,0x605442]. Rozrzut wartości między
  kotwicami tone tej samej nawierzchni: GRAVEL 156→115 = **26%** (≥12% ✓, criterion 2).
- `src/render/renderer.js`: wear w shaderze `mix(0.80,1.17,wear)` → `mix(0.87,1.05,wear)`,
  addytywny term 0.018 → 0.008; cache key 'vr-terrain-f7'.
- `src/world/props.js`: drzewa — rodziny odcieni (dąb/birch: pnie 0x5c4127 warm-brown,
  korony 0x2f5a24…0x3a6630, niebieskie kanały obniżone; sosna/świerk: 0x1f3d1f…0x2c5230
  z pniem 0x3d2c19 wchodzącym w koronę; suchy/birch: 0x6a5843 z pasami 0x4c3f2e),
  wysokości pni 4.3 / 6.0 / 4.4 m, korony z bryłami przenikającymi pień i siebie
  (brak "wolnych kostek"); POST — neutralna biała plakietka 0xd8dbe0 usunięta
  (ciemne drewno + ciemna czerwień), GATE banner 0xf3f5f8 → 0xcbb691, POST sadzany na
  wysokości *carved* (`columnTopAt`) zamiast analitycznej.

**Pomiary:** tris 346 244 → 408 764 (limit 1.4 M ✓); draw calls w trybie shot
niestabilne w liczniku (14 / 250 / 779 w kolejnych przebiegach — `info.render.calls`
w shot-mode kumuluje się między klatkami; render ms raportowany jako 0.00, bo shot
renderuje jedną klatkę). Jasność kadru: przed mean 74.2 / 67.1% bright; po mean 64.7 /
59.3% (mean ≥60 ✓ — nie przyciemniłem świata, tylko ściany i gravel). Metryka
"min(r,g,b)>190 poniżej y=300": 1827 → 1788, ale po odseparowaniu HUD-u (prędkościomierz
+ panel SILNIK dają ~1100 z tych pikseli, w tym (255,255,255) 740 px) placki w
pasie y 545-660 poza HUD: 1689 → 1643.

**Gates:** tests 9/9 ✓ · smoke `end v 23.3 nan false` ✓ · stagetest ALL PASS ✓ ·
pacenote ALL PASS ✓. `BANK 9.5 → 13.5` (szersza banks) **przerwał stagetest (1
FAILURES)** i został wycofany — terracing został więc tylko na poziomie meshera
(podpasma + normalne), bez zmian fizyki korytarza.

## 18. Placki rozwiązane: to nie była warstwa, tylko **dziura w siatce terenu**

**Diagnoza (twardy dowód, nie zgadywanie):**
1. `renderer.render` z wyłączoną widocznością *wszystkich* meshy → cały kadr w pasie
   y 300-720 ma kolor **(191,188,191)** (323 555 px). Czyli (191,188,191) to kolor
   **pustej sceny** (niebo/fog po tonmapie), a nie kolor jakiegoś materiału.
2. Prowizoryczne pody terenu na magentę (`diffuseColor = vec3(1,0,1)`, kadr
   `shots/plates_magenta.png`): placki **nadal dokładnie (191,188,191)** obok pikseli
   (16,1,16) — więc nie są oświetlanym terenem.
3. Prowizoryczne przypisanie 7 gatunkom propsów osobnych kolorów (`shots/plates_species.png`,
   zielony dąb = 38 928 px, czyli tint działa): placki **nadal (191,188,191)** — nie propsy.
4. W scenie istnieją tylko: terrain Mesh (terrainMaterial), props InstancedMesh
   (propMaterial), grupa auta, fullscreen quad brudu obiektywu (tylko przyciemnia,
   alfa ≤ 0.6, kolory ciemne). Placki nie należą do żadnego z nich → **są otworem**:
   w szczelinie nawierzchni widać pustą scenę przez wycofaną (back-face-culled)
   ścianę sąsiedniego panelu. Stąd „płaska, stała szarość” i dlaczego przeżyła
   wszystkie testy materiałowe A/B.

**Dlaczego powstają szczeliny:** siatka wysokości *renderowana* jest kwantowana do
1/8 m (`mesher.js BED_GRID`/`snapQ`) i sąsiednie chunki są meshowane w różnych LOD
(ring 0 = 1 m, ring 1 = 2 m, ring 2 = 4 m, `peak` zamiast sredniej), a culling
scian/opróbowanie AO liczy sie od `world.columnTopAt()` (wartosc fizyczna,
niekwantowana). Na styku LOD i na wargach korytarza powstają pionowe szczeliny
pod-metrowe; przy `side = FrontSide` sa to **dziury**.

**Zmiana (jeden plik, `src/render/renderer.js:97`):** `terrainMaterial` dostaje
`side: THREE.DoubleSide` (+ cache key `vr-terrain-f8`). Zamiast dziury widać teraz
dalszą sciane szczeliny. Zero nowych trojkatów, zero nowych draw calls, zero assetów.

**Pomiar (ten sam seed 471304713, ten sam kadr, `--virtual-time-budget=60000`):**
| metryka | `shots/plates_base60.png` (przed) | `shots/plates_crackfix.png` (po) |
|---|---|---|
| px w kolorze placka (\|c−(191,188,191)\| ≤ 4), pas y 300-720 | 15 097 | **38** |
| j.w. bez klastrów HUD | 14 422 | **8** |
| stara metryka „wszystkie kanały > 190” (surowa) | 1888 | 1866 |
| mean kadru | 79.7 | 73.9 (≥ 60 ✓) |
| mean pasu sceny / lum>90 w pasie | 48.4 / 5.3% | 42.1 / 1.9% |

Uwaga o metryce: placki leża w 188-191, a ~1100 z pikseli „>190” to HUD (prędkościomierz,
panele SILNIK, 740 px czystej bieli). Dlatego poprzednie A/B (propsy, „1689 → 1745”)
nic nie mierzylo — liczylo HUD. Poprawna metryka to odleglosc od koloru pustej sceny.

**Co zostalo odrzucone (z zmierzonym powodem):** najpierw sciemnilem oświetlone
sciany w shaderze terenu (`wallness()` + `directDiffuse *= 0.28` na riserach,
roughness lip 0.62) — placki zostaly bez zmian (14 422 → 15 005 px), a mean kadru
spadł 64.7 → 47.6. Sciany byly czerwonym herregiem; zmiana zostala cofnietа i nie
weszła do drzewa.

**Niedomknięte (świadomie, poza budżetem czasu):** szczeliny teraz czy­tają jako
**ciemne, ostre rozcięcia** w nawierzchni zamiast jasnych placków — jest ciemniej
i zgodnie z „nawierzchnia ciemniejsza niż otoczenie”, ale nie jest to ciągła,
upierzona linia jazdy. Właściwa naprawa geometryczna (poza tym zadaniem):
spójna siatka przy cullingu (kwantowana `topQ` zamiast `columnTopAt`) albo
**spódnica (skirt) na styku LOD** w `src/world/mesher.js`; wtedy `DoubleSide`
może wrócić do `FrontSide`. Terrasowanie korytarza (cel drugorzędny) nie bylo
ruszane — `BANK` zostaje 9.5 (jego poszerzenie psuje `tools/stagetest.mjs`).

**Gates po zmianie:** `node src/debug/tests.js` 9/9 ✓ · `node tools/smoke.mjs`
`end v 23.3 nan false` ✓ · `node tools/stagetest.mjs` ALL PASS ✓ ·
`node tools/pacenote-test.mjs` ALL PASS ✓. `node --check src/render/renderer.js` ✓.
Koszt renderu: draw calls i trojkaty bez zmian (ta sama siatka); w trybie shot
licznik `renderer.info` jest zawodny — dwukrotne rasterowanie scian wewnętrznych
terenu widac dopiero w HUD profilerze (zywa petla).

## 19. HUD: obiekty Colina McRae przerysowane na Minecraft (PLAN.md §10.1)

**Co jest skórowane, nie zmieniane:** obiektami i układem dalej rządza Colin McRae
(§10); zmienił się wyłącznie język wizualny — zamiast deski rozdzielczy „sim dashboard”
mowa wizualna Minecrafta. Notatki wciąż pochodzą z `src/game/pace-notes.js`, referencja
z `src/game/ghost.js`, zegar z `src/game/timing.js`, sector/checkpointy ze `src/game/stage.js`,
uszkodzenia z `src/car/damage.js` — żadnego drugiego systemu notatek nie dorobiono.

**Mapa obiektów (CMR → co rysujemy):**

| CMR (instrukcja) | ten HUD |
|---|---|
| co-driver signs | drewniane tablice (oak-sign): blokowa strzałka zakrętu (kink / normalny / ostry / hairpin / podwójny, L i R), cyfra ostrości, polskie słowo (`LEWY`, `OSTRO LEWY`, `NIE SKRACAJ`, `SKOK`, `GARB`, `HANT`…), dystans w metrach w wyrzeźbionej płytce; wejście i wyjście skokowo (2 klatki „pop”, zero easingu i alpha) |
| revs | hotbar: 10 slotów zapełnianych od lewej, zielone → pomarańczowe → czerwone przy limicie |
| gear / gear change / max throttle | osobny slot z biegiem + przepełniony segment `MAX GAZ` na końcu hotbara |
| speed | blokowa tarcza (ząb co 10 km/h, luk czerwonej strefy z czerwonych bloków, wskazówka ze stosu kwadratów, flash strefy jako naprzemienne bloki red/white) + duże pikselowe cyfry km/h |
| water / oil / turbo | 3 sloty z blokowym wypełnieniem — stany, które ta gra naprawdę symuluje: `SILNIK`, `PRZÓD`, `TYŁ` |
| damage jako ułamane części | 4 sloty na róg (z `damage.susp`), wypełnienie = zdrowie, wzór pęknięć, gdy < 94 % |
| stage progress + znacznik auta | locator bar: tabliczki-checkpointy na pasku, blokowy znacznik auta, podświetlony aktualny sektor |
| czas + split + limit | mały panel z kamienia, lewy górny róg: `CZAS`, `SPLIT` (ujemny = zielony), `LIMIT` |
| (PLAN §8 #2) stan koła | rząd 4 slotów: zielony = czepne, pomarańczowy = uślizg, czerwony = blokada, niebieski = powietrze |

**Zasady vanilla GUI, których się trzymamy:** paleta `#C6C6C6` (panel) / `#8B8B8B` (slot) /
1 px kontur `#1E1E1E` / bevel 3 px: near-white u góry i po lewej, `#555555` na dole i po prawej
(światło z lewej góry), wnętrze slotu recessed (bevel odwrócony); akcenty wyłącznie stanowe:
zieleń, czerwień, ciepłe drewno tablic (+ pomarańcz/błękit dla stanów koła, §8 #2 wymaga
różnych stanów). Zero gradientów, zero blur, zero zaokrągleń, zero półprzezroczystych paneli,
zero CSS `filter`, zero fontu systemowego.

**True pixel art:** `src/game/pixel-font.js` — glify pisane w źródle jako siatki bitowe
5×7 na komórce 8×8 (ascent 7), arkusz sprite'ów budowany raz per kolor, rysowany
`drawImage` po współrzędnych całkowitych z `imageSmoothingEnabled = false`. Obsłużone
ą ć ę ł ń ó ś ź ż (plus górne), cyfry i `+ - . : / ° ' , ! ? % ( ) > < = # * ·`;
małe litery są składane do wielkich. HUD rysuje się do **jednego** canvasa: bufor
logiczny = viewport / całkowity `uiScale` (1–4, Minecraft GUI scale), `image-rendering:
pixelated`; panel odrysowuje się tylko gdy zmieni się jego klucz wartości, DOM nie jest
tworzony w pętli klatek (jedyny DOM: canvas, 4 placefocusu menu modala, probe `#rly-safe`
do `env(safe-area-inset-*)`). Modals (countdown / META / DNF) mają pixelowy panel z kamienia
i odwrócony blok focusu; keyboard i gamepadfocus chodzi po nich dalej (`Tab`, strzałki, ENTER/A).

**Koszt HUD (tools/stagetest.mjs C1/C2, 600 wywołania `update`):**
`0.0015 ms/frame` (budżet ≤ 0.3) i `1166 B/frame` sterty (budżet ≤ 2048) — rzędu dwóch
tysięcznych milisekundy, czyli wciąż taniej niż poprzedni HUD (0.0027 ms).
**Gates po zmianie:** `node src/debug/tests.js` 9/9 ✓ · `node tools/smoke.mjs` `end v 23.3  nan false` ✓ ·
`node tools/stagetest.mjs` ALL PASS ✓ · `node tools/pacenote-test.mjs` ALL PASS ✓.
Zrzuty: `shots/mc_full.png`, `shots/mc_min.png`, `shots/mc_finish.png`.

**Czego jeszcze nie ma (świadomie):** tablica notatki jako obiekt 3D przy drodze (§10.1
„obiekt w 3D, nie plakietka”), licznik czasu sektorów w wariantcie MINIMAL, oraz
sygnał dźwiękowy przejścia przez bramę. Placki na drodze w tych kadrach to znana,
osobna usterka meshera (§18) — nie byla ruszana i nie urosla.

## 20. Świat wg §10.2: sprite'y roślinności, koleiny zamiast placków, jasne światło, pogoda odcinka

**Czego żąda §10.2:** roślinność jako sprite'y (krzyżujące się płaszczyzny z alfą,
tekstura 16/32 px generowana w kodzie), droga z **ciemniejszym ubitym śladem kół**,
jaśniejszym poboczem i wyraźną krawędzią, słupki z flagami po zewnętrznej zakrętów,
światło jasne i wysokie (nasycone niebo, ciepły klucz, krótka mgła), oraz `tod`
i pogoda jako **cechy odcinka**.

**Co teraz robi kod:**
- `src/world/props.js` — rośliny to **skrzyżowane płaszczyzny z alfą** (3 płaszczyzny
  dla drzew, 2 dla krzewu/paproci), **nie** zwracane do kamery. Tekstury 32×32
  malowane proceduralnie w kodzie (`buildFoliageTextures` → canvas + `CanvasTexture`,
  `NearestFilter`, bez mipmapów, `image-rendering: pixelated`): świerk/sośna o
  stożkowej sylwetce, dąb z tiga klap, **brzoza z blady, paskowany pień**, krzew,
  paproć/bracken. Pięć gatunków = pięć tekstur zbudowanych **raz przy starcie**,
  jedna `MeshLambertMaterial` + `alphaTest 0.5` + `DoubleSide` na gatunek (Lambert,
  więc sprite'y ciemnieją w cieniu, nie świecą; `alphaTest` zamiast transparentu =
  brak artefaktów sortowania, a cień liczony po alfa). Wokselowe pudła-korony usunięte.
  Nowe typy `BIRCH`, `BUSH`, `FERN`; krzewy/paprocie stoją od `pas + SHOULDER + 1.2 m`
  (props nie mają kolizji → fizyka bez zmian). `POST` = 1.6 m tyk ze **flagą 0.62×0.42 m**
  (czerwona z białym pasem) po zewnętrznej zakrętu, co 8 m przy |kappa| >= 0.035.
- `src/world/road-carve.js` — pole `wear` znaczeniowane jako **ton** (0 = najciemniejszy
  ubity ślad koła, 255 = najbielszy). Dwie koleiny przy ±55 % półszerokości, ciemny
  szew w osi, jaśniejszy pas pobocza (205..157), ogon na skarpie <= 26 i znika w 1/3
  BANKU (trawa nie dostaje już jasnych płyt). Stara rampa (70..220, środek drogi
  *jaśniejszy* niż pobocze) była dokładnie tym, co zrzuty czytały jako „placki”.
- `src/world/mesher.js` — łączenie paneli liczy się teraz też z **skwantowanego wiadra
  `wear` (>>5)**, więc pas koleiny jest osobnym panelem (koleiny są ciągłe, nie łatką);
  waga `pw` 0.16 → 0.60.
- `src/render/renderer.js` — dla nawierzchni drogowych `mix(0.70, 1.06, wear)` +
  krzyżowy splot w pasie + tylko górna część pasma dostaje podbicie krawędzi;
  naturalny grunt zachowuje wąską rampę 0.88..1.04. Na asfalcie koleina obniża
  chropowatość (słaby połysk, nie odbicie). Dodany uniform `uWet` (mokrość odcinka).
- `src/render/lighting.js` — STOPY jaśniej: noon key 2.75→3.20 / amb 1.30→1.52 /
  fog 0.50→0.36, golden hour 3.05→3.55 / 1.26→1.52 / fog 0.78→0.46, ekspozycje w gore,
  `fillIntensity` 0.92 + 0.95·sin(elev).
- `applyRig`: sun ×1.34, hemi ×1.42, fill ×1.38, saturacja nieba (oderwanie od szarości),
  **mgła krótka**: `near = max(120, far·(0.70−0.12·haze)/hazeBias)`, `far = far·(1.05+0.30·haze)`.
- `src/world/road-spline.js` — `stageClimate(seed, biome)`: `tod`, pogoda
  (CLEAR/OVERCAST/DUSK/RAIN), `wet`, `haze` z **osobnego forku seedu** (geometria drogi,
  a więc ghost i notatki, nie drgną); wieszane jako `road.climate`, konsumowane przez
  `renderer.setTimeOfDay` (nadpisalny tylko przez `?tod=`) i nowe `renderer.setClimate`.

**Pomiar (seed 471304713, 1280×720, SwiftShader):**

| kadr | mean | bright% | dark% | px min>190 |
|---|---|---|---|---|
| `shots/cmr_before.png` (tod 0.70, sprzed) | 106.8 | 69.3 | 10.9 | 10774 |
| `shots/cmr_straight.png` (tod odcinka 0.47) | 121.7 | 94.5 | 3.3 | 13281 |
| `shots/cmr_tod70.png` (A/B tym samym tod) | 110.0 | 90.2 | 4.6 | 13239 |
| `shots/cmr_corner.png` (brama + zakret) | 127.0 | 88.0 | 9.3 | 15337 |

Cele §10.2 (mean >= 85, bright >= 70) przekroczone bez zgniatania cieni (dark 3-9 %,
poprzednio 10.9 %). `renderer.info`: **84 draw calls / 28 242 tris** (budzet ≤180 / 1.4 M),
10 `InstancedMesh` propsów, 5 tekstur 32×32 zbudowanych raz. `tools/plates.mjs`:
**18** quasi-bialych quadów meshera (14 szuter, 3 pobocze, 1 kamien) — wcześniej
tysiace paneli; licznika „przed” na HEAD nie odłączam, bo HEAD juz nie jest aktualny.
Licznik near-white **pikseli** urósł — to jaśniejsze, nasycone niebo (którego §10.2
wymaga), nie placki: metryka musi byc zaweza do pasma sceny bez nieba.

**Gates:** `src/debug/tests.js` 9/9 · `smoke.mjs` `end v 23.3 nan false` ·
`stagetest.mjs` ALL PASS · `pacenote-test.mjs` ALL PASS · `node --check` na wszystkich
osiem plikach.

**Czego nadal brakuje do referencji:** sprite'y bez mipmapów migaja w dali; pień jest
omalowany w sprite'ie, a nie wokselowy (stub geometii jest, ale nie instancjonowany → instancjowany);
na zakrecie droga czyta sie za bardzo „błoto” — pasma kolein sa za szerokie w stosunku
do pasa jaśniejszego pobocza, które wciąż wygląda jak płyty; tarasowanie krawedzi
(kwantyzacja carvu) rwie ciągłość koleiny; nie ma jeszcze `sunshaft`/grade pod nowa
ekspozycje; pogoda odcinka nie jest pokazana w HUD; `DirtMap` nie karmi koleiny
swiata (jego kurz idzie tylko do shaderu auta) — warstwa placków okazala sie **pasem
`wear` carvu + mappingiem w shaderze**, nie `dirt-map.js`.

## 21. Auto wg §10.2: bryła z profilem, koła instancjonowane, livery z numerem

**Czego zadaza §10.2:** „Auto z numerem i barwami zespołu. Czytelne barwy, okrąg z
numerem startowym, pasy, widoczne nadkola i koła, uszczerbki pokazane jako
uszkodzone/brakujące elementy (zbita lampa = jeden element mniej), nie jako pasek
procentów" + „nadwozie z objętością i zaokrągleniami, felgi i opony jako osobne
bryły, światła (przednie świecą nocą), cień kontaktowy pod autem".

**Co było:** `carMesh.js` budował auto z 14 `BoxGeometry` (płyty) i 4 cylindrów.
Na zrzucie wychodził różowo-biały klocek bez kół — **koła były źle pozycjonowane**:
`syncCarMesh` wstawiał *world* (`w.hub`, `w.y`) jako pozycję *lokalną* dziecka
grupy auta, więc wszystkie cztery lądowały kilkaset metrów obok karoserii. Dodatkowo
trzy kolumny bazy koła były budowane na tym samym `_v`, więc `makeBasis` dostawał
trzy razy ten sam wektor.

**Co jest teraz** (nowe pliki `src/render/car-body.js`, `src/render/car-livery.js`):
- `VolumeBuilder` — bryły **zeszifrowane** (ścia + krawędzie + narożniki ścięte,
  44 trójkąty na bryłę) oraz **loft profilem bocznym**: `tub` (11 punktów: nos,
  maska, przegroda, pokład, tył, spód) i `cab` (4 punkty: **nachylona szyba
  przednia, dach, nachylona szyba tylna**). Nic nie jest gładkim `BoxGeometry`.
- Dokręcone elementy: słupki A/B + linia szyb, **nadhkola** (2 zszifrowane bryły
  na koło, wypukłe na zewnątrz progu), progi, zderzaki przód/tył, atrapa,
  **roof scoop**, lusterka na ramionach, końcówka wydechu, dyfuzor, **tylny
  spoiler** tylko tam, gdzie `aero.downforce >= 0.5` (A/B/D, C bez).
- ~1600 trójkątów karoserii, ~320 na koło.
- **Koła:** jedna geometria + `InstancedMesh(4)`: opona z realnym bieżnikiem
  (14 segmentów, naprzemienny promień bieżnika = kostki + środkowy kanał),
  boki opony, bęben felgi, 5 ramion, piaasta, **tarcze hamulcowe po obu stronach**
  (ta sama geometria dla L i P). Transformacja liczona z `w.hub`, `w.y`,
  `w.forward`, `w.right` **przeniesionych do przestrzeni auta** (`q⁻¹`), obrót
  z `w.omega`, skali z `w.rEff / w.rGeo` (miękkie lądowanie = zgnieciona opona).
  Brud na oponach: `instanceColor` (mnożnik per koło) — nadal 1 draw call.
- **Livery w kodzie:** jedna mapa 128×128 (`CanvasTexture`, `NearestFilter`,
  mipmaps off, `SRGBColorSpace`), rysowana **raz przy starcie** per `car.id`:
  A `#c0181f`/biały nr **7**, B granat/żółty nr **3**, C zielony/kremowy nr **12**,
  D żółty/granatowy nr **5**; panele drzwi, pas na linii barkowej, pasy dachowe,
  bloczki „sponsorskie" (`KORVETT / SZUTER / RALLY`), zaciemniony nos i tył oraz
  **okrąg startowy: biały okrąg + czarna cyfra**. Mapowanie jest triplanarne
  (bok → u,v; góra → u,v z Z; przód → v,z), zapeklowane per wierzchołek, więc
  ten sam numer czyta się na drzwiach i na dachu. Atrybuty geometrii:
  `aLivUv` (vec2), `aLiv` (float, 0 = szyba/zderzak/twarda plastika, 1 = lakier).
- **Uszkodzenia jako fizyczne części** (`applyDamage`, tylko przy zmianie stanu,
  zero zapisów per klatka): `frontHits 1..2` = zderzak przedni przekrzywiony
  (obrót ~0.1 rad + przesunięcie) i przyciemniony; `frontHits >= 3` = zderzak
  **usunięty** (region zwinięty do punktu = trójkąty zdegenerowane); `lights[0] == 0`
  = lampa martwa (emissive 0.05, kolor ×0.2), a przy ≥3 uderzeniach obie bryły
  lamp **znikają**; `severityPct` steruje uniformly `uDamage` = pikselowe pęknięcia
  paneli w shaderze. Żadnych pasków procentów na aucie. Zgnieciona geometria ma
  zachowane kopie originalne (`regions[].pos/.col`), więc `service()` przywraca kształt.
- **Światła nocą:** panele lamp mają atrybut `aLamp` (1 przód, 2 tył) →
  `totalEmissiveRadiance` (bez dodatkowych draw calli); tylne zapalają się mocniej
  przy hamowaniu (`car.input.brake`). Dla `settings.tod > 0.78 lub < 0.22`
  (`renderer.setTimeOfDay` wystawia teraz `settings.tod`) auto dostaje **2
  `SpotLight`** (bez cieni) — na nocnym zrzucie widać dwa stożki na drodze.
- **Brud §10.2 dalej czytelny:** warstwa brudu (16 paneli: albedo, roughness,
  smugi, spray z `dirt-map.js`) jest nietknięta; zmieniło się tylko *sposób
  przypisania* — indeks panelu nadaje teraz `car-body.js` per bryła/sciana
  (`hood`, `roof`, `screenF`, `screenR`, `flankL/R`, `sillL/R`, `archFL/FR/RL/RR`,
  `front`, `rear`, `under`, `wing`), zamiast nearest-box `classifyPanel`, więc
  profile trafiły tam, gdzie powinny. `src/dirt/` nietknięte.

**Pomiar** (`renderer.info` w trybie zrzutu, seed 471304713, MED):
draw calls **223 → 216** (auto: 5 obiekty → 2: body + 1 InstancedMesh; budżet
twardy 220 jest spełniony, wcześniej był przekroczony przez auto+kawałki terenu),
trójkąty **40 186 → 42 758** (budżet 1.4 M). Tekstury auta: livery 128×128 RGBA,
`panelTex` 16×1, `panelCol` 16×1, `sprayTex` 512×512 — wszystko budowane raz.

**Zrzuty:** `shots/car_chase.png` (widać bryłę, koła, nadkola, spoiler, okrąg na
dachu; tył jest zakryty płytą błota po 66 s szutru — to brud symulacji, nie lakier),
`shots/car_close.png` (orbita 9 m: carczytelny czerwono-biały livery, felgi z
ramionami, tinted tires, cień kontaktowy pod karoserią), `shots/car_night.png`
(tod 0.93: dwie plamy świateł na drodze, czerwone światła tylne).

**Co nadal wygląda źle:** (1) z bliska karoseria jest wciąż *za bardzo pudełkowa*
— maska i pokład są płaskie, brak progu między błotnikiem a drzwiami; (2) livery
triplanarne ciąnie pasy także tam, gdzie nie powinny (przód/tył dostają pasy
dachu); (3) numery i napisy czytają się tylko z bliska (128×128, nearest);
(4) lusterka to dwa chipy na ramionach, szyby bez odbicia środowiska (brak
envmapy — §10.2 postuluje „szyby z odbiciem"); (5) tarcze hamulcowe świecą
czerwienią dopiero gdy sim wystawi temperature opony — `tyre.js` jej nie ma,
więc na razie są stalowe; (6) zapadniecie rogu przy zbitej suspensji pokazuje
się tylko przez koło (fizyka obniza hub), karoseria jako jedna bryła nie wisie.
