const fs=require('fs'),{loadEngineSim}=require('../web/es-loader.js');
(async()=>{const irs={};for(const f of fs.readdirSync('ir'))irs[f]=fs.readFileSync('ir/'+f);
const es=await loadEngineSim(fs.readFileSync('es.wasm'),irs);const x=es.x;
for(const pre of [0,1]){let t0=performance.now();es.create(pre,{});const ms=performance.now()-t0;
x.es_starter_params(+process.argv[2]||800,+process.argv[3]||1500);let line='';for(let f=0;f<240;f++){x.es_set_starter(f<20?1:0);if(f==20)x.es_starter_params(0,0);es.step(1/60);if(f%30==0)line+=x.es_rpm().toFixed(0)+' ';}
// gear test: 1st gear, clutch ramp, throttle
x.es_set_gear(0);let l2='';for(let f=0;f<300;f++){x.es_set_clutch(Math.min(1,f/45));x.es_set_throttle(f>20?0.6:0.1);es.step(1/60);if(f%30==0)l2+=x.es_rpm().toFixed(0)+'/'+x.es_speed_mph().toFixed(0)+' ';}
console.log('preset',pre,'build',ms.toFixed(0),'ms  spin->',line,' gear1:',l2, 'cyc',x.es_cycle_deg().toFixed(0));}})();
