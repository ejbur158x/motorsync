// MOTORSYNC page logic. Two sound engines behind one UI:
//   Standard: our procedural synth cores in an AudioWorklet + the simple car model (std/car.js). Light, default.
//   Physics:  Ange Yaghi's engine-sim in a Web Worker (worker.js) — heavy, opt-in, behind a CPU warning.
const $ = (id) => document.getElementById(id);
const b64 = (s) => { const bin = atob(s); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u; };
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
$('lic').textContent = LICENSE;
const B = window.MSBuilder, CAR = window.MSCar;

// ---------------------------------------------------------------- engines
const IR_NAMES = ['Reverb pipe', 'Dry pipe', 'Muffled I', 'Muffled II', 'Muffled III', 'Smooth'];
const QUALITY = [
  { name: 'Lite', simFrequency: 5000, fluidSteps: 4 },
  { name: 'Normal', simFrequency: 7000, fluidSteps: 4 },
  { name: 'High', simFrequency: 10000, fluidSteps: 8 },
];
const CYL_NUM = { 0: [1, 2, 3, 4, 5, 6], 1: [1, 3, 5, 7, 2, 4, 6, 8] };
// Garage. base 0/1 = Ange's 2JZ / GM LS scripts (physics mode). std = which of our synth cores plays it in Standard mode.
const PRESETS = [
  { id: 'msI6T', name: 'MotorSync I6 Turbo', spec: '3.0L I6 · 18 psi', std: 'i6', base: 0, params: { revLimitRpm: 7200, timingScale: 0.85 },
    fi: { type: 'turbo', turboPsi: 18, spoolStart: 1700, spoolFull: 4300, spoolTime: 1.55, bov: 0, turboLevel: 1.6 },
    cfg: { layout: 'I', cyl: 6, liters: 3.0, aspiration: 'turbo', boostPsi: 18, character: 0.4 } },
  { id: 'slr', name: 'SLR Supercharged V8', spec: '5.4L V8 · twin-screw', std: 'v8', base: 1, params: { boreMm: 97, strokeMm: 92, revLimitRpm: 6500, redlineRpm: 6100, exLengthIn: 70, timingScale: 0.85 },
    fi: { type: 'sc', scPsi: 13, scType: 'screw', scLevel: 0.85, scEee: 2, scChop: 0.75, scOff: 0.07, scHalf: 0.75, scPitch: 1 },
    cfg: { layout: 'V', cyl: 8, liters: 5.4, aspiration: 'sc', boostPsi: 13, character: 0.3, crank: 'cross' } },
  { id: 'jz', name: '2JZ', spec: '3.0L I6 · NA · stock', base: 0, params: {}, fi: { type: 'na' }, cfg: { layout: 'I', cyl: 6, liters: 3.0, aspiration: 'na', character: 0.3, thump: 0.2, name: '2JZ' } },
  { id: 'ls', name: 'GM LS', spec: '5.3L V8 · NA · stock', base: 1, params: {}, fi: { type: 'na' }, cfg: { layout: 'V', cyl: 8, liters: 5.3, aspiration: 'na', character: 0.3, crank: 'cross', name: 'GM LS' } },
  { id: 'i7', name: 'Twin-charged I7', spec: '3.5L I7 · 20 psi', cfg: { layout: 'I', cyl: 7, liters: 3.5, aspiration: 'twin', boostPsi: 20, character: 0.6, name: 'Twin-charged I7' } },
  { id: 'f6', name: 'Flat-6 boxer', spec: '3.8L F6 · NA · race', cfg: { layout: 'F', cyl: 6, liters: 3.8, aspiration: 'na', character: 0.8, headers: 'unequal', name: 'Flat-6 boxer' } },
  { id: 'v12', name: 'V12', spec: '6.5L V12 · NA', cfg: { layout: 'V', cyl: 12, liters: 6.5, aspiration: 'na', character: 0.7, name: 'V12' } },
];
const SOUND_DEFAULTS = { 0: { exIr: 0, exAudioVolume: 0.2, jitter: 0.23, noise: 1 }, 1: { exIr: 5, exAudioVolume: 4, jitter: 0.6, noise: 1 }, 2: { exIr: 0, exAudioVolume: 0.25, jitter: 0.45, noise: 1 } };
// our original cores' sound settings and their tuned defaults (EJ's configs)
const STD_SOUND = {
  i6: { character: 0.5, thump: 1, engineGain: 1, turboGain: 1.6, bovMode: 0, popsEnabled: true },
  v8: { character: 1, engineGain: 1, scGain: 0.85, scPitch: 1, scEee: 2, scChop: 0.75, scHalf: 0.75, scOff: 0.07, popAmount: 2.15, popDuration: 4, popsEnabled: true },
  gen: { engineGain: 1, popAmount: 1, popsEnabled: true },
};

let S = { mode: 'std', physAck: false, cur: { kind: 'preset', id: 'msI6T' }, cfg: Object.assign({}, PRESETS[0].cfg),
  sound: {}, fiSound: {}, stdSound: {}, car: {}, quality: 1, volume: 0.8, mine: [], dynoPrev: null, dynoLast: null, bmode: 'simple' };
try { const s = JSON.parse(localStorage.getItem('motorsync_v2') || 'null'); if (s) S = Object.assign(S, s); } catch (e) {}
if (S.mode !== 'phys') S.mode = 'std';
if (S.mode === 'phys' && !S.physAck) S.mode = 'std';
const save = () => { try { localStorage.setItem('motorsync_v2', JSON.stringify(S)); } catch (e) {} };
const curPreset = () => (S.cur.kind === 'preset' ? PRESETS.find((x) => x.id === S.cur.id) : null);
const curCfg = () => { const p = curPreset(); return p ? p.cfg : (S.cur.cfg || S.cfg); };

// Physics engine description (worker.js)
function physEngine() {
  const p = curPreset(); let e;
  if (p && p.base !== undefined) e = { preset: p.base, params: Object.assign({}, p.params), fi: Object.assign({}, p.fi), name: p.name, cylNums: CYL_NUM[p.base], idleRpm: p.base === 1 ? 650 : 850 };
  else { const sp = B.buildSpec(curCfg()); e = { preset: 2, params: sp.params, fi: sp.fi, name: sp.name, cylNums: sp.cylNums, idleRpm: 850 }; }
  const q = QUALITY[S.quality] || QUALITY[1];
  const cyl = e.preset === 2 ? e.params.nCyl : (e.preset === 1 ? 8 : 6);
  Object.assign(e.params, { simFrequency: cyl > 8 && S.quality === 1 ? 5000 : q.simFrequency, fluidSteps: q.fluidSteps }, S.sound);
  Object.assign(e.fi, S.fiSound);
  return e;
}
// Standard engine description (our synth + car)
function stdEngine() {
  const p = curPreset();
  if (p && p.std === 'i6') return { core: 'i6', name: p.name, fiType: 'turbo', car: CAR.carFor('i6'),
    stats: { cyl: 6, liters: 3.0, fire: [0, 480, 240, 600, 120, 360], bank: [0, 0, 0, 0, 0, 0] }, cylNums: [1, 2, 3, 4, 5, 6] };
  if (p && p.std === 'v8') return { core: 'v8', name: p.name, fiType: 'sc', car: CAR.carFor('v8'),
    stats: { cyl: 8, liters: 5.4, fire: [0, 270, 450, 180, 90, 360, 540, 630], bank: [0, 0, 0, 0, 1, 1, 1, 1] }, cylNums: [1, 2, 3, 4, 5, 6, 7, 8] };
  const cfg = curCfg(), sp = B.buildSpec(cfg), g = B.stdSynth(sp, cfg);
  Object.assign(g.fi, S.fiSound);
  const stats = { cyl: sp.n, liters: sp.liters, fire: g.fire, bank: Array.from({ length: sp.n }, (_, i) => sp.params['cyl.' + i + '.bank']) };
  return { core: 'gen', name: sp.name, fiType: sp.fi.type, synth: g, car: CAR.carFor('gen', g), stats, cylNums: sp.cylNums };
}

