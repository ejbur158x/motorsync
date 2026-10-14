// I6 Turbo procedural engine core v3 — pure JS, no deps.
// Shared by the realtime AudioWorklet and the offline loop renderer.
//
// Signal path (modelled on a turbo I6 with a split manifold, like a 2JZ / RB26):
//   6 cylinder pulses (jittered, imbalanced) -> bank A (cyl 1-3) / bank B (cyl 4-6)
//   -> header delay + pipe resonator per bank -> collector -> tailpipe resonator
//   -> muffler EQ -> asymmetric saturation (rasp) -> + intake, turbo, starter, clunks
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

// Pipe = delay line with damped feedback (a 1-D waveguide). Gives the natural,
// slightly irregular resonance ladder of real exhaust tubing.
class Pipe {
  constructor(sr, ms, fb, damp) {
    this.n = Math.max(2, Math.round(sr * ms / 1000)); this.b = new Float32Array(this.n); this.i = 0;
    this.fb = fb; this.damp = damp; this.lp = 0;
  }
  run(x) {
    const d = this.b[this.i];
    this.lp += this.damp * (d - this.lp);
    const y = x + this.fb * this.lp;
    this.b[this.i] = y; this.i = (this.i + 1) % this.n;
    return y;
  }
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

class I6Core {
  constructor(sr, seed = 12345) {
    this.sr = sr; this.reseed(seed);
    // targets (set from outside)
    this.targetRpm = 850; this.targetThrottle = 0; this.boostOverride = -1;
    this.bovMode = 0;          // 0 = blow-off, 1 = compressor flutter, 2 = none
    this.engineGain = 1; this.turboGain = 1.6; this.masterGain = 0.8;
    this.popsEnabled = true;
    this.character = 0.5;      // 0 = 2JZ smooth, 1 = RB26 mean
    this.thrAttack = 0.13; this.thrRelease = 0.21; // seconds: throttle plate + manifold fill
    this.rpmSlew = 18500;      // max rpm/s the SOUND will follow (guards against jumpy game physics)
    this.fuelCut = false; this._fc = false; // rev limiter: kills combustion instantly, throttle stays open
    this.spoolTime = 1.55;     // seconds to full boost; -1 = from character (2JZ laggy ... RB snappy)
    this.running = true;       // combustion on/off (ignite() runs the start sequence)
    // state
    this.rpm = 850; this.throttle = 0; this.boost = 0;
    this.phase = 0; this.slot = -1; this.ctr = 0; this.cycInc = 0; this.prevThr = 0;
    // I6 firing order 1-5-3-6-2-4 (0-indexed). Banks: cyl 1-3 -> A, 4-6 -> B (split manifold)
    this.order = [0, 4, 2, 5, 1, 3];
    this.cyl = [1.34, 0.97, 1.03, 0.95, 1.0, 0.98]; // cyl 1 hits hardest once per cycle = the ½-order thump // fixed imbalance per cylinder: drives the 0.5 / 1st orders
    // pending pulses (firing jitter means a pulse can start a little late)
    this.pend = []; // {wait, amp, tau, bank}
    this.envA = 0; this.envB = 0; this.riseA = 0; this.riseB = 0; this.tauA = 0.003; this.tauB = 0.003; this.ampA = 0; this.ampB = 0;
    this.popT = 1e9; this.popAmp = 0; this.wob = 0; this.wobT = 0;
    // exhaust
    this.hdrA = new Delay(sr, 0.9); this.hdrB = new Delay(sr, 1.1);
    this.pipeA = new Pipe(sr, 1.85, 0.3, 0.5); this.pipeB = new Pipe(sr, 2.3, 0.3, 0.45);
    this.tail = new Pipe(sr, 4.8, 0.26, 0.3);
    this.o15 = new Biquad(); this.o6 = new Biquad(); this.o15Tune = 1; this.o6Tune = 4;
    this.thump = 1;            // ½-order thump amount: 1 = EJ's tuned lump, ~0.15 = a stock-smooth 2JZ
    this.half = new Biquad(); this.fund = new Biquad(); this.hp = new Biquad(); this.sub = new Biquad(); this.body = new Biquad(); this.rasp = new Biquad(); this.lp = new Biquad(); this.outHp = new Biquad();
    this.raspBp = new Biquad(); this.intakeBp = new Biquad(); this.whooshBp = new Biquad(); this.bovBp = new Biquad();
    this.hp.set('hp', 18, 0.7, sr); this.outHp.set('hp', 22, 0.7, sr);
    // turbo
    this.whPh = 0; this.bovEnv = 0; this.bovF = 3000; this.fluttPh = 0;
    // starter + clunk
    this.startT = -1; this.stPh = 0; this.stBp = new Biquad(); this.stBp.set('bp', 1900, 1.2, sr);
    // 2JZ starter, measured: ~155 rpm crank (7.7 Hz compression pulses), 2.26 kHz gear whine dipping ~11% per compression,
    // 0.465x gear partial (~1.05 kHz), light engagement clank, short spin-down zing.
    this.stProfile = { crankS: 1.15, crankRpm: 155, comps: 3, dip: 0.3, spinUpS: 0.12, flareS: 0.3, flareRpm: 1650, settleS: 1.25,
      whineHz: 2260, whineWob: 0.11, spinBump: 0.04, spinLoud: 0, spinTau: 0.15, partials: [[1, 1], [0.465, 0.6], [2, 0.18]], whineAmp: 0.16, loadMod: 0.3,
      gearHz: 1050, gearAmp: 0.25, airHz: 2400, airAmp: 0.9, level: 0.2,
      rings: [[2215, 0.05, 1], [3762, 0.04, 0.6], [680, 0.06, 0.5], [4254, 0.03, 0.4]], excTau: 0.006, ringLevel: 0.006,
      spinDownS: 0.18, spinDownAmp: 0.15, overrun: 0.12 };
    this.starter = new Starter(sr, this.stProfile);
    this.clT = 1e9; this.clAmp = 0; this.clF = 95; this.clBp = new Biquad(); this.clBp.set('bp', 700, 1.0, sr);
  }
  reseed(s) { this.r = s >>> 0 || 1; }
  rand() { let x = this.r; x ^= x << 13; x ^= x >>> 17; x ^= x << 5; this.r = x >>> 0; return this.r / 4294967296; }

