import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ConfidentialClientApplication,
  type AuthenticationResult,
  type Configuration,
} from '@azure/msal-node';
import {
  AssociationEntityType,
  EngagementConnectionStatus,
  EngagementProvider,
  EngagementSource,
  Prisma,
  type IntegrationConnection,
  type IntegrationConnectionToken,
} from '@prisma/client';
import { createHmac, randomUUID } from 'node:crypto';
import type { TenantContext } from '@capiro/shared';
import { deriveMeetingVirtuality } from '@capiro/shared';
import type { AppConfig } from '../../config/config.schema.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { harvestMailContacts } from '../contact-harvest.js';
import { ClientAssociationService } from '../client-association.service.js';
import { MICROSOFT_SCOPES, normalizePem } from './microsoft-oauth.service.js';
import {
  MAX_SYNCED_MAIL_FOLDERS,
  selectSyncableFolders,
  type GraphMailFolder,
  type SyncableMailFolder,
} from './microsoft-mail-folders.util.js';
import { TokenCryptoService } from './token-crypto.service.js';

const GRAPH_BASE_URL = 'https://graph.microsoft.com/v1.0';
const TOKEN_REFRESH_SKEW_MS = 5 * 60 * 1000;
const CALENDAR_PAST_DAYS = 365;
const CALENDAR_FUTURE_DAYS = 365;
const MAIL_BACKFILL_DAYS = 365;
const MAX_CALENDAR_PAGES_PER_RUN = 12;
const MAX_MAIL_PAGES_PER_FOLDER_PER_RUN = 12;
const OUTLOOK_SUBSCRIPTION_MS = 6 * 24 * 60 * 60 * 1000;
const SUBSCRIPTION_RENEWAL_SKEW_MS = 24 * 60 * 60 * 1000;
// Budget for BOTH phases of a persist: the unlocked phase-1 association read
// and the phase-2 write txn that waits on the per-tenant sync advisory lock
// (lockTenantForGraphSync) and then upserts. 20s gives headroom over the prior
// 5s interactive-transaction default, which was tripping "Transaction already
// closed" while transactions blocked on the deadlock storm. The advisory lock
// auto-releases on commit/rollback, so it is held only for the short write txn
// (association was moved out of it — see persistGraphEvent/persistGraphMessage).
const GRAPH_SYNC_TX_TIMEOUT_MS = 20_000;

interface MicrosoftSyncState {
  calendar?: {
    cursor?: string | null;
    nextLink?: string | null;
    deltaLink?: string | null;
    updatedAt?: string | null;
    window?: { from: string; to: string };
    lastStats?: SyncStats;
  };
  mail?: {
    cursor?: string | null;
    deltaLink?: string | null;
    updatedAt?: string | null;
    folders?: Record<string, MailFolderSyncState>;
    lastStats?: SyncStats;
  };
  webhooks?: {
    configured?: boolean;
    updatedAt?: string | null;
    subscriptions?: MicrosoftSubscriptionState[];
    lastLifecycleEvent?: string | null;
  };
}

interface MailFolderSyncState {
  cursor?: string | null;
  nextLink?: string | null;
  deltaLink?: string | null;
  updatedAt?: string | null;
  /** Human-readable folder path for id-keyed dynamic folders (debuggability). */
  displayName?: string | null;
  lastStats?: SyncStats;
}

interface MicrosoftSubscriptionState {
  id: string;
  resource: 'me/events' | 'me/messages';
  clientState: string;
  expirationDateTime: string;
  createdAt: string;
}

interface SyncStats {
  scanned: number;
  matched: number;
  skipped: number;
  removed: number;
  // Messages that threw while being persisted and were skipped rather than
  // aborting the whole run (per-message resilience).
  failed: number;
  pages: number;
  hasMore: boolean;
}

interface SyncResult {
  connectionId: string;
  calendar?: SyncStats;
  mail?: Record<string, SyncStats>;
}

interface GraphDeltaResponse<T> {
  value?: T[];
  '@odata.nextLink'?: string;
  '@odata.deltaLink'?: string;
}

interface GraphEmailAddress {
  name?: string | null;
  address?: string | null;
}

interface GraphRecipient {
  emailAddress?: GraphEmailAddress | null;
}

interface GraphEvent {
  id?: string;
  // Cross-mailbox-stable meeting id (Phase 2 groundwork). Default event property.
  iCalUId?: string | null;
  subject?: string | null;
  bodyPreview?: string | null;
  webLink?: string | null;
  isCancelled?: boolean | null;
  // Structured online-meeting fields (Meetings v2 §5). Graph's default event
  // representation on /calendarView(/delta) already returns these, so no $select
  // change is needed (adding a $select to the delta query would risk the existing
  // delta-cycle state). onlineMeeting.joinUrl is the authoritative Teams/… join
  // link when present; deriveMeetingVirtuality falls back to the free-text scan.
  isOnlineMeeting?: boolean | null;
  onlineMeetingProvider?: string | null;
  onlineMeeting?: { joinUrl?: string | null } | null;
  start?: { dateTime?: string | null; timeZone?: string | null } | null;
  end?: { dateTime?: string | null; timeZone?: string | null } | null;
  location?: { displayName?: string | null } | null;
  organizer?: { emailAddress?: GraphEmailAddress | null } | null;
  attendees?: Array<{
    emailAddress?: GraphEmailAddress | null;
    type?: string | null;
    status?: { response?: string | null } | null;
  }>;
  '@removed'?: { reason?: string };
}

interface GraphMessage {
  id?: string;
  conversationId?: string | null;
  internetMessageId?: string | null;
  subject?: string | null;
  bodyPreview?: string | null;
  webLink?: string | null;
  isRead?: boolean | null;
  hasAttachments?: boolean | null;
  receivedDateTime?: string | null;
  sentDateTime?: string | null;
  from?: GraphRecipient | null;
  sender?: GraphRecipient | null;
  toRecipients?: GraphRecipient[];
  ccRecipients?: GraphRecipient[];
  bccRecipients?: GraphRecipient[];
  '@removed'?: { reason?: string };
}

interface GraphSubscriptionResponse {
  id: string;
  resource: 'me/events' | 'me/messages';
  expirationDateTime: string;
  clientState?: string | null;
}

interface GraphNotificationPayload {
  value?: GraphNotification[];
}

interface GraphNotification {
  subscriptionId?: string;
  clientState?: string;
  resource?: string;
  changeType?: string;
  lifecycleEvent?: string;
}

export interface MicrosoftGraphSendMailInput {
  subject: string;
  body: string;
  /** Graph message body type. Defaults to 'Text' for back-compat; outreach
   *  sends HTML drafts as 'HTML' so recipients see formatting. */
  bodyContentType?: 'Text' | 'HTML';
  toRecipients: Array<{ email: string; name?: string | null }>;
  ccRecipients?: Array<{ email: string; name?: string | null }>;
  bccRecipients?: Array<{ email: string; name?: string | null }>;
  /** Inline file attachments (base64 contentBytes), sent as Graph fileAttachments. */
  attachments?: Array<{ name: string; contentType: string; contentBytes: string }>;
}

@Injectable()
export class MicrosoftGraphSyncService {
  private readonly logger = new Logger(MicrosoftGraphSyncService.name);
  private readonly clientId?: string;
  private readonly tenantId?: string;
  private readonly authority: string;
  private readonly thumbprint?: string;
  private readonly privateKey?: string;
  private readonly stateSecret?: Buffer;
  private readonly notificationUrl?: string;
  private msal?: ConfidentialClientApplication;

