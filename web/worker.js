// MOTORSYNC sim host: runs engine-sim (WASM) one 1/60 s frame at a time and streams the audio to the
// AudioWorklet over a MessagePort, keeping ~120 ms buffered. Also runs: auto-start, the automatic
// clutch (shifts, launch, anti-stall), brakes, forced induction (forced.js) and the dyno pull.
// Loaded as a Worker from a Blob (es-loader.js and forced.js are prepended), or on the main thread as a fallback.
(function (self) {
  const DT = 1 / 60, SR = 44100, TARGET = SR * 0.12, MAX_BRAKE_N = 12000;
  let es = null, x = null, port = null, produced = 0, consumed = 0, underruns = 0;
  let rtf = 1, lastPost = 0, busy = false;
  const fi = new self.MSForced.ForcedInduction(SR);
  const ST = {
    thr: 0, pedal: 0, brake: 0, auto: false, autoT: 0, above: 0, crankThr: 0, shift: null, gears: 6, on: false,
    idleTarget: 850, idleAdd: 0, clutch: 1, clutchOpen: false, launch: false, launchT: 0, redline: 6500, revLimit: 7000,
    dyno: null, dynoPts: [],
  };

  function post(m) { self.postMessage(m); }

  function stats() {
    const n = x.es_cyl_count(), fire = [], bank = [];
    for (let i = 0; i < n; i++) { fire.push(x.es_fire_deg(i)); bank.push(x.es_cyl_bank(i)); }
    return { cyl: n, liters: x.es_displacement_l(), redline: x.es_redline(), fire, bank };
  }

  function build(m) {
    try {
      es.create(m.preset, m.params || {});
      fi.configure(m.fi);
      ST.crankThr = 0.03; ST.redline = x.es_redline(); ST.idleAdd = 0; ST.idleTarget = m.idleRpm || 850;
      ST.revLimit = (m.params && m.params.revLimitRpm) || es.get(-1, 'revLimitRpm');
      ST.shift = null; ST.dyno = null; ST.clutchOpen = false; ST.launch = false;
      x.es_set_gear(-1); x.es_set_clutch(1); ST.clutch = 1;
      post({ type: 'built', stats: stats() });
      if (m.restart) startEngine(); else { ST.on = false; ST.auto = false; }
    } catch (e) { post({ type: 'error', message: String(e.message || e) }); }
  }

  function startEngine() { x.es_set_ignition(1); ST.on = true; ST.auto = true; ST.autoT = 0; ST.above = 0; }
  function stopEngine() { ST.auto = false; x.es_set_starter(0); x.es_set_ignition(0); ST.on = false; endDyno(false); }

  function shift(dir) {
    if (ST.shift || ST.dyno) return;
    const g = x.es_gear(), ng = Math.max(-1, Math.min(ST.gears - 1, g + dir));
    if (ng === g) return;
    ST.shift = { t: 0, to: ng, engaged: false, release: g === -1 ? 0.8 : 0.32 };
    ST.clutchOpen = false; ST.launch = false;
  }

  // ---- dyno: neutral, wide open, the dyno holds the crank and sweeps it from low rpm to the limiter
  function startDyno() {
    if (!ST.on || ST.auto) { post({ type: 'dynoMsg', text: 'Start the engine first.' }); return; }
    ST.shift = null; x.es_set_gear(-1); x.es_set_clutch(1);
    const from = Math.max(1500, Math.round(ST.redline * 0.2 / 100) * 100);
    const to = ST.revLimit - 150;
    ST.dyno = { phase: 'settle', t: 0, rpm: from, to, rate: Math.max(350, (to - from) / 10) };   // ~10 s pull
    ST.dynoPts = [];
    post({ type: 'dynoStart', from, to: ST.dyno.to });
  }
  function endDyno(finished) {
    if (!ST.dyno) return;
    ST.dyno = null; x.es_set_dyno(0, 0);
    post({ type: 'dynoDone', finished });
  }

  function tick() {
    const d = ST.dyno;
    let pedal = d ? 1 : ST.pedal;
    // throttle: short ramp so the plate never steps
    ST.thr += (pedal - ST.thr) * Math.min(1, DT / 0.035);
    let thr = ST.thr;
    const rpm = x.es_rpm();
    // idle air control: a little extra throttle holds idle near the target when you're off the gas
    if (ST.on && !ST.auto && !d && pedal < 0.05) {
      ST.idleAdd = Math.min(0.06, Math.max(0, ST.idleAdd + (ST.idleTarget - rpm) * 2e-6));
      thr = Math.max(thr, ST.idleAdd);
    } else if (!ST.on) ST.idleAdd = 0;
    if (ST.auto) {
      ST.autoT += DT; x.es_set_starter(1); thr = Math.max(thr, ST.crankThr);
      if (rpm > 500) ST.above += DT; else ST.above = 0;
      if (ST.above > 0.25) { ST.auto = false; x.es_set_starter(0); post({ type: 'caught' }); }
      else if (ST.autoT > 6) { ST.auto = false; x.es_set_starter(0); ST.on = false; post({ type: 'nostart' }); }
    }
    // stall: the engine stopped turning on its own
    if (ST.on && !ST.auto) { ST.stallT = rpm < 150 ? (ST.stallT || 0) + DT : 0; if (ST.stallT > 0.5) { stopEngine(); post({ type: 'stalled' }); } }
    // ---- clutch
    const gear = x.es_gear();
    if (ST.shift) {
      const s = ST.shift; s.t += DT;
      if (!s.engaged) {
        ST.clutch = Math.max(0, 1 - s.t / 0.07);
        if (s.t >= 0.07) {
          x.es_set_gear(s.to); s.engaged = true; s.t = 0;
          // stopped and off the gas: hold the clutch in, like a driver waiting at a light
          if (s.to >= 0 && x.es_speed_mph() < 2 && ST.pedal < 0.05) { ST.shift = null; ST.clutchOpen = true; ST.clutch = 0; }
        }
      } else {
        ST.clutch = s.to === -1 ? 1 : Math.min(1, Math.pow(s.t / s.release, 1.6));
        if (s.to >= 0 && rpm < 700 && ST.pedal < 0.15) { ST.shift = null; ST.clutchOpen = true; ST.clutch = 0; }
        else if (ST.clutch >= 1) ST.shift = null;
      }
    } else if (gear >= 0) {
      // automatic clutch: open below stall speed with no gas, slip it in on launch
      if (ST.clutchOpen) {
        ST.clutch = 0;
        if (ST.pedal > 0.05) { ST.clutchOpen = false; ST.launch = true; ST.launchT = 0; }
      } else if (ST.launch) {
        ST.launchT += DT;
        const slip = Math.min(1, Math.max(0.12, (rpm - 1100) / 1600));
        ST.clutch = Math.min(1, ST.launchT / 1.0) * slip;
        if (ST.launchT > 1.0 && slip >= 1) ST.launch = false;
        if (ST.pedal < 0.02 && rpm < 900) { ST.launch = false; ST.clutchOpen = true; }
      } else ST.clutch = 1;
      if (!ST.launch && !ST.clutchOpen && rpm < 650 && ST.pedal < 0.15) ST.clutchOpen = true;
    } else ST.clutch = 1;
    x.es_set_clutch(ST.clutch);
    x.es_set_brake(ST.brake * MAX_BRAKE_N);
    // ---- dyno sweep
    if (d) {
      d.t += DT;
      if (d.phase === 'settle') { if (d.t > 0.8) { d.phase = 'pull'; d.t = 0; } }
      else {
        d.rpm += d.rate * DT;
        ST.dynoPts.push([Math.round(rpm), +x.es_torque_lbft().toFixed(1), +fi.psi.toFixed(1)]);
        if (d.rpm >= d.to) endDyno(true);
      }
      if (ST.dyno) x.es_set_dyno(1, d.rpm);
    }
    // ---- forced induction: real boost pressure into the intake
    const psi = fi.frame(DT, rpm, pedal, thr, ST.on && !ST.auto, ST.redline);
    x.es_set_boost(psi);
    x.es_set_throttle(thr);
  }

  function pump() {
    if (busy || !x || !port) return;
    busy = true;
    const t0 = performance.now(); let simT = 0;
    while (produced - consumed < TARGET && performance.now() - t0 < 40) {
      tick();
      const phase0 = x.es_cycle_deg() / 720;
      const s = es.step(DT);
      simT += DT;
      if (s.length) {
        const c = new Float32Array(s), n = c.length;     // copy out of WASM memory
        fi.process(c, phase0);
        port.postMessage({ pcm: c }, [c.buffer]); produced += n;   // count before the transfer detaches c
      }
    }
    const wall = performance.now() - t0;
    if (simT > 0 && wall > 0) rtf = rtf * 0.85 + (simT * 1000 / wall) * 0.15;
    const now = performance.now();
    if (now - lastPost > 33) {
      lastPost = now;
      const pts = ST.dynoPts.length ? ST.dynoPts.splice(0) : null;
      post({ type: 'state', t: now, rpm: x.es_rpm(), cyc: x.es_cycle_deg(), mph: x.es_speed_mph(), gear: x.es_gear(),
        map: x.es_manifold_pressure(), psi: fi.psi, rtf, underruns, starting: ST.auto, on: ST.on, thr: ST.thr,
        shifting: !!ST.shift, clutch: ST.clutch, dyno: ST.dyno ? { rpm: ST.dyno.rpm, phase: ST.dyno.phase } : null, dynoPts: pts });
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
    else if (m.type === 'build') build(m);
    else if (m.type === 'live') { const ok = es.live(m.key, m.value); if (m.key === 'revLimitRpm') ST.revLimit = m.value; if (!ok) post({ type: 'needsRebuild', key: m.key }); }
    else if (m.type === 'fi') fi.configure(Object.assign({}, fi.cfg, m.fi));
    else if (m.type === 'throttle') ST.pedal = m.value;
    else if (m.type === 'brake') ST.brake = m.value;
    else if (m.type === 'start') { if (ST.on || ST.auto) stopEngine(); else startEngine(); }
    else if (m.type === 'shift') shift(m.dir);
    else if (m.type === 'dyno') { if (m.action === 'start') startDyno(); else endDyno(false); }
  };
})(typeof self !== 'undefined' ? self : this);
