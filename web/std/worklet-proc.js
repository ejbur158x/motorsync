// MOTORSYNC Standard engine processor: runs one of our synth cores (I6 Turbo, SLR V8, or the generic
// builder synth) in the AudioWorklet. Messages: { use: 'i6'|'v8'|'gen', configure: {...} } swaps the core;
// any other key calls that method on the core (ignite, clunk, configure) or sets that property.
class MSStd extends AudioWorkletProcessor {
  constructor() {
    super(); this.c = null; this.kind = ''; this.n = 0; this.gain = 1; this.fade = 1;
    this.port.onmessage = (e) => {
      const m = e.data;
      if (m.use) {
        this.kind = m.use;
        const seed = (Math.random() * 1e9) | 0;
        this.c = m.use === 'i6' ? new I6Core(sampleRate, seed) : m.use === 'v8' ? new V8Core(sampleRate, seed) : new GenericCore(sampleRate, seed);
        this.c.running = false; this.c.targetRpm = 0; this.c.rpm = 0;
        if (m.use === 'gen' && m.configure) this.c.configure(m.configure);
      }
      if (!this.c) return;
      for (const k in m) {
        if (k === 'use' || (k === 'configure' && m.use)) continue;
        if (typeof this.c[k] === 'function') this.c[k](m[k]); else this.c[k] = m[k];
      }
    };
  }
  process(_, outputs) {
    const out = outputs[0], L = out[0], R = out[1] || null;
    if (!this.c) { L.fill(0); if (R) R.fill(0); return true; }
    for (let i = 0; i < L.length; i++) { const s = this.c.sample(); L[i] = s; if (R) R[i] = s; }
    if ((this.n += L.length) >= 512) {
      this.n = 0; const c = this.c;
      const psi = this.kind === 'i6' ? c.boost * 18 : this.kind === 'v8' ? c.boost * 13 : c.fi.psi;
      this.port.postMessage({ rpm: c.rpm, boost: c.boost, psi, throttle: c.throttle, starting: c.startT >= 0, running: c.running, phase: c.phase });
    }
    return true;
  }
}
registerProcessor('ms-std', MSStd);
