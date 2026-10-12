// node tools/dyno_test.js <preset> '<params json>' : holds the engine on the dyno at WOT, prints torque/hp vs rpm and boost
const fs = require('fs'), { loadEngineSim } = require('../web/es-loader.js');
(async () => {
  const irs = {}; for (const f of fs.readdirSync('ir')) irs[f] = fs.readFileSync('ir/' + f);
  const es = await loadEngineSim(fs.readFileSync('es.wasm'), irs); const x = es.x;
  const preset = +(process.argv[2] || 0), params = JSON.parse(process.argv[3] || '{}'), boosts = JSON.parse(process.argv[4] || '[0]');
  es.create(preset, params);
  for (let t = 0; t < 3; t += 1 / 60) { x.es_set_starter(t < 2 ? 1 : 0); x.es_set_throttle(t < 2 ? 0.05 : 0); es.step(1 / 60); }
  const out = [];
  for (const psi of boosts) for (const rpm of [2000, 3000, 4000, 5000, 6000]) {
    x.es_set_boost(psi); x.es_set_dyno(1, rpm); x.es_set_throttle(1);
    for (let i = 0; i < 50; i++) es.step(1 / 60);
    let tq = 0; for (let i = 0; i < 20; i++) { es.step(1 / 60); tq += x.es_torque_lbft(); } tq /= 20;
    out.push(`${psi}psi ${rpm}: ${tq.toFixed(0)} lb-ft ${(tq * rpm / 5252).toFixed(0)} hp (rpm ${x.es_rpm().toFixed(0)})`);
  }
  console.log(out.join('\n'));
})();
