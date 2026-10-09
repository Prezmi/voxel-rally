# 01 — Design

## 1. Co dokładnie bierzemy z Colin McRae Rally

CMR (1998, Team 10600/Climax) nie była "grą o jeżdżeniu". Była grą o **czytaniu odcinka**. Mechaniki, które definiują gatunek i które przenosimy:

| Mechanika CMR | Co dawało | Nasza wersja |
|---|---|---|
| Odcinek z limitem czasu i checkpointami | Presja + kara za zgubienie trasy | Identycznie; checkpoint = bramka w terenie, kara czasowa naliczana z brakującego CP |
| Pilot z notatkami | Możliwość jechania szybciej niż widać | Notatki **generowane z geometrii trasy**, nie wpisane; pilot mówi o nawierzchni i profilu |
| Notacja 1–6 + modyfikatory | Kompresja informacji o zakręcie | Ta sama skala: 1 = nawrót, 6 = lekki szykanowy; `over crest`, `tightens`, `don't cut`, `caution` |
| Rally Cross (knockout 2 aut) | Presja bezpośrednia | **Poza zakresem v1**; architektura zostawia hak (dwa auta, ta sama trasa, jeden przegrany odpada) |
| Tuning przed odcinkiem | Nagroda za zrozumienie auta | 6 parametrów, każdy z widocznym efektem w test tracku |
| Uszkodzenia | Ryzyko ma cenę | Uszkodzenie zmienia parametry zawieszenia/sterowności i moc, nie tylko mesh |
| Test track | Nauka bez kary | Tryb z wizualizacją: wektory sił per koło, wykres poślizgu, ślady |
| Różne nawierzchnie jako "charakter odcinka" | Każdy odcinek to inna umiejętność | 4 rodziny nawierzchnii, każda z innym modelem kontaktu i innym brudem |

Czego **nie** bierzemy: licencji, nazw, tras, zdjęć, dźwięków. Wszystko własne i proceduralne.

---

## 2. Pętla rozgrywki

```
wybór odcinku → (opcjonalnie) tuning → zapoznanie (przejazd z notatkami, wolno)
   → START → odcinek przeciw zegarowi → checkpointy → META
   → wyniki: czas, split per sektor, kary, styl jazdy (liczba uślizgów, przekroczeń)
   → auto brudne → MYCIE (między odcinkami) → następny odcinek
```

**Sektor (split):** odcinek podzielony na 3–5 sektorów. Gracz widzi `+0.7s` / `-1.2s` względem referencji natychmiast po sektorze. To jest źródło "jeszcze jedna próba".

**Start:** licznik 5-4-3-2-1-GO z dźwiękiem proceduralnym; przed GO auto nie może się ruszyć (jump start = kara 5 s).

**Limit czasu:** brak mety w limicie = DNF z powodem. Limit = czas referencyjny × 1.6.

---

## 3. Anatomia odcinka

Każdy odcinek jest opisany przez **splajn trasy** z atrybutami per segment. To jest pojedyncze źródło prawdy dla: geometrii drogi, notatki pilota, AI-ducha, limitu czasu i generowania nawierzchni.

Segment splajnu ma:
```
{ s, position, tangent, curvature (1/R), camber, gradient, surface_id,
  width, hazard[], shoulder[], feature }
```
`feature` ∈ `flat | crest | dip | jump | water | hairpin | chicane | bridge | tunnel | forest | open`

**Blok kompozycyjny odcinka** (sekwencja, 20–40 s każdy):
- `FAST_SWEEPER` — łuki 4–6, wysokie prędkości, test stabilności i linii.
- `TECHNICAL_LOW` — zakręty 1–3, test hamowania i rozkładu masy.
- `CREST_UNKNOWNS` — wzniesienia, test zaufania do notatek.
- `SURFACE_CHANGE` — przejście asfalt→szuter w pełnym gazie, test adaptacji.
- `SLIDE_SECTION` — długi łuk, w którym kontrolowany poślizg jest szybszy niż trzymanie.
- `HAZARD_GAUNTLET` — drzewa/skarpy blisko trasy, test marginesu.

Odcinek = 6–12 bloków. Długość 3–8 km. Czas referencyjny 55–140 s.

---

## 4. Odcinki v1

| # | Nazwa | Region/biome | Nawierzchnia | Dł. | Czas ref. | Charakter |
|---|---|---|---|---|---|---|
| 1 | **Kopalnia** | las liściasty | szuter 90% | 3.4 km | 62 s | nauka: hamowanie, tył na luźnym |
| 2 | **Obwodnica** | płaski, skała | asfalt 95% | 4.1 km | 66 s | linia, hamowanie, późne apogeum |
| 3 | **Przełęcz** | góry | śnieg 85% | 5.0 km | 96 s | mało tarcia, hamowanie silnikiem |
| 4 | **Tory** | bagno/żwir | błoto 80% | 3.8 km | 78 s | koleiny, zbieranie gruntu, gaz |
| 5 | **Mieszany I** | las→płaskowyż | szuter→asfalt | 5.6 km | 92 s | zmiana nawierzchni w gazie |
| 6 | **Nocna** | las iglasty | szuter, noc | 4.4 km | 84 s | notatki są jedynym źródłem informacji |
| 7 | **Deszczowa** | wąwozy | asfalt+błoto, mokro | 4.8 km | 90 s | aquaplaning, μ spada, brud mokry |
| 8 | **Finał** | góry+las | wszystkie 4 | 7.9 km | 138 s | czysta suma umiejętności |

Każdy odcinek ma **wariant** (lustrzane przejście trasy) — darmowa powtarzalność contentu, ten sam generator.

---

## 5. Samochody (4, voxelowe, własne nazwy)

