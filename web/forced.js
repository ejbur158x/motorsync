// MOTORSYNC forced induction: boost model (fed to engine-sim's intake as real pressure) plus the
// turbo / blow-off / flutter and supercharger-whine sound from our I6 Turbo and SLR V8 synths.
// Runs in the sim worker: frame() once per 1/60 s sim frame, process() over that frame's audio.
(function (root) {
  class Biquad {
    constructor() { this.b0 = 1; this.b1 = 0; this.b2 = 0; this.a1 = 0; this.a2 = 0; this.z1 = 0; this.z2 = 0; }
    set(type, f, q, sr) {
      const w = 2 * Math.PI * Math.min(Math.max(f, 10), sr * 0.45) / sr;
      const c = Math.cos(w), s = Math.sin(w), al = s / (2 * q);
      let b0, b1, b2, a0, a1, a2;
      if (type === 'hp') { b0 = (1 + c) / 2; b1 = -(1 + c); b2 = b0; a0 = 1 + al; a1 = -2 * c; a2 = 1 - al; }
      else { b0 = al; b1 = 0; b2 = -al; a0 = 1 + al; a1 = -2 * c; a2 = 1 - al; }   // band-pass
      this.b0 = b0 / a0; this.b1 = b1 / a0; this.b2 = b2 / a0; this.a1 = a1 / a0; this.a2 = a2 / a0;
    }
    run(x) { const y = this.b0 * x + this.z1; this.z1 = this.b1 * x - this.a1 * y + this.z2; this.z2 = this.b2 * x - this.a2 * y; return y; }
  }
  // supercharger types: whine order (Hz per rpm/60), how boost builds with rpm, default 'eee'
  const SC = {
    screw: { order: 11, eee: 2, curve: (r) => Math.pow(Math.min(1, r), 0.7) },          // twin-screw (SLR / AMG)
    roots: { order: 6, eee: 0.6, curve: (r) => Math.pow(Math.min(1, r), 0.5) },          // roots blower: lower, chunkier
    centrifugal: { order: 26, eee: 0, curve: (r) => Math.min(1, r * r) },                // belt-driven impeller: rises with rpm
  };

  class ForcedInduction {
    constructor(sr) {
      this.sr = sr; this.r = 0x9e3779b9;
      this.cfg = { type: 'na' };
      this.tBoost = 0; this.sBoost = 0; this.psi = 0; this.prevThr = 0;
      this.whPh = 0; this.bovEnv = 0; this.bovF = 3000; this.fluttPh = 0; this.byEnv = 0;
      this.scPh = 0; this.scAm = 0; this.chopE = 0; this.chopAvg = 1e-3; this.phase = 0;
      this.whooshBp = new Biquad(); this.bovBp = new Biquad(); this.scAir = new Biquad(); this.bypassBp = new Biquad();
      this.eeF2 = new Biquad(); this.eeF3 = new Biquad(); this.hp = new Biquad();
      this.eeF2.set('bp', 2300, 2.2, sr); this.eeF3.set('bp', 3000, 2.8, sr); this.bypassBp.set('bp', 1600, 1.2, sr); this.hp.set('hp', 80, 0.7, sr);
      this.rpm = 0; this.thr = 0;
    }
    rand() { let x = this.r; x ^= x << 13; x ^= x >>> 17; x ^= x << 5; this.r = x >>> 0; return this.r / 4294967296; }
    configure(cfg) { this.cfg = Object.assign({}, cfg || { type: 'na' }); if (this.cfg.type === 'na') { this.tBoost = this.sBoost = this.psi = 0; } }
    get hasTurbo() { return this.cfg.type === 'turbo' || this.cfg.type === 'twin'; }
    get hasSC() { return this.cfg.type === 'sc' || this.cfg.type === 'twin'; }

    // Boost physics for one sim frame. pedal = raw driver input, thr = the plate actually used.
    frame(dt, rpm, pedal, thr, running, redline) {
      const c = this.cfg; this.rpm = rpm; this.thr = thr;
      if (c.type === 'na' || !running) { this.tBoost *= Math.exp(-dt / 0.3); this.sBoost *= Math.exp(-dt / 0.1); }
      else {
        if (this.hasTurbo) {
          const spool = Math.min(1, Math.max(0, (rpm - c.spoolStart) / Math.max(100, c.spoolFull - c.spoolStart)));
          const tgt = thr * spool;
          const tau = tgt > this.tBoost ? c.spoolTime : 0.35;
          this.tBoost += (tgt - this.tBoost) * Math.min(1, dt / tau);
          if (this.prevThr - pedal > 0.35 && this.tBoost > 0.35 && this.bovEnv < 0.05 && c.bov !== 2) {
            this.bovEnv = Math.min(1, this.tBoost * 1.2); this.bovF = 4200; this.fluttPh = 0;
            if (c.bov === 0) this.tBoost *= 0.4;
          }
        }
        if (this.hasSC) {
          const t = SC[c.scType] || SC.screw;
          let tgt = thr * t.curve(rpm / (redline * 0.45));
          if (c.type === 'twin') tgt *= Math.min(1, Math.max(0, (c.handover + 1000 - rpm) / 1000)); // clutch drops the blower out
          this.sBoost += (tgt - this.sBoost) * Math.min(1, dt / (tgt > this.sBoost ? 0.08 : 0.12));
          if (this.prevThr - pedal > 0.35 && this.sBoost > 0.3 && this.byEnv < 0.05) this.byEnv = Math.min(1, this.sBoost);
        }
      }
      this.prevThr = pedal;
      this.psi = this.tBoost * (c.turboPsi || 0) + this.sBoost * (c.scPsi || 0);
      return this.psi;
    }

    // Mix the turbo / blower sound into this frame's engine audio (in place).
    // phase0 = engine cycle position (0..1 over 720°) at the first sample.
    process(buf, phase0) {
      const c = this.cfg; if (c.type === 'na' && this.bovEnv < 0.0005 && this.byEnv < 0.0005) return;
      const sr = this.sr, n = buf.length, rpm = Math.max(0.5, this.rpm), thr = this.thr;
      const bst = this.tBoost, sb = this.sBoost;
      this.whooshBp.set('bp', 2200 + bst * 2600, 0.9, sr);
      const sct = SC[c.scType] || SC.screw;
      const wfSC = rpm * sct.order / 60 * (c.scPitch || 1);
      this.scAir.set('bp', Math.max(200, wfSC * 2.0), 6, sr);
      const eee = c.scEee ?? sct.eee;
      const turboGain = (c.turboLevel ?? 1.6) * 1.0, scGain = (c.scLevel ?? 0.85) * 1.3;   // balanced against engine-sim's (hot) output
      const scAmp = this.hasSC ? (c.scOff + (1 - c.scOff) * Math.pow(sb, sct === SC.centrifugal ? 1.6 : 1.2)) * (0.15 + 0.85 * Math.min(1, rpm / 5000)) * Math.min(1, rpm / 400) : 0;
      const wfT = 1700 + bst * 7250;
      let phase = phase0; const dPhase = rpm / 120 / sr;
      for (let i = 0; i < n; i++) {
        const x = buf[i];
        let add = 0;
        // ---- turbo (from the I6 Turbo synth)
        if (this.hasTurbo || this.bovEnv > 0.0005) {
          this.whPh += wfT / sr; if (this.whPh >= 1) this.whPh -= 1;
          const ph = this.whPh * 2 * Math.PI;
          let turbo = (Math.sin(ph) + 0.25 * Math.sin(2 * ph) + 0.08 * Math.sin(3 * ph)) * 0.10 * Math.pow(bst, 1.5);
          turbo += this.whooshBp.run(this.rand() * 2 - 1) * 0.45 * bst * (0.3 + 0.7 * thr);
          if (this.bovEnv > 0.0005) {
            this.bovBp.set('bp', this.bovF, 1.4, sr);
            let bv = this.bovBp.run(this.rand() * 2 - 1) * this.bovEnv;
            if (c.bov === 1) {
              this.fluttPh += (17 + 8 * this.bovEnv) / sr;
              bv *= (this.fluttPh % 1) < 0.35 ? 1.6 : 0.15;
              this.bovEnv *= Math.exp(-1 / (0.45 * sr));
            } else this.bovEnv *= Math.exp(-1 / (0.28 * sr));
            this.bovF += (1300 - this.bovF) * (1 / (0.2 * sr));
            turbo += bv * 1.3;
          }
          add += turbo * turboGain;
        }
        // ---- supercharger whine (from the SLR V8 synth): pitch locked to rpm, 'eee' colour, engine chop
        if (this.hasSC || this.byEnv > 0.0005) {
          this.scPh += wfSC / sr; if (this.scPh >= 1) this.scPh -= 1;
          this.scAm += wfSC / 4 / sr; if (this.scAm >= 1) this.scAm -= 1;
          const ph = this.scPh * 2 * Math.PI;
          let sc = (Math.sin(ph) + 0.45 * Math.sin(2 * ph + 0.4) + 0.22 * Math.sin(3 * ph + 1.1) + 0.055 * Math.sin(4 * ph + 2.0)) * (1 + 0.12 * Math.sin(this.scAm * 2 * Math.PI));
          let buzz = 0;
          if (eee > 0) {
            const c2 = 2 * Math.cos(ph); let s1 = Math.sin(ph), s0 = 0;
            for (let k = 1; k <= 12 && k * wfSC < sr * 0.45; k++) { buzz += s1 / k; const s2 = c2 * s1 - s0; s0 = s1; s1 = s2; }
            buzz = this.eeF2.run(buzz) + this.eeF3.run(buzz) * 0.6;
          }
          sc = sc * 0.085 + buzz * 0.12 * eee + this.scAir.run(this.rand() * 2 - 1) * 0.5;
          // the engine's own pulses chop into the whine
          this.chopE += (Math.abs(x) - this.chopE) * 0.02;
          this.chopAvg += (this.chopE - this.chopAvg) * 0.0004;
          const chop = Math.min(2.2, this.chopE / (this.chopAvg + 1e-4));
          sc *= (1 - c.scChop) + c.scChop * chop;
          sc *= 1 - (c.scHalf ?? 0.5) * 0.75 * (0.5 + 0.5 * Math.cos(2 * Math.PI * phase));
          sc *= scAmp;
          if (this.byEnv > 0.0005) { sc += this.bypassBp.run(this.rand() * 2 - 1) * this.byEnv * 0.35; this.byEnv *= Math.exp(-1 / (0.18 * sr)); }
          add += sc * scGain;
        }
        phase += dPhase; if (phase >= 1) phase -= 1;
        buf[i] = x + this.hp.run(add);
      }
    }
  }
  const api = { ForcedInduction, SC_TYPES: Object.keys(SC) };
  if (typeof module !== 'undefined') module.exports = api; else root.MSForced = api;
})(typeof self !== 'undefined' ? self : this);
