/** @cleanup-smoke noArgsExit=2 */
import { config as dotenvConfig } from 'dotenv';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { normalizeName } from '../src/acquisition-personnel/normalization/name-normalizer.js';

/**
 * sync-peo-rosters.ts
 *
 * Phase 3: load Army PEO/CPE (Capability Program Executive) org-chart rosters into
 * acquisition_personnel — real, named, current acquisition leaders (PEO/CPE, deputies,
 * PMs, staff). This is the AUTHORITATIVE "who runs the programs" source the J-books
 * lack.
 *
 * Input: committed roster artifacts scripts/__data__/peo_roster_*.json, each:
 *   { org, formerName?, service, source, asOf, people: [
 *       { fullName, rank?, role, roleTitle, programOfRecord? } ] }
 * produced offline by:
 *   - __tools__/extract_peo_orgchart.py  (text-based org-chart PDFs), or
 *   - hand-captured from a CPE web roster (role->name pairs).
 *
 * People-first: sets organization/role/title/programOfRecord + a citable source
 * mention; does NOT set pe_primary. PE linking is proposed separately by the
 * Phase 1b matcher (now aided by programOfRecord) and confirmed via the review queue.
 *
 * Idempotent: dedup by nameKey (matches DB uniqueness); re-runs add/refresh a
 * source mention instead of duplicating people.
 *
 * Usage: tsx scripts/sync-peo-rosters.ts            # DRY RUN
 *        tsx scripts/sync-peo-rosters.ts --commit    # upsert
 */

interface RosterPerson {
  fullName: string;
  rank?: string | null;
  role?: string | null;
  roleTitle?: string | null;
  programOfRecord?: string | null;
}
interface Roster {
  org: string;
  formerName?: string | null;
  service?: string | null;
  source?: string | null;
  asOf?: string | null;
  people: RosterPerson[];
}

/** Title-case an ALL-CAPS or mixed name for display; preserves suffixes like III, SES, JR. */
function cleanName(name: string): string {
  const keepUpper = new Set(['II', 'III', 'IV', 'V', 'SES', 'JR', 'JR.', 'SR', 'SR.']);
  return name
    .trim()
    .split(/\s+/)
    .map((w) => {
      const bare = w.replace(/[.,]/g, '').toUpperCase();
      if (keepUpper.has(bare)) return w.toUpperCase();
      if (w.length <= 2 && w.endsWith('.')) return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase(); // initials
      return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
    })
    .join(' ')
    .replace(/,$/, '');
}

async function main(): Promise<void> {
  dotenvConfig();
  if (!process.env.DATABASE_URL) {
    console.error('Usage: sync-peo-rosters [--commit] (requires DATABASE_URL)');
    process.exitCode = 2;
    return;
  }
  const commit = process.argv.includes('--commit');
  const dataDir = path.resolve('scripts/__data__');
  const files = fs
    .readdirSync(dataDir)
    .filter((f) => f.startsWith('peo_roster_') && f.endsWith('.json'))
    .map((f) => path.join(dataDir, f));

  const prisma = new PrismaService();
  await prisma.onModuleInit();

  const stats = {
    mode: commit ? 'COMMIT' : 'DRY_RUN',
    rosters: files.length,
    people_seen: 0,
    people_inserted: 0,
    people_updated: 0,
    source_mentions: 0,
  };
  const samples: string[] = [];

  try {
    // Pre-seed existing people by nameKey for idempotent dedup.
    const existing = await prisma.acquisitionPersonnel.findMany({ select: { id: true, nameKey: true } });
    const byNameKey = new Map<string, string>();
    for (const e of existing) if (!byNameKey.has(e.nameKey)) byNameKey.set(e.nameKey, e.id);

    for (const file of files) {
      const roster: Roster = JSON.parse(fs.readFileSync(file, 'utf-8'));
      const observedAt = roster.asOf ? new Date(roster.asOf) : new Date();

      for (const person of roster.people) {
        const fullName = (person.fullName ?? '').trim();
        if (!fullName) continue;
        stats.people_seen += 1;
        const displayName = cleanName(fullName);
        const nameKey = normalizeName(fullName).nameKey;
        const metadata = {
          orgCurrent: roster.org,
          formerName: roster.formerName ?? null,
          rank: person.rank ?? null,
          roleTitle: person.roleTitle ?? null,
          rosterSource: roster.source ?? null,
          rosterAsOf: roster.asOf ?? null,
        };

        if (samples.length < 20) {
          samples.push(`[${person.role ?? '?'}] ${person.rank ?? ''} ${fullName} — ${person.roleTitle ?? ''} (${roster.org})`.replace(/\s+/g, ' ').trim());
        }
        if (!commit) continue;

        const existingId = byNameKey.get(nameKey);
        if (existingId) {
          // Update org/role/title/program if this roster is authoritative, but never
          // clobber an existing pe_primary. Refresh display fields.
          await prisma.acquisitionPersonnel.update({
            where: { id: existingId },
            data: {
              organization: roster.org,
              service: roster.service ?? undefined,
              role: person.role ?? undefined,
              title: person.roleTitle ?? undefined,
              programOfRecord: person.programOfRecord ?? undefined,
              lastSeenAt: observedAt,
            },
          });
          stats.people_updated += 1;
          await prisma.acquisitionPersonnelSource.create({
            data: {
              personId: existingId,
              source: 'army_cpe_roster',
              sourceUrl: null,
              snippet: `${person.roleTitle ?? person.role ?? 'member'} — ${roster.org}${roster.formerName ? ` (formerly ${roster.formerName})` : ''}`,
              observedAt,
              confidence: 0.95,
              metadata,
            },
          });
          stats.source_mentions += 1;
        } else {
          const created = await prisma.acquisitionPersonnel.create({
            data: {
              fullName: displayName,
              nameKey,
              service: roster.service ?? 'ARMY',
              organization: roster.org,
              role: person.role ?? null,
              title: person.roleTitle ?? null,
              programOfRecord: person.programOfRecord ?? null,
              confidence: 0.95,
              status: 'active',
              metadata,
              firstSeenAt: observedAt,
              lastSeenAt: observedAt,
            },
          });
          byNameKey.set(nameKey, created.id);
          stats.people_inserted += 1;
          await prisma.acquisitionPersonnelSource.create({
            data: {
              personId: created.id,
              source: 'army_cpe_roster',
              sourceUrl: null,
              snippet: `${person.roleTitle ?? person.role ?? 'member'} — ${roster.org}${roster.formerName ? ` (formerly ${roster.formerName})` : ''}`,
              observedAt,
              confidence: 0.95,
              metadata,
            },
          });
          stats.source_mentions += 1;
        }
      }
    }

    console.log(JSON.stringify(stats, null, 2));
    console.log('\nSAMPLE PEOPLE:');
    for (const s of samples) console.log('  ' + s);
  } finally {
    await prisma.onModuleDestroy();
  }
}

void main();
