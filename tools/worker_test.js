// Drive web/worker.js in node with a fake self: build, start, launch, brake, dyno pull. Writes a WAV.
const fs = require('fs'), path = require('path'), W = path.join(__dirname, '../web/');
const B = require('../web/builder.js');
const src = ['es-loader.js', 'forced.js', 'worker.js'].map((f) => fs.readFileSync(W + f, 'utf8')).join('\n');
const msgs = []; const fake = { postMessage: (m) => { msgs.push(m); if (!['state'].includes(m.type)) console.log('<-', m.type, m.message || m.text || ''); }, onmessage: null };
new Function('self', src)(fake);
const irs = {}; for (const f of fs.readdirSync('ir')) irs[f] = fs.readFileSync('ir/' + f);
const { MessageChannel } = require('worker_threads');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  await fake.onmessage({ data: { type: 'init', wasm: fs.readFileSync('es.wasm'), irs } });
  const ch = new MessageChannel(); let consumed = 0; const audio = [];
  ch.port2.on('message', (m) => { if (m.pcm) { consumed += m.pcm.length; for (const v of m.pcm) audio.push(v); } });
  fake.onmessage({ data: { type: 'attach', port: ch.port1 } });
  setInterval(() => ch.port2.postMessage({ consumed, underruns: 0 }), 10);
  const cfg = JSON.parse(process.argv[2] || '{"layout":"I","cyl":7,"liters":3.5,"aspiration":"twin","boostPsi":20,"character":0.6}');
  const s = B.buildSpec(cfg);
  fake.onmessage({ data: { type: 'build', preset: 2, params: s.params, fi: s.fi, restart: true } });
  const last = () => msgs.filter((m) => m.type === 'state').pop();
  const log = (tag) => { const st = last(); console.log(tag.padEnd(10), `rpm ${st.rpm | 0} gear ${st.gear} mph ${st.mph.toFixed(1)} psi ${st.psi.toFixed(1)} clutch ${st.clutch.toFixed(2)} rtf ${st.rtf.toFixed(2)}`); };
  await sleep(3000); log('idle');
  fake.onmessage({ data: { type: 'throttle', value: 1 } }); await sleep(1500); log('rev');
  fake.onmessage({ data: { type: 'throttle', value: 0 } }); await sleep(1500); log('lift');
  fake.onmessage({ data: { type: 'shift', dir: 1 } }); await sleep(1500); log('1st idle');
  fake.onmessage({ data: { type: 'throttle', value: 0.8 } });
  for (let i = 0; i < 6; i++) { await sleep(500); log('launch'); }
  fake.onmessage({ data: { type: 'throttle', value: 0 } }); fake.onmessage({ data: { type: 'brake', value: 1 } });
  for (let i = 0; i < 6; i++) { await sleep(500); log('brake'); }
  fake.onmessage({ data: { type: 'brake', value: 0 } }); fake.onmessage({ data: { type: 'shift', dir: -1 } }); await sleep(800);
  fake.onmessage({ data: { type: 'dyno', action: 'start' } });
  const pts = [];
  while (!msgs.some((m) => m.type === 'dynoDone')) { await sleep(200); for (const m of msgs.splice(0)) { if (m.dynoPts) pts.push(...m.dynoPts); if (m.type === 'dynoDone') msgs.push(m); } }
  let best = [0, 0], bestT = [0, 0];
  for (const [r, t, p] of pts) { const hp = t * r / 5252; if (hp > best[0]) best = [hp, r]; if (t > bestT[0]) bestT = [t, r]; }
  console.log(`dyno ${pts.length} pts: peak ${best[0].toFixed(0)} hp @ ${best[1]}, ${bestT[0].toFixed(0)} lb-ft @ ${bestT[1]}`);
  for (let i = 0; i < pts.length; i += Math.ceil(pts.length / 10)) console.log('  ', pts[i].join(' '));
  const out = process.argv[3]; if (out) {
    const b = Buffer.alloc(44 + audio.length * 2); b.write('RIFF', 0); b.writeUInt32LE(36 + audio.length * 2, 4); b.write('WAVEfmt ', 8);
    b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(44100, 24); b.writeUInt32LE(88200, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
    b.write('data', 36); b.writeUInt32LE(audio.length * 2, 40); audio.forEach((v, i) => b.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(v * 32768))), 44 + i * 2));
    fs.writeFileSync(out, b);
  }
  process.exit(0);
})();
