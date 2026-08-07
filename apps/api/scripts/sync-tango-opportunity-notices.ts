/**
 * MakeGov/Tango notice-history sync (Funding Opportunities P28).
 *
 *   tsx scripts/sync-tango-opportunity-notices.ts                       # dry run
 *   tsx scripts/sync-tango-opportunity-notices.ts --commit
 *   tsx scripts/sync-tango-opportunity-notices.ts --commit --limit=500
 *   tsx scripts/sync-tango-opportunity-notices.ts --commit --posted-since=2026-05-01
 *
 * DRY-RUN BY DEFAULT.
 *
 * ── What it writes, and what it does not ─────────────────────────────────────
 *
 * One table: `tango_opportunity_notice`. It never writes to `sam_opportunity`,
 * never resolves a P27 parity conflict, and emits no alert — a material change
 * observed here becomes visible on the timeline and nothing else. Alerting is
 * P48's, and this script holds no dependency through which one could be sent.
 *
 * ── Why the crosswalk is attached HERE rather than at read time ──────────────
 *
 * Each notice is stamped with the `sam_opportunity.id` its solicitation number
 * resolves to, using P27's own `resolveCrosswalk` — so a notice is stamped only
 * when EXACTLY ONE local notice carries that number, and left unstamped when
 * more than one does. Doing it at write time means the timeline read is a single
 * indexed query on `sam_opportunity_id`; doing it at read time would mean
 * re-resolving an ambiguous solicitation number on every detail page view, with
 * a different answer each time the local catalog changed underneath it.
 *
 * An unstamped notice is not lost. It is stored with its provider identity and
 * becomes reachable the moment the ambiguity resolves — and the timeline API
 * reports `coverage: 'not_crosswalked'` rather than an empty history, so a
 * reader is never told a solicitation was never amended when the truth is that
 * Capiro cannot yet prove which one it is.
 *
 * ── Incremental, WITH OVERLAP ────────────────────────────────────────────────
 *
 * `TangoNoticeListOptions` (P14's audited filter set) offers `postedSince`, not
 * a `changedSince` — a notice is immutable in the provider's own model once
 * posted, so "everything posted since the last run" is the correct incremental
 * key here, and the overlap covers a notice posted while a run was executing.
 * The high-water mark advances only on a fully-exhausted page walk.
 */
import { config as dotenvConfig } from 'dotenv';
import { PrismaClient } from '@prisma/client';
import { createHash } from 'node:crypto';
import { TangoGatewayService } from '../src/external/tango/tango.client.js';
import {
  TangoResilienceService,
  TangoRequestCeilingExceededError,
} from '../src/external/tango/tango-resilience.service.js';
import { TangoStoreService, canonicalize, computeFilterFingerprint } from '../src/external/tango/tango-store.service.js';
import {
  normalizeSolicitationNumber,
  resolveCrosswalk,
  type SamCandidate,
} from '../src/external/tango/tango-opportunity.mapper.js';
import type { TangoGateway, TangoNotice } from '../src/external/tango/tango.types.js';
import { redact, redactWithKnownSecret } from '../src/external/tango/tango.errors.js';
import type { PrismaService } from '../src/prisma/prisma.service.js';

dotenvConfig();

const SYNC_VERB = 'sync-tango-opportunity-notices';
const DEFAULT_BATCH_SIZE = 100;
const DEFAULT_OVERLAP_HOURS = 4;
const DEFAULT_POSTED_SINCE_DAYS = 90;

// ── CLI ──────────────────────────────────────────────────────────────────────

function hasFlag(argv: string[], name: string): boolean {
  return argv.includes(`--${name}`);
}
function flagValue(argv: string[], name: string): string | undefined {
  const withEq = argv.find((a) => a.startsWith(`--${name}=`));
  if (withEq) return withEq.slice(`--${name}=`.length);
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
}

