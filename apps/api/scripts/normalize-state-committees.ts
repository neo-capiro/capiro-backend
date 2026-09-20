/**
 * Normalize state committee rosters (Phase 1 M2.2, PD3/PD8 substrate). GLOBAL —
 * `state_legislator`/`state_committee`/`state_committee_membership` carry no
 * tenant/RLS (same as `congress_committee`), so this runs as a plain scan, no
 * `bypassRls` needed.
 *
 * `StateLegislator.committees` is a Json array written by `sync-openstates.ts`.
 * Each membership keeps `{name, role}` plus the OpenStates committee's stable
 * id, classification, parent, links, sources and extras. The local committee
 * is deduped by `"<state>-<chamber>-<slug(name)>"` (StateCommittee.id's own
 * scheme — the SAME id a LegiScan bill-committee referral resolves to once
 * M2.2's ingestion wiring lands, so both sources converge on one row).
 * `chamber` is still taken from the LEGISLATOR's own chamber, since the
 * OpenStates Committee schema carries no chamber field — a documented limitation for
 * genuinely joint committees (they'll get an upper-chamber row AND a
 * lower-chamber row rather than one shared row); acceptable per PD2's "never
 * guess" standard, since guessing which of two real chambers a joint
 * committee "belongs to" would be worse than two rows.
 *
 * Idempotent: upserts by the deterministic committee id + the
 * (committeeId, legislatorId) unique membership key. Also RECONCILES — a
 * legislator's membership rows for committees no longer in their current
 * `committees` Json (a real seat change, or simply a run that synced fewer
 * committees) are pruned, the same "replace with truth" contract
 * sync-committees.ts already applies to the federal committee roster
 * (deleteMany + createMany there; a per-legislator deleteMany here, since
 * this script can run scoped to a subset of states/legislators per run,
 * unlike the federal script's always-full rebuild). Before this, membership
 * rows only ever accumulated — harmless while `committees` was always `[]`
 * (the sync-openstates.ts bug this fix pairs with), but real data now flows
 * in, so a stale row would otherwise sit in `state_committee_membership`
 * (and therefore in the Legislators UI) forever.
 *
 *   pnpm --filter @capiro/api exec tsx scripts/normalize-state-committees.ts
 * Env: STATE_COMMITTEE_STATES (comma-separated 2-letter codes; default = all).
 */
import { config as dotenvConfig } from 'dotenv';
import { PrismaClient, type Prisma } from '@prisma/client';
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

export interface CommitteeJsonEntry {
  name?: string;
  role?: string;
  openstates?: {
    id?: string;
    classification?: string | null;
    parentId?: string | null;
    links?: Array<{ url: string; note?: string | null }>;
    sources?: Array<{ url: string; note?: string | null }>;
    extras?: Record<string, unknown>;
  };
}

export interface DesiredCommittee {
  committeeId: string;
  name: string;
  role: string | null;
  openstates: CommitteeJsonEntry['openstates'] | null;
}

/**
 * Compute the exact, deduped set of committees a legislator should currently
 * belong to, from their raw `committees` Json and the shared
 * `"<state>-<chamber>-<slug(name)>"` id scheme. The pure core of the
 * upsert-and-prune loop below — everything DB-shaped stays in main().
 */
export function computeDesiredCommittees(
  state: string,
  chamber: string,
  entries: CommitteeJsonEntry[],
): DesiredCommittee[] {
  const seen = new Set<string>();
  const desired: DesiredCommittee[] = [];
  for (const entry of entries) {
    const name = (entry.name ?? '').trim();
    if (!name) continue;
    const committeeId = `${state}-${chamber}-${slugify(name)}`;
    if (seen.has(committeeId)) continue; // OpenStates listing the same committee twice -> one row
    seen.add(committeeId);
    desired.push({
      committeeId,
      name,
      role: entry.role ?? null,
      openstates: entry.openstates ?? null,
    });
  }
  return desired;
}

function httpUrl(links: Array<{ url: string }> | undefined): string | null {
  for (const link of links ?? []) {
    try {
      const parsed = new URL(link.url);
      if (
        (parsed.protocol === 'https:' || parsed.protocol === 'http:') &&
        !parsed.username &&
        !parsed.password
      )
        return parsed.href;
    } catch {
      // A malformed provider URL is retained nowhere and never becomes a UI link.
    }
  }
  return null;
}

