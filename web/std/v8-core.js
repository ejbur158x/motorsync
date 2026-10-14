// Supercharged cross-plane V8 procedural engine core — pure JS, no deps.
// Shared by the realtime AudioWorklet and the offline loop renderer.
//
// Modelled on a 5.4 L supercharged AMG V8 with side-exit exhaust (SLR-style):
//   8 cylinder pulses, firing order 1-5-4-2-6-3-7-8 on a cross-plane crank.
//   Right bank (1-4) and left bank (5-8) each fire UNEVENLY (gaps of 90/180/270 deg):
//   that unevenness is the V8 burble. Each bank has its own header, pipe and side pipe
//   (no crossover), so the burble survives all the way to the listener.
//   + twin-screw supercharger: belt-driven, whine pitch locked to rpm, boost with no lag.
class Biquad {
  constructor() { this.b0 = 1; this.b1 = 0; this.b2 = 0; this.a1 = 0; this.a2 = 0; this.z1 = 0; this.z2 = 0; }
  set(type, f, q, sr, gainDb = 0) {
    const w = 2 * Math.PI * Math.min(Math.max(f, 10), sr * 0.45) / sr;
    const c = Math.cos(w), s = Math.sin(w), al = s / (2 * q);
    let b0, b1, b2, a0, a1, a2;
    if (type === 'lp') { b0 = (1 - c) / 2; b1 = 1 - c; b2 = b0; a0 = 1 + al; a1 = -2 * c; a2 = 1 - al; }
    else if (type === 'hp') { b0 = (1 + c) / 2; b1 = -(1 + c); b2 = b0; a0 = 1 + al; a1 = -2 * c; a2 = 1 - al; }
    else if (type === 'bp') { b0 = al; b1 = 0; b2 = -al; a0 = 1 + al; a1 = -2 * c; a2 = 1 - al; }
    else { const A = Math.pow(10, gainDb / 40); b0 = 1 + al * A; b1 = -2 * c; b2 = 1 - al * A; a0 = 1 + al / A; a1 = -2 * c; a2 = 1 - al / A; }
    this.b0 = b0 / a0; this.b1 = b1 / a0; this.b2 = b2 / a0; this.a1 = a1 / a0; this.a2 = a2 / a0;
  }
  run(x) { const y = this.b0 * x + this.z1; this.z1 = this.b1 * x - this.a1 * y + this.z2; this.z2 = this.b2 * x - this.a2 * y; return y; }
}
class Pipe { // delay line with damped feedback: a 1-D waveguide for exhaust tubing
  constructor(sr, ms, fb, damp) { this.n = Math.max(2, Math.round(sr * ms / 1000)); this.b = new Float32Array(this.n); this.i = 0; this.fb = fb; this.damp = damp; this.lp = 0; }
  run(x) { const d = this.b[this.i]; this.lp += this.damp * (d - this.lp); const y = x + this.fb * this.lp; this.b[this.i] = y; this.i = (this.i + 1) % this.n; return y; }
}
class Delay {
  constructor(sr, ms) { this.n = Math.max(1, Math.round(sr * ms / 1000)); this.b = new Float32Array(this.n); this.i = 0; }
  run(x) { const y = this.b[this.i]; this.b[this.i] = x; this.i = (this.i + 1) % this.n; return y; }
}

