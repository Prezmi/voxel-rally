# 07 — Roadmap, budżety, ryzyka

## Faza 0 — Bootstrap (1 dzień)
**Cel:** działający szkielet, nic ładnego.
- `index.html` z import map, Three.js, canvas fullscreen, resize, HDR RT.
- Pętla ze stałym krokiem + interpolacją, `settings.js`, `rng.js`, `events.js`.
- Debug HUD z FPS, czasem sim, czasem render.
- `npm run dev` = `python3 -m http.server`.

**Kryteria:** 60 FPS na pustej scenie; `F3` pokazuje sim < 0.5 ms; brak zależności poza Three.js.

---

## Faza 1 — Świat i jazda pudełkiem (3 dni)
**Cel:** teren, droga, kamera, sterowanie.
- `palette.js`, `surfaces.js` (tabela z `02 §4`), `noise.js`, `terrain-gen.js`.
- `road-spline.js` + `road-carve.js`: jeden odcinek szotrowy 3.4 km.
- `chunk.js` + `mesher.js` (face culling, greedy, vertex AO) + `streaming.js`.
- Auto = pudełko na 4 "sprężynach" (bez modelu koła), `raycast-terrain.js`, `camera.js` CHASE.
- Input klawiatura + gamepad.

**Kryteria:** odcinek generuje się z seedem w < 1.2 s; draw calls ≤ 220; auto jedzie, skręca, nie zapada się, nie wylatuje; teren wygląda na "rajdowy las", nie na losowy noise.

---

## Faza 2 — Fizyka per-koło (5 dni) ← **najważniejsza faza**
**Cel:** cztery koła, cztery prawdy.
- `wheel.js`, `suspension.js`, `tyre.js` (Pacejka + okrąg tarcia + roll + plough), `diff.js`, `powertrain.js`, `steering.js`.
- Różne zachowanie na 4 nawierzchniach: **test "ten sam zakręt, 4 materiały"** — zmienia się prędkość, linia i sposób hamowania.
- Hamulec ręczny, uszkodzenia zawieszenia wpływające na `k`/`c`.
- `debug/physics-hud.js` + 7 testów regresji.

**Kryteria:** wszystkie testy z `02 §11` przechodzą; gracz po 30 s potrafi celowo wprowadzić auto w poślizg i wyjść kontrą; na asfalcie kontrolowany poślizg jest **wolniejszy** niż trzymanie linii (sprawdzone czasami), na szutrze szybszy; determinizm ±0.02 s.

---

## Faza 3 — Brud (3 dni)
**Cel:** auto brudzi się zależnie od nawierzchni i jest to czytelne.
- `dirt-map.js` (RT 512², splaty), `panel-dirt.js` (16 paneli), `emitters.js` (reguły per nawierzchnia z `04 §4.2`), ewolucja (schnięcie, odpadanie), `wash.js`.
- Warstwa brudu w shaderze auta (albedo + roughness + normal + smugi).
- Brud na obiektywie kamery.

**Kryteria:** po 30 s jazdy 4 zrzuty ekranu (szuter / asfalt / błoto / śnieg) pokazują **4 różne maski brudu** — różnią się lokalizacją, grubością i kolorem, nie tylko jasnością; po myciu auto jest wyraźnie czyste, a guma na oponach zostaje; koszt < 1.2 ms/klatka.

---

## Faza 4 — Pętla rajdowa (3 dni)
**Cel:** to staje się rajd, nie symulator.
- `stage.js`, `timing.js` (start, checkpointy, sectory, kary, limit, DNF).
- `pace-notes.js` + HUD notatek + `voice.js` (speechSynthesis + fallback).
- `ghost.js` + duch AI (`props`/offline solver) → `ref_time` i limity.
- HUD rajdowy: zegar, split, limit, uszkodzenia, **4 wskaźniki kół**.

**Kryteria:** pełny przejazd odcinka z notatkami, 6 checkpointów, kary działają, split pokaże `+0.7s` po sektorze; notatki są prawdziwe (test: 0 fałszywych, margines czasu ≥ 1.2 s przed zakrętem); pilot nie nakłada się (kolejka z priorytetem).

---

## Faza 5 — AAA polish (5 dni)
**Cel:** obraz i dźwięk na poziomie, który sprzedaje fizykę.
- `post.js`: bloom, motion blur, grade LUT, grain, vignette, CA, haze.
- `particles.js`: odłamki-bloki, kurz, bryzgi, śnieg, woda, dym (pule).
- `decals.js`: ślady opon per nawierzchnia + koleiny w heightfieldzie.
- `shadow.js` 2 kaskady, `sky.js` proceduralny, noc + reflektory, deszcz.
- Audio: `graph.js`, `engine-synth.js`, `tyre-synth.js` (4 tory), `granular.js`, `impacts.js`, `ir.js`, `music.js`.
- `damage.js` wizualny (deformacja per blok) + `camera.js` shake + 3 dodatkowe kamery.

**Kryteria:** 60 FPS w 1080p z pełnym postem; ślad opon pojawia się tylko przy uślizgu (test); kurz za autem na szutrze jest wyraźnie większy niż na asfalcie przy tej samej prędkości; audio: testy z `05 §10`; zrzut ekranu "wygląda jak gra", nie "jak demo Three.js".

---

