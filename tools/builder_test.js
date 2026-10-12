// Validate generated engines: they must start, idle and make sensible torque per liter on the dyno.
const fs = require('fs'), { loadEngineSim } = require('../web/es-loader.js'), B = require('../web/builder.js');
const cfgs = JSON.parse(process.argv[2] || 'null') || [
  { layout: 'I', cyl: 1, liters: 0.6 }, { layout: 'I', cyl: 3, liters: 1.5 }, { layout: 'I', cyl: 4, liters: 2.0 },
  { layout: 'I', cyl: 5, liters: 2.5 }, { layout: 'I', cyl: 7, liters: 3.5 }, { layout: 'V', cyl: 6, liters: 3.5 },
  { layout: 'V', cyl: 8, liters: 5.0, crank: 'cross' }, { layout: 'V', cyl: 8, liters: 4.5, crank: 'flat' },
  { layout: 'V', cyl: 10, liters: 5.2 }, { layout: 'V', cyl: 12, liters: 6.0 }, { layout: 'VR', cyl: 6, liters: 2.8 },
  { layout: 'F', cyl: 4, liters: 2.5 }, { layout: 'F', cyl: 6, liters: 3.6 }, { layout: 'V', cyl: 16, liters: 8.0 },
];
(async () => {
  const irs = {}; for (const f of fs.readdirSync('ir')) irs[f] = fs.readFileSync('ir/' + f);
  const es = await loadEngineSim(fs.readFileSync('es.wasm'), irs); const x = es.x;
  for (const c of cfgs) {
    const s = B.buildSpec(c);
    es.create(2, s.params);
    let caught = -1, above = 0, t = 0;
    for (; t < 5; t += 1 / 60) {
      const crank = caught < 0; x.es_set_starter(crank ? 1 : 0); x.es_set_throttle(crank ? 0.03 : 0); es.step(1 / 60);
      if (x.es_rpm() > 500) above += 1 / 60; else above = 0; if (caught < 0 && above > 0.25) caught = t;
    }
    let idle = 0; for (let i = 0; i < 60; i++) { es.step(1 / 60); idle += x.es_rpm() / 60; }
    const rpm = Math.round(s.params.revLimitRpm * 0.6 / 100) * 100;
    x.es_set_dyno(1, rpm); x.es_set_throttle(1); for (let i = 0; i < 50; i++) es.step(1 / 60);
    let tq = 0; for (let i = 0; i < 20; i++) { es.step(1 / 60); tq += x.es_torque_lbft() / 20; }
    x.es_set_dyno(0, 0); x.es_set_throttle(0);
    console.log(`${s.name.padEnd(22)} ${s.crank.padEnd(5)} order ${s.order.join('-').padEnd(30)} caught ${caught.toFixed(2)}s idle ${idle.toFixed(0).padStart(4)} | ${rpm} rpm: ${tq.toFixed(0)} lb-ft = ${(tq / s.liters).toFixed(0)} lb-ft/L, ${(tq * rpm / 5252).toFixed(0)} hp, limit ${s.params.revLimitRpm}`);
  }
})();
