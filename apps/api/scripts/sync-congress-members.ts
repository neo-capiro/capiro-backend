/**
 * Sync the canonical congressional-member roster (Bucket-#3 C6.P6.1 / C1.V1).
 *
 * Two sources, merged on Bioguide ID:
 *   1. api.congress.gov /v3/member/congress/{c} — the official roster (party,
 *      state, district, chamber via terms) for each target congress.
 *   2. unitedstates/congress-legislators (CC0, gh-pages JSON) — the id
 *      crosswalk block (lis for senators — the id Senate roll-call XML uses —
 *      plus fec/opensecrets/govtrack/wikidata/...), merged into idsJsonb.
 *
 * congress_member is a GLOBAL public-record table (congress_bill class).
 * Members appearing in the roster of any target congress are upserted;
 * isCurrent reflects membership in the LATEST target congress. LIS ids that
 * fail to match a roster bioguide are logged (crosswalk lag alarm — the
 * Senate vote sync depends on them).
 *
 *   pnpm --filter @capiro/api exec tsx scripts/sync-congress-members.ts
 * Env: CONGRESS_API_KEY (required), TARGET_CONGRESSES (default "117,118,119").
 */
import { config as dotenvConfig } from 'dotenv';
import { PrismaClient } from '@prisma/client';
import { runWithSyncRun } from '../src/ingestion/sync-run.helper.js';
dotenvConfig();

const prisma = new PrismaClient();
const CONGRESS_API_KEY = process.env.CONGRESS_API_KEY ?? '';
const API_BASE = 'https://api.congress.gov/v3';
const LEGISLATORS_URL =
  'https://unitedstates.github.io/congress-legislators/legislators-current.json';
const TARGET_CONGRESSES = (process.env.TARGET_CONGRESSES ?? '117,118,119')
  .split(',')
  .map((c) => parseInt(c.trim(), 10))
  .filter((c) => Number.isInteger(c) && c > 0);

interface ApiMember {
  bioguideId?: string;
  name?: string;
  partyName?: string;
  state?: string;
  district?: number | null;
  terms?: { item?: Array<{ chamber?: string; startYear?: number; endYear?: number | null }> };
  updateDate?: string | null;
}

interface LegislatorRecord {
  id?: { bioguide?: string; lis?: string; [k: string]: unknown };
  name?: { first?: string; last?: string; official_full?: string };
  terms?: Array<{ type?: string; state?: string; party?: string }>;
}

async function fetchJson<T>(url: string, attempt = 1): Promise<T | null> {
  try {
    const res = await fetch(url, { headers: { accept: 'application/json' } });
    if (res.status === 429 && attempt <= 3) {
      const wait = Number(res.headers.get('retry-after') ?? '30') * 1000;
      await new Promise((r) => setTimeout(r, wait));
      return fetchJson<T>(url, attempt + 1);
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()) as T;
  } catch (err) {
    console.error(`[sync-congress-members] fetch failed ${url}:`, err);
    return null;
  }
}

function splitName(full: string): { first: string; last: string } {
  // API format is "Last, First M." — fall back to whitespace split.
  const comma = full.indexOf(',');
  if (comma > 0) {
    return { last: full.slice(0, comma).trim(), first: full.slice(comma + 1).trim() };
  }
  const parts = full.trim().split(/\s+/);
  return { first: parts.slice(0, -1).join(' '), last: parts[parts.length - 1] ?? full };
}

async function main() {
  if (!CONGRESS_API_KEY) throw new Error('CONGRESS_API_KEY env var is required');
  const latestCongress = Math.max(...TARGET_CONGRESSES);

  await runWithSyncRun(prisma as never, 'sync-congress-members', async () => {
    let inserted = 0;
    let updated = 0;
    let skipped = 0;
    let errors = 0;

    // 1. The CC0 crosswalk: bioguide -> full id block (lis for senators).
    const legislators = (await fetchJson<LegislatorRecord[]>(LEGISLATORS_URL)) ?? [];
    const idsByBioguide = new Map<string, Record<string, unknown>>();
    for (const rec of legislators) {
      const bioguide = rec.id?.bioguide;
      if (bioguide) idsByBioguide.set(bioguide.toUpperCase(), rec.id as Record<string, unknown>);
    }
    if (!legislators.length) {
      console.warn('[sync-congress-members] crosswalk fetch empty — lis ids will be missing');
    }

    // 2. Official roster per target congress (paginated, 250/page).
    for (const congress of TARGET_CONGRESSES) {
      const seen = new Set<string>();
      let offset = 0;
      for (;;) {
        const page = await fetchJson<{ members?: ApiMember[]; pagination?: { count?: number } }>(
          `${API_BASE}/member/congress/${congress}?format=json&limit=250&offset=${offset}&api_key=${CONGRESS_API_KEY}`,
        );
        const members = page?.members ?? [];
        if (!members.length) break;

        for (const m of members) {
          const bioguideId = m.bioguideId?.toUpperCase();
          if (!bioguideId || seen.has(bioguideId)) {
            skipped++;
            continue;
          }
          seen.add(bioguideId);
          const { first, last } = splitName(m.name ?? '');
          const latestTerm = m.terms?.item?.[m.terms.item.length - 1];
          const chamber = latestTerm?.chamber?.toLowerCase().includes('senate')
            ? 'senate'
            : 'house';
          const ids = idsByBioguide.get(bioguideId) ?? null;
          const lisId = typeof ids?.lis === 'string' ? (ids.lis as string) : null;
          try {
            const existing = await prisma.congressMember.findUnique({
              where: { bioguideId },
              select: { bioguideId: true, congresses: true },
            });
            const congresses = Array.from(
              new Set([...(existing?.congresses ?? []), congress]),
            ).sort((a, b) => a - b);
            const data = {
              firstName: first,
              lastName: last,
              fullName: m.name ?? `${first} ${last}`.trim(),
              party: m.partyName ?? null,
              state: m.state ?? null,
              district: typeof m.district === 'number' ? m.district : null,
              chamber,
              lisId,
              isCurrent: congress === latestCongress,
              congresses,
              idsJsonb: (ids ?? {}) as object,
              updateDate: m.updateDate ? new Date(m.updateDate) : null,
              lastSyncedAt: new Date(),
            };
            if (existing) {
              await prisma.congressMember.update({ where: { bioguideId }, data });
              updated++;
            } else {
              await prisma.congressMember.create({ data: { bioguideId, ...data } });
              inserted++;
            }
          } catch (err) {
            errors++;
            console.error(`[sync-congress-members] upsert failed ${bioguideId}:`, err);
          }
        }
        offset += members.length;
        if (page?.pagination?.count !== undefined && offset >= page.pagination.count) break;
        await new Promise((r) => setTimeout(r, 200)); // polite pacing on the shared key
      }
      console.log(`[sync-congress-members] congress ${congress}: ${seen.size} members`);
    }

    // 3. Crosswalk-lag alarm: current senators without a lis id break the
    // Senate vote sync — surface loudly.
    const missingLis = await prisma.congressMember.count({
      where: { isCurrent: true, chamber: 'senate', lisId: null },
    });
    if (missingLis > 0) {
      console.warn(
        `[sync-congress-members] WARNING: ${missingLis} current senator(s) missing lis id — Senate vote crosswalk will lag`,
      );
    }

    return { inserted, updated, skipped, errors };
  });
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
