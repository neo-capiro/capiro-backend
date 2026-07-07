/**
 * Canonical congressional committee registry + membership rosters
 * (Bucket-#3 C6.P6.1). Two CC0 sources, two requests per run:
 *   1. committees-current.json — committees + nested subcommittees.
 *   2. committee-membership-current.json — rosters keyed by thomas id,
 *      members keyed by bioguide. This is the ONLY machine-readable roster
 *      source: the Congress.gov API has no membership endpoint (verified
 *      live 2026-07-06 against /v3/committee/house/hsag00).
 *
 * Keying: rows use the Congress.gov systemCode (the registry's canonical
 * 'committee' id). thomas_id maps deterministically: lowercase + "00" for
 * full committees (HSAG -> hsag00), lowercase parent + 2-digit sub id for
 * subcommittees (HSAG + "16" -> hsag16) — verified against live
 * congress.gov subcommittee lists.
 *
 * Memberships are a full-snapshot replace (delete-all + recreate); rows
 * whose committee is missing from committees-current are skipped, not
 * invented. side is the dataset's 'majority'/'minority' — join
 * congress_member for real party/chamber.
 *
 *   pnpm --filter @capiro/api exec tsx scripts/sync-committees.ts
 */
import { config as dotenvConfig } from 'dotenv';
import { PrismaClient } from '@prisma/client';
import { runWithSyncRun } from '../src/ingestion/sync-run.helper.js';
dotenvConfig();

const prisma = new PrismaClient();
const COMMITTEES_URL =
  process.env.COMMITTEES_URL ??
  'https://unitedstates.github.io/congress-legislators/committees-current.json';
const MEMBERSHIP_URL =
  process.env.COMMITTEE_MEMBERSHIP_URL ??
  'https://unitedstates.github.io/congress-legislators/committee-membership-current.json';

interface CommitteeRecord {
  type?: string; // 'house' | 'senate' | 'joint'
  name?: string;
  url?: string;
  thomas_id?: string;
  jurisdiction?: string;
  subcommittees?: Array<{ name?: string; thomas_id?: string }>;
}

interface MembershipRecord {
  bioguide?: string;
  name?: string;
  party?: string; // 'majority' | 'minority'
  rank?: number;
  title?: string;
}

/** Congress.gov systemCode for a full committee ("HSAG" -> "hsag00"). */
export function systemCodeForCommittee(thomasId: string): string {
  return `${thomasId.toLowerCase()}00`;
}

/** Congress.gov systemCode for a subcommittee ("HSAG", "16" -> "hsag16"). */
export function systemCodeForSubcommittee(parentThomasId: string, subThomasId: string): string {
  return `${parentThomasId.toLowerCase()}${subThomasId}`;
}

/**
 * Membership-file key -> systemCode. Keys are the parent thomas id alone
 * ("HSAG" -> hsag00) or parent + 2-digit sub id ("HSAG16" -> hsag16).
 * Null for keys that don't match either shape.
 */
export function membershipKeyToSystemCode(key: string): string | null {
  const m = key.match(/^([A-Z]{4})(\d{2})?$/);
  if (!m?.[1]) return null;
  return `${m[1].toLowerCase()}${m[2] ?? '00'}`;
}

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`fetch failed ${url}: HTTP ${res.status}`);
  return (await res.json()) as T;
}

