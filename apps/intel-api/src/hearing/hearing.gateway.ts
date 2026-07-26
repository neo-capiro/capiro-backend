import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OnGatewayConnection, OnGatewayDisconnect, WebSocketGateway } from '@nestjs/websockets';
import type { WebSocket } from 'ws';
import type { IncomingMessage } from 'node:http';
import { ClerkService } from '../auth/clerk.service.js';
import { verifyWsOrigin } from './ws-origin.js';
import { OrgTenantResolverService } from '../auth/org-tenant-resolver.service.js';
import {
  FeatureFlagService,
  HEARING_WATCH_FEATURE,
} from '../feature-flags/feature-flag.service.js';
import { HearingSessionService } from './hearing-session.service.js';
import { HearingWsTicketService } from './hearing-ws-ticket.service.js';
import { SegmentCommitService } from './segment-commit.service.js';
import { WatchlistService } from '../watchlist/watchlist.service.js';
import { OrchestratorClient } from './orchestrator.client.js';
import { DeepgramStreamManager } from './deepgram-stream.manager.js';
import { BillHearingLinkerService } from '../linking/bill-hearing-linker.service.js';
import { WatchlistMatchPromoterService } from '../linking/watchlist-match-promoter.service.js';
import type { ClientWsMessage, ServerWsMessage } from './hearing.types.js';

interface LiveConn {
  ws: WebSocket;
  tenantId: string;
  userId: string;
  sessionId: string;
  // NOTE: the caller's Clerk JWT is deliberately NOT stored here. It used to be
  // (`authToken`), retained for the life of the socket — up to MAX_SESSION_MS,
  // four hours — and relayed to MeriV2 on every final segment, long after the
  // ~60s token had expired. Downstream calls now use service-to-service auth
  // with an explicitly delegated tenantId/userId.
  recordingPolicy: string;
  sessionContext: {
    clientId?: string | null;
    issueIds: string[];
    billIds: string[];
    programElementIds: string[];
    committeeId?: string | null;
  };
  deepgram: DeepgramStreamManager;
}

const MAX_SESSION_MS = Number.parseInt(process.env.MAX_SESSION_MS ?? `${4 * 60 * 60 * 1000}`, 10);


/**
 * WebSocket gateway for the live hearing audio stream.
 *
 * URL: ws://<host>/intel-api/live?sessionId=...  (Bearer JWT in Sec-WebSocket-Protocol
 * or `authorization` query param). One browser connection per session; one
 * Deepgram socket per session (DeepgramStreamManager). Auth + tenant scoping
 * via the SAME ClerkService used by the REST guard (no auth reimplemented).
 *
 * Flow: browser audio frames -> Deepgram -> interim (UI only) / final
 * (-> orchestrator extract -> SegmentCommitService -> persisted + cards to UI).
 */
@WebSocketGateway({ path: '/intel-api/live', verifyClient: verifyWsOrigin })
export class HearingGateway implements OnGatewayConnection, OnGatewayDisconnect {
  private readonly logger = new Logger(HearingGateway.name);
  private readonly conns = new WeakMap<WebSocket, LiveConn>();
  private readonly deepgramApiKey: string;

  constructor(
    private readonly clerk: ClerkService,
    private readonly tenants: OrgTenantResolverService,
    private readonly flags: FeatureFlagService,
    private readonly sessions: HearingSessionService,
    private readonly tickets: HearingWsTicketService,
    private readonly commit: SegmentCommitService,
    private readonly watchlists: WatchlistService,
    private readonly orchestrator: OrchestratorClient,
    private readonly linker: BillHearingLinkerService,
    private readonly promoter: WatchlistMatchPromoterService,
    config: ConfigService,
  ) {
    this.deepgramApiKey = config.get<string>('DEEPGRAM_API_KEY') ?? '';
  }