  // --- one-shot triggers (callable through the worklet port)
  ignite() { this.startT = 0; this.running = true; this.rpm = 0; this.phase = 0; }
  clunk(kind) { // 1 = upshift, -1 = downshift
    this.clT = 0; this.clAmp = kind < 0 ? 1.0 : 0.8; this.clF = kind < 0 ? 120 : 92;
    this.clBp.set('bp', kind < 0 ? 900 : 650, 1.0, this.sr);
  }

  updateFilters() {
    const sr = this.sr, rpm = this.rpm, t = this.throttle, ch = this.character, k = rpm / 7000;
    this.half.set('pk', Math.max(14, rpm / 120), 1.2, sr, 10 * this.thump);  // ½ order: the one-cylinder thump (EJ's ask; a stock 2JZ is far smoother)
    // measured on a real 2JZ pull: the 1.5 order is quiet low down and grows hard toward redline; 2x firing (order 6) sits ~-12 dB
    this.o15.set('pk', rpm / 40, 1.6, sr, -8 + 20 * Math.min(1, rpm / 7000) * this.o15Tune);
    this.o6.set('pk', rpm / 10, 1.8, sr, this.o6Tune);
    this.fund.set('pk', rpm / 20, 1.6, sr, 5);                  // firing note: the JDM howl on top
    this.sub.set('pk', 70 + 50 * k, 0.8, sr, 4);
    this.body.set('pk', 190 + 140 * k, 1.0, sr, 3);
    this.rasp.set('pk', 1900 + 900 * k + 500 * ch, 1.3, sr, 1 + (1.5 + 2.5 * ch) * t);
    this.lp.set('lp', 1100 + rpm * 0.75 + t * (1600 + 1400 * ch), 0.7, sr);
    this.raspBp.set('bp', 2600 + 1400 * k + 600 * ch + (this.rand() - 0.5) * 500, 1.1, sr);
    this.intakeBp.set('bp', 450 + rpm * (0.15 + 0.08 * ch), 0.9, sr);
    this.whooshBp.set('bp', 2200 + this.boost * 2600, 0.9, sr);
    this.bovBp.set('bp', this.bovF, 1.4, sr);
  }

