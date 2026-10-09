# 04 — Render: voxel, proceduralne materiały, brud, post

Zero plików. Tekstury są albo **w shaderze** (hash noise, fbm, triplanar), albo **rysowane na Canvas2D** do atlasu w czasie startu (HUD, ikony, znaki, tablice, numery). Nic nie jest wczytywane z dysku.

---

## 1. Renderer — konfiguracja

- Three.js r1xx+, `WebGLRenderer({ antialias: false, powerPreference: 'high-performance' })`.
- Antialiasing: **post-process SMAA-lite własny** (taniej i spójnie z resztą composite) albo MSAA 4× jeśli GPU pozwala — opcja w ustawieniach.
- `WebGL2`, `colorSpace: SRGBColorSpace`, render do **HDR render target RGBA16F**, composite na koniec.
- Wszystkie materiały: własne `ShaderMaterial` (nie MeshStandard) — pełna kontrola nad brudem i voxel AO.

**Passy w klatce:**
```
1. Shadow pass: 2 kaskady (0–40 m, 40–140 m), 2048² i 1024², tylko teren + auto + dekoracje
2. Depth prepass terenu (pół-cena, daje early-z i potem SSAO-lite z depth)
3. Opaque: teren (chunki), auto, dekoracje instancjonowane
4. Sky: fullscreen quad, proceduralny (gradient + słońce + chmury fbm)
5. Decals: ślady opon, plamy brudu na ziemi (deferred, depth-tested, quad per ślad)
6. Transparent: cząstki (kurz, błoto, woda), krawędzie kolein, ghost auto
7. Composite (1 pass): bloom z 1/4 downsample + tonemap + grade LUT proceduralny + grain +
   vignette + chromatic aberration + motion blur (velocity z velocity buffer lub prosta projekcja)
8. HUD: ortho overlay, canvas atlas
```

---

## 2. Meshing terenu

- **Face culling** (sąsiedni blok nieprzezroczysty → brak face) + **greedy meshing** w poziomie (merge współpłaszczyznowych quadów) → typowo 8–14× mniej trójkątów niż naive.
- **Jeden mesh per chunk per grupa materiałów** (grupa = zestaw bloków o tym samym shaderze bazowym).
- **Vertex AO** (klasyczne Minecraft): 2 bity na vertex → 4 poziomy zaciemnienia, liczone z sąsiadów. Darmowa "głębia" bez SSAO.
- **Kolory bloków** w vertex color (per blok) + proceduralna tekstura w shaderze (skala bloku 1 m, noise per blok z seedem pozycji → każdy blok ma własny wzór, nie powtarzalną tapetę).
- **LOD:** ring 2 = mesh uproszczony (co 2 kolumny, bez AO); ring 3 = tylko sylwetka (1 quad na kolumnę, bez detalu).
- **Remeshing:** kolejka priorytetowa, max 6 chunków/ms, chunki blisko auta mają priorytet.

---

## 3. Proceduralne materiały (bez tekstur)

Każdy blok ma w palecie: `baseColor`, `roughness`, `normalStrength`, `noiseScale`, `pattern` (enum), `surface_id`.

Shader bazowy terenu:
```glsl
// per fragment, world-space triplanar-ish, ale na voxelach wystarczy blend face-normal
vec3 p = vWorldPos * u.noiseScale + hash(vBlockId) * 7.31;
float grains  = fbm(p * 4.0, 3);          // kamień, żwir
float speckle = step(0.86, hash3(p));     // jasne ziarna w szutrze
float cracks  = voronoiCrack(p * 0.6);    // pęknięcia asfaltu
float wet     = uWetness;                 // mokre = ciemniejsze + lustrzane
albedo = mix(baseColor * (0.82 + 0.36*grains), baseColor*1.25, speckle);
albedo = mix(albedo, albedo * 0.55, wet*0.7);
rough  = mix(uRoughness, 0.12, wet);
```
- **asfalt:** `voronoiCrack` + łaty (duże bloby noise) + linie malowane proceduralnie na odcinkach `road_markings`.
- **szuter:** `speckle` + `grains` + widoczne kamyki (normal perturbation z hash3).
- **błoto:** ciemne, `wet` domyślnie wysokie, smugi z adwekcji (patrz §5).
- **śnieg:** jasny, `subsurface`-fake (rim light), ślady i koleiny mocno widoczne.

**Oświetlenie:** 1 directional (słońce) + hemisphere + 1 spotlight (reflektory, noc). Odbicia: brak ray tracingu; zamiast tego **screen-space-ish fake**: `fresnel * skyColor` + decal kałuży z odbiciem uproszczonym (próbkowanie sky gradientu po wektorze odbicia).