  async handleConnection(client: WebSocket, req: IncomingMessage): Promise<void> {
    try {
      const url = new URL(req.url ?? '', 'http://localhost');
      const sessionId = url.searchParams.get('sessionId');
      if (!sessionId) {
        return this.reject(client, 'Missing sessionId or auth token');
      }
      if (!this.deepgramApiKey) {
        return this.reject(client, 'Deepgram not configured');
      }

      // ── Preferred path: a single-use ticket minted over authenticated HTTPS.
      // Nothing long-lived is presented and nothing is retained.
      const ticket = url.searchParams.get('ticket');
      if (ticket) {
        const consumed = await this.tickets.consume(ticket, sessionId);
        if (!consumed) {
          // Unknown, already used, expired, or for a different session.
          return this.reject(client, 'Invalid or expired ticket');
        }
        return this.startSession(client, sessionId, consumed.tenantId, consumed.clerkUserId);
      }

      // ── DEPRECATED dual-accept path: raw Clerk JWT in the query string.
      // Retained ONLY so intel-api can ship before apps/web. Remove in the
      // follow-up commit once the web change is live — at which point
      // extractToken's ?authorization / ?token branches go too.
      const token = extractToken(req, url);
      if (!token) {
        return this.reject(client, 'Missing sessionId or auth token');
      }
      this.logger.warn(
        JSON.stringify({
          security_event: 'ws.legacy_token_auth',
          reason: 'clerk_jwt_in_query_string',
          session_id: sessionId,
          count: 1,
        }),
      );

      // Same Clerk verification path as the REST guard.
      const claims = await this.clerk.verifySessionToken(token);
      if (!claims.sub) {
        return this.reject(client, 'No tenant/subject in token');
      }

      // Canonical resolution, mirroring the REST TenantGuard. This used to be
      // `capiro_tenant_id ?? org_id` taken straight from the claims, which meant
      // an org_id-only token put a raw `org_...` string into every downstream
      // tenant predicate — and, more importantly, that a user whose Capiro
      // membership had been revoked could still open a live audio socket.
      const claimedOrgId = claims.org_id?.trim() || undefined;
      const claimedTenantId = claims.capiro_tenant_id?.trim() || undefined;
      if (!claimedOrgId && !claimedTenantId) {
        return this.reject(client, 'No tenant/subject in token');
      }

      let resolvedTenant = claimedOrgId
        ? await this.tenants.resolveByClerkOrgId(claimedOrgId)
        : null;
      if (!resolvedTenant && claimedTenantId) {
        resolvedTenant = await this.tenants.resolveByTenantId(claimedTenantId);
      }
      if (!resolvedTenant) {
        return this.reject(client, 'No tenant for the supplied identifiers');
      }
      if (claimedTenantId && resolvedTenant.tenantId !== claimedTenantId) {
        return this.reject(client, 'Tenant claim mismatch');
      }
      if (
        claimedOrgId &&
        resolvedTenant.clerkOrgId &&
        resolvedTenant.clerkOrgId !== claimedOrgId
      ) {
        return this.reject(client, 'Org claim mismatch');
      }

      const tenantId = resolvedTenant.tenantId;

      // The socket stays open for hours, so an unrevoked membership at connect
      // time is the minimum bar — re-validation for long-lived sockets is
      // tracked separately.
      if (!(await this.tenants.hasActiveMembership(tenantId, claims.sub))) {
        this.logger.warn(
          JSON.stringify({
            security_event: 'auth.denied',
            reason: 'no_active_membership',
            surface: 'ws',
            tenant_id: tenantId,
            clerk_user_id: claims.sub,
            count: 1,
          }),
        );
        return this.reject(client, 'No active membership for this tenant');
      }

      return this.startSession(client, sessionId, tenantId, claims.sub);
    } catch (err) {
      this.reject(client, (err as Error).message);
    }
  }

