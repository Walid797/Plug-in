// Copies the built web app (what the local launcher serves) into desktop/www, so the installer carries everything:
// the app, the fonts, the WASM runtimes and the AI models. Run `node tools/build.mjs` in the repository root first.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const www = path.join(here, 'www');
const FILES = ['index.html', 'sw.js', 'manifest.webmanifest'];
const DIRS = ['app', 'vendor', 'models', 'icons'];

await fs.rm(www, { recursive: true, force: true });
await fs.mkdir(www, { recursive: true });
for (const f of FILES) await fs.copyFile(path.join(root, f), path.join(www, f));
for (const d of DIRS) await fs.cp(path.join(root, d), path.join(www, d), { recursive: true });
const need = ['index.html', 'app/app.js', 'models'];
for (const n of need) await fs.access(path.join(www, n)).catch(() => { throw new Error(`missing ${n}: run "node tools/build.mjs" in the repository root first`); });
console.log('desktop/www ready');