async function main() {
  await runWithSyncRun(prisma as never, 'sync-committees', async () => {
    let inserted = 0;
    let updated = 0;
    let skipped = 0;
    let errors = 0;

    const committees = await fetchJson<CommitteeRecord[]>(COMMITTEES_URL);
    if (!Array.isArray(committees) || committees.length === 0) {
      throw new Error('committees-current.json empty — refusing to sweep isCurrent');
    }

    // Build the full row set FIRST so the magnitude guards below see the whole
    // snapshot before anything destructive runs.
    const seen = new Set<string>();
    const allRows: Array<{
      systemCode: string;
      thomasId: string;
      name: string;
      chamber: string;
      parentSystemCode: string | null;
      url: string | null;
      jurisdiction: string | null;
    }> = [];
    for (const c of committees) {
      if (!c.thomas_id || !c.name) {
        skipped++;
        continue;
      }
      const chamber = c.type ?? 'house';
      allRows.push(
        {
          systemCode: systemCodeForCommittee(c.thomas_id),
          thomasId: c.thomas_id,
          name: c.name,
          chamber,
          parentSystemCode: null,
          url: c.url ?? null,
          jurisdiction: c.jurisdiction ?? null,
        },
        ...(c.subcommittees ?? [])
          .filter((s) => s.thomas_id && s.name)
          .map((s) => ({
            systemCode: systemCodeForSubcommittee(c.thomas_id!, s.thomas_id!),
            thomasId: `${c.thomas_id}${s.thomas_id}`,
            name: s.name!,
            chamber,
            parentSystemCode: systemCodeForCommittee(c.thomas_id!),
            url: null,
            jurisdiction: null,
          })),
      );
    }
    for (const row of allRows) seen.add(row.systemCode);

    // Magnitude guard (not just zero): a VALID-but-partial upstream file (e.g.
    // only House committees after an upstream generator bug) must not sweep
    // isCurrent off everything else or gut the roster replace below. Congress
    // has ~50 committees / ~230 committee+subcommittee codes; refuse anything
    // that shrank suspiciously vs an absolute floor or the current DB state.
    const existingCurrent = await prisma.congressCommittee.count({ where: { isCurrent: true } });
    if (seen.size < 100 || (existingCurrent > 0 && seen.size < existingCurrent * 0.5)) {
      throw new Error(
        `committees snapshot suspiciously small (${seen.size} codes vs ${existingCurrent} current in DB) — refusing to sweep/replace`,
      );
    }

    for (const row of allRows) {
      try {
        const existing = await prisma.congressCommittee.findUnique({
          where: { systemCode: row.systemCode },
          select: { systemCode: true },
        });
        const data = { ...row, isCurrent: true, lastSyncedAt: new Date() };
        if (existing) {
          await prisma.congressCommittee.update({
            where: { systemCode: row.systemCode },
            data,
          });
          updated++;
        } else {
          await prisma.congressCommittee.create({ data });
          inserted++;
        }
      } catch (err) {
        errors++;
        console.error(`[sync-committees] upsert failed ${row.systemCode}:`, err);
      }
    }
    if (errors > allRows.length * 0.2) {
      throw new Error(`${errors} committee upserts failed — refusing to sweep/replace`);
    }

    // Committees that fell out of the current snapshot are no longer current.
    const swept = await prisma.congressCommittee.updateMany({
      where: { systemCode: { notIn: Array.from(seen) }, isCurrent: true },
      data: { isCurrent: false },
    });
    if (swept.count > 0) {
      console.log(`[sync-committees] marked ${swept.count} committee(s) not current`);
    }

    // Membership rosters: full-snapshot replace.
    const membership = await fetchJson<Record<string, MembershipRecord[]>>(MEMBERSHIP_URL);
    const memberRows: {
      systemCode: string;
      bioguideId: string;
      side: string;
      rank: number | null;
      title: string | null;
    }[] = [];
    let membershipSkipped = 0;
    for (const [key, members] of Object.entries(membership)) {
      const systemCode = membershipKeyToSystemCode(key);
      if (!systemCode || !seen.has(systemCode)) {
        membershipSkipped += members?.length ?? 0;
        continue;
      }
      for (const m of members ?? []) {
        if (!m.bioguide || !m.party) continue;
        memberRows.push({
          systemCode,
          bioguideId: m.bioguide.toUpperCase(),
          side: m.party,
          rank: typeof m.rank === 'number' ? m.rank : null,
          title: m.title ?? null,
        });
      }
    }
    // Magnitude guard on the roster replace (same reasoning as above —
    // ~2,000+ seats exist; zero-only checks don't catch partial payloads),
    // then swap atomically so the live resolve_entity reader and a mid-swap
    // crash both see either the old snapshot or the new one, never neither.
    const existingMemberships = await prisma.congressCommitteeMembership.count();
    if (
      memberRows.length < 500 ||
      (existingMemberships > 0 && memberRows.length < existingMemberships * 0.5)
    ) {
      throw new Error(
        `membership snapshot suspiciously small (${memberRows.length} rows vs ${existingMemberships} in DB) — refusing to wipe rosters`,
      );
    }
    await prisma.$transaction([
      prisma.congressCommitteeMembership.deleteMany({}),
      prisma.congressCommitteeMembership.createMany({ data: memberRows, skipDuplicates: true }),
    ]);
    console.log(
      `[sync-committees] memberships: ${memberRows.length} rows across ${seen.size} committees` +
        (membershipSkipped ? ` (${membershipSkipped} skipped — unknown committee key)` : ''),
    );

    return { inserted, updated, skipped, errors };
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
