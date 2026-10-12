// Inline es.wasm, impulse responses and scripts into one self-contained page: index.html (served by GitHub Pages)
const fs = require('fs'), path = require('path');
const root = path.join(__dirname, '..');
let html = fs.readFileSync(path.join(__dirname, 'app.html'), 'utf8');
const irs = {}; for (const f of fs.readdirSync(path.join(root, 'ir'))) irs[f] = fs.readFileSync(path.join(root, 'ir', f)).toString('base64');
const sub = (tag, val) => { if (!html.includes(tag)) throw new Error('missing ' + tag); html = html.split(tag).join(val); };
sub('"/*__WASM_B64__*/"', JSON.stringify(fs.readFileSync(path.join(root, 'es.wasm')).toString('base64')));
sub('/*__IRS_JSON__*/{}', JSON.stringify(irs));
sub('/*__LOADER__*/""', JSON.stringify(fs.readFileSync(path.join(__dirname, 'es-loader.js'), 'utf8')));
sub('/*__WORKER__*/""', JSON.stringify(fs.readFileSync(path.join(__dirname, 'worker.js'), 'utf8')));
sub('/*__WORKLET__*/""', JSON.stringify(fs.readFileSync(path.join(__dirname, 'worklet.js'), 'utf8')));
sub('/*__LICENSE__*/""', JSON.stringify(fs.readFileSync(path.join(root, 'engine-sim', 'LICENSE'), 'utf8')));
const out = path.join(root, 'index.html');
fs.writeFileSync(out, html);
console.log('index.html', (html.length / 1024).toFixed(0), 'KB');
