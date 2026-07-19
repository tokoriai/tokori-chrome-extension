/**
 * Copy the tesseract.js runtime into public/ so it ships with the
 * extension UNHASHED. The names must survive the build verbatim:
 * `tesseract-core-simd-lstm.wasm.js` locates its `.wasm` as a sibling
 * file with the same basename, so Vite's hashed asset emit would break
 * the pair. public/ files are copied to the dist root as-is.
 *
 * Runs automatically before dev/build (see package.json pre-scripts).
 */
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'public', 'tesseract');
mkdirSync(out, { recursive: true });

const files = [
  ['tesseract.js/dist/worker.min.js', 'worker.min.js'],
  ['tesseract.js-core/tesseract-core-simd-lstm.wasm.js', 'tesseract-core-simd-lstm.wasm.js'],
  ['tesseract.js-core/tesseract-core-simd-lstm.wasm', 'tesseract-core-simd-lstm.wasm'],
  // Apache-2.0 requires the license text to travel with redistributed
  // builds — ship both projects' licenses next to the runtime.
  ['tesseract.js/LICENSE.md', 'LICENSE-tesseract-js.md'],
  ['tesseract.js-core/LICENSE', 'LICENSE-tesseract-core.txt'],
];

for (const [from, to] of files) {
  copyFileSync(join(root, 'node_modules', from), join(out, to));
}

// The LSTM-only core prints ~10 "Warning: Parameter not found: <legacy
// param>" lines to console.error every time a language initializes —
// the traineddata's embedded config names legacy-engine parameters the
// LSTM build compiles out, and the core warns and moves on. Recognition
// is unaffected, but Chrome's extension-error collector surfaces every
// line as a red error on the Manage-extension page, which reads as "OCR
// is broken". The prints happen inside the worker (it importScripts the
// core), so mute exactly that class there before the core loads.
const workerFile = join(out, 'worker.min.js');
const mute =
  '/* tokori: mute the LSTM core’s harmless legacy-parameter warnings */' +
  ';(()=>{const e=console.error.bind(console);console.error=(...a)=>{' +
  "if(typeof a[0]==='string'&&a[0].startsWith('Warning: Parameter not found:'))return;" +
  'e(...a);};})();\n';
writeFileSync(workerFile, mute + readFileSync(workerFile, 'utf8'));

console.log(`[copy-tesseract] ${files.length} files → public/tesseract/`);