| Auto | Masa | Rozstaw | Charakter | Moc | Napęd |
|---|---|---|---|---|---|
| **Kubus A1** | 1180 kg | 2.55 m | lekki, nerwowy, szybki w zmianie kierunku | 210 KM | RWD |
| **Blok GT4** | 1290 kg | 2.66 m | stabilny, wybaczający, wolny w kontrze | 235 KM | AWD |
| **Szczyt W** | 1245 kg | 2.62 m | neutralny, najlepszy na asfalcie | 250 KM | AWD |
| **Bagiennik** | 1340 kg | 2.72 m | ciężki, świetny w błocie i śniegu, toporny | 225 KM | AWD + niskie przełożenie |

Różnice są w: rozkładzie masy, sztywności stabilizatorów, domyślnej blokadzie mechanizmu, czułości układu kierowniczego, oporze toczenia opon. **Nie** w ukrytym "grip multiplierze" — to byłoby sprzeczne z filarem P2.

---

## 6. Tuning (6 parametrów, każdy z widocznym efektem)

| Parametr | Zakres | Co zmienia odczuwalnie |
|---|---|---|
| Wysokość zawieszenia | 0.10–0.22 m | wysokość CoM → przechył; prześwit → uderzenia w koleiny/skarpy |
| Tłumienie (rebump/dobój) | 0.6–1.6× | stabilność na krawędziach, "pływanie" na szutrze |
| Stabilator przedni | miękki→sztywny | nadsterowność ↔ podsterowność przy gazie |
| Blokada mechanizmu | 0–85% | trakcja na wyjściu ↔ hamowanie silnikiem i podsterowność |
| Bias hamowania | 45–65% tył | blokada tyłu i rotacja ↔ stabilność w hamowaniu |
| Mieszanka opon | twarda–miękka | trwałość i μ vs temperatura/wrażliwość na mokro |

Test track pokazuje efekt **na żywo**: mini-wykres siły bocznej per koło i ślady.

---

## 7. Notatki pilota — język i generowanie

Słownik (generowany, nie pisany ręcznie):

```
<odległość> <kierunek> <ostrość> [modyfikator] [nawierzchnia] [ostrzeżenie]

odległość: 10, 20, 30, 40, 50, 70, 100, 150, 200, LONG, SHORT
kierunek:  LEFT | RIGHT
ostrość:   1 (nawrót) 2 3 4 5 6 (lekki) | FLAT
modyfikatory: OVER CREST · TIGHTENS · WIDE ENTRY · DON'T CUT · LONG CUT · SLOW IN FAST OUT
nawierzchnia: GRAVEL · TARMAC · SNOW · MUD · LOOSE · WET · ICE
ostrzeżenia: CAUTION · HAZARD · JUMP · WATER · MARSHALS · SPECTATORS
```

Przykład wyjścia generatora:
```
100 RIGHT 4, GRAVEL, OVER CREST
60 LEFT 2, TIGHTENS, DON'T CUT
40 RIGHT 6, LOOSE, CAUTION
LONG LEFT 5, TARMAC
```

Algorytm generowania: `docs/03-world.md §7`.

**Realizacja głosu:** `speechSynthesis` (Web Speech API) — to API przeglądarki, nie plik. Parametry: `rate 1.35`, `pitch 0.9`, dobór lektora z dostępnych. Fallback: tekst HUD + krótkie syntezowane sylaby (WebAudio) jako "radio pilota". Oba warianty są bez plików.

---

## 8. Progresja i czempion

- Sezon = 8 odcinków, punkty wg pozycji w sektorach i czasie.
- Kara za DNF nie kasuje poprzednich wyników.
- Odblokowywanie: auto #2 po 2 odcinkach, #3 po 5, #4 po ukończeniu czempionu.
- **Duch:** najlepszy przejazd gracza jest zapisany jako strumień stanów (30 Hz, ~40 KB na odcinek) i renderowany jako półprzezroczyste auto z jego śladami.
- **Poziomy trudności:** `NOVICE` (asysty trakcji + notatki pełne), `PRO` (bez asyst), `RALLY` (bez notatek, tylko zapoznanie raz).

---

## 9. Warunki atmosferyczne jako warstwa danych

| Warunek | Wpływ na fizykę | Wpływ na brud | Wpływ na render |
|---|---|---|---|
| Sucho | μ bazowe | wolne schnięcie, kurz | kurz w powietrzu, ostre cienie |
| Mokro (deszcz) | μ −25..40%, próg aquaplaningu przy dużej prędkości na asfalcie | brud mokry, ciemny, długo trzyma | kałuże, refleksy, mgła, ciemniejsze niebo |
| Noc | brak wpływu | — | reflektory (spotlight), brak cieni słonecznych |
| Mróz (śnieg) | lód: μ 0.22 lokalnie | prawie zero brudu, za to szron | opad śniegu, białe niebo |

---

## 10. Co sprawia, że to jest "Minecraft", a nie tylko "voxel"

1. **Auto jest zbudowane z bloków** (moduły 0.25 m) — brud, uszkodzenia i deformacja działają per blok.
2. **Odłamki to bloki** — uderzenie w ziemię/skarbę wyrywa woksele i one lecą jako cząstki.
3. **Koleiny są prawdziwe** — na błocie i śniegu koło realnie usuwa/odspaja bloki i zostaje wgłębienie w heightfieldzie.
4. **Dekoracje są blokowe** — drzewa, słupy, bandy, kibice, znaki.
5. **HUD jest blokowy** — czcionka bitmapowa 7×9 rysowana proceduralnie, ikony z pikseli.
6. **Nie udajemy Minecrafta assetami** — nie ma tekstur z gry Mojang, tylko własne proceduralne materiały w tym języku formy.