  /**
   * Everything after authorization, shared by the ticket path and the
   * deprecated JWT path. `tenantId` is always the CANONICAL uuid and `userId`
   * the Clerk subject; neither path passes a raw token in.
   */
  private async startSession(
    client: WebSocket,
    sessionId: string,
    tenantId: string,
    userId: string,
  ): Promise<void> {
    // Feature gate: refuse non-Capiro tenants until hearing_watch is enabled.
    const featureOn = await this.flags.isEnabled(HEARING_WATCH_FEATURE, tenantId);
    if (!featureOn) {
      return this.reject(client, 'Hearing Watch not enabled for this tenant');
    }

    // Scope + consent gate (throws 403 if consent needs_review).
    const session = await this.sessions.assertCaptureAllowed(tenantId, sessionId);

    const deepgram = new DeepgramStreamManager(this.deepgramApiKey, {
      onOpen: () => this.send(client, { type: 'status', status: 'transcribing' }),
      onInterim: (segment) => this.send(client, { type: 'interim', segment }),
      onReconnecting: (attempt) =>
        this.send(client, { type: 'status', status: `reconnecting:${attempt}` }),
      onError: (err) => {
        this.logger.warn(`deepgram error session=${sessionId}: ${err.message}`);
        this.send(client, { type: 'error', message: err.message });
      },
      onFinal: (segment) => {
        void this.handleFinal(client, segment);
      },
    });

    this.conns.set(client, {
      ws: client,
      tenantId,
      userId,
      sessionId,
      recordingPolicy: session.recordingPolicy,
      sessionContext: {
        clientId: session.clientId,
        issueIds: session.issueIds,
        billIds: session.billIds,
        programElementIds: session.programElementIds,
        committeeId: session.committeeId,
      },
      deepgram,
    });

    await this.sessions.markStatus(tenantId, sessionId, 'live', { startedAt: new Date() });
    deepgram.start();
    this.send(client, { type: 'status', status: 'connected' });

    // Hard cap on session duration (cost + stuck-stream guard).
    setTimeout(() => {
      if (this.conns.has(client)) {
        this.send(client, { type: 'status', status: 'max_duration_reached' });
        client.close();
      }
    }, MAX_SESSION_MS);

    client.on('message', (raw: Buffer, isBinary: boolean) =>
      this.onMessage(client, raw, isBinary),
    );
  }

  async handleDisconnect(client: WebSocket): Promise<void> {
    const conn = this.conns.get(client);
    if (!conn) return;
    conn.deepgram.stop();
    this.conns.delete(client);
    try {
      await this.sessions.markStatus(conn.tenantId, conn.sessionId, 'ended', {
        endedAt: new Date(),
      });
    } catch (err) {
      this.logger.warn(`markStatus ended failed: ${(err as Error).message}`);
    }
    // Hearing-end auto-link (Phase 6 §9.6): promote watchlist matches → hearing
    // alerts, then link tracked bills → combined alerts. SHADOW-safe (writes
    // intel_alert status='new', no delivery). Fire-and-forget so the disconnect
    // path never blocks; advisory locks dedupe against the daily sweep.
    void this.autoLink(conn.tenantId, conn.sessionId);
  }

  /** Fire-and-forget hearing-end linking. Promote BEFORE link so the combined
   *  alert can reference the just-created hearing alert (§9.4 ordering). */
  private async autoLink(tenantId: string, sessionId: string): Promise<void> {
    try {
      const promoted = await this.promoter.promoteMatches(tenantId, sessionId);
      const linked = await this.linker.linkSession(tenantId, sessionId);
      this.logger.log(
        `hearing-end auto-link session=${sessionId} promoted=${promoted.alerts} combined=${linked.combined}`,
      );
    } catch (err) {
      this.logger.warn(
        `hearing-end auto-link failed session=${sessionId}: ${(err as Error).message}`,
      );
    }
  }

  private onMessage(client: WebSocket, raw: Buffer, isBinary: boolean): void {
    const conn = this.conns.get(client);
    if (!conn) return;
    // ws v8 delivers BOTH text and binary frames as a Buffer, so a
    // `Buffer.isBuffer(raw)` test is always true and would misroute every JSON
    // control frame (audio/stop) into Deepgram as audio. The `isBinary` flag is
    // the only reliable discriminator: true = raw audio frame, false = a JSON
    // control message.
    if (isBinary) {
      conn.deepgram.sendAudio(raw);
      return;
    }
    try {
      const msg = JSON.parse(raw.toString('utf8')) as ClientWsMessage;
      if (msg.type === 'audio') {
        conn.deepgram.sendAudio(Buffer.from(msg.chunk, 'base64'));
      } else if (msg.type === 'stop') {
        client.close();
      }
    } catch {
      // ignore malformed control frame
    }
  }

