// Plays the PCM chunks the sim host sends. Re-primes (brief silence) instead of crackling when starved.
class EngineSimPlayer extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = new Float32Array(1 << 17); this.mask = this.buf.length - 1;
    this.r = 0; this.w = 0; this.consumed = 0; this.underruns = 0; this.primed = false; this.last = 0; this.since = 0;
    this.port.onmessage = (e) => {
      if (e.data.port) { this.sp = e.data.port; this.sp.onmessage = (ev) => ev.data.pcm && this.push(ev.data.pcm); }
    };
  }
  push(a) { for (let i = 0; i < a.length; i++) { this.buf[this.w] = a[i]; this.w = (this.w + 1) & this.mask; } }
  process(_in, outs) {
    const out = outs[0], o = out[0];
    let avail = (this.w - this.r) & this.mask;
    if (!this.primed && avail >= 2048) this.primed = true;
    for (let i = 0; i < o.length; i++) {
      if (this.primed && avail > 0) { this.last = this.buf[this.r]; this.r = (this.r + 1) & this.mask; avail--; this.consumed++; }
      else { if (this.primed) { this.primed = false; this.underruns++; } this.last *= 0.995; }
      o[i] = this.last;
    }
    for (let c = 1; c < out.length; c++) out[c].set(o);
    this.since += o.length;
    if (this.sp && this.since >= 512) { this.since = 0; this.sp.postMessage({ consumed: this.consumed, underruns: this.underruns }); }
    return true;
  }
}
registerProcessor('engine-sim-player', EngineSimPlayer);
