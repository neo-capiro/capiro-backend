// ============================================================================
// ⛔ CHANGE-CONTROL: AUTHENTICATION / EMAIL INTEGRATION — APPROVAL REQUIRED
// ----------------------------------------------------------------------------
// Google Workspace analog of microsoft-graph-sync.service.ts. It clones that
// file's proven persistence + concurrency machinery (per-tenant advisory lock,
// sorted contact upsert, manual-association preservation, tx timeout) and swaps
// the provider fetch specifics: Gmail (messages.list backfill + history.list
// incremental) and Google Calendar (events.list + syncToken), via raw fetch.
//
// Reads land in the SAME engagement store as Outlook, discriminated by
// EngagementSource.google, so Radar / Engagement / Intel / Meri surface Google
// data with zero consumer changes. Do NOT edit without Neo's approval.
// ============================================================================
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  AssociationEntityType,
  EngagementConnectionStatus,
  EngagementProvider,
  EngagementSource,
  Prisma,
  type IntegrationConnection,
} from '@prisma/client';
import { deriveMeetingVirtuality, type TenantContext } from '@capiro/shared';
import { PrismaService } from '../../prisma/prisma.service.js';
import { harvestMailContacts } from '../contact-harvest.js';
import { ClientAssociationService } from '../client-association.service.js';
import { GoogleTokenService } from './google-token.service.js';

const GMAIL_BASE_URL = 'https://gmail.googleapis.com/gmail/v1';
const CALENDAR_BASE_URL = 'https://www.googleapis.com/calendar/v3';
const CALENDAR_PAST_DAYS = 365;
const CALENDAR_FUTURE_DAYS = 365;
const MAIL_BACKFILL_DAYS = 365;
const MAX_CALENDAR_PAGES_PER_RUN = 12;
const MAX_MAIL_PAGES_PER_LABEL_PER_RUN = 12;
const GMAIL_PAGE_SIZE = 100;
const CALENDAR_PAGE_SIZE = 250;
// Matches microsoft-graph-sync: each persist txn waits on the per-tenant sync
// advisory lock, then upserts. 20s gives headroom over the 5s interactive-tx
// default. The lock auto-releases on commit/rollback.
const GOOGLE_SYNC_TX_TIMEOUT_MS = 20_000;
// Upper bound on Retry-After-driven retries for ONE request. Without this the
// 429/5xx branch below recursed unboundedly: a provider that keeps returning
// the same retryable status with a small Retry-After could hold a request (and
// its scheduler slot) open forever. 3 attempts = at most ~30s of backoff.
const MAX_RETRYABLE_ATTEMPTS = 3;
// Gmail labels we mirror into the store — the direct analog of the Outlook
// 'inbox' / 'sentitems' mail folders.
// Backfill scope: ALL mail minus junk — spam/trash/drafts excluded, archived
// and custom-label mail included (parity with the M365 folder-tree sync #536;
// Gmail "archive" is just the absence of the INBOX label, so a label-scoped
// sync can never see it).
const MAIL_BACKFILL_SCOPE = 'ALL';
const MAIL_EXCLUDE_QUERY = '-in:spam -in:trash -in:draft';
const EXCLUDED_LABEL_IDS: ReadonlySet<string> = new Set(['SPAM', 'TRASH', 'DRAFT']);

/**
 * Derive the stored folder label + sent-ness from a message's own labelIds
 * (the per-stream label is gone now that one query covers the whole mailbox).
 * Exported for unit tests.
 */
export function gmailFolderFromLabelIds(labelIds: readonly string[] | undefined): {
  folder: 'sent' | 'inbox' | 'archive';
  isSent: boolean;
} {
  const labels = labelIds ?? [];
  const isSent = labels.includes('SENT');
  return {
    folder: isSent ? 'sent' : labels.includes('INBOX') ? 'inbox' : 'archive',
    isSent,
  };
}

interface GoogleSyncState {
  calendar?: {
    syncToken?: string | null;
    pageToken?: string | null;
    updatedAt?: string | null;
    window?: { from: string; to: string };
    lastStats?: SyncStats;
  };
  mail?: {
    historyId?: string | null;
    labels?: Record<string, MailLabelSyncState>;
    updatedAt?: string | null;
    lastStats?: SyncStats;
  };
  webhooks?: {
    configured?: boolean;
    updatedAt?: string | null;
  };
}

interface MailLabelSyncState {
  backfillPageToken?: string | null;
  backfillDone?: boolean;
  updatedAt?: string | null;
}

interface SyncStats {
  scanned: number;
  matched: number;
  skipped: number;
  removed: number;
  // Messages that threw while being fetched/persisted and were skipped rather
  // than aborting the whole run (per-message resilience).
  failed: number;
  pages: number;
  hasMore: boolean;
}

interface SyncResult {
  connectionId: string;
  calendar?: SyncStats;
  mail?: Record<string, SyncStats>;
}

interface GmailListResponse {
  messages?: Array<{ id?: string; threadId?: string }>;
  nextPageToken?: string;
  resultSizeEstimate?: number;
}

interface GmailHistoryResponse {
  history?: Array<{
    id?: string;
    messagesAdded?: Array<{ message?: { id?: string; threadId?: string; labelIds?: string[] } }>;
    messagesDeleted?: Array<{ message?: { id?: string; threadId?: string; labelIds?: string[] } }>;
  }>;
  nextPageToken?: string;
  historyId?: string;
}

interface GmailProfile {
  emailAddress?: string;
  historyId?: string;
}

interface GmailHeader {
  name?: string;
  value?: string;
}

