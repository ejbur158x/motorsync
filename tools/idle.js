const fs=require('fs'),{loadEngineSim}=require('../web/es-loader.js');
(async()=>{const irs={};for(const f of fs.readdirSync('ir'))irs[f]=fs.readFileSync('ir/'+f);
const es=await loadEngineSim(fs.readFileSync('es.wasm'),irs);const p=JSON.parse(process.argv[3]||'{}');
es.create(+process.argv[2],p);const x=es.x;let line='';
for(let t=0,f=0;t<14;t+=1/60,f++){const crank=+(p.crank||1.5);x.es_set_starter(t<crank?1:0);x.es_set_throttle(t<crank?(p.cthr||0):0);es.step(1/60);if(f%60==0)line+=x.es_rpm().toFixed(0)+' ';}
console.log(JSON.stringify(p),line);})();
