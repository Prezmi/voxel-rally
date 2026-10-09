# 02 — Fizyka: cztery koła, cztery prawdy

Wszystko poniżej działa w **stałym kroku** `DT = 1/120 s` (render 60 Hz, fizyka 120 Hz, podkrok koła 240 Hz przy dużych uślizgach). Kolejność w kroku jest częścią modelu i nie może się zmieniać.

---

## 1. Ciało pojazdu

```
mass m            = 1240 kg
inertia I         = diag(Ixx, Iyy, Izz) liczona z bryły auta (skrzynka + kabina + masa nieresorowana odjęta)
CoM               = (0, 0.52, 0) w lokalnych współrzędnych, y = góra
weight dist.      = 0.57 przód / 0.43 tył
wheelbase         = 2.62 m
track             = 1.52 m przód, 1.54 m tył
```

Stan: `pos, vel, quat, angVel` (w przestrzeni świata). Integracja: **semi-implicit Euler** z `angVel` aktualizowanym przed `vel` (stabilność przy poślizgach).

---

## 2. Zawieszenie — 4 niezależne

Każde ramię: **push-rod z geometrycznym przełożeniem** uproszczony do osi pionowej ciała (wystarczalny dla odczucia, tani).

```
rest_length       : ride_height + droop
travel            : [-0.06 bump_stop, +0.11 droop_stop]  (skok zawieszenia)
spring_rate k     : przód 78 000 N/m, tył 66 000 N/m   (× modyfikator uszkodzenia)
damper c          : dobój 4 800 N·s/m, dobój 6 900 N·s/m (× tuning)
anti_roll AR      : przód 1 400 N·m/rad, tył 2 200 N·m/rad (× tuning)
```

Obliczenie na koło `i`:

```
hub_i   = body_pos + R(body_quat) * hub_local_i
dir_i   = normalize(R(body_quat) * down_local_i)        // oś ramienia, po przechyle
ray     = cast(hub_i, dir_i, rest_length + travel_max)  // → kontakt z terenem
susp_i  = clamp(contact_distance - rest_length, -bump_stop, +droop_stop)
v_susp  = prędkość względna wzdłuż dir_i (koło vs ciało)

F_spring_i = k * (-susp_i)                       // siła wzdłuż dir_i do góry
F_damp_i   = c_damp * v_susp   (dobój) / c_reb * v_susp (rebump)   // pół-implicitnie
F_arb_i    = AR * Δroll                         // stabilizator: rozkłada przychylność
N_i        = F_spring_i + F_damp_i + F_arb_i    // OBCIĄŻENIE NORMALNE koła i
N_i        = max(N_i, 0)                        // koło odciążone nie ma tarcia
```

**Krytyczne:** `N_i` jest jedynym źródłem przyczepności. Przechył, nurkowanie przy hamowaniu, uniesienie przy gazie, wybicie na krawężniku — wszystko wchodzi do gry przez `N_i`, nie przez mnożnik.

Masa nieresorowana: 18 kg/koło, integrowana osobno (pozwala na "hop" koła i realne utraty kontaktu na wybiciach).

---

## 3. Model koła — rdzeń gry

Dla każdego koła `i`, w każdym podkroku:

### 3.1 Kinematyka
```
r_eff   = 0.335 m × (1 - 0.02 * load_norm)        // ugięcie opony pod obciążeniem
v_hub   = vel + cross(angVel, hub_local_world_i)  // prędkość punktu zawieszenia
v_contact = v_hub + cross(angVel, [0,-r_eff,0])   // prędkość punktu kontaktu z podłożem

// rozkład na osie koła (x = kierunek jazdy koła, y = bok)
vx = dot(v_contact, wheel_forward_i)
vy = dot(v_contact, wheel_lateral_i)
```

### 3.2 Poślizgi
```
// podłużny (slip ratio)
kappa_i = (omega_i * r_eff - vx) / max(abs(vx), omega_i * r_eff, 0.5)

// boczny (slip angle)
alpha_i = atan2(-vy, abs(vx) + 0.5) - steer_i * sign(vx + 1e-3)
```
`steer_i` z geometrii Ackermanna uproszczonej: `steer_front = steer_input * steer_ratio`, tył 0 (lub `+0.2°` toe-out statycznie).