interface GmailMessage {
  id?: string;
  threadId?: string;
  labelIds?: string[];
  snippet?: string;
  internalDate?: string;
  historyId?: string;
  payload?: {
    mimeType?: string;
    headers?: GmailHeader[];
    parts?: Array<{ filename?: string; mimeType?: string }>;
  };
}

interface CalendarDateTime {
  dateTime?: string | null;
  date?: string | null;
  timeZone?: string | null;
}

interface CalendarEvent {
  id?: string;
  status?: string | null;
  summary?: string | null;
  description?: string | null;
  location?: string | null;
  htmlLink?: string | null;
  // Google Meet auto-link (legacy field) + the modern conferenceData block.
  // Present in the API response and stored to raw_jsonb; declared here so the
  // virtuality classifier can read structured join links.
  hangoutLink?: string | null;
  conferenceData?: {
    entryPoints?: Array<{ entryPointType?: string | null; uri?: string | null }> | null;
  } | null;
  start?: CalendarDateTime | null;
  end?: CalendarDateTime | null;
  organizer?: { email?: string | null; displayName?: string | null } | null;
  attendees?: Array<{
    email?: string | null;
    displayName?: string | null;
    responseStatus?: string | null;
    organizer?: boolean | null;
  }>;
}

interface CalendarListResponse {
  items?: CalendarEvent[];
  nextPageToken?: string;
  nextSyncToken?: string;
}

@Injectable()
export class GoogleSyncService {
  private readonly logger = new Logger(GoogleSyncService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly association: ClientAssociationService,
    private readonly googleToken: GoogleTokenService,
  ) {}

  async syncConnection(
    ctx: TenantContext,
    connectionId: string,
    input: { calendar?: boolean; mail?: boolean; reset?: boolean } = {},
  ): Promise<SyncResult> {
    await this.assertConnectionAccess(ctx, connectionId);
    return this.syncConnectionByTenant(ctx.tenantId, connectionId, input);
  }

  /**
   * Tenant-scoped sync without a user context — used by the auto-sync
   * scheduler (EngagementSyncSchedulerService). Success stamps
   * connected/lastSyncAt/lastError:null; invalid_grant flips the connection to
   * needs_configuration with a reconnect message (Testing-mode 7-day token
   * death lands here); other failures go through markSyncError.
   */
  async syncConnectionByTenant(
    tenantId: string,
    connectionId: string,
    input: { calendar?: boolean; mail?: boolean; reset?: boolean } = {},
  ): Promise<SyncResult> {
    try {
      const { connection, token } = await this.googleToken.loadConnection(tenantId, connectionId);
      const accessToken = await this.googleToken.getValidAccessToken(tenantId, connectionId, token);
      const state = readSyncState(connection.syncState);
      const result: SyncResult = { connectionId };

      let calendarSynced = false;
      if (input.calendar !== false) {
        result.calendar = await this.syncCalendar(tenantId, connection, state, accessToken, input);
        calendarSynced = true;
      }
      if (input.mail !== false) {
        try {
          result.mail = await this.syncMail(tenantId, connection, state, accessToken, input);
        } catch (err) {
          // If the calendar leg already succeeded, don't flag the whole
          // connection failed for a TRANSIENT mail-leg error (429/5xx/DB blip):
          // the calendar meetings are already committed, the mail cursor was NOT
          // advanced (syncMail throws before it persists state), and the
          // scheduler retries next cycle — this kills the misleading "failed to
          // sync" banner (and the hidden Sync-now button) that is the reported
          // bug. A PERMANENT failure (revoked scope / forbidden) or a mail-only
          // run still surfaces via markSyncError so the user can act.
          if (!calendarSynced || isPermanentMailFailure(err)) throw err;
          this.logger.warn(
            `Google mail sync hit a transient failure for connection ${connectionId}; calendar synced OK, keeping connection connected (will retry next cycle): ${
              err instanceof Error ? err.message : err
            }`,
          );
        }
      }

      await this.prisma.withTenant(tenantId, (tx) =>
        tx.integrationConnection.update({
          where: { id: connectionId },
          data: {
            syncState: state as Prisma.InputJsonValue,
            status: EngagementConnectionStatus.connected,
            lastSyncAt: new Date(),
            lastError: null,
          },
        }),
      );

      return result;
    } catch (err) {
      await this.markSyncError(tenantId, connectionId, err);
      throw err;
    }
  }

  // ---- Calendar ------------------------------------------------------------

  private async syncCalendar(
    tenantId: string,
    connection: IntegrationConnection,
    state: GoogleSyncState,
    accessToken: string,
    input: { reset?: boolean },
  ): Promise<SyncStats> {
    const stats = emptyStats();
    const current = state.calendar ?? {};
    const window = calendarWindow();
    const useSyncToken = !input.reset && Boolean(current.syncToken);
    let pageToken: string | null = current.pageToken ?? null;
    let syncToken: string | null = null;

    for (let page = 0; page < MAX_CALENDAR_PAGES_PER_RUN; page += 1) {
      stats.pages += 1;
      let response: CalendarListResponse;
      try {
        response = await this.calendarList(accessToken, {
          syncToken: useSyncToken ? (current.syncToken ?? undefined) : undefined,
          window: useSyncToken ? undefined : window,
          pageToken: pageToken ?? undefined,
        });
      } catch (err) {
        // 410 GONE => the syncToken expired; drop it and force a full-window
        // resync on the next run (direct analog of Graph's resync-required).
        if (isGoneError(err) && useSyncToken) {
          state.calendar = {
            syncToken: null,
            pageToken: null,
            updatedAt: new Date().toISOString(),
            window,
            lastStats: stats,
          };
          return stats;
        }
        throw err;
      }

      for (const event of response.items ?? []) {
        stats.scanned += 1;
        const outcome = await this.persistCalendarEvent(
          tenantId,
          connection.id,
          event,
          connection.accountEmail,
        );
        stats.matched += outcome === 'matched' ? 1 : 0;
        stats.skipped += outcome === 'skipped' ? 1 : 0;
        stats.removed += outcome === 'removed' ? 1 : 0;
      }

      pageToken = response.nextPageToken ?? null;
      syncToken = response.nextSyncToken ?? syncToken;
      if (!pageToken) break;
    }

    stats.hasMore = Boolean(pageToken);
    state.calendar = {
      syncToken: syncToken ?? current.syncToken ?? null,
      pageToken,
      updatedAt: new Date().toISOString(),
      window,
      lastStats: stats,
    };
    return stats;
  }

