/**
 * Reconcile the first-party Florida committee directory into state_committee.
 * Default mode is a read-only report. Applying to a non-local database needs
 * both an explicit non-local opt-in and the exact inventory confirmation token.
 * The sync upserts the 66 reviewed rows and soft-retires older directory rows
 * that are no longer in that reviewed inventory. It never deletes or merges
 * rows, so historical referrals, rosters, hearings, and deep links remain.
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { URL } from 'node:url';
import { config as dotenvConfig } from 'dotenv';
import { PrismaClient, type Prisma } from '@prisma/client';

dotenvConfig();

export type InventoryRow = {
  chamber: 'house' | 'senate' | 'joint';
  officialCode: string;
  name: string;
  officialUrl: string | null;
  listingOnly: boolean;
  existing: Array<{ id: string; chamber: string | null; officialSourceKey: string | null }>;
};

export type Snapshot = {
  checkedAt: string;
  provenance: { comparisonArtifact: string; sources: Record<string, string> };
  counts: { house: number; senate: number; joint: number; total: number };
  rows: InventoryRow[];
};

export type AppliedInventoryRow = {
  state: string;
  chamber: string | null;
  name: string;
  officialSourceKey: string | null;
  legislativeSession: string | null;
};

type DirectoryEvidence = Record<string, unknown> & { active?: boolean };

export function officialKey(row: InventoryRow): string {
  if (row.chamber === 'house') return `FL:2026:fl:house:committee:${row.officialCode}`;
  if (row.chamber === 'senate') return `FL:2026:fl:senate:${row.officialCode}`;
  // Joint membership carries conflicting 2026/2027 evidence. It is deliberately
  // directory-only and must not become a calendar identity.
  return `FL:directory:fl:joint:${row.officialCode}`;
}

export function deterministicId(key: string): string {
  return `official-${createHash('sha256').update(key).digest('hex').slice(0, 32)}`;
}

export function verifiedAliasIds(row: InventoryRow, officialId: string): string[] {
  return row.existing
    .filter((entry) => !entry.officialSourceKey && entry.id !== officialId)
    .map((entry) => entry.id);
}

export function expectedInventoryRecord(row: InventoryRow): AppliedInventoryRow {
  return {
    state: 'FL',
    chamber: row.chamber === 'house' ? 'lower' : row.chamber === 'senate' ? 'upper' : 'joint',
    name: row.name,
    officialSourceKey: officialKey(row),
    legislativeSession: row.chamber === 'joint' ? null : '2026',
  };
}

function directoryEvidence(sourceEvidence: unknown): DirectoryEvidence | null {
  if (!sourceEvidence || typeof sourceEvidence !== 'object' || Array.isArray(sourceEvidence)) {
    return null;
  }
  const directory = (sourceEvidence as { directory?: unknown }).directory;
  return directory && typeof directory === 'object' && !Array.isArray(directory)
    ? (directory as DirectoryEvidence)
    : null;
}

/**
 * Calendar discovery stores identity evidence at the root, while this sync
 * stores directory evidence under `directory`. The root `officialBodyKey`
 * still proves that a legacy row belongs to the same 2026 official-key namespace.
 */
export function isManagedDirectoryRow(row: {
  officialSourceKey: string | null;
  sourceEvidence: unknown;
}): boolean {
  if (directoryEvidence(row.sourceEvidence) != null) return true;
  if (
    !row.sourceEvidence ||
    typeof row.sourceEvidence !== 'object' ||
    Array.isArray(row.sourceEvidence)
  ) {
    return false;
  }
  const officialBodyKey = (row.sourceEvidence as { officialBodyKey?: unknown }).officialBodyKey;
  return (
    typeof officialBodyKey === 'string' &&
    officialBodyKey.length > 0 &&
    row.officialSourceKey === `FL:2026:${officialBodyKey}`
  );
}

/** Rows soft-retired by this inventory remain addressable but leave directory lists. */
export function isActiveDirectoryRow(row: { sourceEvidence: unknown }): boolean {
  return directoryEvidence(row.sourceEvidence)?.active !== false;
}

export function retiredDirectorySourceEvidence(
  sourceEvidence: unknown,
  checkedAt: string,
): Prisma.InputJsonObject {
  const root =
    sourceEvidence && typeof sourceEvidence === 'object' && !Array.isArray(sourceEvidence)
      ? (sourceEvidence as Record<string, unknown>)
      : {};
  return {
    ...root,
    directory: {
      ...(directoryEvidence(sourceEvidence) ?? {}),
      active: false,
      retiredAt: checkedAt,
      retirementReason: 'not-in-reviewed-inventory',
    },
  } as unknown as Prisma.InputJsonObject;
}

