// MOTORSYNC Standard car model: the drivetrain from our original I6 Turbo / SLR demos (EJ's tuned timing),
// generalized so any engine from the builder gets a torque curve, gearbox and the same feel.
// Pure logic: step(dt) returns what the sound engine should hear ({ rpm, throttle, fuelCut, clunk }).
(function (root) {
  const V160 = [3.827, 2.36, 1.685, 1.312, 1.0, 0.793], AMG5 = [3.595, 2.186, 1.405, 1.0, 0.831];
  const DEFAULTS = {
    shiftUpMs: 140, shiftDownMs: 200, clutchMs: 90, rpmDrop: 300, rpmDropN: 3000, decayCurve: 1.8, decayFloor: 0.25,
    revUp: 1, slewMax: 18500, slewSmooth: 45, launchBite: 1.2, blip: 1, limit: 7200, limiterHz: 8, brake: 10500,
    thrAttackMs: 130, thrReleaseMs: 210,
  };
  // presets: our two original cars, and a generic one shaped from the build
  function carFor(kind, b) {
    if (kind === 'i6') return Object.assign({}, DEFAULTS, { idle: 850, mass: 1550, R: 0.33, ratios: V160, final: 3.266,
      torque: (r, x) => (290 + 230 * x) * Math.max(0.35, Math.sin(Math.PI * Math.min(1, r / 7000 * 0.95 + 0.08))) });
    if (kind === 'v8') return Object.assign({}, DEFAULTS, { idle: 600, limit: 6800, brake: 16000, mass: 1768, R: 0.34, ratios: AMG5, final: 2.82,
      torque: (r, x) => (430 + 350 * x) * Math.min(1, 0.45 + r / 4500) * (r > 5200 ? Math.max(0.55, 1 - (r - 5200) / 3500) : 1) });
    // generic: peak torque scales with size and boost; peaks at peakAt × limiter, sags 30% by the limiter
    const limit = b.redline, T0 = b.tqPerL * b.liters, psi = Math.max((b.fi && b.fi.turboPsi) || 0, (b.fi && b.fi.scPsi) || 0);
    const peak = b.peakAt * limit;
    const torque = (r, x) => T0 * (1 + 0.75 * (psi / 14.7) * x) * (r < peak ? Math.max(0.35, Math.sin(Math.PI / 2 * r / peak)) : 1 - 0.3 * (r - peak) / Math.max(500, limit - peak));
    return Object.assign({}, DEFAULTS, { idle: b.idleRpm, limit, revUp: b.revUp, mass: 1300 + 90 * b.liters, R: 0.33,
      ratios: V160, final: 3.266 * 7200 / limit, torque, tqScale: 268 / torque(peak, 0) * (limit / 7200) });
  }

  class StdCar {
    constructor(cfg) { this.set(cfg); this.reset(); }
    set(cfg) { this.c = Object.assign({}, cfg); }
    reset() {
      this.running = false; this.gear = 0; this.v = 0; this.freeRpm = this.c.idle; this.rpm = 0; this.rpmOut = 0; this.rpmVel = 0;
      this.lim = { cut: false, t: 0 }; this.thrSmooth = 0; this.shifting = null; this.engageT = 1; this.slip = false; this.slipT = 0;
      this.gas = 0; this.brake = 0; this.boost = 0;
    }
    wheelRpm(g) { return this.v / (2 * Math.PI * this.c.R) * 60 * (g ? this.c.ratios[g - 1] : 0) * this.c.final; }
    get gears() { return this.c.ratios.length; }
    shift(d) {
      if (!this.running || this.shifting) return null;
      const to = Math.max(0, Math.min(this.gears, this.gear + d)); if (to === this.gear) return null;
      this.shifting = { dir: d, to, t: 0, dur: (d > 0 ? this.c.shiftUpMs : this.c.shiftDownMs) / 1000 };
      return to;
    }
    // starting: the sound engine is still cranking (its rpm leads); engRpm = what it reports
    step(dt, starting, engRpm, boost) {
      const c = this.c, IDLE = c.idle; let clunk = 0;
      this.boost = boost || 0;
      if (!this.running) { this.rpm += (0 - this.rpm) * Math.min(1, dt * 4); return { rpm: this.rpm, throttle: 0, fuelCut: false, clunk }; }
      if (starting) { this.rpm = engRpm; this.freeRpm = Math.max(IDLE, engRpm); this.rpmOut = Math.max(IDLE, engRpm); this.rpmVel = 0; return { rpm: null, throttle: null, fuelCut: false, clunk }; }
      let thr = this.gas;
      let clutchIn = this.gear === 0;
      if (this.shifting) {
        const s = this.shifting; s.t += dt; clutchIn = true;
        const p = s.t / s.dur;
        if (s.dir > 0) thr = 0;
        else { const target = Math.min(c.limit - 200, this.wheelRpm(s.to) + 150); thr = p > 0.05 && p < 0.75 ? c.blip * Math.max(0, Math.min(1, (target - this.freeRpm) / 700)) : 0; }
        if (s.t >= s.dur) { this.gear = s.to; this.shifting = null; this.engageT = 0; if (this.gear) clunk = s.dir; }
      }
      const half = 1 / (2 * c.limiterHz), lim = this.lim;
      lim.t -= dt;
      if (lim.cut) { if (lim.t <= 0) { lim.cut = false; lim.t = half; } }
      else if (lim.t <= 0 && this.rpm >= c.limit) { lim.cut = true; lim.t = half; }
      const ramp = this.shifting ? 0.035 : (thr > this.thrSmooth ? c.thrAttackMs : c.thrReleaseMs) / 1000;
      this.thrSmooth += (thr - this.thrSmooth) * Math.min(1, dt / ramp);
      const drive = lim.cut ? 0 : this.thrSmooth;
      const brakeF = this.brake * c.brake, gear = this.gear, wr = gear ? this.wheelRpm(gear) : 0;
      const gasOn = this.gas > 0.05;
      if (!clutchIn && !this.slip && wr < (gasOn ? 1000 : IDLE - 100) && (gasOn || this.v > 0.3)) { this.slip = true; this.slipT = 0; }
      if (clutchIn) this.slip = false;
      const tqScale = c.tqScale || 1;   // generic engines rev like the original I6 (times their own revUp)
      if (clutchIn || this.slip) {
        const dropRate = gear === 0 ? c.rpmDropN : (this.shifting ? c.rpmDrop : c.rpmDropN);
        const x = Math.max(0, (this.freeRpm - IDLE) / (c.limit - 200 - IDLE));
        const fall = dropRate * (c.decayFloor + (1 - c.decayFloor) * Math.pow(x, c.decayCurve)) * (1 - drive);
        let pull = 0;
        if (this.slip) { this.slipT += dt; const k = 5 + 30 * Math.pow(Math.min(1, this.slipT / c.launchBite), 1.6); pull = k * (this.freeRpm - wr); }
        this.freeRpm += (c.torque(this.freeRpm, this.boost) * tqScale * drive * 58 * c.revUp - fall - pull - (this.freeRpm - IDLE) * 0.6 * drive) * dt;
        this.freeRpm = Math.max(IDLE, Math.min(c.limit + 120, this.freeRpm));
        if (this.slip && this.freeRpm - wr < 120 && wr > IDLE - 50) { this.slip = false; this.engageT = 1; this.freeRpm = wr; }
      }
      if (!clutchIn) {
        this.engageT = Math.min(1, this.engageT + dt / (c.clutchMs / 1000));
        const engR = this.slip ? this.freeRpm : wr;
        const tq = c.torque(engR, this.boost) * drive - (drive < 0.05 ? 45 : 0);
        const F = tq * c.ratios[gear - 1] * c.final / c.R * (this.slip ? 0.85 : 1) * this.engageT - 0.46 * this.v * this.v - (this.v > 0 ? 160 + brakeF : 0);
        this.v = Math.max(0, this.v + F / c.mass * dt);
        const wr2 = this.wheelRpm(gear);
        if (this.slip) this.rpm = Math.max(wr2, this.freeRpm);
        else { this.rpm = this.freeRpm + (wr2 - this.freeRpm) * this.engageT; if (this.engageT >= 1) this.freeRpm = this.rpm; }
        if (this.v < 0.3 && !gasOn) { this.rpm = this.freeRpm = Math.max(IDLE, this.freeRpm - c.rpmDropN * dt); this.slip = false; if (this.brake > 0.1 && gear > 1 && !this.shifting) this.gear = 1; }
      } else {
        this.rpm = this.freeRpm; this.v = Math.max(0, this.v - (0.46 * this.v * this.v + (this.v > 0 ? 160 + brakeF : 0)) / c.mass * dt);
      }
      this.rpm = Math.max(IDLE, Math.min(c.limit + 150, this.rpm));
      { const tau = Math.max(0.005, c.slewSmooth / 1000);
        const want = Math.max(-c.slewMax, Math.min(c.slewMax, (this.rpm - this.rpmOut) / tau));
        this.rpmVel += (want - this.rpmVel) * Math.min(1, dt / tau);
        this.rpmOut += this.rpmVel * dt; this.rpm = this.rpmOut; }
      return { rpm: this.rpm, throttle: thr > 0 ? thr : (this.rpm < IDLE + 150 ? 0.1 : 0), fuelCut: lim.cut, clunk };
    }
    get mph() { return this.v * 2.23694; }
  }
  const api = { StdCar, carFor, DEFAULTS };
  if (typeof module !== 'undefined') module.exports = api; else root.MSCar = api;
})(typeof self !== 'undefined' ? self : typeof globalThis !== 'undefined' ? globalThis : this);
