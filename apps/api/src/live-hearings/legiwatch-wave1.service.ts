/**
 * LegiWatch V2 Wave 1 — tenant follow/attend/archive/relevance/actions service.
 *
 * Composes the EXISTING canonical Live Hearings system; it does not fork any
 * part of it. Specifically:
 *
 *  - capture demand still goes through the Phase 7 schedule path and its
 *    fail-closed policy guard. There is no second capture scheduler here.
 *  - the public transcript and public intelligence rails are read, never
 *    written or copied per tenant.
 *  - committee identity comes from `CongressCommittee`, never inferred from
 *    whichever hearings happen to fall in a date window.
 *
 * Tenant safety: every tenant-owned read/write runs inside
 * `PrismaService.withTenant`, which injects `where.tenantId` and sets the RLS
 * GUC. Client ids arriving in a request body prove nothing about whose tenant
 * they belong to, so they are validated against the caller's tenant before
 * being persisted or used as a filter.
 */
import { resolveCanonicalHearingId } from '../hearing-discovery/hearing-alias.js';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import { PrismaService } from '../prisma/prisma.service.js';
import { LiveHearingsPhase7Service } from './live-hearings-phase7.service.js';
import { CommitteeDirectoryService } from './committee-directory.service.js';
import { requireStateCalendar } from './legiwatch-calendar-access.js';
import { stateCapturePolicy } from './legiwatch-state-capture-policy.js';
import { LiveHearingsService, type CalendarQuery } from './live-hearings.service.js';
import {
  assessAttendance,
  refuseAttendanceRequest,
  type AttendanceAssessment,
} from './legiwatch-wave1-attendance.js';
import {
  buildAllClientsRelevance,
  buildClientRelevance,
  bandForScore,
  timecode,
  RELEVANCE_BAND_FLOORS,
  type ClientRelevanceResult,
  type RelevanceRow,
} from './legiwatch-wave1-relevance.js';
import {
  buildCalendarExport,
  buildBulkCalendarExport,
  type CalendarExportHearing,
  type CalendarExportResult,
} from './legiwatch-calendar-export.js';
import { LegiWatchLifecycleNotificationService } from './legiwatch-lifecycle-notification.service.js';
import {
  discoverSavedHearingSessions,
  type SavedSessionsDiscovery,
} from './legiwatch-saved-sessions.js';

/** Server-side page ceiling for every list this service returns. */
const MAX_PAGE_SIZE = 100;
const DEFAULT_PAGE_SIZE = 25;

function clampPageSize(value: number | undefined): number {
  if (!value || !Number.isFinite(value)) return DEFAULT_PAGE_SIZE;
  return Math.min(Math.max(Math.trunc(value), 1), MAX_PAGE_SIZE);
}

function clampPage(value: number | undefined): number {
  if (!value || !Number.isFinite(value)) return 1;
  return Math.max(Math.trunc(value), 1);
}

/**
 * Keyset cursor for committee intelligence history (W2-1): `(createdAt, id)`,
 * the same tiebreaker pair the query orders by. Opaque base64 JSON, matching
 * the encoding convention Feed's cursor already uses.
 *
 * `createdAt` is carried as the RAW TEXT Postgres prints for the timestamptz
 * column (`i.created_at::text` in the query below) — never parsed into a JS
 * `Date`. A `Date` (and `.toISOString()`) is millisecond-precision; Postgres
 * `timestamptz` is microsecond-precision, and `now()` is stable for the whole
 * duration of a transaction, so a batch of intelligence rows inserted in one
 * INSERT statement routinely shares one `created_at` down to the microsecond.
 * Round-tripping that value through a `Date` silently truncates it, so a
 * reconstructed cursor could compare UNEQUAL to the very row it was built
 * from — the tie-break `id <` branch would then also miss, and a row already
 * shown on a prior page could be skipped from every later one. Keeping the
 * text lossless is what makes the keyset actually stable.
 */
function encodeIntelHistoryCursor(row: { createdAtText: string; id: string }): string {
  return Buffer.from(JSON.stringify({ t: row.createdAtText, id: row.id }), 'utf8').toString(
    'base64url',
  );
}

function decodeIntelHistoryCursor(
  cursor: string | undefined,
): { createdAtText: string; id: string } | null {
  if (!cursor) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (!parsed || typeof parsed !== 'object') return null;
    const { t, id } = parsed as { t?: unknown; id?: unknown };
    if (typeof t !== 'string' || !t.trim() || typeof id !== 'string') return null;
    return { createdAtText: t, id };
  } catch {
    // A malformed/tampered cursor is treated as absent — the query falls back
    // to page one rather than throwing on user-supplied opaque input.
    return null;
  }
}

export interface FollowConfigInput {
  clientIds?: string[];
  notifyOnScheduleChange?: boolean;
  notifyOnHearingStarting?: boolean;
  notifyOnTranscriptReady?: boolean;
  notifyOnHighPriorityMatch?: boolean;
}

export interface FollowConfigState {
  hearingId: string;
  following: boolean;
  clientIds: string[];
  /** Names for the clients above, resolved under the caller's tenant. */
  clients: Array<{ id: string; name: string | null; archived: boolean }>;
  notifyOnScheduleChange: boolean;
  notifyOnHearingStarting: boolean;
  notifyOnTranscriptReady: boolean;
  notifyOnHighPriorityMatch: boolean;
  createdAt: string | null;
  updatedAt: string | null;
  /**
   * Always false. Stated explicitly in the contract because the whole point of
   * the Follow/Attend split is that following creates no capture demand, and a
   * client should be able to assert that from the response.
   */
  createdCaptureDemand: false;
}

export interface CommitteeFollowInput {
  clientIds?: string[];
  notifyOnNewHearing?: boolean;
  notifyOnScheduleChange?: boolean;
  notifyOnTranscriptReady?: boolean;
  notifyOnHighPriorityMatch?: boolean;
}

export interface ArchiveSearchInput {
  q?: string;
  from?: string;
  to?: string;
  chamber?: string;
  committee?: string;
  subcommittee?: string;
  eventStatus?: string;
  hasTranscript?: boolean;
  intelligenceType?: string;
  clientId?: string;
  relevanceBand?: string;
  page?: number;
  pageSize?: number;
}

/**
 * Declared as a type alias, not an interface, so it keeps an implicit index
 * signature and stays assignable to the `Record<string, unknown>` shape every
 * other read on this service returns.
 */
export type ArchiveSearchPage = {
  rows: Array<Record<string, unknown>>;
  savedSessionsState: SavedSessionsDiscovery['savedSessionsState'];
  total: number;
  /**
   * The archive's size BEFORE the query and facets narrow it. `total` is
   * post-filter, so on its own a zero `total` cannot distinguish "nothing
   * matched your search" from "there is nothing archived yet" — and the
   * surface was rendering the second message for the first case (LW-QA-015).
   */
  corpusTotal: number;
  page: number;
  pageSize: number;
  hasMore: boolean;
  query: string | null;
  /**
   * How the rows were matched. `all-terms` is the normal predicate (every term
   * must appear somewhere). `partial` means nothing matched every term and the
   * search fell back to an any-term query — the UI has to say so rather than
   * present partial hits as if they were exact. `null` when there is no query.
   */
  matchMode: 'all-terms' | 'partial' | null;
  facets: {
    chamber: Array<{ value: string; count: number }>;
    committee: Array<{ value: string; label: string; count: number }>;
    eventStatus: Array<{ value: string; count: number }>;
  };
};

interface CanonicalHearingRow {
  id: string;
  geographicJurisdiction?: string | null;
  legislativeSession?: string | null;
  stateCommitteeId?: string | null;
  calendarRevision?: number;
  sourceRevision?: number;
  calendarSnapshot?: unknown;
  calendarCheckedAt?: Date | null;
  calendarCheckState?: string;
  timePrecision?: string | null;
  scheduledEnd?: Date | null;
  title: string;
  chamber: string;
  committeeName: string | null;
  committeeSystemCode: string | null;
  subcommitteeSystemCode: string | null;
  date: Date;
  startsAt: Date | null;
  time: string | null;
  timezone: string | null;
  location: string | null;
  url: string | null;
  visibility: string;
  eventStatus: string;
  eventType: string | null;
  witnesses: string[];
  actualEnd: Date | null;
}

@Injectable()
export class LegiWatchWave1Service {
  private readonly logger = new Logger(LegiWatchWave1Service.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly phase7: LiveHearingsPhase7Service,
    private readonly committees: CommitteeDirectoryService,
    private readonly notifications: LegiWatchLifecycleNotificationService,
  ) {}

  // ── W1-1 · configurable hearing following ────────────────────────────────

