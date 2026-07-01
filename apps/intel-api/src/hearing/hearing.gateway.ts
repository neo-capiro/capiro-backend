import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  OnGatewayConnection,
  OnGatewayDisconnect,
  WebSocketGateway,
} from '@nestjs/websockets';
import type { WebSocket } from 'ws';
import type { IncomingMessage } from 'node:http';
import { ClerkService } from '../auth/clerk.service.js';
import { FeatureFlagService, HEARING_WATCH_FEATURE } from '../feature-flags/feature-flag.service.js';
import { HearingSessionService } from './hearing-session.service.js';
import { SegmentCommitService } from './segment-commit.service.js';
import { WatchlistService } from '../watchlist/watchlist.service.js';
import { OrchestratorClient } from './orchestrator.client.js';
import { DeepgramStreamManager } from './deepgram-stream.manager.js';
import type { ClientWsMessage, ServerWsMessage } from './hearing.types.js';

interface LiveConn {
  ws: WebSocket;
  tenantId: string;
  userId: string;
  sessionId: string;
  authToken: string;
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
@WebSocketGateway({ path: '/intel-api/live' })
export class HearingGateway implements OnGatewayConnection, OnGatewayDisconnect {
  private readonly logger = new Logger(HearingGateway.name);
  private readonly conns = new WeakMap<WebSocket, LiveConn>();
  private readonly deepgramApiKey: string;

  constructor(
    private readonly clerk: ClerkService,
    private readonly flags: FeatureFlagService,
    private readonly sessions: HearingSessionService,
    private readonly commit: SegmentCommitService,
    private readonly watchlists: WatchlistService,
    private readonly orchestrator: OrchestratorClient,
    config: ConfigService,
  ) {
    this.deepgramApiKey = config.get<string>('DEEPGRAM_API_KEY') ?? '';
  }

  async handleConnection(client: WebSocket, req: IncomingMessage): Promise<void> {
    try {
      const url = new URL(req.url ?? '', 'http://localhost');
      const sessionId = url.searchParams.get('sessionId');
      const token = extractToken(req, url);
      if (!sessionId || !token) {
        return this.reject(client, 'Missing sessionId or auth token');
      }
      if (!this.deepgramApiKey) {
        return this.reject(client, 'Deepgram not configured');
      }

      // Same Clerk verification path as the REST guard.
      const claims = await this.clerk.verifySessionToken(token);
      const tenantId = claims.capiro_tenant_id?.trim() || claims.org_id?.trim();
      if (!tenantId || !claims.sub) {
        return this.reject(client, 'No tenant/subject in token');
      }

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
        userId: claims.sub,
        sessionId,
        authToken: token,
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

      client.on('message', (raw: Buffer | string) => this.onMessage(client, raw));
    } catch (err) {
      this.reject(client, (err as Error).message);
    }
  }

  async handleDisconnect(client: WebSocket): Promise<void> {
    const conn = this.conns.get(client);
    if (!conn) return;
    conn.deepgram.stop();
    this.conns.delete(client);
    try {
      await this.sessions.markStatus(conn.tenantId, conn.sessionId, 'ended', { endedAt: new Date() });
    } catch (err) {
      this.logger.warn(`markStatus ended failed: ${(err as Error).message}`);
    }
  }

  private onMessage(client: WebSocket, raw: Buffer | string): void {
    const conn = this.conns.get(client);
    if (!conn) return;
    // Binary frames are raw audio; JSON frames are control messages.
    if (Buffer.isBuffer(raw)) {
      conn.deepgram.sendAudio(raw);
      return;
    }
    try {
      const msg = JSON.parse(raw.toString()) as ClientWsMessage;
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
    segment: { startMs: number; endMs: number; text: string; speakerLabel?: string; confidence?: number },
  ): Promise<void> {
    const conn = this.conns.get(client);
    if (!conn) return;
    const extraction = await this.orchestrator.extract({
      tenantId: conn.tenantId,
      sessionId: conn.sessionId,
      authToken: conn.authToken,
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
        this.logger.warn(`watchlist match failed session=${conn.sessionId}: ${(err as Error).message}`);
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
    this.logger.debug(`ws rejected: ${reason}`);
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
    return proto.split(',').map((s) => s.trim()).filter(Boolean).pop() ?? null;
  }
  return null;
}
