# VOXEL RALLY — plan produkcji
**Roboczy tytuł:** Voxel Rally · **Kodname:** `mc-rally`
**Baza:** Three.js (ES modules, bez bundlera wymaganego) · **Zero plików graficznych i dźwiękowych** — cała grafika, tekstury, modele, dźwięk i muzyka są generowane w kodzie.
**Inspiracja:** Colin McRae Rally (1998/99) — odcinki przeciw zegarowi, pilot z notatkami, nawierzchnia jako główny przeciwnik, tuning, uszkodzenia. Własne nazwy i własne samochody (voxelowe), zero materiałów licencjonowanych.

---

## 1. Teza projektu

Rajd to nie wyścig. Rajd to **pokonywanie nawierzchni na czas**. Cała gra stoi na trzech filarach:

1. **Nawierzchnia jest bossem.** Szuter, asfalt, śnieg i błoto różnią się nie "modyfikatorem prędkości", tylko fizyką kontaktu: inną krzywą tarcia, innym oporem toczenia, innym oporem odspajania gruntu, innym sposobem, w jaki auto zostawia ślad.
2. **Cztery osobne placki kontaktu.** Auto nie ma jednego współczynnika przyczepności. Każde koło ma własne obciążenie, własny kąt poślizgu bocznego, własny poślizg podłużny, własne koło μ i własne ograniczenie (blokada, uślizg, odciążenie). Cała frajda — kontrola nad tym, co robi każde koło z osobna.
3. **Brud jest informacją.** Auto brudzi się zależnie od nawierzchni, a brud jest czytelny: błoto na progach i tylnych nadkolach, kurz na dachu, asfalt prawie nic poza gumą na oponach. Brud to jednocześnie estetyka i feedback — z niego da się wyczytać, którędy jechałeś i co poszło źle.

Minecraft jest **językiem materiału**, nie żartem: świat jest wokselowy, auto jest zbudowane z bloków, ale zachowuje się jak prawdziwa rajdówka. Brud, kurz, koleiny, odłamki bloków — wszystko wynika z tej samej symulacji.

---

## 2. Pion pionowy (vertical slice) — to jest cel fazy 1–5

Jeden odcinek: **leśny szuter, 4.2 km, 6 checkpointy, 1 auto, pełna pętla rajdowa.**

Warunki ukończenia slajdu:
- Start → checkpointy → meta, czas, kary za brak checkpointu, split time.
- Pilot wypisuje notatki generowane z geometrii trasy (nie wpisane ręcznie).
- Auto traci tył na hamowaniu na szutrze, da się złapać kontrą i wyjść z poślizgu.
- Ten sam odcinek na asfalcie (wariant) wymaga innej techniki: późniejsze hamowanie, ciaśniejsze linie, brak kontrolowanych poślizgów.
- Po odcinku auto jest widocznie brudne, a brud jest inny na szutrze i na asfalcie.
- Dźwięk silnika reaguje na obroty, obciążenie i bieg; szuter słychać jako granulowany hałas, nie jako "biały szum".
- 60 FPS w 1080p na typowym laptopie.

---

## 3. Filary projektowe (decyzje, których nie zmieniamy)

| # | Filar | Konsekwencja techniczna |
|---|---|---|
| P1 | Odcinki przeciw zegarowi, nie wyścig | Brak AI rywali w fazie 1; rywal = duch (ghost) i tabele czasów |
| P2 | Fizyka 4 kół, osobno | Model koła → siła → moment; żadnego "grip = 0.8" globalnego |
| P3 | Nawierzchnia jako warstwa danych świata | Każdy blok ma `surface_id`; fizyka i brud czytają ten sam identyfikator |
| P4 | Wszystko proceduralne | Tekstury z shadera/canvasa, modele z boksu, dźwięk z WebAudio, muzyka z syntezy |
| P5 | Świat wokselowy, ale trasa jest splajnem | Droga jest splajnem z atrybutami; teren jest wokselowy; trasa rzeźbi teren |
| P6 | Notatki pilota generowane z trasy | Klasyfikacja zakrętów z krzywizny + profilu + nawierzchni |
| P7 | Uszkodzenia mają konsekwencje w fizyce | Uszkodzone zawieszenie zmienia sprężynę/tłumienie, nie tylko wygląd |
| P8 | Sterowalność > realizm | Asysty są, ale domyślnie wyłączone; trudność rośnie przez warunki, nie przez sztuczne spowolnienie |

