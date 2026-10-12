// Loads es.wasm with a 4-function WASI shim. Works in browsers, AudioWorklets and node.
async function loadEngineSim(wasmBytes, irFiles /* {name: Uint8Array} */) {
  let mem;
  const wasi = {
    clock_time_get: (id, prec, out) => { const t = BigInt(Math.round((typeof performance !== 'undefined' ? performance.now() : Date.now()) * 1e6)); new DataView(mem.buffer).setBigUint64(out, t, true); return 0; },
    fd_close: () => 0, fd_seek: () => 0,
    fd_write: (fd, iovs, n, nw) => { const dv = new DataView(mem.buffer); let tot = 0; for (let i = 0; i < n; i++) tot += dv.getUint32(iovs + i * 8 + 4, true); dv.setUint32(nw, tot, true); return 0; },
    proc_exit: () => {},
  };
  const { instance } = await WebAssembly.instantiate(wasmBytes, { wasi_snapshot_preview1: wasi });
  const x = instance.exports; mem = x.memory; x._initialize();
  const enc = new TextEncoder();
  const setName = s => { const b = enc.encode(s); const p = x.es_name_buf(); const u = new Uint8Array(mem.buffer, p, 128); u.fill(0); u.set(b.subarray(0, 127)); };
  for (const [name, bytes] of Object.entries(irFiles || {})) {
    const p = x.es_ir_alloc(bytes.length); new Uint8Array(mem.buffer, p, bytes.length).set(bytes);
    setName(name); x.es_ir_commit();
  }
  const api = {
    x,
    create(preset, params = {}) {
      x.es_params_clear();
      for (const [k, v] of Object.entries(params)) { setName(k); x.es_param(v); }
      const n = x.es_create(preset);
      if (!n) { const p = x.es_error(); const u = new Uint8Array(mem.buffer, p); let e = ''; for (let i = 0; u[i]; i++) e += String.fromCharCode(u[i]); throw new Error('engine build failed: ' + e); }
      return n;
    },
    get(preset, key) { setName(key); return x.es_get(preset); },
    live(key, v) { setName(key); return x.es_live(v); },
    // advance one frame, return Float32Array view of the new samples (valid until next call)
    step(dt) { x.es_step(dt); const n = x.es_pop(1 << 16); return new Float32Array(mem.buffer, x.es_out_ptr(), n); },
  };
  return api;
}
if (typeof module !== 'undefined') module.exports = { loadEngineSim };
