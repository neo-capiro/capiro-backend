#!/usr/bin/env node
/**
 * Phase 2 scope check — did a given commit range touch forbidden paths?
 *
 * Extracted from the inline gate in verify-engagement-phase2-code.sh as the
 * repair for finding F-001. The bug was not the assertion but its range: the
 * gate compared PHASE2_BASE..HEAD, so it re-evaluated on every descendant
 * commit and reported any later phase's legitimate change as a Phase 2 scope
 * violation. Phase 3 must change apps/web — the plan specifies the very path
 * that tripped it.
 *
 * Scoping the range to Phase 2's own commits keeps the assertion's meaning
 * ("Phase 2 did not touch product web") and stops it producing a false failure
 * on branches that come after.
 *
 * The predicate is exported and pure so the negative controls can prove it
 * bites, rather than testing that a shell `grep` was spelled correctly.
 *
 * Usage:
 *   node scripts/verify-engagement-phase2-scope.mjs --base <sha> --head <sha> \
 *     --forbid '^apps/web/' [--label 'product web source']
 *
 * Exit: 0 the range touches nothing forbidden · 1 it does
 */
import { execFileSync } from 'node:child_process';

/** Pure predicate: which of `files` match any of `forbidden` (regex sources)? */
export function violations(files, forbidden) {
  const patterns = forbidden.map((source) => new RegExp(source));
  return files.filter((file) => patterns.some((pattern) => pattern.test(file))).sort();
}

/** Files changed in base..head. An empty or invalid range throws. */
export function filesInRange(base, head, cwd = process.cwd()) {
  const out = execFileSync('git', ['diff', '--name-only', `${base}`, `${head}`], {
    cwd,
    encoding: 'utf8',
  });
  return out.split('\n').map((line) => line.trim()).filter(Boolean);
}

function parseArgs(argv) {
  const args = { forbid: [], label: 'forbidden paths' };
  for (let i = 0; i < argv.length; i += 1) {
    const next = argv[i + 1];
    if (argv[i] === '--base') args.base = next;
    else if (argv[i] === '--head') args.head = next;
    else if (argv[i] === '--forbid') args.forbid.push(next);
    else if (argv[i] === '--label') args.label = next;
  }
  return args;
}

function main(argv) {
  const args = parseArgs(argv);
  if (!args.base || !args.head || args.forbid.length === 0) {
    console.error(
      'usage: verify-engagement-phase2-scope.mjs --base <sha> --head <sha> --forbid <regex> [--label <text>]',
    );
    return 1;
  }

  let files;
  try {
    files = filesInRange(args.base, args.head);
  } catch (error) {
    console.error(`cannot diff ${args.base}..${args.head}: ${error.message}`);
    return 1;
  }

  const offending = violations(files, args.forbid);
  if (offending.length > 0) {
    console.error(`FAIL  ${args.label} changed in ${args.base}..${args.head}:`);
    for (const file of offending) console.error(`  ${file}`);
    return 1;
  }
  console.log(`OK  no ${args.label} change in ${args.base}..${args.head} (${files.length} files in range)`);
  return 0;
}

if (process.argv[1]?.endsWith('verify-engagement-phase2-scope.mjs')) {
  process.exit(main(process.argv.slice(2)));
}