  private async persistCalendarEvent(
    tenantId: string,
    connectionId: string,
    event: CalendarEvent,
    accountEmail?: string | null,
  ): Promise<'matched' | 'skipped' | 'removed'> {
    if (!event.id) return 'skipped';
    if (event.status === 'cancelled') {
      await this.prisma.withTenant(tenantId, (tx) =>
        tx.meeting.updateMany({
          where: { tenantId, source: EngagementSource.google, externalId: event.id },
          data: {
            status: 'deleted',
            metadata: { googleStatus: 'cancelled' } as Prisma.InputJsonValue,
          },
        }),
      );
      return 'removed';
    }

    const startsAt = parseCalendarDateTime(event.start);
    const endsAt = parseCalendarDateTime(event.end);
    if (!startsAt || !endsAt) return 'skipped';

    return this.prisma.withTenantRetry(
      tenantId,
      async (tx) => {
        await lockTenantForEngagementSync(tx, tenantId);
        // Dedupe by normalized email — meeting_attendees has a UNIQUE
        // (meeting_id, email), and a duplicated invitee P2002s the whole sync
        // tx (same bug hit live on the Microsoft path when auto-sync retried
        // stale calendars).
        const attendeeEmails = new Set<string>();
        const attendees = (event.attendees ?? [])
          .map((attendee) => ({
            email: normalizeEmail(attendee.email),
            name: clean(attendee.displayName),
            role: attendee.organizer ? 'organizer' : 'attendee',
            responseStatus: clean(attendee.responseStatus),
          }))
          .filter((attendee) => attendee.email || attendee.name)
          .filter((attendee) => {
            if (!attendee.email) return true;
            if (attendeeEmails.has(attendee.email)) return false;
            attendeeEmails.add(attendee.email);
            return true;
          });
        const organizerEmail = normalizeEmail(event.organizer?.email);
        const existing = await tx.meeting.findUnique({
          where: {
            tenantId_source_externalId: {
              tenantId,
              source: EngagementSource.google,
              externalId: event.id!,
            },
          },
          select: { id: true, clientId: true, isInternal: true, associationSignals: true },
        });
        const ownEmail = accountEmail?.trim().toLowerCase();
        const association = await this.association.associate(tx, tenantId, {
          subject: event.summary,
          body: event.description,
          attendeeEmails: [organizerEmail ?? '', ...attendees.map((a) => a.email ?? '')].filter(
            (e) => e && e !== ownEmail,
          ),
        });
        const hasManualOverride = existing
          ? await hasManualAssociationOverride(
              tx,
              tenantId,
              AssociationEntityType.meeting,
              existing.id,
            )
          : false;
        const clientId = existing?.isInternal
          ? null
          : existing?.clientId &&
              (hasManualOverride || hasManualAssociationSignal(existing.associationSignals))
            ? existing.clientId
            : association.clientId;

        const contactsByEmail = await upsertContacts(tx, tenantId, attendees);
        // Classify virtuality from Google's structured conference fields (Meet
        // hangoutLink / conferenceData video entry point) with a free-text
        // fallback, exactly like the Microsoft sync — without this the meeting
        // is stored non-virtual and the Send Meri button can never appear.
        const virtuality = googleEventVirtuality(event);
        const baseData = {
          clientId,
          connectionId,
          source: EngagementSource.google,
          externalId: event.id!,
          subject: clean(event.summary) || 'Untitled calendar event',
          description: clean(event.description),
          location: clean(event.location),
          startsAt,
          endsAt,
          organizerEmail,
          organizerName: clean(event.organizer?.displayName),
          status: 'scheduled',
          isVirtual: virtuality.isVirtual,
          joinLink: virtuality.joinLink,
          provider: virtuality.provider,
          raw: event as unknown as Prisma.InputJsonValue,
          metadata: {
            webLink: event.htmlLink ?? null,
            provider: 'google_calendar',
          } as Prisma.InputJsonValue,
          associationScore: association.score,
          associationReason: association.reason,
          associationSignals: association.signals as Prisma.InputJsonValue,
        };
        const meeting = existing
          ? await tx.meeting.update({
              where: { id: existing.id },
              data: baseData,
              select: { id: true },
            })
          : await tx.meeting.create({
              data: { tenantId, ...baseData },
              select: { id: true },
            });

        await tx.meetingAttendee.deleteMany({ where: { meetingId: meeting.id } });
        for (const attendee of attendees) {
          await tx.meetingAttendee.create({
            data: {
              tenantId,
              meetingId: meeting.id,
              email: attendee.email,
              name: attendee.name,
              role: attendee.role,
              responseStatus: attendee.responseStatus,
              contactId: attendee.email ? (contactsByEmail.get(attendee.email)?.id ?? null) : null,
            },
          });
        }
        return 'matched' as const;
      },
      { timeoutMs: GOOGLE_SYNC_TX_TIMEOUT_MS },
    );
  }

