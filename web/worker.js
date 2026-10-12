// Sim host: runs engine-sim (WASM) one 1/60 s frame at a time and streams the audio to the
// AudioWorklet over a MessagePort, keeping ~120 ms buffered. Also runs auto-start and the clutch.
// Loaded as a Worker from a Blob (es-loader.js is prepended), or on the main thread as a fallback.
(function (self) {
  const DT = 1 / 60, SR = 44100, TARGET = SR * 0.12;
  let es = null, x = null, port = null, produced = 0, consumed = 0, underruns = 0;
  let rtf = 1, lastPost = 0, busy = false;
  const ST = { thr: 0, thrTarget: 0, auto: false, autoT: 0, above: 0, crankThr: 0, shift: null, gears: 6, on: false, stopping: false };

  function post(m) { self.postMessage(m); }

  function stats() {
    const n = x.es_cyl_count(), fire = [], bank = [];
    for (let i = 0; i < n; i++) { fire.push(x.es_fire_deg(i)); bank.push(x.es_cyl_bank(i)); }
    return { cyl: n, liters: x.es_displacement_l(), redline: x.es_redline(), fire, bank };
  }

  function build(preset, params, restart) {
    try {
      es.create(preset, params);
      ST.crankThr = preset === 0 ? 0.03 : 0;
      ST.shift = null; ST.stopping = false; x.es_set_gear(-1); x.es_set_clutch(1);
      post({ type: 'built', stats: stats() });
      if (restart) startEngine(); else { ST.on = false; ST.auto = false; }
    } catch (e) { post({ type: 'error', message: String(e.message || e) }); }
  }

  function startEngine() {
    x.es_set_ignition(1); ST.stopping = false; ST.on = true;
    ST.auto = true; ST.autoT = 0; ST.above = 0;
  }
  function stopEngine() { ST.auto = false; x.es_set_starter(0); x.es_set_ignition(0); ST.stopping = true; ST.on = false; }

  function shift(dir) {
    if (ST.shift) return;
    const g = x.es_gear(), ng = Math.max(-1, Math.min(ST.gears - 1, g + dir));
    if (ng === g) return;
    ST.shift = { t: 0, to: ng, from: g, engaged: false, release: g === -1 ? 0.8 : 0.32 };
  }

  function tick() {
    // throttle: short ramp so the plate never steps
    ST.thr += (ST.thrTarget - ST.thr) * Math.min(1, DT / 0.035);
    let thr = ST.thr;
    if (ST.auto) {
      ST.autoT += DT; x.es_set_starter(1); thr = Math.max(thr, ST.crankThr);
      if (x.es_rpm() > 550) ST.above += DT; else ST.above = 0;
      if (ST.above > 0.25) { ST.auto = false; x.es_set_starter(0); post({ type: 'caught' }); }
      else if (ST.autoT > 6) { ST.auto = false; x.es_set_starter(0); ST.on = false; post({ type: 'nostart' }); }
    }
    if (ST.shift) {
      const s = ST.shift; s.t += DT;
      if (!s.engaged) {
        x.es_set_clutch(Math.max(0, 1 - s.t / 0.07));
        if (s.t >= 0.07) { x.es_set_gear(s.to); s.engaged = true; s.t = 0; }
      } else {
        const p = s.to === -1 ? 1 : Math.min(1, Math.pow(s.t / s.release, 1.6));
        x.es_set_clutch(p);
        if (p >= 1) ST.shift = null;
      }
    }
    x.es_set_throttle(thr);
  }

  function pump() {
    if (busy || !x || !port) return;
    busy = true;
    const t0 = performance.now(); let simT = 0;
    while (produced - consumed < TARGET && performance.now() - t0 < 40) {
      tick();
      const s = es.step(DT);
      simT += DT;
      if (s.length) { const c = new Float32Array(s), n = c.length; port.postMessage({ pcm: c }, [c.buffer]); produced += n; }   // count before the transfer detaches c
    }
    const wall = performance.now() - t0;
    if (simT > 0 && wall > 0) rtf = rtf * 0.85 + (simT * 1000 / wall) * 0.15;
    const now = performance.now();
    if (now - lastPost > 33) {
      lastPost = now;
      post({ type: 'state', t: now, rpm: x.es_rpm(), cyc: x.es_cycle_deg(), mph: x.es_speed_mph(), gear: x.es_gear(),
        map: x.es_manifold_pressure(), rtf, underruns, starting: ST.auto, on: ST.on, thr: ST.thr, shifting: !!ST.shift });
    }
    busy = false;
  }

  self.onmessage = async (e) => {
    const m = e.data;
    if (m.type === 'init') {
      es = await loadEngineSim(m.wasm, m.irs); x = es.x;
      post({ type: 'ready' });
    } else if (m.type === 'attach') {   // audio output arrives later, on the first tap
      port = m.port;
      port.onmessage = (ev) => { if (ev.data.consumed != null) { consumed = ev.data.consumed; underruns = ev.data.underruns; pump(); } };
      setInterval(pump, 8);
    } else if (!x) return;
    else if (m.type === 'defaults') {
      const out = {}; for (const k of m.keys) out[k] = es.get(m.preset, k);
      post({ type: 'defaults', preset: m.preset, values: out });
    }
    else if (m.type === 'build') build(m.preset, m.params, m.restart);
    else if (m.type === 'live') { const ok = es.live(m.key, m.value); if (!ok) post({ type: 'needsRebuild', key: m.key }); }
    else if (m.type === 'throttle') ST.thrTarget = m.value;
    else if (m.type === 'start') { if (ST.on || ST.auto) stopEngine(); else startEngine(); }
    else if (m.type === 'shift') shift(m.dir);
  };
})(typeof self !== 'undefined' ? self : this);