// Starter motor model, shared by the I6 and V8 cores (pasted into each core by tools/inject-starter).
// Built from measured starts: crank speed from the compression-pulse rate, whine pitch/partials,
// engagement ring frequencies and how the whine dips on each compression.
class Starter {
  constructor(sr, P) {
    this.sr = sr; this.P = P; this.r = 0x9e3779b9;
    this.ph = P.partials.map(() => 0);
    this.rings = P.rings.map(([f, tau, a]) => { const b = new Biquad(); b.set('bp', f, Math.PI * f * tau, sr); return { b, a }; });
    this.gear = new Biquad(); this.gear.set('bp', P.gearHz, 1.4, sr);
    this.air = new Biquad(); this.air.set('bp', P.airHz, 0.55, sr);
    this.air2 = new Biquad(); this.air2.set('bp', P.airHz * 0.45, 0.6, sr);   // broadband 'whirr' body
    this.exc = 0; this.lastF = P.whineHz;
  }
  rnd() { let x = this.r; x ^= x << 13; x ^= x >>> 17; x ^= x << 5; this.r = x >>> 0; return this.r / 2147483648 - 1; }
  engage() { this.exc = 1; }
  _rings() {
    const P = this.P, e = this.exc > 1e-4 ? this.rnd() * this.exc : 0;
    this.exc *= Math.exp(-1 / (P.excTau * this.sr));
    let y = 0; for (const r of this.rings) y += r.b.run(e) * r.a;
    return y * P.ringLevel;
  }
  _whine(f, amp) {
    const P = this.P; let y = 0;
    for (let k = 0; k < P.partials.length; k++) {
      const [mul, a] = P.partials[k];
      this.ph[k] += f * mul / this.sr; if (this.ph[k] >= 1) this.ph[k] -= 1;
      y += a * Math.sin(2 * Math.PI * this.ph[k]);
    }
    this.lastF = f;
    return y * amp;
  }
  // t: seconds since engage, ramp: 0..1 spin-up, load: 0..1 compression load right now
  crank(t, ramp, load) {
    const P = this.P;
    const bump = 1 + P.spinBump * Math.exp(-t / 0.12);                 // unloaded spin-up overshoot
    const f = P.whineHz * ramp * bump * (1 - P.whineWob * load);         // armature slows on each compression
    const lm = P.loadMod, amp = (1 - lm + lm * load) * Math.min(1, t / 0.03) * (1 + P.spinLoud * Math.exp(-t / P.spinTau)); // free-spinning before it loads up = louder
    const n = this.rnd();
    return P.level * (this._whine(f, amp) * P.whineAmp
      + this.gear.run(n) * P.gearAmp * amp
      + this.air.run(this.rnd()) * P.airAmp * amp + this.air2.run(this.rnd()) * P.airAmp * 0.7 * amp)
      + this._rings();
  }
  // after the engine catches: pinion kicks out, the armature winds down ("zing")
  spinDown(td) {
    const P = this.P;
    const f = this.lastF > 0 ? P.whineHz * (1 + P.overrun * Math.exp(-td / 0.04)) * Math.exp(-td / P.spinDownS) : 0;
    const amp = P.spinDownAmp * Math.exp(-td / (P.spinDownS * 0.6));
    return P.level * this._whine(f, amp) * P.whineAmp + this._rings();
  }
}

