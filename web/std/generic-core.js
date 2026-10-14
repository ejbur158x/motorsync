// MOTORSYNC Standard synth for any engine from the builder: N cylinders at their real firing angles,
// one or two exhaust pipes (split manifold / one per bank), the same pulse + waveguide + resonance
// recipe as our I6 Turbo and SLR V8 cores, with the forced-induction sound from forced.js.
// Needs Biquad, Pipe, Delay, Starter (from i6-core.js) and ForcedInduction (forced.js) in scope.
class GenericCore {
  constructor(sr, seed = 777) {
    this.sr = sr; this.r = seed >>> 0 || 1;
    this.targetRpm = 850; this.targetThrottle = 0;
    this.engineGain = 1; this.masterGain = 0.8; this.character = 0.4; this.thump = 0.6;
    this.thrAttack = 0.13; this.thrRelease = 0.21; this.rpmSlew = 18500;
    this.fuelCut = false; this._fc = false; this.running = true; this.popsEnabled = true; this.popAmount = 1;
    this.idleRpm = 850; this.redline = 7000;
    this.rpm = 850; this.throttle = 0; this.boost = 0; this.phase = 0; this.ctr = 0; this.prevPhase = 0;
    this.wob = 0; this.wobT = 0; this.wobGoal = 0; this.popCharge = 0; this.rpmRate = 0; this.lastRpm = 0; this.pops = [];
    this.fi = new ForcedInduction(sr);
    this.f = {}; for (const k of ['hp', 'half', 'oB', 'oB2', 'fund', 'sub', 'body', 'rasp', 'lp', 'outHp', 'raspBp', 'intakeBp', 'clBp', 'top']) this.f[k] = new Biquad();
    this.f.hp.set('hp', 16, 0.7, sr); this.f.outHp.set('hp', 20, 0.7, sr); this.f.clBp.set('bp', 700, 1.0, sr);
    this.startT = -1; this.clT = 1e9; this.clAmp = 0; this.clF = 90;
    this.blk = new Float32Array(128); this.blkN = 0; this.blkI = 128;
    this.configure({ n: 6, fire: [0, 480, 240, 600, 120, 360], pipe: [0, 0, 0, 1, 1, 1], nPipes: 2, liters: 3, layout: 'I' });
  }
  rand() { let x = this.r; x ^= x << 13; x ^= x >>> 17; x ^= x << 5; this.r = x >>> 0; return this.r / 4294967296; }

  // g: { n, fire[] (deg in the 720° cycle), pipe[] (0/1), nPipes, liters, layout, idleRpm, redline, character,
  //      thump, farGain, unequal, exLen (1 = normal), fi (forced.js config) }
  configure(g) {
    const sr = this.sr;
    this.g = g; this.n = g.n;
    this.fireF = g.fire.map((d) => (((d % 720) + 720) % 720) / 720);
    this.pipeOf = g.pipe.slice(); this.nPipes = g.nPipes || 1;
    if (g.idleRpm) this.idleRpm = g.idleRpm;
    if (g.redline) this.redline = g.redline;
    if (g.character != null) this.character = g.character;
    if (g.thump != null) this.thump = g.thump;
    const Vc = (g.liters || 3) / this.n;                       // liters per cylinder
    this.Vc = Vc;
    // per-cylinder imbalance: cylinder 1 strongest (the ½-order lope), the rest scattered a little
    this.cyl = Array.from({ length: this.n }, (_, i) => i === 0 ? 1.3 : 0.95 + 0.1 * (((i * 7919) % 13) / 13));
    const size = Math.min(1.6, Math.max(0.5, Math.pow(Vc / 0.5, 0.3)));     // bigger cylinders = longer, darker pulses
    const L = g.exLen || 1, unequal = g.unequal ? 1 : 0;
    this.hdr = [new Delay(sr, 0.9 * size * L), new Delay(sr, (1.1 + 0.25 * unequal) * size * L)];
    this.pipe = [new Pipe(sr, 1.85 * size * L, 0.3, 0.5), new Pipe(sr, (2.3 + 0.4 * unequal) * size * L, 0.3, 0.45)];
    this.tail = [new Pipe(sr, (this.nPipes === 2 && g.layout !== 'I' ? 6.2 : 4.8) * L, 0.26, 0.3), new Pipe(sr, 6.6 * L, 0.24, 0.27)];
    this.farB = new Delay(sr, g.layout === 'I' ? 0.2 : 3.5);
    this.farGain = g.farGain ?? (g.layout === 'I' ? 0.88 : 0.35);
    this.tauMax = 0.0035 + 0.0025 * Math.min(1, Vc / 0.7);
    this.env = [1, 1]; this.amp = [0, 0]; this.tau = [0.004, 0.004]; this.pend = [];
    // forced.js boosts the whine 1.3x for engine-sim's hotter output; undo that so it sits like our SLR core
    const fi = Object.assign({}, g.fi || { type: 'na' }); if (fi.scLevel != null) fi.scLevel /= 1.3; else fi.scLevel = 0.85 / 1.3;
    this.fi.configure(fi);
    this.lpB = 0;
  }
  ignite() { this.startT = 0; this.running = true; this.rpm = 0; this.phase = 0; this.prevPhase = 0;
    this.stProfile = { crankS: 0.6 + 0.1 * Math.min(6, this.n / 2), crankRpm: 165, comps: Math.max(1, this.n / 2), dip: 0.3, spinUpS: 0.1, flareS: 0.3,
      flareRpm: Math.min(2000, this.idleRpm * 1.9), settleS: 1.3,
      whineHz: 1400, whineWob: 0.09, spinBump: 0.06, spinLoud: 2, spinTau: 0.18, partials: [[1, 1], [0.5, 0.5], [2, 0.2]], whineAmp: 0.12, loadMod: 0.3,
      gearHz: 1300, gearAmp: 0.22, airHz: 2600, airAmp: 0.85, level: 0.12,
      rings: [[2400, 0.06, 1], [3600, 0.04, 0.6], [800, 0.08, 0.5]], excTau: 0.008, ringLevel: 0.008, spinDownS: 0.14, spinDownAmp: 0.15, overrun: 0.12 };
    this.starter = new Starter(this.sr, this.stProfile);
  }
  clunk(kind) { this.clT = 0; this.clAmp = kind < 0 ? 1.0 : 0.8; this.clF = kind < 0 ? 110 : 88; this.f.clBp.set('bp', kind < 0 ? 880 : 620, 1.0, this.sr); }