export function assertAppliedInventory(snapshot: Snapshot, rows: AppliedInventoryRow[]): number {
  const byKey = new Map(rows.map((row) => [row.officialSourceKey, row]));
  const mismatches: string[] = [];
  for (const inventoryRow of snapshot.rows) {
    const expected = expectedInventoryRecord(inventoryRow);
    const actual = byKey.get(expected.officialSourceKey);
    if (
      !actual ||
      Object.entries(expected).some(
        ([field, value]) => actual[field as keyof AppliedInventoryRow] !== value,
      )
    ) {
      mismatches.push(expected.officialSourceKey ?? inventoryRow.officialCode);
    }
  }
  const expectedKeys = new Set(snapshot.rows.map(officialKey));
  const unexpected = rows
    .map((row) => row.officialSourceKey)
    .filter((key): key is string => typeof key === 'string')
    .filter((key) => !expectedKeys.has(key));
  if (mismatches.length) {
    throw new Error(
      `Florida inventory postcondition failed for ${mismatches.length} of ${snapshot.rows.length} keys: ${mismatches.slice(0, 10).join(', ')}`,
    );
  }
  if (unexpected.length) {
    throw new Error(
      `Florida inventory postcondition found ${unexpected.length} unexpected active keys: ${unexpected.slice(0, 10).join(', ')}`,
    );
  }
  if (rows.length !== snapshot.rows.length) {
    throw new Error(
      `Florida inventory postcondition expected ${snapshot.rows.length} active rows (got ${rows.length})`,
    );
  }
  return snapshot.rows.length;
}

export function validateSnapshot(snapshot: Snapshot): void {
  if (snapshot.rows.length !== 66 || snapshot.counts.total !== 66) {
    throw new Error(`Florida snapshot must contain exactly 66 rows (got ${snapshot.rows.length})`);
  }
  for (const chamber of ['house', 'senate', 'joint'] as const) {
    const count = snapshot.rows.filter((row) => row.chamber === chamber).length;
    if (count !== snapshot.counts[chamber]) throw new Error(`Florida ${chamber} count mismatch`);
  }
  const keys = snapshot.rows.map(officialKey);
  if (new Set(keys).size !== keys.length)
    throw new Error('Florida snapshot has duplicate official keys');
  for (const row of snapshot.rows) {
    const sourceUrl =
      row.officialUrl ?? (row.listingOnly ? snapshot.provenance.sources.senate : null);
    if (!sourceUrl) throw new Error(`Florida snapshot has no official URL for ${row.officialCode}`);
    const url = new URL(sourceUrl);
    if (
      !row.name.trim() ||
      !row.officialCode.trim() ||
      url.protocol !== 'https:' ||
      ![
        'flhouse.gov',
        'www.flhouse.gov',
        'flsenate.gov',
        'www.flsenate.gov',
        'leg.state.fl.us',
        'www.leg.state.fl.us',
      ].includes(url.hostname)
    ) {
      throw new Error(`Florida snapshot contains an invalid official entry: ${row.officialCode}`);
    }
  }
}

export const FLORIDA_SYNC_LOCAL_CONFIRM = '2026-local-only';
export const FLORIDA_SYNC_NONLOCAL_CONFIRM = 'apply-2026-official-florida-committees';

