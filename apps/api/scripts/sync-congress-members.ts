/**
 * Sync the canonical congressional-member roster (Bucket-#3 C6.P6.1 / C1.V1).
 *
 * Three sources, merged on Bioguide ID:
 *   1. api.congress.gov /v3/member/congress/{c} — the official ALL-SERVED
 *      roster (party, state, district, chamber via terms) for each target
 *      congress. A resignation/death/replacement still appears here, so this
 *      collection alone can never say who is serving now.
 *   2. api.congress.gov /v3/member/congress/{latest}?currentMember=true — the
 *      official CURRENTLY-SERVING identity set for the latest target congress.
 *      `isCurrent` is derived ONLY from membership in this set, reconciled
 *      set-based after every member upsert succeeds — never from historical
 *      roster iteration order, and never published from a partial snapshot.
 *   3. unitedstates/congress-legislators (CC0, gh-pages JSON) — the id
 *      crosswalk block (lis for senators — the id Senate roll-call XML uses —
 *      plus fec/opensecrets/govtrack/wikidata/...), merged into idsJsonb.
 *
 * congress_member is a GLOBAL public-record table (congress_bill class).
 * Members appearing in the roster of any target congress are upserted and
 * retained with their full congress history; LIS ids and other identifiers
 * already known are preserved when the CC0 crosswalk is unavailable or lacks
 * the person — absence from the CC0 file is not a deletion signal. LIS ids
 * that fail to match a roster bioguide are logged (crosswalk lag alarm — the
 * Senate vote sync depends on them).
 *
 *   pnpm --filter @capiro/api exec tsx scripts/sync-congress-members.ts
 * Env: CONGRESS_API_KEY (required), TARGET_CONGRESSES (default "117,118,119").
 */
import { createHash } from 'node:crypto';
import { config as dotenvConfig } from 'dotenv';
import { PrismaClient } from '@prisma/client';
import { runWithSyncRun } from '../src/ingestion/sync-run.helper.js';
import type { RunCounts } from '../src/ingestion/sync-run.helper.js';
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

const ROSTER_PAGE_SIZE = 250;
const ROSTER_PACING_MS = 200;
// A single current-serving congress cannot exceed 535 voting members plus a
// bounded set of non-voting delegates/resident commissioners; 20 pages of 250
// is far beyond any legitimate response and catches a stalled continuation.
const MAX_CURRENT_PAGES = 20;

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

/**
 * Minimal Prisma boundary for the roster sync — keeps the runner unit-testable
 * with a mock. Existing member rows are read back with their identifiers so a
 * missing/failed CC0 crosswalk never wipes retained lisId/idsJsonb values.
 */
export interface CongressMemberSyncPrisma {
  congressMember: {
    findUnique(args: { where: { bioguideId: string }; select?: Record<string, true> }): Promise<{
      bioguideId: string;
      congresses: number[];
      lisId: string | null;
      idsJsonb: unknown;
    } | null>;
    update(args: {
      where: { bioguideId: string };
      data: Record<string, unknown>;
    }): Promise<unknown>;
    create(args: { data: Record<string, unknown> }): Promise<unknown>;
    updateMany(args: {
      where: Record<string, unknown>;
      data: { isCurrent: boolean };
    }): Promise<{ count: number }>;
    count(args?: { where?: Record<string, unknown> }): Promise<number>;
  };
  entityCrosswalk: {
    count(args: { where: { source: string } }): Promise<number>;
    deleteMany(args: { where: { source: string } }): Promise<unknown>;
    createMany(args: {
      data: {
        idType: string;
        idValue: string;
        entityType: string;
        entityKey: string;
        source: string;
      }[];
      skipDuplicates: boolean;
    }): Promise<unknown>;
  };
  $transaction(ops: Promise<unknown>[]): Promise<unknown>;
}

