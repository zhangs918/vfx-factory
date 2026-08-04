import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const assetRoot = path.join(root, 'public/assets/quarks');
const candidates = JSON.parse(fs.readFileSync(path.join(assetRoot, 'manifest.candidates.json'), 'utf8'));
const baseUrl = process.env.VFX_URL ?? 'http://127.0.0.1:5173';

function run(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd: root, stdio: 'inherit', ...options });
    child.on('exit', (code, signal) => resolve(signal ? 1 : (code ?? 1)));
  });
}

let server;
try {
  if (!process.env.VFX_URL) {
    server = spawn('npm', ['run', 'dev', '--', '--host', '127.0.0.1'], {
      cwd: root,
      stdio: 'ignore',
    });
    let ready = false;
    for (let i = 0; i < 80; i++) {
      try {
        const response = await fetch(baseUrl);
        if (response.ok) { ready = true; break; }
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    if (!ready) throw new Error(`Vite did not become ready at ${baseUrl}`);
  }

  let failed = false;
  for (const entry of candidates.effects ?? []) {
    const code = await run(process.execPath, [
      path.join(root, 'scripts/compare_live_to_oracle.mjs'),
      `--effect=${entry.id}`,
    ], { env: { ...process.env, VFX_URL: baseUrl } });
    if (code !== 0) failed = true;
  }
  const promoteCode = await run(process.execPath, [path.join(root, 'scripts/promote_live_ir.mjs')]);
  if (failed || promoteCode !== 0) process.exitCode = 1;
} finally {
  server?.kill('SIGTERM');
}
