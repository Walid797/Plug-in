// Downloads the optional face-restoration model (GFPGAN v1.4, ONNX, ~340 MB) into models/onnx/ and verifies its
// SHA-256 against the app's registry. Used by the desktop installer build so the installer carries the model;
// anyone can also run it by hand:  node tools/fetch-optional-models.mjs
// The file comes from the public release of the facefusion-assets project. Its output was compared with the
// official GFPGANv1.4 weights (same picture up to the model's noise input; see docs/ai-models.md).
import { createHash } from 'node:crypto';
import { promises as fs, createWriteStream } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { findModel, hashAccepted } from '../src/ai/registry.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const URL_ = 'https://github.com/facefusion/facefusion-assets/releases/download/models-3.0.0/gfpgan_1.4.onnx';
const model = findModel('gfpgan');
const dest = path.join(root, model.path);

async function sha256(file) {
  const h = createHash('sha256'); const f = await fs.open(file);
  try { for await (const chunk of f.createReadStream()) h.update(chunk); } finally { await f.close(); }
  return h.digest('hex');
}

const have = await fs.stat(dest).catch(() => null);
if (have && hashAccepted(model, await sha256(dest))) { console.log(`${model.path} already present and verified`); process.exit(0); }
console.log(`downloading ${URL_}`);
const res = await fetch(URL_, { redirect: 'follow' });
if (!res.ok || !res.body) { console.error(`download failed: HTTP ${res.status}`); process.exit(1); }
await fs.mkdir(path.dirname(dest), { recursive: true });
const tmp = `${dest}.part`;
await pipeline(Readable.fromWeb(res.body), createWriteStream(tmp));
const hash = await sha256(tmp);
if (!hashAccepted(model, hash)) { await fs.rm(tmp, { force: true }); console.error(`checksum mismatch (${hash}); the file was discarded`); process.exit(1); }
await fs.rename(tmp, dest);
console.log(`${model.path} verified (${hash}), ${((await fs.stat(dest)).size / 1048576).toFixed(0)} MB`);
