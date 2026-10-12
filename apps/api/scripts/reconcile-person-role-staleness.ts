/**
 * reconcile-person-role-staleness.ts
 *
 *   tsx scripts/reconcile-person-role-staleness.ts            # DRY RUN (counts + samples)
 *   tsx scripts/reconcile-person-role-staleness.ts --commit   # set stale_at
 *   flags: --limit=N        (cap marks this run; 0 = all)
 *          --threshold=DAYS (re-assertion window; default 180)
 *
 * A `person_role` asserts that, as of `observed_at`, a person held a role on an
 * office/program. Roles are NOT re-asserted on every sync — they decay. This scans
 * reviewable roles (review_status accepted/candidate) that are not yet stale and,
 * for any whose `observed_at` is older than the threshold without re-assertion,
 * sets `stale_at`. The decision is delegated to the pure `classifyRoleStaleness`
 * (see personnel-staleness.ts). Idempotent: rows that already have `stale_at` are
 * skipped, so re-running marks nothing new.
 *
 * NOTE: this script only FLAGS roles (sets stale_at); it never deletes or hides
 * anything. Display surfaces (the PE program-team panel) still SHOW a stale role,
 * badged "Stale — verify before use". The hard exclusion of stale roles from
 * lobbying/outreach AUDIENCES is enforced by the Step 3.2 action-recommendation
 * generator (which checks stale_at alongside the contact-use policy) — that
 * consumer does not exist yet, so today stale_at is a display marker only.
 *
 * The current time is captured ONCE into `now` and passed both as the classifier's
 * clock and as the `stale_at` value written, so a single run stamps a consistent
 * timestamp across all rows it marks.
 */
import { config as dotenvConfig } from 'dotenv';
import { PrismaClient } from '@prisma/client';
import {
  classifyRoleStaleness,
  DEFAULT_ROLE_STALENESS_THRESHOLD_DAYS,
} from '../src/acquisition-personnel/staleness/personnel-staleness.js';

dotenvConfig();

const COMMIT = process.argv.includes('--commit');

function numArg(name: string, def: number): number {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (!hit) return def;
  const v = Number(hit.split('=')[1]);
  return Number.isFinite(v) ? v : def;
}

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    console.error('Usage: apps/api/scripts/reconcile-person-role-staleness.ts requires DATABASE_URL (database configuration is required)');
    process.exit(2);
  }
  const limit = numArg('limit', 0);
  const thresholdDays = numArg('threshold', DEFAULT_ROLE_STALENESS_THRESHOLD_DAYS);
  // Capture the clock ONCE so the classifier and the stamped stale_at agree.
  const now = new Date();

  const prisma = new PrismaClient();
  await prisma.$connect();
  try {
    const roles = await prisma.personRole.findMany({
      where: {
        reviewStatus: { in: ['accepted', 'candidate'] },
        staleAt: null,
      },
      select: {
        id: true,
        roleTitle: true,
        observedAt: true,
        staleAt: true,
      },
    });

    const toMark: typeof roles = [];
    let kept = 0;
    let skipped = 0;
    for (const r of roles) {
      const decision = classifyRoleStaleness({
        observedAt: r.observedAt,
        staleAt: r.staleAt,
        now,
        thresholdDays,
      });
      if (decision.action === 'mark_stale') {
        toMark.push(r);
      } else if (decision.action === 'keep') {
        kept += 1;
      } else {
        skipped += 1;
      }
    }

    const capped = limit > 0 ? toMark.slice(0, limit) : toMark;

    let marked = 0;
    if (COMMIT && capped.length > 0) {
      const BATCH = 500;
      for (let i = 0; i < capped.length; i += BATCH) {
        const ids = capped.slice(i, i + BATCH).map((r) => r.id);
        const res = await prisma.personRole.updateMany({
          where: { id: { in: ids }, staleAt: null },
          data: { staleAt: now },
        });
        marked += res.count;
      }
    }

    console.log(
      JSON.stringify(
        {
          mode: COMMIT ? 'COMMIT' : 'DRY_RUN',
          thresholdDays,
          now: now.toISOString(),
          scanned: roles.length,
          wouldMarkStale: toMark.length,
          kept,
          skipped,
          capApplied: limit > 0 ? limit : null,
          marked: COMMIT ? marked : 0,
          sampleRoleTitles: capped.slice(0, 15).map((r) => r.roleTitle),
        },
        null,
        2,
      ),
    );
  } finally {
    await prisma.$disconnect();
  }
}

// Guard against auto-run on import: only execute when invoked directly.
const invokedDirectly =
  typeof process !== 'undefined' &&
  Array.isArray(process.argv) &&
  /reconcile-person-role-staleness(\.ts|\.js)?$/.test(process.argv[1] ?? '');

if (invokedDirectly) {
  void main().catch((err) => {
    console.error(
      '[reconcile-person-role-staleness] FAILED',
      err instanceof Error ? err.message : String(err),
    );
    process.exit(1);
  });
}