## Faza 6 — Content (4 dni)
**Cel:** 8 odcinków, 4 auta, czempion.
- 5 biome'ów, 8 odcinków z tabeli z `01 §4` + warianty (mirror/reversed).
- `car-params.js` 4 auta, `setup-ui.js` tuning + preview w test tracku.
- `championship.js`, `save.js`, odblokowania, tryby (Rajd / OS / Test track).
- Noc, deszcz, mróz jako warstwa warunków.

**Kryteria:** wszystkie 8 odcinków generuje się i jest przejezdnych duchem AI (ref_time istnieje, limit nie jest sztuczny); 4 auta różnią się czasami na różnych nawierzchniach (macierz 4×4 czasów — różnice > 4% tam, gdzie powinny być); ukończenie sezonu możliwe bez restartu.

---

## Faza 7 — Hardening (3 dni)
**Cel:** stabilność, wydajność, dostępność.
- Skalowanie jakości (LOW/MED/HIGH), profilowanie, budżety z `PLAN §7`.
- Gamepad kalibracja, opcje dostępności (kolory dla daltonistów, napisy zamiast głosu, limit wstrząsów kamery, brak migotania).
- Balans: kary, limity, uszkodzenia, asysty.
- Długie sesje: wycieki (heap, węzły audio), reset odcinka, pauza.

**Kryteria:** 30 minut jazdy bez spadku FPS i bez wzrostu heap; 0 błędów w konsoli; gra działa na zintegrowanej grafice (LOW) w 30 FPS; `F9` testy przechodzą na LOW i HIGH.

---

## Budżety techniczne (twarde, sprawdzane w F3)

| Metryka | Cel | Twardy limit |
|---|---|---|
| sim.step(1/120) | ≤ 2.5 ms | 4 ms |
| render | ≤ 13 ms | 16.6 ms |
| draw calls | ≤ 180 | 220 |
| trójkąty | ≤ 1.4 M | 2.0 M |
| cząstki | ≤ 12 000 | 18 000 |
| chunky w scenie | ≤ 70 | 90 |
| remesh | ≤ 3/ms | 6/ms |
| decale aktywne | ≤ 2 500 | 4 000 |
| węzły audio | ≤ 45 | 60 |
| generowanie odcinka | ≤ 1.2 s | 2.5 s |
| JS heap | ≤ 180 MB | 220 MB |

---

## Rejestr ryzyk i mitygacji

| # | Ryzyko | Objaw | Mitygacja | Decyzja zapadająca w |
|---|---|---|---|---|
| R1 | Fizyka niestabilna (drgania, teleporty) | auto "wibruje" na prostej, wylatuje ze skarpy | stały krok, clampy sił i prędkości, pół-implicitny damper, soft contact, test 7 z `02 §11` | F2 |
| R2 | Raycast za drogi | sim > 4 ms | heightfield jako pierwszy poziom, per-blok tylko przy progu, cache kolumny per koło | F1 |
| R3 | Pacejka dobrana "na ucho" | auto nieprzewidywalne, nie do nastrojenia | `physics-hud` + testy liczbowe (F2 kryteria) jako **regresja**, nie odczucie | F2 |
| R4 | Brud wygląda jak szara mgła | wszystkie odcinki wyglądają tak samo | maski per panel, grubość + roughness + normal, splaty z kierunkiem, test 4 zrzutów | F3 |
| R5 | Audio brzmi syntetycznie | "buzz" zamiast silnika | envelope pracy cylindrów, granular zamiast stałego szumu, limiter, testy widmowe | F5 |
| R6 | Post-processing zjada FPS | 30 FPS na MED | własny 1-pass composite, bloom 1/4, opcje jakości, brak EffectComposer | F5 |
| R7 | Odcinki do siebie podobne | "znowu to samo" | bloki kompozycyjne z `01 §3`, warianty mirror/reversed, 5 biome'ów, warunki atmosfery | F6 |
| R8 | Notatki fałszywe/spóźnione | gracz traci zaufanie do pilota | generator z geometrii + test: 0 fałszywych, margines ≥ 1.2 s | F4 |
| R9 | Klawiatura niegrywalna | brak kontroli nad poślizgiem | rampa 120 ms binary→analog, steer rate limit, kalibracja pada | F7 |
| R10 | Scope creep (multiplayer, rallycross) | nic nie kończy się | poza zakresem v1, hak w architekturze tylko dokumentalny | stale |

---

## Definicja ukończenia v1

1. 8 odcinków, 4 nawierzchnie, wszystkie przejezdne i różne w technice.
2. Fizyka 4 kół z okręgiem tarcia, mechanizmem i uszkodzeniami — testy regresji zielone.
3. Brud zależny od nawierzchni, czytelny na zrzutach, z ewolucją i myciem.
4. Pełna pętla rajdowa: start, notatki, checkpointy, sectory, kary, meta, czempion, duch.
5. Cała grafika i cały dźwięk generowane w kodzie — **zero plików asset** (sprawdzane: brak katalogu `assets/`, brak `fetch()` innych niż moduły).
6. Budżety z tabeli spełnione na MED w 1080p.
7. Nowy gracz po 10 minutach potrafi: przejechać odcinek w limicie, użyć ręcznego do nawrotu, i powiedzieć, dlaczego stracił tył na którym kole.