  constructor(
    private readonly prisma: PrismaService,
    private readonly tokenCrypto: TokenCryptoService,
    private readonly association: ClientAssociationService,
    config: ConfigService<AppConfig, true>,
  ) {
    this.clientId = config.get('MICROSOFT_CLIENT_ID', { infer: true });
    this.tenantId = config.get('MICROSOFT_TENANT_ID', { infer: true });
    this.authority = config.get('MICROSOFT_AUTHORITY', { infer: true });
    this.thumbprint = config.get('MICROSOFT_CERT_THUMBPRINT', { infer: true });
    const rawKey = config.get('MICROSOFT_CERT_PRIVATE_KEY', { infer: true });
    this.privateKey = rawKey ? normalizePem(rawKey) : undefined;
    const stateSecret = config.get('OAUTH_STATE_SECRET', { infer: true });
    this.stateSecret = stateSecret ? Buffer.from(stateSecret, 'utf8') : undefined;
    this.notificationUrl = config.get('MICROSOFT_GRAPH_NOTIFICATION_URL', { infer: true });
  }

  async syncConnection(
    ctx: TenantContext,
    connectionId: string,
    input: { calendar?: boolean; mail?: boolean; reset?: boolean; from?: string; to?: string } = {},
  ): Promise<SyncResult> {
    await this.assertConnectionAccess(ctx, connectionId);
    return this.syncConnectionByTenant(ctx.tenantId, connectionId, input);
  }

  async syncCalendarWindow(
    ctx: TenantContext,
    connectionId: string,
    input: { from: string; to: string },
  ): Promise<SyncStats> {
    await this.assertConnectionAccess(ctx, connectionId);
    const window = calendarWindow(input.from, input.to);

    try {
      const { connection, token } = await this.loadConnection(ctx.tenantId, connectionId);
      const accessToken = await this.getValidAccessToken(ctx.tenantId, connectionId, token);
      const stats = emptyStats();
      let nextUrl = calendarViewUrl(window.from, window.to);

      for (let page = 0; page < MAX_CALENDAR_PAGES_PER_RUN && nextUrl; page += 1) {
        stats.pages += 1;
        const response = await this.graphGet<GraphDeltaResponse<GraphEvent>>(nextUrl, accessToken, {
          Prefer: 'outlook.timezone="UTC", odata.maxpagesize=50',
        });
        for (const event of response.value ?? []) {
          stats.scanned += 1;
          const outcome = await this.persistGraphEvent(
            ctx.tenantId,
            connection.id,
            event,
            connection.accountEmail,
          );
          stats.matched += outcome === 'matched' ? 1 : 0;
          stats.skipped += outcome === 'skipped' ? 1 : 0;
          stats.removed += outcome === 'removed' ? 1 : 0;
        }
        nextUrl = response['@odata.nextLink'] ?? '';
        if (!nextUrl) break;
      }

      stats.hasMore = Boolean(nextUrl);
      await this.prisma.withTenant(ctx.tenantId, (tx) =>
        tx.integrationConnection.update({
          where: { id: connectionId },
          data: {
            status: EngagementConnectionStatus.connected,
            lastSyncAt: new Date(),
            lastError: null,
          },
        }),
      );
      return stats;
    } catch (err) {
      await this.markSyncError(ctx.tenantId, connectionId, err);
      throw err;
    }
  }

  async configureSubscriptions(ctx: TenantContext, connectionId: string) {
    await this.assertConnectionAccess(ctx, connectionId);
    return this.configureSubscriptionsByTenant(ctx.tenantId, connectionId);
  }

  /** Whether webhook subscriptions can be managed at all in this deployment. */
  get subscriptionsConfigurable(): boolean {
    return Boolean(this.notificationUrl);
  }

  /**
   * Tenant-scoped subscription ensure/renew — reuses subscriptions with >24h
   * left and (re)creates the rest. Called at connect time (via the ctx
   * wrapper) and by the auto-sync scheduler each cycle: renewal used to happen
   * ONLY at connect, so 6-day Graph subscriptions expired and webhook-driven
   * connections went permanently silent (no webhook → no sync → no renewal).
   */
  async configureSubscriptionsByTenant(tenantId: string, connectionId: string) {
    if (!this.notificationUrl) {
      throw new ServiceUnavailableException('MICROSOFT_GRAPH_NOTIFICATION_URL is not configured');
    }
    this.assertTokenRefreshConfigured();

    const { connection, token } = await this.loadConnection(tenantId, connectionId);
    const accessToken = await this.getValidAccessToken(tenantId, connectionId, token);
    const state = readSyncState(connection.syncState);
    const existing = state.webhooks?.subscriptions ?? [];
    const now = Date.now();
    const createdAt = new Date().toISOString();
    const subscriptions: MicrosoftSubscriptionState[] = [];

    for (const resource of ['me/events', 'me/messages'] as const) {
      const reusable = existing.find(
        (subscription) =>
          subscription.resource === resource &&
          new Date(subscription.expirationDateTime).getTime() > now + SUBSCRIPTION_RENEWAL_SKEW_MS,
      );
      if (reusable) {
        subscriptions.push(reusable);
        continue;
      }

      const clientState = this.signClientState(tenantId, connectionId, resource);
      const expirationDateTime = new Date(Date.now() + OUTLOOK_SUBSCRIPTION_MS).toISOString();
      const created = await this.graphPost<GraphSubscriptionResponse>(
        '/subscriptions',
        accessToken,
        {
          changeType: 'created,updated,deleted',
          notificationUrl: this.notificationUrl,
          lifecycleNotificationUrl: this.notificationUrl,
          resource,
          expirationDateTime,
          clientState,
        },
      );

      subscriptions.push({
        id: created.id,
        resource,
        clientState,
        expirationDateTime: created.expirationDateTime,
        createdAt,
      });
    }

    state.webhooks = {
      configured: true,
      updatedAt: new Date().toISOString(),
      subscriptions,
      lastLifecycleEvent: state.webhooks?.lastLifecycleEvent ?? null,
    };

    await this.prisma.withTenant(tenantId, (tx) =>
      tx.integrationConnection.update({
        where: { id: connectionId },
        data: { syncState: state as Prisma.InputJsonValue, lastError: null },
      }),
    );

    return { configured: true, subscriptions };
  }

  async sendMail(ctx: TenantContext, connectionId: string, input: MicrosoftGraphSendMailInput) {
    await this.assertConnectionAccess(ctx, connectionId);
    const { token } = await this.loadConnection(ctx.tenantId, connectionId);
    const accessToken = await this.getValidAccessToken(ctx.tenantId, connectionId, token);
    const toGraphRecipients = (list: Array<{ email: string; name?: string | null }> | undefined) =>
      (list ?? []).map((recipient) => ({
        emailAddress: {
          address: recipient.email,
          ...(recipient.name ? { name: recipient.name } : {}),
        },
      }));

    await this.graphPostNoContent('/me/sendMail', accessToken, {
      message: {
        subject: input.subject,
        body: {
          contentType: input.bodyContentType ?? 'Text',
          content: input.body,
        },
        toRecipients: toGraphRecipients(input.toRecipients),
        ...(input.ccRecipients?.length
          ? { ccRecipients: toGraphRecipients(input.ccRecipients) }
          : {}),
        ...(input.bccRecipients?.length
          ? { bccRecipients: toGraphRecipients(input.bccRecipients) }
          : {}),
        ...(input.attachments?.length
          ? {
              attachments: input.attachments.map((a) => ({
                '@odata.type': '#microsoft.graph.fileAttachment',
                name: a.name,
                contentType: a.contentType,
                contentBytes: a.contentBytes,
              })),
            }
          : {}),
      },
      saveToSentItems: true,
    });
    return { ok: true };
  }