### 3.3 Siła — Pacejka modyfikowana przez nawierzchnię
```
F_peak_i   = D * N_i                                  // D = szczyt μ_eff (patrz §4)
B_i        = B0 * surface.stiffness
C_i        = C0 * surface.curve_factor
E_i        = E0

F_lat_i = F_peak_i * sin( C_i * atan( B_i*alpha_i - E_i*(B_i*alpha_i - atan(B_i*alpha_i)) ) )
F_lon_i = F_peak_i * sin( C_i * atan( B_i*kappa_i - E_i*(B_i*kappa_i - atan(B_i*kappa_i)) ) )
```
Stałe bazowe (dobre opony rajdowe): `D = 1.28`, `C0 = 1.55`, `B0 = 9.4`, `E0 = 0.85`.

### 3.4 Okrąg tarcia (combined slip) — to jest miejsce, gdzie rodzi się uślizg
```
F_demand = hypot(F_lon_i, F_lat_i)
F_cap    = mu_eff_i * N_i

if F_demand > F_cap:
    scale = F_cap / F_demand
    F_lon_i *= scale
    F_lat_i *= scale
    // i zwrotne sprzężenie z kołem:
    if |kappa_i| > kappa_lock (0.18 przy hamowaniu, 0.28 przy gazie):
        omega_i -= (F_lon_i * r_eff / I_wheel) * DT   // koło przyspiesza/zwalnia do równowagi
```
`I_wheel = 1.15 kg·m²` (opona + felga + półos).

**ABS/antypoślizg** to tylko ogranicznik `kappa` — domyślnie wyłączony, włączany w trybie NOVICE.

### 3.5 Opór toczenia i opór odspajania gruntu (tu nawierzchnie się różnią)
```
F_roll_i  = -sign(vx) * (surface.Crr * N_i + surface.cushion * |vx| )
F_plough_i = -sign(vy) * surface.plough * N_i * |vy| / (|vy| + 3)   // "bulldozing" klina gruntu
```
`F_plough` jest odpowiedzialny za to, że na szutrze auto "pcha" klin żwiru przy poślizgu bocznym — i za to, że błoto wypycha auto z koleiny.

### 3.6 Suma na ciało
```
F_i      = (F_lon_i + F_roll_i) * wheel_forward_i + F_lat_i * wheel_lateral_i + N_i * up_i
torque_i = cross(hub_world_i - com_world_i, F_i) + rolling_resistance_torque
body.F  += F_i ;  body.torque += torque_i
```

### 3.7 Hamulce i napęd
```
// hamulec: moment na koło, ograniczony do F_cap * r_eff (żeby nie było darmowej blokady)
brake_torque_i = brake_bias_i * brake_input * brake_max_torque
drive_torque_i = diff_torque_i * split_i            // z mechanizmu, §5

omega_i += (drive_torque_i - brake_torque_i - F_lon_i * r_eff) / I_wheel * DT
omega_i  = clamp(omega_i, 0, redline_rpm)           // wolne koło nie cofa się
```

Silnik: model jednowęzłowy — `torque(rpm, throttle)` z krzywej proceduralnej + ogranicznik obrotów + cut-off przy zmianie biegu. Skrzynia: 6 biegów + zmiana z przerwą 120 ms (cut).

---

## 4. Nawierzchnie — tabela parametrów (pojedyncze źródło prawdy)

| surface | μ_peak suchy | μ mokry | μ lód | Crr | plough | sink | curve C× | stiff B× | brud: stick | kolor brudu |
|---|---|---|---|---|---|---|---|---|---|---|
| **asfalt** | 1.18 | 0.86 | 0.30 | 0.011 | 0 | 0.000 | 1.00 | 1.12 | 0.04 | `#3a3a38` (guma) |
| **szuter** | 0.80 | 0.62 | 0.28 | 0.052 | 1.9 | 0.020 | 0.92 | 0.86 | 0.42 | `#8d7a5f` |
| **błoto** | 0.55 | 0.42 | 0.24 | 0.115 | 3.6 | 0.065 | 0.80 | 0.70 | 0.88 | `#4a3524` |
| **śnieg** | 0.45 | 0.40 | 0.22 | 0.095 | 2.4 | 0.045 | 0.86 | 0.78 | 0.14 | `#dfe6ea` |
| **trawa** | 0.72 | 0.55 | 0.30 | 0.075 | 1.4 | 0.030 | 0.90 | 0.82 | 0.30 | `#4f6b34` |
| **piasek** | 0.62 | 0.50 | 0.26 | 0.130 | 2.9 | 0.055 | 0.84 | 0.74 | 0.20 | `#c2a878` |

