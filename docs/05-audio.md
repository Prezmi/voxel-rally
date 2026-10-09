# 05 — Audio: wszystko syntezowane

Zero plików. Cały dźwięk to WebAudio: oscylatory, szum, filtry, granular, pogłos z wygenerowanej odpowiedzi impulsowej.

**Zasada techniczna:** graf węzłów jest **budowany raz** przy starcie; w klatce zmieniają się wyłącznie `param.value` / `setTargetAtTime`. Żadnego `createOscillator()` w pętli.

---

## 1. Graf miksera

```
[ENGINE]──┐
[DRIVE]───┤
[TYRE]────┤      ┌──[BUS_MAIN]──[COMP]──[LIMITER]──[destination]
[WIND]────┼──────┤
[IMPACT]──┤      └──[SEND]──[REVERB(ConvolverNode)]──┘
[AMBIENCE]┘
[VOICE]───────────────────────────────────────────(dry, duckuje resztę o 3 dB)
[MUSIC]───────────────────────────────────────────(−6 dB w odcinku, +0 dB w menu)
```

---

## 2. Silnik

Model: **rzędowa wiązka oscylatorów + pulsowanie pracy cylindrów + modulacja jasności obciążeniem.**

```
cylinders = 4
fundamental f0 = rpm/60 * cylinders/2        // 4-suw: wybuch na obrót/2
harmonic bank: 12 oscylatorów (saw) na f0*k, k=1..12, amplituda 1/k^1.35 * spectrum_tweak
firing amplitude modulation: LFO przy f0 z envelope (krótki atak 8 ms, decay 60 ms)
   → to jest "pulsowanie", które odróżnia silnik od stałego tonu
load: throttle → jasność (lowpass cutoff 400..6500 Hz) + gain + dodanie parzystych harmonicznych
rpm wysokie: dodaj "buzz" (FM: carrier f0*8, modulator f0*3, index 2.5)
cut przy zmianie biegu: gain → 0.05 na 120 ms + drop cutoff
detune per cylinder ±0.4% → "nierówność" pracy, bez brzmienia syntetycznego
```
Dodatkowo: **dźwięk wydechu** = szum pasmowy (bandpass 180 Hz Q=3) modulowany tym samym envelope'em pracy cylindrów → daje "body".

**4 auta = 4 różne brzmienia** przez: `cylinders` (4 vs 5), `firingOrder`, `spectrum_tweak`, `baseCutoff`, `exhaustQ`. Bez plików.

---

## 3. Napęd / skrzynia / mechanizm

- **Gear whine:** 2 oscylatory (sine + triangle) przy `f0_gear = wheel_rpm * teeth`, gain ∝ torque, cutoff rośnie z prędkością; przy zmianie biegu "clunk" = transient (patrz §5).
- **Differential whine:** szum bandpass 900–1400 Hz, gain ∝ |Δω kół| — czyli **słychać blokadę mechanizmu**.
- **Clutch/synchronizer:** krótki klik (2 transienty 3 ms i 12 ms).

---

## 4. Opony i nawierzchnia (tu fizyka per-koło staje się słyszalna)

Cztery osobne tory (jeden per koło) — to jest możliwe i celowe:

```
tor_koła = [szum biały] → [highpass hp_i] → [lowpass lp_i] → [gain_i] → [pan_i]

hp_i = 900 + 2600 * slip_i          // im większy poślizg, tym więcej wysokiego pasma
lp_i = 1200 + 5200 * surface.brightness
gain_i = base * (0.25 + 0.75*slip_i) * load_norm * surface.noiseGain
pan_i  = pozycja koła (przód/tył, lewo/prawo) → StereoPanner + delay dla głębi
```

**Granularny szuter (osobny warstwa, tylko dla szotru/błota/piasku):**
```
pulser: co 1/(grainRate) sekund odpala "grain" = krótki burst szumu
grainRate = 18..34 Hz * (v / 25)      // szybciej = gęstszy granular
grain duracja 6..14 ms, bandpass losowy z zakresu nawierzchni (żwir 1.2–4 kHz, błoto 200–900 Hz)
amplituda ∝ N_i (obciążenie koła)
```
Realizacja bez alokacji: **pula 16 BufferSourceNode** z jednym wygenerowanym bufferem szumu (2 s, wypełniony w JS), każdy grain = inny offset + playbackRate + własny bandpass. To jest granularna synteza bez plików.

**Błoto:** dodatkowo "squelch" = lowpass 300 Hz + LFO amplitudy 6–11 Hz + mokry reverb send.
**Śnieg:** cichy, wysoki szum + "crunch" (transienty co ~40 ms przy uślizgu).
**Asfalt:** prawie czysty szum toczenia + **skrzypienie** przy `alpha > 8°`: 2 oscylatory (sine 320 Hz + 480 Hz) z nieliniową modulacją (waveshaper) i vibrato 22 Hz — klasyczny tire squeal.
**Aquaplaning:** szeroki szum 2–6 kHz narastający z prędkością + nagły spadek pasma niskiego.