class V8Core {
  constructor(sr, seed = 12345) {
    this.sr = sr; this.reseed(seed);
    // ---- inputs
    this.targetRpm = 600; this.targetThrottle = 0; this.boostOverride = -1;
    this.engineGain = 1; this.scGain = 0.85; this.masterGain = 0.8;
    this.scEee = 2;            // 'eee' vowel colour on the blower whine (0 = pure 'ooo' tone)
    this.scChop = 0.75;        // how much the engine's pulses chop into the whine
    this.scOff = 0.07;         // whine level off-throttle (bypass open), as a fraction of full boost (0.03 = -30 dB)
    this.scHalf = 0.75;        // how much the ½-order thump (once per 2 revs) pulls the whine down
    this.scPitch = 1;          // supercharger whine pitch multiplier
    this.bypassWhoosh = true;  // soft air rush from the bypass valve when you lift on boost
    this.popsEnabled = true;
    this.popAmount = 2.15;      // overrun crackle amount
    this.popDuration = 4;      // seconds of crackle after a lift (it dies out after that)
    this.pulseMute = false;    // render-only: silence the combustion pulses (crackle one-shots)
    this.popCharge = 0; this.rpmRate = 0; this.lastRpm = 0;
    this.character = 1;        // 0 = SLR refined ... 1 = AMG brute (more burble, bark, crackle)
    this.thrAttack = 0.13; this.thrRelease = 0.21;
    this.rpmSlew = 18500;
    this.fuelCut = false; this._fc = false;
    this.running = true;
    this.idleRpm = 600;
    // ---- state
    this.rpm = 600; this.throttle = 0; this.boost = 0;
    this.phase = 0; this.slot = -1; this.ctr = 0; this.cycInc = 0; this.prevThr = 0;
    // firing order 1-5-4-2-6-3-7-8. Bank 0 = right (cyl 1-4), bank 1 = left (cyl 5-8)
    this.order = [0, 4, 3, 1, 5, 2, 6, 7];
    this.cyl = [1.2, 0.95, 1.05, 0.97, 1.02, 0.94, 1.06, 0.98]; // cyl 1 strongest: ½-order lope
    this.pend = [];
    this.envA = 1; this.envB = 1; this.tauA = 0.004; this.tauB = 0.004; this.ampA = 0; this.ampB = 0;
    this.pops = []; this.wob = 0; this.wobT = 0; this.wobGoal = 0;
    // exhaust: each bank has its own header, pipe and side pipe
    this.hdrA = new Delay(sr, 1.1); this.hdrB = new Delay(sr, 1.35);
    this.pipeA = new Pipe(sr, 2.7, 0.3, 0.42); this.pipeB = new Pipe(sr, 3.05, 0.3, 0.4);
    this.sideA = new Pipe(sr, 6.2, 0.24, 0.28); this.sideB = new Pipe(sr, 6.6, 0.24, 0.27);
    // Listener sits beside the near side pipe (like a driver / POV mic): the far bank is quieter and ~3.5 ms late.
    // Hearing mostly ONE cross-plane bank is what puts the SLR's weight on orders 1.5 and 2.5.
    this.farB = new Delay(sr, 3.5);
    // Tone tuned by measurement against a real SLR recording (order levels + octave bands):
    this.tune = { farGain: 0.35, o15: 0, o25: 6, o2: 0, o1: 0, fund: 0, half: 5, lpBase: 750, lpRpm: 0.6, tauMax: 0.0058, tauFrac: 0.6,
                  intake: 1.1, intakeF: 0.11, intakeQ: 0.8, raspG: 0.3, airG: 1.4, airF: 1200, airQ: 4, bodyF: 150, bodyG: 9, topCut: 2800, idleLump: 0.6, idleFar: 1.0, idleEven: 0.8 };
    this.lpB = 0; // far pipe sounds darker: the two banks have different voices, so the uneven bank pattern is audible
    this.f = {}; for (const k of ['hp','half','o1','o2','fund','sub','body','rasp','lp','outHp','raspBp','intakeBp','scAir','bypassBp','stBp','clBp','airBp','top']) this.f[k] = new Biquad();
    this.f.hp.set('hp', 16, 0.7, sr); this.f.outHp.set('hp', 20, 0.7, sr);
    this.f.stBp.set('bp', 1700, 1.2, sr); this.f.clBp.set('bp', 700, 1.0, sr);
    // supercharger
    this.scPh = 0; this.scAm = 0; this.byEnv = 0; this.chopE = 0; this.chopAvg = 1e-3;
    this.eeF2 = new Biquad(); this.eeF3 = new Biquad(); this.eeF2.set('bp', 2300, 2.2, sr); this.eeF3.set('bp', 3000, 2.8, sr); // 'ee' vowel formants
    // starter + clunk
    this.startT = -1; this.stPh = 0; this.clT = 1e9; this.clAmp = 0; this.clF = 90;
    // AMG / SLR starter, measured: short ~0.75 s crank at ~170 rpm (11.4 Hz compression pulses), ~870 Hz whine that
    // overshoots on spin-up, and a bright metallic 'disc' zing at engagement (rings at 2.68 / 2.47 kHz, 880 Hz, 6.5 kHz).
    this.stProfile = { crankS: 0.75, crankRpm: 170, comps: 4, dip: 0.28, spinUpS: 0.08, flareS: 0.35, flareRpm: 1450, settleS: 1.6,
      whineHz: 870, whineWob: 0.06, spinBump: 0.09, spinLoud: 6, spinTau: 0.2, partials: [[1, 1], [1.507, 0.65], [2.25, 0.3], [3.35, 0.25]], whineAmp: 0.075, loadMod: 0.35,
      gearHz: 1960, gearAmp: 0.18, airHz: 2900, airAmp: 0.8, level: 0.05,
      rings: [[2684, 0.09, 1], [2473, 0.08, 0.8], [879, 0.12, 0.6], [6551, 0.03, 0.45], [3504, 0.05, 0.4]], excTau: 0.01, ringLevel: 0.01,
      spinDownS: 0.1, spinDownAmp: 0.15, overrun: 0.15 };
    this.starter = new Starter(sr, this.stProfile);
  }
  reseed(s) { this.r = s >>> 0 || 1; }
  rand() { let x = this.r; x ^= x << 13; x ^= x >>> 17; x ^= x << 5; this.r = x >>> 0; return this.r / 4294967296; }

