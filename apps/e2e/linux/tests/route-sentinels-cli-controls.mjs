#!/usr/bin/env node
/** Check the sentinel CLI boundary against the committed, reviewed output. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SOURCE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const scratchRoot = path.resolve(os.tmpdir());
const scratch = mkdtempSync(path.join(scratchRoot, 'capiro-sentinel-cli-'));
const e2e = path.join(scratch, 'apps', 'e2e');
const script = path.join(e2e, 'scripts', 'gen-route-sentinels.mjs');
const output = path.join(e2e, 'route-sentinels.json');
const inputs = [
  'scripts/gen-route-sentinels.mjs',
  'lib/projects.mjs',
  'routes.inventory.json',
  'route-sentinels.overlay.json',
  'route-content-observed.json',
  'route-content-unclean.json',
];
const digest = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
const invoke = (args) => spawnSync(process.execPath, [script, ...args], {
  cwd: scratch,
  encoding: 'utf8',
  timeout: 15000,
  windowsHide: true,
});

try {
  for (const rel of inputs) {
    const dest = path.join(e2e, rel);
    mkdirSync(path.dirname(dest), { recursive: true });
    copyFileSync(path.join(SOURCE, rel), dest);
  }
  const before = inputs.map((rel) => {
    const file = path.join(e2e, rel);
    return [rel, digest(file), statSync(file).mtimeMs];
  });
  for (const { args, exit } of [
    { args: [], exit: 2 },
    { args: ['--help'], exit: 0 },
    { args: ['-h'], exit: 0 },
    { args: ['--unknown'], exit: 2 },
    { args: ['--write', 'extra'], exit: 2 },
  ]) {
    const result = invoke(args);
    assert.equal(result.error, undefined, `${args.join(' ')} spawn error`);
    assert.equal(result.signal, null, `${args.join(' ')} signalled`);
    assert.equal(result.status, exit, `${args.join(' ')} exit: ${result.stderr}`);
    assert.match(`${result.stdout}${result.stderr}`, /Usage:/, `${args.join(' ')} usage`);
    assert.equal(existsSync(output), false, `${args.join(' ')} wrote route coverage`);
    assert.deepEqual(inputs.map((rel) => {
      const file = path.join(e2e, rel);
      return [rel, digest(file), statSync(file).mtimeMs];
    }), before, `${args.join(' ')} changed an input`);
  }

  const write = invoke(['--write']);
  assert.equal(write.error, undefined, 'explicit write spawn error');
  assert.equal(write.signal, null, 'explicit write signalled');
  assert.equal(write.status, 0, `explicit write exit: ${write.stderr}`);
  assert.ok(existsSync(output), 'explicit write did not create the fixed output');
  assert.ok(readFileSync(output).equals(readFileSync(path.join(SOURCE, 'route-sentinels.json'))),
    'explicit write changed the reviewed sentinel output bytes');
  console.log(`sentinel CLI controls PASS: resource-free usage and reviewed output ${digest(output)}`);
} finally {
  const resolved = path.resolve(scratch);
  assert.equal(path.dirname(resolved), scratchRoot, 'scratch cleanup escaped temporary root');
  rmSync(resolved, { recursive: true, force: true });
}
