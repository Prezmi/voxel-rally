# 03 — Świat: teren wokselowy, trasa ze splajnu, notatki z geometrii

## 1. Reprezentacja świata

**Chunk:** 16 × 16 kolumn, wysokość świata 96 bloków, rozmiar bloku 1.0 m.
**Dane chunka:**
```
Uint8Array  blocks[16*16*96]      // id bloku (0 = powietrze)
Int8Array   height[16*16]         // wysokość powierzchni (cache, liczony przy modyfikacji)
Uint8Array  surface[16*16]        // surface_id na powierzchni (fizyka czyta to, nie blocks)
Int8Array   rut[16*16]            // offset kolein w 1/16 bloku (ujemny)
mesh          per material group  // jeden mesh na grupę materiałów
dirty         flag do remeshingu
```

**Heightfield z subblokowym offsetem:** fizyka używa `h = height + rut/16 + micro(x,z)`, gdzie `micro` to proceduralna nierówność (noise, amplituda 0.06 m) — dzięki temu szuter "faluje" bez zmieniania bloków.

**Strumieniowanie:** promień 260 m wokół auta, ringi: `full (0–110 m)`, `simplified (110–200 m)`, `silhouette (200–260 m)`. Budżet: ≤ 90 meshy, remesh ≤ 6/ms.

---

## 2. Generator terenu

```
seed per stage (jeden integer, deterministyczny)

base        = valueNoise(x,z, 4 oktawy, lacunarity 2.0, gain 0.5)      → 0..1
warp        = noise(x + 12*noise(z), z + 12*noise(x))                  → domain warp
ridge       = 1 - abs(noise(x,z))                                      → grzbiety górskie
mountainMix = smoothstep(0.45, 0.85, warp) * ridge
height      = 12 + 26*base + 48*mountainMix
```

Biomy (wybór per odcinek, deterministyczny z seeda):
| Biome | Roślinność | Bloki | Uwagi |
|---|---|---|---|
| `FOREST` | gęste drzewa, paprocie | dirt/grass/gravel | klasyczny szuter CMR |
| `MOUNTAIN` | skała, śnieg na szczycie | stone/snow/ice | przełęcz |
| `SWAMP` | woda, martwe drzewa | mud/peat/gravel | błoto |
| `PLATEAU` | otwarta przestrzeń | asphalt/gravel/stone | obwodnica |
| `CANYON` | wąwozy, skarpy | stone/asphalt/mud | deszczowa |

**Drzewa:** proceduralne, 3 gatunki (liściasty, iglasty, martwy). Pnie jako kolumny bloków, korona jako "blob" z noise progiem. Rozmieszczane po `FOREST` z odrzuceniem w korytarzu drogi (patrz §3). Limit: 3 000 drzew/odcinek, renderowane **instancją** (jeden mesh gatunku + InstancedMesh z transformacją).

---

## 3. Trasa: splajn rzeźbi teren

Trasa jest splajnem Catmull-Rom (centripetal) przez 40–90 punktów kontrolnych. Punkty generuje **walker**:

```
krok 22–40 m, zmiana kierunku: Δθ = sampled z rozkładu (dużo małych, rzadko duże)
reguła: nie więcej niż 3 ostre zakręty pod rząd; co najmniej 1 prosta ≥ 180 m na 400 m
profil: gradient z noise + wymuszone crest/dip (feature)
```

**Rzeźbienie (carving)** — dla każdego punktu splajnu, co 1 m łuku:
1. `center = spline.point(s)`, `normal = perpendicular(tangent)`.
2. Szerokość drogi: `width = 7.5 m` (szuter/błoto), `9.0 m` (asfalt), zwężenia do 5.5 m na `bridge`/`tunnel`.
3. W korytarzu: **wyrównanie wysokości** — teren jest interpolowany w poprzek do `road_height(s)` z rampą 12 m na zewnątrz (żeby nie było ściany).
4. Ustawienie bloków powierzchni per kolumna wg `surface_id` segmentu + mieszanie na granicach (pas 2 m, `mix` noise).
5. Pobocza: `shoulder` 1.5 m z blokami `loose`, dalej skarpy.
6. Usunięcie kolizji: drzewa/skały w korytarzu → przesunięte lub usunięte (z "powodem" zapisanym, żeby generator był odtwarzalny).

**Kamber (przechylenie poprzeczne):** `camber(s) = -curvature(s) * camber_gain`, clamp ±6°. Realizacja: podniesienie jednej strony korytarza. To jest to, co pozwala trzymać szybciej w łuku — i to, co gracz czyta oczami.

**Feature'y wstawiane jawnie:**
- `crest` — zmiana gradientu z +do −, widoczna z daleka, generuje notatkę `OVER CREST`.
- `jump` — próg z rampą 8°, skok 3–9 m, pas lądowania 25 m.
- `water` — obniżenie + woda, głębokość 0.3–0.8 m, efekt: `wetness += 0.5`, spadek μ na 4 s.
- `hairpin` — zakręt > 150°, notacja 1–2.
- `chicane` — 3 szybkie zmiany kierunku, notacja `LEFT 5, RIGHT 5, LEFT 5`.