  async followState(ctx: TenantContext, hearingId: string): Promise<FollowConfigState> {
    await this.requireHearing(hearingId, ctx);
    const row = await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.hearingFollow.findFirst({
        where: { userId: ctx.userId, hearingId },
      }),
    );
    return this.toFollowState(ctx, hearingId, row);
  }

  /**
   * Upsert one follow configuration.
   *
   * Idempotent by (tenant, user, hearing): calling it twice with the same body
   * leaves one row in the same state. Editing an existing follow is the same
   * call — there is no separate update path to drift from this one.
   *
   * Notably this method NEVER touches `hearing_subscription`. Following is not
   * capture demand; that separation is the Phase 7 invariant the capture worker
   * depends on, and a regression test asserts it.
   */
  async upsertFollow(
    ctx: TenantContext,
    hearingId: string,
    input: FollowConfigInput,
  ): Promise<FollowConfigState> {
    await this.requireHearing(hearingId, ctx);
    const clientIds = await this.resolveClientIds(ctx, input.clientIds ?? []);

    const row = await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.hearingFollow.upsert({
        where: {
          tenantId_userId_hearingId: {
            tenantId: ctx.tenantId,
            userId: ctx.userId,
            hearingId,
          },
        },
        create: {
          tenantId: ctx.tenantId,
          userId: ctx.userId,
          hearingId,
          clientIds,
          notifyOnScheduleChange: input.notifyOnScheduleChange ?? true,
          notifyOnHearingStarting: input.notifyOnHearingStarting ?? true,
          notifyOnTranscriptReady: input.notifyOnTranscriptReady ?? true,
          notifyOnHighPriorityMatch: input.notifyOnHighPriorityMatch ?? true,
        },
        update: {
          clientIds,
          // An absent flag means "leave as configured", not "reset to default":
          // a PUT that only changes the client list must not silently re-enable
          // a notification the user turned off.
          ...(input.notifyOnScheduleChange === undefined
            ? {}
            : { notifyOnScheduleChange: input.notifyOnScheduleChange }),
          ...(input.notifyOnHearingStarting === undefined
            ? {}
            : { notifyOnHearingStarting: input.notifyOnHearingStarting }),
          ...(input.notifyOnTranscriptReady === undefined
            ? {}
            : { notifyOnTranscriptReady: input.notifyOnTranscriptReady }),
          ...(input.notifyOnHighPriorityMatch === undefined
            ? {}
            : { notifyOnHighPriorityMatch: input.notifyOnHighPriorityMatch }),
          updatedAt: new Date(),
        },
      }),
    );

    return this.toFollowState(ctx, hearingId, row);
  }

  /** Unfollow. Idempotent: unfollowing a hearing you do not follow succeeds. */
  async unfollow(ctx: TenantContext, hearingId: string): Promise<FollowConfigState> {
    await this.requireHearing(hearingId, ctx);
    await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.hearingFollow.deleteMany({ where: { userId: ctx.userId, hearingId } }),
    );
    return this.toFollowState(ctx, hearingId, null);
  }

  private async toFollowState(
    ctx: TenantContext,
    hearingId: string,
    row: {
      clientIds: string[];
      notifyOnScheduleChange: boolean;
      notifyOnHearingStarting: boolean;
      notifyOnTranscriptReady: boolean;
      notifyOnHighPriorityMatch: boolean;
      createdAt: Date;
      updatedAt: Date;
    } | null,
  ): Promise<FollowConfigState> {
    if (!row) {
      return {
        hearingId,
        following: false,
        clientIds: [],
        clients: [],
        notifyOnScheduleChange: true,
        notifyOnHearingStarting: true,
        notifyOnTranscriptReady: true,
        notifyOnHighPriorityMatch: true,
        createdAt: null,
        updatedAt: null,
        createdCaptureDemand: false,
      };
    }
    return {
      hearingId,
      following: true,
      clientIds: row.clientIds,
      clients: await this.describeClients(ctx, row.clientIds),
      notifyOnScheduleChange: row.notifyOnScheduleChange,
      notifyOnHearingStarting: row.notifyOnHearingStarting,
      notifyOnTranscriptReady: row.notifyOnTranscriptReady,
      notifyOnHighPriorityMatch: row.notifyOnHighPriorityMatch,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      createdCaptureDemand: false,
    };
  }

  // ── W1-2 · configurable attendance / capture request ─────────────────────

  async attendanceState(
    ctx: TenantContext,
    hearingId: string,
  ): Promise<AttendanceAssessment & { hearingId: string }> {
    const hearing = await this.requireHearing(hearingId, ctx);
    return { hearingId, ...(await this.assess(ctx, hearing)) };
  }

  /**
   * Request attendance.
   *
   * The server re-derives eligibility from canonical state and refuses the
   * request itself when it is not permitted — a client that bypasses the
   * frontend controls gets the same answer the UI would have shown. Actual
   * capture demand is then created by the SHIPPED Phase 7 schedule path, so
   * the one-canonical-capture invariant and the fail-closed policy ceiling are
   * unchanged.
   */
  async requestAttendance(
    ctx: TenantContext,
    hearingId: string,
    input: { mode?: 'automatic' | 'browser'; consentAcknowledged?: boolean },
  ): Promise<Record<string, unknown>> {
    const hearing = await this.requireHearing(hearingId, ctx);
    const mode = input.mode ?? 'automatic';
    const assessment = await this.assess(ctx, hearing);

    const refusal = refuseAttendanceRequest(assessment, mode);
    if (refusal) {
      throw new ConflictException({
        code: refusal.code,
        message: refusal.message,
        state: assessment.state,
        availableModes: assessment.availableModes,
      });
    }

    if (assessment.consentRequired && !input.consentAcknowledged) {
      throw new ConflictException({
        code: 'CONSENT_REQUIRED',
        message:
          'This attendance mode requires an explicit consent acknowledgement before it can be scheduled.',
        state: assessment.state,
        availableModes: assessment.availableModes,
      });
    }

    let scheduleResult: Record<string, unknown> | null = null;
    if (mode === 'automatic') {
      // Delegate to the shipped path. It runs its own policy assessment,
      // writes the demand row, ensures the ONE canonical capture and enqueues
      // preflight. Wave 1 adds no second scheduler.
      scheduleResult = await this.phase7.schedule(ctx, hearingId);
    } else {
      // Browser attendance is still tenant demand (so the user's sessions and
      // notifications work), but it must not create server-capture demand.
      // scheduled_by_user stays false for exactly that reason.
      await this.prisma.withTenant(ctx.tenantId, (tx) =>
        tx.$executeRawUnsafe(
          `INSERT INTO hearing_subscription
             (tenant_id, user_id, hearing_id, notify_on_start, notify_on_mention,
              scheduled_by_user, scheduled_by_rule_id, client_ids, watchlist_id,
              attendance_mode, consent_acknowledged_at, created_at, updated_at)
           VALUES ($1::uuid, $2, $3, true, false, false, NULL, ARRAY[]::text[], NULL,
                   'browser', now(), now(), now())
           ON CONFLICT (tenant_id, user_id, hearing_id)
           DO UPDATE SET attendance_mode='browser',
                         scheduled_by_user=false,
                         consent_acknowledged_at=COALESCE(hearing_subscription.consent_acknowledged_at, now()),
                         updated_at=now()`,
          ctx.tenantId,
          ctx.userId,
          hearingId,
        ),
      );
    }

    if (mode === 'automatic') {
      await this.prisma.withTenant(ctx.tenantId, (tx) =>
        tx.$executeRawUnsafe(
          `UPDATE hearing_subscription
             SET attendance_mode='automatic',
                 consent_acknowledged_at = CASE WHEN $4::boolean THEN COALESCE(consent_acknowledged_at, now()) ELSE consent_acknowledged_at END,
                 updated_at=now()
           WHERE tenant_id=$1::uuid AND user_id=$2 AND hearing_id=$3`,
          ctx.tenantId,
          ctx.userId,
          hearingId,
          Boolean(input.consentAcknowledged),
        ),
      );
    }

    const next = await this.assess(ctx, hearing);
    return {
      hearingId,
      requestedMode: mode,
      attendance: next,
      schedule: scheduleResult,
      // Restating the invariant in the response so a caller can assert it.
      oneCanonicalCapture: true,
    };
  }

  /**
   * Cancel this tenant's attendance. Delegates to the shipped Phase 7 cancel,
   * which preserves the canonical capture and other tenants' demand.
   */
  async cancelAttendance(ctx: TenantContext, hearingId: string): Promise<Record<string, unknown>> {
    const hearing = await this.requireHearing(hearingId, ctx);
    const result = await this.phase7.cancelSchedule(ctx, hearingId);
    // The Phase 7 cancel only clears scheduled_by_user; a browser-mode row has
    // that false already, so remove the row outright when nothing else holds it.
    await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.$executeRawUnsafe(
        `DELETE FROM hearing_subscription
         WHERE tenant_id=$1::uuid AND user_id=$2 AND hearing_id=$3
           AND scheduled_by_user=false AND scheduled_by_rule_id IS NULL`,
        ctx.tenantId,
        ctx.userId,
        hearingId,
      ),
    );
    return { ...result, attendance: await this.assess(ctx, hearing) };
  }

  private async assess(
    ctx: TenantContext,
    hearing: CanonicalHearingRow,
  ): Promise<AttendanceAssessment> {
    const [candidates, capture, subscription, transcriptCount] = await Promise.all([
      this.prisma.hearingStreamCandidate.findMany({
        where: { hearingId: hearing.id },
        orderBy: [{ priority: 'asc' }, { updatedAt: 'desc' }],
        select: { capturePolicy: true, resolutionState: true },
      }),
      // domain_status / terminal_reason_code are SQL-owned columns that are not
      // declared on the Prisma model, exactly as the Phase 7 service reads
      // them. Raw SQL is the only way to see them.
      this.prisma
        .$queryRawUnsafe<
          Array<{
            id: string;
            domainStatus: string;
            failureCode: string | null;
            terminalReasonCode: string | null;
          }>
        >(
          `SELECT id,
                  domain_status        AS "domainStatus",
                  failure_code         AS "failureCode",
                  terminal_reason_code AS "terminalReasonCode"
           FROM public_hearing_capture
           WHERE hearing_id = $1
           LIMIT 1`,
          hearing.id,
        )
        .then((rows) => rows[0] ?? null),
      this.prisma.withTenant(ctx.tenantId, (tx) =>
        tx.hearingSubscription.findFirst({
          where: { userId: ctx.userId, hearingId: hearing.id },
          select: {
            scheduledByUser: true,
            attendanceMode: true,
            consentAcknowledgedAt: true,
          },
        }),
      ),
      this.transcriptSegmentCount(hearing.id),
    ]);

    return assessAttendance({
      statePermission: await stateCapturePolicy(this.prisma, ctx, hearing),
      hearing: {
        id: hearing.id,
        visibility: hearing.visibility,
        eventStatus: hearing.eventStatus,
        url: hearing.url,
      },
      candidates,
      capture,
      subscription,
      hasTranscript: transcriptCount > 0,
    });
  }

  // ── W1-3 · archive + global hearing research ─────────────────────────────

  /** Accessible saved captures; public capture/transcript state stays separate. */
  async savedSessions(ctx: TenantContext, hearingId: string) {
    await this.requireHearing(hearingId, ctx);
    const discovery = await this.discoverSavedSessions(ctx, hearingId);
    return {
      hearingId,
      savedSessionsState: discovery.savedSessionsState,
      sessions: discovery.sessions.filter((session) => session.hearingId === hearingId),
      associationPolicy: 'explicit_hearing_id_or_unique_official_source',
    };
  }

  private discoverSavedSessions(
    ctx: TenantContext,
    hearingId: string | null = null,
  ): Promise<SavedSessionsDiscovery> {
    return this.prisma.withTenant(ctx.tenantId, (tx) =>
      discoverSavedHearingSessions(tx, ctx.tenantId, ctx.clerkUserId, hearingId),
    );
  }

  /**
   * Server-side search over the durable historical hearing corpus.
   *
   * Everything — matching, faceting, ordering and paging — happens in
   * Postgres. The browser never receives the corpus to filter locally.
   *
   * Matching spans four sources, unioned by hearing:
   *   1. hearing identity (title, committee, location, witness names) via FTS
   *   2. the canonical machine transcript segments
   *   3. the official published transcript text
   *   4. public intelligence findings
   *
   * Results are RANKED, not merely matched. With a query present, rows come
   * back in `matchTier` order (0 best), then by identity ts_rank_cd, then by
   * recency:
   *
   *   0  title+committee IS the phrase          3  identity phrase via FTS
   *   1  title+committee starts with it         4  identity has every term
   *   2  title+committee contains it            5  a body corpus has the phrase
   *                                             6  matched on scattered terms
   *
   * With no query the order is unchanged: pure recency, because "most relevant"
   * is meaningless when nothing was asked.
   *
   * `clientId` narrows to hearings with tenant relevance for that client. It
   * is validated against the caller's tenant first, so it cannot be used to
   * probe another tenant's client ids.
   */
  async searchArchive(
    ctx: TenantContext,
    input: ArchiveSearchInput,
  ): Promise<Record<string, unknown>> {
    if (input.clientId) await this.assertClientInTenant(ctx.tenantId, input.clientId);

    const phrase = input.q?.trim() || null;
    // Collapsed to `[a-z0-9 ]` so the phrase tiers compare against the same
    // normalization the SQL applies to title + committee. A consequence worth
    // stating: this cannot contain `%`, `_` or a backslash, which is why the
    // LIKE patterns built from it need no escaping.
    const normPhrase = phrase
      ? phrase
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, ' ')
          .trim()
      : '';
    const terms = normPhrase ? normPhrase.split(' ') : [];
    // One tenant-scoped discovery serves rows, counts, facets and any fallback
    // search. Never fetch tenant transcripts into the public research corpus.
    const saved = await this.discoverSavedSessions(ctx);

    const strict = await this.runArchiveSearch(ctx, input, saved, {
      phrase,
      ftsQuery: phrase,
      normPhrase: normPhrase || null,
      mode: phrase ? 'all-terms' : null,
    });
    if (strict.total > 0 || terms.length < 2) return strict;

    // Nothing matched EVERY term. Rather than return an empty page, fall back
    // once to an any-term query — and label it, so the UI can say these are
    // partial matches instead of passing them off as exact ones. One extra
    // round trip, and only on the otherwise-empty case.
    const partial = await this.runArchiveSearch(ctx, input, saved, {
      phrase,
      ftsQuery: terms.join(' or '),
      normPhrase: normPhrase || null,
      mode: 'partial',
    });
    return partial.total > 0 ? partial : strict;
  }

  /**
   * One matched, faceted, ranked page of the archive.
   *
   * `match.ftsQuery` is what the predicate and the snippets run against;
   * `match.phrase` is the user's original string, kept separate so the phrase
   * tiers stay meaningful when `ftsQuery` has been rewritten for the any-term
   * fallback.
   *
   * Callers own the `input.clientId` tenant check; `searchArchive` does it once
   * before either pass.
   */
  private async runArchiveSearch(
    ctx: TenantContext,
    input: ArchiveSearchInput,
    saved: SavedSessionsDiscovery,
    match: {
      phrase: string | null;
      ftsQuery: string | null;
      normPhrase: string | null;
      mode: 'all-terms' | 'partial' | null;
    },
  ): Promise<ArchiveSearchPage> {
    const page = clampPage(input.page);
    const pageSize = clampPageSize(input.pageSize);
    const offset = (page - 1) * pageSize;
    const q = match.ftsQuery;

    // The archive is the DURABLE HISTORICAL corpus: proceedings that already
    // happened, or whose capture reached a terminal state. A scheduled future
    // hearing belongs to the calendar, not here.
    const baseWhere = `
      h.visibility = 'public'
      AND (
        h.event_status IN ('completed', 'canceled')
        OR c.domain_status IN ('COMPLETE','COMPLETE_WITH_GAPS','FAILED','CANCELED','BLOCKED')
        OR ot.id IS NOT NULL
      )`;

    // Text match. websearch_to_tsquery accepts real user input (quoted
    // phrases, OR, -negation) without throwing on stray syntax the way
    // to_tsquery does.
    const textMatch = q
      ? `AND (
           to_tsvector('english',
             coalesce(h.title,'') || ' ' || coalesce(h.committee_name,'') || ' ' ||
             coalesce(h.location,'') || ' ' || legiwatch_witness_text(h.witnesses)
           ) @@ websearch_to_tsquery('english', $1)
           OR EXISTS (
             SELECT 1 FROM public_hearing_transcript_segment s
             WHERE s.capture_id = c.id
               AND to_tsvector('english', s.text) @@ websearch_to_tsquery('english', $1)
           )
           OR (ot.id IS NOT NULL AND to_tsvector('english', ot.text) @@ websearch_to_tsquery('english', $1))
           OR EXISTS (
             SELECT 1 FROM public_hearing_insight i
             WHERE i.hearing_id = h.id
               AND to_tsvector('english',
                     coalesce(i.title,'') || ' ' || coalesce(i.summary,'') || ' ' ||
                     coalesce(i.evidence_text,'')
                   ) @@ websearch_to_tsquery('english', $1)
           )
         )`
      : '';

    const filters: string[] = [];
    // `q` is bound as $1 ONLY when it exists. Binding a null placeholder that
    // no clause references makes Postgres reject the statement with 42P18
    // ("could not determine data type of parameter $1"), because an unreferenced
    // parameter has no inferable type.
    const params: unknown[] = q ? [q] : [];
    const bind = (value: unknown): string => {
      params.push(value);
      return `$${params.length}`;
    };

    if (input.from) filters.push(`AND h.date >= ${bind(input.from)}::date`);
    if (input.to) filters.push(`AND h.date <= ${bind(input.to)}::date`);
    if (input.chamber) filters.push(`AND lower(h.chamber) = lower(${bind(input.chamber)})`);
    if (input.committee) filters.push(`AND h.committee_system_code = ${bind(input.committee)}`);
    if (input.subcommittee)
      filters.push(`AND h.subcommittee_system_code = ${bind(input.subcommittee)}`);
    if (input.eventStatus) filters.push(`AND h.event_status = ${bind(input.eventStatus)}`);
    const savedTranscriptHearingIds = [
      ...new Set(
        saved.sessions
          .filter((session) => session.transcriptSegmentCount > 0)
          .map((session) => session.hearingId),
      ),
    ];
    if (input.hasTranscript === true)
      filters.push(
        `AND (ot.id IS NOT NULL OR EXISTS (SELECT 1 FROM public_hearing_transcript_segment s2 WHERE s2.capture_id = c.id)
          OR h.id = ANY(${bind(savedTranscriptHearingIds)}::text[]))`,
      );
    if (input.hasTranscript === false)
      filters.push(
        `AND ot.id IS NULL AND NOT EXISTS (SELECT 1 FROM public_hearing_transcript_segment s2 WHERE s2.capture_id = c.id)
          AND NOT (h.id = ANY(${bind(savedTranscriptHearingIds)}::text[]))`,
      );
    if (input.intelligenceType)
      filters.push(
        `AND EXISTS (SELECT 1 FROM public_hearing_insight i2 WHERE i2.hearing_id = h.id AND i2.insight_type = ${bind(input.intelligenceType)})`,
      );

    // Client relevance filtering. tenant_hearing_relevance is FORCE-RLS
    // isolated and this whole query runs inside withTenant, so the tenant
    // predicate is enforced by the policy as well as stated here.
    if (input.clientId) {
      const clientBind = bind(input.clientId);
      // The ONE relevance-band vocabulary: RELEVANCE_BAND_FLOORS, also used by
      // clientRelevance/allClientsRelevance and (Wave 2) committee intelligence
      // history. A second hardcoded copy here would only need to drift once.
      const bandFloor =
        input.relevanceBand === 'HIGH'
          ? RELEVANCE_BAND_FLOORS.HIGH
          : input.relevanceBand === 'MEDIUM'
            ? RELEVANCE_BAND_FLOORS.MEDIUM
            : input.relevanceBand === 'LOW'
              ? RELEVANCE_BAND_FLOORS.LOW
              : null;
      filters.push(
        `AND EXISTS (
           SELECT 1 FROM tenant_hearing_relevance r
           WHERE r.hearing_id = h.id
             AND r.client_id = ${clientBind}::uuid
             ${bandFloor === null ? '' : `AND r.score >= ${bind(bandFloor)}`}
         )`,
      );
    }

    const where = `${baseWhere} ${textMatch} ${filters.join(' ')}`;

    // Every parameter the shared WHERE references, captured BEFORE the ranking
    // and paging binds. The count and the three facet queries reuse `where` and
    // nothing else, and Postgres rejects a bind carrying more parameters than
    // the statement uses — so this count, not "the last two", is what they slice
    // to.
    const filterParamCount = params.length;

    // The FROM clause is shared by the row query, the count and the facets so
    // a facet can never describe a different population than the results.
    const from = `
      FROM federal_committee_hearing h
      LEFT JOIN public_hearing_capture c ON c.hearing_id = h.id
      LEFT JOIN official_hearing_transcript ot ON ot.hearing_id = h.id`;

    // The hearing-identity document, exactly as `committee_hearing_search_fts_idx`
    // declares it.
    const identityTsv = `to_tsvector('english',
               coalesce(h.title,'') || ' ' || coalesce(h.committee_name,'') || ' ' ||
               coalesce(h.location,'') || ' ' || legiwatch_witness_text(h.witnesses)
             )`;

    // Title + committee only, normalized the same way `normPhrase` is. Location
    // and witness names stay out of the phrase tiers — a room number should not
    // manufacture a phrase hit — but they are still matched and ranked through
    // the FTS tiers below, which use the full indexed document.
    const normIdentity = `btrim(regexp_replace(
               lower(coalesce(h.title,'') || ' ' || coalesce(h.committee_name,'')),
               '[^a-z0-9]+', ' ', 'g'))`;

    // ── Relevance ranking ──────────────────────────────────────────────────
    // The four-corpus OR above answers WHETHER a hearing matched and says
    // nothing about HOW WELL: websearch_to_tsquery lowers "Armed Services" to
    // the unordered `'arm' & 'servic'`, so the phrase is not represented in the
    // predicate at all. Ordering that boolean by recency alone is what put the
    // newest proceeding whose multi-hour transcript happens to contain both
    // stems above the House Armed Services Committee itself.
    //
    // The tier reconstructs the phrase and orders by it. It lives ONLY in the
    // row query's SELECT/ORDER BY: the predicate, the count and all three
    // facets are untouched, so no result population moves — only its order.
    const phrase = match.phrase;
    let matchTierSql = 'NULL';
    if (q && phrase) {
      const phraseBind = bind(phrase);
      // Adjacency in one of the body corpora — a real phrase hit in a
      // transcript still beats two stems scattered across two hours of it.
      const bodyPhrase = `(
                 EXISTS (
                   SELECT 1 FROM public_hearing_transcript_segment s5
                   WHERE s5.capture_id = c.id
                     AND to_tsvector('english', s5.text) @@ phraseto_tsquery('english', ${phraseBind})
                 )
                 OR (ot.id IS NOT NULL AND to_tsvector('english', ot.text) @@ phraseto_tsquery('english', ${phraseBind}))
                 OR EXISTS (
                   SELECT 1 FROM public_hearing_insight i5
                   WHERE i5.hearing_id = h.id
                     AND to_tsvector('english',
                           coalesce(i5.title,'') || ' ' || coalesce(i5.summary,'') || ' ' ||
                           coalesce(i5.evidence_text,'')
                         ) @@ phraseto_tsquery('english', ${phraseBind})
                 ))`;
      const literalTiers: string[] = [];
      if (match.normPhrase) {
        const normBind = bind(match.normPhrase);
        literalTiers.push(
          `WHEN ${normIdentity} = ${normBind} THEN 0`,
          `WHEN ${normIdentity} LIKE ${normBind} || ' %' THEN 1`,
          `WHEN ' ' || ${normIdentity} || ' ' LIKE '% ' || ${normBind} || ' %' THEN 2`,
        );
      }
      matchTierSql = `CASE
               ${literalTiers.join('\n               ')}
               WHEN ${identityTsv} @@ phraseto_tsquery('english', ${phraseBind}) THEN 3
               WHEN ${identityTsv} @@ websearch_to_tsquery('english', $1) THEN 4
               WHEN ${bodyPhrase} THEN 5
               ELSE 6
             END`;
    }

    const rowSql = `
      SELECT h.id,
             h.title,
             h.chamber,
             h.committee_name          AS "committeeName",
             h.committee_system_code   AS "committeeSystemCode",
             h.subcommittee_system_code AS "subcommitteeSystemCode",
             h.date,
             h.starts_at               AS "startsAt",
             h.time,
             h.timezone,
             h.location,
             h.url                     AS "officialPageUrl",
             h.event_status            AS "eventStatus",
             h.type                    AS "eventType",
             h.witnesses,
             c.id                      AS "captureId",
             c.domain_status           AS "captureStatus",
             c.actual_end              AS "captureActualEnd",
             c.transcript_gap_seconds  AS "transcriptGapSeconds",
             ot.id                     AS "officialTranscriptId",
             (SELECT count(*)::int FROM public_hearing_transcript_segment s3 WHERE s3.capture_id = c.id) AS "segmentCount",
             (SELECT count(*)::int FROM public_hearing_insight i3 WHERE i3.hearing_id = h.id) AS "insightCount",
             ${
               q
                 ? `(
               SELECT json_build_object(
                 'segmentId', s4.id,
                 'startMs',  s4.start_ms,
                 'speakerName', s4.speaker_label,
                 'snippet', ts_headline('english', s4.text, websearch_to_tsquery('english', $1),
                                        'MaxFragments=1, MaxWords=28, MinWords=8, StartSel=<mark>, StopSel=</mark>')
               )
               FROM public_hearing_transcript_segment s4
               WHERE s4.capture_id = c.id
                 AND to_tsvector('english', s4.text) @@ websearch_to_tsquery('english', $1)
               ORDER BY ts_rank(to_tsvector('english', s4.text), websearch_to_tsquery('english', $1)) DESC, s4.sequence ASC
               LIMIT 1
             )`
                 : 'NULL'
             } AS "transcriptHit",
             ${
               q
                 ? `(
               SELECT json_build_object('insightId', i4.id, 'insightType', i4.insight_type, 'title', i4.title)
               FROM public_hearing_insight i4
               WHERE i4.hearing_id = h.id
                 AND to_tsvector('english',
                       coalesce(i4.title,'') || ' ' || coalesce(i4.summary,'') || ' ' || coalesce(i4.evidence_text,'')
                     ) @@ websearch_to_tsquery('english', $1)
               ORDER BY i4.sequence ASC
               LIMIT 1
             )`
                 : 'NULL'
             } AS "intelligenceHit",
             ${matchTierSql} AS "matchTier"
      ${from}
      WHERE ${where}
      ORDER BY ${
        q && phrase
          ? `"matchTier" ASC,
               ts_rank_cd(${identityTsv}, websearch_to_tsquery('english', $1)) DESC,
               `
          : ''
      }COALESCE(c.actual_end, h.starts_at, h.date::timestamp) DESC, h.id DESC
      LIMIT ${bind(pageSize)} OFFSET ${bind(offset)}`;

    const rows = await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.$queryRawUnsafe<Array<Record<string, unknown>>>(rowSql, ...params),
    );

    // Count and facets reuse only the params the shared WHERE references.
    // NOT `params.length - 2`: phrase-aware ranking (LW-QA-023) binds beyond the
    // LIMIT/OFFSET pair, so the count of FILTER params is the only safe slice.
    const facetParams = params.slice(0, filterParamCount);
    const [totals, chamberFacets, committeeFacets, statusFacets, corpusTotals] =
      await this.prisma.withTenant(ctx.tenantId, async (tx) =>
        Promise.all([
          tx.$queryRawUnsafe<Array<{ total: number }>>(
            `SELECT count(DISTINCT h.id)::int AS total ${from} WHERE ${where}`,
            ...facetParams,
          ),
          tx.$queryRawUnsafe<Array<{ value: string; count: number }>>(
            `SELECT h.chamber AS value, count(DISTINCT h.id)::int AS count ${from} WHERE ${where}
             GROUP BY h.chamber ORDER BY count DESC, value ASC`,
            ...facetParams,
          ),
          tx.$queryRawUnsafe<Array<{ value: string; label: string; count: number }>>(
            `SELECT h.committee_system_code AS value, min(h.committee_name) AS label,
                    count(DISTINCT h.id)::int AS count ${from} WHERE ${where}
               AND h.committee_system_code IS NOT NULL
             GROUP BY h.committee_system_code ORDER BY count DESC, label ASC LIMIT 40`,
            ...facetParams,
          ),
          tx.$queryRawUnsafe<Array<{ value: string; count: number }>>(
            `SELECT h.event_status AS value, count(DISTINCT h.id)::int AS count ${from} WHERE ${where}
             GROUP BY h.event_status ORDER BY count DESC, value ASC`,
            ...facetParams,
          ),
          // The archive BEFORE the query and facets narrow it. Every number
          // above is post-filter, so a zero `total` cannot tell "nothing
          // matched" from "nothing is here" — and the surface was rendering
          // the second message for the first case. `baseWhere` is entirely
          // literal, so this binds no parameters and cannot disturb the $1
          // q-binding or the LIMIT/OFFSET binds.
          tx.$queryRawUnsafe<Array<{ total: number }>>(
            `SELECT count(DISTINCT h.id)::int AS total ${from} WHERE ${baseWhere}`,
          ),
        ]),
      );

    const total = totals[0]?.total ?? 0;

    return {
      rows: rows.map((row) => ({
        ...this.toArchiveResult(row),
        savedSessions: saved.sessions.filter((session) => session.hearingId === row.id),
        savedTranscriptAvailable:
          saved.savedSessionsState === 'unavailable'
            ? null
            : savedTranscriptHearingIds.includes(String(row.id)),
      })),
      savedSessionsState: saved.savedSessionsState,
      total,
      corpusTotal: corpusTotals[0]?.total ?? 0,
      page,
      pageSize,
      hasMore: offset + rows.length < total,
      query: match.phrase,
      matchMode: match.mode,
      facets: {
        chamber: chamberFacets,
        committee: committeeFacets,
        eventStatus: statusFacets,
      },
    };
  }

  private toArchiveResult(row: Record<string, unknown>): Record<string, unknown> {
    const segmentCount = Number(row.segmentCount ?? 0);
    const hasOfficial = Boolean(row.officialTranscriptId);
    const date = row.date instanceof Date ? row.date : null;
    return {
      id: row.id,
      title: row.title,
      chamber: row.chamber,
      committeeName: row.committeeName,
      committeeSystemCode: row.committeeSystemCode,
      subcommitteeSystemCode: row.subcommitteeSystemCode,
      // Eastern calendar day as a plain `YYYY-MM-DD` string. Never an instant:
      // the web contract formats the parts directly and a timestamp here is
      // what reintroduces the midnight-UTC day shift.
      calendarDate: date ? date.toISOString().slice(0, 10) : null,
      scheduledStart: row.startsAt instanceof Date ? row.startsAt.toISOString() : null,
      time: row.time,
      timeZone: row.timezone,
      location: row.location,
      officialPageUrl: row.officialPageUrl,
      eventStatus: row.eventStatus,
      eventType: row.eventType,
      witnesses: Array.isArray(row.witnesses) ? row.witnesses : [],
      captureStatus: row.captureStatus ?? null,
      transcript: {
        available: segmentCount > 0 || hasOfficial,
        segmentCount,
        officialTranscriptId: row.officialTranscriptId ?? null,
        gapSeconds: row.transcriptGapSeconds ?? null,
      },
      intelligenceCount: Number(row.insightCount ?? 0),
      transcriptHit: row.transcriptHit ?? null,
      intelligenceHit: row.intelligenceHit ?? null,
      // Which ranking tier placed this row. Exposed so the ordering is
      // inspectable from the client and assertable from a test, rather than
      // being an opaque property of the SQL.
      matchTier: row.matchTier == null ? null : Number(row.matchTier),
      // Every result funnels to the ONE canonical destination.
      detailPath: `/legiwatch/hearings/${encodeURIComponent(String(row.id))}`,
    };
  }

  // ── W1-4 · committee following + committee intelligence ──────────────────

  async committeeFollowState(
    ctx: TenantContext,
    systemCode: string,
  ): Promise<Record<string, unknown>> {
    const { systemCode: canonicalCode } = await this.requireCommittee(ctx, systemCode);
    const row = await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.legiWatchCommitteeFollow.findFirst({
        where: { userId: ctx.userId, committeeSystemCode: canonicalCode },
      }),
    );
    return this.toCommitteeFollowState(ctx, canonicalCode, row);
  }

  async upsertCommitteeFollow(
    ctx: TenantContext,
    systemCode: string,
    input: CommitteeFollowInput,
  ): Promise<Record<string, unknown>> {
    const { systemCode: canonicalCode } = await this.requireCommittee(ctx, systemCode);
    const clientIds = await this.resolveClientIds(ctx, input.clientIds ?? []);

    const row = await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.legiWatchCommitteeFollow.upsert({
        where: {
          tenantId_userId_committeeSystemCode: {
            tenantId: ctx.tenantId,
            userId: ctx.userId,
            committeeSystemCode: canonicalCode,
          },
        },
        create: {
          tenantId: ctx.tenantId,
          userId: ctx.userId,
          committeeSystemCode: canonicalCode,
          clientIds,
          notifyOnNewHearing: input.notifyOnNewHearing ?? true,
          notifyOnScheduleChange: input.notifyOnScheduleChange ?? true,
          notifyOnTranscriptReady: input.notifyOnTranscriptReady ?? false,
          notifyOnHighPriorityMatch: input.notifyOnHighPriorityMatch ?? true,
        },
        update: {
          clientIds,
          ...(input.notifyOnNewHearing === undefined
            ? {}
            : { notifyOnNewHearing: input.notifyOnNewHearing }),
          ...(input.notifyOnScheduleChange === undefined
            ? {}
            : { notifyOnScheduleChange: input.notifyOnScheduleChange }),
          ...(input.notifyOnTranscriptReady === undefined
            ? {}
            : { notifyOnTranscriptReady: input.notifyOnTranscriptReady }),
          ...(input.notifyOnHighPriorityMatch === undefined
            ? {}
            : { notifyOnHighPriorityMatch: input.notifyOnHighPriorityMatch }),
          updatedAt: new Date(),
        },
      }),
    );
    return this.toCommitteeFollowState(ctx, canonicalCode, row);
  }

  async unfollowCommittee(
    ctx: TenantContext,
    systemCode: string,
  ): Promise<Record<string, unknown>> {
    const { systemCode: canonicalCode } = await this.requireCommittee(ctx, systemCode);
    await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.legiWatchCommitteeFollow.deleteMany({
        where: { userId: ctx.userId, committeeSystemCode: canonicalCode },
      }),
    );
    return this.toCommitteeFollowState(ctx, canonicalCode, null);
  }

  private async toCommitteeFollowState(
    ctx: TenantContext,
    systemCode: string,
    row: {
      clientIds: string[];
      notifyOnNewHearing: boolean;
      notifyOnScheduleChange: boolean;
      notifyOnTranscriptReady: boolean;
      notifyOnHighPriorityMatch: boolean;
      createdAt: Date;
      updatedAt: Date;
    } | null,
  ): Promise<Record<string, unknown>> {
    if (!row) {
      return {
        committeeSystemCode: systemCode,
        following: false,
        clientIds: [],
        clients: [],
        notifyOnNewHearing: true,
        notifyOnScheduleChange: true,
        notifyOnTranscriptReady: false,
        notifyOnHighPriorityMatch: true,
        createdAt: null,
        updatedAt: null,
      };
    }
    return {
      committeeSystemCode: systemCode,
      following: true,
      clientIds: row.clientIds,
      clients: await this.describeClients(ctx, row.clientIds),
      notifyOnNewHearing: row.notifyOnNewHearing,
      notifyOnScheduleChange: row.notifyOnScheduleChange,
      notifyOnTranscriptReady: row.notifyOnTranscriptReady,
      notifyOnHighPriorityMatch: row.notifyOnHighPriorityMatch,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  /**
   * Committee intelligence history (W2-1).
   *
   * Derived from the committee's OWN canonical hearings' public insights. It
   * fabricates nothing: a committee whose hearings have produced no insights
   * returns an empty list with the hearing/extraction counts that explain why.
   *
   * ── exact committee vs. optional subcommittee inclusion ──
   *
   * A hearing's `committee_system_code` is always its TOP-LEVEL committee;
   * `subcommittee_system_code` is set ADDITIONALLY when a subcommittee
   * convened it. So "exact committee" for a requested code — whether that
   * code names a top-level committee or a subcommittee — means:
   *
   *   (committee_system_code = code AND subcommittee_system_code IS NULL)
   *     OR subcommittee_system_code = code
   *
   * i.e. a full-committee hearing under `code`, or a hearing specifically
   * convened by the subcommittee `code`. `includeSubcommittees` widens that to
   * every hearing whose TOP-LEVEL committee is `code`, sub-convened or not —
   * the opt-in, not the default, so a committee room's own history is not
   * silently diluted with every subcommittee's activity.
   *
   * ── entity filters (speaker/agency/bill/programElement) ──
   *
   * `speaker` matches the stored `speaker_name` column. `agency`/`bill`/
   * `programElement` match against `entities` (`Array<{entityType, label,
   * canonicalId}>`) by label/canonicalId substring, NOT by entityType: the
   * extraction pipeline enforces no fixed entityType vocabulary (confirmed
   * against `safeEntities` in live-hearings-phase8.service.ts, which accepts
   * any string up to 64 chars, defaulting to 'OTHER'). Requiring an exact type
   * match would silently return nothing the moment the extractor's tagging
   * drifts from whatever this endpoint hardcoded; matching the label/
   * canonicalId text is honest about what the stored data actually guarantees.
   *
   * ── pagination ──
   *
   * Keyset (`created_at DESC, id DESC`), not offset/page: intelligence rows
   * arrive continuously as Phase 9's extraction backfills, so an offset page
   * can duplicate or skip rows across requests once new rows land above the
   * window. A stable ORDER BY tiebreaker is necessary but not sufficient for
   * that — only a keyset cursor is.
   */
  async committeeIntelligenceHistory(
    ctx: TenantContext,
    systemCode: string,
    input: {
      cursor?: string;
      pageSize?: number;
      insightType?: string;
      includeSubcommittees?: boolean;
      dateFrom?: string;
      dateTo?: string;
      speaker?: string;
      agency?: string;
      bill?: string;
      programElement?: string;
      clientId?: string;
      relevanceBand?: string;
    },
  ): Promise<Record<string, unknown>> {
    const { systemCode: canonicalCode } = await this.requireCommittee(ctx, systemCode);
    const pageSize = clampPageSize(input.pageSize);
    if (input.clientId) await this.assertClientInTenant(ctx.tenantId, input.clientId);

    const params: unknown[] = [canonicalCode];
    const bind = (v: unknown): string => {
      params.push(v);
      return `$${params.length}`;
    };

    // lower() on both sides for the same reason CommitteeDirectoryService
    // normalizes before comparing: committee_hearing.committee_system_code is
    // written by the discovery pipeline and is not guaranteed to share
    // congress_committee.system_code's casing, so a byte-equality join here
    // silently returns an empty history instead of the committee's insights.
    const committeeFilter = input.includeSubcommittees
      ? `(lower(h.committee_system_code) = lower($1) OR lower(h.subcommittee_system_code) = lower($1))`
      : `((lower(h.committee_system_code) = lower($1) AND h.subcommittee_system_code IS NULL) OR lower(h.subcommittee_system_code) = lower($1))`;

    const filters: string[] = [];
    if (input.insightType) filters.push(`AND i.insight_type = ${bind(input.insightType)}`);
    if (input.dateFrom) filters.push(`AND h.date >= ${bind(input.dateFrom)}::date`);
    if (input.dateTo) filters.push(`AND h.date <= ${bind(input.dateTo)}::date`);
    if (input.speaker) filters.push(`AND i.speaker_name ILIKE ${bind(`%${input.speaker}%`)}`);
    const entityFilter = (value: string | undefined): void => {
      if (!value) return;
      filters.push(
        `AND EXISTS (
           SELECT 1 FROM jsonb_array_elements(i.entities) AS e
           WHERE (e->>'label' ILIKE ${bind(`%${value}%`)} OR e->>'canonicalId' ILIKE ${bind(`%${value}%`)})
         )`,
      );
    };
    entityFilter(input.agency);
    entityFilter(input.bill);
    entityFilter(input.programElement);

    // Client relevance filtering. tenant_hearing_relevance is FORCE-RLS
    // isolated and this whole query runs inside withTenant, so the tenant
    // predicate is enforced by the policy as well as stated here.
    if (input.clientId) {
      const clientBind = bind(input.clientId);
      const bandFloor =
        input.relevanceBand === 'HIGH'
          ? RELEVANCE_BAND_FLOORS.HIGH
          : input.relevanceBand === 'MEDIUM'
            ? RELEVANCE_BAND_FLOORS.MEDIUM
            : input.relevanceBand === 'LOW'
              ? RELEVANCE_BAND_FLOORS.LOW
              : null;
      filters.push(
        `AND EXISTS (
           SELECT 1 FROM tenant_hearing_relevance r
           WHERE r.insight_id = i.id AND r.client_id = ${clientBind}::uuid
             ${bandFloor === null ? '' : `AND r.score >= ${bind(bandFloor)}`}
         )`,
      );
    }

    const filterSql = filters.join('\n        ');
    // Snapshot the params bound so far: `total` describes the WHOLE filtered
    // set regardless of pagination position, so it must never see the keyset
    // cursor or the LIMIT bind added below. Slicing by this snapshot's length
    // is exact and immune to however many params either one happens to add.
    const countParams = [...params];

    // Keyset cursor: `(created_at, id) < (cursorCreatedAt, cursorId)`,
    // decomposed the same way Feed's cursor is (feed.service.ts) so the two
    // LegiWatch keyset implementations read the same way. Applied to the main
    // query only — never to the count.
    const cursor = decodeIntelHistoryCursor(input.cursor);
    const cursorSql = cursor
      ? `AND (i.created_at < ${bind(cursor.createdAtText)}::timestamptz
              OR (i.created_at = ${bind(cursor.createdAtText)}::timestamptz AND i.id < ${bind(cursor.id)}))`
      : '';

    const sql = `
      SELECT i.id,
             i.hearing_id       AS "hearingId",
             i.insight_type     AS "insightType",
             i.title,
             i.summary,
             i.evidence_text    AS "evidenceText",
             i.speaker_name     AS "speakerName",
             i.confidence,
             i.preliminary,
             i.entities,
             i.segment_id       AS "segmentId",
             i.start_ms         AS "startMs",
             i.end_ms           AS "endMs",
             i.extractor,
             i.extractor_version AS "extractorVersion",
             i.created_at       AS "createdAt",
             i.created_at::text AS "createdAtCursor",
             h.title            AS "hearingTitle",
             h.date             AS "hearingDate",
             h.committee_system_code    AS "hearingCommitteeSystemCode",
             h.subcommittee_system_code AS "hearingSubcommitteeSystemCode"
      FROM public_hearing_insight i
      JOIN federal_committee_hearing h ON h.id = i.hearing_id
      WHERE ${committeeFilter}
        ${filterSql}
        ${cursorSql}
      ORDER BY i.created_at DESC, i.id DESC
      LIMIT ${bind(pageSize + 1)}`;

    const countSql = `
      SELECT count(*)::int AS total
      FROM public_hearing_insight i
      JOIN federal_committee_hearing h ON h.id = i.hearing_id
      WHERE ${committeeFilter}
        ${filterSql}`;

    const [rows, totals, hearingStats, extractionStats] = await this.prisma.withTenant(
      ctx.tenantId,
      async (tx) =>
        Promise.all([
          tx.$queryRawUnsafe<Array<Record<string, unknown>>>(sql, ...params),
          tx.$queryRawUnsafe<Array<{ total: number }>>(countSql, ...countParams),
          tx.$queryRawUnsafe<Array<{ total: number; withTranscript: number }>>(
            `SELECT count(*)::int AS total,
                    count(*) FILTER (
                      WHERE EXISTS (
                        SELECT 1 FROM public_hearing_capture c
                        JOIN public_hearing_transcript_segment s ON s.capture_id = c.id
                        WHERE c.hearing_id = h.id
                      )
                    )::int AS "withTranscript"
             FROM federal_committee_hearing h
             WHERE ${committeeFilter}`,
            canonicalCode,
          ),
          // Extraction is PROCESSING, not silently "nothing found", whenever
          // this committee's hearings still have pending/leased intelligence
          // jobs — mirrors the per-hearing `intelProcessing` signal already
          // established on the Hearing Detail route.
          tx.$queryRawUnsafe<Array<{ pending: number }>>(
            `SELECT count(*)::int AS pending
             FROM public_hearing_intelligence_job j
             JOIN federal_committee_hearing h ON h.id = j.hearing_id
             WHERE ${committeeFilter}
               AND j.status IN ('pending', 'leased')`,
            canonicalCode,
          ),
        ]),
    );

    const total = totals[0]?.total ?? 0;
    const hasMore = rows.length > pageSize;
    const page = hasMore ? rows.slice(0, pageSize) : rows;
    const last = page[page.length - 1] as { createdAtCursor?: unknown; id?: unknown } | undefined;
    const nextCursor =
      hasMore && typeof last?.createdAtCursor === 'string' && typeof last.id === 'string'
        ? encodeIntelHistoryCursor({ createdAtText: last.createdAtCursor, id: last.id })
        : null;

    return {
      committeeSystemCode: canonicalCode,
      includeSubcommittees: Boolean(input.includeSubcommittees),
      rows: page.map((r) => {
        // `createdAtCursor` is the internal lossless-text form used only to
        // build `nextCursor` above; it is not part of the client-facing shape.
        const { createdAtCursor: _createdAtCursor, ...rest } = r;
        return {
          ...rest,
          entities: Array.isArray(rest.entities) ? rest.entities : [],
          hearingDate:
            rest.hearingDate instanceof Date ? rest.hearingDate.toISOString().slice(0, 10) : null,
          createdAt: rest.createdAt instanceof Date ? rest.createdAt.toISOString() : null,
          // `timecode` is the H:MM:SS rendering used everywhere else client
          // relevance/evidence is shown (legiwatch-wave1-relevance.ts), so a
          // committee-intelligence evidence row reads identically to a
          // hearing-detail one.
          timecode: typeof rest.startMs === 'number' ? timecode(rest.startMs) : null,
          detailPath: `/legiwatch/hearings/${encodeURIComponent(String(rest.hearingId))}`,
        };
      }),
      total,
      hasMore,
      nextCursor,
      // The honest-unavailable context: zero insights with zero transcribed
      // hearings is "nothing captured yet", not "nothing happened"; a nonzero
      // `pendingExtractionJobs` means more may still be coming (PROCESSING),
      // never render as if extraction had already finished with nothing found.
      corpus: {
        hearings: hearingStats[0]?.total ?? 0,
        hearingsWithTranscript: hearingStats[0]?.withTranscript ?? 0,
        pendingExtractionJobs: extractionStats[0]?.pending ?? 0,
      },
    };
  }

  // ── W1-6 · client relevance V2 ───────────────────────────────────────────

  /** One client's structured relevance for one hearing. */
  async clientRelevance(
    ctx: TenantContext,
    hearingId: string,
    clientId: string,
  ): Promise<ClientRelevanceResult> {
    await this.requireHearing(hearingId, ctx);
    const client = await this.assertClientInTenant(ctx.tenantId, clientId);
    const [rows, segments] = await Promise.all([
      this.relevanceRows(ctx, hearingId, clientId),
      this.transcriptSegmentCount(hearingId),
    ]);
    return buildClientRelevance({
      clientId,
      clientName: client.name,
      hearingId,
      rows,
      hasTranscript: segments > 0,
    });
  }

  /**
   * Client context for the post-hearing brief, for a BACKEND-SERVICE caller
   * (intel-api, over the internal shared-secret channel) that holds a tenantId
   * but no user. Returns the client's name plus the same relevance result the
   * user-facing route serves, or a null relevance when the session has no
   * canonical hearing (ad-hoc browser capture) or the hearing is unknown here.
   * The client must belong to the tenant — `assertClientInTenant` 404s otherwise.
   */
  async clientBriefContext(
    tenantId: string,
    clientId: string,
    hearingId: string | null,
  ): Promise<{ clientName: string | null; relevance: ClientRelevanceResult | null }> {
    const client = await this.assertClientInTenant(tenantId, clientId);
    if (!hearingId) return { clientName: client.name, relevance: null };
    const hearing = await this.prisma.committeeHearing.findUnique({
      where: { id: hearingId },
      select: { id: true },
    });
    if (!hearing) return { clientName: client.name, relevance: null };
    const [rows, segments] = await Promise.all([
      this.relevanceRows({ tenantId }, hearingId, clientId),
      this.transcriptSegmentCount(hearingId),
    ]);
    return {
      clientName: client.name,
      relevance: buildClientRelevance({
        clientId,
        clientName: client.name,
        hearingId,
        rows,
        hasTranscript: segments > 0,
      }),
    };
  }

  /** The All-Clients ranked view over the caller's own client list. */
  async allClientsRelevance(
    ctx: TenantContext,
    hearingId: string,
  ): Promise<Record<string, unknown>> {
    await this.requireHearing(hearingId, ctx);
    const [clients, rows, segments] = await Promise.all([
      this.prisma.withTenant(ctx.tenantId, (tx) =>
        tx.client.findMany({
          where: { status: 'active' },
          select: { id: true, name: true },
          orderBy: { name: 'asc' },
        }),
      ),
      this.relevanceRows(ctx, hearingId, null),
      this.transcriptSegmentCount(hearingId),
    ]);

    const results = buildAllClientsRelevance({
      hearingId,
      authorizedClients: clients,
      rows,
      hasTranscript: segments > 0,
    });

    return {
      hearingId,
      scope: 'all-clients',
      transcriptAvailable: segments > 0,
      clients: results,
      counts: {
        HIGH: results.filter((r) => r.band === 'HIGH').length,
        MEDIUM: results.filter((r) => r.band === 'MEDIUM').length,
        LOW: results.filter((r) => r.band === 'LOW').length,
        NONE: results.filter((r) => r.band === 'NONE').length,
        INSUFFICIENT_EVIDENCE: results.filter((r) => r.band === 'INSUFFICIENT_EVIDENCE').length,
      },
    };
  }

  /**
   * Load tenant relevance rows joined to the global insights they cite.
   *
   * `tenant_hearing_relevance` is FORCE-RLS isolated and this runs inside
   * withTenant, so the tenant predicate is enforced by policy as well as by
   * the query.
   */
  private async relevanceRows(
    // Only the tenant is needed here (RLS scope). Narrowed so a backend-service
    // caller holding a bare tenantId can read without fabricating a user context.
    ctx: Pick<TenantContext, 'tenantId'>,
    hearingId: string,
    clientId: string | null,
  ): Promise<RelevanceRow[]> {
    const rows = await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.$queryRawUnsafe<Array<Record<string, unknown>>>(
        `SELECT r.id,
                r.client_id    AS "clientId",
                r.client_name  AS "clientName",
                r.hearing_id   AS "hearingId",
                r.insight_id   AS "insightId",
                r.score,
                r.matched_on   AS "matchedOn",
                r.rationale,
                r.updated_at   AS "updatedAt",
                i.insight_type AS "insightType",
                i.title        AS "insightTitle",
                i.summary      AS "insightSummary",
                i.evidence_text AS "evidenceText",
                i.speaker_name AS "speakerName",
                i.confidence,
                i.preliminary,
                i.segment_id   AS "segmentId",
                i.start_ms     AS "startMs",
                i.end_ms       AS "endMs",
                i.extractor,
                i.extractor_version AS "extractorVersion"
         FROM tenant_hearing_relevance r
         JOIN public_hearing_insight i ON i.id = r.insight_id
         WHERE r.hearing_id = $1
           AND ($2::uuid IS NULL OR r.client_id = $2::uuid)
         ORDER BY r.score DESC, i.sequence ASC`,
        hearingId,
        clientId,
      ),
    );

    return rows.map((r) => ({
      id: String(r.id),
      clientId: String(r.clientId),
      clientName: (r.clientName as string | null) ?? null,
      hearingId: String(r.hearingId),
      insightId: String(r.insightId),
      score: Number(r.score),
      matchedOn: r.matchedOn,
      rationale: String(r.rationale ?? ''),
      updatedAt: r.updatedAt instanceof Date ? r.updatedAt : new Date(String(r.updatedAt)),
      insightType: String(r.insightType),
      insightTitle: String(r.insightTitle ?? ''),
      insightSummary: String(r.insightSummary ?? ''),
      evidenceText: (r.evidenceText as string | null) ?? null,
      speakerName: (r.speakerName as string | null) ?? null,
      confidence: r.confidence == null ? null : Number(r.confidence),
      preliminary: Boolean(r.preliminary),
      segmentId: (r.segmentId as string | null) ?? null,
      startMs: r.startMs == null ? null : Number(r.startMs),
      endMs: r.endMs == null ? null : Number(r.endMs),
      extractor: String(r.extractor ?? 'unknown'),
      extractorVersion: String(r.extractorVersion ?? '0'),
    }));
  }

  // ── W1-7 · saved references ──────────────────────────────────────────────

  /**
   * Save a canonical reference. Idempotent: re-saving the same reference for
   * the same client updates the note instead of adding a duplicate row.
   *
   * Only REFERENCES are stored. The public transcript and insight text stay in
   * the global rail where they are canonical.
   */
  async saveItem(
    ctx: TenantContext,
    hearingId: string,
    input: {
      kind: 'moment' | 'finding' | 'hearing';
      segmentId?: string;
      insightId?: string;
      clientId?: string;
      note?: string;
    },
  ): Promise<Record<string, unknown>> {
    await this.requireHearing(hearingId, ctx);
    if (input.clientId) await this.assertClientInTenant(ctx.tenantId, input.clientId);

    // Validate the references actually belong to THIS hearing. Without this a
    // caller could file another proceeding's segment under this one and the
    // saved item would render with mismatched provenance.
    if (input.kind === 'moment') {
      if (!input.segmentId) {
        throw new BadRequestException('segmentId is required to save a moment');
      }
      await this.assertSegmentInHearing(hearingId, input.segmentId);
    }
    if (input.kind === 'finding') {
      if (!input.insightId) {
        throw new BadRequestException('insightId is required to save a finding');
      }
      await this.assertInsightInHearing(hearingId, input.insightId);
    }

    const rows = await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.$queryRawUnsafe<Array<{ id: string }>>(
        `INSERT INTO legiwatch_saved_item
           (tenant_id, user_id, kind, hearing_id, segment_id, insight_id, client_id, note,
            created_at, updated_at)
         VALUES ($1::uuid, $2, $3, $4, $5, $6, $7::uuid, $8, now(), now())
         ON CONFLICT (tenant_id, user_id, kind, hearing_id,
                      COALESCE(segment_id, ''), COALESCE(insight_id, ''),
                      COALESCE(client_id, '00000000-0000-0000-0000-000000000000'::uuid))
         DO UPDATE SET note = COALESCE(EXCLUDED.note, legiwatch_saved_item.note),
                       updated_at = now()
         RETURNING id`,
        ctx.tenantId,
        ctx.userId,
        input.kind,
        hearingId,
        input.segmentId ?? null,
        input.insightId ?? null,
        input.clientId ?? null,
        input.note ?? null,
      ),
    );

    return { id: rows[0]?.id ?? null, hearingId, kind: input.kind, saved: true };
  }

  async listSavedItems(
    ctx: TenantContext,
    input: { hearingId?: string; clientId?: string; page?: number; pageSize?: number },
  ): Promise<Record<string, unknown>> {
    const page = clampPage(input.page);
    const pageSize = clampPageSize(input.pageSize);
    if (input.clientId) await this.assertClientInTenant(ctx.tenantId, input.clientId);

    const [rows, total] = await this.prisma.withTenant(ctx.tenantId, async (tx) =>
      Promise.all([
        tx.legiWatchSavedItem.findMany({
          where: {
            userId: ctx.userId,
            ...(input.hearingId ? { hearingId: input.hearingId } : {}),
            ...(input.clientId ? { clientId: input.clientId } : {}),
          },
          orderBy: { createdAt: 'desc' },
          skip: (page - 1) * pageSize,
          take: pageSize,
        }),
        tx.legiWatchSavedItem.count({
          where: {
            userId: ctx.userId,
            ...(input.hearingId ? { hearingId: input.hearingId } : {}),
            ...(input.clientId ? { clientId: input.clientId } : {}),
          },
        }),
      ]),
    );

    return {
      rows: rows.map((r) => ({
        id: r.id,
        kind: r.kind,
        hearingId: r.hearingId,
        segmentId: r.segmentId,
        insightId: r.insightId,
        clientId: r.clientId,
        note: r.note,
        createdAt: r.createdAt.toISOString(),
        detailPath: `/legiwatch/hearings/${encodeURIComponent(r.hearingId)}`,
      })),
      total,
      page,
      pageSize,
      hasMore: (page - 1) * pageSize + rows.length < total,
    };
  }

  async deleteSavedItem(ctx: TenantContext, id: string): Promise<{ deleted: boolean }> {
    const result = await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.legiWatchSavedItem.deleteMany({ where: { id, userId: ctx.userId } }),
    );
    return { deleted: result.count > 0 };
  }

  /**
   * Build the grounded context packet for "Ask Meri".
   *
   * The packet carries canonical IDENTIFIERS and the specific evidence the user
   * selected — never an uncontrolled blob, and never unrelated client
   * information. The caller (Meri) resolves the references itself under its own
   * governance, which is what keeps Institutional Memory boundaries intact.
   */
  async buildMeriContextPacket(
    ctx: TenantContext,
    hearingId: string,
    input: { segmentId?: string; insightId?: string; clientId?: string; question?: string },
  ): Promise<Record<string, unknown>> {
    const hearing = await this.requireHearing(hearingId, ctx);
    let client: { id: string; name: string | null } | null = null;
    if (input.clientId) client = await this.assertClientInTenant(ctx.tenantId, input.clientId);
    if (input.segmentId) await this.assertSegmentInHearing(hearingId, input.segmentId);
    if (input.insightId) await this.assertInsightInHearing(hearingId, input.insightId);

    const segment = input.segmentId
      ? await this.prisma.publicHearingTranscriptSegment.findUnique({
          where: { id: input.segmentId },
          select: { id: true, startMs: true, endMs: true, text: true, speakerLabel: true },
        })
      : null;
    const insight = input.insightId
      ? await this.prisma.publicHearingInsight.findUnique({
          where: { id: input.insightId },
          select: {
            id: true,
            insightType: true,
            title: true,
            summary: true,
            evidenceText: true,
            segmentId: true,
            startMs: true,
          },
        })
      : null;

    // Only the SELECTED client's relevance, and only for this hearing. This is
    // the boundary that stops a hearing question from pulling the tenant's
    // whole client book into the prompt.
    const relevance =
      client && insight
        ? (await this.relevanceRows(ctx, hearingId, client.id)).filter(
            (r) => r.insightId === insight.id,
          )
        : [];

    return {
      source: 'legiwatch-hearing',
      hearing: {
        id: hearing.id,
        title: hearing.title,
        chamber: hearing.chamber,
        committeeName: hearing.committeeName,
        committeeSystemCode: hearing.committeeSystemCode,
        subcommitteeSystemCode: hearing.subcommitteeSystemCode,
        calendarDate: hearing.date.toISOString().slice(0, 10),
        scheduledStart: hearing.startsAt ? hearing.startsAt.toISOString() : null,
        eventStatus: hearing.eventStatus,
        officialPageUrl: hearing.url,
        detailPath: `/legiwatch/hearings/${encodeURIComponent(hearing.id)}`,
      },
      client: client ? { id: client.id, name: client.name } : null,
      transcriptSegment: segment,
      intelligenceFinding: insight,
      clientRelevance: relevance.map((r) => ({
        insightId: r.insightId,
        score: r.score,
        band: bandForScore(r.score),
        rationale: r.rationale,
        matchedOn: r.matchedOn,
      })),
      question: input.question?.trim() || null,
      /** Explicit provenance so the answer can cite what it was given. */
      evidenceReferences: {
        hearingId: hearing.id,
        segmentIds: segment ? [segment.id] : [],
        insightIds: insight ? [insight.id] : [],
      },
    };
  }

  /**
   * Grounded prefill for "Create brief".
   *
   * Wave 1 deliberately does NOT create the document here. Workspace owns
   * document creation (`POST /workspace-api/drafts`) and it is a separate
   * service with its own tenant guard; having apps/api call it server-to-server
   * would duplicate that architecture and add a second document-creation path
   * to keep in sync.
   *
   * Instead this returns the grounded context and the SOURCE REFERENCES the
   * brief must retain for traceability, and the web posts it to the existing
   * Workspace endpoint. One document editor, one creation path, and the
   * grounding is assembled server-side where the canonical data lives.
   */
  async buildBriefPrefill(
    ctx: TenantContext,
    hearingId: string,
    input: { clientId?: string; insightIds?: string[] },
  ): Promise<Record<string, unknown>> {
    const hearing = await this.requireHearing(hearingId, ctx);
    let client: { id: string; name: string | null } | null = null;
    if (input.clientId) client = await this.assertClientInTenant(ctx.tenantId, input.clientId);

    const requested = [...new Set((input.insightIds ?? []).filter(Boolean))];
    for (const id of requested) await this.assertInsightInHearing(hearingId, id);

    // With no explicit selection, ground the brief in this client's matched
    // findings — never in every finding of the proceeding, which would put
    // unrelated material into a client document.
    const findings = requested.length
      ? await this.prisma.publicHearingInsight.findMany({
          where: { id: { in: requested }, hearingId },
          select: {
            id: true,
            insightType: true,
            title: true,
            summary: true,
            evidenceText: true,
            speakerName: true,
            segmentId: true,
            startMs: true,
          },
          orderBy: { sequence: 'asc' },
        })
      : client
        ? (await this.relevanceRows(ctx, hearingId, client.id)).slice(0, 10).map((r) => ({
            id: r.insightId,
            insightType: r.insightType,
            title: r.insightTitle,
            summary: r.insightSummary,
            evidenceText: r.evidenceText,
            speakerName: r.speakerName,
            segmentId: r.segmentId,
            startMs: r.startMs,
          }))
        : [];

    const calendarDate = hearing.date.toISOString().slice(0, 10);
    const detailPath = `/legiwatch/hearings/${encodeURIComponent(hearing.id)}`;

    return {
      /** Field names match Workspace's CreateDraftDto so the web can post directly. */
      draft: {
        docTitle: `Hearing brief — ${hearing.title}`,
        ...(client?.name ? { client: client.name } : {}),
      },
      context: {
        source: 'legiwatch-hearing',
        hearing: {
          id: hearing.id,
          title: hearing.title,
          chamber: hearing.chamber,
          committeeName: hearing.committeeName,
          calendarDate,
          eventStatus: hearing.eventStatus,
          witnesses: hearing.witnesses,
          detailPath,
          officialPageUrl: hearing.url,
        },
        client: client ? { id: client.id, name: client.name } : null,
        findings,
      },
      /**
       * The references the created document must retain. Traceability is the
       * point: a brief whose claims cannot be walked back to a canonical
       * segment is not a grounded brief.
       */
      sources: [
        { kind: 'hearing', id: hearing.id, path: detailPath },
        ...(hearing.url ? [{ kind: 'official_page', id: hearing.id, url: hearing.url }] : []),
        ...findings.map((f) => ({
          kind: 'intelligence_finding',
          id: f.id,
          segmentId: f.segmentId ?? null,
          startMs: f.startMs ?? null,
        })),
      ],
    };
  }

  /**
   * Grounded prefill for "Stage outreach".
   *
   * Same boundary as the brief: Engagement owns outreach creation and this
   * returns only the prefill. Nothing is sent, and nothing is auto-created —
   * the action stages work for user review, which is the required behavior.
   */
  async buildOutreachPrefill(
    ctx: TenantContext,
    hearingId: string,
    input: { clientId: string; insightId?: string; segmentId?: string },
  ): Promise<Record<string, unknown>> {
    const hearing = await this.requireHearing(hearingId, ctx);
    const client = await this.assertClientInTenant(ctx.tenantId, input.clientId);
    if (input.insightId) await this.assertInsightInHearing(hearingId, input.insightId);
    if (input.segmentId) await this.assertSegmentInHearing(hearingId, input.segmentId);

    const insight = input.insightId
      ? await this.prisma.publicHearingInsight.findUnique({
          where: { id: input.insightId },
          select: {
            id: true,
            insightType: true,
            title: true,
            summary: true,
            evidenceText: true,
            speakerName: true,
            segmentId: true,
            startMs: true,
          },
        })
      : null;
    const segment = input.segmentId
      ? await this.prisma.publicHearingTranscriptSegment.findUnique({
          where: { id: input.segmentId },
          select: { id: true, startMs: true, text: true, speakerLabel: true },
        })
      : null;

    const detailPath = `/legiwatch/hearings/${encodeURIComponent(hearing.id)}`;
    return {
      clientId: client.id,
      clientName: client.name,
      /** Staged only. Sending stays an explicit, separate user decision. */
      status: 'staged',
      autoSend: false,
      context: {
        source: 'legiwatch-hearing',
        hearing: {
          id: hearing.id,
          title: hearing.title,
          committeeName: hearing.committeeName,
          chamber: hearing.chamber,
          calendarDate: hearing.date.toISOString().slice(0, 10),
          detailPath,
          officialPageUrl: hearing.url,
        },
        finding: insight,
        transcriptMoment: segment,
      },
      sources: [
        { kind: 'hearing', id: hearing.id, path: detailPath },
        ...(insight ? [{ kind: 'intelligence_finding', id: insight.id }] : []),
        ...(segment ? [{ kind: 'transcript_segment', id: segment.id }] : []),
      ],
    };
  }

  // ── W1-8 · calendar export ───────────────────────────────────────────────

  async calendarExport(
    ctx: TenantContext,
    hearingId: string,
    appOrigin: string,
    options: { dateOnlyReminder?: boolean } = {},
  ): Promise<CalendarExportResult> {
    const canonicalId = await resolveCanonicalHearingId(this.prisma, hearingId);
    const hearing = await this.requireHearing(canonicalId, ctx);
    const payload = await this.toCalendarExportHearing(hearing);
    await this.preserveExportIdentity(payload, hearingId);
    return buildCalendarExport(payload, { appOrigin, ...options });
  }

  private async preserveExportIdentity(
    payload: CalendarExportHearing,
    requestedId: string,
  ): Promise<void> {
    if (payload.id !== requestedId) {
      const alias = await this.prisma.committeeHearing.findUnique({
        where: { id: requestedId },
        select: { calendarRevision: true, sourceRevision: true },
      });
      payload.uidHearingId = requestedId;
      // Offset, not max: every later canonical/source revision must advance
      // even when the retained alias used to have a much larger revision.
      payload.calendarRevision =
        (payload.calendarRevision ?? 0) +
        (alias?.calendarRevision ?? 0) +
        (alias?.sourceRevision ?? 0) +
        1;
    }
  }

  private async toCalendarExportHearing(
    hearing: CanonicalHearingRow,
  ): Promise<CalendarExportHearing> {
    const subcommittee = hearing.subcommitteeSystemCode
      ? await this.prisma.congressCommittee.findFirst({
          where: { systemCode: hearing.subcommitteeSystemCode },
          select: { name: true },
        })
      : null;
    return {
      id: hearing.id,
      title: hearing.title,
      date: hearing.date.toISOString().slice(0, 10),
      startsAt: hearing.startsAt,
      actualEnd: hearing.actualEnd,
      scheduledEnd: hearing.scheduledEnd,
      calendarRevision: (hearing.calendarRevision ?? 0) + (hearing.sourceRevision ?? 0),
      timePrecision: hearing.timePrecision,
      time: hearing.time,
      timezone: hearing.timezone,
      location: hearing.location,
      committeeName: hearing.committeeName,
      subcommitteeName: subcommittee?.name ?? null,
      chamber: hearing.chamber,
      url: hearing.url,
      eventStatus: hearing.eventStatus,
    };
  }

  /**
   * Header-level bulk export (LEGIWATCH-V2-HANDOFF §2/§5.1) — one VCALENDAR
   * with one VEVENT per hearing, reusing the same date/time-safe builder as
   * the single-hearing export. Exactly one of `hearingIds` (an explicit
   * selection — e.g. the user's followed hearings) or `from`/`to` (the
   * current filtered Schedule window) must be given. Closed-session hearings
   * are excluded — export never offers what the Schedule view itself hides.
   * Bounded to 500 hearings so this can never become a request/row storm.
   */
  async calendarExportBulk(
    ctx: TenantContext,
    input: CalendarQuery & { dateOnlyReminder?: boolean },
    appOrigin: string,
  ): Promise<{
    ics: string;
    filename: string;
    includedCount: number;
    skipped: Array<{ id: string; reason: string }>;
  }> {
    const MAX = 5000;
    if (input.hearingIds || (input.from && input.to)) {
      const calendar = new LiveHearingsService(this.prisma);
      const hearings: CalendarExportHearing[] = [];
      const requestedByCanonical = new Map<string, string>();
      for (const requestedId of input.hearingIds ?? []) {
        const canonicalId = await resolveCanonicalHearingId(this.prisma, requestedId);
        // If both IDs were selected, canonical wins independently of order.
        if (!requestedByCanonical.has(canonicalId) || requestedId === canonicalId)
          requestedByCanonical.set(canonicalId, requestedId);
      }
      let total = 0;
      for (let page = 1; page <= MAX / 200; page++) {
        const result = await calendar.calendar(ctx, { ...input, page, pageSize: 200 });
        total = result.total;
        if (total > MAX)
          throw new BadRequestException(
            `Selection contains ${total} events; narrow it to at most ${MAX}`,
          );
        for (const row of result.rows) {
          const payload = await this.toCalendarExportHearing(
            await this.requireHearing(row.id, ctx),
          );
          await this.preserveExportIdentity(payload, requestedByCanonical.get(row.id) ?? row.id);
          hearings.push(payload);
        }
        if (hearings.length >= total || !result.rows.length) break;
      }
      if (hearings.length !== total)
        throw new BadRequestException(
          'Calendar selection changed during export; refresh and retry',
        );
      const result = buildBulkCalendarExport(hearings, {
        appOrigin,
        dateOnlyReminder: input.dateOnlyReminder,
      });
      for (const id of new Set(input.hearingIds ?? [])) {
        const canonicalId = await resolveCanonicalHearingId(this.prisma, id);
        if (!hearings.some((h) => h.id === canonicalId))
          result.skipped.push({ id, reason: 'Event unavailable in this selection' });
      }
      return result;
    }
    throw new BadRequestException('calendarExportBulk requires hearingIds or a from/to window');
  }

  // ── Hearing Detail V2 composition ────────────────────────────────────────

  /**
   * One request that fills the canonical Hearing Detail route.
   *
   * It COMPOSES the existing contracts rather than forking domain truth, and
   * deliberately does not serialize the transcript body: the detail response
   * carries transcript AVAILABILITY and counts, and the transcript itself
   * stays on its own paginated endpoint.
   */
  async detailV2(
    ctx: TenantContext,
    hearingId: string,
    input: { clientId?: string } = {},
  ): Promise<Record<string, unknown>> {
    const hearing = await this.requireHearing(hearingId, ctx);
    if (input.clientId) await this.assertClientInTenant(ctx.tenantId, input.clientId);

    const [attendance, follow, segmentCount, insightSummary, committee, sources] =
      await Promise.all([
        this.assess(ctx, hearing),
        this.followState(ctx, hearingId),
        this.transcriptSegmentCount(hearingId),
        this.prisma.$queryRawUnsafe<Array<{ insightType: string; count: number }>>(
          `SELECT insight_type AS "insightType", count(*)::int AS count
           FROM public_hearing_insight WHERE hearing_id = $1
           GROUP BY insight_type ORDER BY count DESC`,
          hearingId,
        ),
        hearing.committeeSystemCode
          ? this.committees.committee(hearing.committeeSystemCode, ctx)
          : null,
        this.prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
          `SELECT id, source_url AS "sourceUrl", 'official_transcript' AS kind, title
           FROM official_hearing_transcript WHERE hearing_id = $1`,
          hearingId,
        ),
      ]);

    const relevance = input.clientId
      ? await this.clientRelevance(ctx, hearingId, input.clientId)
      : await this.allClientsRelevance(ctx, hearingId);

    return {
      hearing: {
        id: hearing.id,
        title: hearing.title,
        chamber: hearing.chamber,
        committeeName: hearing.committeeName,
        committeeSystemCode: hearing.committeeSystemCode,
        subcommitteeSystemCode: hearing.subcommitteeSystemCode,
        // A plain calendar-day string, never an instant — see toArchiveResult.
        calendarDate: hearing.date.toISOString().slice(0, 10),
        scheduledStart: hearing.startsAt ? hearing.startsAt.toISOString() : null,
        time: hearing.time,
        timeZone: hearing.timezone,
        location: hearing.location,
        officialPageUrl: hearing.url,
        eventStatus: hearing.eventStatus,
        eventType: hearing.eventType,
        visibility: hearing.visibility,
        witnesses: hearing.witnesses,
      },
      committee,
      followState: follow,
      attendanceState: attendance,
      transcriptSummary: {
        available: segmentCount > 0,
        segmentCount,
        // The body is NOT here. It stays on the paginated transcript endpoint.
        transcriptPath: `/api/legiwatch/live-hearings/events/${encodeURIComponent(hearingId)}/transcript`,
      },
      intelligenceSummary: {
        total: insightSummary.reduce((sum, r) => sum + Number(r.count), 0),
        byType: insightSummary,
      },
      clientRelevance: relevance,
      sources,
      availableActions: this.availableActions(attendance, segmentCount > 0),
      calendarExportPath: `/api/legiwatch/live-hearings/events/${encodeURIComponent(hearingId)}/calendar-export`,
    };
  }

  /**
   * Which actions the UI may offer. Derived from real state so the UI never
   * has to guess, and never offers an action the server would refuse.
   */
  private availableActions(
    attendance: AttendanceAssessment,
    hasTranscript: boolean,
  ): Record<string, boolean> {
    return {
      follow: true,
      attend: attendance.canRequest,
      cancelAttendance: attendance.scheduled,
      askMeri: true,
      createBrief: hasTranscript,
      stageOutreach: hasTranscript,
      saveMoment: hasTranscript,
      saveToClient: true,
      exportCalendar: true,
    };
  }

  // ── W1-5 · notification inbox (generation lives in the lifecycle service) ─

  async notificationInbox(
    ctx: TenantContext,
    input: { unreadOnly?: boolean; page?: number; pageSize?: number },
  ): Promise<Record<string, unknown>> {
    return this.notifications.inbox(ctx, input);
  }

  async markNotificationRead(ctx: TenantContext, id: string): Promise<{ read: boolean }> {
    return this.notifications.markRead(ctx, id);
  }

  // ── shared helpers ───────────────────────────────────────────────────────

  /**
   * Load a canonical hearing or 404.
   *
   * Hearings are GLOBAL public records, so this read is intentionally not
   * tenant-scoped — but nothing tenant-owned is returned from it.
   */
  private async requireHearing(
    hearingId: string,
    ctx: TenantContext,
  ): Promise<CanonicalHearingRow> {
    const hearing = await this.prisma.committeeHearing.findUnique({
      where: { id: hearingId },
      select: {
        id: true,
        geographicJurisdiction: true,
        legislativeSession: true,
        stateCommitteeId: true,
        calendarRevision: true,
        sourceRevision: true,
        calendarSnapshot: true,
        calendarCheckedAt: true,
        calendarCheckState: true,
        timePrecision: true,
        scheduledEnd: true,
        title: true,
        chamber: true,
        committeeName: true,
        committeeSystemCode: true,
        subcommitteeSystemCode: true,
        date: true,
        startsAt: true,
        time: true,
        timezone: true,
        location: true,
        url: true,
        visibility: true,
        eventStatus: true,
        type: true,
        witnesses: true,
        actualEnd: true,
      },
    });
    if (!hearing) throw new NotFoundException(`hearing ${hearingId} not found`);
    if (hearing.geographicJurisdiction && hearing.geographicJurisdiction !== 'US')
      await requireStateCalendar(this.prisma, ctx.tenantId);
    return {
      ...hearing,
      eventType: hearing.type,
    } as CanonicalHearingRow;
  }

  /**
   * Committee identity comes from CongressCommittee, never from hearing rows.
   *
   * Resolved case-insensitively and returns the row's CANONICAL stored
   * `systemCode` — mirroring `CommitteeDirectoryService`'s `normalizeCode()`
   * map lookup, which is why the Committee Room (`GET committees/:id`) has
   * always accepted any casing. Wave 1's follow/intelligence-history routes
   * previously did an exact-case match here, so a caller-cased systemCode that
   * didn't byte-for-byte match the stored casing 404'd even though the same
   * code resolved fine one route over (LW-QA-016/017). Callers MUST use the
   * returned canonical `systemCode` for all downstream reads/writes, not the
   * raw input, so follow rows and intelligence-history queries key off the one
   * casing hearings actually store `committee_system_code` as.
   */
  private async requireCommittee(
    ctx: TenantContext,
    systemCode: string,
  ): Promise<{ systemCode: string }> {
    void ctx;
    const found = await this.prisma.congressCommittee.findFirst({
      where: { systemCode: { equals: systemCode, mode: 'insensitive' } },
      select: { systemCode: true },
    });
    if (!found) throw new NotFoundException(`committee ${systemCode} not found`);
    return found;
  }

  /**
   * A client id in a request body proves nothing about whose tenant it is in.
   * This read runs under the caller's tenant, so another tenant's client comes
   * back empty and 404s — which also avoids confirming that it exists.
   */
  private async assertClientInTenant(
    tenantId: string,
    clientId: string,
  ): Promise<{ id: string; name: string | null }> {
    const found = await this.prisma.withTenant(tenantId, (tx) =>
      tx.client.findFirst({ where: { id: clientId }, select: { id: true, name: true } }),
    );
    if (!found) throw new NotFoundException('Client not found');
    return found;
  }

  /**
   * Validate a whole client list at once and return it de-duplicated.
   *
   * Any id the caller's tenant cannot see 404s the entire request rather than
   * being silently dropped: quietly persisting a subset would leave the user
   * believing they follow a hearing for a client they do not.
   */
  private async resolveClientIds(ctx: TenantContext, clientIds: string[]): Promise<string[]> {
    const unique = [...new Set(clientIds.filter((id) => typeof id === 'string' && id.trim()))];
    if (!unique.length) return [];
    const found = await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.client.findMany({ where: { id: { in: unique } }, select: { id: true } }),
    );
    if (found.length !== unique.length) {
      const visible = new Set(found.map((c) => c.id));
      const missing = unique.filter((id) => !visible.has(id));
      throw new NotFoundException(`Client not found: ${missing.join(', ')}`);
    }
    return unique;
  }

  /**
   * Resolve stored client ids for display.
   *
   * A follow keeps its client ids even after the client is archived or
   * deleted, so this reports what is still resolvable and marks the rest
   * `archived` rather than dropping them. Silently hiding them would make a
   * follow look like it covers fewer clients than it does.
   */
  private async describeClients(
    ctx: TenantContext,
    clientIds: string[],
  ): Promise<Array<{ id: string; name: string | null; archived: boolean }>> {
    if (!clientIds.length) return [];
    const rows = await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.client.findMany({
        where: { id: { in: clientIds } },
        select: { id: true, name: true, status: true },
      }),
    );
    const byId = new Map(rows.map((r) => [r.id, r]));
    return clientIds.map((id) => {
      const row = byId.get(id);
      return {
        id,
        name: row?.name ?? null,
        // Not resolvable under this tenant, or resolvable but not active.
        archived: !row || row.status !== 'active',
      };
    });
  }

  private async transcriptSegmentCount(hearingId: string): Promise<number> {
    const rows = await this.prisma.$queryRawUnsafe<Array<{ count: number }>>(
      `SELECT count(*)::int AS count
       FROM public_hearing_transcript_segment s
       JOIN public_hearing_capture c ON c.id = s.capture_id
       WHERE c.hearing_id = $1`,
      hearingId,
    );
    return rows[0]?.count ?? 0;
  }

  private async assertSegmentInHearing(hearingId: string, segmentId: string): Promise<void> {
    const rows = await this.prisma.$queryRawUnsafe<Array<{ id: string }>>(
      `SELECT s.id FROM public_hearing_transcript_segment s
       JOIN public_hearing_capture c ON c.id = s.capture_id
       WHERE s.id = $1 AND c.hearing_id = $2 LIMIT 1`,
      segmentId,
      hearingId,
    );
    if (!rows.length) {
      throw new BadRequestException(
        `transcript segment ${segmentId} does not belong to hearing ${hearingId}`,
      );
    }
  }

  private async assertInsightInHearing(hearingId: string, insightId: string): Promise<void> {
    const found = await this.prisma.publicHearingInsight.findFirst({
      where: { id: insightId, hearingId },
      select: { id: true },
    });
    if (!found) {
      throw new BadRequestException(
        `intelligence finding ${insightId} does not belong to hearing ${hearingId}`,
      );
    }
  }
}