  // ---- Gmail ---------------------------------------------------------------

  private async syncMail(
    tenantId: string,
    connection: IntegrationConnection,
    state: GoogleSyncState,
    accessToken: string,
    input: { reset?: boolean },
  ): Promise<Record<string, SyncStats>> {
    const mailState = state.mail ?? {};
    const results: Record<string, SyncStats> = {};

    // Incremental path: a stored historyId means we've established a baseline;
    // pull only what changed since. A 404 means the historyId is too old
    // (Gmail history retention is short) — fall back to a full backfill.
    if (!input.reset && mailState.historyId) {
      try {
        const stats = await this.syncMailIncremental(tenantId, connection, mailState, accessToken);
        state.mail = {
          ...mailState,
          updatedAt: new Date().toISOString(),
          lastStats: stats,
        };
        results.incremental = stats;
        return results;
      } catch (err) {
        if (!isNotFoundError(err)) throw err;
        this.logger.warn(
          `Gmail historyId too old for connection ${connection.id}; resetting to full backfill`,
        );
        mailState.historyId = null;
        mailState.labels = {};
      }
    }

    // Backfill path: ONE query over the whole mailbox (minus spam/trash/
    // drafts — archive and custom labels included), capped per run, resuming
    // from the stored pageToken. Once exhausted, capture the current profile
    // historyId as the baseline for future incremental syncs. Pre-widening
    // INBOX/SENT label states are simply ignored; the 'ALL' scope starts its
    // own backfill (upserts are idempotent).
    const labelStates = input.reset ? {} : (mailState.labels ?? {});
    const current = labelStates[MAIL_BACKFILL_SCOPE] ?? {};
    if (current.backfillDone && !input.reset) {
      results[MAIL_BACKFILL_SCOPE] = emptyStats();
    } else {
      const stats = emptyStats();
      let pageToken: string | null = input.reset ? null : (current.backfillPageToken ?? null);
      const query = `after:${Math.floor(addDays(new Date(), -MAIL_BACKFILL_DAYS).getTime() / 1000)} ${MAIL_EXCLUDE_QUERY}`;

      for (let page = 0; page < MAX_MAIL_PAGES_PER_LABEL_PER_RUN; page += 1) {
        stats.pages += 1;
        const list = await this.gmailList(accessToken, {
          query,
          pageToken: pageToken ?? undefined,
        });
        for (const ref of list.messages ?? []) {
          if (!ref.id) continue;
          stats.scanned += 1;
          try {
            const message = await this.gmailGet(accessToken, ref.id);
            const outcome = await this.persistGmailMessage(tenantId, connection.id, message);
            stats.matched += outcome === 'matched' ? 1 : 0;
            stats.skipped += outcome === 'skipped' ? 1 : 0;
          } catch (err) {
            // ONLY skip a genuinely gone message (deleted between list and
            // fetch). Transient/infra errors (429, 5xx, DB pool/timeout) MUST
            // propagate: aborting here leaves the backfill pageToken un-advanced
            // so the scheduler re-fetches this page next cycle. Swallowing them
            // would advance the cursor past never-persisted messages and
            // silently drop them.
            if (!isMessageGoneError(err)) throw err;
            stats.failed += 1;
            this.logger.warn(
              `Gmail message ${ref.id} is gone for connection ${connection.id}; skipping: ${
                err instanceof Error ? err.message : err
              }`,
            );
          }
        }
        pageToken = list.nextPageToken ?? null;
        if (!pageToken) break;
      }

      stats.hasMore = Boolean(pageToken);
      labelStates[MAIL_BACKFILL_SCOPE] = {
        backfillPageToken: pageToken,
        backfillDone: !pageToken,
        updatedAt: new Date().toISOString(),
      };
      results[MAIL_BACKFILL_SCOPE] = stats;
    }

    const allDone = Boolean(labelStates[MAIL_BACKFILL_SCOPE]?.backfillDone);
    let historyId = mailState.historyId ?? null;
    if (allDone) {
      const profile = await this.gmailProfile(accessToken);
      historyId = profile.historyId ?? historyId;
    }

    state.mail = {
      historyId,
      labels: labelStates,
      updatedAt: new Date().toISOString(),
      lastStats: combineStats(Object.values(results)),
    };
    return results;
  }

