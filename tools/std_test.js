// Offline render of the Standard synths: node tools/std_test.js <i6|v8|gen> '<builder cfg>' out.wav
const fs = require('fs'), path = require('path'), W = path.join(__dirname, '../web/');
const B = require('../web/builder.js');
const scope = (files, name) => new Function(files.map((f) => fs.readFileSync(W + f, 'utf8')).join('\n') + `\nreturn ${name};`)();
const which = process.argv[2] || 'gen';
const SR = 44100;
let core;
if (which === 'i6') core = new (scope(['std/i6-core.js'], 'I6Core'))(SR);
else if (which === 'v8') core = new (scope(['std/v8-core.js'], 'V8Core'))(SR);
else {
  const head = fs.readFileSync(W + 'std/i6-core.js', 'utf8').split('class I6Core')[0];
  const G = new Function(head + fs.readFileSync(W + 'forced.js', 'utf8') + '\nconst ForcedInduction = globalThis.MSForced.ForcedInduction;\n' + fs.readFileSync(W + 'std/generic-core.js', 'utf8') + '\nreturn GenericCore;').call({});
  core = new G(SR);
  const cfg = JSON.parse(process.argv[3] || '{"layout":"I","cyl":7,"liters":3.5,"aspiration":"twin","boostPsi":20,"character":0.6}');
  const sp = B.buildSpec(cfg);
  core.configure(B.stdSynth ? B.stdSynth(sp, cfg) : null);
}
const out = new Float32Array(SR * 9); core.ignite();
const seq = (t) => t < 3 ? [850, 0] : t < 4.6 ? [850 + (t - 3) / 1.6 * 6000, 1] : t < 6 ? [6850 - (t - 4.6) * 3500, 0] : t < 6.3 ? [3000 + (t - 6) * 6000, 1] : [4800 - (t - 6.3) * 1500, 0];
for (let i = 0; i < out.length; i++) {
  if (i % 128 === 0) { const t = i / SR; if (t > 2.8) { const [r, th] = seq(t); core.targetRpm = Math.max(850, r); core.targetThrottle = th; } }
  out[i] = core.sample();
}
let pk = 0, ss = 0; for (const v of out) { pk = Math.max(pk, Math.abs(v)); ss += v * v; }
console.log(which, 'peak', pk.toFixed(2), 'rms dB', (10 * Math.log10(ss / out.length)).toFixed(1), 'boost end', (core.boost || 0).toFixed(2));
const o = process.argv[4]; if (o) {
  const b = Buffer.alloc(44 + out.length * 2); b.write('RIFF', 0); b.writeUInt32LE(36 + out.length * 2, 4); b.write('WAVEfmt ', 8);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(SR, 24); b.writeUInt32LE(SR * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
  b.write('data', 36); b.writeUInt32LE(out.length * 2, 40); out.forEach((v, i) => b.writeInt16LE(Math.round(Math.max(-1, Math.min(1, v)) * 32767), 44 + i * 2)); fs.writeFileSync(o, b);
}
