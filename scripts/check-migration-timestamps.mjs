#!/usr/bin/env node
/**
 * Migration directory timestamp guard.
 *
 * WHY THIS EXISTS
 * ---------------
 * apps/api migration directory names are not produced by `prisma migrate dev`.
 * They are hand-written, and the documented convention is "pick a timestamp that
 * sorts after the latest migration on origin/main" (see
 * docs/plans/funding-opportunities-makegov-v1/independent-review/FIX-PLAN-p08-idempotency.md).
 *
 * That rule is a RATCHET, not a clock. With many parallel worktrees each
 * advancing the frontier by a day or more, the frontier outruns real time. By
 * 2026-09-20 apps/api names had drifted +730 days (exactly two years) ahead,
 * while apps/intel-api — same authors, same commits, same machines — stayed on
 * real dates. The year became a stuck carry: recent names use the real month and
 * day with the year forced to 2028.
 *
 * The ratchet is not wrong to want: lexicographic directory order is the order
 * migrations replay onto a FRESH database, so a new migration must sort after
 * everything already applied. This guard keeps that property while bounding the
 * drift, by making the offset an explicit, reviewed constant instead of an
 * emergent one.
 *
 * WHAT IT CHECKS (new migrations only — existing directories are grandfathered
 * and must never be renamed, because renaming an applied migration causes
 * Prisma drift errors against prod and the shared local fixture DB)
 *
 *   1. STRUCTURAL   month 1-12, day 1-31, hour < 24, minute < 60, second < 60.
 *                   Six existing directories violate this today (e.g.
 *                   20280913016000 = "minute 60"), proving the names are string
 *                   arithmetic, not clock reads.
 *   2. OFFSET       |dirname date - (commit date + yearOffset)| <= toleranceDays.
 *                   yearOffset is per-tree and checked in. Raising it is a
 *                   deliberate, reviewable edit — which is the gate that was
 *                   missing.
 *   3. ORDERING     the new name sorts strictly after the highest existing name
 *                   in its own tree, preserving fresh-replay order.
 *
 * Usage:
 *   node scripts/check-migration-timestamps.mjs [--base <ref>]
 * Requires full history for the base ref (actions/checkout with fetch-depth: 0).
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const CONFIG_PATH =
  process.env.MIGRATION_OFFSETS_CONFIG ?? 'scripts/migration-timestamp-offsets.json';

const argv = process.argv.slice(2);
const baseArgIdx = argv.indexOf('--base');
const baseRef = baseArgIdx >= 0 ? argv[baseArgIdx + 1] : 'origin/main';

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
/** Same, but a missing path/ref is an expected outcome — keep git's noise out of the log. */
const gitQuiet = (...args) =>
  execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();

/** Parse a 14-char YYYYMMDDHHMMSS prefix. Returns { ok, date?, reason? }. */
function parsePrefix(ts) {
  const y = +ts.slice(0, 4);
  const mo = +ts.slice(4, 6);
  const d = +ts.slice(6, 8);
  const h = +ts.slice(8, 10);
  const mi = +ts.slice(10, 12);
  const s = +ts.slice(12, 14);
  if (mo < 1 || mo > 12) return { ok: false, reason: `month ${mo} out of range` };
  if (d < 1 || d > 31) return { ok: false, reason: `day ${d} out of range` };
  if (h > 23) return { ok: false, reason: `hour ${h} out of range` };
  if (mi > 59) return { ok: false, reason: `minute ${mi} out of range` };
  if (s > 59) return { ok: false, reason: `second ${s} out of range` };
  return { ok: true, date: new Date(Date.UTC(y, mo - 1, d, h, mi, s)) };
}

const config = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
const trees = Object.entries(config).filter(([k]) => !k.startsWith('_'));

let base;
try {
  base = git('merge-base', baseRef, 'HEAD');
} catch {
  console.error(`Cannot resolve merge-base with ${baseRef}. Use actions/checkout with fetch-depth: 0.`);
  process.exit(2);
}

/** Migration directory names present in a tree at a given rev. */
function namesAt(rev, tree) {
  let out = '';
  try {
    out = gitQuiet('ls-tree', '--name-only', `${rev}:${tree}`);
  } catch {
    return [];
  }
  return out
    .split('\n')
    .map((l) => l.replace(/\/$/, '').trim())
    .filter((l) => /^\d{14}_/.test(l));
}

const violations = [];

for (const [tree, rule] of trees) {
  const yearOffset = rule.yearOffset ?? 0;
  const toleranceDays = rule.toleranceDays ?? 7;

  const before = new Set(namesAt(base, tree));
  const after = namesAt('HEAD', tree);
  const added = after.filter((n) => !before.has(n));
  if (added.length === 0) continue;

  const maxBefore = [...before].sort().pop() ?? '';

  for (const name of added) {
    const ts = name.slice(0, 14);

    // The commit that introduced this directory, on this branch.
    let commitIso;
    try {
      commitIso = git(
        'log', '--diff-filter=A', '--format=%aI', '-1',
        `${base}..HEAD`, '--', `${tree}/${name}`,
      );
    } catch {
      commitIso = '';
    }
    if (!commitIso) commitIso = git('log', '--format=%aI', '-1', 'HEAD');

    // 1. structural
    const parsed = parsePrefix(ts);
    if (!parsed.ok) {
      violations.push(`${tree}/${name}\n    not a real timestamp: ${parsed.reason}`);
      continue;
    }

    // 2. offset from the commit date
    const commit = new Date(commitIso);
    const expected = new Date(commit.getTime());
    expected.setUTCFullYear(expected.getUTCFullYear() + yearOffset);
    const driftDays = (parsed.date.getTime() - expected.getTime()) / 86_400_000;
    if (Math.abs(driftDays) > toleranceDays) {
      const want = new Date(expected.getTime());
      const suggest =
        `${want.getUTCFullYear()}` +
        `${String(want.getUTCMonth() + 1).padStart(2, '0')}` +
        `${String(want.getUTCDate()).padStart(2, '0')}` +
        '010000';
      violations.push(
        `${tree}/${name}\n` +
        `    dirname timestamp is ${driftDays >= 0 ? '+' : ''}${driftDays.toFixed(1)} days from the expected\n` +
        `    value (commit date ${commitIso.slice(0, 10)} + yearOffset ${yearOffset}), tolerance is ${toleranceDays}d.\n` +
        `    Rename to something near ${suggest}, or, if the frontier genuinely\n` +
        `    needs to move, raise yearOffset for this tree in ${CONFIG_PATH} in this PR.`,
      );
      continue;
    }

    // 3. fresh-replay ordering
    if (maxBefore && name <= maxBefore) {
      violations.push(
        `${tree}/${name}\n` +
        `    sorts at or before the existing maximum ${maxBefore}.\n` +
        `    Directory order is fresh-database replay order, so a new migration must sort strictly after it.`,
      );
    }
  }
}

if (violations.length > 0) {
  console.error('Migration timestamp guard FAILED:\n');
  for (const v of violations) console.error('  ' + v + '\n');
  console.error(
    'Existing migrations are grandfathered — never rename a directory that has been applied.\n' +
    'This check only applies to migrations added by this PR.',
  );
  process.exit(1);
}

console.log('Migration timestamp guard passed.');