  async handleNotifications(payload: GraphNotificationPayload) {
    const notifications = payload.value ?? [];
    if (!notifications.length) return { accepted: 0, scheduledSyncs: 0 };

    const connections = await this.prisma.withSystem((tx) =>
      tx.integrationConnection.findMany({
        where: {
          provider: EngagementProvider.microsoft_365,
          status: EngagementConnectionStatus.connected,
        },
        select: { id: true, tenantId: true, syncState: true },
      }),
    );

    let accepted = 0;
    // Graph delivers a batch of change notifications (often dozens for a single
    // mailbox at first connect). Coalesce them so each (connection, resource)
    // pair triggers exactly one sync instead of one per notification — running
    // N identical syncs concurrently wastes Graph quota and lets their
    // per-event transactions deadlock against each other.
    const pendingSyncs = new Map<
      string,
      { tenantId: string; connectionId: string; syncInput: { calendar: boolean; mail: boolean } }
    >();
    for (const notification of notifications) {
      const subscriptionId = notification.subscriptionId;
      if (!subscriptionId) continue;
      const match = findSubscriptionConnection(connections, subscriptionId);
      if (!match) continue;
      if (notification.clientState !== match.subscription.clientState) {
        this.logger.warn(`Rejected Graph notification with invalid clientState: ${subscriptionId}`);
        continue;
      }

      accepted += 1;
      if (notification.lifecycleEvent) {
        await this.recordLifecycleEvent(
          match.tenantId,
          match.connectionId,
          notification.lifecycleEvent,
        );
        continue;
      }

      const isCalendar = match.subscription.resource === 'me/events';
      const key = `${match.connectionId}:${isCalendar ? 'calendar' : 'mail'}`;
      if (!pendingSyncs.has(key)) {
        pendingSyncs.set(key, {
          tenantId: match.tenantId,
          connectionId: match.connectionId,
          syncInput: { calendar: isCalendar, mail: !isCalendar },
        });
      }
    }

    for (const { tenantId, connectionId, syncInput } of pendingSyncs.values()) {
      void this.syncConnectionByTenant(tenantId, connectionId, syncInput).catch((err) => {
        this.logger.error(
          `Graph notification sync failed for connection ${connectionId}: ${(err as Error).message}`,
        );
      });
    }

    return { accepted, scheduledSyncs: pendingSyncs.size };
  }

