#!/usr/bin/env node
/** @cleanup-smoke noArgsExit=0 helpExit=0 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { run as inspectOwners } from './check-registry-ownership.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// This finite inventory names reviewed helpers. The ownership inspector checks
// their declarations, named import edges and pinned callers without executing
// application code. Renamed or semantic copies are outside this source ratchet.
export function inspectHelperInventory(config, inventory) {
  const errors = [];
  if (!config || !Array.isArray(config.profiles) || typeof inventory !== 'string')
    return { errors: ['invalid helper inventory input'], helpers: 0 };
  const expected = new Set();
  for (const profile of config.profiles) {
    if (typeof profile?.id !== 'string' || !Array.isArray(profile.symbols)) {
      errors.push('invalid helper ownership profile');
      continue;
    }
    for (const symbol of profile.symbols)
      if (symbol?.kind === 'function') {
        const key = `${profile.id}\t${symbol.name}`;
        if (expected.has(key)) errors.push(`duplicate owned helper: ${key}`);
        expected.add(key);
      }
  }
  const actual = new Set();
  for (const line of inventory.split(/\r?\n/)) {
    if (!line || line.startsWith('#')) continue;
    if (!/^[A-Za-z0-9_-]+\t[A-Za-z_$][\w$]*$/.test(line)) {
      errors.push(`invalid helper inventory row: ${line}`);
      continue;
    }
    if (actual.has(line)) errors.push(`duplicate helper inventory row: ${line}`);
    actual.add(line);
    if (!expected.has(line)) errors.push(`unowned helper inventory row: ${line}`);
  }
  if (expected.size === 0 || actual.size === 0) errors.push('empty helper inventory');
  for (const key of expected)
    if (!actual.has(key)) errors.push(`missing helper inventory row: ${key}`);
  return { errors, helpers: actual.size };
}

export function run(root = ROOT) {
  const config = JSON.parse(
    readFileSync(path.join(root, 'scripts/registry-ownership.json'), 'utf8'),
  );
  const inventory = readFileSync(path.join(root, 'scripts/duplicate-helper-names.txt'), 'utf8');
  const result = inspectHelperInventory(config, inventory);
  const ownership = inspectOwners(root);
  return {
    errors: [...result.errors, ...ownership.errors],
    helpers: result.helpers,
    profiles: ownership.profiles,
    files: ownership.files,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) {
    process.stdout.write(
      'Usage: node scripts/check-duplicate-helpers.mjs\nInspect the finite reviewed helper inventory and canonical source ownership.\n',
    );
  } else if (args.length) {
    process.stderr.write('Unsupported duplicate helper arguments\n');
    process.exitCode = 1;
  } else {
    try {
      const result = run();
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      if (result.errors.length) process.exitCode = 1;
    } catch (error) {
      process.stderr.write(`Duplicate helper inspection failed: ${error.message}\n`);
      process.exitCode = 1;
    }
  }
}
