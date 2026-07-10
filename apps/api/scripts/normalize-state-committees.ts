/**
 * Normalize state committee rosters (Phase 1 M2.2, PD3/PD8 substrate). GLOBAL —
 * `state_legislator`/`state_committee`/`state_committee_membership` carry no
 * tenant/RLS (same as `congress_committee`), so this runs as a plain scan, no
 * `bypassRls` needed.
 *
 * `StateLegislator.committees` is a Json array `[{name, role}]` written by
 * `sync-openstates.ts` — free-text committee names with no id, so a committee
 * is deduped by `"<state>-<chamber>-<slug(name)>"` (StateCommittee.id's own
 * scheme — the SAME id a LegiScan bill-committee referral resolves to once
 * M2.2's ingestion wiring lands, so both sources converge on one row).
 * `chamber` is taken from the LEGISLATOR's own chamber, since OpenStates'
 * committee Json carries no chamber of its own — a documented limitation for
 * genuinely joint committees (they'll get an upper-chamber row AND a
 * lower-chamber row rather than one shared row); acceptable per PD2's "never
 * guess" standard, since guessing which of two real chambers a joint
 * committee "belongs to" would be worse than two rows.
 *
 * Idempotent: upserts by the deterministic committee id + the
 * (committeeId, legislatorId) unique membership key.
 *
 *   pnpm --filter @capiro/api exec tsx scripts/normalize-state-committees.ts
 * Env: STATE_COMMITTEE_STATES (comma-separated 2-letter codes; default = all).
 */
import { config as dotenvConfig } from 'dotenv';
import { PrismaClient } from '@prisma/client';
import { runWithSyncRun } from '../src/ingestion/sync-run.helper.js';
dotenvConfig();

const prisma = new PrismaClient();
const STATES = (process.env.STATE_COMMITTEE_STATES ?? '')
  .split(',')
  .map((s) => s.trim().toUpperCase())
  .filter(Boolean);

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 200);
}

interface CommitteeJsonEntry {
  name?: string;
  role?: string;
}

async function main() {
  await runWithSyncRun(prisma as never, 'normalize-state-committees', async () => {
    const legislators = await prisma.stateLegislator.findMany({
      where: STATES.length ? { state: { in: STATES } } : undefined,
      select: { id: true, state: true, chamber: true, committees: true },
    });

    let committeesUpserted = 0;
    let membershipsUpserted = 0;
    let skippedNoChamber = 0;

    for (const leg of legislators) {
      if (!leg.chamber) {
        // No chamber on record for this legislator — the id scheme needs one,
        // and guessing house-vs-senate would be exactly the kind of guess
        // PD2 forbids, so this legislator's committees are skipped (logged).
        const entries = Array.isArray(leg.committees)
          ? (leg.committees as CommitteeJsonEntry[])
          : [];
        if (entries.length) skippedNoChamber++;
        continue;
      }
      const entries = Array.isArray(leg.committees) ? (leg.committees as CommitteeJsonEntry[]) : [];
      for (const entry of entries) {
        const name = (entry.name ?? '').trim();
        if (!name) continue;
        const committeeId = `${leg.state}-${leg.chamber}-${slugify(name)}`;
        await prisma.stateCommittee.upsert({
          where: { id: committeeId },
          create: { id: committeeId, state: leg.state, chamber: leg.chamber, name },
          update: { name },
        });
        committeesUpserted++;
        await prisma.stateCommitteeMembership.upsert({
          where: { committeeId_legislatorId: { committeeId, legislatorId: leg.id } },
          create: { committeeId, legislatorId: leg.id, role: entry.role ?? null },
          update: { role: entry.role ?? null, lastSyncedAt: new Date() },
        });
        membershipsUpserted++;
      }
    }

    console.log(
      `[normalize-state-committees] ${legislators.length} legislators scanned, ${committeesUpserted} committee upserts, ${membershipsUpserted} membership upserts, ${skippedNoChamber} legislators skipped (no chamber on record)`,
    );
    return { committeesUpserted, membershipsUpserted, skippedNoChamber };
  });
}

if (require.main === module) {
  main()
    .catch((e) => {
      console.error(e);
      process.exit(1);
    })
    .finally(() => prisma.$disconnect());
}
