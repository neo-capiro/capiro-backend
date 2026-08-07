#!/usr/bin/env node
/** Run browser parity, then replay its observed Engagement GETs before the local runner removes auth material. */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

async function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: ROOT,
      env: process.env,
      shell: process.platform === 'win32',
      stdio: 'inherit',
    });
    child.on('error', reject);
    child.on('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`${command} ${args.join(' ')} failed with exit ${code}`)),
    );
  });
}

await run('node', ['apps/web/scripts/engagement-phase3-browser-parity.mjs']);
await run('node', ['scripts/engagement-phase3-api-replay.mjs']);
console.log('ENGAGEMENT_PHASE3_BROWSER_AND_READ_PARITY_COMPLETE');
