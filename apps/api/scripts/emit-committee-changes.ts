/**
 * Emit `intelligence_change` rows for committee membership changes (WS-G,
 * LegiStorm gaps/enrichment plan — optional temporal enrichment).
 *
 * The ingestion pipeline explicitly DROPS LegiStorm's own dated
 * roster_snapshot history (directory-indexes.ts's own comment: "drops the
 * raw LegiStorm rows and keeps only committee LEADERSHIP"), so there is no
 * historical roster data to read directly. This maintains OUR OWN
 * lightweight ledger (committee_membership_watch) of "who was on which
 * committee as of the last run" and diffs the CURRENT directory snapshot
 * against it — gained / lost / role-changed. This is temporal enrichment of
 * already-shipped committee data, never a new vendor fetch — no
 * LEGISTORM_API_KEY dependency at all, and no dependency on WS-B/C/D/E/F.
 *
 * Boots a Nest application context to reuse DirectoryService's already-built
 * committee index (the same pattern sync-hearing-transcripts.ts uses for
 * GovInfoService: NestFactory.createApplicationContext + app.get(...,
 * {strict:false})) rather than re-implementing its private
 * buildContacts/buildCommitteeIndex logic standalone.
 *
 * Gated to members/staff who are an EXISTING ClientTarget for some client —
 * "the member/staffer you're tracking just became committee chair" is a
 * precise, high-signal audience. A broader gate (committee has jurisdiction
 * over a client's tracked bills, mirroring office-recommender.service.ts's
 * fuzzy committee-name text matching) is a deliberate, documented follow-up,
 * not built here — fuzzy text matching is a materially less precise
 * audience computation than ClientTarget's clean id join.
 *
 * FIRST RUN: the watch table starts empty, so every current membership
 * would otherwise look like a "gain" — a false burst, not a real signal.
 * The first-ever run (watch table empty) establishes the baseline (writes
 * every current membership to the watch table) and emits NOTHING; only
 * subsequent runs detect real changes.
 *
 *   pnpm --filter @capiro/api exec tsx scripts/emit-committee-changes.ts
 */
import { config as dotenvConfig } from 'dotenv';
import { NestFactory } from '@nestjs/core';
import { runWithSyncRun } from '../src/ingestion/sync-run.helper.js';

dotenvConfig();

export const SOURCE = 'committee_membership';

async function loadNest(): Promise<{ AppModule: any; DirectoryService: any; PrismaService: any }> {
  for (const base of ['../dist', '../src']) {
    try {
      const app = await import(`${base}/app.module.js`);
      const directory = await import(`${base}/directory/directory.service.js`);
      const prisma = await import(`${base}/prisma/prisma.service.js`);
      return {
        AppModule: app.AppModule,
        DirectoryService: directory.DirectoryService,
        PrismaService: prisma.PrismaService,
      };
    } catch {
      // try next base
    }
  }
  throw new Error('Could not load AppModule from dist or src');
}

export interface CurrentMembership {
  committeeId: string;
  personId: string;
  personName: string;
  role: string | null;
}

export interface WatchRow {
  committeeId: string;
  personId: string;
  personName: string | null;
  role: string | null;
}

export interface DetectedChange {
  committeeId: string;
  personId: string;
  personName: string;
  changeType: 'committee_seat_gained' | 'committee_seat_lost' | 'committee_role_changed';
  newRole: string | null;
  oldRole: string | null;
}

/**
 * Pure diff — exported for testing without a database or NestJS context.
 * `isFirstRun=true` short-circuits to zero changes (the watch table is
 * being established, not compared against) — see the file header for why.
 */