---

## 5. Uderzenia i uszkodzenia

```
transient(speed) = [burst szumu 4–18 ms] → [bandpass f = 120 + 900*speed_norm, Q 1.2]
                 → [lowpass 6 kHz] → [gain ∝ speed]
+ rezonans karoserii: 3 sine (110, 165, 240 Hz) z decay 180 ms, amplituda z kierunku uderzenia
+ metaliczny "clang" przy słupach/bandach: FM (carrier 1400, mod 320, index 6), decay 90 ms
+ uszkodzenie zawieszenia: "clunk" 60 Hz + 20 ms szum
```
Kolejność: uderzenie w bloki (tłumione, więcej niskiego) vs w słup (ostry metaliczny) vs w auto (średni + dzwoniący).

---

## 6. Wiatr, otoczenie, deszcz

- **Wiatr:** szum różowy, gain ∝ v², cutoff ∝ v; przy v > 45 m/s dodaje "rush" pasma 1–4 kHz.
- **Ambience odcinka:** warstwa szumu niskiego (las/woda/wiatr w górach) dobrana per biome, bardzo cicho.
- **Deszcz:** 3 warstwy: szeroki szum (krople), losowe "tick" transienty (pula 8), plus pluskanie pod kołami (zwiększony `gain` kół + więcej niskiego).
- **Opad śniegu:** prawie cisza + sporadyczne "tick" przy uderzeniach płatków (subtelne).

---

## 7. Pilot (voice)

**Wariant A (preferowany):** `window.speechSynthesis` — API przeglądarki, nie plik.
```
utterance.rate = 1.35, pitch = 0.95, volume = 0.9
wybór lektora: pierwszy dostępny "en" / "pl" zależnie od języka gracza
kolejkowanie: max 1 aktywna + 1 w buforze; nowa notatka przerywa starszą jeśli pilniejsza (CAUTION)
```
**Wariant B (fallback, deterministyczny):** synteza sylabiczna — samogłoski z 2–3 oscylatorami (formanty F1/F2 z tabeli) + spółgłoski z krótkimi burstami szumu. Brzmi jak "radio z pilota", nie jak człowiek — ale jest w 100% proceduralne i działa wszędzie. Oba warianty mają identyczny tekst HUD.

**Radio filter:** voice przez bandpass 300–3400 Hz + slight distortion → brzmi jak interkom w kasku.

---

## 8. Muzyka proceduralna (menu, meta, powtórki)

- Perkusja: membrana (sine z pitch drop 180→60 Hz) + szum (hi-hat, 40 ms HP) + klask (szum bandpass 1.8 kHz).
- Bas: FM (carrier 2×, modulator 1×, index 3) z filtrem.
- Harmonia: 3 oscylatory z proceduralnym akordem z trybu (molowy, otwarty).
- **Adaptive w odcinku:** intensywność = `f(prędkość, slip_energy, bliskość hazardu)` → tempo 96→132 BPM, gęstość hi-hatu, otwarcie filtra. Właściwości: muzyka **nie przeszkadza** w odcinku (−6 dB, bez pasma 200–800 Hz, żeby nie kolidowała z silnikiem).

---

## 9. Pogłos (IR generowany, nie wczytywany)

```js
// generowanie IR w JS, 2 s @ 48 kHz, stereo
for (i in N) {
  t = i / N;
  env = exp(-t * decay) * (1 - exp(-t * 400));   // atak 0, decay per scena
  buf[i] = (rand()*2-1) * env;
}
// scena: las (decay 0.5 s, mało wczesnych odbić), wąwóz (1.4 s, dużo wczesnych odbić),
// otwarty płaskowyż (0.3 s), pod mostem (2.0 s + flutter)
ConvolverNode.buffer = generatedBuffer;   // jeden na scenę, przełączany przy odcinku
```

---

## 10. Budżet i testy audio

- ≤ 60 węzłów w grafie, ≤ 16 grainów aktywnych, ≤ 12 oscylatorów silnika.
- `setTargetAtTime` z `timeConstant` ≥ 8 ms — żadnych skoków (klików).
- Limiter na masterze (threshold −3 dB, ratio 8) + hard clamp, bo syntezę łatwo "przedmuchać".
- Testy: (1) silnik przy 3000 vs 6500 rpm różni się w widmie mierzalnie; (2) szuter vs asfalt przy tej samej prędkości — różnica energii w 1–4 kHz > 6 dB; (3) brak klików przy zmianie biegu (analiza envelope); (4) master nie przekracza −1 dBFS przy pełnym gazie na błocie.
