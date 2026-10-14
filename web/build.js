// Inline es.wasm, impulse responses and scripts into one self-contained page: index.html (served by GitHub Pages)
const fs = require('fs'), path = require('path');
const root = path.join(__dirname, '..');
let html = fs.readFileSync(path.join(__dirname, 'app.html'), 'utf8');
const irs = {}; for (const f of fs.readdirSync(path.join(root, 'ir'))) irs[f] = fs.readFileSync(path.join(root, 'ir', f)).toString('base64');
const sub = (tag, val) => { if (!html.includes(tag)) throw new Error('missing ' + tag); html = html.split(tag).join(val); };
sub('"/*__WASM_B64__*/"', JSON.stringify(fs.readFileSync(path.join(root, 'es.wasm')).toString('base64')));
sub('/*__IRS_JSON__*/{}', JSON.stringify(irs));
sub('/*__LOADER__*/""', JSON.stringify(fs.readFileSync(path.join(__dirname, 'es-loader.js'), 'utf8')));
sub('/*__FORCED__*/""', JSON.stringify(fs.readFileSync(path.join(__dirname, 'forced.js'), 'utf8')));
sub('/*__BUILDER_INLINE__*/', fs.readFileSync(path.join(__dirname, 'builder.js'), 'utf8').replace(/<\/script/gi, '<\\/script'));
sub('/*__WORKER__*/""', JSON.stringify(fs.readFileSync(path.join(__dirname, 'worker.js'), 'utf8')));
const rd = (f) => fs.readFileSync(path.join(__dirname, f), 'utf8');
const i6 = rd('std/i6-core.js'), helpers = i6.split('class I6Core')[0];
const stdWorklet = [
  `const I6Core = (() => {\n${i6}\nreturn I6Core; })();`,
  `const V8Core = (() => {\n${rd('std/v8-core.js')}\nreturn V8Core; })();`,
  rd('forced.js'),
  `const GenericCore = (() => {\n${helpers}\nconst ForcedInduction = globalThis.MSForced.ForcedInduction;\n${rd('std/generic-core.js')}\nreturn GenericCore; })();`,
  rd('std/worklet-proc.js'),
].join('\n');
sub('/*__STD_WORKLET__*/""', JSON.stringify(stdWorklet));
sub('/*__CAR_INLINE__*/', rd('std/car.js').replace(/<\/script/gi, '<\\/script'));
sub('/*__WORKLET__*/""', JSON.stringify(fs.readFileSync(path.join(__dirname, 'worklet.js'), 'utf8')));
sub('/*__LICENSE__*/""', JSON.stringify(fs.readFileSync(path.join(root, 'engine-sim', 'LICENSE'), 'utf8')));
sub('/*__MAIN_SCRIPT__*/', '<script>\n' + rd('app.js').replace(/<\/script/gi, '<\\/script') + '\n</script>');
const out = path.join(root, 'index.html');
fs.writeFileSync(out, html);
console.log('index.html', (html.length / 1024).toFixed(0), 'KB');