export function diffCommitteeMemberships(
  current: CurrentMembership[],
  watchRows: WatchRow[],
  isFirstRun: boolean,
): DetectedChange[] {
  if (isFirstRun) return [];

  const currentByKey = new Map(current.map((m) => [`${m.committeeId}|${m.personId}`, m]));
  const watchByKey = new Map(watchRows.map((w) => [`${w.committeeId}|${w.personId}`, w]));
  const changes: DetectedChange[] = [];

  for (const [key, m] of currentByKey) {
    const watch = watchByKey.get(key);
    if (!watch) {
      changes.push({
        committeeId: m.committeeId,
        personId: m.personId,
        personName: m.personName,
        changeType: 'committee_seat_gained',
        newRole: m.role,
        oldRole: null,
      });
    } else if ((watch.role ?? null) !== (m.role ?? null)) {
      changes.push({
        committeeId: m.committeeId,
        personId: m.personId,
        personName: m.personName,
        changeType: 'committee_role_changed',
        newRole: m.role,
        oldRole: watch.role ?? null,
      });
    }
  }
  for (const [key, w] of watchByKey) {
    if (!currentByKey.has(key)) {
      changes.push({
        committeeId: w.committeeId,
        personId: w.personId,
        personName: w.personName ?? w.personId,
        changeType: 'committee_seat_lost',
        newRole: null,
        oldRole: w.role ?? null,
      });
    }
  }
  return changes;
}

/**
 * 'Chair' on EITHER side of the change is the highest-signal event — gaining
 * OR losing a chairmanship is a meaningful power shift either way, unlike
 * WS-C's flat 'notable', where no comparably strong text signal exists.
 */
export function severityFor(change: DetectedChange): 'critical' | 'notable' | 'info' {
  const isChair = (role: string | null) => !!role && /chair/i.test(role);
  return isChair(change.newRole) || isChair(change.oldRole) ? 'critical' : 'notable';
}

export function buildDedupeKey(change: DetectedChange): string {
  const roleKey = change.newRole ?? change.oldRole ?? 'none';
  return `committee_membership:${change.committeeId}:${change.personId}:${change.changeType}:${roleKey}`;
}

export function buildTitleAndDescription(change: DetectedChange): {
  title: string;
  description: string;
} {
  if (change.changeType === 'committee_seat_gained') {
    return {
      title: change.newRole
        ? `${change.personName} named ${change.newRole} of a tracked committee`
        : `${change.personName} joined a tracked committee`,
      description: `${change.personName} is now ${
        change.newRole ? `the ${change.newRole} of` : 'a member of'
      } committee ${change.committeeId}.`,
    };
  }
  if (change.changeType === 'committee_seat_lost') {
    return {
      title: `${change.personName} left a tracked committee`,
      description: `${change.personName} is no longer ${
        change.oldRole ? `the ${change.oldRole} of` : 'a member of'
      } committee ${change.committeeId}.`,
    };
  }
  return {
    title: `${change.personName}'s committee role changed`,
    description: `${change.personName}'s role on committee ${change.committeeId} changed from ${
      change.oldRole ?? 'plain member'
    } to ${change.newRole ?? 'plain member'}.`,
  };
}

/**
 * apps/api-side cross-tenant read for a tenant-scoped table (client_targets),
 * mirroring emit-redistricting-alerts.ts's / emit-state-changes.ts's
 * set_config('app.bypass_rls', ...) transaction precedent verbatim.
 */
async function readCrossTenant<T>(prisma: any, fn: (tx: any) => Promise<T>): Promise<T> {
  return prisma.$transaction(async (tx: any) => {
    await tx.$executeRawUnsafe("SELECT set_config('app.bypass_rls', 'on', true)");
    return fn(tx);
  });
}