export interface SyncCongressMembersOptions {
  targetCongresses: number[];
  apiKey: string;
  fetchFn?: typeof fetch;
  /** Test hook — production pacing stays ROSTER_PACING_MS. */
  pacingMs?: number;
  legislatorsUrl?: string;
  apiBase?: string;
}

interface ApiMemberPage {
  members?: ApiMember[];
  pagination?: { count?: number; next?: string | null };
}

/** Strip the query string so a logged URL can never carry the api_key value. */
function sanitizeUrlForLog(url: string): string {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return url.split('?')[0] ?? url;
  }
}

// Retries 429 AND 5xx, then THROWS. A roster page that silently fails must
// fail the RUN — treating it as end-of-data truncates the walk and (worse)
// makes the crosswalk snapshot-replace below delete rows for every member on
// the unfetched pages. Matches sync-congress's fetchJson posture. Errors name
// only origin+path+status — never the query string, which carries the api key.
// The network-failure catch rethrows a redacted error: a transport message can
// embed the full authenticated URL, so the original message is not propagated.
async function fetchJson<T>(url: string, attempt = 1, fetchFn: typeof fetch = fetch): Promise<T> {
  let res: Response;
  try {
    res = await fetchFn(url, { headers: { accept: 'application/json' } });
  } catch {
    if (attempt <= 3) {
      await new Promise((r) => setTimeout(r, attempt * 2000));
      return fetchJson<T>(url, attempt + 1, fetchFn);
    }
    throw new Error(`fetch failed for ${sanitizeUrlForLog(url)} (transport error)`);
  }
  if ((res.status === 429 || res.status >= 500) && attempt <= 3) {
    const wait = Number(res.headers.get('retry-after') ?? String(attempt * 15)) * 1000;
    await new Promise((r) => setTimeout(r, wait));
    return fetchJson<T>(url, attempt + 1, fetchFn);
  }
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${sanitizeUrlForLog(url)}`);
  return (await res.json()) as T;
}

// External-id namespaces worth crosswalking (Bucket-#3 C6, entity_crosswalk).
// lis = Senate roll-call XML key; fec is an ARRAY in the source (one id per
// candidacy). Everything else in the id block (ballotpedia, cspan, ...) is
// noise for lobbying workflows — extend deliberately, not wholesale.
const CROSSWALK_ID_TYPES = ['lis', 'fec', 'opensecrets', 'govtrack', 'wikidata', 'thomas'] as const;

export function buildCrosswalkRows(
  bioguideId: string,
  ids: Record<string, unknown>,
): { idType: string; idValue: string; entityType: string; entityKey: string; source: string }[] {
  const rows: {
    idType: string;
    idValue: string;
    entityType: string;
    entityKey: string;
    source: string;
  }[] = [];
  for (const idType of CROSSWALK_ID_TYPES) {
    const raw = ids[idType];
    const values = Array.isArray(raw) ? raw : raw !== undefined && raw !== null ? [raw] : [];
    for (const v of values) {
      const idValue = String(v).trim();
      if (!idValue) continue;
      rows.push({
        idType,
        idValue,
        entityType: 'member',
        entityKey: bioguideId,
        source: 'sync-congress-members',
      });
    }
  }
  return rows;
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

/** Normalize a source bioguide id, or null when it is not a non-blank string. */
function normalizeBioguideId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.toUpperCase() : null;
}

/**
 * Deterministic source-identity fingerprint of the validated current set:
 * SHA256 over the unique uppercase bioguide ids, sorted lexically and joined
 * with '\n' (no trailing newline). The SELECT-only release collector computes
 * the same hash from persisted current rows to prove the published snapshot
 * matches the official source without another provider call.
 */
export function currentIdentityHash(ids: Iterable<string>): string {
  const sorted = Array.from(ids, (id) => id.toUpperCase()).sort();
  return createHash('sha256').update(sorted.join('\n'), 'utf8').digest('hex');
}

/**
 * Fully retrieve the official CURRENTLY-SERVING roster for one congress
 * (/member/congress/{c}?currentMember=true). Returns the complete member
 * objects ONLY when every page validates: the pagination count must be a
 * positive integer that stays identical across every page, every entry must
 * carry a non-blank string bioguide id, each page must add at least one new
 * id, and the walk must terminate with the unique-id set equal to the count.
 * Any failure — a fetch error, a missing/changed count, a malformed identity,
 * a duplicate-only continuation, or a truncated/overshooting walk — throws,
 * so a partial current snapshot can never reconcile flags. The returned rows
 * are the real API member records (not fabricated placeholders) so
 * current-only members can be upserted with full source fidelity.
 */
async function fetchCompleteCurrentMembers(
  congress: number,
  apiKey: string,
  fetchFn: typeof fetch,
  apiBase: string,
  pacingMs: number,
): Promise<ApiMember[]> {
  const membersById = new Map<string, ApiMember>();
  let expectedCount: number | null = null;
  let offset = 0;
  for (let pageNum = 1; pageNum <= MAX_CURRENT_PAGES; pageNum++) {
    const page = await fetchJson<ApiMemberPage>(
      `${apiBase}/member/congress/${congress}?currentMember=true&format=json&limit=${ROSTER_PAGE_SIZE}&offset=${offset}&api_key=${apiKey}`,
      1,
      fetchFn,
    );
    const members = page?.members;
    if (!Array.isArray(members) || members.length === 0) {
      throw new Error(
        `current roster page for congress ${congress} at offset ${offset} returned no usable members`,
      );
    }
    const count = page?.pagination?.count;
    if (typeof count !== 'number' || !Number.isInteger(count) || count <= 0) {
      throw new Error(
        `current roster page for congress ${congress} at offset ${offset} has no valid pagination count`,
      );
    }
    if (expectedCount === null) {
      expectedCount = count;
    } else if (count !== expectedCount) {
      throw new Error(
        `current roster count changed mid-walk for congress ${congress}: ${expectedCount} -> ${count} at offset ${offset}`,
      );
    }
    const before = membersById.size;
    for (const m of members) {
      const bioguideId = normalizeBioguideId(m?.bioguideId);
      if (!bioguideId) {
        throw new Error(
          `current roster page for congress ${congress} at offset ${offset} contains a member with a malformed bioguide id`,
        );
      }
      membersById.set(bioguideId, m);
    }
    offset += members.length;
    if (offset >= expectedCount) {
      if (membersById.size !== expectedCount) {
        throw new Error(
          `current roster for congress ${congress} incomplete: ${membersById.size} unique ids vs reported count ${expectedCount}`,
        );
      }
      return Array.from(membersById.values());
    }
    if (membersById.size === before) {
      throw new Error(
        `current roster for congress ${congress} stalled at offset ${offset} (duplicate-only page)`,
      );
    }
    await new Promise((r) => setTimeout(r, pacingMs));
  }
  throw new Error(
    `current roster for congress ${congress} exceeded ${MAX_CURRENT_PAGES} pages — refusing incomplete snapshot`,
  );
}

/**
 * Merge the CC0 identifier block into a member write without ever deleting
 * known identifiers: a crosswalk that is unavailable, or one that lacks this
 * person (or a specific key), preserves what the DB already knows. Only a
 * supplied non-blank value updates. Absence is not a deletion signal — the
 * Senate vote sync resolves historical roll calls through retained lis ids.
 */
function mergeIdentifiers(
  ids: Record<string, unknown> | null,
  existing: { lisId: string | null; idsJsonb: unknown } | null,
): { lisId: string | null; idsJsonb: Record<string, unknown> } {
  const existingIds =
    existing?.idsJsonb && typeof existing.idsJsonb === 'object' && !Array.isArray(existing.idsJsonb)
      ? (existing.idsJsonb as Record<string, unknown>)
      : {};
  if (!ids) {
    return { lisId: existing?.lisId ?? null, idsJsonb: existingIds };
  }
  const merged: Record<string, unknown> = { ...existingIds };
  for (const [key, value] of Object.entries(ids)) {
    if (value === undefined || value === null) continue;
    if (typeof value === 'string' && !value.trim()) continue;
    if (Array.isArray(value) && value.length === 0) continue;
    merged[key] = value;
  }
  const suppliedLis = typeof ids.lis === 'string' && ids.lis.trim() ? ids.lis : null;
  return { lisId: suppliedLis ?? existing?.lisId ?? null, idsJsonb: merged };
}

/**
 * Normalize one roster API member (all-served or current-serving — the item
 * shape is the documented member list entry) into a congress_member write.
 * `isCurrent` is deliberately ABSENT from the write — current flags are owned
 * exclusively by the post-upsert snapshot reconciliation, so a failed or
 * reordered historical pass can never publish a partial current roster.
 */
export function toMemberWrite(
  m: ApiMember,
  congress: number,
  ids: Record<string, unknown> | null,
  existing: { congresses: number[]; lisId: string | null; idsJsonb: unknown } | null,
): { bioguideId: string; data: Record<string, unknown> } | null {
  const bioguideId = m.bioguideId?.toUpperCase();
  if (!bioguideId) return null;
  const { first, last } = splitName(m.name ?? '');
  const latestTerm = m.terms?.item?.[m.terms.item.length - 1];
  const chamber = latestTerm?.chamber?.toLowerCase().includes('senate') ? 'senate' : 'house';
  const { lisId, idsJsonb } = mergeIdentifiers(ids, existing);
  const congresses = Array.from(new Set([...(existing?.congresses ?? []), congress])).sort(
    (a, b) => a - b,
  );
  return {
    bioguideId,
    data: {
      firstName: first,
      lastName: last,
      fullName: m.name ?? `${first} ${last}`.trim(),
      party: m.partyName ?? null,
      state: m.state ?? null,
      district: typeof m.district === 'number' ? m.district : null,
      chamber,
      lisId,
      congresses,
      idsJsonb,
      updateDate: m.updateDate ? new Date(m.updateDate) : null,
      lastSyncedAt: new Date(),
    },
  };
}

export async function runSyncCongressMembers(
  prismaLike: CongressMemberSyncPrisma,
  options: SyncCongressMembersOptions,
): Promise<RunCounts> {
  const fetchFn = options.fetchFn ?? fetch;
  const apiBase = options.apiBase ?? API_BASE;
  const legislatorsUrl = options.legislatorsUrl ?? LEGISLATORS_URL;
  const pacingMs = options.pacingMs ?? ROSTER_PACING_MS;
  const targetCongresses = options.targetCongresses;
  if (!options.apiKey) throw new Error('CONGRESS_API_KEY env var is required');
  if (!targetCongresses.length) throw new Error('TARGET_CONGRESSES resolved to an empty list');
  const latestCongress = Math.max(...targetCongresses);

  return runWithSyncRun(prismaLike as never, 'sync-congress-members', async () => {
    let inserted = 0;
    let updated = 0;
    let skipped = 0;
    let errors = 0;

    // 1. The CC0 crosswalk: bioguide -> full id block (lis for senators).
    // Tolerated failure: rosters still sync without it, and identifier merging
    // preserves every previously known lisId/idsJsonb value (no wipe).
    let legislators: LegislatorRecord[] = [];
    try {
      legislators = await fetchJson<LegislatorRecord[]>(legislatorsUrl, 1, fetchFn);
    } catch (err) {
      console.error('[sync-congress-members] crosswalk fetch failed:', err);
    }
    const idsByBioguide = new Map<string, Record<string, unknown>>();
    for (const rec of legislators) {
      const bioguide = rec.id?.bioguide;
      if (bioguide) idsByBioguide.set(bioguide.toUpperCase(), rec.id as Record<string, unknown>);
    }
    if (!legislators.length) {
      console.warn('[sync-congress-members] crosswalk fetch empty — known identifiers preserved');
    }

    // 2. Official ALL-SERVED roster per target congress (paginated, 250/page).
    // Historical upserts never touch isCurrent — the flag is reconciled only
    // from the validated current snapshot in steps 3-4. A member who served
    // the latest congress but later departed is therefore NOT marked current
    // here, and iteration order of TARGET_CONGRESSES cannot change the outcome.
    const allSeen = new Set<string>();
    for (const congress of targetCongresses) {
      const seen = new Set<string>();
      let offset = 0;
      for (;;) {
        const page = await fetchJson<ApiMemberPage>(
          `${apiBase}/member/congress/${congress}?format=json&limit=${ROSTER_PAGE_SIZE}&offset=${offset}&api_key=${options.apiKey}`,
          1,
          fetchFn,
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
          allSeen.add(bioguideId);
          try {
            const existing = await prismaLike.congressMember.findUnique({
              where: { bioguideId },
              select: { bioguideId: true, congresses: true, lisId: true, idsJsonb: true },
            });
            const write = toMemberWrite(
              m,
              congress,
              idsByBioguide.get(bioguideId) ?? null,
              existing,
            );
            if (!write) {
              skipped++;
              continue;
            }
            if (existing) {
              await prismaLike.congressMember.update({ where: { bioguideId }, data: write.data });
              updated++;
            } else {
              // New rows are created with the schema default isCurrent=false;
              // the reconciliation below flips the ones the current snapshot
              // actually contains.
              await prismaLike.congressMember.create({
                data: { bioguideId, ...write.data },
              });
              inserted++;
            }
          } catch (err) {
            errors++;
            console.error(`[sync-congress-members] upsert failed ${bioguideId}:`, err);
          }
        }
        offset += members.length;
        if (page?.pagination?.count !== undefined && offset >= page.pagination.count) break;
        await new Promise((r) => setTimeout(r, pacingMs)); // polite pacing on the shared key
      }
      console.log(`[sync-congress-members] congress ${congress}: ${seen.size} members`);
    }

    // Any failed member write means the roster state is not fully known —
    // reconciling current flags now could publish a misleading snapshot, so
    // the run reports its errors without touching flags (existing posture).
    if (errors === 0) {
      // 3. The complete official CURRENT-serving roster for the latest target
      // congress, validated BEFORE any flag changes. A throw here (failed,
      // malformed, stalled or incomplete page) fails the run — prior current
      // flags stay exactly as they were. These are REAL member records; any
      // current-serving member the all-served pages missed is upserted from
      // this data below, never fabricated.
      const currentMembers = await fetchCompleteCurrentMembers(
        latestCongress,
        options.apiKey,
        fetchFn,
        apiBase,
        pacingMs,
      );
      const currentIds = new Set(currentMembers.map((m) => normalizeBioguideId(m.bioguideId)!));

      // Upsert every current-serving member absent from the all-served pages
      // (brand-new member whose all-served listing lagged, or an existing row
      // the historical passes did not refresh). Uses the same toMemberWrite
      // mapping with latestCongress history, and adds them to the crosswalk
      // scope. A failure here refuses reconciliation — the snapshot is only
      // publishable once every current member has a retained row.
      for (const m of currentMembers) {
        const bioguideId = normalizeBioguideId(m.bioguideId)!;
        if (allSeen.has(bioguideId)) continue;
        try {
          const existing = await prismaLike.congressMember.findUnique({
            where: { bioguideId },
            select: { bioguideId: true, congresses: true, lisId: true, idsJsonb: true },
          });
          const write = toMemberWrite(
            m,
            latestCongress,
            idsByBioguide.get(bioguideId) ?? null,
            existing,
          );
          if (!write) continue;
          if (existing) {
            await prismaLike.congressMember.update({ where: { bioguideId }, data: write.data });
            updated++;
          } else {
            await prismaLike.congressMember.create({ data: { bioguideId, ...write.data } });
            inserted++;
          }
          allSeen.add(bioguideId);
        } catch (err) {
          console.error(
            `[sync-congress-members] current-only member upsert failed ${bioguideId}:`,
            err,
          );
          throw new Error(
            `current snapshot member ${bioguideId} could not be retained — refusing to reconcile flags`,
          );
        }
      }

      // 4. Atomic bounded reconciliation: exactly two set-based updates, only
      // after the complete current snapshot validated and every upsert
      // succeeded. Departed members (previously current, absent from the
      // snapshot — including rows absent from every historical page this run)
      // become false; serving members become true. No roster row is deleted.
      const [cleared, set] = (await prismaLike.$transaction([
        prismaLike.congressMember.updateMany({
          where: { isCurrent: true, bioguideId: { notIn: Array.from(currentIds) } },
          data: { isCurrent: false },
        }),
        prismaLike.congressMember.updateMany({
          where: { bioguideId: { in: Array.from(currentIds) } },
          data: { isCurrent: true },
        }),
      ])) as [{ count: number }, { count: number }];
      // The source identity hash lets the SELECT-only release collector prove
      // persisted current rows match this validated snapshot — no extra
      // provider call needed.
      const sourceHash = currentIdentityHash(currentIds);
      console.log(
        `[sync-congress-members] current snapshot (${currentIds.size} serving): ${set.count} flagged current, ${cleared.count} reconciled non-current; source identity sha256=${sourceHash}`,
      );
    } else {
      console.warn(
        `[sync-congress-members] ${errors} member upsert(s) failed — current flags left unreconciled`,
      );
    }

    // 5. entity_crosswalk (Bucket-#3 C6): external-id -> bioguide rows for
    // every member this run touched (all-served plus current-only). Snapshot-
    // replace for THIS source only — other syncs' crosswalk rows are
    // untouched. Guards: skip the replace on a valid-but-partial legislators
    // payload (~535 current members) or when the new snapshot shrank
    // suspiciously vs the DB; swap atomically so the live resolve_entity
    // reader never observes an empty table mid-swap.
    const crosswalkRows = Array.from(allSeen).flatMap((bioguideId) => {
      const ids = idsByBioguide.get(bioguideId);
      return ids ? buildCrosswalkRows(bioguideId, ids) : [];
    });
    const existingCrosswalk = await prismaLike.entityCrosswalk.count({
      where: { source: 'sync-congress-members' },
    });
    if (legislators.length < 400) {
      console.warn(
        `[sync-congress-members] legislators payload small (${legislators.length}) — keeping existing crosswalk rows`,
      );
    } else if (
      crosswalkRows.length === 0 ||
      (existingCrosswalk > 0 && crosswalkRows.length < existingCrosswalk * 0.5)
    ) {
      console.warn(
        `[sync-congress-members] crosswalk snapshot suspiciously small (${crosswalkRows.length} vs ${existingCrosswalk} in DB) — keeping existing rows`,
      );
    } else {
      await prismaLike.$transaction([
        prismaLike.entityCrosswalk.deleteMany({ where: { source: 'sync-congress-members' } }),
        prismaLike.entityCrosswalk.createMany({ data: crosswalkRows, skipDuplicates: true }),
      ]);
      console.log(`[sync-congress-members] entity_crosswalk: ${crosswalkRows.length} rows`);
    }

    // 6. Crosswalk-lag alarm: current senators without a lis id break the
    // Senate vote sync — surface loudly.
    const missingLis = await prismaLike.congressMember.count({
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

async function main() {
  await runSyncCongressMembers(prisma as unknown as CongressMemberSyncPrisma, {
    targetCongresses: TARGET_CONGRESSES,
    apiKey: CONGRESS_API_KEY,
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