  private async syncMailIncremental(
    tenantId: string,
    connection: IntegrationConnection,
    mailState: NonNullable<GoogleSyncState['mail']>,
    accessToken: string,
  ): Promise<SyncStats> {
    const stats = emptyStats();
    const startHistoryId = mailState.historyId!;
    const seen = new Set<string>();
    let pageToken: string | null = null;
    let latestHistoryId: string | null = startHistoryId;

    for (let page = 0; page < MAX_MAIL_PAGES_PER_LABEL_PER_RUN; page += 1) {
      stats.pages += 1;
      const response = await this.gmailHistory(accessToken, {
        startHistoryId,
        pageToken: pageToken ?? undefined,
      });
      latestHistoryId = response.historyId ?? latestHistoryId;
      for (const entry of response.history ?? []) {
        for (const added of entry.messagesAdded ?? []) {
          const msg = added.message;
          if (!msg?.id || seen.has(msg.id)) continue;
          // Junk stays out; everything else (inbox, sent, archive, custom
          // labels) mirrors — matching the widened backfill scope.
          const labels = msg.labelIds ?? [];
          if (labels.some((label) => EXCLUDED_LABEL_IDS.has(label))) continue;
          seen.add(msg.id);
          stats.scanned += 1;
          try {
            const message = await this.gmailGet(accessToken, msg.id);
            const outcome = await this.persistGmailMessage(tenantId, connection.id, message);
            stats.matched += outcome === 'matched' ? 1 : 0;
            stats.skipped += outcome === 'skipped' ? 1 : 0;
          } catch (err) {
            // Same rule as the backfill loop: skip only a gone message; let
            // transient/infra errors propagate so historyId is NOT advanced past
            // unpersisted messages (gmailHistory would never re-emit them).
            if (!isMessageGoneError(err)) throw err;
            stats.failed += 1;
            this.logger.warn(
              `Gmail message ${msg.id} is gone for connection ${connection.id}; skipping: ${
                err instanceof Error ? err.message : err
              }`,
            );
          }
        }
      }
      pageToken = response.nextPageToken ?? null;
      if (!pageToken) break;
    }

    stats.hasMore = Boolean(pageToken);
    mailState.historyId = latestHistoryId;
    return stats;
  }

  private async persistGmailMessage(
    tenantId: string,
    connectionId: string,
    message: GmailMessage,
  ): Promise<'matched' | 'skipped'> {
    if (!message.id) return 'skipped';
    // Folder + sent-ness come from the message's own labels now that a single
    // query covers the whole mailbox (there is no per-stream label anymore).
    const { folder, isSent } = gmailFolderFromLabelIds(message.labelIds);
    const headers = message.payload?.headers ?? [];
    const fromParsed = parseAddressList(getHeader(headers, 'From'))[0] ?? null;
    const fromEmail = fromParsed?.email ?? null;
    const toRecipients = parseAddressList(getHeader(headers, 'To'));
    const ccRecipients = parseAddressList(getHeader(headers, 'Cc'));
    const bccRecipients = parseAddressList(getHeader(headers, 'Bcc'));
    const subject = clean(getHeader(headers, 'Subject'));
    const internetMessageId = clean(getHeader(headers, 'Message-ID'));
    const messageDate = parseEpochMs(message.internalDate);
    // Gmail's native threadId is a clean thread key (better than Graph's
    // conversationId heuristics).
    const threadExternalId = message.threadId || internetMessageId || message.id;
    const participantEmails = [
      fromEmail ?? '',
      ...toRecipients.map((r) => r.email),
      ...ccRecipients.map((r) => r.email),
      ...bccRecipients.map((r) => r.email),
    ];
    const hasAttachments = Boolean(
      message.payload?.parts?.some((part) => part.filename && part.filename.length > 0),
    );

    return this.prisma.withTenantRetry(
      tenantId,
      async (tx) => {
        await lockTenantForEngagementSync(tx, tenantId);
        const existingMessage = await tx.mailMessage.findUnique({
          where: {
            tenantId_source_externalId: {
              tenantId,
              source: EngagementSource.google,
              externalId: message.id!,
            },
          },
          include: {
            thread: {
              select: { id: true, clientId: true, lastMessageAt: true, associationSignals: true },
            },
          },
        });
        const existingThread = existingMessage?.thread
          ? existingMessage.thread
          : await tx.mailThread.findUnique({
              where: {
                tenantId_source_externalId: {
                  tenantId,
                  source: EngagementSource.google,
                  externalId: threadExternalId,
                },
              },
              select: { id: true, clientId: true, lastMessageAt: true, associationSignals: true },
            });
        const association = await this.association.associate(tx, tenantId, {
          subject,
          body: message.snippet,
          participantEmails,
        });
        const hasManualOverride = existingThread
          ? await hasManualAssociationOverride(
              tx,
              tenantId,
              AssociationEntityType.mail_thread,
              existingThread.id,
            )
          : false;
        const clientId =
          existingThread?.clientId &&
          (hasManualOverride || hasManualAssociationSignal(existingThread.associationSignals))
            ? existingThread.clientId
            : association.clientId;
        if (!clientId && !existingThread) return 'skipped';

        const participantJson = uniqueParticipants([
          fromEmail ? { email: fromEmail, name: fromParsed?.name ?? null, role: 'from' } : null,
          ...toRecipients.map((r) => ({ ...r, role: 'to' })),
          ...ccRecipients.map((r) => ({ ...r, role: 'cc' })),
          ...bccRecipients.map((r) => ({ ...r, role: 'bcc' })),
        ]);
        const lastMessageAt = laterDate(existingThread?.lastMessageAt ?? null, messageDate);
        const thread = existingThread
          ? await tx.mailThread.update({
              where: { id: existingThread.id },
              data: {
                clientId,
                connectionId,
                subject: subject || 'Untitled email thread',
                snippet: clean(message.snippet),
                participants: participantJson as Prisma.InputJsonValue,
                lastMessageAt,
                raw: message as unknown as Prisma.InputJsonValue,
                metadata: { labels: unique([folder]) } as Prisma.InputJsonValue,
                associationScore: association.score,
                associationReason: association.reason,
                associationSignals: association.signals as Prisma.InputJsonValue,
              },
              select: { id: true },
            })
          : await tx.mailThread.create({
              data: {
                tenantId,
                clientId,
                connectionId,
                source: EngagementSource.google,
                externalId: threadExternalId,
                subject: subject || 'Untitled email thread',
                snippet: clean(message.snippet),
                participants: participantJson as Prisma.InputJsonValue,
                lastMessageAt,
                raw: message as unknown as Prisma.InputJsonValue,
                metadata: { labels: [folder] } as Prisma.InputJsonValue,
                associationScore: association.score,
                associationReason: association.reason,
                associationSignals: association.signals as Prisma.InputJsonValue,
              },
              select: { id: true },
            });

        await tx.mailMessage.upsert({
          where: {
            tenantId_source_externalId: {
              tenantId,
              source: EngagementSource.google,
              externalId: message.id!,
            },
          },
          update: {
            threadId: thread.id,
            connectionId,
            subject,
            fromEmail,
            fromName: fromParsed?.name ?? null,
            toRecipients: toRecipients as unknown as Prisma.InputJsonValue,
            ccRecipients: ccRecipients as unknown as Prisma.InputJsonValue,
            bccRecipients: bccRecipients as unknown as Prisma.InputJsonValue,
            sentAt: isSent ? messageDate : null,
            receivedAt: messageDate,
            bodyText: clean(message.snippet),
            hasAttachments,
            raw: message as unknown as Prisma.InputJsonValue,
            metadata: {
              label: folder,
              folder,
              internetMessageId,
              labelIds: message.labelIds ?? [],
            } as Prisma.InputJsonValue,
          },
          create: {
            tenantId,
            threadId: thread.id,
            connectionId,
            source: EngagementSource.google,
            externalId: message.id!,
            subject,
            fromEmail,
            fromName: fromParsed?.name ?? null,
            toRecipients: toRecipients as unknown as Prisma.InputJsonValue,
            ccRecipients: ccRecipients as unknown as Prisma.InputJsonValue,
            bccRecipients: bccRecipients as unknown as Prisma.InputJsonValue,
            sentAt: isSent ? messageDate : null,
            receivedAt: messageDate,
            bodyText: clean(message.snippet),
            hasAttachments,
            raw: message as unknown as Prisma.InputJsonValue,
            metadata: {
              label: folder,
              folder,
              internetMessageId,
              labelIds: message.labelIds ?? [],
            } as Prisma.InputJsonValue,
          },
        });

        // Everyone on this message becomes a known correspondent. Calendar
        // attendees were already harvested; mail never was, so the contact
        // table knew whoever had been on an invite and nobody the firm had
        // merely emailed. Same data, already stored — no new OAuth scope.
        // ONE insert-only statement: this transaction holds the per-tenant sync
        // advisory lock, and a per-participant read/write loop here is the exact
        // shape that starved the pool on 2026-07-21.
        await harvestMailContacts(tx, tenantId, participantJson, {
          source: 'google',
          clientId,
        });
        return 'matched';
      },
      { timeoutMs: GOOGLE_SYNC_TX_TIMEOUT_MS },
    );
  }

