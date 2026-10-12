#!/usr/bin/env node
/** @cleanup-smoke noArgsExit=0 helpExit=0 */

/**
 * MeriV2 Phase 17 ethical-wall literal gate.
 *
 * `ethicalWallAllowed` is the SERVER-DERIVED decision that a ContextRequest's
 * actor may see its client's walled memory (packages/meriv2-core
 * context/contract.ts). A literal `true` in live source is a grant nobody
 * derived, so every one must be removed or carry a reviewed reason below.
 *
 * This replaces an inline `rg ... || true` check that never ran: ubuntu-latest
 * does not ship ripgrep, the searches printed "rg: command not found", and the
 * `|| true` turned that into a pass. The gate therefore fails closed on anything
 * it cannot verify — a git error, an empty file list, a list that no longer
 * contains the Context Plane compiler, or an allowlist entry that has gone stale.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parseArgs, withUsage } from './cleanup-gates/lib/cli.mjs';

const SEARCH_ROOTS = ['apps', 'packages'];
const SOURCE_FILE = /\.(?:[cm]?ts|tsx)$/;
const TEST_FILE = /\.(?:spec|test)\.(?:[cm]?ts|tsx)$/;
const WALL_LITERAL = /['"]?\bethicalWallAllowed['"]?\s*:\s*true\b/;

/**
 * A file every real scan must include. If it is missing, the file list is
 * wrong (bad cwd, sparse checkout, renamed roots), not clean.
 */
export const SENTINEL_FILE = 'apps/api/src/context/context-compiler.service.ts';

/**
 * Reviewed exceptions: an EXACT trimmed source line plus the reason it cannot
 * admit walled client memory to an actor without a client_memory_access grant.
 * An entry stops matching the moment its line changes, and an entry that no
 * longer matches anything fails the gate, so this cannot rot into a waiver.
 *
 * Empty on purpose. The three Phase 22/23/26 literals this gate first caught
 * (d8a97dfec) now derive the flag from their actor-scoped security envelope.
 */
export const ALLOWED_WALL_LITERALS = [];

/** Live (non-test) TypeScript source under the search roots, tracked by git. */
export function listSourceFiles(cwd) {
  const out = execFileSync('git', ['ls-files', '-z', '--', ...SEARCH_ROOTS], {
    cwd,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return out
    .split('\0')
    .filter((file) => SOURCE_FILE.test(file) && !TEST_FILE.test(file))
    .sort();
}

export function findWallLiterals(files, readFile) {
  const matches = [];
  for (const file of files) {
    readFile(file)
      .split(/\r?\n/)
      .forEach((text, index) => {
        if (WALL_LITERAL.test(text)) matches.push({ file, lineNumber: index + 1, text });
      });
  }
  return matches;
}

export function evaluate(matches, allowlist = ALLOWED_WALL_LITERALS) {
  const isAllowed = (match) =>
    allowlist.some((entry) => entry.file === match.file && entry.line === match.text.trim());
  return {
    violations: matches.filter((match) => !isAllowed(match)),
    allowed: matches.filter(isAllowed),
    stale: allowlist.filter(
      (entry) =>
        !matches.some((match) => match.file === entry.file && match.text.trim() === entry.line),
    ),
  };
}

function main() {
  const cwd = process.cwd();
  const files = listSourceFiles(cwd);
  if (files.length === 0 || !files.includes(SENTINEL_FILE)) {
    console.error(
      `Ethical-wall gate scanned ${files.length} file(s) and did not see ${SENTINEL_FILE}; ` +
        'refusing to report a clean result for a scan that did not cover the Context Plane.',
    );
    process.exitCode = 2;
    return;
  }

  const matches = findWallLiterals(files, (file) => readFileSync(`${cwd}/${file}`, 'utf8'));
  const { violations, allowed, stale } = evaluate(matches);

  for (const match of allowed) {
    const entry = ALLOWED_WALL_LITERALS.find(
      (candidate) => candidate.file === match.file && candidate.line === match.text.trim(),
    );
    console.log(`allowlisted ${match.file}:${match.lineNumber} — ${entry.reason}`);
  }
  if (violations.length > 0) {
    console.error('Live ethical-wall bypass found:');
    for (const match of violations) {
      console.error(`${match.file}:${match.lineNumber}:${match.text.trim()}`);
    }
    console.error(
      'Derive the flag from the actor and client (see apps/api/src/memory/memory-wall.helpers.ts), ' +
        'or add a reviewed entry with its reason to ALLOWED_WALL_LITERALS in scripts/check-ethical-wall-literals.mjs.',
    );
  }
  if (stale.length > 0) {
    console.error('Stale ethical-wall allowlist entries (the line changed or was removed):');
    for (const entry of stale) console.error(`${entry.file}: ${entry.line}`);
  }
  if (violations.length > 0 || stale.length > 0) {
    process.exitCode = 1;
    return;
  }
  console.log(
    `Ethical-wall gate PASS: ${files.length} live source file(s) scanned, ` +
      `${allowed.length} allowlisted literal(s), 0 unreviewed.`,
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const usage = 'Usage: node scripts/check-ethical-wall-literals.mjs [--help]';
  withUsage(() => {
    const args = parseArgs(process.argv.slice(2), {});
    if (args.help) {
      console.log(usage);
      process.exit(0);
    }
  }, usage)();
  console.error(usage);
  try {
    main();
  } catch (error) {
    console.error(
      `Ethical-wall gate could not run: ${error instanceof Error ? error.message : error}`,
    );
    // Never turn an unavailable scan into a pass.
    process.exitCode = 2;
  }
}