  updateFilters() {
    const sr = this.sr, rpm = this.rpm, t = this.throttle, ch = this.character, f = this.f, n = this.n;
    const k = rpm / this.redline, big = Math.min(1, Math.max(0, ((this.g.liters || 3) - 2) / 4));
    const load = Math.min(1, Math.max(0, (rpm - this.idleRpm) / 1400));
    f.half.set('pk', Math.max(12, rpm / 120), 1.2, sr, (4 + 6 * this.thump) * (0.6 + 0.4 * ch));     // ½ order: lope / thump
    f.fund.set('pk', Math.max(20, rpm * n / 120), 1.6, sr, 5);                                        // firing note
    if (this.nPipes === 2 && this.g.layout !== 'I') {   // two banks: one-bank orders n/4 ± ½ carry the burble (1.5 / 2.5 on a V8)
      f.oB.set('pk', Math.max(15, rpm * (n / 4 - 0.5) / 60), 1.6, sr, 2 * ch * load);
      f.oB2.set('pk', Math.max(15, rpm * (n / 4 + 0.5) / 60), 1.6, sr, (6 + 2 * ch) * load);
    } else if (this.nPipes === 2) {                      // split manifold inline (I6 style): order n/4 grows toward redline, 2× firing on top
      f.oB.set('pk', Math.max(15, rpm * (n / 4) / 60), 1.6, sr, -8 + 20 * Math.min(1, rpm / this.redline));
      f.oB2.set('pk', rpm * n / 60, 1.8, sr, 4);
    } else { f.oB.set('pk', rpm * n / 60, 1.8, sr, 3); f.oB2.set('pk', Math.max(15, rpm / 60), 1.4, sr, 2 * ch); }
    f.sub.set('pk', 55 + 25 * (1 - big) + 45 * k, 0.8, sr, 4 + 2 * big);
    f.body.set('pk', 150 + 60 * (1 - big) + 130 * k, 0.95, sr, 3 + 5 * big);
    f.rasp.set('pk', 1700 + 900 * k + 600 * ch, 1.3, sr, 0.5 + (1.5 + 2.5 * ch) * t);
    f.lp.set('lp', (750 + 400 * (1 - big)) + rpm * (0.6 + 0.15 * (1 - big)) + t * (1300 + 1400 * ch), 0.7, sr);
    f.raspBp.set('bp', 2300 + 1400 * k + 600 * ch + (this.rand() - 0.5) * 450, 1.1, sr);
    f.intakeBp.set('bp', 350 + rpm * (0.12 + 0.08 * ch), 0.85, sr);
    f.top.set('lp', 2800 + 2600 * (1 - big) + 1500 * ch, 0.6, sr);
  }

