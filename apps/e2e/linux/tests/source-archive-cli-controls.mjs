#!/usr/bin/env node
/** Bare archive CLI controls: usage paths must not touch the default output. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const E2E = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = path.join(E2E, 'scripts', 'make-source-archive.mjs');
const DEFAULT_OUT = path.join(E2E, '.source-archive');

function snapshot(root) {
  if (!existsSync(root)) return null;
  const entries = [];
  function walk(dir, rel) {
    for (const name of readdirSync(dir).sort()) {
      const childRel = rel ? `${rel}/${name}` : name;
      const child = path.join(dir, name);
      const stat = lstatSync(child);
      if (stat.isDirectory()) {
        entries.push([childRel, 'directory']);
        walk(child, childRel);
      } else if (stat.isSymbolicLink()) {
        entries.push([childRel, 'symlink', readlinkSync(child)]);
      } else {
        assert.ok(stat.isFile(), `unexpected archive output entry: ${childRel}`);
        entries.push([childRel, 'file', createHash('sha256').update(readFileSync(child)).digest('hex')]);
      }
    }
  }
  walk(root, '');
  return entries;
}

const before = snapshot(DEFAULT_OUT);
const scratchRoot = path.resolve(os.tmpdir());
const scratch = mkdtempSync(path.join(scratchRoot, 'capiro-archive-cli-'));
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
    assert.deepEqual(snapshot(DEFAULT_OUT), before, `${args.join(' ')} changed default archive output`);
    assert.deepEqual(readdirSync(scratch), [], `${args.join(' ')} wrote in the calling directory`);
  }
  console.log('archive CLI controls PASS: noargs/help/unknown write nothing');
} finally {
  const resolved = path.resolve(scratch);
  assert.equal(path.dirname(resolved), scratchRoot, 'scratch cleanup escaped temporary root');
  rmSync(resolved, { recursive: true, force: true });
}
