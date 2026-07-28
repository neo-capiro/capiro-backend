import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OnGatewayConnection, OnGatewayDisconnect, WebSocketGateway } from '@nestjs/websockets';
import type { WebSocket } from 'ws';
import type { IncomingMessage } from 'node:http';
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
import type {
  ClientWsMessage,
  FinalSegment,
  InterimSegment,
  ServerWsMessage,
} from './hearing.types.js';

const MAX_SESSION_MS = Number.parseInt(
  process.env.MAX_SESSION_MS ?? `${12 * 60 * 60 * 1000}`,
  10,
);
const CAPTURE_START_TIMEOUT_MS = 15_000;
const FIRST_AUDIO_TIMEOUT_MS = 30_000;
const HEARTBEAT_MS = 30_000;
const MAX_FRAME_BYTES = 1_000_000;
const MAX_BYTES_PER_SECOND = 512 * 1024;
const BROWSER_MIME_TYPES = new Set(['audio/webm;codecs=opus', 'audio/webm']);

type CaptureState = 'connected' | 'starting' | 'ready' | 'capturing' | 'stopping' | 'ended';

interface LiveConn {
  ws: WebSocket;
  tenantId: string;
  userId: string;
  sessionId: string;
  recordingPolicy: string;
  forceEncrypt: boolean;
  sessionContext: {
    clientId?: string | null;
    issueIds: string[];
    billIds: string[];
    programElementIds: string[];
    agencyIds: string[];
    committeeId?: string | null;
    hearingId?: string | null;
  };
  state: CaptureState;
  deepgram?: DeepgramStreamManager;
  claimStartedAt?: Date;
  timelineOffsetMs: number;
  hasAudio: boolean;
  rawChain: Promise<void>;
  pendingEnrichment: Set<Promise<void>>;
  finalizePromise?: Promise<void>;
  heartbeatTimer?: ReturnType<typeof setInterval>;
  startTimer?: ReturnType<typeof setTimeout>;
  firstAudioTimer?: ReturnType<typeof setTimeout>;
  durationTimer?: ReturnType<typeof setTimeout>;
  rateWindowStartedAt: number;
  bytesThisWindow: number;
}

/**
 * Browser-audio hearing gateway.
 *
 * The application WebSocket is only an authenticated control channel until the
 * browser sends `capture_start`. The server atomically claims the session in a
 * preparation state, opens Deepgram, and replies `capture_ready`; only then may
 * MediaRecorder bytes flow. The session becomes `live` on its first accepted
 * audio frame. Final transcript persistence is ordered and immediate, while Meri
 * enrichment runs off the critical path. Graceful stop drains every stage before
 * hearing-end linking and lease release.
 */
@WebSocketGateway({
  path: '/intel-api/live',
  verifyClient: verifyWsOrigin,
  maxPayload: MAX_FRAME_BYTES,
})
export class HearingGateway implements OnGatewayConnection, OnGatewayDisconnect {
  private readonly logger = new Logger(HearingGateway.name);
  private readonly conns = new WeakMap<WebSocket, LiveConn>();
  private readonly deepgramApiKey: string;