export interface ParsedArgs {
  commit: boolean;
  limit: number | undefined;
  overlapHours: number;
  postedSince: string | undefined;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const limitRaw = flagValue(argv, 'limit');
  const parsedLimit = limitRaw != null ? Number(limitRaw) : NaN;
  const overlapRaw = flagValue(argv, 'overlap-hours');
  const parsedOverlap = overlapRaw != null ? Number(overlapRaw) : NaN;
  const postedRaw = flagValue(argv, 'posted-since');
  return {
    commit: hasFlag(argv, 'commit'),
    limit: Number.isFinite(parsedLimit) && parsedLimit > 0 ? Math.min(parsedLimit, 50_000) : undefined,
    overlapHours: Number.isFinite(parsedOverlap) && parsedOverlap >= 0 ? parsedOverlap : DEFAULT_OVERLAP_HOURS,
    // An unparseable date is DROPPED, never passed through: garbage as the
    // provider's incremental key either 400s or is ignored server-side, and the
    // second failure mode turns a bounded run into a full-catalog walk that
    // still reports the bound in its summary.
    postedSince:
      postedRaw != null && !Number.isNaN(new Date(postedRaw).getTime()) ? postedRaw : undefined,
  };
}

// ── The row ──────────────────────────────────────────────────────────────────

export interface NoticeRow {
  tangoNoticeId: string;
  tangoOpportunityId: string | null;
  samOpportunityId: string | null;
  solicitationNumber: string | null;
  title: string | null;
  postedDate: Date | null;
  providerUpdatedAt: Date | null;
  responseDeadline: Date | null;
  active: boolean | null;
  setAside: string | null;
  naicsCode: string | null;
  pscCode: string | null;
  attachmentCount: number | null;
  sourceUrl: string | null;
  contentHash: string;
  snapshot: Record<string, unknown>;
}

function toDate(iso: string | null): Date | null {
  if (iso == null) return null;
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? null : at;
}

/**
 * Map one provider notice to its row.
 *
 * The content hash is computed over the NORMALIZED domain object with
 * `provenance` removed, using the same canonical-JSON helper P15's snapshot
 * store uses. Dropping provenance is load-bearing: `fetchedAt` changes on every
 * single fetch, so hashing it in would make every re-sync look like a content
 * change and defeat the whole no-op path.
 */
export function toNoticeRow(
  notice: TangoNotice,
  crosswalk: { tangoOpportunityId: string | null; samOpportunityId: string | null },
): NoticeRow {
  const { provenance, ...rest } = notice;
  const snapshot = { ...rest } as Record<string, unknown>;
  return {
    tangoNoticeId: notice.noticeId,
    tangoOpportunityId: crosswalk.tangoOpportunityId,
    samOpportunityId: crosswalk.samOpportunityId,
    solicitationNumber: notice.solicitationNumber,
    title: notice.title,
    postedDate: toDate(notice.postedDate),
    providerUpdatedAt: toDate(provenance.providerUpdatedAt),
    responseDeadline: toDate(notice.responseDeadline),
    active: notice.active,
    setAside: notice.setAside,
    naicsCode: notice.naicsCode,
    pscCode: notice.pscCode,
    // A negative count is a mapping bug, not fewer attachments. Refused here so
    // the CHECK constraint never has to be the thing that catches it.
    attachmentCount:
      notice.attachmentCount != null && notice.attachmentCount >= 0 ? notice.attachmentCount : null,
    sourceUrl: notice.sourceUrl,
    contentHash: createHash('sha256').update(canonicalize(snapshot)).digest('hex'),
    snapshot,
  };
}

// ── Injectable dependencies ──────────────────────────────────────────────────

export interface NoticeSyncDeps {
  gateway: TangoGateway;
  store: TangoStoreService;
  findSamCandidates: (normalizedSolicitationNumber: string) => Promise<SamCandidate[]>;
  upsertNotice: (row: NoticeRow) => Promise<{ unchanged: boolean }>;
  now?: () => Date;
}

export interface NoticeSyncOptions {
  commit: boolean;
  limit?: number;
  overlapHours?: number;
  batchSize?: number;
  postedSince?: string;
  postedSinceDays?: number;
}

