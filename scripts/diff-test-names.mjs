#!/usr/bin/env node
/** @cleanup-smoke noArgsExit=1 helpExit=1 */
/**
 * diff-test-names — prove test preservation between two dumps.
 *
 * Usage:
 *   node scripts/diff-test-names.mjs --before before.json --after after.json \
 *        [--renames renames.json] [--twins twins.json] \
 *        [--acknowledge-scope scope.json] [--acknowledge-targets targets.json] \
 *        [--out diff.json] [--quiet]
 *
 * Exit codes:
 *   0  only permitted changes (additions / no change / mapped renames / twinned
 *      removals / gained targets) with complete passing evidence and no
 *      unacknowledged scope, target or status change
 *   1  usage error
 *   2  blocked: unexcused removals, invalid maps, status regressions,
 *      non-passing/incomplete evidence, or unacknowledged scope/target change
 *   3  fatal: an input could not be read, or is not a canonical validated dump
 *      (raw/arbitrary JSON is never accepted as an empty passing comparison)
 */

import fs from 'node:fs';
import { diffDumps, loadMapFile } from './test-proof/lib/diff.mjs';
import { DIFF_SCHEMA, SCHEMA_VERSION } from './test-proof/lib/schema.mjs';

function parseArgs(argv) {
  const args = { flags: new Set() };
  const valueFlags = ['before', 'after', 'renames', 'twins', 'acknowledge-scope', 'acknowledge-targets', 'out'];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const eq = a.indexOf('=');
    if (eq !== -1) {
      args[a.slice(2, eq)] = a.slice(eq + 1);
    } else {
      const name = a.slice(2);
      if (valueFlags.includes(name)) {
        args[name] = argv[i + 1];
        i += 1;
      } else {
        args.flags.add(name);
      }
    }
  }
  return args;
}

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.flags.has('help') || !args.before || !args.after) {
    process.stderr.write('usage: node scripts/diff-test-names.mjs --before <dump> --after <dump> [--renames f] [--twins f] [--acknowledge-scope f] [--acknowledge-targets f] [--out f] [--quiet]\n');
    process.exit(1);
  }

  let before;
  let after;
  try {
    before = readJson(args.before);
    after = readJson(args.after);
  } catch (err) {
    process.stderr.write(`diff-test-names: cannot read dumps: ${err.message}\n`);
    process.exit(3);
  }

  let renames = [];
  let twins = [];
  let scopeAcks = [];
  let targetAcks = [];
  try {
    if (args.renames) renames = loadMapFile(readJson(args.renames), 'renames');
    if (args.twins) twins = loadMapFile(readJson(args.twins), 'twins');
    if (args['acknowledge-scope']) scopeAcks = loadMapFile(readJson(args['acknowledge-scope']), 'acknowledgedScope');
    if (args['acknowledge-targets']) targetAcks = loadMapFile(readJson(args['acknowledge-targets']), 'acknowledgedTargets');
  } catch (err) {
    process.stderr.write(`diff-test-names: cannot read map files: ${err.message}\n`);
    process.exit(3);
  }

  const result = diffDumps({ before, after, renames, twins, scopeAcks, targetAcks });

  const invalidInput = result.error === 'invalid-canonical-dump';

  const doc = {
    schema: DIFF_SCHEMA,
    schemaVersion: SCHEMA_VERSION,
    before: { schema: before.schema, runSha: before.runSha ?? null, targets: Array.isArray(before.targets) ? before.targets.length : null },
    after: { schema: after.schema, runSha: after.runSha ?? null, targets: Array.isArray(after.targets) ? after.targets.length : null },
    ...result,
  };

  if (args.out) {
    fs.writeFileSync(args.out, JSON.stringify(doc, null, 2) + '\n');
  }

  if (!args.flags.has('quiet')) {
    const lines = [];
    lines.push(`diff-test-names: before=${result.totals.before} after=${result.totals.after} added=${result.totals.added} removed=${result.totals.removed} changed=${result.totals.changed} removedConsolidated=${result.totals.removedConsolidated} statusRegressions=${result.totals.statusRegressions}`);
    for (const p of result.perPackage) {
      lines.push(`  ${p.package} [${p.runner}] before=${p.before} after=${p.after} added=${p.added} removed=${p.removed} changed=${p.changed} consolidated=${p.removedConsolidated}`);
    }
    if (result.scopeChanged.added.length) lines.push(`  scope-added (permitted): ${result.scopeChanged.added.join(', ')}`);
    if (result.scopeChanged.targetsAdded.length) lines.push(`  target-added (permitted): ${result.scopeChanged.targetsAdded.join(', ')}`);
    if (result.scopeChanged.removed.length) lines.push(`  scope-removed: ${result.scopeChanged.removed.join(', ')}`);
    if (result.scopeChanged.runnerChanged.length) lines.push(`  scope-runner-changed: ${result.scopeChanged.runnerChanged.join(', ')}`);
    if (result.scopeChanged.targetsRemoved.length) lines.push(`  target-removed: ${result.scopeChanged.targetsRemoved.join(', ')}`);
    if (result.scopeChanged.tierChanged.length) lines.push(`  target-tier-changed: ${result.scopeChanged.tierChanged.join(', ')}`);
    if (result.scopeChanged.acknowledged.length) lines.push(`  scope-acknowledged: ${result.scopeChanged.acknowledged.join(', ')}`);
    if (result.scopeChanged.targetsAcknowledged.length) lines.push(`  target-acknowledged: ${result.scopeChanged.targetsAcknowledged.join(', ')}`);
    for (const c of result.changed) lines.push(`  changed: ${c.from}  ->  ${c.to}${c.crossScope ? ' [cross-scope]' : ''}`);
    for (const c of result.removedConsolidated) lines.push(`  consolidated: ${c.removedSuite} :: ${c.fullName} (survivor ${c.survivorSuite})`);
    for (const s of result.statusChanges) lines.push(`  status: ${s.identity} before=${JSON.stringify(s.before)} after=${JSON.stringify(s.after)} (${s.detail.join('; ')})`);
    const ev = result.evidence || { before: {}, after: {} };
    for (const m of ev.before.incomplete || []) lines.push(`  EVIDENCE-INCOMPLETE: ${m}`);
    for (const m of ev.after.incomplete || []) lines.push(`  EVIDENCE-INCOMPLETE: ${m}`);
    for (const m of ev.before.collectionOnly || []) lines.push(`  COLLECTION-ONLY: ${m}`);
    for (const m of ev.after.collectionOnly || []) lines.push(`  COLLECTION-ONLY: ${m}`);
    for (const p of result.problems) lines.push(`  BLOCK: ${p}`);
    if (invalidInput) lines.push('RESULT: INVALID INPUT (not a canonical validated dump; arbitrary JSON is never an empty passing comparison)');
    else lines.push(result.ok ? 'RESULT: PASS (only permitted changes, complete passing evidence)' : 'RESULT: BLOCKED');
    process.stderr.write(lines.join('\n') + '\n');
    if (args.out) process.stderr.write(`wrote ${args.out}\n`);
  }

  if (invalidInput) process.exit(3);
  process.exit(result.ok ? 0 : 2);
}

main();