  constructor(
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
      if (!sessionId) return this.reject(client, 'Missing sessionId or auth token');
      if (!this.deepgramApiKey) return this.reject(client, 'Deepgram not configured');

      const ticket = url.searchParams.get('ticket');
      if (!ticket) return this.reject(client, 'Missing or invalid ticket');
      const consumed = await this.tickets.consume(ticket, sessionId);
      if (!consumed) return this.reject(client, 'Invalid or expired ticket');
      await this.startSession(client, sessionId, consumed.tenantId, consumed.clerkUserId);
    } catch (err) {
      this.reject(client, (err as Error).message);
    }
  }

  private async startSession(
    client: WebSocket,
    sessionId: string,
    tenantId: string,
    userId: string,
  ): Promise<void> {
    const featureOn = await this.flags.isEnabled(HEARING_WATCH_FEATURE, tenantId);
    if (!featureOn) return this.reject(client, 'Hearing Watch not enabled for this tenant');

    // Defense in depth: the HTTPS ticket endpoint already checked this user, but
    // the single-use ticket carries their identity so the upgrade rechecks that a
    // private session still belongs to them before accepting any audio.
    const session = await this.sessions.assertCaptureAllowed(tenantId, sessionId, userId);
    const conn: LiveConn = {
      ws: client,
      tenantId,
      userId,
      sessionId,
      recordingPolicy: session.recordingPolicy,
      forceEncrypt: HearingSessionService.isSensitiveSession(session),
      // Everything structured the session was created with travels to Meri with
      // each segment. Agencies and the scheduled hearing id used to be dropped
      // here even though the row carried them.
      sessionContext: {
        clientId: session.clientId,
        issueIds: session.issueIds,
        billIds: session.billIds,
        programElementIds: session.programElementIds,
        agencyIds: session.agencyIds,
        committeeId: session.committeeId,
        hearingId: session.hearingId,
      },
      state: 'connected',
      timelineOffsetMs: 0,
      hasAudio: false,
      rawChain: Promise.resolve(),
      pendingEnrichment: new Set(),
      rateWindowStartedAt: Date.now(),
      bytesThisWindow: 0,
    };
    this.conns.set(client, conn);
    this.send(client, { type: 'status', status: 'connected' });

    client.on('message', (raw: Buffer, isBinary: boolean) => {
      void this.onMessage(client, raw, isBinary);
    });
  }

  async handleDisconnect(client: WebSocket): Promise<void> {
    const conn = this.conns.get(client);
    if (!conn) return;
    await this.finalize(conn, conn.hasAudio ? 'ended' : 'failed', false);
    this.conns.delete(client);
  }

  private async onMessage(client: WebSocket, raw: Buffer, isBinary: boolean): Promise<void> {
    const conn = this.conns.get(client);
    if (!conn || conn.state === 'ended') return;

    if (isBinary) {
      await this.onAudioFrame(conn, raw);
      return;
    }

    let msg: ClientWsMessage;
    try {
      msg = JSON.parse(raw.toString('utf8')) as ClientWsMessage;
    } catch {
      this.send(client, {
        type: 'error',
        code: 'INVALID_CONTROL_FRAME',
        message: 'Invalid control frame',
      });
      return;
    }

    if (msg.type === 'capture_start') {
      await this.startCapture(conn, msg.mimeType, msg.displaySurface);
    } else if (msg.type === 'capture_stop' || msg.type === 'stop') {
      await this.finalize(conn, 'ended', true);
    } else if (msg.type === 'audio') {
      await this.onAudioFrame(conn, Buffer.from(msg.chunk, 'base64'));
    }
  }

  private async startCapture(
    conn: LiveConn,
    mimeType: string,
    displaySurface?: string,
  ): Promise<void> {
    if (conn.state !== 'connected') {
      this.send(conn.ws, {
        type: 'error',
        code: 'CAPTURE_STATE_CONFLICT',
        message: 'This session is already starting or capturing.',
      });
      return;
    }
    if (!BROWSER_MIME_TYPES.has(mimeType.toLowerCase())) {
      this.send(conn.ws, {
        type: 'error',
        code: 'UNSUPPORTED_AUDIO_CONTAINER',
        message: 'Browser capture must use audio/webm with Opus.',
      });
      return;
    }

    const claim = await this.sessions.claimCapture(conn.tenantId, conn.sessionId);
    if (!claim) {
      this.send(conn.ws, {
        type: 'error',
        code: 'SESSION_ALREADY_ACTIVE',
        message: 'This hearing session is already being transcribed in another tab or browser.',
      });
      return;
    }

    conn.state = 'starting';
    conn.claimStartedAt = claim.startedAt;
    conn.timelineOffsetMs = await this.commit.maxEndMs(conn.tenantId, conn.sessionId);
    this.logger.log(
      `capture claimed session=${conn.sessionId} user=${conn.userId} ` +
        `surface=${displaySurface ?? 'unknown'} offsetMs=${conn.timelineOffsetMs}`,
    );

    conn.heartbeatTimer = setInterval(() => {
      const claimToken = conn.claimStartedAt;
      if (!claimToken || conn.state === 'ended') return;
      void this.sessions
        .heartbeatCapture(conn.tenantId, conn.sessionId, claimToken)
        .then((ok) => {
          if (!ok && conn.state !== 'ended') {
            this.send(conn.ws, {
              type: 'error',
              code: 'CAPTURE_LEASE_LOST',
              message: 'This capture lost ownership of the hearing session.',
            });
            void this.finalize(conn, 'failed', true);
          }
        })
        .catch((err) => {
          this.logger.warn(`capture heartbeat failed: ${(err as Error).message}`);
          this.send(conn.ws, {
            type: 'error',
            code: 'CAPTURE_LEASE_UNAVAILABLE',
            message: 'Capture ownership could not be verified. The session was stopped safely.',
          });
          void this.finalize(conn, 'failed', true);
        });
    }, HEARTBEAT_MS);

    conn.durationTimer = setTimeout(() => {
      this.send(conn.ws, { type: 'status', status: 'max_duration_reached' });
      void this.finalize(conn, 'ended', true);
    }, MAX_SESSION_MS);

    conn.deepgram = new DeepgramStreamManager(this.deepgramApiKey, {
      onOpen: () => {
        if (conn.state !== 'starting') return;
        if (conn.startTimer) clearTimeout(conn.startTimer);
        conn.state = 'ready';
        this.send(conn.ws, { type: 'status', status: 'capture_ready' });
        // A share-picker or recorder failure after the server claim used to leave
        // Deepgram and the distributed lease alive for up to 12 hours. A ready
        // capture must deliver its first browser audio promptly or release itself.
        conn.firstAudioTimer = setTimeout(() => {
          if (conn.state === 'ready' && !conn.hasAudio) {
            this.send(conn.ws, {
              type: 'error',
              code: 'FIRST_AUDIO_TIMEOUT',
              message: 'No browser audio arrived. Start transcription again and share tab audio.',
            });
            void this.finalize(conn, 'failed', true);
          }
        }, FIRST_AUDIO_TIMEOUT_MS);
      },
      onInterim: (segment) => {
        if (conn.state === 'ended' || conn.state === 'stopping') return;
        this.send(conn.ws, {
          type: 'interim',
          segment: this.withOffset(segment, conn.timelineOffsetMs),
        });
      },
      onFinal: (segment) => this.enqueueFinal(conn, this.withOffset(segment, conn.timelineOffsetMs)),
      onReconnecting: () => undefined,
      onError: (err) => {
        this.logger.warn(`deepgram error session=${conn.sessionId}: ${err.message}`);
        this.send(conn.ws, {
          type: 'error',
          code: 'TRANSCRIPTION_RESTART_REQUIRED',
          message: err.message,
        });
        this.send(conn.ws, { type: 'status', status: 'capture_restart_required' });
        void this.finalize(conn, 'failed', true);
      },
    });

    conn.startTimer = setTimeout(() => {
      if (conn.state === 'starting') {
        this.send(conn.ws, {
          type: 'error',
          code: 'TRANSCRIPTION_START_TIMEOUT',
          message: 'The transcription service did not become ready. Try again.',
        });
        void this.finalize(conn, 'failed', true);
      }
    }, CAPTURE_START_TIMEOUT_MS);

    this.send(conn.ws, { type: 'status', status: 'preparing_transcription' });
    conn.deepgram.start();
  }

  private async onAudioFrame(conn: LiveConn, raw: Buffer): Promise<void> {
    if (conn.state !== 'ready' && conn.state !== 'capturing') {
      this.send(conn.ws, {
        type: 'error',
        code: 'AUDIO_BEFORE_READY',
        message: 'Wait for capture_ready before sending audio.',
      });
      return;
    }
    if (raw.byteLength <= 0 || raw.byteLength > MAX_FRAME_BYTES) {
      this.send(conn.ws, {
        type: 'error',
        code: 'AUDIO_FRAME_TOO_LARGE',
        message: 'Audio frame exceeded the allowed size.',
      });
      await this.finalize(conn, 'failed', true);
      return;
    }

    const now = Date.now();
    if (now - conn.rateWindowStartedAt >= 1_000) {
      conn.rateWindowStartedAt = now;
      conn.bytesThisWindow = 0;
    }
    conn.bytesThisWindow += raw.byteLength;
    if (conn.bytesThisWindow > MAX_BYTES_PER_SECOND) {
      this.send(conn.ws, {
        type: 'error',
        code: 'AUDIO_RATE_EXCEEDED',
        message: 'Audio arrived faster than the supported browser capture rate.',
      });
      await this.finalize(conn, 'failed', true);
      return;
    }

    if (!conn.hasAudio) {
      const claimToken = conn.claimStartedAt;
      let activated = false;
      try {
        activated = Boolean(
          claimToken &&
            (await this.sessions.activateCapture(conn.tenantId, conn.sessionId, claimToken)),
        );
      } catch (err) {
        this.logger.warn(`capture activation failed: ${(err as Error).message}`);
      }
      if (!activated) {
        this.send(conn.ws, {
          type: 'error',
          code: 'CAPTURE_LEASE_LOST',
          message: 'The hearing session could not be activated for audio.',
        });
        await this.finalize(conn, 'failed', true);
        return;
      }
      if (conn.firstAudioTimer) clearTimeout(conn.firstAudioTimer);
    }

    if (!conn.deepgram?.sendAudio(raw)) {
      this.send(conn.ws, {
        type: 'error',
        code: 'TRANSCRIPTION_NOT_READY',
        message: 'The transcription service is not ready for audio.',
      });
      await this.finalize(conn, 'failed', true);
      return;
    }
    if (!conn.hasAudio) {
      conn.hasAudio = true;
      conn.state = 'capturing';
      this.send(conn.ws, { type: 'status', status: 'capturing' });
    }
  }

  private enqueueFinal(conn: LiveConn, segment: FinalSegment): void {
    conn.rawChain = conn.rawChain
      .then(async () => {
        const raw = await this.commit.commitRawFinal({
          tenantId: conn.tenantId,
          sessionId: conn.sessionId,
          recordingPolicy: conn.recordingPolicy,
          segment,
          forceEncrypt: conn.forceEncrypt,
        });

        this.send(conn.ws, { type: 'final', segmentId: raw.id ?? '', segment });
        if (!raw.id || !raw.created) return;

        let task!: Promise<void>;
        task = this.enrichFinal(conn, raw.id, segment)
          .catch((err) =>
            this.logger.warn(
              `segment enrichment failed session=${conn.sessionId} segment=${raw.id}: ` +
                `${(err as Error).message}`,
            ),
          )
          .finally(() => conn.pendingEnrichment.delete(task));
        conn.pendingEnrichment.add(task);
      })
      .catch((err) => {
        this.logger.error(`raw segment commit failed session=${conn.sessionId}: ${(err as Error).message}`);
        this.send(conn.ws, {
          type: 'error',
          code: 'TRANSCRIPT_PERSIST_FAILED',
          message: 'A transcript segment could not be saved.',
        });
      });
  }

  private async enrichFinal(conn: LiveConn, segmentId: string, segment: FinalSegment): Promise<void> {
    const extraction = await this.orchestrator.extract({
      tenantId: conn.tenantId,
      sessionId: conn.sessionId,
      clerkUserId: conn.userId,
      segment,
      sessionContext: conn.sessionContext,
    });

    await this.commit.enrichFinal({
      tenantId: conn.tenantId,
      sessionId: conn.sessionId,
      segmentId,
      segment,
      extraction,
      forceEncrypt: conn.forceEncrypt,
    });

    const matchCount = await this.watchlists.matchAndPersist({
      tenantId: conn.tenantId,
      sessionId: conn.sessionId,
      segmentId,
      text: segment.text,
      clientId: conn.sessionContext.clientId ?? undefined,
    });
    if (matchCount > 0) {
      await this.commit.protectSegmentText(conn.tenantId, conn.sessionId, segmentId);
      this.send(conn.ws, {
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

    if (extraction.summaryCard) {
      this.send(conn.ws, {
        type: 'card',
        card: {
          id: segmentId,
          cardType: extraction.summaryCard.cardType,
          title: extraction.summaryCard.title,
          body: extraction.summaryCard.body,
          startMs: segment.startMs,
        },
      });
    }
  }

  private async finalize(
    conn: LiveConn,
    outcome: 'ended' | 'failed',
    closeClient: boolean,
  ): Promise<void> {
    if (conn.finalizePromise) return conn.finalizePromise;
    conn.finalizePromise = (async () => {
      if (conn.state === 'ended') return;
      conn.state = 'stopping';
      if (conn.startTimer) clearTimeout(conn.startTimer);
      if (conn.firstAudioTimer) clearTimeout(conn.firstAudioTimer);
      if (conn.durationTimer) clearTimeout(conn.durationTimer);
      if (conn.heartbeatTimer) clearInterval(conn.heartbeatTimer);

      await conn.deepgram?.stopAndWait().catch(() => undefined);
      await conn.rawChain;
      await Promise.allSettled([...conn.pendingEnrichment]);

      let released = conn.claimStartedAt == null;
      if (conn.claimStartedAt) {
        try {
          released = await this.sessions.releaseCapture(
            conn.tenantId,
            conn.sessionId,
            conn.claimStartedAt,
            outcome,
          );
        } catch (err) {
          released = false;
          this.logger.warn(
            `capture release failed session=${conn.sessionId}: ${(err as Error).message}`,
          );
        }
        if (!released) {
          this.logger.warn(
            `capture release did not match owned lease session=${conn.sessionId}; skipping hearing-end linking`,
          );
        }
      }

      // Never emit downstream alerts from a stale socket that failed to release
      // its exact lease token. It may be observing a newer active capture.
      if (released && outcome === 'ended' && conn.hasAudio) {
        await this.autoLink(conn.tenantId, conn.sessionId);
      }
      conn.state = 'ended';
      const finalStatus = released ? outcome : 'failed';
      this.send(conn.ws, { type: 'status', status: finalStatus });
      if (closeClient && conn.ws.readyState === conn.ws.OPEN) conn.ws.close();
    })();
    return conn.finalizePromise;
  }

  private async autoLink(tenantId: string, sessionId: string): Promise<void> {
    try {
      const promoted = await this.promoter.promoteMatches(tenantId, sessionId);
      const linked = await this.linker.linkSession(tenantId, sessionId);
      this.logger.log(
        `hearing-end auto-link session=${sessionId} promoted=${promoted.alerts} ` +
          `combined=${linked.combined}`,
      );
    } catch (err) {
      this.logger.warn(`hearing-end auto-link failed session=${sessionId}: ${(err as Error).message}`);
    }
  }

  private withOffset<T extends InterimSegment | FinalSegment>(segment: T, offsetMs: number): T {
    return {
      ...segment,
      startMs: segment.startMs + offsetMs,
      endMs: segment.endMs + offsetMs,
    };
  }

  private send(client: WebSocket, msg: ServerWsMessage): void {
    if (client.readyState === client.OPEN) client.send(JSON.stringify(msg));
  }

  private reject(client: WebSocket, reason: string): void {
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

function classifyWsRejection(reason: string): string {
  const r = reason.toLowerCase();
  if (r.includes('no active membership')) return 'no_active_membership';
  if (r.includes('tenant claim mismatch')) return 'tenant_claim_mismatch';
  if (r.includes('org claim mismatch')) return 'org_claim_mismatch';
  if (r.includes('no tenant')) return 'no_matching_tenant';
  return 'ws_ticket_invalid';
}