  private async handleFinal(
    client: WebSocket,
    segment: {
      startMs: number;
      endMs: number;
      text: string;
      speakerLabel?: string;
      confidence?: number;
    },
  ): Promise<void> {
    const conn = this.conns.get(client);
    if (!conn) return;
    const extraction = await this.orchestrator.extract({
      tenantId: conn.tenantId,
      sessionId: conn.sessionId,
      clerkUserId: conn.userId,
      segment,
      sessionContext: conn.sessionContext,
    });
    let segmentId: string | null = null;
    try {
      segmentId = await this.commit.commitFinal({
        tenantId: conn.tenantId,
        sessionId: conn.sessionId,
        recordingPolicy: conn.recordingPolicy,
        segment,
        extraction,
      });
    } catch (err) {
      this.logger.error(`commit failed session=${conn.sessionId}: ${(err as Error).message}`);
    }
    this.send(client, { type: 'final', segmentId: segmentId ?? '', segment });
    // Watchlist matching (H2): score the committed segment against the tenant's
    // active watchlist terms, persist matches, and surface an alert card.
    if (segmentId) {
      try {
        const matchCount = await this.watchlists.matchAndPersist({
          tenantId: conn.tenantId,
          sessionId: conn.sessionId,
          segmentId,
          text: segment.text,
          clientId: conn.sessionContext.clientId ?? undefined,
        });
        if (matchCount > 0) {
          this.send(client, {
            type: 'card',
            card: {
              id: `wl-${segmentId}`,
              cardType: 'watchlist_match',
              title: `${matchCount} watchlist match${matchCount > 1 ? 'es' : ''}`,
              body: segment.text.slice(0, 200),
              startMs: segment.startMs,
            },
          });
        }
      } catch (err) {
        this.logger.warn(
          `watchlist match failed session=${conn.sessionId}: ${(err as Error).message}`,
        );
      }
    }
    if (extraction.summaryCard) {
      this.send(client, {
        type: 'card',
        card: {
          id: segmentId ?? `${segment.startMs}`,
          cardType: extraction.summaryCard.cardType,
          title: extraction.summaryCard.title,
          body: extraction.summaryCard.body,
          startMs: segment.startMs,
        },
      });
    }
  }

  private send(client: WebSocket, msg: ServerWsMessage): void {
    if (client.readyState === client.OPEN) {
      client.send(JSON.stringify(msg));
    }
  }

  private reject(client: WebSocket, reason: string): void {
    // WARN, not debug. At the default log level every WebSocket rejection was
    // invisible — including an invalid ticket and a revoked membership — so
    // there was no signal at all that the live-hearing surface was denying
    // anyone. Emitted in the structured shape so the Capiro/Security metric
    // filter counts WS denials alongside HTTP ones.
    this.logger.warn(
      JSON.stringify({
        security_event: 'auth.denied',
        reason: classifyWsRejection(reason),
        surface: 'ws',
        tenant_id: null,
        claimed_tenant_id: null,
        clerk_user_id: null,
        detail: reason,
        count: 1,
      }),
    );
    try {
      client.send(JSON.stringify({ type: 'error', message: reason } satisfies ServerWsMessage));
    } catch {
      // ignore
    }
    client.close();
  }
}

function extractToken(req: IncomingMessage, url: URL): string | null {
  const fromQuery = url.searchParams.get('authorization') ?? url.searchParams.get('token');
  if (fromQuery) return fromQuery.replace(/^Bearer\s+/i, '').trim();
  const header = req.headers.authorization;
  if (header) {
    const m = header.match(/^Bearer\s+(.+)$/i);
    if (m?.[1]) return m[1].trim();
  }
  // Browsers can pass the token via the WS subprotocol header.
  const proto = req.headers['sec-websocket-protocol'];
  if (typeof proto === 'string' && proto.length > 0) {
    return (
      proto
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
        .pop() ?? null
    );
  }
  return null;
}

/**
 * Map a rejection message onto a stable `auth.denied` reason code.
 *
 * The gateway rejects with human-readable strings; the metric filter needs a
 * fixed dimension. Anything unrecognized falls back to ws_ticket_invalid rather
 * than being dropped, so no denial goes uncounted.
 */
function classifyWsRejection(reason: string): string {
  const r = reason.toLowerCase();
  if (r.includes('no active membership')) return 'no_active_membership';
  if (r.includes('tenant claim mismatch')) return 'tenant_claim_mismatch';
  if (r.includes('org claim mismatch')) return 'org_claim_mismatch';
  if (r.includes('no tenant')) return 'no_matching_tenant';
  return 'ws_ticket_invalid';
}