export interface NoticeSyncSummary {
  processed: number;
  /** Rows written or would-be written. Real only when `commit`. */
  written: number;
  /** Identical content already stored — a no-op, and free. */
  unchanged: number;
  /** Stamped with a local sam_opportunity id via P27's exact-identifier rule. */
  crosswalked: number;
  /** Stored with provider identity only: the solicitation number was ambiguous or unknown. */
  uncrosswalked: number;
  errored: number;
  ceilingReached: boolean;
  completeness: 'complete' | 'in_progress';
  isFirstRun: boolean;
  postedSince: string;
}

export async function runNoticeSync(
  deps: NoticeSyncDeps,
  options: NoticeSyncOptions,
): Promise<NoticeSyncSummary> {
  const now = deps.now ?? (() => new Date());
  const runStartedAt = now();
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  const overlapMs = (options.overlapHours ?? DEFAULT_OVERLAP_HOURS) * 60 * 60 * 1000;
  const lookbackDays = options.postedSinceDays ?? DEFAULT_POSTED_SINCE_DAYS;
  const floor =
    options.postedSince ??
    new Date(runStartedAt.getTime() - lookbackDays * 86_400_000).toISOString().slice(0, 10);

  const filterFingerprint = computeFilterFingerprint({ postedSince: floor });
  const checkpoint = await deps.store.readCheckpoint(SYNC_VERB, 'notice', filterFingerprint);
  const isFirstRun = checkpoint == null;
  const postedSince =
    checkpoint?.windowEnd != null
      ? new Date(checkpoint.windowEnd.getTime() - overlapMs).toISOString()
      : floor;

  let cursor: string | null = checkpoint?.cursor ?? null;
  const summary = {
    processed: 0,
    written: 0,
    unchanged: 0,
    crosswalked: 0,
    uncrosswalked: 0,
    errored: 0,
  };
  let ceilingReached = false;
  const limit = options.limit ?? Number.POSITIVE_INFINITY;

  outer: for (;;) {
    const remaining = limit - summary.processed;
    if (remaining <= 0) break;

    let page;
    try {
      page = await deps.gateway.listNotices({
        cursor,
        limit: Math.min(batchSize, remaining),
        postedSince,
      });
    } catch (error) {
      if (error instanceof TangoRequestCeilingExceededError) {
        ceilingReached = true;
        break outer;
      }
      throw error;
    }

    for (const notice of page.items) {
      summary.processed += 1;
      try {
        const normalized = normalizeSolicitationNumber(notice.solicitationNumber);
        const candidates = normalized ? await deps.findSamCandidates(normalized) : [];
        // P27's own rule, reused verbatim rather than reimplemented: exactly one
        // candidate links, more than one is ambiguous and links NOTHING.
        const crosswalk = resolveCrosswalk(
          { opportunityId: notice.noticeId, solicitationNumber: notice.solicitationNumber },
          candidates,
        );
        const samOpportunityId = crosswalk.state === 'linked' ? crosswalk.samOpportunityId : null;
        if (samOpportunityId != null) summary.crosswalked += 1;
        else summary.uncrosswalked += 1;

        const row = toNoticeRow(notice, {
          // The provider's notice resource states no parent opportunity id, so
          // this stays null rather than being derived from the solicitation
          // number — that would be an identity claim the provider never made.
          tangoOpportunityId: null,
          samOpportunityId,
        });

        if (options.commit) {
          const { unchanged } = await deps.upsertNotice(row);
          if (unchanged) summary.unchanged += 1;
          else summary.written += 1;
        } else {
          summary.written += 1;
        }
      } catch {
        summary.errored += 1;
      }
    }

    cursor = page.nextCursor;
    const isDone = cursor == null;
    if (options.commit) {
      await deps.store.writeCheckpoint({
        syncVerb: SYNC_VERB,
        resourceType: 'notice',
        filterFingerprint,
        cursor,
        ...(isDone ? { windowStart: postedSince, windowEnd: runStartedAt.toISOString() } : {}),
        completeness: isDone ? 'complete' : 'in_progress',
        rowsProcessed: page.items.length,
      });
    }
    if (isDone) break;
  }

  return {
    ...summary,
    ceilingReached,
    completeness: ceilingReached || cursor != null ? 'in_progress' : 'complete',
    isFirstRun,
    postedSince,
  };
}

// ── Real wiring ──────────────────────────────────────────────────────────────