// ---------------------------------------------------------------- shared audio
let ctx = null, master = null, out = null;
function audio() {
  if (ctx) return ctx;
  ctx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 44100, latencyHint: 'interactive' });
  master = ctx.createGain(); master.gain.value = S.volume;
  const limiter = ctx.createDynamicsCompressor();
  limiter.threshold.value = -6; limiter.knee.value = 4; limiter.ratio.value = 12; limiter.attack.value = 0.002; limiter.release.value = 0.12;
  master.connect(limiter).connect(ctx.destination);
  out = master;
  return ctx;
}
let state = null, stats = null, built = null;   // whatever the active backend reports

// ---------------------------------------------------------------- Standard backend
const Std = {
  node: null, ready: null, car: null, eng: null, ws: { rpm: 0, psi: 0, boost: 0, starting: false, phase: 0, t: 0 }, timer: null,
  async load() {
    if (this.ready) return this.ready;
    this.ready = (async () => {
      const c = audio(); const res = c.resume().catch(() => {});
      await c.audioWorklet.addModule(URL.createObjectURL(new Blob([STD_WORKLET_SRC], { type: 'text/javascript' })));
      await res;
      this.node = new AudioWorkletNode(c, 'ms-std', { numberOfInputs: 0, outputChannelCount: [2] });
      this.node.port.onmessage = (e) => { this.ws = e.data; this.ws.t = performance.now(); };
      this.node.connect(out);
    })();
    return this.ready;
  },
  build(restart) {
    const e = this.eng = stdEngine(); built = e; stats = e.stats;
    $('engName').textContent = e.name;
    if (!this.node) { onBuilt(); return; }
    const snd = Object.assign({}, STD_SOUND[e.core], S.stdSound[e.core] || {});
    this.node.port.postMessage(Object.assign({ use: e.core, configure: e.synth }, snd));
    this.car = new CAR.StdCar(Object.assign({}, e.car, S.car));
    onBuilt();
    if (restart) this.toggle();
  },
  toggle() {
    const car = this.car; if (!car) return;
    car.running = !car.running;
    if (car.running) { car.gear = 0; car.v = 0; this.node.port.postMessage({ ignite: 1 }); this.ws.starting = true; }
    else this.node.port.postMessage({ running: false });
    this.loop();
  },
  loop() {
    if (this.timer) return;
    let last = performance.now();
    this.timer = setInterval(() => {
      const now = performance.now(), dt = Math.min(0.05, (now - last) / 1000); last = now;
      const car = this.car; if (!car || S.mode !== 'std') return;
      car.gas = pedalVal('gas'); car.brake = pedalVal('brake');
      const o = car.step(dt, this.ws.starting, this.ws.rpm, this.ws.boost);
      if (o.rpm != null) this.node.port.postMessage({ targetRpm: Math.max(300, Math.min(12000, o.rpm)), targetThrottle: clamp(o.throttle, 0, 1), fuelCut: o.fuelCut });
      if (o.clunk) this.node.port.postMessage({ clunk: o.clunk });
      state = { rpm: this.ws.starting ? this.ws.rpm : (car.running ? car.rpm : this.ws.rpm), gear: car.gear - 1, mph: car.mph, psi: this.ws.psi || 0, map: 0,
        on: car.running && !this.ws.starting, starting: car.running && this.ws.starting, cyc: (this.ws.phase || 0) * 720, t: this.ws.t || now, rtf: 0, dyno: null };
    }, 16);
  },
  shift(d) { if (this.car && this.car.running && !this.ws.starting) this.car.shift(d); },
  sound(k, v) { if (!this.eng) return; (S.stdSound[this.eng.core] = S.stdSound[this.eng.core] || {})[k] = v; save(); this.node && this.node.port.postMessage({ [k]: v }); },
  fi(k, v) { S.fiSound[k] = v; save(); if (this.node && this.eng && this.eng.core === 'gen') this.node.port.postMessage({ configure: Object.assign({}, this.eng.synth, { fi: Object.assign({}, this.eng.synth.fi, S.fiSound) }) }); },
  carSet(k, v) { S.car[k] = v; save(); if (this.car) this.car.c[k] = v; },
  stop() { if (this.car && this.car.running) this.toggle(); if (this.node) this.node.port.postMessage({ running: false }); },
  suspend() { this.stop(); if (this.node) { try { this.node.disconnect(); } catch (e) {} } },
  resume() { if (this.node) this.node.connect(out); },
};