  ignite() { this.startT = 0; this.running = true; this.rpm = 0; this.phase = 0; }
  // a little burst of n pops (also used to render crackle one-shots)
  crackle(n) {
    let w = 0;
    for (let i = 0; i < n; i++) { this.pops.push({ wait: Math.floor(w), t: 0, amp: (0.5 + this.rand() * 1.3) * (i ? 0.6 : 1), bank: this.rand() < 0.7 ? 0 : 1 }); w += this.sr * (0.012 + this.rand() * 0.04); }
  }
  clunk(kind) { this.clT = 0; this.clAmp = kind < 0 ? 1.0 : 0.85; this.clF = kind < 0 ? 105 : 82; this.f.clBp.set('bp', kind < 0 ? 850 : 600, 1.0, this.sr); }

  updateFilters() {
    const sr = this.sr, rpm = this.rpm, t = this.throttle, ch = this.character, k = rpm / 7000, f = this.f;
    const T = this.tune;
    f.half.set('pk', Math.max(12, rpm / 120), 1.2, sr, T.half);     // ½ order: lope
    const load = Math.min(1, Math.max(0, (rpm - this.idleRpm) / 1400)); // the one-bank growl builds off idle
    f.o1.set('pk', Math.max(12, rpm / 40), 1.6, sr, (T.o15 + 2 * ch) * load); // 1.5 order: one-bank growl
    f.o2.set('pk', rpm / 24, 1.6, sr, (T.o25 + 2 * ch) * load);               // 2.5 order: the SLR's main voice
    f.fund.set('pk', rpm / 15, 1.6, sr, T.fund);                    // firing note
    f.sub.set('pk', 55 + 40 * k, 0.75, sr, 6);                      // chest
    f.body.set('pk', T.bodyF + 110 * k, 0.9, sr, T.bodyG);
    f.rasp.set('pk', 1500 + 700 * k + 400 * ch, 1.3, sr, 0.5 + (1 + 2.5 * ch) * t);
    f.lp.set('lp', T.lpBase + rpm * T.lpRpm + t * (1200 + 1200 * ch), 0.7, sr);
    f.raspBp.set('bp', 2200 + 1200 * k + (this.rand() - 0.5) * 400, 1.1, sr);
    f.intakeBp.set('bp', 300 + rpm * T.intakeF, T.intakeQ, sr);
    f.airBp.set('bp', T.airF + rpm * 0.12, T.airQ, sr);
    f.top.set('lp', T.topCut, 0.6, sr);                              // final top cut on the engine bus                    // induction + blower air rush
    const wf = rpm * V8Core.WHINE_HZ_PER_RPM * this.scPitch;
    f.scAir.set('bp', Math.max(200, wf * 2.0), 6, sr);             // narrow air whistle riding the whine
    f.bypassBp.set('bp', 1600, 1.2, sr);
  }