  sample() {
    const sr = this.sr, ch = this.character;
    let starter = 0, combust = this.running;

    // ---- start sequence: crank ~1.1 s, catch, flare, settle
    if (this.startT >= 0) {
      const t = this.startT, S = this.stProfile, IDL = 850;
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
    if (!this.running && this.startT < 0) { this.targetRpm = 0; this.targetThrottle = 0; combust = false; } // shut-down spin-down

    // ---- smoothing (+ slow organic wobble so idle is never metronome-perfect)
    if (!this.noWob && (this.wobT -= 1) <= 0) { this.wobT = sr * (0.08 + this.rand() * 0.12); this.wobGoal = (this.rand() - 0.5); } // noWob: loop renders stay periodic
    this.wob += ((this.wobGoal || 0) - this.wob) * 0.0004;
    if (this.startT < 0 || this.startT >= this.stProfile.crankS) { const lim = this.rpmSlew / sr; this.rpm += Math.max(-lim, Math.min(lim, (this.targetRpm - this.rpm) * 0.0025)); }
    // throttle plate + manifold fill: ~130 ms to open, ~180 ms to close
    if (!this.fuelCut) this.throttle += (this.targetThrottle - this.throttle) / ((this.targetThrottle > this.throttle ? this.thrAttack : this.thrRelease) * sr);
    const thr = this.throttle, idleness = Math.max(0, 1 - (this.rpm - 850) / 1500);
    const rpm = Math.max(0.5, this.rpm * (1 + this.wob * 0.012 * (0.4 + idleness)));

    // ---- turbo spool + lift valve
    if (this.boostOverride >= 0) this.boost = this.boostOverride;
    else {
      const spool = Math.min(1, Math.max(0, (rpm - 1700) / 2600));
      const tgt = (this.fuelCut ? this.targetThrottle : thr) * spool * (combust || this.fuelCut ? 1 : 0);
      const tau = tgt > this.boost ? (this.spoolTime > 0 ? this.spoolTime : 0.7 - 0.3 * ch) : 0.35;
      this.boost += (tgt - this.boost) * (1 / (tau * sr));
      if (this.prevThr - this.targetThrottle > 0.35 && this.boost > 0.35 && this.bovEnv < 0.05 && this.bovMode !== 2) {
        this.bovEnv = Math.min(1, this.boost * 1.2); this.bovF = 4200; this.fluttPh = 0;
        if (this.bovMode === 0) this.boost *= 0.4;
      }
    }
    this.prevThr = this.targetThrottle;
    if ((this.ctr++ & 31) === 0) this.updateFilters();

    // ---- crank: one cycle = 2 revs = 6 firings
    const inc = this.cycInc > 0 ? this.cycInc : rpm / 120 / sr;
    this.phase += inc; if (this.phase >= 1) this.phase -= 1;
    const slot = Math.floor(this.phase * 6);
    const interval = 1 / (inc * 6 * sr);
    if (slot !== this.slot) {
      this.slot = slot;
      const c = this.order[slot], lump = (0.55 + 0.65 * ch) * (0.55 + 0.45 * this.thump);
      const load = combust ? 0.25 + 0.75 * thr : 0.12; // no fuel = just compression chuff
      let amp = (1 + (this.cyl[c] - 1) * lump) * load * (1 + (this.rand() - 0.5) * (0.16 + 0.2 * idleness));
      // occasional weak burn at idle / light load = lope
      if (combust && thr < 0.3 && this.rand() < 0.04 * idleness) amp *= 0.55;
      const tau = Math.min(0.0042, interval * 0.62) * (0.85 + this.rand() * 0.3);
      const wait = Math.floor(this.rand() * interval * sr * (0.025 + 0.04 * idleness));
      this.pend.push({ wait, amp, tau, bank: c < 3 ? 0 : 1 });
      if (this.popsEnabled && ((combust && thr < 0.08 && rpm > 2300 && this.rand() < 0.035 * (rpm / 6000)) || (this.fuelCut && this.rand() < 0.07))) {
        this.popT = 0; this.popAmp = 0.8 + this.rand() * 1.6;
      }
    }
    for (let i = this.pend.length - 1; i >= 0; i--) {
      const p = this.pend[i];
      if (p.wait-- <= 0) {
        if (p.bank === 0) { this.ampA = p.amp; this.tauA = p.tau; this.envA = 0; this.riseA = 0; }
        else { this.ampB = p.amp; this.tauB = p.tau; this.envB = 0; this.riseB = 0; }
        this.pend.splice(i, 1);
      }
    }
    // blowdown pulse: fast rise (~0.3 ms) then exponential decay
    this.envA += 1 / sr; this.envB += 1 / sr;
    const pA = this.ampA * (1 - Math.exp(-this.envA / 0.0003)) * Math.exp(-this.envA / this.tauA);
    const pB = this.ampB * (1 - Math.exp(-this.envB / 0.0003)) * Math.exp(-this.envB / this.tauB);
    const nz = this.rand() * 2 - 1, nz2 = this.rand() * 2 - 1;
    const turb = 0.15 + 0.2 * ch * thr; // turbulence riding on each pulse
    let exA = pA * (1 + turb * nz), exB = pB * (1 + turb * nz2);
    this.popT += 1 / sr;
    if (this.popT < 0.03) { const pp = this.popAmp * Math.exp(-this.popT / 0.004) * (0.5 + nz); exA += pp; exB += pp * 0.6; }

    // ---- exhaust: banks -> collector -> tailpipe
    const a = this.pipeA.run(this.hdrA.run(exA));
    const b = this.pipeB.run(this.hdrB.run(exB));
    let x = this.tail.run(a + 0.88 * b);
    x = this.hp.run(x); x = this.half.run(x); x = this.o15.run(x); x = this.o6.run(x); x = this.fund.run(x); x = this.sub.run(x); x = this.body.run(x); x = this.rasp.run(x); x = this.lp.run(x);
    // asymmetric saturation: even harmonics + grit, harder on the RB side
    const drive = 1.0 + (0.9 + 1.1 * ch) * thr, bias = 0.06 + 0.06 * ch;
    let eng = (Math.tanh(drive * (x * 0.8 + bias)) - Math.tanh(drive * bias)) / Math.tanh(drive);
    // high rasp band, gated by the pulses (this is the "tearing paper" edge)
    eng += this.raspBp.run(nz) * (pA + pB) * (0.08 + 0.22 * ch) * (0.3 + thr) * (0.4 + rpm / 7000);
    // intake roar (RB26 ITBs bark more)
    eng += this.intakeBp.run(this.rand() * 2 - 1) * (0.04 + (0.12 + 0.18 * ch) * thr) * (0.3 + rpm / 7000);
    eng *= (0.6 + 0.4 * (rpm / 7000)) * Math.min(1, rpm / 500);

    // ---- turbo
    const bst = this.boost;
    const wf = 1500 + 400 * ch + bst * (6500 + 1500 * ch);
    this.whPh += wf / sr; if (this.whPh >= 1) this.whPh -= 1;
    const ph = this.whPh * 2 * Math.PI;
    let turbo = (Math.sin(ph) + 0.25 * Math.sin(2 * ph) + 0.08 * Math.sin(3 * ph)) * 0.10 * Math.pow(bst, 1.5);
    turbo += this.whooshBp.run(this.rand() * 2 - 1) * 0.45 * bst * (0.3 + 0.7 * thr);
    if (this.bovEnv > 0.0005) {
      let bv = this.bovBp.run(this.rand() * 2 - 1) * this.bovEnv;
      if (this.bovMode === 1) {
        this.fluttPh += (17 + 8 * this.bovEnv) / sr;
        bv *= (this.fluttPh % 1) < 0.35 ? 1.6 : 0.15;
        this.bovEnv *= Math.exp(-1 / (0.45 * sr)); this.boost *= Math.exp(-1 / (0.5 * sr));
      } else this.bovEnv *= Math.exp(-1 / (0.28 * sr));
      this.bovF += (1300 - this.bovF) * (1 / (0.2 * sr));
      turbo += bv * 1.3;
    }

    // ---- gear clunk: drivetrain thud + metallic tick
    let clunk = 0;
    if (this.clT < 0.25) {
      const t = this.clT;
      clunk = this.clAmp * (Math.sin(2 * Math.PI * this.clF * t) * Math.exp(-t / 0.035) * 0.7
            + this.clBp.run(this.rand() * 2 - 1) * Math.exp(-t / 0.01) * 1.2);
      this.clT += 1 / sr;
    }

    const out = this.outHp.run(eng * this.engineGain * 0.9 + turbo * this.turboGain + starter * this.engineGain + clunk);
    return Math.tanh(out * this.masterGain * 1.2);
  }
}