Dodatkowe cechy:
- **asfalt:** `kink` — μ rośnie z temperaturą opony do +8% po 20 s jazdy; `aquaplane`: przy `vx > 27 m/s` i `wetness > 0.7` μ spada do 0.25 gwałtownie.
- **szuter:** `loose_layer` — cienka warstwa o niższym μ na wierzchu; hamowanie daje "grainy" puls (modulacja μ z częstotliwością 18–30 Hz, amplituda 6%) → to jest to, co słychać i czuć w kierownicy.
- **błoto:** `sink` realnie obniża koło (dochodzi opór objętościowy `F_sink = 0.5 * rho_mud * A * v²`), `rut` — koło w istniejącej koleinie dostaje +12% μ boczne, ale −8% prędkości.
- **śnieg:** `ridge` — przy stałym poślizgu narasta wał śniegu przed kołem: `plough` rośnie z czasem trwania uślizgu do ×1.8, potem pęka.

---

## 5. Mechanizm różnicowy

Trzy tryby (tuning): `OPEN`, `VISCOUS`, `LOCKED %`.

```
// otwarty: równy moment, ale z tarczem wewnętrznym T_clutch
T_left  = T_input/2 + T_clutch * sign(omega_right - omega_left)
T_right = T_input/2 - T_clutch * sign(omega_right - omega_left)

// viscous: sprzęgło lepkościowe proporcjonalne do różnicy prędkości kół
T_lock = Kv * (omega_slow - omega_fast)   // Kv z tuningu, clamp do T_max

// locked %: T_lock = pct * T_input
```
Przód/tył: centralny differential z podziałem `split_front = 0.42` (AWD) lub `1.00` (RWD), modyfikowany przez `throttle` i `load transfer` (na gazie więcej tyłu).

**Efekt, którego chcemy:** na szutrze przy otwartym mechanizmie jedno koło w koleinie kręci się i auto traci trakcję; przy blokadzie 60% auto jedzie prościej, ale podsterowność w zakręcie rośnie. Gracz to **poczuje**, bo oba efekty wynikają z `N_i` i `kappa_i`, nie z flagi.

---

## 6. Hamulec ręczny (dźwignia do kontrolowanego poślizgu)

```
brake_rear_i = handbrake * 0.9 * brake_max_torque      // tył mocno
drive_rear_i = 0                                       // odłącz napęd tyłu
if AWD: drive_front_i *= 1.15                          // przód dostaje resztę
```
Plus: przy ręcznym rośnie `steer` o +2° (counter-steer assist, wyłączalny). To jest narzędzie do "rear throw" jak w CMR.

---

## 7. Kontakt z terenem wokselowym

```
height_at(x,z): heightfield chunka (float, interpolacja biliniowa między kolumnami)
surface_at(x,z): id bloka na powierzchni kolumny (nearest, bez interpolacji)
```

- **Raycast koła:** najpierw heightfield (tani), potem per-blok lookup tylko gdy `|contact_height - last_height| > 0.15` (krawędź bloku) lub gdy wykryto uderzenie.
- **Krawędź bloku = krawężnik:** jeśli różnica wysokości > 0.12 m, dodaj impuls normalny i moment obrotowy koła (koło "wskakuje"). To daje charakterystyczne "trzaskanie" na poboczu.
- **Deformacja:** przy `surface.sink > 0` i `N_i > 2500 N` zapis do `rut_map` (heightfield z ujemnym offsetem, promień 0.18 m, głębokość do 0.09 m, trwałość do 3 odcinków w pamięci sesji).
- **Odspajanie bloków:** uderzenie z `|v_normal| > 6 m/s` w blok `loose` (szuter/błoto/śnieg) → usuwa blok, generuje 1–3 cząstki-bloki, zmniejsza wysokość kolumny o 0.06 m. Limit: 400 bloków/odcinek (żeby trasa się nie rozsypała).

---

## 8. Uszkodzenia (P7: muszą zmieniać fizykę)