---

## 4. Checkpointy i timing

- Checkpoint = **bramka** (2 słupy + baner proceduralny) w poprzek drogi, co 900–1600 m.
- Wykrycie: przekroczenie płaszczyzny bramki przez CoM auta (test znaku, bez siatki).
- Brak bramki = kara `+30 s` (albo DNF przy 2 brakach).
- Bramki dają **sectory**: czas per sektor + różnica względem referencji.
- Limit odcinka = `ref_time * 1.6`.
- Start: bramka startowa z licznikiem; ruch przed GO = `+5 s`.

**Referencja (ref_time):** liczona automatycznie przy generowaniu odcinka przez **ducha AI** (patrz §6) i zapisana w definicji odcinka.

---

## 5. Dekoracje i "życie" odcinka

| Element | Jak | Uwaga |
|---|---|---|
| Kibice | blokowe ludziki 0.6×1.8 m, w grupach 3–9, przy trasie 4–12 m od krawędzi | reagują: odskakują przy aucie < 4 m lub przy uderzeniu |
| Marshal | 1–2 na checkpoint, machają flagą przy przejeździe | sygnał dźwiękowy |
| Znaki | tablice 3×3 bloki z proceduralnym piktogramem (strzałka, "3") | ostrzegają, ale nie zastępują notatek |
| Bandy/słupy | słupy 0.25 m co 8 m przy ostrych zakrętach | kolizja = impuls + uszkodzenie |
| Barierki | belki drewniane przy `bridge`/`jump` | absorbują energię, uginają się |
| Woda | proceduralna: siatka + shader (piana przy kołach) | kałuże na asfalcie = decal + zmiana μ |

Wszystko instancjonowane, zero meshy "dekoracja" osobno.

---

## 6. Duch AI (pojedynczy, offline)

Nie AI wyścigowa — **generator referencji i ducha**:

```
1. Dla każdego segmentu: v_max = solve(friction circle przy N_i nominalnych, μ segmentu, camber)
2. Plan hamowania: wstecz od zakrętu, hamowanie z decel = μ*g*0.85, margines 8%
3. Przejazd przez symulację z controllerem PID (steer + throttle + brake) → zapis stanów 30 Hz
4. Wynik = ref_time; stany = ghost replay
```
Duch jest tani (liczony raz przy generowaniu odcinka, ~2–4 s CPU) i daje: limit czasu, referencję sektorów, wizualny ghost, i **darmowy test, czy odcinek jest w ogóle przejezdny**.

---

## 7. Generator notatek pilota (z geometrii splajnu)

```
1. Skan splajnu po łuku, co 5 m. Znajdź ekstrema curvature (|κ| lokalne maksima).
2. Grupuj ekstrema w "events" (merge jeśli odstęp < 60 m).
3. Dla każdego eventu:
   R = 1/κ ;  angle = Δheading przez event ;  severity = clamp(round(6 - R/12), 1, 6)
   angle < 25° → FLAT (bez notatki, chyba że surface zmiana)
4. Odległość = distance od poprzedniego eventu → kwantyzacja {10,20,30,40,50,70,100,150,200,LONG}
5. Modyfikatory:
   gradient zmiana +→− w obrębie 30 m przed eventem  → OVER CREST
   κ rośnie w głąb zakrętu (κ_mid > κ_entry * 1.25)  → TIGHTENS
   pobocze < 2.5 m po zewnętrznej                     → DON'T CUT
   szerokość > 10 m po zewnętrznej                    → LONG CUT
   surface_id inny niż poprzedni event                → nazwa nawierzchni
   hazard w promieniu 12 m                             → CAUTION / HAZARD
   feature jump/water                                  → JUMP / WATER
6. Kompresja: jeśli dwa eventy < 25 m → "CHICANE LEFT RIGHT"
7. Trigger w grze: gdy distance_to_event < v * 2.2 s → mów (żeby pilot mówił ~2 s przed zakrętem)
```

Właściwości, które sprawdzamy testem: notatka pojawia się **zawsze** przed zakrętem z marginesem ≥ 1.2 s przy prędkości planowej; żadna notatka nie jest fałszywa (każda ma event w geometrii); `TIGHTENS` nie pojawia się przy łukach o stałej κ.

---

## 8. Warianty i powtarzalność

- `variant = mirror` — lustrzane przejście tego samego splajnu (tanie, podwaja content).
- `variant = reversed` — ten sam splajn od końca (inne notatki, inna sekwencja).
- Seed odcinka zapisany w save → ten sam odcinek zawsze identyczny (poza deformacją od gracza, która jest osobnym stanem).