  sample() {
    const sr = this.sr, ch = this.character, f = this.f, IDLE = this.idleRpm;
    let starter = 0, combust = this.running;

    // ---- start: crank ~1.2 s, catch, flare, settle
    if (this.startT >= 0) {
      const t = this.startT, S = this.stProfile, IDL = this.idleRpm;
      if (t === 0) this.starter.engage();
      this.startT += 1 / sr;
      if (t < S.crankS) {
        combust = false;
        const load = Math.max(0, Math.sin(this.phase * 2 * Math.PI * 2 * S.comps)) ** 2;   // compression stroke load
        const ramp = Math.min(1, t / S.spinUpS);
        this.rpm = ramp * S.crankRpm * (1 - S.dip * load);
        this.targetRpm = this.rpm; this.throttle = 0; this.targetThrottle = 0;
        starter = this.starter.crank(t, ramp, load);
      } else if (t < S.crankS + S.flareS) {
        this.targetRpm = S.flareRpm; this.targetThrottle = 0.45; starter = this.starter.spinDown(t - S.crankS);
      } else if (t < S.crankS + S.flareS + S.settleS) {
        this.targetRpm = S.flareRpm - (t - S.crankS - S.flareS) / S.settleS * (S.flareRpm - IDL); this.targetThrottle = 0.15;
        starter = this.starter.spinDown(t - S.crankS);
      } else this.startT = -1;
    }
    if (this.fuelCut !== this._fc) { this._fc = this.fuelCut; this.throttle = this.fuelCut ? 0.05 : Math.max(this.throttle, this.targetThrottle * 0.9); }
    if (this.fuelCut) combust = false;
    if (!this.running && this.startT < 0) { this.targetRpm = 0; this.targetThrottle = 0; combust = false; }

    // ---- smoothing + organic wobble
    if (!this.noWob && (this.wobT -= 1) <= 0) { this.wobT = sr * (0.08 + this.rand() * 0.14); this.wobGoal = this.rand() - 0.5; } // noWob: loop renders stay periodic
    this.wob += (this.wobGoal - this.wob) * 0.0004;
    if (this.startT < 0 || this.startT >= this.stProfile.crankS) { const lim = this.rpmSlew / sr; this.rpm += Math.max(-lim, Math.min(lim, (this.targetRpm - this.rpm) * 0.0025)); }
    if (!this.fuelCut) this.throttle += (this.targetThrottle - this.throttle) / ((this.targetThrottle > this.throttle ? this.thrAttack : this.thrRelease) * sr);
    const thr = this.throttle, idleness = Math.max(0, 1 - (this.rpm - IDLE) / 1400);
    const rpm = Math.max(0.5, this.rpm * (1 + this.wob * 0.016 * (0.4 + idleness)));

    // ---- supercharger: boost follows throttle almost instantly (bypass valve closes), scales with rpm
    if (this.boostOverride >= 0) this.boost = this.boostOverride;
    else {
      const rpmF = Math.pow(Math.min(1, rpm / 3200), 0.7);
      const pedal = this.fuelCut ? this.targetThrottle : thr;
      const tgt = pedal * rpmF * (combust || this.fuelCut ? 1 : 0);
      this.boost += (tgt - this.boost) / ((tgt > this.boost ? 0.08 : 0.12) * sr);
      if (this.bypassWhoosh && this.prevThr - this.targetThrottle > 0.35 && this.boost > 0.3 && this.byEnv < 0.05) this.byEnv = Math.min(1, this.boost);
    }
    this.prevThr = this.targetThrottle;
    // crackle charge: builds on throttle at higher rpm, burns off over popDuration once you lift
    if ((this.ctr & 31) === 0) {
      const dt = 32 / sr;
      this.rpmRate += ((this.rpm - this.lastRpm) / dt - this.rpmRate) * 0.25; this.lastRpm = this.rpm;
      if (thr > 0.5 && rpm > 2500) this.popCharge = Math.min(1, this.popCharge + dt / 0.8);
      else if (thr < 0.08) this.popCharge = Math.max(0, this.popCharge - dt / Math.max(0.1, this.popDuration));
    }
    if ((this.ctr++ & 31) === 0) this.updateFilters();

    // ---- crank: one cycle = 2 revs = 8 firings, 90 deg apart
    const inc = this.cycInc > 0 ? this.cycInc : rpm / 120 / sr;
    this.phase += inc; if (this.phase >= 1) this.phase -= 1;
    const slot = Math.floor(this.phase * 8);
    const interval = 1 / (inc * 8 * sr);
    if (slot !== this.slot) {
      this.slot = slot;
      const c = this.order[slot], lump = (0.6 + 0.6 * ch) * (1 + this.tune.idleLump * idleness); // idle = lumpier
      const load = this.pulseMute ? 0 : (combust ? 0.28 + 0.72 * thr : 0.1);
      let amp = (1 + (this.cyl[c] - 1) * lump) * load * (1 + (this.rand() - 0.5) * (0.14 + 0.22 * idleness));
      if (combust && thr < 0.3 && this.rand() < 0.05 * idleness) amp *= 0.6;
      const tau = Math.min(this.tune.tauMax, interval * this.tune.tauFrac) * (0.85 + this.rand() * 0.3);
      const wait = Math.floor(this.rand() * interval * sr * (0.025 + 0.045 * idleness));
      this.pend.push({ wait, amp, tau, bank: c < 4 ? 0 : 1 });
      // AMG overrun crackle: pops come in little bursts
      // Overrun crackle: only right after a lift (the charge built on throttle burns off), much more when rpm falls fast
      if (this.popsEnabled) {
        const decel = Math.min(1, Math.max(0, (-this.rpmRate - 300) / 1500));
        const pLift = combust && thr < 0.08 ? 0.045 * this.popAmount * this.popCharge * (0.15 + 0.85 * decel) * Math.min(1, rpm / 4500) : 0;
        const pCut = this.fuelCut ? 0.01 * this.popAmount : 0;
        if (this.rand() < pLift + pCut) this.crackle(1 + Math.floor(this.rand() * (1 + 2 * ch)));
      }
    }
    for (let i = this.pend.length - 1; i >= 0; i--) {
      const p = this.pend[i];
      if (p.wait-- <= 0) {
        if (p.bank === 0) { this.ampA = p.amp; this.tauA = p.tau; this.envA = 0; } else { this.ampB = p.amp; this.tauB = p.tau; this.envB = 0; }
        this.pend.splice(i, 1);
      }
    }
    this.envA += 1 / sr; this.envB += 1 / sr;
    const pA = this.ampA * (1 - Math.exp(-this.envA / 0.0004)) * Math.exp(-this.envA / this.tauA);
    const pB = this.ampB * (1 - Math.exp(-this.envB / 0.0004)) * Math.exp(-this.envB / this.tauB);
    const nz = this.rand() * 2 - 1, nz2 = this.rand() * 2 - 1;
    const turb = 0.12 + 0.18 * ch * thr;
    let exA = pA * (1 + turb * nz), exB = pB * (1 + turb * nz2);
    for (let i = this.pops.length - 1; i >= 0; i--) {
      const p = this.pops[i];
      if (p.wait > 0) { p.wait--; continue; }
      const v = p.amp * Math.exp(-p.t / 0.0035) * (0.5 + nz);
      if (p.bank === 0) exA += v; else exB += v;
      p.t += 1 / sr; if (p.t > 0.03) this.pops.splice(i, 1);
    }

    // ---- exhaust: two independent side pipes
    const a = this.sideA.run(this.pipeA.run(this.hdrA.run(exA)));
    const bDry = this.sideB.run(this.pipeB.run(this.hdrB.run(exB)));
    const bFar = this.farB.run(bDry);
    this.lpB += 0.16 * (bFar - this.lpB);
    const idlB = Math.max(0, 1 - (rpm - this.idleRpm) / 1400);
    let b = this.lpB * 1.25 * (1 - idlB * this.tune.idleEven) + bDry * idlB * this.tune.idleEven; // idle: both banks arrive together, so they blend into an even firing note
    // at idle the flow is low and you hear both pipes more evenly (real SLR idle is firing-note led)
    const idl = Math.max(0, 1 - (rpm - this.idleRpm) / 1400);
    let x = a + (this.tune.farGain + (this.tune.idleFar - this.tune.farGain) * idl) * b;
    x = f.hp.run(x); x = f.half.run(x); x = f.o1.run(x); x = f.o2.run(x); x = f.fund.run(x); x = f.sub.run(x); x = f.body.run(x); x = f.rasp.run(x); x = f.lp.run(x);
    const drive = 1.0 + (0.8 + 1.2 * ch) * thr, bias = 0.07 + 0.05 * ch;
    let eng = (Math.tanh(drive * (x * 0.8 + bias)) - Math.tanh(drive * bias)) / Math.tanh(drive);
    eng += f.raspBp.run(nz) * (pA + pB) * this.tune.raspG * (0.05 + 0.18 * ch) * (0.3 + thr) * (0.3 + rpm / 7000);
    eng += f.intakeBp.run(this.rand() * 2 - 1) * (0.25 * this.tune.intake + this.tune.intake * thr) * (0.3 + rpm / 7000);   // induction roar
    eng += f.airBp.run(this.rand() * 2 - 1) * this.tune.airG * (0.15 + thr) * (0.2 + rpm / 7000) * (0.4 + 0.6 * this.boost);
    eng = f.top.run(eng) * (0.65 + 0.35 * (rpm / 7000)) * Math.min(1, rpm / 450);

    // ---- supercharger whine: twin-screw, pitch locked to rpm. Bypass open = quiet whir, closed = scream
    const wf = rpm * V8Core.WHINE_HZ_PER_RPM * this.scPitch;
    this.scPh += wf / sr; if (this.scPh >= 1) this.scPh -= 1;
    this.scAm += wf / 4 / sr; if (this.scAm >= 1) this.scAm -= 1;   // male rotor rev: slight lobe-to-lobe unevenness
    const ph = this.scPh * 2 * Math.PI;
    const bst = this.boost;
    const scAmp = (this.scOff + (1 - this.scOff) * Math.pow(bst, 1.2)) * (0.15 + 0.85 * Math.min(1, rpm / 5000)) * Math.min(1, rpm / 400);
    // measured on the real car: mesh line at order 11, 2nd harmonic -7 dB, 3rd -13 dB, 4th about -25 dB
    let sc = (Math.sin(ph) + 0.45 * Math.sin(2 * ph + 0.4) + 0.22 * Math.sin(3 * ph + 1.1) + 0.055 * Math.sin(4 * ph + 2.0)) * (1 + 0.12 * Math.sin(this.scAm * 2 * Math.PI));
    // 'eee': a buzzy band-limited rotor-pass wave pushed through the ee-vowel formants (F2 ~2.3 kHz, F3 ~3 kHz)
    let buzz = 0;
    if (this.scEee > 0) {
      const c2 = 2 * Math.cos(ph); let s1 = Math.sin(ph), s0 = 0;
      for (let k = 1; k <= 12 && k * wf < sr * 0.45; k++) { buzz += s1 / k; const s2 = c2 * s1 - s0; s0 = s1; s1 = s2; }
      buzz = this.eeF2.run(buzz) * 1.0 + this.eeF3.run(buzz) * 0.6;
    }
    sc = sc * 0.085 + buzz * 0.12 * this.scEee + f.scAir.run(this.rand() * 2 - 1) * 0.5;
    // engine pulses chop into the whine: the blower breathes through the near bank's intake/exhaust pulsing
    const pe = pA + this.tune.farGain * pB;
    this.chopE += (pe - this.chopE) * 0.02;                 // ~150 Hz envelope: keeps the 0.5-4 order pattern
    this.chopAvg += (this.chopE - this.chopAvg) * 0.0004;   // ~50 ms running average
    const chop = Math.min(2.2, this.chopE / (this.chopAvg + 1e-4));
    sc *= (1 - this.scChop) + this.scChop * chop;
    // ½-order lope: the whine dips once per engine cycle, right as the strong cylinder fires
    sc *= 1 - this.scHalf * 0.75 * (0.5 + 0.5 * Math.cos(2 * Math.PI * this.phase));
    sc *= scAmp;
    if (this.byEnv > 0.0005) { sc += f.bypassBp.run(this.rand() * 2 - 1) * this.byEnv * 0.35; this.byEnv *= Math.exp(-1 / (0.18 * sr)); }

    // ---- gear clunk
    let clunk = 0;
    if (this.clT < 0.25) {
      const t = this.clT;
      clunk = this.clAmp * (Math.sin(2 * Math.PI * this.clF * t) * Math.exp(-t / 0.035) * 0.7 + f.clBp.run(this.rand() * 2 - 1) * Math.exp(-t / 0.01) * 1.2);
      this.clT += 1 / sr;
    }

    const out = f.outHp.run(eng * this.engineGain * 0.9 + sc * this.scGain + starter * this.engineGain + clunk);
    return Math.tanh(out * this.masterGain * 1.2);
  }
}
// Blower mesh frequency measured on a real SLR: order 11 = 11/60 Hz per engine rpm
V8Core.WHINE_HZ_PER_RPM = 11 / 60;