---

## 4. Zakres

### W zakresie (v1)
- 8 odcinków, 4 rodziny nawierzchnii + 3 mieszane.
- 4 samochody (voxelowe) o różnym charakterze.
- Podstawowy tuning: wysokość, tłumienie, stabilizator, blokada mechanizmu, bias hamowania, mieszanka opon.
- Tryby: **Rajd** (czempion), **Odcinek specjalny** (pojedynczy + duch), **Tor testowy** (nauka, wizualizacja poślizgów).
- Noc + deszcz jako warstwa warunków (wpływ na μ i brud).
- Powtórki (replay) i zapis ducha.

### Poza zakresem v1 (świadomie)
- Multiplayer, sieć.
- Rallycross (head-to-head na torze) — zostawiamy hak w architekturze, nie robimy.
- Kariera menedżerska, sponsorzy, negocjacje.
- Redakcja trasy przez gracza.

---

## 5. Mapa dokumentów

| Plik | Zawartość |
|---|---|
| `docs/01-design.md` | DNA Colina McRae, pętla rozgrywki, stage design, notatki pilota, progresja, tuning |
| `docs/02-physics.md` | Fizyka: ciało, zawieszenie, **model koła per-wheel**, mechanizm różnicowy, nawierzchnie, uszkodzenia, pseudokod, stałe |
| `docs/03-world.md` | Generator terenu, splajn trasy, rzeźbienie drogi w wokselach, checkpointy, dekoracje, generowanie notatek |
| `docs/04-rendering.md` | Renderer, meshing, proceduralne tekstury, **system brudu**, cząstki, koleiny, post-processing, kamery |
| `docs/05-audio.md` | Synteza silnika, granularny szuter, opony, uderzenia, IR pogłosu, pilot (TTS), muzyka proceduralna |
| `docs/06-architecture.md` | Struktura modułów, pętla gry, stały krok czasu, input, HUD, save, replay, import map |
| `docs/07-roadmap.md` | Fazy 0–7 z kryteriami akceptacji, budżety wydajności, ryzyka i mitygacje, metryki "AAA feel" |
| `docs/08-external-resources.md` | Zweryfikowane skilly agentowe i repo referencyjne: co zainstalować, co przeczytać, czego nie brać, i 7 luk, które musimy napisać sami |

---

## 6. Kolejność prac (skrót)

```
F0 bootstrap      1 dzień   Three.js, pusty świat, HUD debug, import map
F1 świat          3 dni     teren wokselowy, splajn drogi, meshing, kamera, jazda pudełkiem
F2 fizyka        5 dni      zawieszenie 4x, model koła, nawierzchnie, mechanizm, hamulec ręczny
F3 brud          3 dni     mapa brudu, splaty, shader brudu, suszenie, mycie
F4 stage loop    3 dni     start/checkpoint/meta, czasy, kary, notatki pilota, HUD rajdowy
F5 AAA polish    5 dni     post, cząstki, koleiny, uszkodzenia, audio proceduralne, kamery
F6 content       4 dni     8 odcinków, 4 auta, tuning, czempion, duchy, noc/deszcz
F7 hardening     3 dni     wydajność, gamepad, dostępność, balans, zapis
```

**~27 dni roboczych do v1.** Pierwszy grywalny moment: koniec F2 (auto jeździ i ślizga się inaczej na czterech nawierzchniach). Pierwszy "rajd": koniec F4.

---

## 7. Budżet techniczny (twarde limity)

| Zasób | Limit | Uwaga |
|---|---|---|
| Klatka renderowania | ≤ 13 ms | 60 FPS, 1080p |
| Krok fizyki | ≤ 4 ms | 4 koła × 120 Hz substep |
| Draw calls | ≤ 220 | chunky instancjonowane, dekoracje instancjonowane |
| Trójkąty w klatce | ≤ 2.0 M | LOD terenu, frustum + distance culling |
| Cząstki aktywne | ≤ 18 000 | pula z góry ograniczona, bez alokacji w pętli |
| Meshy chunków | ≤ 90 widocznych | promień strumieniowania ~260 m |
| Mapa brudu | 1 render target 512² | RGBA8, splat ≤ 24/ms |
| Węzły WebAudio | ≤ 60 | stały graf, modulacja parametrów, brak tworzenia węzłów w klatce |
| JS heap | ≤ 220 MB | pula obiektów w fizyce i cząstkach |

