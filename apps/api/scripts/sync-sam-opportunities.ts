/**
 * Step 3.1 — SAM.gov DoD contract-opportunities ingestion + review-gated matching.
 *
 *   pnpm --filter @capiro/api sync:sam-opportunities -- --commit
 *   tsx scripts/sync-sam-opportunities.ts --since 2026-05-01 --commit
 *
 * Pulls DoD Contract Opportunities from the SAM.gov API
 * (api.sam.gov/opportunities/v2/search), upserts each notice into sam_opportunity
 * (idempotent on noticeId), derives `active` from the archive date, then runs a PURE,
 * review-gated matching pass (sam-opportunity-matcher) to propose opportunity ->
 * PE / program links into sam_opportunity_match.
 *
 * Wrapped in runWithSyncRun: the incremental window comes from the last successful
 * run's watermark (ctx.since), or an explicit `--since YYYY-MM-DD`. DoD-filtered via
 * the deptname API filter AND a client-side org-path check (defense in depth).
 *
 * HISTORICAL BACKFILL. The daily job only pulls the last ~30 days; older/closed
 * notices need a one-off backfill. SAM.gov caps a single search's date span at ~1
 * year, so walk it in <=1yr windows (newest first is fine — upsert is idempotent):
 *   tsx scripts/sync-sam-opportunities.ts --backfill --since 2024-07-01 --posted-to 2025-06-30 --commit
 *   tsx scripts/sync-sam-opportunities.ts --backfill --since 2023-07-01 --posted-to 2024-06-30 --commit
 * `--backfill` bypasses the "already running" guard (so a manual run isn't skipped
 * by the daily cron) and does NOT touch the incremental watermark (the SyncRun's
 * startedAt is wall-clock now, so the daily floor is unaffected). Raise the page
 * circuit-breaker for dense windows with SAM_MAX_PAGES (default 50 -> 5,000 rows);
 * if a window is capped the run logs a loud CAPPED warning so no gap goes silent.
 *
 * Review gating (sam-opportunity-matcher):
 *   - a verbatim PE-code hit in the text         -> review_status 'accepted'
 *   - a program alias + office/PSC agreement     -> review_status 'candidate'
 *   - PSC/NAICS alone                            -> review_status 'quarantined'
 * No fuzzy / coarse path is ever auto-accepted.
 *
 * Requires SAM_GOV_API_KEY (Secrets Manager -> env). Dry-run by default; pass
 * `--commit` to write. Idempotent.
 *
 * MATCH-ONLY (no API key, no network):
 *   tsx scripts/sync-sam-opportunities.ts --match-only --commit   # (verb: rematch-sam-opportunities)
 * Re-runs the pure matcher over EVERY existing sam_opportunity row to realize a
 * matcher change (e.g. procurement-BLIN recognition) across the ingested backlog —
 * the daily sync only re-matches the notices it freshly fetches.
 */
import { config as dotenvConfig } from 'dotenv';
import { PrismaClient } from '@prisma/client';
import { runWithSyncRun, type RunCounts } from '../src/ingestion/sync-run.helper.js';
import {
  matchOpportunity,
  trigrams,
  normalizeText,
  type AliasForMatch,
  type OpportunityForMatch,
  type ProposedSamMatch,
} from './sam-opportunity-matcher.js';
import { extractPromotedFields } from './backfill-sam-opportunity-fields.js';

dotenvConfig();

const SAM_URL = 'https://api.sam.gov/opportunities/v2/search';
const SOURCE = 'sync-sam-opportunities';
const DEFAULT_LOOKBACK_DAYS = 30;
const PAGE_LIMIT = 100;
// Circuit breaker on pages/run (PAGE_LIMIT rows each). Env-overridable so a dense
// historical backfill window can pull deeper than the daily's 5,000-row default.
const MAX_PAGES = Number(process.env.SAM_MAX_PAGES) || 50;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

