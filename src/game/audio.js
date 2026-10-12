// Tiny WebAudio synth: engine (saw + sub through a lowpass), wind and
// skid noise, UI beeps. No audio files. Everything is guarded so a
// missing AudioContext never breaks the game.

export class GameAudio {
  constructor() {
    this.ctx = null;
    this.muted = false;
    this.started = false;
  }

  ensure() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
      return;
    }
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      const ctx = new AC();
      this.ctx = ctx;
      this.master = ctx.createGain();
      this.master.gain.value = this.muted ? 0 : 0.55;
      this.master.connect(ctx.destination);

      // Engine: saw + square sub into a lowpass.
      this.engGain = ctx.createGain(); this.engGain.gain.value = 0;
      this.engFilter = ctx.createBiquadFilter();
      this.engFilter.type = 'lowpass'; this.engFilter.frequency.value = 500; this.engFilter.Q.value = 2;
      this.osc1 = ctx.createOscillator(); this.osc1.type = 'sawtooth';
      this.osc2 = ctx.createOscillator(); this.osc2.type = 'square';
      const g2 = ctx.createGain(); g2.gain.value = 0.5;
      this.osc1.connect(this.engFilter);
      this.osc2.connect(g2); g2.connect(this.engFilter);
      this.engFilter.connect(this.engGain); this.engGain.connect(this.master);
      this.osc1.start(); this.osc2.start();

      // Noise: one looping buffer through two filters (wind + skid).
      const len = ctx.sampleRate * 1.2;
      const buf = ctx.createBuffer(1, len, ctx.sampleRate);
      const data = buf.getChannelData(0);
      for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
      const mkNoise = (type, freq) => {
        const src = ctx.createBufferSource();
        src.buffer = buf; src.loop = true;
        const f = ctx.createBiquadFilter(); f.type = type; f.frequency.value = freq;
        const g = ctx.createGain(); g.gain.value = 0;
        src.connect(f); f.connect(g); g.connect(this.master);
        src.start();
        return g;
      };
      this.windGain = mkNoise('lowpass', 420);
      this.skidGain = mkNoise('bandpass', 950);
      this.started = true;
    } catch {
      this.ctx = null;
    }
  }

  setMuted(m) {
    this.muted = m;
    if (this.master && this.ctx) this.master.gain.setTargetAtTime(m ? 0 : 0.55, this.ctx.currentTime, 0.05);
  }

  // rpm01: 0..1 engine load/speed blend; speedKmh for wind.
  update(rpm01, throttle, speedKmh, offroad, drifting, running) {
    if (!this.ctx || !this.started) return;
    const t = this.ctx.currentTime;
    const freq = 55 + rpm01 * 175 + throttle * 12;
    this.osc1.frequency.setTargetAtTime(freq, t, 0.06);
    this.osc2.frequency.setTargetAtTime(freq * 0.5 + 1.5, t, 0.06);
    this.engFilter.frequency.setTargetAtTime(380 + rpm01 * 1500 + throttle * 500, t, 0.08);
    this.engGain.gain.setTargetAtTime(running ? 0.055 + throttle * 0.05 + rpm01 * 0.02 : 0, t, 0.09);
    const wind = Math.min(0.16, Math.max(0, speedKmh - 25) / 900) + (offroad && speedKmh > 12 ? 0.045 : 0);
    this.windGain.gain.setTargetAtTime(running ? wind : 0, t, 0.12);
    this.skidGain.gain.setTargetAtTime(running && drifting ? 0.075 : 0, t, 0.05);
  }

  beep(freq = 660, dur = 0.12, type = 'square', vol = 0.16) {
    if (!this.ctx) return;
    try {
      const ctx = this.ctx;
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = type; o.frequency.value = freq;
      g.gain.setValueAtTime(vol, ctx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + dur);
      o.connect(g); g.connect(this.master);
      o.start(); o.stop(ctx.currentTime + dur + 0.02);
    } catch { /* noop */ }
  }
}