---

## 8. Metryki "AAA feel" (checklist, mierzalna)

Nie "AAA" jako liczba polygonów, tylko odczucie. Każde mierzalne:

1. **Różnica techniki między nawierzchniami** — ten sam zakręt: czas przejazdu na asfalcie vs szutrze różni się ≥ 12%, a optymalna linia jest inna (inna prędkość wejścia ≥ 15 km/h).
2. **Czytalność poślizgu** — gracz po 10 s wie, które koło ucieka (HUD per-koło + dźwięk + ślad).
3. **Brud czytelny po 30 s jazdy** — zrzut auta pokazuje inny rozkład brudu dla szuter/błoto/śnieg/asfalt (4 różne maski).
4. **Dźwięk niesyntetyczny** — silnik ma pulsowanie pracy cylindrów słyszalne w widmie, nie stały ton.
5. **Kamera nie "pływa"** — prowadzi po wektorze prędkości, nie za tylnym zderzakiem; kontra kierownicy widoczna w kadrze.
6. **Zero momentów "dlaczego to zadziałało"** — każdy uślizg ma przyczynę w obciążeniu koła lub w hamowaniu.
7. **Powtarzalność** — ten sam przejazd z tym samym wejściem daje ten sam wynik (stały krok czasu, deterministyczny RNG seed na odcinek).

---

## 9. Ryzyka (top 6)

| Ryzyko | Mitygacja |
|---|---|
| Fizyka kół niestabilna przy substepach | Stały krok 1/120 s, clamp sił, rate-limit skoku prędkości, pół-implicitne tłumienie; testy regresji (jazda w kółko, hamowanie z 160 km/h) |
| Raycast w wokselach za drogi | Heightfield per kolumna + per-blok lookup tylko przy kontakcie; cache kolumny pod kołem |
| Proceduralny dźwięk brzmi jak buzz | Filtry pasmowe, ograniczenie liczby oscylatorów, synteza przez modulację stałego grafu, A/B z referencją nagrania |
| Brud wygląda jak "szara mgła" | Splaty z grubością + próg, maski per panel, zmiana roughness i normalu, nie tylko albedo |
| Scope creep w content | 8 odcinków z jednego generatora; żadnego ręcznego level designu w v1 |
| Three.js post-processing ciężki | Własny jednopassowy composite zamiast łańcucha EffectComposer; bloom na downsample 1/4 |

Szczegóły i pełna lista: `docs/07-roadmap.md`.

---

## 10. Kierunek artystyczny (referencja: **Colin McRae Rally**) #kierunek

Gramy w Rajdu Świata, nie w „Minecraft na kółkach”. Referencja, do której wracamy przy każdej decyzji graficznej, to **Colin McRae Rally** (PS1-era, ale *czytana* przez współczesne oświetlenie): ciepłe, późne światło słoneczne, długie cienie, nasycona ale ziemska paleta, droga jako bohater kadru, a krajobraz jako tło.

**Co przenosimy z referencji:**
- **Checkpointy stoją przy drodze** — brama / dwa słupki z flagą przy krawędzi trasy, widoczne z daleka, oświetlone; nie abstrakcyjne punkty na mapie. Przejście przez bramę daje sygnał wizualny i dźwiękowy.
- **Tablice u góry ekranu** — pas informacyjny nad kadrem: nazwa odcinka, sector, split do referencji, limit czasu, notatki pilota jako znaki (np. `5L → 4R`, `HANT`, `DON'T CUT`) wyświetlane jak drogowskazy, z czasowym oknem pojawienia. Ten pas jest *hierarchiczny*: najpierw to, czego gracz potrzebuje w zakręcie.
- **Prędkościomierz jak w grze rajdowej** (nie listy tekstowe): dolny róg kadru — obrotomierz ze strefą czerwoną i wskazówką, duża cyfra prędkości w km/h, widoczny bieg (`N 1..6`), małe wskaźniki stanów (woda/olej/turbo w stylu CMR). Tarcza jest czytelna ruchem gałki, nie tekstem.
- **Pasek postępu odcinka** z zaznaczonymi checkpointami i znacznikiem auta (to element HUD-u CMR), obok mały, dyskretny zegar i split (wartość ujemna = jedziemy szybciej od referencji). Zakaz dużych liczb w środku kadru.
- **Strzałki pilota**: symbol zakrętu (lewy/prawy, ostrość 1–6, hairpin, crest/jump, `DON'T CUT`) z malejącą liczbą metrów — niższa liczba = wolniejszy zakręt, `6` ≈ pełny gaz.
- **Gęstość HUD-u jak w CMR**: pełny / minimalny / wyłączony (gracz wybiera, nie my).