  // ---- HTTP helpers --------------------------------------------------------

  private async calendarList(
    accessToken: string,
    input: { syncToken?: string; window?: { from: string; to: string }; pageToken?: string },
  ): Promise<CalendarListResponse> {
    const params = new URLSearchParams({
      singleEvents: 'true',
      maxResults: String(CALENDAR_PAGE_SIZE),
    });
    if (input.syncToken) {
      params.set('syncToken', input.syncToken);
    } else if (input.window) {
      params.set('timeMin', input.window.from);
      params.set('timeMax', input.window.to);
      params.set('orderBy', 'startTime');
    }
    if (input.pageToken) params.set('pageToken', input.pageToken);
    return this.googleGet<CalendarListResponse>(
      `${CALENDAR_BASE_URL}/calendars/primary/events?${params.toString()}`,
      accessToken,
    );
  }

  private async gmailList(
    accessToken: string,
    input: { labelId?: string; query: string; pageToken?: string },
  ): Promise<GmailListResponse> {
    const params = new URLSearchParams({
      q: input.query,
      maxResults: String(GMAIL_PAGE_SIZE),
    });
    if (input.labelId) params.set('labelIds', input.labelId);
    if (input.pageToken) params.set('pageToken', input.pageToken);
    return this.googleGet<GmailListResponse>(
      `${GMAIL_BASE_URL}/users/me/messages?${params.toString()}`,
      accessToken,
    );
  }

  private async gmailGet(accessToken: string, id: string): Promise<GmailMessage> {
    const params = new URLSearchParams({ format: 'metadata' });
    for (const header of ['From', 'To', 'Cc', 'Bcc', 'Subject', 'Date', 'Message-ID']) {
      params.append('metadataHeaders', header);
    }
    return this.googleGet<GmailMessage>(
      `${GMAIL_BASE_URL}/users/me/messages/${encodeURIComponent(id)}?${params.toString()}`,
      accessToken,
    );
  }

  private async gmailHistory(
    accessToken: string,
    input: { startHistoryId: string; pageToken?: string },
  ): Promise<GmailHistoryResponse> {
    const params = new URLSearchParams({
      startHistoryId: input.startHistoryId,
      historyTypes: 'messageAdded',
    });
    if (input.pageToken) params.set('pageToken', input.pageToken);
    return this.googleGet<GmailHistoryResponse>(
      `${GMAIL_BASE_URL}/users/me/history?${params.toString()}`,
      accessToken,
    );
  }

  private async gmailProfile(accessToken: string): Promise<GmailProfile> {
    return this.googleGet<GmailProfile>(`${GMAIL_BASE_URL}/users/me/profile`, accessToken);
  }

  private async googleGet<T>(url: string, accessToken: string, attempt = 1): Promise<T> {
    const response = await fetch(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
    });