// ---------------------------------------------------------------- Physics backend (engine-sim)
const Phys = {
  host: null, hostReady: null, booting: null, node: null,
  startHost() {
    if (this.hostReady) return this.hostReady;
    this.hostReady = (async () => {
      const irs = {}; for (const [k, v] of Object.entries(IRS_B64)) irs[k] = b64(v);
      const wasm = b64(WASM_B64).buffer;
      const src = LOADER_SRC + '\n' + FORCED_SRC + '\n' + WORKER_SRC;
      try { this.host = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' }))); }
      catch (e) { this.host = mainThreadHost(src); }
      this.host.onmessage = onPhys;
      const ready = new Promise((res) => (onPhys.ready = res));
      this.host.postMessage({ type: 'init', wasm, irs }, [wasm]);
      await ready;
    })();
    return this.hostReady;
  },
  async load() {
    if (this.booting) return this.booting;
    this.booting = (async () => {
      const c = audio(); const res = c.resume().catch(() => {});
      await this.startHost(); await res;
      await c.audioWorklet.addModule(URL.createObjectURL(new Blob([WORKLET_SRC], { type: 'text/javascript' })));
      this.node = new AudioWorkletNode(c, 'engine-sim-player', { numberOfInputs: 0, outputChannelCount: [2] });
      this.node.connect(out);
      const ch = new MessageChannel();
      this.node.port.postMessage({ port: ch.port2 }, [ch.port2]);
      this.host.postMessage({ type: 'attach', port: ch.port1 }, [ch.port1]);
    })();
    return this.booting;
  },
  build(restart) {
    const e = built = physEngine();
    $('engName').textContent = e.name;
    if (!this.host || !this.node) { stats = null; onBuilt(); return; }
    this.host.postMessage({ type: 'build', preset: e.preset, params: e.params, fi: e.fi, restart, idleRpm: e.idleRpm });
  },
  toggle() { this.host && this.host.postMessage({ type: 'start' }); },
  shift(d) { this.host && this.host.postMessage({ type: 'shift', dir: d }); },
  live(k, v) { S.sound[k] = v; save(); this.host && stats && this.host.postMessage({ type: 'live', key: k, value: v }); },
  fi(k, v) { S.fiSound[k] = v; save(); this.host && this.host.postMessage({ type: 'fi', fi: { [k]: v } }); },
  stop() { if (state && (state.on || state.starting) && this.host) this.host.postMessage({ type: 'start' }); },
  suspend() { this.stop(); if (this.host) this.host.postMessage({ type: 'pause', value: true }); if (this.node) { try { this.node.disconnect(); } catch (e) {} } },
  resume() { if (this.host) this.host.postMessage({ type: 'pause', value: false }); if (this.node) this.node.connect(out); },
};
function mainThreadHost(src) {   // no Worker allowed: run the sim on this thread
  const h = { onmessage: null, postMessage: (m) => setTimeout(() => fake.onmessage && fake.onmessage({ data: m }), 0) };
  const fake = { postMessage: (m) => h.onmessage && h.onmessage({ data: m }), onmessage: null };
  new Function('self', src)(fake);
  return h;
}
function onPhys(e) {
  const m = e.data;
  if (S.mode !== 'phys' && m.type === 'state') return;
  if (m.type === 'ready') onPhys.ready();
  else if (m.type === 'built') { stats = m.stats; onBuilt(); }
  else if (m.type === 'state') { state = m; if (m.dynoPts) dynoAdd(m.dynoPts); }
  else if (m.type === 'nostart') toast('It didn’t catch. Tap Start to crank again.');
  else if (m.type === 'stalled') toast('Stalled. Tap Start.');
  else if (m.type === 'error') toast('Couldn’t build that engine: ' + m.message);
  else if (m.type === 'dynoStart') dynoBegin(m);
  else if (m.type === 'dynoDone') dynoEnd(m.finished);
  else if (m.type === 'dynoMsg') toast(m.text);
}

const backend = () => (S.mode === 'phys' ? Phys : Std);
function onBuilt() {
  if (stats) {
    const nums = (built && built.cylNums) || stats.fire.map((_, i) => i + 1);
    const order = stats.fire.map((f, i) => [((f % 720) + 720) % 720, nums[i]]).sort((a, b) => a[0] - b[0]).map((a) => a[1]).join('-');
    $('order').textContent = 'Firing order ' + order;
    $('roDisp').textContent = stats.liters.toFixed(1) + ' L';
  }
  const fiType = S.mode === 'phys' ? (built && built.fi ? built.fi.type : 'na') : (built ? built.fiType : 'na');
  $('roBoostK').textContent = fiType === 'na' ? (S.mode === 'phys' ? 'MAP inHg' : 'Boost') : 'Boost psi';
  renderSound(); renderGarage();
}
function rebuild(restart) { backend().build(restart); }
function toast(msg) { $('toast').textContent = msg; clearTimeout(toast.t); toast.t = setTimeout(() => ($('toast').textContent = ''), 4500); }

// ---------------------------------------------------------------- mode switch
function applyModeUI() {
  const phys = S.mode === 'phys';
  $('modeStd').setAttribute('aria-pressed', !phys); $('modePhys').setAttribute('aria-pressed', phys);
  $('physBanner').hidden = !phys; $('cpu').hidden = !phys;
  $('t-dyno').hidden = !phys;
  if (!phys && !$('p-dyno').hidden) showTab('drive');
}
async function setMode(m, force) {
  if (m === S.mode) { $('physWarn').hidden = true; return; }
  if (m === 'phys' && !force) { $('physWarn').hidden = false; $('physWarn').scrollIntoView({ block: 'nearest', behavior: 'smooth' }); return; }
  const wasRunning = state && (state.on || state.starting);
  backend().suspend();
  S.mode = m; if (m === 'phys') S.physAck = true; save();
  $('physWarn').hidden = true; state = null; stats = null; built = null;
  applyModeUI();
  if (ctx) {
    if (m === 'phys') toast('Loading the physics engine…');
    await backend().load(); backend().resume(); rebuild(!!wasRunning);
  } else rebuild(false);
  renderBuilder();
}
$('modeStd').onclick = () => setMode('std');
$('modePhys').onclick = () => setMode('phys');
$('pwGo').onclick = () => setMode('phys', true);
$('pwNo').onclick = () => { $('physWarn').hidden = true; };

// ---------------------------------------------------------------- drive controls
const pedals = { gas: 0, brake: 0 }, keys = { gas: 0, brake: 0 };
const pedalVal = (w) => Math.max(pedals[w], keys[w]);
function sendPedal(which) {
  const v = pedalVal(which), el = $(which);
  el.querySelector('.fill').style.height = (v * 100).toFixed(0) + '%';
  el.querySelector('.pct').textContent = Math.round(v * 100) + '%';
  el.setAttribute('aria-valuenow', Math.round(v * 100));
  if (S.mode === 'phys' && Phys.host) Phys.host.postMessage({ type: which === 'gas' ? 'throttle' : 'brake', value: v });
}
for (const which of ['gas', 'brake']) {
  const el = $(which); let id = null;
  const set = (ev) => { const r = el.getBoundingClientRect(); pedals[which] = clamp(1 - (ev.clientY - r.top - 8) / (r.height - 16), 0, 1); sendPedal(which); };
  el.addEventListener('pointerdown', (ev) => { id = ev.pointerId; el.setPointerCapture(id); set(ev); ev.preventDefault(); });
  el.addEventListener('pointermove', (ev) => { if (ev.pointerId === id) set(ev); });
  const up = (ev) => { if (ev.pointerId === id) { id = null; pedals[which] = 0; sendPedal(which); } };
  el.addEventListener('pointerup', up); el.addEventListener('pointercancel', up);
}
let loading = false;
async function startPressed() {
  if (loading) return;
  const be = backend();
  if (!be.node) { loading = true; $('status').textContent = 'Loading'; try { await be.load(); } finally { loading = false; } rebuild(true); return; }
  if (ctx.state !== 'running') ctx.resume();
  be.toggle();
}
$('startBtn').addEventListener('click', startPressed);
const shift = (dir) => backend().shift(dir);
$('up').addEventListener('pointerdown', (ev) => { ev.preventDefault(); shift(1); });
$('down').addEventListener('pointerdown', (ev) => { ev.preventDefault(); shift(-1); });
document.addEventListener('keydown', (ev) => {
  if (ev.target.closest && ev.target.closest('input,select,textarea')) return;
  if (ev.repeat) return;
  const k = ev.key.toLowerCase();
  if (k === 'w' || k === 'arrowup') { keys.gas = 1; sendPedal('gas'); ev.preventDefault(); }
  else if (k === 's' || k === 'arrowdown') { keys.brake = 1; sendPedal('brake'); ev.preventDefault(); }
  else if (k === ' ') { startPressed(); ev.preventDefault(); }
  else if (k === 'e' || k === 'arrowright') shift(1);
  else if (k === 'q' || k === 'arrowleft') shift(-1);
});
document.addEventListener('keyup', (ev) => {
  const k = ev.key.toLowerCase();
  if (k === 'w' || k === 'arrowup') { keys.gas = 0; sendPedal('gas'); }
  if (k === 's' || k === 'arrowdown') { keys.brake = 0; sendPedal('brake'); }
});

// ---------------------------------------------------------------- tabs
const TABS = ['drive', 'dyno', 'build', 'sync'];
function showTab(t) {
  if (t === 'dyno' && S.mode !== 'phys') t = 'drive';
  for (const x of TABS) { $('t-' + x).setAttribute('aria-selected', x === t); $('p-' + x).hidden = x !== t; }
  try { localStorage.setItem('motorsync_tab', t); } catch (e) {}
}
for (const t of TABS) $('t-' + t).addEventListener('click', () => showTab(t));

// ---------------------------------------------------------------- form helpers
function slider(parent, o) {   // o: {id,label,min,max,step,value,fmt,log,onInput,changed}
  const row = document.createElement('div'); row.className = 'row';
  const lab = document.createElement('label'); lab.htmlFor = o.id; lab.textContent = o.label;
  const val = document.createElement('span'); val.className = 'val' + (o.changed ? ' changed' : '');
  const inp = document.createElement('input'); inp.type = 'range'; inp.id = o.id;
  const toPos = (v) => o.log ? Math.log(v / o.min) / Math.log(o.max / o.min) : v, fromPos = (p) => o.log ? o.min * Math.pow(o.max / o.min, p) : p;
  if (o.log) { inp.min = 0; inp.max = 1; inp.step = 0.001; } else { inp.min = o.min; inp.max = o.max; inp.step = o.step; }
  inp.value = toPos(o.value); val.textContent = o.fmt(o.value);
  inp.addEventListener('input', () => { const v = fromPos(+inp.value); val.textContent = o.fmt(v); val.classList.add('changed'); o.onInput(v); });
  row.append(lab, val, inp); parent.appendChild(row); return row;
}
function chips(parent, o) {   // o: {label, options:[{v,t,s}], value, onPick}
  const row = document.createElement('div'); row.className = 'row';
  const lab = document.createElement('span'); lab.className = 'lab'; lab.textContent = o.label;
  const box = document.createElement('div'); box.className = 'chips'; box.setAttribute('role', 'group'); box.setAttribute('aria-label', o.label);
  for (const opt of o.options) {
    const b = document.createElement('button'); b.className = 'chip'; b.type = 'button';
    b.setAttribute('aria-pressed', String(opt.v === o.value));
    b.innerHTML = opt.t + (opt.s ? `<small>${opt.s}</small>` : '');
    b.addEventListener('click', () => { for (const c of box.children) c.setAttribute('aria-pressed', String(c === b)); o.onPick(opt.v); });
    box.appendChild(b);
  }
  row.append(lab, document.createElement('span'), box); parent.appendChild(row); return row;
}
function advGroup(parent, title, open) {
  const d = document.createElement('details'); d.className = 'adv'; d.open = !!open;
  const s = document.createElement('summary'); s.textContent = title;
  const rows = document.createElement('div'); rows.className = 'rows';
  d.append(s, rows); parent.appendChild(d); return rows;
}
const x2 = (v) => v.toFixed(2) + '×', f2 = (v) => v.toFixed(2), pct = (v) => Math.round(v * 100) + '%';

// ---------------------------------------------------------------- sound card (live)
function renderSound() {
  const el = $('rowsSound'); el.textContent = '';
  slider(el, { id: 'sVol', label: 'Volume', min: 0, max: 1.5, step: 0.01, value: S.volume, fmt: pct, onInput: (v) => { S.volume = v; save(); if (master) master.gain.value = v; } });
  if (S.mode === 'phys') return renderPhysSound(el);
  const e = Std.eng || stdEngine(), core = e.core, cur = Object.assign({}, STD_SOUND[core], S.stdSound[core] || {});
  const set = (k) => (v) => Std.sound(k, v);
  if (core === 'i6') {
    slider(el, { id: 'sCh', label: 'Character (2JZ ↔ RB26)', min: 0, max: 1, step: 0.05, value: cur.character, fmt: f2, onInput: set('character') });
    slider(el, { id: 'sTh', label: '½-order thump (0.2 ≈ stock 2JZ)', min: 0, max: 1.5, step: 0.05, value: cur.thump, fmt: f2, onInput: set('thump') });
    slider(el, { id: 'sEng', label: 'Engine level', min: 0, max: 1.5, step: 0.05, value: cur.engineGain, fmt: f2, onInput: set('engineGain') });
    slider(el, { id: 'sTur', label: 'Turbo level', min: 0, max: 2, step: 0.05, value: cur.turboGain, fmt: f2, onInput: set('turboGain') });
    chips(el, { label: 'On lift', value: cur.bovMode, options: [{ v: 0, t: 'Blow-off' }, { v: 1, t: 'Flutter' }, { v: 2, t: 'None' }], onPick: set('bovMode') });
  } else if (core === 'v8') {
    slider(el, { id: 'sCh', label: 'Character (SLR ↔ AMG brute)', min: 0, max: 1, step: 0.05, value: cur.character, fmt: f2, onInput: set('character') });
    slider(el, { id: 'sEng', label: 'Engine level', min: 0, max: 1.5, step: 0.05, value: cur.engineGain, fmt: f2, onInput: set('engineGain') });
    slider(el, { id: 'sSc', label: 'Supercharger level', min: 0, max: 3, step: 0.05, value: cur.scGain, fmt: f2, onInput: set('scGain') });
    slider(el, { id: 'sPi', label: 'Whine pitch', min: 0.6, max: 1.6, step: 0.05, value: cur.scPitch, fmt: x2, onInput: set('scPitch') });
    slider(el, { id: 'sEe', label: 'Whine "eee"', min: 0, max: 3, step: 0.05, value: cur.scEee, fmt: f2, onInput: set('scEee') });
    slider(el, { id: 'sCp', label: 'Engine chop on whine', min: 0, max: 1, step: 0.05, value: cur.scChop, fmt: f2, onInput: set('scChop') });
    slider(el, { id: 'sHf', label: '½-order lope on whine', min: 0, max: 1, step: 0.05, value: cur.scHalf, fmt: f2, onInput: set('scHalf') });
    slider(el, { id: 'sOf', label: 'Whine off-throttle', min: 0, max: 0.5, step: 0.01, value: cur.scOff, fmt: pct, onInput: set('scOff') });
    slider(el, { id: 'sPa', label: 'Overrun crackle', min: 0, max: 3, step: 0.05, value: cur.popAmount, fmt: f2, onInput: set('popAmount') });
    slider(el, { id: 'sPd', label: 'Crackle duration', min: 0.5, max: 8, step: 0.25, value: cur.popDuration, fmt: (v) => v.toFixed(1) + ' s', onInput: set('popDuration') });
  } else {
    const g = e.synth;
    slider(el, { id: 'sCh', label: 'Character (smooth ↔ mean)', min: 0, max: 1, step: 0.05, value: S.stdSound.gen?.character ?? g.character, fmt: f2, onInput: set('character') });
    slider(el, { id: 'sTh', label: '½-order thump / lope', min: 0, max: 1.5, step: 0.05, value: S.stdSound.gen?.thump ?? g.thump, fmt: f2, onInput: set('thump') });
    slider(el, { id: 'sEng', label: 'Engine level', min: 0, max: 1.5, step: 0.05, value: cur.engineGain, fmt: f2, onInput: set('engineGain') });
    slider(el, { id: 'sPa', label: 'Overrun crackle', min: 0, max: 3, step: 0.05, value: cur.popAmount, fmt: f2, onInput: set('popAmount') });
    fiSoundRows(el, g.fi, (k, v) => Std.fi(k, v));
  }
}
function fiSoundRows(el, fi, setFi) {
  if (fi.type === 'turbo' || fi.type === 'twin') {
    slider(el, { id: 'sTurbo', label: 'Turbo sound', min: 0, max: 3, step: 0.05, value: S.fiSound.turboLevel ?? fi.turboLevel ?? 1.6, fmt: x2, onInput: (v) => setFi('turboLevel', v) });
    chips(el, { label: 'On lift', value: S.fiSound.bov ?? fi.bov ?? 0, options: [{ v: 0, t: 'Blow-off' }, { v: 1, t: 'Flutter' }, { v: 2, t: 'None' }], onPick: (v) => setFi('bov', v) });
  }
  if (fi.type === 'sc' || fi.type === 'twin') {
    slider(el, { id: 'sWhine', label: 'Blower whine', min: 0, max: 3, step: 0.05, value: S.fiSound.scLevel ?? fi.scLevel ?? 0.85, fmt: x2, onInput: (v) => setFi('scLevel', v) });
    slider(el, { id: 'sOff', label: 'Whine off-throttle', min: 0, max: 0.5, step: 0.01, value: S.fiSound.scOff ?? fi.scOff ?? 0.07, fmt: pct, onInput: (v) => setFi('scOff', v) });
  }
}
function renderPhysSound(el) {
  const e = (built && built.params) ? built : physEngine(), base = SOUND_DEFAULTS[e.preset];
  const get = (k) => (k in S.sound ? S.sound[k] : base[k]);
  const irRow = document.createElement('div'); irRow.className = 'row';
  irRow.innerHTML = '<label for="sIr">Exhaust tone</label><span></span>';
  const sel = document.createElement('select'); sel.id = 'sIr';
  IR_NAMES.forEach((n, i) => { const o = document.createElement('option'); o.value = i; o.textContent = n; sel.appendChild(o); });
  sel.value = String(get('exIr')); sel.addEventListener('input', () => Phys.live('exIr', +sel.value));
  irRow.appendChild(sel); el.appendChild(irRow);
  slider(el, { id: 'sExVol', label: 'Exhaust level', min: 0.02, max: 10, log: true, value: get('exAudioVolume'), fmt: x2, changed: 'exAudioVolume' in S.sound, onInput: (v) => Phys.live('exAudioVolume', v) });
  slider(el, { id: 'sJit', label: 'Roughness', min: 0, max: 1.5, step: 0.01, value: get('jitter'), fmt: f2, changed: 'jitter' in S.sound, onInput: (v) => Phys.live('jitter', v) });
  fiSoundRows(el, e.fi, (k, v) => Phys.fi(k, v));
  slider(el, { id: 'sLim', label: 'Rev limiter', min: 3000, max: 12000, step: 100, value: S.sound.revLimitRpm ?? e.params.revLimitRpm ?? (e.preset === 1 ? 6800 : 7500), fmt: (v) => v.toFixed(0) + ' rpm', changed: 'revLimitRpm' in S.sound, onInput: (v) => Phys.live('revLimitRpm', v) });
}

// ---------------------------------------------------------------- garage
function renderGarage() {
  const el = $('garage'); el.textContent = '';
  const all = PRESETS.map((p) => ({ id: p.id, name: p.name, spec: p.spec, kind: 'preset' }))
    .concat(S.mine.map((m, i) => ({ id: 'mine' + i, name: m.name || 'My build', spec: B.buildSpec(m).name, kind: 'mine', idx: i })));
  for (const c of all) {
    const b = document.createElement('div'); b.className = 'car'; b.setAttribute('role', 'button'); b.tabIndex = 0;
    const active = (c.kind === 'preset' && S.cur.kind === 'preset' && S.cur.id === c.id) || (c.kind === 'mine' && S.cur.kind === 'custom' && S.cur.mine === c.idx);
    if (active) b.classList.add('active');
    b.innerHTML = '<b></b><span></span>'; b.querySelector('b').textContent = c.name; b.querySelector('span').textContent = c.spec;
    if (c.kind === 'mine') { const x = document.createElement('button'); x.className = 'x'; x.textContent = 'Delete'; x.addEventListener('click', (ev) => { ev.stopPropagation(); S.mine.splice(c.idx, 1); save(); renderGarage(); }); b.appendChild(x); }
    const pick = () => {
      if (c.kind === 'preset') { S.cur = { kind: 'preset', id: c.id }; S.cfg = Object.assign({}, PRESETS.find((x) => x.id === c.id).cfg); }
      else { S.cfg = Object.assign({}, S.mine[c.idx]); S.cur = { kind: 'custom', cfg: S.cfg, mine: c.idx }; }
      S.sound = {}; S.fiSound = {}; delete S.stdSound.gen; save(); renderBuilder(); dropIn();
    };
    b.addEventListener('click', pick); b.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); pick(); } });
    el.appendChild(b);
  }
}
function dropIn() {
  const running = state && (state.on || state.starting);
  if (S.mode === 'std') Std.stop();
  rebuild(!!running && !!backend().node);
  renderGarage();
  toast(running ? 'New engine in. Cranking…' : 'Engine ready. Tap Start.');
}