### 10.1 Język wizualny HUD-u: **przepisany na Minecraft**

Zasada: **obiekty i układ HUD-u bierzemy z Colina McRae, ich skórę rysujemy w mowie wizualnej Minecrafta**. Zakaz "deski rozdzielczej symulatora": żadnego połysku, żadnych gradientów, żadnych półprzezroczystych paneli "glass".

- **Czcionka pikselowa, generowana w kodzie** (siatka 5x7 na glif, canvas/CSS) — żadnych plików fontów. Liczby (czas, split, prędkość, dystans) w tej samej czcionce co tekst.
- **Tabliczki z drewna zamiast plakietek**: notatki pilota to przybite tablice (jak `oak sign`) z blokową strzałką zakrętu i podpisem `LEWY 60 m`, `PRAWY 130 m`, `OSTRO LEWY`, `WĄSKI`, `SKOK`, `NIE SKRACAJ`; tablica wchodzi i wychodzi skokowo (klatka po klatce, bez easingu), z gwoździami/darkim konturem.
- **Prędkościomierz blokowy**: tarcza zbudowana z segmentów-bloków (skala co 10 km/h jako zęby), blokowa wskazówka, czerwona strefa jako rząd czerwonych bloków; obok duży pikselowy numery prędkości i slot z biegiem.
- **Paski stanu jako sloty** (hotbar / pasek XP / serduszka): uszkodzenia zawieszenia i silnika jako rząd slotów, pękane wypełnienie zamiast wykresu; obrót/bieg jako osobne sloty.
- **Czas i split jako pikselowy wyświetlacz** w ramce z kamienia: `CZAS`, `SPLIT` (ujemny = szybciej od referencji, kolor zielony), `LIMIT`; zakaz dużych liczb w środku kadra.
- **Pasek postępu odcinka** z checkpointami jako blokami-tabliczkami przy krawędzi i blokowym znacznikiem auta.
- **Obiekt w 3D, nie plakietka**: checkpoint to brama przy drodze, notatka może być tablicą stojącą przy drodze w kadrze (poza HUD-em) dla najazdów.

### 10.2 Księga wyglądu: **Colin McRae Rally 2.0 (2000) → wokselowy Minecraft**

Referencja wizualna to **CMR 2.0**, nie nowsze rajdówki. Z instrukcji i recenzji wynikają konkretne, budowalne reguły:

**Kadr.** Kamera pogoni trochę wyżej i dalej niż dziś: droga zajmuje dolne ~55-60% kadru, horyzont na ~40% wysokości, widoczny pas nieba, auto w dolnej tercji z czytelnym cieniem. Widok ma mówić "najazd na zakręt", nie "symulator za zderzakiem".

**Droga.** Dominuje ton ziemi (szuter/ziemia), szeroka, z **ciemniejszym ubitym śladem kół**, jaśniejszym poboczem i wyraźną krawędzią; przy zakrętach słupki z flagami po zewnętrznej (znak zakrętu, nie plakietka HUD-u). Brud na drodze to **koleiny**, nie jasne łaty.

**Roślinność jako sprite'y** (recenzje: "drzewa to sprite'y, nie polygony"): krzyżujące się płaszczyzny z alfą, tekstura 16×16 lub 32×32 generowana proceduralnie w kodzie (zero assetów). To czyta się bliżej CMR i jest tanie niż wokselowe pudełka; wokselowe pnie zostają jako podstawa.

**Kraj = paleta.** Finlania: błoto i szuter, ciemne świerki, blade niebo; Francja: jasne trawiaste wzgórza; Szwecja: śnieg i zmarznięte jezioro; Kenia: czerwony kurz i akacj; Grecja: ochra, oliwki, kamienne mury. Nasza pionowa pionka to "leśny szuter" w charakterze Finlandii.

**Pora dnia i pogoda to cechy odcinka** (funkcja CMR 2.0), nie ustawienie gracza: każdy odcinek ma `tod` i pogodę, z dopasowaną mgłą, niebem i mokrością drogi.