  /**
   * Tenant-scoped sync without a user context — the entry point for the
   * webhook path and the auto-sync scheduler (EngagementSyncSchedulerService).
   * Success stamps connected/lastSyncAt/lastError:null; failure goes through
   * markSyncError (status=error + a 15-minute nextSyncAt retry hint).
   */
  async syncConnectionByTenant(
    tenantId: string,
    connectionId: string,
    input: { calendar?: boolean; mail?: boolean; reset?: boolean; from?: string; to?: string } = {},
  ): Promise<SyncResult> {
    try {
      const { connection, token } = await this.loadConnection(tenantId, connectionId);
      const accessToken = await this.getValidAccessToken(tenantId, connectionId, token);
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
          // calendar meetings are committed, the mail cursor was NOT advanced
          // (syncMail throws before persisting state), and the scheduler retries
          // next cycle — killing the misleading "failed to sync" banner. A
          // PERMANENT failure (revoked scope / forbidden / mailbox-not-enabled,
          // which the outer catch routes to needs_configuration) or a mail-only
          // run still surfaces via re-throw.
          if (!calendarSynced || isPermanentMailFailure(err)) throw err;
          this.logger.warn(
            `Microsoft mail sync hit a transient failure for connection ${connectionId}; calendar synced OK, keeping connection connected (will retry next cycle): ${
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
      // A signed-in account with NO Exchange Online mailbox (e.g. a bare
      // .onmicrosoft.com admin) fails this way forever — that needs a human
      // with a licensed mailbox, not a 15-minute retry loop.
      if (err instanceof Error && err.message.includes('MailboxNotEnabledForRESTAPI')) {
        await this.prisma.withTenant(tenantId, (tx) =>
          tx.integrationConnection
            .update({
              where: { id: connectionId },
              data: {
                status: EngagementConnectionStatus.needs_configuration,
                lastError:
                  'This Microsoft account has no Exchange Online mailbox — reconnect with a licensed mailbox account.',
              },
            })
            .catch(() => undefined),
        );
        throw err;
      }
      await this.markSyncError(tenantId, connectionId, err);
      throw err;
    }
  }

  private async syncCalendar(
    tenantId: string,
    connection: IntegrationConnection,
    state: MicrosoftSyncState,
    accessToken: string,
    input: { reset?: boolean; from?: string; to?: string },
  ): Promise<SyncStats> {
    const stats = emptyStats();
    const current = state.calendar ?? {};
    const window = calendarWindow(input.from, input.to);
    let usedStoredCursor =
      !input.reset && Boolean(current.nextLink || current.cursor || current.deltaLink);
    let nextUrl = usedStoredCursor
      ? (current.nextLink || current.cursor || current.deltaLink)!
      : calendarDeltaUrl(window.from, window.to);
    let deltaLink: string | null = null;

    for (let page = 0; page < MAX_CALENDAR_PAGES_PER_RUN && nextUrl; page += 1) {
      stats.pages += 1;
      let response: GraphDeltaResponse<GraphEvent>;
      try {
        response = await this.graphGet<GraphDeltaResponse<GraphEvent>>(nextUrl, accessToken, {
          Prefer: 'outlook.timezone="UTC", odata.maxpagesize=50',
        });
      } catch (err) {
        // Graph delta state expires (410 SyncStateNotFound) on streams that
        // sat idle for weeks — restart from a fresh delta URL instead of
        // failing this connection's sync forever (Gmail's historyId-too-old
        // reset is the same pattern). One reset per run: a fresh URL 410ing
        // again is a real error.
        if (usedStoredCursor && isGraphSyncStateGone(err)) {
          this.logger.warn(
            `calendar delta state expired for connection ${connection.id}; restarting from a fresh delta window`,
          );
          usedStoredCursor = false;
          nextUrl = calendarDeltaUrl(window.from, window.to);
          deltaLink = null;
          continue;
        }
        throw err;
      }
      for (const event of response.value ?? []) {
        stats.scanned += 1;
        const outcome = await this.persistGraphEvent(
          tenantId,
          connection.id,
          event,
          connection.accountEmail,
        );
        stats.matched += outcome === 'matched' ? 1 : 0;
        stats.skipped += outcome === 'skipped' ? 1 : 0;
        stats.removed += outcome === 'removed' ? 1 : 0;
      }
      nextUrl = response['@odata.nextLink'] ?? '';
      deltaLink = response['@odata.deltaLink'] ?? null;
      if (!nextUrl) break;
    }

    stats.hasMore = Boolean(nextUrl);
    state.calendar = {
      cursor: nextUrl || deltaLink || current.deltaLink || null,
      nextLink: nextUrl || null,
      deltaLink: deltaLink ?? current.deltaLink ?? null,
      updatedAt: new Date().toISOString(),
      window,
      lastStats: stats,
    };
    return stats;
  }

  private async syncMail(
    tenantId: string,
    connection: IntegrationConnection,
    state: MicrosoftSyncState,
    accessToken: string,
    input: { reset?: boolean },
  ): Promise<Record<string, SyncStats>> {
    // Legacy pair first (well-known-name keys so pre-existing delta links
    // survive), then the enumerated folder tree: custom/client subfolders and
    // Archive included, junk/deleted/drafts/outbox excluded. Enumeration
    // failure falls back to the legacy pair — mail sync must never break on a
    // folder-listing hiccup.
    const legacyFolders: SyncableMailFolder[] = [
      { key: 'inbox', pathSegment: 'inbox', displayPath: 'inbox' },
      { key: 'sentitems', pathSegment: 'sentitems', displayPath: 'sentitems' },
    ];
    const enumeration = await this.listSyncableMailFolders(connection.id, accessToken);
    const folders = [...legacyFolders, ...enumeration.folders];
    const results: Record<string, SyncStats> = {};
    const mailState = state.mail ?? {};
    const folderStates = mailState.folders ?? {};

    for (const folder of folders) {
      const current = folderStates[folder.key] ?? {};
      const stats = emptyStats();
      let usedStoredCursor =
        !input.reset && Boolean(current.nextLink || current.cursor || current.deltaLink);
      let nextUrl = usedStoredCursor
        ? (current.nextLink || current.cursor || current.deltaLink)!
        : mailDeltaUrl(folder.pathSegment, addDays(new Date(), -MAIL_BACKFILL_DAYS));
      let deltaLink: string | null = null;

      for (let page = 0; page < MAX_MAIL_PAGES_PER_FOLDER_PER_RUN && nextUrl; page += 1) {
        stats.pages += 1;
        let response: GraphDeltaResponse<GraphMessage>;
        try {
          response = await this.graphGet<GraphDeltaResponse<GraphMessage>>(nextUrl, accessToken, {
            Prefer: 'odata.maxpagesize=50',
          });
        } catch (err) {
          // Expired delta state (410 SyncStateNotFound) — restart this
          // folder's stream from a fresh backfill window (see syncCalendar).
          if (usedStoredCursor && isGraphSyncStateGone(err)) {
            this.logger.warn(
              `mail delta state expired for connection ${connection.id} folder ${folder.displayPath}; restarting from a fresh delta window`,
            );
            usedStoredCursor = false;
            nextUrl = mailDeltaUrl(folder.pathSegment, addDays(new Date(), -MAIL_BACKFILL_DAYS));
            deltaLink = null;
            continue;
          }
          throw err;
        }
        for (const message of response.value ?? []) {
          stats.scanned += 1;
          try {
            const outcome = await this.persistGraphMessage(
              tenantId,
              connection.id,
              folder.displayPath,
              message,
            );
            stats.matched += outcome === 'matched' ? 1 : 0;
            stats.skipped += outcome === 'skipped' ? 1 : 0;
            stats.removed += outcome === 'removed' ? 1 : 0;
          } catch (err) {
            // ONLY skip a genuinely gone message (404/410). Transient/infra
            // errors (DB pool/timeout, 429, 5xx) MUST propagate so the delta
            // cursor is NOT advanced past never-persisted messages (Graph delta
            // won't re-emit them → silent drop). Aborting lets the scheduler
            // retry from the un-advanced deltaLink.
            if (!isMessageGoneError(err)) throw err;
            stats.failed += 1;
            this.logger.warn(
              `Graph message ${message?.id ?? '(no id)'} is gone for connection ${connection.id}; skipping: ${
                err instanceof Error ? err.message : err
              }`,
            );
          }
        }
        nextUrl = response['@odata.nextLink'] ?? '';
        deltaLink = response['@odata.deltaLink'] ?? null;
        if (!nextUrl) break;
      }

      stats.hasMore = Boolean(nextUrl);
      folderStates[folder.key] = {
        cursor: nextUrl || deltaLink || current.deltaLink || null,
        nextLink: nextUrl || null,
        deltaLink: deltaLink ?? current.deltaLink ?? null,
        updatedAt: new Date().toISOString(),
        displayName: folder.displayPath,
        lastStats: stats,
      };
      results[folder.key] = stats;
    }

    // Prune state for folders that no longer exist (deleted/renamed/emptied) —
    // only when enumeration succeeded, so a transient listing failure can't
    // wipe delta links. The legacy keys always survive.
    if (enumeration.enumerated) {
      const live = new Set(folders.map((folder) => folder.key));
      for (const key of Object.keys(folderStates)) {
        if (!live.has(key)) delete folderStates[key];
      }
    }

    state.mail = {
      cursor: Object.values(folderStates).find((folder) => folder.nextLink)?.nextLink ?? null,
      deltaLink: null,
      updatedAt: new Date().toISOString(),
      folders: folderStates,
      lastStats: combineStats(Object.values(results)),
    };
    return results;
  }

  /**
   * Enumerate the mailbox's folder tree (paginated, recursing into child
   * folders) and select the dynamic set to sync — everything except the noise
   * well-known folders and their descendants; inbox/sentitems stay on their
   * legacy state keys. Returns enumerated:false on any Graph failure so
   * syncMail falls back to the legacy pair instead of breaking mail sync.
   */
  private async listSyncableMailFolders(
    connectionId: string,
    accessToken: string,
  ): Promise<{ folders: SyncableMailFolder[]; enumerated: boolean }> {
    const FOLDER_SELECT =
      '$select=id,displayName,parentFolderId,childFolderCount,totalItemCount&$top=100';
    try {
      const wellKnownId = async (name: string): Promise<string | null> => {
        try {
          const folder = await this.graphGet<GraphMailFolder>(
            `/me/mailFolders/${name}?$select=id`,
            accessToken,
          );
          return folder.id ?? null;
        } catch {
          // Some well-known folders 404 on some mailbox types — treat as absent.
          return null;
        }
      };
      const [inboxId, sentItemsId, ...noiseRootIds] = await Promise.all([
        wellKnownId('inbox'),
        wellKnownId('sentitems'),
        wellKnownId('junkemail'),
        wellKnownId('deleteditems'),
        wellKnownId('drafts'),
        wellKnownId('outbox'),
        wellKnownId('conversationhistory'),
      ]);

      const all: GraphMailFolder[] = [];
      const childQueue: string[] = [];
      const collectPages = async (firstUrl: string) => {
        let url: string | null = firstUrl;
        while (url && all.length < 2000) {
          const page: { value?: GraphMailFolder[]; '@odata.nextLink'?: string } =
            await this.graphGet(url, accessToken);
          for (const folder of page.value ?? []) {
            all.push(folder);
            if ((folder.childFolderCount ?? 0) > 0 && folder.id) childQueue.push(folder.id);
          }
          url = page['@odata.nextLink'] ?? null;
        }
      };
      await collectPages(`/me/mailFolders?${FOLDER_SELECT}`);
      while (childQueue.length > 0 && all.length < 2000) {
        const parentId = childQueue.shift()!;
        await collectPages(
          `/me/mailFolders/${encodeURIComponent(parentId)}/childFolders?${FOLDER_SELECT}`,
        );
      }

      const { folders, dropped } = selectSyncableFolders({
        all,
        noiseRootIds,
        inboxId,
        sentItemsId,
        cap: MAX_SYNCED_MAIL_FOLDERS,
      });
      if (dropped > 0) {
        this.logger.warn(
          `mail folder cap for connection ${connectionId}: syncing ${folders.length} dynamic folders, dropped ${dropped} smaller ones`,
        );
      }
      this.logger.log(
        `mail folder enumeration for connection ${connectionId}: ${folders.length} dynamic folders (+inbox/sentitems)`,
      );
      return { folders, enumerated: true };
    } catch (error) {
      this.logger.warn(
        `mail folder enumeration failed for connection ${connectionId} — syncing inbox+sentitems only: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return { folders: [], enumerated: false };
    }
  }

  private async persistGraphEvent(
    tenantId: string,
    connectionId: string,
    event: GraphEvent,
    accountEmail?: string | null,
  ): Promise<'matched' | 'skipped' | 'removed'> {
    if (!event.id) return 'skipped';
    if (event['@removed']) {
      await this.prisma.withTenant(tenantId, (tx) =>
        tx.meeting.updateMany({
          where: { tenantId, source: EngagementSource.outlook, externalId: event.id },
          data: {
            status: 'deleted',
            metadata: { graphRemoved: event['@removed'] } as Prisma.InputJsonValue,
          },
        }),
      );
      return 'removed';
    }

    const startsAt = parseGraphDateTime(event.start?.dateTime);
    const endsAt = parseGraphDateTime(event.end?.dateTime);
    if (!startsAt || !endsAt) return 'skipped';

    // Dedupe by normalized email: Graph invites can list the same address twice
    // (required+optional, DL expansion), and meeting_attendees has a UNIQUE
    // (meeting_id, email) — the second create() P2002'd the WHOLE sync tx,
    // freezing the mailbox (calendar syncs before mail). Hit live by 3 mailboxes
    // when auto-sync retried weeks-stale calendars.
    const attendeeEmails = new Set<string>();
    const attendees = (event.attendees ?? [])
      .map((attendee) => ({
        email: normalizeEmail(attendee.emailAddress?.address),
        name: clean(attendee.emailAddress?.name),
        role: clean(attendee.type),
        responseStatus: clean(attendee.status?.response),
      }))
      .filter((attendee) => attendee.email || attendee.name)
      .filter((attendee) => {
        if (!attendee.email) return true;
        if (attendeeEmails.has(attendee.email)) return false;
        attendeeEmails.add(attendee.email);
        return true;
      });
    const organizerEmail = normalizeEmail(event.organizer?.emailAddress?.address);
    const ownEmail = accountEmail?.trim().toLowerCase();

    // Phase 1 — client association, computed OUTSIDE the advisory lock. This is
    // the expensive read (a full active-client scan + attendee-history join +
    // in-JS scoring); running it inside lockTenantForGraphSync serialized it per
    // tenant and left ~5 sessions permanently blocked on pg_advisory_xact_lock,
    // each pinning a Prisma pool connection — starving the pool so unrelated
    // endpoints 500'd with P2028. Association is best-effort (advisory client
    // link), so it need not be atomic with the write below.
    const association = await this.prisma.withTenant(
      tenantId,
      (tx) =>
        this.association.associate(tx, tenantId, {
          subject: event.subject,
          body: event.bodyPreview,
          attendeeEmails: [
            organizerEmail ?? '',
            ...attendees.map((attendee) => attendee.email ?? ''),
          ].filter((e) => e && e !== ownEmail),
        }),
      { timeoutMs: GRAPH_SYNC_TX_TIMEOUT_MS },
    );

    // Phase 2 — the advisory lock is now held ONLY across the writes. It still
    // serializes this tenant's Graph-sync writes on the shared (tenant,email)
    // contacts and (tenant,source,externalId) rows, so the deadlock guard the
    // lock exists for is intact; it is just no longer held across association.
    // `existing` is re-read here (under the lock) so the create/update decision
    // stays serialized and race-free.
    return this.prisma.withTenantRetry(
      tenantId,
      async (tx) => {
        await lockTenantForGraphSync(tx, tenantId);
        const existing = await tx.meeting.findUnique({
          where: {
            tenantId_source_externalId: {
              tenantId,
              source: EngagementSource.outlook,
              externalId: event.id!,
            },
          },
          select: { id: true, clientId: true, isInternal: true, associationSignals: true },
        });
        const hasManualOverride = existing
          ? await hasManualAssociationOverride(
              tx,
              tenantId,
              AssociationEntityType.meeting,
              existing.id,
            )
          : false;
        // Meetings the user marked internal stay client-less; never re-link them.
        // Otherwise respect manual/explicit associations, but let stale auto-links
        // be corrected.
        const clientId = existing?.isInternal
          ? null
          : existing?.clientId &&
              (hasManualOverride || hasManualAssociationSignal(existing.associationSignals))
            ? existing.clientId
            : association.clientId;

        const contactsByEmail = await upsertContacts(tx, tenantId, attendees);
        // Virtual-meeting classification derived once at sync time (Meetings v2
        // §5): prefer Graph's structured onlineMeeting.joinUrl, else scan the
        // webLink/location/invite body. Stored on the Meeting so the UI and the
        // Meri-eligibility gate read a column instead of re-parsing free text.
        const virtuality = deriveMeetingVirtuality({
          location: clean(event.location?.displayName),
          description: clean(event.bodyPreview),
          metadata: { webLink: event.webLink ?? null },
          onlineMeetingUrl: event.onlineMeeting?.joinUrl ?? null,
          isOnlineMeeting: event.isOnlineMeeting ?? null,
          onlineMeetingProvider: event.onlineMeetingProvider ?? null,
        });
        const baseData = {
          clientId,
          connectionId,
          source: EngagementSource.outlook,
          externalId: event.id!,
          // Phase 2 groundwork: stored (dormant) for future cross-mailbox grouping.
          iCalUId: event.iCalUId ?? null,
          subject: clean(event.subject) || 'Untitled calendar event',
          description: clean(event.bodyPreview),
          location: clean(event.location?.displayName),
          startsAt,
          endsAt,
          organizerEmail,
          organizerName: clean(event.organizer?.emailAddress?.name),
          status: event.isCancelled ? 'cancelled' : 'scheduled',
          isVirtual: virtuality.isVirtual,
          joinLink: virtuality.joinLink,
          provider: virtuality.provider,
          raw: event as Prisma.InputJsonValue,
          metadata: {
            webLink: event.webLink ?? null,
            provider: 'microsoft_graph',
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
      { timeoutMs: GRAPH_SYNC_TX_TIMEOUT_MS },
    );
  }

  private async persistGraphMessage(
    tenantId: string,
    connectionId: string,
    folder: string,
    message: GraphMessage,
  ): Promise<'matched' | 'skipped' | 'removed'> {
    if (!message.id) return 'skipped';
    if (message['@removed']) {
      await this.prisma.withTenant(tenantId, (tx) =>
        tx.mailMessage.updateMany({
          where: { tenantId, source: EngagementSource.outlook, externalId: message.id },
          data: {
            metadata: {
              graphRemoved: message['@removed'],
              folder,
            } as Prisma.InputJsonValue,
          },
        }),
      );
      return 'removed';
    }

    const from = message.from?.emailAddress ?? message.sender?.emailAddress;
    const fromEmail = normalizeEmail(from?.address);
    const toRecipients = recipients(message.toRecipients);
    const ccRecipients = recipients(message.ccRecipients);
    const bccRecipients = recipients(message.bccRecipients);
    const participantEmails = [
      fromEmail ?? '',
      ...toRecipients.map((recipient) => recipient.email),
      ...ccRecipients.map((recipient) => recipient.email),
      ...bccRecipients.map((recipient) => recipient.email),
    ];
    const messageDate = parseGraphDateTime(message.receivedDateTime ?? message.sentDateTime);
    const threadExternalId = message.conversationId || message.internetMessageId || message.id;

    // Phase 1 — client association, computed OUTSIDE the advisory lock (same
    // fix as persistGraphEvent): the expensive active-client scan + scoring must
    // not run while holding lockTenantForGraphSync, which pinned pool
    // connections on pg_advisory_xact_lock and 500'd unrelated endpoints (P2028).
    const association = await this.prisma.withTenant(
      tenantId,
      (tx) =>
        this.association.associate(tx, tenantId, {
          subject: message.subject,
          body: message.bodyPreview,
          participantEmails,
        }),
      { timeoutMs: GRAPH_SYNC_TX_TIMEOUT_MS },
    );

    // Phase 2 — advisory lock held ONLY across the writes (deadlock guard on the
    // shared (tenant,email) / (tenant,source,externalId) rows stays intact).
    return this.prisma.withTenantRetry(
      tenantId,
      async (tx) => {
        await lockTenantForGraphSync(tx, tenantId);
        const existingMessage = await tx.mailMessage.findUnique({
          where: {
            tenantId_source_externalId: {
              tenantId,
              source: EngagementSource.outlook,
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
                  source: EngagementSource.outlook,
                  externalId: threadExternalId,
                },
              },
              select: { id: true, clientId: true, lastMessageAt: true, associationSignals: true },
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
          fromEmail ? { email: fromEmail, name: clean(from?.name), role: 'from' } : null,
          ...toRecipients.map((recipient) => ({ ...recipient, role: 'to' })),
          ...ccRecipients.map((recipient) => ({ ...recipient, role: 'cc' })),
          ...bccRecipients.map((recipient) => ({ ...recipient, role: 'bcc' })),
        ]);

        const lastMessageAt = laterDate(existingThread?.lastMessageAt ?? null, messageDate);
        const thread = existingThread
          ? await tx.mailThread.update({
              where: { id: existingThread.id },
              data: {
                clientId,
                connectionId,
                subject: clean(message.subject) || 'Untitled email thread',
                snippet: clean(message.bodyPreview),
                participants: participantJson as Prisma.InputJsonValue,
                lastMessageAt,
                raw: message as Prisma.InputJsonValue,
                metadata: {
                  webLink: message.webLink ?? null,
                  folders: unique([folder, ...readFolders(existingThread)]),
                } as Prisma.InputJsonValue,
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
                source: EngagementSource.outlook,
                externalId: threadExternalId,
                subject: clean(message.subject) || 'Untitled email thread',
                snippet: clean(message.bodyPreview),
                participants: participantJson as Prisma.InputJsonValue,
                lastMessageAt,
                raw: message as Prisma.InputJsonValue,
                metadata: {
                  webLink: message.webLink ?? null,
                  folders: [folder],
                } as Prisma.InputJsonValue,
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
              source: EngagementSource.outlook,
              externalId: message.id!,
            },
          },
          update: {
            threadId: thread.id,
            connectionId,
            subject: clean(message.subject),
            fromEmail,
            fromName: clean(from?.name),
            toRecipients: toRecipients as Prisma.InputJsonValue,
            ccRecipients: ccRecipients as Prisma.InputJsonValue,
            bccRecipients: bccRecipients as Prisma.InputJsonValue,
            sentAt: parseGraphDateTime(message.sentDateTime),
            receivedAt: parseGraphDateTime(message.receivedDateTime),
            bodyText: clean(message.bodyPreview),
            hasAttachments: Boolean(message.hasAttachments),
            raw: message as Prisma.InputJsonValue,
            metadata: {
              folder,
              webLink: message.webLink ?? null,
              internetMessageId: message.internetMessageId ?? null,
              isRead: message.isRead ?? null,
            } as Prisma.InputJsonValue,
          },
          create: {
            tenantId,
            threadId: thread.id,
            connectionId,
            source: EngagementSource.outlook,
            externalId: message.id!,
            subject: clean(message.subject),
            fromEmail,
            fromName: clean(from?.name),
            toRecipients: toRecipients as Prisma.InputJsonValue,
            ccRecipients: ccRecipients as Prisma.InputJsonValue,
            bccRecipients: bccRecipients as Prisma.InputJsonValue,
            sentAt: parseGraphDateTime(message.sentDateTime),
            receivedAt: parseGraphDateTime(message.receivedDateTime),
            bodyText: clean(message.bodyPreview),
            hasAttachments: Boolean(message.hasAttachments),
            raw: message as Prisma.InputJsonValue,
            metadata: {
              folder,
              webLink: message.webLink ?? null,
              internetMessageId: message.internetMessageId ?? null,
              isRead: message.isRead ?? null,
            } as Prisma.InputJsonValue,
          },
        });

        // Everyone on this message becomes a known correspondent. Calendar
        // attendees were already harvested; mail never was, so the contact
        // table knew whoever had been on an invite and nobody the firm had
        // merely emailed. Same data, already stored — no new Graph scope.
        // ONE insert-only statement: this transaction holds the per-tenant sync
        // advisory lock, and a per-participant read/write loop here is the exact
        // shape that starved the pool on 2026-07-21.
        await harvestMailContacts(tx, tenantId, participantJson, {
          source: 'microsoft_graph',
          clientId,
        });
        return 'matched';
      },
      { timeoutMs: GRAPH_SYNC_TX_TIMEOUT_MS },
    );
  }

  private async loadConnection(tenantId: string, connectionId: string) {
    const loaded = await this.prisma.withTenant(tenantId, async (tx) => {
      const connection = await tx.integrationConnection.findUnique({
        where: { id: connectionId },
        include: { token: true },
      });
      if (!connection) throw new NotFoundException('Microsoft connection not found');
      if (connection.provider !== EngagementProvider.microsoft_365) {
        throw new BadRequestException('Connection is not a Microsoft 365 integration');
      }
      if (!connection.token) {
        throw new BadRequestException('Microsoft connection has no stored OAuth token');
      }
      return { connection, token: connection.token };
    });
    return loaded;
  }

  private async assertConnectionAccess(ctx: TenantContext, connectionId: string): Promise<void> {
    const connection = await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.integrationConnection.findUnique({
        where: { id: connectionId },
        select: { createdByUserId: true, provider: true },
      }),
    );
    if (!connection) throw new NotFoundException('Microsoft connection not found');
    if (connection.provider !== EngagementProvider.microsoft_365) {
      throw new BadRequestException('Connection is not a Microsoft 365 integration');
    }
    if (connection.createdByUserId !== ctx.userId) {
      throw new ForbiddenException('You can only sync your own Microsoft account');
    }
  }

  private async getValidAccessToken(
    tenantId: string,
    connectionId: string,
    token: IntegrationConnectionToken,
  ): Promise<string> {
    const hasRequiredScopes = hasRequiredResourceScopes(token.scopes);
    if (hasRequiredScopes && token.expiresAt.getTime() > Date.now() + TOKEN_REFRESH_SKEW_MS) {
      return this.tokenCrypto.decrypt({
        ciphertext: token.accessTokenCiphertext,
        iv: token.accessTokenIv,
        authTag: token.accessTokenAuthTag,
      });
    }

    this.assertTokenRefreshConfigured();
    if (!token.refreshTokenCiphertext || !token.refreshTokenIv || !token.refreshTokenAuthTag) {
      throw new ServiceUnavailableException(
        'Microsoft refresh token is missing; reconnect Microsoft 365',
      );
    }

    const refreshToken = this.tokenCrypto.decrypt({
      ciphertext: token.refreshTokenCiphertext,
      iv: token.refreshTokenIv,
      authTag: token.refreshTokenAuthTag,
    });
    let result: AuthenticationResult | null;
    try {
      result = await this.getMsal().acquireTokenByRefreshToken({
        refreshToken,
        scopes: MICROSOFT_SCOPES,
      });
    } catch (error) {
      if (requiresInteractiveMicrosoftConsent(error)) {
        await this.markConnectionNeedsReconnect(tenantId, connectionId, error);
        throw new BadRequestException(
          'Reconnect Microsoft 365 in Settings to grant the updated Outlook permissions',
        );
      }
      throw error;
    }
    if (!result?.accessToken) {
      throw new ServiceUnavailableException(
        'Microsoft token refresh failed; reconnect Microsoft 365',
      );
    }
    await this.persistRefreshedAccessToken(tenantId, connectionId, result, token.homeAccountId);
    return result.accessToken;
  }

  private async markConnectionNeedsReconnect(
    tenantId: string,
    connectionId: string,
    error: unknown,
  ) {
    const message = error instanceof Error ? error.message : String(error);
    await this.prisma.withTenant(tenantId, async (tx) => {
      await tx.integrationConnection
        .update({
          where: { id: connectionId },
          data: {
            status: EngagementConnectionStatus.needs_configuration,
            lastError: `Reconnect Microsoft 365 to grant updated permissions. ${message.slice(
              0,
              850,
            )}`,
          },
        })
        .catch(() => undefined);
    });
  }

  private async persistRefreshedAccessToken(
    tenantId: string,
    connectionId: string,
    result: AuthenticationResult,
    homeAccountId: string | null,
  ) {
    const encrypted = this.tokenCrypto.encrypt(result.accessToken);
    // Azure never echoes offline_access (nor openid/profile) in a refresh response, and returns
    // resource scopes inconsistently (short name vs full Graph URI). Only warn when a real
    // RESOURCE scope is missing — a genuine signal consent was reduced. Critically, do NOT derive
    // the persisted scope set from result.scopes: dropping offline_access here previously made
    // getValidAccessToken() believe the token lacked a required scope and forced a token refresh on
    // every sync (a refresh storm against Azure for already-connected mailboxes).
    if (!hasRequiredResourceScopes(result.scopes)) {
      const granted = normalizeScopeNames(result.scopes);
      const missing = REQUIRED_RESOURCE_SCOPES.filter((scope) => !granted.has(scope));
      this.logger.warn(
        `Refreshed Microsoft token is missing required scopes for connection ${connectionId} (tenant ${tenantId}): ${missing.join(', ')}`,
      );
    }
    // Persist the canonical scope set we requested (a successful refresh confirms it) so the next
    // getValidAccessToken() scope gate stays stable.
    const persistedScopes = MICROSOFT_SCOPES;
    // Azure rotates refresh tokens on every redemption. Capture the freshly issued one (matched to
    // this account) and persist it, so we advance the token chain instead of replaying the original
    // refresh token from connect time forever.
    const rotatedRefresh = this.extractRotatedRefreshToken(homeAccountId);
    const refreshEnvelope = rotatedRefresh ? this.tokenCrypto.encrypt(rotatedRefresh) : null;
    await this.prisma.withTenant(tenantId, async (tx) => {
      await tx.integrationConnectionToken.update({
        where: { connectionId },
        data: {
          accessTokenCiphertext: encrypted.ciphertext,
          accessTokenIv: encrypted.iv,
          accessTokenAuthTag: encrypted.authTag,
          ...(refreshEnvelope
            ? {
                refreshTokenCiphertext: refreshEnvelope.ciphertext,
                refreshTokenIv: refreshEnvelope.iv,
                refreshTokenAuthTag: refreshEnvelope.authTag,
              }
            : {}),
          keyVersion: this.tokenCrypto.getKeyVersion(),
          scopes: persistedScopes,
          expiresAt: result.expiresOn ?? new Date(Date.now() + 60 * 60 * 1000),
        },
      });
      await tx.integrationConnection.update({
        where: { id: connectionId },
        data: {
          status: EngagementConnectionStatus.connected,
          scopes: persistedScopes,
          lastError: null,
        },
      });
    });
  }

  /**
   * Read the freshly rotated refresh token out of the MSAL in-memory cache after a successful
   * acquireTokenByRefreshToken. AuthenticationResult does not expose the refresh token, so we
   * serialize the cache and pick the entry for this account (home_account_id), falling back to the
   * most recent entry. Best-effort: if nothing is found we keep the existing stored refresh token.
   */
  private extractRotatedRefreshToken(homeAccountId: string | null): string | undefined {
    if (!this.msal) return undefined;
    try {
      const cache = JSON.parse(this.msal.getTokenCache().serialize()) as {
        RefreshToken?: Record<string, { secret?: string; home_account_id?: string }>;
      };
      const entries = Object.values(cache.RefreshToken ?? {});
      if (!entries.length) return undefined;
      const matched = homeAccountId
        ? entries.find((entry) => entry.home_account_id === homeAccountId)
        : undefined;
      return (matched ?? entries[entries.length - 1])?.secret;
    } catch (err) {
      this.logger.warn(
        `Failed to read rotated Microsoft refresh token from MSAL cache: ${(err as Error).message}`,
      );
      return undefined;
    }
  }

  private async graphGet<T>(
    url: string,
    accessToken: string,
    headers: Record<string, string> = {},
  ): Promise<T> {
    return this.graphFetch<T>('GET', url, accessToken, undefined, headers);
  }

  private async graphPost<T>(url: string, accessToken: string, body: unknown): Promise<T> {
    return this.graphFetch<T>('POST', url, accessToken, body);
  }

  private async graphPostNoContent(url: string, accessToken: string, body: unknown): Promise<void> {
    await this.graphFetch<void>('POST', url, accessToken, body, {}, false);
  }

  private async graphFetch<T>(
    method: 'GET' | 'POST',
    url: string,
    accessToken: string,
    body?: unknown,
    headers: Record<string, string> = {},
    parseJson = true,
  ): Promise<T> {
    const target = url.startsWith('https://') ? url : `${GRAPH_BASE_URL}${url}`;
    const response = await fetch(target, {
      method,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...headers,
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    if (response.status === 429 || response.status >= 500) {
      const retryAfter = Number(response.headers.get('retry-after') ?? '0');
      if (retryAfter > 0 && retryAfter <= 10) {
        await sleep(retryAfter * 1000);
        return this.graphFetch(method, url, accessToken, body, headers);
      }
    }

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new ServiceUnavailableException(
        `Microsoft Graph ${method} ${target} failed (${response.status}): ${text.slice(0, 500)}`,
      );
    }
    if (!parseJson || response.status === 202 || response.status === 204) {
      return undefined as T;
    }
    return (await response.json()) as T;
  }

  private async markSyncError(tenantId: string, connectionId: string, err: unknown) {
    const message = err instanceof Error ? err.message : 'Microsoft Graph sync failed';
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

  private async recordLifecycleEvent(
    tenantId: string,
    connectionId: string,
    lifecycleEvent: string,
  ) {
    await this.prisma.withSystem(async (tx) => {
      const connection = await tx.integrationConnection.findUnique({
        where: { id: connectionId },
        select: { syncState: true },
      });
      if (!connection) return;
      const state = readSyncState(connection.syncState);
      state.webhooks = {
        ...(state.webhooks ?? {}),
        configured: lifecycleEvent !== 'subscriptionRemoved',
        lastLifecycleEvent: lifecycleEvent,
        updatedAt: new Date().toISOString(),
      };
      await tx.integrationConnection.update({
        where: { id: connectionId },
        data: {
          syncState: state as Prisma.InputJsonValue,
          lastError:
            lifecycleEvent === 'missed'
              ? 'Microsoft Graph reported missed webhook notifications; run sync now.'
              : undefined,
        },
      });
    });
    if (lifecycleEvent === 'missed') {
      void this.syncConnectionByTenant(tenantId, connectionId).catch(() => undefined);
    }
  }

  private signClientState(
    tenantId: string,
    connectionId: string,
    resource: 'me/events' | 'me/messages',
  ): string {
    if (!this.stateSecret) throw new ServiceUnavailableException('OAUTH_STATE_SECRET is not set');
    return createHmac('sha256', this.stateSecret)
      .update(`${tenantId}:${connectionId}:${resource}:${randomUUID()}`)
      .digest('base64url')
      .slice(0, 96);
  }

  private getMsal(): ConfidentialClientApplication {
    if (this.msal) return this.msal;
    const config: Configuration = {
      auth: {
        clientId: this.clientId!,
        // Multi-tenant authority (default /organizations); refresh tokens for any
        // customer's Outlook account resolve to their home tenant via this endpoint.
        authority: this.authority,
        clientCertificate: {
          thumbprint: this.thumbprint!,
          privateKey: this.privateKey!,
        },
      },
    };
    this.msal = new ConfidentialClientApplication(config);
    return this.msal;
  }

  private assertTokenRefreshConfigured() {
    if (
      !this.clientId ||
      !this.tenantId ||
      !this.thumbprint ||
      !this.privateKey ||
      !this.tokenCrypto.isConfigured()
    ) {
      throw new ServiceUnavailableException(
        'Microsoft Graph sync is not fully configured. Required: MICROSOFT_CLIENT_ID, MICROSOFT_TENANT_ID, MICROSOFT_CERT_THUMBPRINT, MICROSOFT_CERT_PRIVATE_KEY, OAUTH_TOKEN_ENCRYPTION_KEY.',
      );
    }
  }
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
 * Serialize a tenant's Microsoft Graph sync write transactions across the whole
 * cluster via a transaction-scoped Postgres advisory lock.
 *
 * The production failure was a storm of deadlocks (40P01) and 5s transaction
 * timeouts caused by SEVERAL syncs of the same mailbox running at once — a
 * webhook burst, a manual "Sync now", and the calendar-window endpoint all
 * firing while the user retried. Each per-event/message transaction upserts the
 * same tenant-scoped rows (engagement_contacts on (tenant,email); meetings /
 * mail_threads / mail_messages on (tenant,source,externalId)), so concurrent
 * transactions took those locks in conflicting orders and deadlocked.
 *
 * Keying the lock on the tenant forces those write transactions to run one at a
 * time, which makes the deadlock structurally impossible regardless of how many
 * syncs race. It is held only for the short write txn (auto-released on
 * commit/rollback), never across the Graph HTTP calls. An in-process guard
 * could not do this because prod runs multiple API tasks behind the ALB.
 */
async function lockTenantForGraphSync(tx: Prisma.TransactionClient, tenantId: string) {
  // PROVIDER-NEUTRAL key (was `msgraph-sync:` before the Google integration):
  // the Google sync (google-sync.service.ts lockTenantForEngagementSync) uses
  // the SAME `engagement-sync:<tenant>` key, so an Outlook sync and a Gmail sync
  // for the same tenant serialize against each other. Both providers upsert the
  // same tenant-scoped rows (engagement_contacts on (tenant,email); meetings /
  // mail_threads / mail_messages on (tenant,source,externalId)) — a per-provider
  // key would reintroduce the cross-provider deadlock this lock exists to prevent.
  const lockKey = `engagement-sync:${tenantId}`;
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`;
}

async function upsertContacts(
  tx: Prisma.TransactionClient,
  tenantId: string,
  attendees: Array<{
    email: string | null;
    name: string | null;
  }>,
) {
  // Dedupe by email and upsert in a stable, sorted order. The per-tenant
  // advisory lock (lockTenantForGraphSync) is what guarantees concurrent syncs
  // can't deadlock here; the sort is cheap defense-in-depth (consistent
  // lock-ordering on the (tenant,email) unique index) and the dedupe avoids
  // redundant upserts when an event lists the same address twice. Emails are
  // already lowercased by normalizeEmail, so JS sort order matches the citext
  // collation of the unique index.
  const names = new Map<string, string | null>();
  for (const attendee of attendees) {
    if (!attendee.email) continue;
    // Prefer the first non-null name we see for an email within this event.
    if (!names.has(attendee.email) || (attendee.name && !names.get(attendee.email))) {
      names.set(attendee.email, attendee.name);
    }
  }

  const contacts = new Map<string, { id: string }>();
  for (const email of [...names.keys()].sort()) {
    const name = names.get(email) ?? null;
    const contact = await tx.engagementContact.upsert({
      where: { tenantId_email: { tenantId, email } },
      update: {
        fullName: name ?? undefined,
      },
      create: {
        tenantId,
        email,
        fullName: name,
        source: 'microsoft_graph',
      },
      select: { id: true },
    });
    contacts.set(email, contact);
  }
  return contacts;
}

function findSubscriptionConnection(
  connections: Array<{ id: string; tenantId: string; syncState: Prisma.JsonValue }>,
  subscriptionId: string,
) {
  for (const connection of connections) {
    const state = readSyncState(connection.syncState);
    const subscription = state.webhooks?.subscriptions?.find((item) => item.id === subscriptionId);
    if (subscription) {
      return { connectionId: connection.id, tenantId: connection.tenantId, subscription };
    }
  }
  return null;
}

function readSyncState(value: Prisma.JsonValue): MicrosoftSyncState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as unknown as MicrosoftSyncState;
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

function calendarWindow(from?: string, to?: string): { from: string; to: string } {
  const now = new Date();
  const start = from ? new Date(from) : addDays(now, -CALENDAR_PAST_DAYS);
  const end = to ? new Date(to) : addDays(now, CALENDAR_FUTURE_DAYS);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) {
    throw new BadRequestException('Calendar sync window is invalid');
  }
  return { from: start.toISOString(), to: end.toISOString() };
}

function calendarDeltaUrl(from: string, to: string): string {
  const params = new URLSearchParams({ startDateTime: from, endDateTime: to });
  return `/me/calendarView/delta?${params.toString()}`;
}

function calendarViewUrl(from: string, to: string): string {
  const params = new URLSearchParams({
    startDateTime: from,
    endDateTime: to,
    $top: '50',
  });
  return `/me/calendarView?${params.toString()}`;
}

/**
 * Graph delta cursors expire when a stream sits idle past the service's
 * sync-state retention — Graph then answers 410 SyncStateNotFound (observed
 * live on calendars untouched for 2+ weeks). graphFetch folds the status and
 * body into the thrown message.
 */
function isGraphSyncStateGone(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return message.includes('SyncStateNotFound') || message.includes('failed (410)');
}

/** HTTP status parsed from our "Microsoft Graph GET ... failed (503): ..."
 *  ServiceUnavailableException messages. */
function mailErrorStatus(err: unknown): number | null {
  const msg = err instanceof Error ? err.message : '';
  const m = /failed \((\d{3})\)/.exec(msg);
  return m ? Number(m[1]) : null;
}

/** A message that no longer exists (404/410) — safe to skip. Every other error
 *  must abort the run so the delta cursor is NOT advanced past never-persisted
 *  messages (which the delta would never re-emit → silent drop). */
function isMessageGoneError(err: unknown): boolean {
  const status = mailErrorStatus(err);
  return status === 404 || status === 410;
}

/** A permanent mail-integration failure the user must act on (revoked scope /
 *  forbidden / no Exchange mailbox). Surfaced rather than silently retried;
 *  transient errors (429/5xx/DB blips) keep the connection connected when the
 *  calendar leg already succeeded. */
function isPermanentMailFailure(err: unknown): boolean {
  const status = mailErrorStatus(err);
  if (status === 401 || status === 403) return true;
  return err instanceof Error && err.message.includes('MailboxNotEnabledForRESTAPI');
}

function mailDeltaUrl(folder: string, since: Date): string {
  const params = new URLSearchParams();
  params.set(
    '$select',
    [
      'id',
      'conversationId',
      'internetMessageId',
      'subject',
      'bodyPreview',
      'from',
      'sender',
      'toRecipients',
      'ccRecipients',
      'bccRecipients',
      'receivedDateTime',
      'sentDateTime',
      'hasAttachments',
      'webLink',
      'isRead',
    ].join(','),
  );
  params.set('$orderby', 'receivedDateTime desc');
  params.set('$filter', `receivedDateTime ge ${since.toISOString()}`);
  return `/me/mailFolders('${folder}')/messages/delta?${params.toString()}`;
}

function recipients(values?: GraphRecipient[]): Array<{ email: string; name: string | null }> {
  return (values ?? [])
    .map((recipient) => ({
      email: normalizeEmail(recipient.emailAddress?.address),
      name: clean(recipient.emailAddress?.name),
    }))
    .filter((recipient): recipient is { email: string; name: string | null } =>
      Boolean(recipient.email),
    );
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

function readFolders(_thread: { id: string }): string[] {
  return [];
}

function parseGraphDateTime(value?: string | null): Date | null {
  const text = value?.trim();
  if (!text) return null;
  const normalized = /z$/i.test(text) || /[+-]\d\d:\d\d$/.test(text) ? text : `${text}Z`;
  const date = new Date(normalized);
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

// Required RESOURCE scopes = MICROSOFT_SCOPES minus offline_access. Azure never echoes
// offline_access/openid/profile in token responses, so it must not be treated as "missing".
// Lower-cased short names for tolerant comparison against whatever form Azure returns.
const REQUIRED_RESOURCE_SCOPES = MICROSOFT_SCOPES.filter(
  (scope) => scope.toLowerCase() !== 'offline_access',
).map((scope) => scope.toLowerCase());

// Normalize granted scopes to lower-cased short names (strip the Graph resource URI prefix that
// Azure sometimes prepends, e.g. "https://graph.microsoft.com/Mail.Read" -> "mail.read").
export function normalizeScopeNames(scopes: readonly string[] | undefined): Set<string> {
  return new Set(
    (scopes ?? []).map((scope) =>
      scope.toLowerCase().replace(/^https:\/\/graph\.microsoft\.com\//, ''),
    ),
  );
}

// True when every required resource scope is present, tolerant of case, URI-prefixing, and the
// absent-by-design offline_access scope. Used to decide whether a stored token still grants what
// we need (and therefore whether a refresh is required).
export function hasRequiredResourceScopes(scopes: readonly string[] | undefined): boolean {
  const granted = normalizeScopeNames(scopes);
  return REQUIRED_RESOURCE_SCOPES.every((scope) => granted.has(scope));
}

function requiresInteractiveMicrosoftConsent(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /AADSTS65001|invalid_grant|consent/i.test(message);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