  // engine + starter + clunk for one sample, before the FI layer and the output stage
  _engine() {
    const sr = this.sr, ch = this.character, f = this.f, IDLE = this.idleRpm;
    let starter = 0, combust = this.running;
    if (this.startT >= 0) {
      const t = this.startT, S = this.stProfile;
      if (t === 0) this.starter.engage();
      this.startT += 1 / sr;
      if (t < S.crankS) {
        combust = false;
        const ld = Math.max(0, Math.sin(this.phase * 2 * Math.PI * S.comps)) ** 2, ramp = Math.min(1, t / S.spinUpS);
        this.rpm = ramp * S.crankRpm * (1 - S.dip * ld); this.targetRpm = this.rpm; this.throttle = 0; this.targetThrottle = 0;
        starter = this.starter.crank(t, ramp, ld);
      } else if (t < S.crankS + S.flareS) { this.targetRpm = S.flareRpm; this.targetThrottle = 0.45; starter = this.starter.spinDown(t - S.crankS); }
      else if (t < S.crankS + S.flareS + S.settleS) {
        this.targetRpm = S.flareRpm - (t - S.crankS - S.flareS) / S.settleS * (S.flareRpm - IDLE); this.targetThrottle = 0.15;
        starter = this.starter.spinDown(t - S.crankS);
      } else this.startT = -1;
    }
    if (this.fuelCut !== this._fc) { this._fc = this.fuelCut; this.throttle = this.fuelCut ? 0.05 : Math.max(this.throttle, this.targetThrottle * 0.9); }
    if (this.fuelCut) combust = false;
    if (!this.running && this.startT < 0) { this.targetRpm = 0; this.targetThrottle = 0; combust = false; }
    if ((this.wobT -= 1) <= 0) { this.wobT = sr * (0.08 + this.rand() * 0.12); this.wobGoal = this.rand() - 0.5; }
    this.wob += (this.wobGoal - this.wob) * 0.0004;
    if (this.startT < 0 || this.startT >= this.stProfile.crankS) { const lim = this.rpmSlew / sr; this.rpm += Math.max(-lim, Math.min(lim, (this.targetRpm - this.rpm) * 0.0025)); }
    if (!this.fuelCut) this.throttle += (this.targetThrottle - this.throttle) / ((this.targetThrottle > this.throttle ? this.thrAttack : this.thrRelease) * sr);
    const thr = this.throttle, idleness = Math.max(0, 1 - (this.rpm - IDLE) / 1500);
    const rpm = Math.max(0.5, this.rpm * (1 + this.wob * 0.014 * (0.4 + idleness)));
    if ((this.ctr++ & 31) === 0) {
      this.updateFilters();
      const dt = 32 / sr;
      this.rpmRate += ((this.rpm - this.lastRpm) / dt - this.rpmRate) * 0.25; this.lastRpm = this.rpm;
      if (thr > 0.5 && rpm > 2500) this.popCharge = Math.min(1, this.popCharge + dt / 0.8);
      else if (thr < 0.08) this.popCharge = Math.max(0, this.popCharge - dt / 3);
    }
    // ---- crank: fire each cylinder when the cycle passes its firing angle
    const inc = rpm / 120 / sr, p0 = this.phase;
    this.phase += inc; const wrap = this.phase >= 1; if (wrap) this.phase -= 1;
    const interval = 1 / (inc * this.n * sr);
    for (let c = 0; c < this.n; c++) {
      const ff = this.fireF[c];
      if (wrap ? (ff >= p0 || ff < this.phase) : (ff >= p0 && ff < this.phase)) {
        const lump = (0.55 + 0.6 * ch) * (0.55 + 0.45 * this.thump) * (1 + 0.5 * idleness);
        const load = combust ? 0.25 + 0.75 * thr : 0.11;
        let amp = (1 + (this.cyl[c] - 1) * lump) * load * (1 + (this.rand() - 0.5) * (0.15 + 0.2 * idleness));
        if (combust && thr < 0.3 && this.rand() < 0.045 * idleness) amp *= 0.58;
        const tau = Math.min(this.tauMax, interval * 0.62 * Math.max(1, this.nPipes)) * (0.85 + this.rand() * 0.3);
        const wait = Math.floor(this.rand() * interval * sr * (0.025 + 0.04 * idleness));
        this.pend.push({ wait, amp, tau, pipe: this.pipeOf[c] || 0 });
        if (this.popsEnabled) {
          const decel = Math.min(1, Math.max(0, (-this.rpmRate - 300) / 1500));
          const pLift = combust && thr < 0.08 ? 0.04 * this.popAmount * this.popCharge * (0.15 + 0.85 * decel) * Math.min(1, rpm / 4500) : 0;
          if (this.rand() < pLift + (this.fuelCut ? 0.01 * this.popAmount : 0)) this.pops.push({ wait: 0, t: 0, amp: 0.6 + this.rand() * 1.2, pipe: this.rand() < 0.6 ? 0 : 1 });
        }
      }
    }
    for (let i = this.pend.length - 1; i >= 0; i--) {
      const p = this.pend[i];
      if (p.wait-- <= 0) { this.amp[p.pipe] = p.amp; this.tau[p.pipe] = p.tau; this.env[p.pipe] = 0; this.pend.splice(i, 1); }
    }
    this.env[0] += 1 / sr; this.env[1] += 1 / sr;
    const pA = this.amp[0] * (1 - Math.exp(-this.env[0] / 0.00035)) * Math.exp(-this.env[0] / this.tau[0]);
    const pB = this.amp[1] * (1 - Math.exp(-this.env[1] / 0.00035)) * Math.exp(-this.env[1] / this.tau[1]);
    const nz = this.rand() * 2 - 1, nz2 = this.rand() * 2 - 1, turb = 0.13 + 0.2 * ch * thr;
    let exA = pA * (1 + turb * nz), exB = pB * (1 + turb * nz2);
    for (let i = this.pops.length - 1; i >= 0; i--) {
      const p = this.pops[i]; const v = p.amp * Math.exp(-p.t / 0.0035) * (0.5 + nz);
      if (p.pipe === 0) exA += v; else exB += v;
      p.t += 1 / sr; if (p.t > 0.03) this.pops.splice(i, 1);
    }
    // ---- exhaust
    let x;
    if (this.nPipes === 1) x = this.tail[0].run(this.pipe[0].run(this.hdr[0].run(exA + exB)));
    else if (this.g.layout === 'I') x = this.tail[0].run(this.pipe[0].run(this.hdr[0].run(exA)) + this.farGain * this.pipe[1].run(this.hdr[1].run(exB)));
    else {   // two banks, two pipes: you hear the near one most (that's where the burble comes from)
      const a = this.tail[0].run(this.pipe[0].run(this.hdr[0].run(exA)));
      const bDry = this.tail[1].run(this.pipe[1].run(this.hdr[1].run(exB)));
      this.lpB += 0.16 * (this.farB.run(bDry) - this.lpB);
      const idl = Math.max(0, 1 - (rpm - IDLE) / 1400);
      x = a + (this.farGain + (1 - this.farGain) * idl) * (this.lpB * 1.25 * (1 - idl * 0.8) + bDry * idl * 0.8);
    }
    x = f.hp.run(x); x = f.half.run(x); x = f.oB.run(x); x = f.oB2.run(x); x = f.fund.run(x); x = f.sub.run(x); x = f.body.run(x); x = f.rasp.run(x); x = f.lp.run(x);
    const drive = 1.0 + (0.85 + 1.15 * ch) * thr * (1 + 0.3 * this.boost), bias = 0.06 + 0.06 * ch;
    let eng = (Math.tanh(drive * (x * 0.8 + bias)) - Math.tanh(drive * bias)) / Math.tanh(drive);
    eng += f.raspBp.run(nz) * (pA + pB) * (0.07 + 0.2 * ch) * (0.3 + thr) * (0.4 + rpm / 7000);
    eng += f.intakeBp.run(this.rand() * 2 - 1) * (0.05 + (0.12 + 0.16 * ch) * thr) * (0.3 + rpm / 7000);
    eng = f.top.run(eng) * (0.6 + 0.4 * Math.min(1.2, rpm / 7000)) * Math.min(1, rpm / 450);
    let clunk = 0;
    if (this.clT < 0.25) {
      const t = this.clT;
      clunk = this.clAmp * (Math.sin(2 * Math.PI * this.clF * t) * Math.exp(-t / 0.035) * 0.7 + f.clBp.run(this.rand() * 2 - 1) * Math.exp(-t / 0.01) * 1.2);
      this.clT += 1 / sr;
    }
    return eng * this.engineGain * 0.9 + starter * this.engineGain + clunk;
  }

  // block processing so the forced-induction layer (forced.js) can run per block
  sample() {
    if (this.blkI >= 128) {
      const phase0 = this.phase, sr = this.sr;
      const fiOn = this.running && this.startT < 0;
      this.fi.frame(128 / sr, this.rpm, this.targetThrottle, this.fuelCut ? this.targetThrottle : this.throttle, fiOn, this.redline);   // limiter cuts fuel, not boost
      const c = this.fi.cfg, max = Math.max(c.turboPsi || 0, c.scPsi || 0, 1);
      this.boost = Math.min(1, this.fi.psi / max);
      for (let i = 0; i < 128; i++) this.blk[i] = this._engine();
      this.fi.process(this.blk, phase0);
      for (let i = 0; i < 128; i++) this.blk[i] = Math.tanh(this.f.outHp.run(this.blk[i]) * this.masterGain * 1.2);
      this.blkI = 0;
    }
    return this.blk[this.blkI++];
  }
}