| Uszkodzenie | Próg | Efekt w fizyce | Efekt wizualny |
|---|---|---|---|
| Zawieszenie (per ramię) | impuls > 9 kN | `k *= 0.72`, `c *= 0.6` | koło niżej, auto "pływa" |
| Koło/bęben | impuls > 14 kN | `brake_max_i *= 0.35` | dym, brak blokady na tym kole |
| Sterowanie | kumulacja bocznych uderzeń | `steer_ratio *= 1.18`, luz | auto "płynie" |
| Silnik | 3 uderzenia czołowe > 12 kN | moc −18% | dym z maski, falowanie obrotów |
| Reflektory | uderzenie w przód | noc: światło wyłączony | zbita szyba |
| Karoseria | dowolne | — | deformacja per blok (przesunięcie/skalowanie bloku) |

Naprawa: między odcinkami serwis przywraca 70% (darmowy) lub 100% za "serwisowy budżet". Uszkodzenia nie naprawione przechodzą na następny odcinek.

---

## 9. Pseudokod kroku fizyki (kolejność jest normatywna)

```js
function stepPhysics(dt) {          // dt = 1/120
  readInput();                      // deadzone, smooth, rate limit
  engineAndGears(dt);               // rpm, torque, clutch cut
  for (let sub = 0; sub < 2; sub++) {
    const h = dt / 2;
    for (const w of wheels) {       // 4 koła, kolejność: przód L, przód R, tył L, tył R
      raycastContact(w);            // heightfield → blok
      suspensionForce(w, h);        // N_i
      tyreForces(w, h);             // F_lon, F_lat, okrąg tarcia, plough, roll
      brakeAndDrive(w, h);          // omega_i
      accumulateOnBody(w);          // F, torque
    }
    applyAeroAndGravity();
    integrateBody(h);               // semi-implicit: angVel → quat → vel → pos
    applyDeformationAndDamage();
  }
  emitDirtAndParticles();           // brud i cząstki: raz na krok, nie na substep
  updateStageAndTiming();
}
```

**Stabilność (wymagane):**
- Clamp siły na koło: `|F| ≤ 3.5 * m * g`.
- Clamp `angVel` ciała: `|angVel| ≤ 12 rad/s`.
- Rate limit `vel`: `|Δv| ≤ 45 m/s` na krok (chroni przed teleportem w skarpy).
- Jeśli `N_i` skacze o > 3× między krokami → interpoluj (soft contact).
- Determinizm: brak `Math.random()` w fizyce; RNG tylko seedowany per odcinek i tylko w warstwie cząstek/brudu.

---

## 10. Asysty (tryby trudności)

| Asysta | Domyślnie | Co robi |
|---|---|---|
| ABS | OFF (NOVICE: ON) | limit `|kappa| ≤ 0.15` |
| TC | OFF | limit `kappa` przy gazie |
| Counter-steer assist | OFF | +2–4° przy dużym `alpha` |
| Auto-upshift | ON | zmiana biegu przy redline |
| Brake marker HUD | ON (RALLY: OFF) | znacznik punktu hamowania na HUD |

Asysty **nie zmieniają μ**. Zmieniają wyłącznie ograniczniki w §3.4 i §3.7 — dzięki temu PRO i NOVICE mają tę samą fizykę, różne narzędzia.

---

## 11. Testy fizyki (regresja, uruchamiane w `verify`)

1. **Hamowanie z 160 km/h do zera** na asfalcie: droga 78–92 m, bez blokady przy bias 55%.
2. **Stały łuk R=60 m** na asfalcie: prędkość maksymalna bez uślizgu 41–46 m/s; na szutrze 30–34 m/s.
3. **Ten sam łuk na szutrze z ręcznym:** kąt poślizgu ciała 12–22°, powrót bez kontrawy < 1.2 s.
4. **Wyjście z błota:** czas do 60 km/h z miejsca ≥ 4.5 s (na asfalcie ≤ 2.6 s).
5. **Skakańce:** utrata kontaktu ≥ 1 koła przy 25% wybiciów na testowym odcinku, auto ląduje i jedzie dalej.
6. **Determinizm:** dwa przejazdy z tym samym inputem → identyczne czasy (±0.02 s).
7. **Brak drgań:** przy 120 km/h prosto `|angVel| < 0.6 rad/s`, brak oscylacji > 8 Hz w `N_i`.