// ---------------------------------------------------------------- builder
const ASP = [{ v: 'na', t: 'NA' }, { v: 'turbo', t: 'Turbo' }, { v: 'sc', t: 'Super' }, { v: 'twin', t: 'Twin', s: 'turbo + super' }];
function setCfg(k, v, rerender) { S.cfg[k] = v; save(); if (rerender) renderBuilder(); else updateSummary(); }
function renderBuilder() {
  const el = $('rowsBuild'); el.textContent = '';
  const c = S.cfg, L = B.LAYOUTS[c.layout] || B.LAYOUTS.I;
  $('mSimple').setAttribute('aria-pressed', S.bmode === 'simple'); $('mAdv').setAttribute('aria-pressed', S.bmode === 'adv');
  chips(el, { label: 'Layout', value: c.layout, options: [{ v: 'I', t: 'I', s: 'inline' }, { v: 'V', t: 'V', s: 'two banks' }, { v: 'VR', t: 'VR', s: 'narrow V' }, { v: 'F', t: 'Flat', s: 'boxer' }],
    onPick: (v) => { const LL = B.LAYOUTS[v]; let n = clamp(c.cyl, LL.min, LL.max); if (LL.step === 2 && n % 2) n++; S.cfg.layout = v; S.cfg.cyl = n; delete S.cfg.vAngle; delete S.cfg.crank; save(); renderBuilder(); } });
  const row = document.createElement('div'); row.className = 'row';
  row.innerHTML = '<span class="lab">Cylinders</span><span class="val"></span>';
  const st = document.createElement('div'); st.className = 'stepper';
  const minus = document.createElement('button'); minus.textContent = '−'; minus.setAttribute('aria-label', 'Fewer cylinders');
  const outp = document.createElement('output'); outp.textContent = c.cyl;
  const plus = document.createElement('button'); plus.textContent = '+'; plus.setAttribute('aria-label', 'More cylinders');
  const step = (d) => { const n = clamp(c.cyl + d * L.step, L.min, L.max); if (n !== c.cyl) { S.cfg.cyl = n; delete S.cfg.vAngle; delete S.cfg.crank; save(); renderBuilder(); } };
  minus.onclick = () => step(-1); plus.onclick = () => step(1);
  st.append(minus, outp, plus); row.appendChild(st); el.appendChild(row);
  slider(el, { id: 'bLiters', label: 'Displacement', min: 0.3, max: 10, step: 0.1, value: c.liters, fmt: (v) => v.toFixed(1) + ' L', onInput: (v) => setCfg('liters', +v.toFixed(1)) });
  chips(el, { label: 'Aspiration', value: c.aspiration || 'na', options: ASP, onPick: (v) => setCfg('aspiration', v, true) });
  if ((c.aspiration || 'na') !== 'na')
    slider(el, { id: 'bBoost', label: 'Boost', min: 3, max: 40, step: 0.5, value: c.boostPsi ?? (c.aspiration === 'twin' ? 20 : c.aspiration === 'sc' ? 10 : 15), fmt: (v) => v.toFixed(1) + ' psi', onInput: (v) => setCfg('boostPsi', v) });
  slider(el, { id: 'bChar', label: 'Street ↔ Race', min: 0, max: 1, step: 0.01, value: c.character ?? 0.3, fmt: (v) => v < 0.25 ? 'Street' : v < 0.6 ? 'Sport' : v < 0.85 ? 'Track' : 'Race', onInput: (v) => setCfg('character', v) });
  const cranks = B.crankOptions(c.layout, c.cyl);
  if (cranks.length > 1) chips(el, { label: 'Crank', value: cranks.includes(c.crank) ? c.crank : cranks[0],
    options: cranks.map((k) => ({ v: k, t: { cross: 'Cross-plane', flat: 'Flat-plane', even: 'Even fire' }[k], s: { cross: 'muscle burble', flat: 'exotic scream', even: 'smooth' }[k] })), onPick: (v) => setCfg('crank', v) });
  const nm = document.createElement('div'); nm.className = 'row';
  nm.innerHTML = '<label for="bName">Name</label><span></span>';
  const ni = document.createElement('input'); ni.type = 'text'; ni.id = 'bName'; ni.placeholder = 'Auto'; ni.value = c.name || ''; ni.maxLength = 40;
  ni.addEventListener('input', () => setCfg('name', ni.value.trim() || undefined));
  nm.appendChild(ni); el.appendChild(nm);
  if (S.bmode === 'adv') renderAdvanced(el);
  updateSummary();
}
function renderAdvanced(el) {
  const c = S.cfg, sp = B.buildSpec(c), p = sp.params, asp = c.aspiration || 'na';
  const opt = (k, v) => { if (v === undefined) delete S.cfg[k]; else S.cfg[k] = v; save(); updateSummary(); };
  const geo = advGroup(el, 'Geometry', true);
  slider(geo, { id: 'aBore', label: 'Bore', min: 50, max: 130, step: 0.5, value: c.boreMm ?? p.boreMm, changed: 'boreMm' in c, fmt: (v) => v.toFixed(1) + ' mm', onInput: (v) => opt('boreMm', v) });
  slider(geo, { id: 'aStroke', label: 'Stroke', min: 40, max: 130, step: 0.5, value: c.strokeMm ?? p.strokeMm, changed: 'strokeMm' in c, fmt: (v) => v.toFixed(1) + ' mm', onInput: (v) => opt('strokeMm', v) });
  if (c.layout === 'V') slider(geo, { id: 'aVang', label: 'V angle', min: 15, max: 150, step: 1, value: sp.vAngle, changed: 'vAngle' in c, fmt: (v) => v.toFixed(0) + '°', onInput: (v) => opt('vAngle', v) });
  slider(geo, { id: 'aCr', label: 'Compression', min: 7, max: 14, step: 0.1, value: c.compression ?? (asp !== 'na' ? 9 : 10.2 + (c.character ?? 0.3)), changed: 'compression' in c, fmt: (v) => v.toFixed(1) + ':1', onInput: (v) => opt('compression', v) });
  slider(geo, { id: 'aFly', label: 'Flywheel (lighter revs faster)', min: 1, max: 30, step: 0.5, value: p.flywheelMassKg, changed: 'flywheelMassKg' in c, fmt: (v) => v.toFixed(1) + ' kg', onInput: (v) => opt('flywheelMassKg', v) });
  const cam = advGroup(el, 'Cams');
  slider(cam, { id: 'aDur', label: 'Duration @ 0.050″', min: 180, max: 310, step: 1, value: p.intakeDuration, changed: 'duration' in c, fmt: (v) => v.toFixed(0) + '°', onInput: (v) => opt('duration', v) });
  slider(cam, { id: 'aLift', label: 'Valve lift', min: 5, max: 18, step: 0.1, value: p.intakeLiftMm, changed: 'liftMm' in c, fmt: (v) => v.toFixed(1) + ' mm', onInput: (v) => opt('liftMm', v) });
  slider(cam, { id: 'aLsa', label: 'Lobe separation (lower = lumpier)', min: 100, max: 124, step: 0.5, value: p.intakeLobeCenter, changed: 'lsa' in c, fmt: (v) => v.toFixed(1) + '°', onInput: (v) => opt('lsa', v) });
  const ex = advGroup(el, 'Exhaust');
  chips(ex, { label: 'Headers', value: c.headers || 'equal', options: [{ v: 'equal', t: 'Equal length', s: 'clean' }, { v: 'unequal', t: 'Unequal', s: 'boxer rumble' }], onPick: (v) => opt('headers', v) });
  slider(ex, { id: 'aExLen', label: 'Exhaust length', min: 20, max: 250, step: 1, value: c.exLengthIn ?? 100, changed: 'exLengthIn' in c, fmt: (v) => v.toFixed(0) + ' in', onInput: (v) => opt('exLengthIn', v) });
  if (p.nEx === 2) slider(ex, { id: 'aSplit', label: 'Second pipe length', min: 0.4, max: 2.5, step: 0.05, value: c.pipeSplit ?? 1, changed: 'pipeSplit' in c, fmt: x2, onInput: (v) => opt('pipeSplit', v) });
  if (asp === 'turbo' || asp === 'twin') {
    const t = advGroup(el, 'Turbo', true);
    slider(t, { id: 'aTsize', label: 'Turbo size (small = snappy, big = top end)', min: 0, max: 2, step: 0.05, value: c.turboSize ?? 1, changed: 'turboSize' in c, fmt: (v) => v < 0.6 ? 'Small' : v < 1.4 ? 'Medium' : 'Big', onInput: (v) => opt('turboSize', v) });
    chips(t, { label: 'On lift', value: c.bov ?? 0, options: [{ v: 0, t: 'Blow-off' }, { v: 1, t: 'Flutter' }, { v: 2, t: 'None' }], onPick: (v) => opt('bov', v) });
  }
  if (asp === 'sc' || asp === 'twin') {
    const s = advGroup(el, 'Supercharger', true);
    chips(s, { label: 'Type', value: c.scType || 'screw', options: [{ v: 'screw', t: 'Twin-screw', s: 'SLR whine' }, { v: 'roots', t: 'Roots', s: 'deep whine' }, { v: 'centrifugal', t: 'Centrifugal', s: 'rising scream' }], onPick: (v) => opt('scType', v) });
    slider(s, { id: 'aEee', label: '"Eee" colour', min: 0, max: 3, step: 0.05, value: c.scEee ?? 2, changed: 'scEee' in c, fmt: f2, onInput: (v) => opt('scEee', v) });
    slider(s, { id: 'aChop', label: 'Engine chop in the whine', min: 0, max: 1, step: 0.01, value: c.scChop ?? 0.75, changed: 'scChop' in c, fmt: f2, onInput: (v) => opt('scChop', v) });
    slider(s, { id: 'aPitch', label: 'Whine pitch', min: 0.6, max: 1.6, step: 0.01, value: c.scPitch ?? 1, changed: 'scPitch' in c, fmt: x2, onInput: (v) => opt('scPitch', v) });
    if (asp === 'twin') slider(s, { id: 'aHand', label: 'Blower hands off to turbo at', min: 2000, max: 7000, step: 100, value: sp.fi.handover, changed: 'handover' in c, fmt: (v) => v.toFixed(0) + ' rpm', onInput: (v) => opt('handover', v) });
  }
  const lim = advGroup(el, 'Limits');
  slider(lim, { id: 'aRev', label: 'Rev limiter', min: 3000, max: 13000, step: 100, value: p.revLimitRpm, changed: 'revLimitRpm' in c, fmt: (v) => v.toFixed(0) + ' rpm', onInput: (v) => opt('revLimitRpm', v) });
  if (S.mode === 'phys') {
    chips(lim, { label: 'Physics quality (lower if the sound gaps)', value: S.quality, options: QUALITY.map((q, i) => ({ v: i, t: q.name })), onPick: (v) => { S.quality = v; save(); } });
  } else {
    // Standard mode drivetrain feel (our original demo's timing; applies to every engine, live)
    const d = advGroup(el, 'Drivetrain feel');
    const D = CAR.DEFAULTS, get = (k) => S.car[k] ?? D[k];
    const car = (id, k, label, min, max, step, unit) => slider(d, { id, label, min, max, step, value: get(k), changed: k in S.car, fmt: (v) => (step < 1 ? v.toFixed(2) : v.toFixed(0)) + unit, onInput: (v) => Std.carSet(k, v) });
    car('cUp', 'shiftUpMs', 'Upshift time', 40, 600, 10, ' ms');
    car('cDn', 'shiftDownMs', 'Downshift time', 40, 700, 10, ' ms');
    car('cBite', 'clutchMs', 'Clutch bite', 20, 400, 10, ' ms');
    car('cLaunch', 'launchBite', 'Launch clutch release', 0.3, 3, 0.1, ' s');
    car('cRev', 'revUp', 'Rev-up rate', 0.4, 2.5, 0.05, '×');
    car('cFall', 'rpmDropN', 'Rpm fall in neutral', 1000, 12000, 250, ' rpm/s');
    car('cLimHz', 'limiterHz', 'Limiter bounce', 3, 30, 1, ' Hz');
    car('cBrake', 'brake', 'Brake strength', 2000, 20000, 500, ' N');
  }
}
function updateSummary() {
  const sp = B.buildSpec(S.cfg), p = sp.params, psi = Math.max(sp.fi.turboPsi, sp.fi.scPsi);
  const fi = sp.fi.type === 'na' ? 'naturally aspirated' : `${psi.toFixed(0)} psi ${{ turbo: 'turbo', sc: 'supercharged', twin: 'twin-charged' }[sp.fi.type]}`;
  $('buildSummary').textContent = `${sp.name} · ${p.boreMm.toFixed(1)} × ${p.strokeMm.toFixed(1)} mm · ${fi} · firing ${sp.order.join('-')} · limiter ${p.revLimitRpm} rpm` + (S.mode === 'phys' && sp.n > 8 ? ' · big engine: heavier on your CPU' : '');
}
$('mSimple').onclick = () => { S.bmode = 'simple'; save(); renderBuilder(); };
$('mAdv').onclick = () => { S.bmode = 'adv'; save(); renderBuilder(); };
$('buildGo').onclick = () => { S.cur = { kind: 'custom', cfg: Object.assign({}, S.cfg) }; S.sound = {}; S.fiSound = {}; delete S.stdSound.gen; save(); dropIn(); };
$('buildSave').onclick = () => { const cfg = Object.assign({}, S.cfg); if (!cfg.name) cfg.name = B.buildSpec(cfg).name; S.mine.push(cfg); S.cur = { kind: 'custom', cfg, mine: S.mine.length - 1 }; save(); renderGarage(); toast('Saved to your garage.'); };
$('copy').onclick = () => {
  const txt = JSON.stringify(S.cfg); $('paste').value = txt;
  navigator.clipboard && navigator.clipboard.writeText(txt).then(() => toast('Copied.'), () => { $('paste').select(); toast('Select and copy the text.'); });
};
$('load').onclick = () => {
  try { const c = JSON.parse($('paste').value); if (!c || !B.LAYOUTS[c.layout]) throw new Error('needs a layout of I, V, VR or F'); S.cfg = c; save(); renderBuilder(); toast('Loaded. Tap Build & start.'); }
  catch (e) { toast('That isn’t a build: ' + e.message); }
};