async function main(): Promise<void> {
  const { AppModule, DirectoryService, PrismaService } = await loadNest();
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['warn', 'error'] });

  try {
    const directory = app.get(DirectoryService, { strict: false });
    const prisma = app.get(PrismaService, { strict: false });

    await runWithSyncRun(prisma, SOURCE, async () => {
      const memberships = await directory.getAllCommitteeMemberships();
      const current: CurrentMembership[] = memberships.map((m: any) => ({
        committeeId: m.committeeId,
        personId: m.person.id,
        personName: m.person.fullName,
        role: m.position ?? null,
      }));

      const watchRows: WatchRow[] = await prisma.committeeMembershipWatch.findMany();
      const isFirstRun = watchRows.length === 0 && current.length > 0;
      const changes = diffCommitteeMemberships(current, watchRows, isFirstRun);

      if (isFirstRun) {
        console.log(
          `[emit-committee-changes] first-ever run: establishing baseline for ${current.length} current memberships, emitting nothing`,
        );
      }

      let emitted = 0;
      let skipped = 0;
      let errors = 0;

      // Skip the ClientTarget gate entirely on the first run — changes is
      // empty (nothing will be emitted), so there is nothing to gate.
      const distinctPersonIds = isFirstRun
        ? []
        : Array.from(new Set(changes.map((c) => c.personId)));
      const clientIdsByPersonId = new Map<string, string[]>();
      if (distinctPersonIds.length) {
        const targetRows = await readCrossTenant(prisma, (tx) =>
          tx.$queryRawUnsafe<Array<{ member_id: string; client_id: string }>>(
            `SELECT member_id, client_id FROM client_targets WHERE member_id = ANY($1::text[]) AND source_directory IN ('congress','staff')`,
            distinctPersonIds,
          ),
        );
        for (const row of targetRows) {
          const arr = clientIdsByPersonId.get(row.member_id) ?? [];
          arr.push(row.client_id);
          clientIdsByPersonId.set(row.member_id, arr);
        }
      }

      for (const change of changes) {
        try {
          const relatedClientIds = clientIdsByPersonId.get(change.personId) ?? [];
          if (!relatedClientIds.length) {
            skipped++;
            continue; // no client tracks this person — never broadcast market-wide
          }

          const dedupeKey = buildDedupeKey(change);
          const existing = await prisma.intelligenceChange.findFirst({
            where: { dedupeKey },
            select: { id: true },
          });
          if (existing) {
            skipped++;
            continue;
          }

          const { title, description } = buildTitleAndDescription(change);
          try {
            await prisma.intelligenceChange.create({
              data: {
                source: SOURCE,
                changeType: change.changeType,
                severity: severityFor(change),
                title,
                description,
                relatedClientIds,
                relatedIssues: [],
                data: {
                  committeeId: change.committeeId,
                  personId: change.personId,
                  personName: change.personName,
                  newRole: change.newRole,
                  oldRole: change.oldRole,
                },
                dedupeKey,
              },
            });
            emitted++;
          } catch (createErr: any) {
            // Defensive backstop against a race between two concurrent runs —
            // the DB's own @unique constraint on dedupeKey is the real guarantee.
            if (createErr?.code === 'P2002') skipped++;
            else throw createErr;
          }
        } catch (err) {
          errors++;
          console.error(
            `[emit-committee-changes] ${change.committeeId}/${change.personId} failed:`,
            err,
          );
        }
      }

      // Update the watch ledger. First run: write EVERY current membership
      // (establishing the baseline — changes is empty, so this must come
      // from `current`, not `changes`, or the table would stay empty
      // forever and every future run would also look like a first run).
      // Subsequent runs: only touch what actually changed — upserting
      // thousands of unchanged rows every day for a cosmetic lastSeenAt
      // refresh isn't worth the transaction cost.
      const now = new Date();
      const toUpsert: Array<{ committeeId: string; personId: string; personName: string | null; role: string | null }> =
        isFirstRun
          ? current.map((m) => ({
              committeeId: m.committeeId,
              personId: m.personId,
              personName: m.personName,
              role: m.role,
            }))
          : changes
              .filter((c) => c.changeType !== 'committee_seat_lost')
              .map((c) => ({
                committeeId: c.committeeId,
                personId: c.personId,
                personName: c.personName,
                role: c.newRole,
              }));

      await prisma.$transaction([
        ...toUpsert.map((m) =>
          prisma.committeeMembershipWatch.upsert({
            where: { committeeId_personId: { committeeId: m.committeeId, personId: m.personId } },
            create: {
              committeeId: m.committeeId,
              personId: m.personId,
              personName: m.personName,
              role: m.role,
              lastSeenAt: now,
            },
            update: { personName: m.personName, role: m.role, lastSeenAt: now },
          }),
        ),
        ...changes
          .filter((c) => c.changeType === 'committee_seat_lost')
          .map((c) =>
            prisma.committeeMembershipWatch.delete({
              where: { committeeId_personId: { committeeId: c.committeeId, personId: c.personId } },
            }),
          ),
      ]);

      console.log(
        `[emit-committee-changes] ${current.length} current memberships, ${changes.length} changes detected, ${emitted} emitted, ${skipped} skipped, ${errors} errors`,
      );
      return { inserted: emitted, updated: 0, skipped, errors };
    });
  } finally {
    await app.close();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error('[emit-committee-changes] FAILED', (error as Error).message);
    process.exit(1);
  });
}