/** MM/dd/yyyy (SAM.gov date format). */
function samDate(d: Date): string {
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${mm}/${dd}/${d.getUTCFullYear()}`;
}

function safeDate(v: string | null | undefined): Date | null {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

function str(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s.length ? s : null;
}

// ── SAM.gov opportunities/v2 record (the subset we read) ─────────────────────
interface SamPlaceOfPerformance {
  city?: { code?: string; name?: string };
  state?: { code?: string; name?: string };
  zip?: string;
  country?: { code?: string; name?: string };
}
interface SamPointOfContact {
  fullName?: string;
  email?: string;
  type?: string;
}
interface SamOpportunityRecord {
  noticeId?: string;
  solicitationNumber?: string;
  title?: string;
  type?: string; // notice type
  /** The notice's ORIGINAL type before amendment. Promoted to its own column. */
  baseType?: string;
  /** Set-aside code and its human-readable description, when the notice restricts. */
  typeOfSetAside?: string;
  typeOfSetAsideDescription?: string;
  fullParentPathName?: string; // org hierarchy "DEPT OF DEFENSE.DEPT OF THE ARMY..."
  department?: string;
  subTier?: string;
  office?: string;
  organizationType?: string;
  classificationCode?: string; // PSC
  naicsCode?: string;
  postedDate?: string;
  responseDeadLine?: string;
  archiveDate?: string;
  description?: string; // a URL to the description endpoint OR inline text
  pointOfContact?: SamPointOfContact[];
  placeOfPerformance?: SamPlaceOfPerformance;
  uiLink?: string;
  active?: string; // 'Yes' | 'No'
}

interface SamSearchResponse {
  totalRecords?: number;
  opportunitiesData?: SamOpportunityRecord[];
  error?: { message?: string };
}

/** Is this notice from DoD? (org-path / department check — mirrors the personnel sync). */
function isDod(rec: SamOpportunityRecord): boolean {
  const hay =
    `${rec.fullParentPathName ?? ''} ${rec.department ?? ''} ${rec.subTier ?? ''}`.toUpperCase();
  return /DEPT OF DEFENSE|DEPARTMENT OF DEFENSE|\bDOD\b|DEPT OF THE (ARMY|NAVY|AIR FORCE)|DEFENSE/.test(
    hay,
  );
}

/** Sub-department agency from the org path. SAM's `department`/`subTier` fields
 *  are almost always null on DoD records, but `fullParentPathName` is populated
 *  ("DEPT OF DEFENSE.DEFENSE LOGISTICS AGENCY.DLA MARITIME..."). We take the 2nd
 *  segment — the meaningful service/agency (Army, Navy, Air Force, DLA, DISA…) —
 *  falling back to the API fields and finally the top segment. */
function agencyOf(rec: SamOpportunityRecord): string | null {
  const segs = (rec.fullParentPathName ?? '')
    .split('.')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return (
    str(rec.department) ??
    str(rec.subTier) ??
    (segs.length > 1 ? str(segs[1]) : null) ??
    (segs.length > 0 ? str(segs[0]) : null)
  );
}

/** Best-effort contracting-office label: SAM's office field if present, else the
 *  deepest (most specific) org-path segment. */
function officeOf(rec: SamOpportunityRecord): string | null {
  const segs = (rec.fullParentPathName ?? '')
    .split('.')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return (
    str(rec.office) ??
    (segs.length > 2 ? str(segs[segs.length - 1]) : null) ??
    str(rec.subTier) ??
    str(rec.department)
  );
}

/** First POC's name + email (public header fields). */
function primaryPoc(rec: SamOpportunityRecord): { name: string | null; email: string | null } {
  const poc =
    (rec.pointOfContact ?? []).find((p) => (p.type ?? '').toLowerCase() === 'primary') ??
    (rec.pointOfContact ?? [])[0];
  return { name: str(poc?.fullName), email: str(poc?.email) };
}

async function fetchPage(
  apiKey: string,
  postedFrom: string,
  postedTo: string,
  offset: number,
): Promise<SamSearchResponse> {
  const params = new URLSearchParams({
    api_key: apiKey,
    postedFrom,
    postedTo,
    limit: String(PAGE_LIMIT),
    offset: String(offset),
    deptname: 'DEPARTMENT OF DEFENSE',
  });
  const res = await fetch(`${SAM_URL}?${params.toString()}`);
  const json = (await res.json()) as SamSearchResponse;
  if (!res.ok) {
    throw new Error(
      `SAM.gov ${res.status}: ${json.error?.message ?? JSON.stringify(json).slice(0, 200)}`,
    );
  }
  return json;
}

/**
 * Build the in-memory alias index the matcher needs: each program alias with its
 * precomputed trigram set + optional office/PSC corroboration hints. Pure shaping —
 * no network.
 *
 * ⚠️ DORMANT TIER: the matcher's `program_alias` tier only emits a match when a
 * trigram-hit alias ALSO has office/PSC agreement (matchOpportunity precision guard).
 * No office/PSC hint source is wired today — the `ProgramAlias` model has NO
 * officeHint/pscHints columns, and the caller's query below selects only
 * {programId, aliasNormalized, aliasType}. So `officeHint`/`pscHints` are always
 * undefined here and the `program_alias` tier NEVER fires in production; SAM matches
 * come only from the description_pe_code (verbatim) and psc_naics_component
 * (quarantined) tiers. To activate the alias tier, derive per-program office/PSC
 * hints (e.g. the contracting offices + PSCs seen on that program's federal_award
 * history) into new ProgramAlias columns and select them here — see the coverage
 * remediation plan §4.2. The fields are kept optional so that enhancement is additive.
 */
function buildAliasIndex(
  aliases: Array<{
    programId: string;
    aliasNormalized: string;
    aliasType: string;
    officeHint?: string | null;
    pscHints?: string[];
  }>,
): AliasForMatch[] {
  return aliases.map((a) => ({
    programId: a.programId,
    aliasNormalized: a.aliasNormalized,
    aliasType: a.aliasType,
    tg: trigrams(a.aliasNormalized),
    officeHint: a.officeHint ?? null,
    pscHints: a.pscHints ? new Set(a.pscHints.map((p) => p.toUpperCase())) : undefined,
  }));
}

async function main(): Promise<void> {
  const commit = flag('commit');

  // MATCH-ONLY: re-run the PURE matcher over EXISTING sam_opportunity rows WITHOUT
  // hitting the SAM.gov API. Realizes a matcher change (e.g. the procurement-BLIN
  // shape) across the already-ingested backlog — the daily sync only re-matches the
  // notices it freshly fetches. Needs no API key. Idempotent (persistMatches is a
  // find-or-create + update on the natural key).
  if (flag('match-only')) {
    const prismaMatch = new PrismaClient();
    try {
      await rematchExisting(prismaMatch, commit);
    } finally {
      await prismaMatch.$disconnect();
    }
    return;
  }

  const apiKey = process.env.SAM_GOV_API_KEY ?? '';
  if (!apiKey) throw new Error('SAM_GOV_API_KEY not configured');
  const backfill = flag('backfill');
  const sinceArg = arg('since');
  // Explicit window end for a backfill (SAM caps a search's span at ~1yr); default now.
  const postedToArg = arg('posted-to');
  const postedToDate = safeDate(postedToArg) ?? new Date();
  const t0 = Date.now();
  console.log(
    `[sam-opportunities] starting (${commit ? 'COMMIT' : 'DRY-RUN'}${backfill ? ', BACKFILL' : ''}) maxPages=${MAX_PAGES}`,
  );

  const prisma = new PrismaClient();
  try {
    await runWithSyncRun(
      prisma as never,
      SOURCE,
      async (ctx): Promise<RunCounts> => {
        // Incremental window: explicit --since wins; else the watermark; else lookback.
        // Window end is `now` for the daily, or an explicit --posted-to for a backfill.
        const since = ctx.since ?? new Date(Date.now() - DEFAULT_LOOKBACK_DAYS * 86_400_000);
        const postedFrom = samDate(since);
        const postedTo = samDate(postedToDate);
        console.log(`[sam-opportunities] window postedFrom=${postedFrom} postedTo=${postedTo}`);

        // Known PEs (for verbatim PE/BLIN-code matching) + the program alias universe.
        // NOTE: no officeHint/pscHints are selected (ProgramAlias has no such columns),
        // so the matcher's alias tier stays dormant — see buildAliasIndex's ⚠️ note.
        const pes = await prisma.programElement.findMany({ select: { peCode: true } });
        const knownPeCodes = new Set<string>(pes.map((p) => p.peCode.toUpperCase()));
        const aliasRows = await prisma.programAlias.findMany({
          select: { programId: true, aliasNormalized: true, aliasType: true },
        });
        const aliasIndex = buildAliasIndex(aliasRows);
        console.log(
          `[sam-opportunities] ${knownPeCodes.size} known PEs, ${aliasIndex.length} program aliases`,
        );

        const counts: RunCounts = { inserted: 0, updated: 0, skipped: 0, errors: 0 };
        let matchesWritten = 0;
        let offset = 0;
        let totalRecords: number | undefined;
        let capped = false;

        for (let page = 0; page < MAX_PAGES; page += 1) {
          const resp = await fetchPage(apiKey, postedFrom, postedTo, offset);
          totalRecords = resp.totalRecords;
          const batch = resp.opportunitiesData ?? [];
          if (batch.length === 0) break;

          for (const rec of batch) {
            if (!isDod(rec)) {
              counts.skipped += 1;
              continue;
            }
            const noticeId = str(rec.noticeId);
            if (!noticeId) {
              counts.skipped += 1;
              continue;
            }

            const archiveDate = safeDate(rec.archiveDate);
            // active: SAM's own flag if present, else derived from archive date.
            const active =
              rec.active != null
                ? rec.active.toLowerCase() !== 'no'
                : archiveDate == null || archiveDate.getTime() > Date.now();
            const poc = primaryPoc(rec);
            // Four source fields the notice already carries and this sync used to
            // drop on the floor. Extracted through the SAME function
            // backfill-sam-opportunity-fields.ts uses, so the live sync and the
            // backfill cannot drift into disagreeing about the same payload.
            //
            // `baseType` is the one that matters for correctness rather than
            // completeness: an amended notice carries type 'Solicitation' with
            // baseType 'Presolicitation', and without it the UI cannot tell an
            // open solicitation from an amended pre-solicitation.
            const promoted = extractPromotedFields(rec);
            const opp = {
              noticeId,
              solicitationNumber: str(rec.solicitationNumber),
              title: str(rec.title) ?? '(untitled)',
              noticeType: (str(rec.type) ?? str(rec.baseType) ?? 'unknown').slice(0, 32),
              baseType: promoted.baseType,
              agency: agencyOf(rec),
              subAgency: promoted.subAgency,
              setAside: promoted.setAside,
              setAsideCode: promoted.setAsideCode,
              office: officeOf(rec),
              pscCode: str(rec.classificationCode)?.slice(0, 8) ?? null,
              naicsCode: str(rec.naicsCode)?.slice(0, 8) ?? null,
              postedDate: safeDate(rec.postedDate),
              responseDeadline: safeDate(rec.responseDeadLine),
              archiveDate,
              description: str(rec.description),
              pocName: poc.name,
              pocEmail: poc.email,
              placeOfPerformance: (rec.placeOfPerformance ?? {}) as object,
              sourceUrl: str(rec.uiLink) ?? `https://sam.gov/opp/${noticeId}/view`,
              active,
            };

            try {
              const existed = await prisma.samOpportunity.findUnique({
                where: { noticeId },
                select: { id: true },
              });
              const row = commit
                ? await prisma.samOpportunity.upsert({
                    where: { noticeId },
                    create: { ...opp, raw: rec as object, lastSyncedAt: new Date() },
                    update: { ...opp, raw: rec as object, lastSyncedAt: new Date() },
                  })
                : { id: existed?.id ?? '(dry-run)' };
              if (existed) counts.updated += 1;
              else counts.inserted += 1;

              // ── review-gated matching pass (pure) ──
              const forMatch: OpportunityForMatch = {
                title: opp.title,
                description: opp.description,
                office: opp.office,
                pscCode: opp.pscCode,
                naicsCode: opp.naicsCode,
              };
              const proposed = matchOpportunity(forMatch, knownPeCodes, aliasIndex);
              if (commit && proposed.length > 0) {
                matchesWritten += await persistMatches(prisma, row.id, proposed);
              }
            } catch (err) {
              counts.errors += 1;
              console.warn(
                `[sam-opportunities] upsert/match failed for ${noticeId}: ${(err as Error).message}`,
              );
            }
          }

          offset += PAGE_LIMIT;
          if (resp.totalRecords !== undefined && offset >= resp.totalRecords) break;
          // Ran out of page budget with more records still available -> capped window.
          if (
            page === MAX_PAGES - 1 &&
            resp.totalRecords !== undefined &&
            offset < resp.totalRecords
          ) {
            capped = true;
          }
        }

        if (capped) {
          console.warn(
            `[sam-opportunities] ⚠️ CAPPED: window ${postedFrom}..${postedTo} has ${totalRecords} records but the page budget stopped at ${offset} (SAM_MAX_PAGES=${MAX_PAGES}). Narrow the window (--posted-to) or raise SAM_MAX_PAGES; the tail was NOT ingested.`,
          );
        }

        const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
        console.log(
          `[sam-opportunities] inserted=${counts.inserted} updated=${counts.updated} skipped=${counts.skipped} errors=${counts.errors} matches=${matchesWritten} in ${elapsed}s`,
        );
        return counts;
      },
      // A manual backfill must not be skipped by an in-flight daily run.
      { overrideSince: sinceArg ?? null, skipIfRunning: !backfill },
    );
  } finally {
    await prisma.$disconnect();
  }
}

