const fs=require('fs'),{loadEngineSim}=require('../web/es-loader.js');
(async()=>{const irs={};for(const f of fs.readdirSync('ir'))irs[f]=fs.readFileSync('ir/'+f);
const es=await loadEngineSim(fs.readFileSync('es.wasm'),irs);const x=es.x;const pre=+process.argv[2],cthr=+process.argv[3];
es.create(pre,{});let t=0,caught=-1,above=0,line='';x.es_set_throttle(0);
for(;t<6;t+=1/60){const crank=caught<0&&t<6;x.es_set_starter(crank?1:0);x.es_set_throttle(crank?cthr:0);es.step(1/60);
 if(x.es_rpm()>550)above+=1/60;else above=0; if(caught<0&&above>0.25)caught=t;}
line+=`caught@${caught.toFixed(2)} idle ${x.es_rpm().toFixed(0)} | `;
x.es_set_clutch(0);x.es_set_gear(0);
for(let f=0;f<480;f++){x.es_set_clutch(Math.min(1,f/60));x.es_set_throttle(f<60?0.25:1);es.step(1/60);if(f%40==0)line+=x.es_rpm().toFixed(0)+'/'+x.es_speed_mph().toFixed(0)+' ';}
console.log('preset',pre,line);})();
