const fs = require('fs'), path = require('path');
const { loadEngineSim } = require('../web/es-loader.js');
(async () => {
  const dir = path.join(__dirname, '..');
  const irs = {}; for (const f of fs.readdirSync(dir + '/ir')) irs[f] = fs.readFileSync(dir + '/ir/' + f);
  const es = await loadEngineSim(fs.readFileSync(dir + '/es.wasm'), irs);
  const preset = +(process.argv[2] || 0), simf = +(process.argv[3] || 7000), fluid = +(process.argv[4] || 4);
  const ncyl = es.create(preset, { simFrequency: simf, fluidSteps: fluid });
  const x = es.x; const out = []; const dt = 1 / 60, total = 9;
  const t0 = performance.now(); let maxRpm = 0;
  for (let t = 0, f = 0; t < total; t += dt, f++) {
    x.es_set_starter(t < 2.5 ? 1 : 0);
    let thr = t < 2.5 ? 0.2 : 0; if (t > 3 && t < 4.6) thr = 1; if (t > 6 && t < 6.3) thr = 1;
    x.es_set_throttle(thr);
    const s = es.step(dt); for (let i = 0; i < s.length; i++) out.push(s[i]);
    maxRpm = Math.max(maxRpm, x.es_rpm());
    if (f % 60 == 0) console.log(`t=${t.toFixed(1)} rpm=${x.es_rpm().toFixed(0)}`);
  }
  const wall = (performance.now() - t0) / 1000;
  console.log(`cyl=${ncyl} ${(x.es_displacement_l()).toFixed(2)}L  ${total}s in ${wall.toFixed(2)}s -> ${(total / wall).toFixed(2)}x realtime, max ${maxRpm.toFixed(0)} rpm, ${out.length} samples`);
  const b = Buffer.alloc(44 + out.length * 2); b.write('RIFF', 0); b.writeUInt32LE(36 + out.length * 2, 4); b.write('WAVEfmt ', 8);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(44100, 24); b.writeUInt32LE(88200, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
  b.write('data', 36); b.writeUInt32LE(out.length * 2, 40); out.forEach((v, i) => b.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(v * 32768))), 44 + i * 2));
  fs.writeFileSync(process.argv[5] || 'wasm_out.wav', b);
})();