/**
 * Upsert proposed matches into sam_opportunity_match, idempotent on the natural key
 * (opportunity_id, program_id, pe_code). Returns the number written. Uses the
 * functional-unique index via a manual find-or-create (Prisma cannot target a
 * coalesce()-based unique index in upsert).
 */
async function persistMatches(
  prisma: PrismaClient,
  opportunityId: string,
  proposed: ProposedSamMatch[],
): Promise<number> {
  let written = 0;
  for (const m of proposed) {
    const existing = await prisma.samOpportunityMatch.findFirst({
      where: { opportunityId, programId: m.programId, peCode: m.peCode },
      select: { id: true },
    });
    if (existing) {
      await prisma.samOpportunityMatch.update({
        where: { id: existing.id },
        data: { matchBasis: m.matchBasis, confidence: m.confidence, reviewStatus: m.reviewStatus },
      });
    } else {
      await prisma.samOpportunityMatch.create({
        data: {
          opportunityId,
          programId: m.programId,
          peCode: m.peCode,
          matchBasis: m.matchBasis,
          confidence: m.confidence,
          reviewStatus: m.reviewStatus,
        },
      });
    }
    written += 1;
  }
  return written;
}

/**
 * Re-run the pure matcher over EVERY existing sam_opportunity row (no network). Used
 * by `--match-only` to realize a matcher change across the already-ingested backlog.
 * Keyset-paginates by id so it streams the full table in bounded memory. Dry-run
 * reports what WOULD be written; `--commit` persists via the idempotent persistMatches.
 */