    if (response.status === 429 || response.status >= 500) {
      const retryAfter = Number(response.headers.get('retry-after') ?? '0');
      if (retryAfter > 0 && retryAfter <= 10 && attempt < MAX_RETRYABLE_ATTEMPTS) {
        await sleep(retryAfter * 1000);
        return this.googleGet<T>(url, accessToken, attempt + 1);
      }
    }

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      const message = `Google API GET ${url} failed (${response.status}): ${text.slice(0, 500)}`;
      if (response.status === 404) throw new GoogleApiError(message, 404);
      if (response.status === 410) throw new GoogleApiError(message, 410);
      throw new ServiceUnavailableException(message);
    }
    return (await response.json()) as T;
  }

  // ---- Connection access ----------------------------------------------------

  private async assertConnectionAccess(ctx: TenantContext, connectionId: string): Promise<void> {
    const connection = await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.integrationConnection.findUnique({
        where: { id: connectionId },
        select: { createdByUserId: true, provider: true },
      }),
    );
    if (!connection) throw new NotFoundException('Google connection not found');
    if (connection.provider !== EngagementProvider.google_workspace) {
      throw new BadRequestException('Connection is not a Google Workspace integration');
    }
    if (connection.createdByUserId !== ctx.userId) {
      throw new ForbiddenException('You can only sync your own Google account');
    }
  }

  private async markSyncError(tenantId: string, connectionId: string, err: unknown) {
    const message = err instanceof Error ? err.message : 'Google sync failed';
    await this.prisma.withTenant(tenantId, (tx) =>
      tx.integrationConnection
        .update({
          where: { id: connectionId },
          data: {
            status: EngagementConnectionStatus.error,
            lastError: message.slice(0, 1000),
            nextSyncAt: new Date(Date.now() + 15 * 60 * 1000),
          },
        })
        .catch(() => undefined),
    );
  }
}

// ---- module-private helpers (clone-and-adapt from microsoft-graph-sync) -----

class GoogleApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'GoogleApiError';
  }
}

function isGoneError(err: unknown): boolean {
  return err instanceof GoogleApiError && err.status === 410;
}

function isNotFoundError(err: unknown): boolean {
  return err instanceof GoogleApiError && err.status === 404;
}

/** HTTP status behind a sync error (typed GoogleApiError, or parsed from our
 *  "... failed (503): ..." ServiceUnavailableException messages). */
function mailErrorStatus(err: unknown): number | null {
  if (err instanceof GoogleApiError) return err.status;
  const msg = err instanceof Error ? err.message : '';
  const m = /failed \((\d{3})\)/.exec(msg);
  return m ? Number(m[1]) : null;
}

/** A message that no longer exists (deleted between list and fetch → 404/410) —
 *  safe to skip. EVERY other error must abort the run so the pageToken/historyId
 *  is NOT advanced past messages that were never persisted (which would silently
 *  drop them). */
function isMessageGoneError(err: unknown): boolean {
  const status = mailErrorStatus(err);
  return status === 404 || status === 410;
}

/** A permanent mail-integration failure the user must act on (revoked scope /
 *  forbidden). Surfaced rather than silently retried. Transient errors
 *  (429/5xx/DB blips) are NOT permanent and should keep the connection connected
 *  when the calendar leg already succeeded. */
function isPermanentMailFailure(err: unknown): boolean {
  const status = mailErrorStatus(err);
  if (status === 401) return true;
  if (status === 403) {
    // Gmail returns 403 for BOTH permanent auth (insufficientPermissions /
    // accessNotConfigured) AND transient quota/rate-limit conditions
    // (rateLimitExceeded / userRateLimitExceeded / dailyLimitExceeded). googleGet
    // doesn't retry 403, so only the permanent variety should surface as error;
    // a rate-limit 403 must stay transient or it resurfaces the false banner.
    const body = err instanceof Error ? err.message.toLowerCase() : '';
    return !/(ratelimitexceeded|userratelimitexceeded|dailylimitexceeded|quotaexceeded)/.test(body);
  }
  return false;
}

async function hasManualAssociationOverride(
  tx: Prisma.TransactionClient,
  tenantId: string,
  entityType: AssociationEntityType,
  entityId: string,
) {
  const override = await tx.clientAssociationOverride.findFirst({
    where: { tenantId, entityType, entityId },
    select: { id: true },
  });
  return Boolean(override);
}

function hasManualAssociationSignal(value: Prisma.JsonValue | null | undefined) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return (value as Record<string, unknown>).manual === true;
}

/**
 * Serialize a tenant's engagement sync write transactions cluster-wide via a
 * transaction-scoped Postgres advisory lock. The key is PROVIDER-NEUTRAL
 * (`engagement-sync:<tenant>`, matching microsoft-graph-sync) so a Google sync
 * and an Outlook sync for the same tenant cannot run concurrently — both upsert
 * the same tenant-scoped rows (engagement_contacts on (tenant,email); meetings /
 * mail_threads / mail_messages on (tenant,source,externalId)), so a per-provider
 * key would reintroduce the exact deadlock the Microsoft fix eliminated.
 */
