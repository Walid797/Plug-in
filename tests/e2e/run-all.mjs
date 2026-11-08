// Runs every end-to-end suite sequentially and writes tests/e2e/out/report.txt.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { root, outDir } from './helpers.mjs';

const suites = ['smoke', 'print', 'offline', 'multi', 'failures', 'ai', 'runtimes', 'mobile'];
const only = process.argv.slice(2);
const lines = [`Hoshmand Photo Studio — E2E report (${new Date().toISOString()})`, ''];
let failed = 0;
await fs.mkdir(outDir, { recursive: true });
for (const s of suites.filter((x) => !only.length || only.includes(x))) {
  const t0 = Date.now();
  const out = await new Promise((resolve) => {
    const p = spawn(process.execPath, [path.join(root, 'tests', 'e2e', `${s}.mjs`)], { stdio: ['ignore', 'pipe', 'pipe'] });
    let buf = '';
    p.stdout.on('data', (d) => { buf += d; });
    p.stderr.on('data', (d) => { buf += d; });
    p.on('exit', (code) => resolve({ code, buf }));
  });
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  const status = out.code === 0 ? 'PASS' : 'FAIL';
  if (out.code !== 0) failed += 1;
  lines.push(`== ${s}: ${status} (${secs}s)`);
  lines.push(...out.buf.split('\n').filter((l) => l.trim() && !/^\s+at /.test(l)).slice(-40));
  lines.push('');
  console.log(`${status} ${s} (${secs}s)`);
}
lines.push(failed ? `${failed} suite(s) failed` : 'All suites passed');
await fs.writeFile(path.join(outDir, 'report.txt'), `${lines.join('\n')}\n`);
console.log(failed ? `${failed} suite(s) failed` : 'All suites passed');
process.exit(failed ? 1 : 0);