**Niebo proceduralne:** gradient (Preetham-uproszczony: `sunPos`, `turbidity`, `albedo`) + tarcza słoneczna + chmury jako fbm na kopule z `windOffset` (animacja w czasie). Noc: gwiazdy z hash3 + moon. Deszcz: warstwa chmur do 100%, obniżony `ambient`.

---

## 4. Samochód: model i brud

### 4.1 Budowa
Auto jest **zestawem bloków** (moduł 0.25 m) — ~180–260 bloków na karoserię, koła osobno (cylinder 16 segmentów + bieżnik proceduralny w shaderze). Zalety: uszkodzenia i brud działają per blok, a "Minecraft" jest strukturalny, nie kostiumowy.

### 4.2 System brudu — to jest osobny podsystem, nie dekoracja

**Dwa poziomy:**

**(A) `panelDirt[16]` — skalar per panel** (progi, tył, nadkola, dach, maska, szyby, progi boczne, zderzaki). Szybki, steruje logiką i czyszczeniem.

**(B) `dirtMap` — render target 512×512** z UV atlasu auta (każdy blok ma swój wycinek UV). Splaty malują grubość brudu i jego kolor.

```
dirtMap.r = grubość brudu 0..1
dirtMap.g = wilgotność 0..1
dirtMap.b = kolor brudu (index → paleta, albo RGB)
dirtMap.a = warstwa "pyłu" (suchy, rozproszony) vs "błota" (mokre, grube)
```

**Emisja splatów** (per koło, przy kontakcie, `docs/02-physics.md`):
```
rate = |slip_energy| * surface.stick * (1 + wetness*0.8)
slip_energy = |F_lat * v_lat| + |F_lon * v_lon|   / 40 kW
kierunek splatu = od koła w stronę, z której leci (zależny od prędkości i kierunku poślizgu)
cel panelu = panel najbliższy trajektorii (progi przy poślizgu, tył przy gazie na szutrze,
             dach przy skokach i przy jechaniu za sobą, maska tylko przy wodzie/błocie)
```

**Reguły brudu per nawierzchnia (to ma być czytelne gołym okiem):**

| Nawierzchnia | Gdzie się odkłada | Charakter |
|---|---|---|
| asfalt | prawie nic; **guma na oponach** + kurz na progach przy poślizgu | cienka warstwa, szaro, matowo |
| szuter | progi, tylne nadkola, tył, dach (z tyłu) | **pył** (kanał `a`), jasny, rozproszony, smugi poziome |
| błoto | progi, nadkola, koła, maska (przy wodzie), spód, tył | **grube placki** (kanał `r`), ciemny, bryzgi z ogonem |
| śnieg | prawie zero brudu; **szron/wilgoć** na spodzie i progach | kanał `g`, jasne wybielenie, schnie szybko |

**Ewolucja w czasie:**
```
co 0.25 s:
  wilgotność -= dryRate(surface, wind, temp)      // błoto schnie 3× wolniej niż śnieg
  grubość    *= (1 - flingRate(speed, vibration)) // przy 140 km/h brud odpada
  pył        += dustFallout (ogólny, równomierny, niski)
```
**Czyszczenie:** mycie między odcinkami = `dirtMap *= 0.08` + `panelDirt *= 0.1`, z wyjątkiem kanału gumy na oponach (zostaje). Opcjonalnie: mycie częściowe (tylko szyby i światła — tanie).

**Render brudu (w shaderze auta):**
```glsl
vec4 d = texture2D(uDirtMap, vUV);
float thick = d.r;
vec3 dirtCol = d.b * (1.0 - 0.25*d.g);            // mokry = ciemniejszy
// grubość zmienia geometrię tylko optycznie: normal "wygładza" i podnosi mikrorelief
float n = fbm(vUV * 220.0 + d.g*3.0, 3);
albedo = mix(albedo, dirtCol, clamp(thick*1.35 + d.a*0.55, 0.0, 0.92));
rough  = mix(rough, mix(0.95, 0.35, d.g), thick);   // mokre błoto jest błyszczące
normal = normalize(normal + vec3(n-0.5) * thick * 0.35);
// smugi: pionowe wyciągnięcia przy grubości > 0.5 i prędkości > 40 m/s
albedo = mix(albedo, dirtCol*0.9, streakMask(vUV, uSpeed));
```

**Minecraft-flavor:** dodatkowo per-blok tint (`panelDirt` → mnożnik koloru bloku), więc z daleka auto wygląda na "ubłocone bloki", a z bliska widać splaty.

### 4.3 Uszkodzenia wizualne
- Per blok: `dentOffset`, `dentScale`, `missing` flag. Uderzenie → bloki w promieniu impulsu przesunięte o `impulse/20000` m z losowym obrotem; powyżej progu → `missing` (blok znika, zostaje "dziura").
- Reflektory: zbita szyba = proceduralny crack pattern w shaderze.
- Dym z silnika = cząstki + `engineDamage` scalar.