async function lockTenantForEngagementSync(tx: Prisma.TransactionClient, tenantId: string) {
  const lockKey = `engagement-sync:${tenantId}`;
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`;
}

async function upsertContacts(
  tx: Prisma.TransactionClient,
  tenantId: string,
  attendees: Array<{ email: string | null; name: string | null }>,
) {
  // Dedupe by email and upsert in sorted order — consistent lock-ordering on the
  // (tenant,email) unique index (the per-tenant advisory lock is the primary
  // guard; the sort is cheap defense-in-depth). Emails are lowercased by
  // normalizeEmail so JS sort matches the citext collation.
  const names = new Map<string, string | null>();
  for (const attendee of attendees) {
    if (!attendee.email) continue;
    if (!names.has(attendee.email) || (attendee.name && !names.get(attendee.email))) {
      names.set(attendee.email, attendee.name);
    }
  }
  const contacts = new Map<string, { id: string }>();
  for (const email of [...names.keys()].sort()) {
    const name = names.get(email) ?? null;
    const contact = await tx.engagementContact.upsert({
      where: { tenantId_email: { tenantId, email } },
      update: { fullName: name ?? undefined },
      create: { tenantId, email, fullName: name, source: 'google' },
      select: { id: true },
    });
    contacts.set(email, contact);
  }
  return contacts;
}

function readSyncState(value: Prisma.JsonValue): GoogleSyncState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as unknown as GoogleSyncState;
}

function emptyStats(): SyncStats {
  return { scanned: 0, matched: 0, skipped: 0, removed: 0, failed: 0, pages: 0, hasMore: false };
}

function combineStats(stats: SyncStats[]): SyncStats {
  return stats.reduce(
    (total, stat) => ({
      scanned: total.scanned + stat.scanned,
      matched: total.matched + stat.matched,
      skipped: total.skipped + stat.skipped,
      removed: total.removed + stat.removed,
      failed: total.failed + stat.failed,
      pages: total.pages + stat.pages,
      hasMore: total.hasMore || stat.hasMore,
    }),
    emptyStats(),
  );
}

function calendarWindow(): { from: string; to: string } {
  const now = new Date();
  return {
    from: addDays(now, -CALENDAR_PAST_DAYS).toISOString(),
    to: addDays(now, CALENDAR_FUTURE_DAYS).toISOString(),
  };
}

function getHeader(headers: GmailHeader[], name: string): string | null {
  const lower = name.toLowerCase();
  for (const header of headers) {
    if (header.name?.toLowerCase() === lower) return header.value ?? null;
  }
  return null;
}

// Parse an RFC-5322 address-list header ("Alice <a@x.com>, b@y.com") into
// normalized {email, name} entries. Pragmatic (splits on commas; quoted commas
// in display names are rare in practice) — the email regex is the source of
// truth, display name is best-effort.
export function parseAddressList(
  value: string | null,
): Array<{ email: string; name: string | null }> {
  if (!value) return [];
  const out: Array<{ email: string; name: string | null }> = [];
  const seen = new Set<string>();
  for (const partRaw of value.split(',')) {
    const part = partRaw.trim();
    if (!part) continue;
    const angle = part.match(/<([^>]+)>/);
    const rawEmail = angle ? angle[1] : part;
    const email = normalizeEmail(rawEmail);
    if (!email || seen.has(email)) continue;
    seen.add(email);
    let name: string | null = null;
    if (angle) {
      // trim first, THEN strip wrapping quotes: the display name precedes the
      // '<' with a space ("Name" <email>), so quotes must be removed after the
      // trailing space is gone, or the closing quote survives.
      const rawName = part.slice(0, part.indexOf('<')).trim();
      name = clean(rawName.replace(/^"|"$/g, '').trim());
    }
    out.push({ email, name });
  }
  return out;
}

function uniqueParticipants(
  values: Array<{ email: string; name: string | null; role: string } | null>,
) {
  const seen = new Set<string>();
  const participants: Array<{ email: string; name: string | null; role: string }> = [];
  for (const value of values) {
    if (!value || seen.has(value.email)) continue;
    seen.add(value.email);
    participants.push(value);
  }
  return participants;
}

export function parseCalendarDateTime(value?: CalendarDateTime | null): Date | null {
  const text = value?.dateTime ?? value?.date;
  if (!text) return null;
  const normalized = /[tT]/.test(text) ? text : `${text}T00:00:00Z`;
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * Classify a Google calendar event's virtuality (isVirtual / joinLink /
 * provider) via the shared classifier. Prefers Google's structured join link —
 * the legacy `hangoutLink` or the `video` conferenceData entry point — then
 * falls back to a free-text scan of location/description/webLink. Exported so
 * both the live sync and the one-off backfill derive identically (and it stays
 * unit-testable without a DB). Mirrors the Microsoft sync's virtuality step.
 */
export function googleEventVirtuality(event: CalendarEvent) {
  const videoEntry = event.conferenceData?.entryPoints?.find(
    (entry) => entry?.entryPointType === 'video',
  );
  return deriveMeetingVirtuality({
    onlineMeetingUrl: event.hangoutLink ?? videoEntry?.uri ?? null,
    location: clean(event.location),
    description: clean(event.description),
    metadata: { webLink: event.htmlLink ?? null },
  });
}

function parseEpochMs(value?: string | null): Date | null {
  if (!value) return null;
  const ms = Number(value);
  if (Number.isNaN(ms)) return null;
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? null : date;
}

function laterDate(left: Date | null, right: Date | null): Date | null {
  if (!left) return right;
  if (!right) return left;
  return left > right ? left : right;
}

function clean(value?: string | null): string | null {
  const text = value?.trim();
  return text ? text : null;
}

function normalizeEmail(value?: string | null): string | null {
  const email = value?.trim().toLowerCase();
  return email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null;
}

function addDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function unique<T>(values: T[]): T[] {
  return Array.from(new Set(values.filter(Boolean)));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