async function rematchExisting(prisma: PrismaClient, commit: boolean): Promise<void> {
  const t0 = Date.now();
  console.log(
    `[sam-opportunities] MATCH-ONLY re-match over existing opportunities (${commit ? 'COMMIT' : 'DRY-RUN'})`,
  );

  // Same universes the sync loop uses: known PE/BLIN codes + the program alias index.
  const pes = await prisma.programElement.findMany({ select: { peCode: true } });
  const knownPeCodes = new Set<string>(pes.map((p) => p.peCode.toUpperCase()));
  const aliasRows = await prisma.programAlias.findMany({
    select: { programId: true, aliasNormalized: true, aliasType: true },
  });
  const aliasIndex = buildAliasIndex(aliasRows);
  console.log(
    `[sam-opportunities] ${knownPeCodes.size} known PEs, ${aliasIndex.length} program aliases`,
  );

  const BATCH = 1000;
  let scanned = 0;
  let withProposed = 0;
  let matchesWritten = 0;
  let cursor: string | undefined;
  for (;;) {
    const rows = await prisma.samOpportunity.findMany({
      select: {
        id: true,
        title: true,
        description: true,
        office: true,
        pscCode: true,
        naicsCode: true,
      },
      orderBy: { id: 'asc' },
      take: BATCH,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
    });
    if (rows.length === 0) break;
    for (const row of rows) {
      const forMatch: OpportunityForMatch = {
        title: row.title,
        description: row.description,
        office: row.office,
        pscCode: row.pscCode,
        naicsCode: row.naicsCode,
      };
      const proposed = matchOpportunity(forMatch, knownPeCodes, aliasIndex);
      if (proposed.length > 0) withProposed += 1;
      if (commit && proposed.length > 0) {
        matchesWritten += await persistMatches(prisma, row.id, proposed);
      }
      scanned += 1;
    }
    cursor = rows[rows.length - 1]!.id;
    if (rows.length < BATCH) break;
  }

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(
    `[sam-opportunities] MATCH-ONLY done: scanned=${scanned} ` +
      `opportunitiesWithProposedMatch=${withProposed} matchesWritten=${matchesWritten} ` +
      `(${commit ? 'COMMITTED' : 'DRY-RUN, nothing written'}) in ${elapsed}s`,
  );
}

// Guarded entrypoint: only runs when invoked directly (never on import — the matcher
// is imported by the spec). Mirrors the project's `void main().catch(...)` pattern.
const isDirectRun = (() => {
  try {
    const invoked = process.argv[1] ?? '';
    return /sync-sam-opportunities(\.[cm]?[tj]s)?$/.test(invoked.replace(/\\/g, '/'));
  } catch {
    return false;
  }
})();

if (isDirectRun) {
  void main().catch((err) => {
    console.error('[sam-opportunities] FAILED', err);
    process.exit(1);
  });
}

// `normalizeText` re-exported so callers/tests can build hints with the same form.
export { main, persistMatches, isDod, officeOf, buildAliasIndex, normalizeText };