**Światło jasne, wysokie.** CMR 2.0 chwalono za "jaśniejszą paletę": mocno nasycone niebo, ciepły klucz, twarde cienie, teren jasny. Nasza płaska szarość z nadmiernej mgły jest błędem wobec referencji.

**Auto z numerem i barwami zespołu.** Czytelne barwy, okrąg z numerem startowym, pasy, widoczne nadkola i koła, uszczerbki pokazane jako **uszkodzone/brakujące elementy** (CMR: zbita lampa = jeden element mniej), nie jako pasek procentów.

**Układ HUD-u wg instrukcji CMR 2.0 (§13-§14):** prędkościomierz/obrotomierz/bieg **dolny prawy róg**; czas i pozycja **górny prawy** z **paskiem sektorów, zielonym gdy zyskujemy i czerwonym gdy tracimy**; notatki pilota **u góry środka**; uszkodzenia i stany (woda/olej/turbo) **dolny lewy róg**. W naszym wydaniu: te same miejsca, drewniano-kamienne tablice i czcionka pikselowa (§10.1).
- **Droga czytelna w każdym świetle** — pobocze, koleiny, krawędzie, kamienie i trawa przy asfalcie; kontrast nawierzchni wyższy niż w fizyce.
- **Auto pokazane z szacunkiem dla kształtu** — nadwozie z objętością i zaokrągleniami, szyby z odbiciem środowiska, felgi i opony jako osobne bryły, światła (przednie świecą nocą), cień kontaktowy pod autem, brud na panelach czytelny z bliska i z daleka.

**Co jest do zrobienia (zdiagnozowane na zrzutach, koniec F2/F3):**
- **Płytki terenu są nieoszlifowane**: jednolite, płaskie kolory na ścianach i górnych powierzchniach, powtarzalna tekstura bez różnicowania, ostre, „papierowe” krawędzie bloków. Cel: różnicowanie tonażu i chropowatości per panel (hałas wielooktawowy w kolorze i w normalu), weathering na krawędziach i u podstaw ścian (jaśniejsze/górne krawędzie, ciemniejsze szczeliny), miękkie przejścia między nawierzchniami, cień otoczenia (AO) wierzchołkowy lub w shaderze, zerowanie widocznego „szwu” między chunkami.
- **Auto nie jest ładnie renderowane**: bryła pudełkowa bez przetłoczeń, brak odbić i porządnego materiału szyb, koła bez felg, brak światła kluczowego modelującego karoserię. Cel: materiały PBR z mapą środowiska, model z zaokrąglonymi narożnikami i panelami, osobne elementy (zderzaki, lusterka, dach, slot, pasy, wydech), opona z bieżnikiem i felga z ramionami.

**Oświetlenie i cień (twarde wymagania):**
- Jedno słońce (kierunkowe) z cieniami, ciepła key + chłodny fill (niebieskawa poświata nieba jako wypełnienie), hemisphere ambient zależny od biomy i pory dnia.
- **Sunshaft / światło wolumetryczne** (F5): smugi światła między drzewami i nad jezdnią, powiązane z mgłą/haze; własny jednopassowy composite (patrz §9).
- Bloom, grade (krzywa kontrastu + ciepła dominanta), ziarno filmowe, winieta — wszystko w jednym passie, w budżecie §7.
- Noc i deszcz (F6) nie mogą być osobnym kodem: ten sam graf materiałów, inne parametry światła i mokrości.

**Mierzalne kryteria kierunku artystycznego:**
1. Zrzut odcinka w „golden hour” przechodzi test odsunięcia: gracz rozpoznaje nawierzchnię, krawędź drogi i najbliższy checkpoint w < 1 s.
2. Różnica tonażu między panelami tej samej nawierzchni ≥ 12% (żadna płaska, jednolita „płyta”).
3. Auto ma widoczny cień kontaktowy i co najmniej jedną odbijającą powierzchnię (szyba lub lakier) reagującą na obrót kamery.
4. Słońce rzuca cienie, których krawędzie nie „migają” (cascaded shadow maps bez acne/peter-panning w kadrze gry) — sprawdzane na zrzutach w trzech porach dnia.
5. Pas tablic u góry ekranu mieści się w 10% wysokości kadru i nie zakrywa drogi.

Ten kierunek wygrywa z „realizmem wokselowym”: jeśli zaszłość techniczna (np. idealnie prosty blok) psuje kadr, poprawiamy grafikę, nie fizykę. Zmiany graficzne odnotowujemy w `SYSTEM-NOTES.md`.