// ---------------------------------------------------------------- dyno (physics mode)
let dyn = { run: null };
$('dynoRun').onclick = async () => {
  if (state && state.dyno) { Phys.host.postMessage({ type: 'dyno', action: 'stop' }); return; }
  if (!Phys.node) { await startPressed(); toast('Starting the engine, then tap Run again.'); return; }
  Phys.host.postMessage({ type: 'dyno', action: 'start' });
};
$('dynoClear').onclick = () => { S.dynoPrev = null; S.dynoLast = null; dyn.run = null; save(); showPeaks(null); };
function dynoBegin() { if (S.dynoLast) S.dynoPrev = S.dynoLast; dyn.run = { name: built ? built.name : '', pts: [] }; $('dynoRun').textContent = 'Stop'; $('dynoMsg').textContent = 'Pulling… full throttle, neutral.'; }
function dynoAdd(pts) { if (dyn.run) dyn.run.pts.push(...pts); }
function dynoEnd(finished) {
  $('dynoRun').textContent = 'Run a pull';
  if (dyn.run && finished && dyn.run.pts.length > 20) { S.dynoLast = dyn.run; save(); }
  if (dyn.run) { const pk = peaks(dyn.run); showPeaks(pk); $('dynoMsg').textContent = finished && pk ? `${dyn.run.name}: ${pk.hp.toFixed(0)} hp at ${pk.hpR} rpm, ${pk.tq.toFixed(0)} lb-ft at ${pk.tqR} rpm.` : 'Pull stopped.'; }
}
function smooth(pts) {
  const o = [], w = 7;
  for (let i = 0; i < pts.length; i++) { let a = 0, n = 0; for (let j = Math.max(0, i - w); j <= Math.min(pts.length - 1, i + w); j++) { a += pts[j][1]; n++; } o.push([pts[i][0], a / n, pts[i][2]]); }
  return o;
}
function peaks(run) {
  if (!run || run.pts.length < 10) return null;
  let hp = 0, hpR = 0, tq = 0, tqR = 0, psi = 0;
  for (const [r, t, p] of smooth(run.pts)) { const h = t * r / 5252; if (h > hp) { hp = h; hpR = r; } if (t > tq) { tq = t; tqR = r; } psi = Math.max(psi, p); }
  return { hp, hpR, tq, tqR, psi };
}
function showPeaks(pk) {
  $('pkHp').textContent = pk ? pk.hp.toFixed(0) : '–'; $('pkHpR').textContent = pk ? '@ ' + pk.hpR + ' rpm' : ' ';
  $('pkTq').textContent = pk ? pk.tq.toFixed(0) : '–'; $('pkTqR').textContent = pk ? '@ ' + pk.tqR + ' rpm' : ' ';
  $('pkPsi').textContent = pk && pk.psi > 0.5 ? pk.psi.toFixed(1) : '–';
}
function drawDyno() {
  if ($('p-dyno').hidden) return;
  const [c, w, h] = fitCanvas($('dynoCv'));
  c.clearRect(0, 0, w, h);
  const runs = [S.dynoPrev, dyn.run].filter((r) => r && r.pts.length > 3).map((r) => ({ r, s: smooth(r.pts) }));
  let maxR = 7000, maxV = 100;
  for (const { s } of runs) for (const [r, t] of s) { maxR = Math.max(maxR, r); maxV = Math.max(maxV, t, t * r / 5252); }
  maxR = Math.ceil(maxR / 1000) * 1000; const stepV = maxV > 600 ? 200 : maxV > 250 ? 100 : 50; maxV = Math.ceil(maxV * 1.08 / stepV) * stepV;
  const L = 40, R = 10, T = 10, Bm = 26, X = (r) => L + (w - L - R) * r / maxR, Y = (v) => T + (h - T - Bm) * (1 - v / maxV);
  c.font = `500 11px ${css('--mono')}`; c.fillStyle = css('--muted'); c.strokeStyle = css('--line'); c.lineWidth = 1;
  c.textAlign = 'right'; c.textBaseline = 'middle';
  for (let v = 0; v <= maxV; v += stepV) { c.beginPath(); c.moveTo(L, Y(v)); c.lineTo(w - R, Y(v)); c.stroke(); c.fillText(String(v), L - 6, Y(v)); }
  c.textAlign = 'center'; c.textBaseline = 'top';
  for (let r = 0; r <= maxR; r += 1000) c.fillText(r ? String(r / 1000) + 'k' : '0', X(r), h - Bm + 6);
  runs.forEach(({ s }, i) => {
    const prev = runs.length === 2 && i === 0;
    for (const [col, f] of [[prev ? css('--muted') : css('--amber'), (p) => p[1] * p[0] / 5252], [prev ? css('--muted') : css('--blue'), (p) => p[1]]]) {
      c.strokeStyle = col; c.lineWidth = prev ? 1.5 : 2.5; c.setLineDash(prev ? [4, 4] : []);
      c.beginPath(); s.forEach((p, k) => (k ? c.lineTo(X(p[0]), Y(f(p))) : c.moveTo(X(p[0]), Y(f(p))))); c.stroke();
    }
    c.setLineDash([]);
  });
  if (state && state.dyno) { c.strokeStyle = css('--red'); c.lineWidth = 1; c.beginPath(); c.moveTo(X(state.rpm), T); c.lineTo(X(state.rpm), h - Bm); c.stroke(); }
  if (!runs.length) { c.fillStyle = css('--muted'); c.font = `500 13px ${css('--display')}`; c.textBaseline = 'middle'; c.fillText('No pulls yet', w / 2, h / 2); }
}

