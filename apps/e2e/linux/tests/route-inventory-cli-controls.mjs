#!/usr/bin/env node
/** Bare route-inventory CLI invocations must leave the committed graph untouched. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const E2E = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = path.join(E2E, 'scripts', 'build-route-inventory.mjs');
const INVENTORY = path.join(E2E, 'routes.inventory.json');
const digest = () => createHash('sha256').update(readFileSync(INVENTORY)).digest('hex');
const before = { hash: digest(), mtimeMs: statSync(INVENTORY).mtimeMs };
const scratchRoot = path.resolve(os.tmpdir());
const scratch = mkdtempSync(path.join(scratchRoot, 'capiro-inventory-cli-'));

try {
  for (const { args, exit } of [
    { args: [], exit: 2 },
    { args: ['--help'], exit: 0 },
    { args: ['-h'], exit: 0 },
    { args: ['--unknown'], exit: 2 },
    { args: ['--write', 'extra'], exit: 2 },
  ]) {
    const result = spawnSync(process.execPath, [SCRIPT, ...args], {
      cwd: scratch,
      encoding: 'utf8',
      timeout: 15000,
      windowsHide: true,
    });
    assert.equal(result.error, undefined, `${args.join(' ')} spawn error`);
    assert.equal(result.signal, null, `${args.join(' ')} signalled`);
    assert.equal(result.status, exit, `${args.join(' ')} exit: ${result.stderr}`);
    assert.match(`${result.stdout}${result.stderr}`, /Usage:/, `${args.join(' ')} usage`);
    assert.deepEqual({ hash: digest(), mtimeMs: statSync(INVENTORY).mtimeMs }, before,
      `${args.join(' ')} touched the committed inventory`);
    assert.deepEqual(readdirSync(scratch), [], `${args.join(' ')} wrote in the calling directory`);
  }
  console.log('route inventory CLI controls PASS: noargs/help/unknown leave inventory untouched');
} finally {
  const resolved = path.resolve(scratch);
  assert.equal(path.dirname(resolved), scratchRoot, 'scratch cleanup escaped temporary root');
  rmSync(resolved, { recursive: true, force: true });
}