---

## 5. Ślady, koleiny, cząstki

**Ślady opon (decal system):**
- Pula 4000 quadów (ribon z 2 wierzchołkami per 0.4 m), ring buffer.
- Właściwości: `alpha` z `slip_ratio`, kolor z nawierzchni (guma na asfalcie, ciemny na szutrze, biały na śniegu), `width` z obciążenia koła.
- Test: ślad pojawia się tylko gdy `|kappa| > 0.12` lub `|alpha| > 6°` — nie "zawsze".

**Koleiny (rut):** zapis do heightfield chunka (`docs/02-physics.md §7`) + decal. Widoczne na błocie i śniegu, niewidoczne na asfalcie.

**Cząstki (pula, zero alokacji w klatce):**
| Typ | Ilość max | Jak |
|---|---|---|
| odłamki bloków | 1200 | prawdziwe małe kostki (InstancedMesh), fizyka uproszczona (gravity + bounce 0.3) |
| kurz/pył | 6000 | billboardy miękkie, alpha z `fbm`, skalowanie z prędkością |
| bryzgi błota | 3000 | kostki + smugi, kolor z palety nawierzchni |
| śnieg | 3000 | miękkie + driftem w górę |
| woda/krople | 2500 | linie (streak) przy prędkości |
| dym | 600 | miękkie, długowieczne |

Kurze obłoki za autem są **napędzane przez `slip_energy` i `surface`** — na asfalcie prawie nic, na szutrze ściana pyłu, w błocie fontanna. To jest główny wizualny dowód, że fizyka per-koło działa.

---

## 6. Post-processing (jeden composite)

| Efekt | Parametr | Cel |
|---|---|---|
| Bloom | próg 1.1, knee 0.3, downsample 1/4, 3 iteracje | słońce, reflektory, eksplozje kurzu |
| Motion blur | velocity buffer (poprzednia kamera) + maska prędkości radialnej | poczucie prędkości |
| Color grade | LUT generowany proceduralnie (3D texture 32³, gradient + film curve) | "rajdowy" look: ciepły, lekko wyblakły, mocny kontrast |
| Film grain | hash + czas, amplituda 0.012 | spoiwo obrazu |
| Vignette | 0.28 | fokus |
| Chromatic aberration | 0.0018 na krawędziach | tylko w powtórkach i przy uszkodzeniach |
| Heat/dust haze | `1 - exp(-density * dist)` z cząstkami kurzu w głębi | głębia i atmosfera |
| Brud na obiektywie | maska z `panelDirt['windshield']` + splaty na osobnym 256² RT | dosłownie: brudne auto = brudna kamera |

**Ustawienia gracza:** jakość (LOW/MED/HIGH) skaluje: promień chunków, rozdzielczość cieni, liczbę cząstek, liczbę iteracji bloomu, motion blur.

---

## 7. Kamery

| Kamera | Opis | Kiedy |
|---|---|---|
| **CHASE** (domyślna) | punkt prowadzony po `normalize(vel)` wstecz od auta, offset 6.5 m, wysokość 2.6 m, `lookAhead = v * 0.35`, spring damping 8 Hz | większość jazdy |
| **ONBOARD** | w kabinie, 0.55 m przed CoM, wstrząsy z zawieszenia, widoczna deska rozdzielcza i pilot | techniczne odcinki |
| **BUMPER** | 0.3 m przed zderzakiem, nisko, mocno reaguje na wybicia | do nagrań "feel" |
| **CINEMATIC** (powtórki) | orbit + dolly, `lookAt` interpolowany, DOF fake | replay, meta |

**Wstrząs kamery:** `shake = f(impuls, surface.roughness, susp_damage)` + `lowpass 12 Hz` (żeby nie było migotania) + `recovery 0.4 s`. Kontry kierownicy: kamera obraca się o `0.35 * steer` — to jest to, co sprzedaje poślizg.

---

## 8. HUD (proceduralny)

- Czcionka bitmapowa 7×9 generowana na canvasie (atlas glifów z rysowanych prostokątów) — styl "rajdowy LCD".
- Elementy: prędkość (duża), obroty + pasek czerwony, bieg, zegar odcinka, split sektora (`+0.7`), limit czasu, pasek uszkodzeń per ramię, **4 wskaźniki koła** (patrz niżej), notatki pilota (duży tekst, znika po 3 s), mini-mapa trasy z zaznaczonymi eventami.
- **Wskaźniki per koło** (kluczowe dla filaru P2): mały kwadrat przy każdym kole, kolor = stan: `zielony` (trzymanie), `żółty` (kappa/alpha > 0.12), `czerwony` (pełny uślizg), `szary` (odciążone/brak kontaktu). Dodatkowo grubość ramki = obciążenie normalne.