// ---------------------------------------------------------------- drawing
function fitCanvas(cv) {
  const r = cv.getBoundingClientRect(), d = Math.min(2, window.devicePixelRatio || 1);
  const w = Math.max(1, Math.round(r.width * d)), h = Math.max(1, Math.round(r.height * d));
  if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
  const c = cv.getContext('2d'); c.setTransform(d, 0, 0, d, 0, 0); return [c, r.width, r.height];
}
const cssCache = {}; const css = (n) => cssCache[n] || (cssCache[n] = getComputedStyle(document.documentElement).getPropertyValue(n).trim());
let shownRpm = 0, phase = 0, lastFrame = performance.now(), lowCpuT = 0;
function limits() {
  if (S.mode === 'std') { const e = Std.eng || stdEngine(), l = (S.car.limit ?? e.car.limit); return [l, l - 500]; }
  const e = (built && built.params) ? built : physEngine(), l = S.sound.revLimitRpm ?? e.params.revLimitRpm ?? (e.preset === 1 ? 6800 : 7500);
  return [l, stats ? stats.redline : l - 500];
}
function frame(now) {
  try { frameInner(now); } catch (e) { console.error(e); }
  requestAnimationFrame(frame);
}
function frameInner(now) {
  const dt = Math.min(0.1, (now - lastFrame) / 1000); lastFrame = now;
  const rpm = state ? state.rpm : 0;
  shownRpm += (rpm - shownRpm) * Math.min(1, dt / 0.05);
  const [limit, redline] = limits();
  drawTach(shownRpm, redline, limit);
  if (state) {
    if ($('slowmo').checked) phase = (phase + rpm * 6 * dt / 40) % 720;
    else phase = ((state.cyc + rpm * 6 * (now - state.t) / 1000) % 720 + 720) % 720;
    $('roGear').textContent = $('gearBig').textContent = state.gear < 0 ? 'N' : String(state.gear + 1);
    $('roMph').textContent = state.mph.toFixed(0);
    const naPhys = S.mode === 'phys' && built && built.fi && built.fi.type === 'na';
    $('roBoost').textContent = naPhys ? state.map.toFixed(1) : (state.psi > 0.05 ? state.psi.toFixed(1) : (S.mode === 'std' && built && built.fiType === 'na' ? '–' : '0.0'));
    if (S.mode === 'phys') {
      $('cpu').textContent = 'CPU ' + Math.min(999, 100 / Math.max(0.01, state.rtf)).toFixed(0) + '%';
      lowCpuT = state.rtf < 1.08 && state.on ? lowCpuT + dt : 0;
    } else lowCpuT = 0;
    const st = $('status'), sb = $('startBtn');
    if (state.starting) { st.textContent = 'Cranking'; st.className = 'pill warn'; sb.textContent = 'Cranking'; sb.className = 'start cranking'; }
    else if (state.on) { st.textContent = state.dyno ? 'On the dyno' : lowCpuT > 2 ? 'CPU maxed: lower quality' : 'Running'; st.className = lowCpuT > 2 ? 'pill warn' : 'pill live'; sb.textContent = 'Stop'; sb.className = 'start on'; }
    else { st.textContent = 'Off'; st.className = 'pill'; sb.textContent = 'Start'; sb.className = 'start'; }
  }
  if (!$('p-drive').hidden) drawFire(phase);
  drawDyno();
}
function drawTach(rpm, redline, limit) {
  const [c, w, h] = fitCanvas($('tach'));
  c.clearRect(0, 0, w, h);
  const max = Math.max(8000, Math.ceil((limit + 600) / 1000) * 1000);
  const cx = w / 2, cy = h * 0.56, R = Math.min(w * 0.46, h * 0.52);
  const a0 = Math.PI * 0.75, a1 = Math.PI * 2.25, ang = (v) => a0 + (a1 - a0) * clamp(v / max, 0, 1);
  c.lineCap = 'butt';
  c.strokeStyle = css('--line'); c.lineWidth = 10; c.beginPath(); c.arc(cx, cy, R, a0, a1); c.stroke();
  c.strokeStyle = css('--red'); c.beginPath(); c.arc(cx, cy, R, ang(redline), a1); c.stroke();
  c.strokeStyle = css('--amber'); c.beginPath(); c.arc(cx, cy, R, a0, ang(rpm)); c.stroke();
  const big = max > 10000 ? 2000 : 1000;
  c.font = `600 ${Math.round(R * 0.12)}px ${css('--display')}`; c.textAlign = 'center'; c.textBaseline = 'middle';
  for (let v = 0; v <= max; v += big / 2) {
    const a = ang(v), major = v % big === 0;
    c.strokeStyle = v >= redline ? css('--red') : (major ? css('--fg') : css('--muted'));
    c.lineWidth = major ? 2.5 : 1.2;
    const r1 = R - 14, r2 = R - (major ? 28 : 21);
    c.beginPath(); c.moveTo(cx + Math.cos(a) * r1, cy + Math.sin(a) * r1); c.lineTo(cx + Math.cos(a) * r2, cy + Math.sin(a) * r2); c.stroke();
    if (major) { c.fillStyle = v >= redline ? css('--red') : css('--fg'); c.fillText(String(v / 1000), cx + Math.cos(a) * (R - 46), cy + Math.sin(a) * (R - 46)); }
  }
  c.strokeStyle = css('--red'); c.lineWidth = 3; const al = ang(limit);
  c.beginPath(); c.moveTo(cx + Math.cos(al) * (R + 8), cy + Math.sin(al) * (R + 8)); c.lineTo(cx + Math.cos(al) * (R - 8), cy + Math.sin(al) * (R - 8)); c.stroke();
  const an = ang(rpm);
  c.strokeStyle = css('--amber'); c.lineWidth = 3.5; c.lineCap = 'round';
  c.beginPath(); c.moveTo(cx - Math.cos(an) * 14, cy - Math.sin(an) * 14); c.lineTo(cx + Math.cos(an) * (R - 20), cy + Math.sin(an) * (R - 20)); c.stroke();
  c.fillStyle = css('--panel-2'); c.beginPath(); c.arc(cx, cy, 9, 0, Math.PI * 2); c.fill();
  c.fillStyle = css('--fg'); c.font = `500 ${Math.round(R * 0.26)}px ${css('--mono')}`;
  c.fillText(Math.round(rpm).toString(), cx, cy + R * 0.42);
  c.fillStyle = css('--muted'); c.font = `600 ${Math.round(R * 0.085)}px ${css('--display')}`;
  c.fillText('RPM × 1000', cx, cy + R * 0.66);
}
function drawFire(ph) {
  const [c, w, h] = fitCanvas($('fireCv'));
  c.clearRect(0, 0, w, h);
  if (!stats) { c.fillStyle = css('--muted'); c.font = `500 13px ${css('--display')}`; c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillText('Start the engine to see it fire', w / 2, h / 2); return; }
  const n = stats.cyl, fire = stats.fire, bank = stats.bank, nums = (built && built.cylNums) || fire.map((_, i) => i + 1);
  const banks = Math.max(...bank) + 1, per = [0, 0]; bank.forEach((b) => per[b]++);
  const maxPer = Math.max(...per), gap = Math.min(46, (w - 56) / maxPer), r = Math.min(15, gap * 0.38, h / (banks * 2) - 6);
  const idx = [0, 0];
  for (let i = 0; i < n; i++) {
    const b = bank[i] || 0, k = idx[b]++;
    const x0 = 28 + (w - 28) / 2 - gap * (per[b] - 1) / 2;
    const x = x0 + k * gap + (banks === 2 && b === 1 ? gap * 0.25 : 0);
    const y = banks === 1 ? h / 2 : (b === 0 ? h * 0.28 : h * 0.72);
    const d = (((ph - fire[i]) % 720) + 720) % 720, glow = Math.exp(-d / 55);
    c.fillStyle = css('--panel-2'); c.strokeStyle = css('--line'); c.lineWidth = 1.5;
    c.beginPath(); c.arc(x, y, r, 0, Math.PI * 2); c.fill(); c.stroke();
    if (glow > 0.02) {
      c.globalAlpha = glow; c.fillStyle = css('--amber'); c.beginPath(); c.arc(x, y, r, 0, Math.PI * 2); c.fill();
      c.globalAlpha = glow * 0.35; c.beginPath(); c.arc(x, y, r * 1.7, 0, Math.PI * 2); c.fill(); c.globalAlpha = 1;
    }
    c.fillStyle = glow > 0.5 ? '#1b1206' : css('--fg'); c.font = `600 ${Math.round(r * 0.95)}px ${css('--mono')}`; c.textAlign = 'center'; c.textBaseline = 'middle';
    c.fillText(String(nums[i]), x, y + 1);
  }
  if (banks === 2) { c.fillStyle = css('--muted'); c.font = `600 11px ${css('--display')}`; c.textAlign = 'left'; c.fillText('A', 2, h * 0.28); c.fillText('B', 2, h * 0.72); }
}

// ---------------------------------------------------------------- boot
try { const t = localStorage.getItem('motorsync_tab'); if (TABS.includes(t)) showTab(t); } catch (e) {}
applyModeUI();
dyn.run = S.dynoLast || null;
backend().build(false);
renderBuilder(); showPeaks(peaks(dyn.run));
if (S.mode === 'phys') Phys.startHost().catch((e) => toast('The physics engine failed to load: ' + e.message));
requestAnimationFrame(frame);
