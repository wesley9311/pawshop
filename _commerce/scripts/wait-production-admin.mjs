import { spawnSync } from 'node:child_process';

const verifier = new URL('./verify-production-admin.mjs', import.meta.url);
const deadlineAt = Date.now() + 120000;
const intervalMs = 1000;
const verifierTimeoutMs = 5000;

while (Date.now() < deadlineAt) {
  const remainingMs = deadlineAt - Date.now();
  const result = spawnSync(process.execPath, [verifier.pathname], {
    env: process.env,
    stdio: 'ignore',
    timeout: Math.max(1, Math.min(verifierTimeoutMs, remainingMs)),
  });
  if (result.status === 0) process.exit(0);
  const sleepMs = Math.min(intervalMs, Math.max(0, deadlineAt - Date.now()));
  if (sleepMs > 0) await new Promise(resolve => setTimeout(resolve, sleepMs));
}

throw new Error('Production admin did not pass its private boundary within 120 seconds.');