function prismaServiceFromClient(client: PrismaClient): PrismaService {
  return client as unknown as PrismaService;
}

function realFindSamCandidates(prisma: PrismaClient): NoticeSyncDeps['findSamCandidates'] {
  return async (normalized) => {
    // tenant-scope-exempt: sam_opportunity is global federal reference data.
    // The normalizer matches normalizeSolicitationNumber exactly; P27's own
    // spec pins the two expressions against each other.
    const rows = await prisma.$queryRaw<
      Array<{ id: string; notice_id: string; solicitation_number: string | null }>
    >`
      SELECT id::text AS id, notice_id, solicitation_number
      FROM sam_opportunity
      WHERE regexp_replace(upper(coalesce(solicitation_number, '')), '[^A-Z0-9]', '', 'g') = ${normalized}
      LIMIT 50
    `;
    return rows.map((r) => ({
      id: r.id,
      noticeId: r.notice_id,
      solicitationNumber: r.solicitation_number,
    }));
  };
}

/**
 * Upsert one notice, reporting whether the content was unchanged.
 *
 * An unchanged observation still moves `last_synced_at` — Capiro DID look, and
 * a freshness line that ignored a confirming re-sync would understate how
 * current the history is — but changes nothing else, so the derived timeline is
 * byte-identical afterwards.
 */
function realUpsertNotice(prisma: PrismaClient): NoticeSyncDeps['upsertNotice'] {
  return async (row) => {
    const existing = await prisma.tangoOpportunityNotice.findUnique({
      where: { tangoNoticeId: row.tangoNoticeId },
      select: { id: true, contentHash: true },
    });
    if (existing != null && existing.contentHash === row.contentHash) {
      await prisma.tangoOpportunityNotice.update({
        where: { id: existing.id },
        data: { lastSyncedAt: new Date() },
      });
      return { unchanged: true };
    }
    await prisma.tangoOpportunityNotice.upsert({
      where: { tangoNoticeId: row.tangoNoticeId },
      create: { ...row, snapshot: row.snapshot as object },
      update: { ...row, snapshot: row.snapshot as object, lastSyncedAt: new Date() },
    });
    return { unchanged: false };
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const apiKey = (process.env.TANGO_API_KEY ?? '').trim();
  if (!apiKey) {
    console.error('TANGO_NOTICE_SYNC_ERR No TANGO_API_KEY configured.');
    process.exitCode = 1;
    return;
  }

  const prisma = new PrismaClient();
  await prisma.$connect();
  try {
    const rawGateway = new TangoGatewayService({
      apiKey,
      baseUrl: process.env.TANGO_API_BASE_URL,
      timeoutMs: process.env.TANGO_TIMEOUT_MS ? Number(process.env.TANGO_TIMEOUT_MS) : undefined,
    });
    const store = new TangoStoreService(prismaServiceFromClient(prisma));
    const gateway = new TangoResilienceService(rawGateway, store, {
      requestCeiling: process.env.TANGO_REQUEST_CEILING_PER_RUN
        ? Number(process.env.TANGO_REQUEST_CEILING_PER_RUN)
        : undefined,
    });

    const summary = await runNoticeSync(
      {
        gateway,
        store,
        findSamCandidates: realFindSamCandidates(prisma),
        upsertNotice: realUpsertNotice(prisma),
      },
      {
        commit: args.commit,
        limit: args.limit,
        overlapHours: args.overlapHours,
        postedSince: args.postedSince,
      },
    );

    console.log(
      `TANGO_NOTICE_SYNC_DONE ${JSON.stringify({ ...summary, commit: args.commit, health: gateway.getHealth() })}`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

const isDirectRun = (() => {
  try {
    const invoked = process.argv[1] ?? '';
    return /sync-tango-opportunity-notices(\.[cm]?[tj]s)?$/.test(invoked.replace(/\\/g, '/'));
  } catch {
    return false;
  }
})();

if (isDirectRun) {
  void main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(
      'TANGO_NOTICE_SYNC_ERR',
      redactWithKnownSecret(redact(message), process.env.TANGO_API_KEY ?? null),
    );
    process.exitCode = 1;
  });
}

export { main };
