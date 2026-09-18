/**
 * Reconcile the first-party Florida committee directory into state_committee.
 * Default mode is a read-only report. Use --apply only against a reviewed,
 * non-production database. This script never deletes or merges rows.
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { URL } from 'node:url';
import { config as dotenvConfig } from 'dotenv';
import { PrismaClient } from '@prisma/client';

dotenvConfig();

export type InventoryRow = {
  chamber: 'house' | 'senate' | 'joint';
  officialCode: string;
  name: string;
  officialUrl: string | null;
  listingOnly: boolean;
  existing: Array<{ id: string; chamber: string | null; officialSourceKey: string | null }>;
};

type Snapshot = {
  checkedAt: string;
  provenance: { comparisonArtifact: string; sources: Record<string, string> };
  counts: { house: number; senate: number; joint: number; total: number };
  rows: InventoryRow[];
};

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

export function validateSnapshot(snapshot: Snapshot): void {
  if (snapshot.rows.length !== 66 || snapshot.counts.total !== 66) {
    throw new Error(`Florida snapshot must contain exactly 66 rows (got ${snapshot.rows.length})`);
  }
  for (const chamber of ['house', 'senate', 'joint'] as const) {
    const count = snapshot.rows.filter((row) => row.chamber === chamber).length;
    if (count !== snapshot.counts[chamber]) throw new Error(`Florida ${chamber} count mismatch`);
  }
  const keys = snapshot.rows.map(officialKey);
  if (new Set(keys).size !== keys.length) throw new Error('Florida snapshot has duplicate official keys');
  for (const row of snapshot.rows) {
    const sourceUrl = row.officialUrl ?? (row.listingOnly ? snapshot.provenance.sources.senate : null);
    if (!sourceUrl) throw new Error(`Florida snapshot has no official URL for ${row.officialCode}`);
    const url = new URL(sourceUrl);
    if (!row.name.trim() || !row.officialCode.trim() || url.protocol !== 'https:' ||
        !['flhouse.gov', 'www.flhouse.gov', 'flsenate.gov', 'www.flsenate.gov',
          'leg.state.fl.us', 'www.leg.state.fl.us'].includes(url.hostname)) {
      throw new Error(`Florida snapshot contains an invalid official entry: ${row.officialCode}`);
    }
  }
}

function validateDatabaseUrl(apply: boolean): URL {
  const raw = process.env.DATABASE_URL;
  if (!raw) throw new Error('DATABASE_URL is required for the report (never use a fallback)');
  const url = new URL(raw);
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw new Error('DATABASE_URL must be PostgreSQL');
  const local = ['localhost', '127.0.0.1', '::1'].includes(url.hostname);
  if (!local && process.env.ALLOW_NONLOCAL_FLORIDA_SYNC !== '1') {
    throw new Error(`Refusing non-local database host ${url.hostname}; this sync must not run against production`);
  }
  if (apply && process.env.FLORIDA_SYNC_CONFIRM !== '2026-local-only') {
    throw new Error('Apply requires FLORIDA_SYNC_CONFIRM=2026-local-only');
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
  const report = { mode: apply ? 'apply' : 'dry-run', databaseHost: db.hostname, total: snapshot.rows.length, created: 0, enriched: 0, unchanged: 0, refreshed: 0, errors: [] as string[] };

  try {
    for (const row of snapshot.rows) {
      const key = officialKey(row);
      const directoryUrl = row.officialUrl ?? snapshot.provenance.sources.senate;
      const legacyId = row.existing.find((entry) => !entry.officialSourceKey)?.id;
      const existingOfficial = await prisma.stateCommittee.findUnique({ where: { officialSourceKey: key } });
      const legacy = legacyId
        ? await prisma.stateCommittee.findUnique({ where: { id: legacyId } })
        : null;
      // Joint roster rows came from legislators in two chambers. Keep both
      // chamber-specific records and referrals untouched; add one directory row.
      const eligibleLegacy = row.chamber !== 'joint' && legacy && !legacy.officialSourceKey
        ? legacy
        : null;
      const id = existingOfficial?.id ?? eligibleLegacy?.id ?? deterministicId(key);
      const existing = existingOfficial ?? eligibleLegacy;
      const aliasIds = verifiedAliasIds(row, id);
      const priorEvidence = existing?.sourceEvidence;
      const sourceEvidence = {
        ...(priorEvidence && typeof priorEvidence === 'object' && !Array.isArray(priorEvidence) ? priorEvidence : {}),
        directory: {
          sourceUrl: directoryUrl,
          checkedAt: snapshot.checkedAt,
          listingOnly: row.listingOnly,
          directoryOnly: row.chamber === 'joint',
          aliasIds,
        },
      };
      const data = {
        state: 'FL',
        chamber: row.chamber === 'house' ? 'lower' : row.chamber === 'senate' ? 'upper' : 'joint',
        name: row.name,
        officialSourceKey: key,
        legislativeSession: row.chamber === 'joint' ? null : '2026',
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
        await prisma.stateCommittee.upsert({ where: { id }, create: { id, ...data }, update: data });
        report[eligibleLegacy ? 'enriched' : 'created']++;
      }
    }
  } finally {
    await prisma.$disconnect();
  }
  console.log(JSON.stringify(report, null, 2));
}

if (process.argv[1]?.endsWith('sync-florida-official-committees.ts')) void main();
