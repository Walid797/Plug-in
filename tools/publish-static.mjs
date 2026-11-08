// Assemble the files a static host (e.g. Render) should serve into ./public.
// Zero dependencies — runs with plain Node. Only the allow-listed runtime files
// are published; source code, tests, tooling and configuration never are.
//   node tools/publish-static.mjs
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'public');
const FILES = ['index.html', 'sw.js', 'manifest.webmanifest', 'THIRD_PARTY_NOTICES.md'];
const DIRS = ['app', 'vendor', 'models', 'icons', 'docs'];

async function copyDir(src, dest) {
  await fs.mkdir(dest, { recursive: true });
  let count = 0; let bytes = 0;
  for (const e of await fs.readdir(src, { withFileTypes: true })) {
    if (e.name.startsWith('.')) continue;
    const s = path.join(src, e.name); const d = path.join(dest, e.name);
    if (e.isDirectory()) { const r = await copyDir(s, d); count += r.count; bytes += r.bytes; }
    else if (e.isFile()) { await fs.copyFile(s, d); count += 1; bytes += (await fs.stat(s)).size; }
  }
  return { count, bytes };
}

await fs.rm(out, { recursive: true, force: true });
await fs.mkdir(out, { recursive: true });
let total = { count: 0, bytes: 0 };
for (const f of FILES) {
  await fs.copyFile(path.join(root, f), path.join(out, f));
  total.count += 1; total.bytes += (await fs.stat(path.join(root, f))).size;
}
for (const d of DIRS) {
  const r = await copyDir(path.join(root, d), path.join(out, d));
  total = { count: total.count + r.count, bytes: total.bytes + r.bytes };
}
// sanity checks: the build output must exist and be self-contained
for (const must of ['app/app.js', 'app/app.css', 'vendor/mediapipe/wasm/vision_wasm_internal.wasm', 'models/mediapipe/face_landmarker.task']) {
  await fs.access(path.join(out, must));
}
console.log(`public/: ${total.count} files, ${(total.bytes / 1048576).toFixed(1)} MiB`);