export function validateDatabaseUrl(apply: boolean, env: NodeJS.ProcessEnv = process.env): URL {
  const raw = env.DATABASE_URL;
  if (!raw) throw new Error('DATABASE_URL is required for the report (never use a fallback)');
  const url = new URL(raw);
  if (!['postgres:', 'postgresql:'].includes(url.protocol))
    throw new Error('DATABASE_URL must be PostgreSQL');
  const local = ['localhost', '127.0.0.1', '::1'].includes(url.hostname);
  if (!local && env.ALLOW_NONLOCAL_FLORIDA_SYNC !== '1') {
    throw new Error(
      `Refusing non-local database host ${url.hostname}; set ALLOW_NONLOCAL_FLORIDA_SYNC=1 for an operator-reviewed one-shot run`,
    );
  }
  const expectedConfirmation = local ? FLORIDA_SYNC_LOCAL_CONFIRM : FLORIDA_SYNC_NONLOCAL_CONFIRM;
  if (apply && env.FLORIDA_SYNC_CONFIRM !== expectedConfirmation) {
    throw new Error(`Apply requires FLORIDA_SYNC_CONFIRM=${expectedConfirmation}`);
  }
  return url;
}

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  const snapshotPath = join(__dirname, '../data/florida-official-committee-inventory.json');
  const snapshot = JSON.parse(await readFile(snapshotPath, 'utf8')) as Snapshot;
  validateSnapshot(snapshot);
  const db = validateDatabaseUrl(apply);
  const prisma = new PrismaClient();
  const report = {
    mode: apply ? 'apply' : 'dry-run',
    databaseHost: db.hostname,
    total: snapshot.rows.length,
    created: 0,
    enriched: 0,
    unchanged: 0,
    refreshed: 0,
    retired: 0,
    verified: 0,
    errors: [] as string[],
  };

  try {
    for (const row of snapshot.rows) {
      const key = officialKey(row);
      const directoryUrl = row.officialUrl ?? snapshot.provenance.sources.senate;
      const legacyId = row.existing.find((entry) => !entry.officialSourceKey)?.id;
      const existingOfficial = await prisma.stateCommittee.findUnique({
        where: { officialSourceKey: key },
      });
      const legacy = legacyId
        ? await prisma.stateCommittee.findUnique({ where: { id: legacyId } })
        : null;
      // Joint roster rows came from legislators in two chambers. Keep both
      // chamber-specific records and referrals untouched; add one directory row.
      const eligibleLegacy =
        row.chamber !== 'joint' && legacy && !legacy.officialSourceKey ? legacy : null;
      const id = existingOfficial?.id ?? eligibleLegacy?.id ?? deterministicId(key);
      const existing = existingOfficial ?? eligibleLegacy;
      const aliasIds = verifiedAliasIds(row, id);
      const priorEvidence = existing?.sourceEvidence;
      const sourceEvidence = {
        ...(priorEvidence && typeof priorEvidence === 'object' && !Array.isArray(priorEvidence)
          ? priorEvidence
          : {}),
        directory: {
          sourceUrl: directoryUrl,
          checkedAt: snapshot.checkedAt,
          listingOnly: row.listingOnly,
          directoryOnly: row.chamber === 'joint',
          aliasIds,
          active: true,
        },
      };
      const data = {
        ...expectedInventoryRecord(row),
        sourceUrl: existing?.sourceUrl ?? directoryUrl,
        sourceEvidence,
        lastSyncedAt: new Date(),
      };
      if (!apply) {
        report[existingOfficial ? 'unchanged' : eligibleLegacy ? 'enriched' : 'created']++;
        continue;
      }
      if (existingOfficial) {
        await prisma.stateCommittee.update({ where: { id: existingOfficial.id }, data });
        report.refreshed++;
      } else {
        await prisma.stateCommittee.upsert({
          where: { id },
          create: { id, ...data },
          update: data,
        });
        report[eligibleLegacy ? 'enriched' : 'created']++;
      }
    }

    const inventoryKeys = new Set(snapshot.rows.map(officialKey));
    const managedRows = await prisma.stateCommittee.findMany({
      where: {
        state: 'FL',
        officialSourceKey: { not: null },
        OR: [
          { officialSourceKey: { startsWith: 'FL:2026:fl:house:committee:' } },
          { officialSourceKey: { startsWith: 'FL:2026:fl:senate:' } },
          { officialSourceKey: { startsWith: 'FL:directory:fl:joint:' } },
        ],
      },
      select: { id: true, officialSourceKey: true, sourceEvidence: true },
    });
    const staleDirectoryRows = managedRows.filter(
      (row) =>
        row.officialSourceKey != null &&
        !inventoryKeys.has(row.officialSourceKey) &&
        isManagedDirectoryRow(row) &&
        isActiveDirectoryRow(row),
    );
    report.retired = staleDirectoryRows.length;
    if (apply) {
      for (const row of staleDirectoryRows) {
        await prisma.stateCommittee.update({
          where: { id: row.id },
          data: {
            sourceEvidence: retiredDirectorySourceEvidence(row.sourceEvidence, snapshot.checkedAt),
            lastSyncedAt: new Date(),
          },
        });
      }
    }
    if (apply) {
      const appliedRows = await prisma.stateCommittee.findMany({
        where: {
          state: 'FL',
          officialSourceKey: {
            in: managedRows
              .map((row) => row.officialSourceKey)
              .filter((key): key is string => Boolean(key)),
          },
        },
        select: {
          state: true,
          chamber: true,
          name: true,
          officialSourceKey: true,
          legislativeSession: true,
          sourceEvidence: true,
        },
      });
      report.verified = assertAppliedInventory(
        snapshot,
        appliedRows
          .filter(isActiveDirectoryRow)
          .map(({ sourceEvidence: _sourceEvidence, ...row }) => row),
      );
    }
  } finally {
    await prisma.$disconnect();
  }
  console.log(JSON.stringify(report, null, 2));
}

if (process.argv[1]?.endsWith('sync-florida-official-committees.ts')) void main();