function rootEvidence(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function openstatesEvidence(
  current: unknown,
  desired: DesiredCommittee,
): Prisma.InputJsonObject | undefined {
  if (!desired.openstates?.id) return undefined;
  return {
    ...rootEvidence(current),
    openstates: {
      committeeId: desired.openstates.id,
      classification: desired.openstates.classification ?? null,
      parentId: desired.openstates.parentId ?? null,
      links: desired.openstates.links ?? [],
      sources: desired.openstates.sources ?? [],
      extras: desired.openstates.extras ?? {},
    },
  } as unknown as Prisma.InputJsonObject;
}

async function main() {
  await runWithSyncRun(prisma as never, 'normalize-state-committees', async () => {
    const legislators = await prisma.stateLegislator.findMany({
      where: STATES.length ? { state: { in: STATES } } : undefined,
      select: { id: true, state: true, chamber: true, committees: true },
    });

    let committeesUpserted = 0;
    let membershipsUpserted = 0;
    let membershipsPruned = 0;
    let skippedNoChamber = 0;

    const desiredByLegislator = new Map<string, DesiredCommittee[]>();
    const committeeById = new Map<string, DesiredCommittee>();

    for (const leg of legislators) {
      if (!leg.chamber) {
        // No chamber on record for this legislator — the id scheme needs one,
        // and guessing house-vs-senate would be exactly the kind of guess
        // PD2 forbids, so this legislator's committees are skipped (logged),
        // existing rows left untouched either way.
        const entries = Array.isArray(leg.committees)
          ? (leg.committees as CommitteeJsonEntry[])
          : [];
        if (entries.length) skippedNoChamber++;
        continue;
      }
      const entries = Array.isArray(leg.committees) ? (leg.committees as CommitteeJsonEntry[]) : [];
      const desired = computeDesiredCommittees(leg.state, leg.chamber, entries);
      desiredByLegislator.set(leg.id, desired);
      for (const committee of desired) {
        const existing = committeeById.get(committee.committeeId);
        // Prefer the copy carrying provider identity/provenance. Role is
        // membership-specific and is written from desiredByLegislator below.
        if (!existing || (!existing.openstates?.id && committee.openstates?.id))
          committeeById.set(committee.committeeId, committee);
      }
    }

    // One committee write per provider identity, not once per member. Besides
    // reducing a Florida normalization from hundreds of redundant writes to a
    // few dozen, this lets us merge OpenStates evidence without overwriting
    // the first-party Florida `directory` evidence on an already-qualified row.
    const committeeIds = [...committeeById.keys()];
    const existingCommittees = committeeIds.length
      ? await prisma.stateCommittee.findMany({
          where: { id: { in: committeeIds } },
          select: { id: true, state: true, chamber: true, sourceUrl: true, sourceEvidence: true },
        })
      : [];
    const existingById = new Map(existingCommittees.map((row) => [row.id, row]));
    for (const d of committeeById.values()) {
      const [state, chamber] = d.committeeId.split('-', 3);
      if (!state || !chamber) continue;
      const existing = existingById.get(d.committeeId);
      const evidence = openstatesEvidence(existing?.sourceEvidence, d);
      const providerUrl = httpUrl(d.openstates?.links) ?? httpUrl(d.openstates?.sources) ?? null;
      await prisma.stateCommittee.upsert({
        where: { id: d.committeeId },
        create: {
          id: d.committeeId,
          state,
          chamber,
          name: d.name,
          sourceUrl: providerUrl,
          ...(evidence ? { sourceEvidence: evidence } : {}),
        },
        update: {
          name: d.name,
          sourceUrl: existing?.sourceUrl ?? providerUrl,
          ...(evidence ? { sourceEvidence: evidence } : {}),
          lastSyncedAt: new Date(),
        },
      });
      committeesUpserted++;
    }

    for (const leg of legislators) {
      if (!leg.chamber) continue;
      const desired = desiredByLegislator.get(leg.id) ?? [];
      for (const d of desired) {
        await prisma.stateCommitteeMembership.upsert({
          where: { committeeId_legislatorId: { committeeId: d.committeeId, legislatorId: leg.id } },
          create: { committeeId: d.committeeId, legislatorId: leg.id, role: d.role },
          update: { role: d.role, lastSyncedAt: new Date() },
        });
        membershipsUpserted++;
      }

      const { count } = await prisma.stateCommitteeMembership.deleteMany({
        where: {
          legislatorId: leg.id,
          committeeId: { notIn: desired.map((d) => d.committeeId) },
        },
      });
      membershipsPruned += count;
    }

    console.log(
      `[normalize-state-committees] ${legislators.length} legislators scanned, ${committeesUpserted} committee upserts, ${membershipsUpserted} membership upserts, ${membershipsPruned} stale memberships pruned, ${skippedNoChamber} legislators skipped (no chamber on record)`,
    );
    // Shared SyncRun/INGESTION_METRIC shape (see emit-state-changes.ts, derive-state-bill-status.ts) —
    // the detailed per-kind counts above are the ones worth reading; this is just the
    // standard 4-bucket summary every sync script reports. (Previously this returned a
    // differently-shaped object that didn't match RunCounts at all — never caught because
    // no test imported this file before now.)
    return { inserted: 0, updated: membershipsUpserted, skipped: skippedNoChamber, errors: 0 };
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
