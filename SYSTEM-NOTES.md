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
- **The knob (`GHOST_TUNE.referenceSpeedMargin = 0.58`).** A friction-circle-perfect
  solve on this stage is **170.7 s (89 km/h avg, max 33 m/s)** — it assumes a line that
  uses the whole 7.5 m corridor, no sight-line limit and no mistakes. With `limit =
  ref · 1.6` (`docs/03 §4`) that reference would make the *harness* driver (281.76 s)
  DNF on the limit (1.6 · 170.7 = 273 s), i.e. the stage would be unfinishable for a
  reference the player is supposed to chase. The margin is a single, explicit
  speed-space scale of the envelope (never above 1, so no corner ever exceeds
  `sqrt(mu_eff·g·R)`: measured worst ratio **0.573**). Calibrated on seed 12345 /
  4200 m: **ghost 268.3 s (57 km/h avg) vs driver 281.8 s → 4.8 % quicker**, inside
  the ±25 % band criterion C asks for.
- **Measured.** solve **3.2–5.5 ms** for the whole 4.2 km (budget 200 ms), 4230 nodes,
  5 sector refs `71.7 / 58.9 / 36.6 / 36.6 / 64.7 s`. Determinism: second solve over
  the same road → max |Δv| = 0, max |Δt| = 0 (`tools/pacenote-test.mjs` D1).
- **Doubt the orchestrator should know about.** `docs/07 F4` criterion A assumes a
  4.2 km drive of 110–190 s (90–130 km/h avg). The harness driver tops out at 26 m/s
  and averages 54 km/h *including* hairpins of R = 9–17 m, so it measures 281.8 s; the
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
