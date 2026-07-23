import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '../../generated/prisma-client/index.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { DeepgramStreamManager } from './deepgram-stream.manager.js';
import { StreamIngestionService, type IngestionHandle } from './stream-ingestion.service.js';
import type { FinalSegment } from './hearing.types.js';

export interface CaptureOutcome {
  /** Terminal status written to the capture row: 'ended' | 'failed'. */
  status: 'ended' | 'failed';
  reason: string;
  segments: number;
}

const HEARTBEAT_MS = 30_000;

/**
 * Keeps transcript timestamps MONOTONIC across Deepgram reconnects (T10).
 *
 * Deepgram's start/duration are relative to the CURRENT socket, so a reconnect
 * restarts them near 0. Left raw, post-reconnect segments collide with early
 * (captureId,startMs,endMs) tuples → P2002 → silently dropped as replays (real
 * data loss on multi-hour unattended captures). At each (re)open we advance the
 * base to the highest endMs persisted so far, so a new socket's timestamps
 * continue after the last segment instead of overwriting it. Pure + unit-tested.
 */
export class MonotonicTimeline {
  private base = 0;
  private maxEnd = 0;

  /** Call on each Deepgram (re)open. First open is a no-op (base stays 0). */
  onOpen(): void {
    this.base = this.maxEnd;
  }

  /** Map a socket-relative segment to a monotonic absolute one. */
  apply(startMs: number, endMs: number): { startMs: number; endMs: number } {
    const s = startMs + this.base;
    const e = endMs + this.base;
    if (e > this.maxEnd) this.maxEnd = e;
    return { startMs: s, endMs: e };
  }
}

/**
 * HearingCaptureRunner — headless (socket-free) capture of ONE live Senate
 * hearing. This is the extraction of HearingGateway.startIngestion's per-session
 * orchestration (Deepgram socket → ffmpeg from onOpen → onFinal) with the
 * WebSocket removed: there is no browser, no tenant, and persistence goes to the
 * GLOBAL, plaintext intel_senate_transcript_segment table (public domain — no
 * AES-GCM, no watchlist/orchestrator enrichment in v1; per-tenant matching is
 * layered at read time).
 *
 * `capture()` resolves when the stream ENDS — ffmpeg EOF/404 on the live segments
 * (onEnd), a dead/unopenable URL (onError, bytesEmitted===0), Deepgram reconnect
 * exhaustion, or the MAX_SESSION_MS hard cap. One ffmpeg + one Deepgram socket
 * per call, so N concurrent captures = N runners in N run-task workers.
 */
@Injectable()
export class HearingCaptureRunner {
  private readonly logger = new Logger(HearingCaptureRunner.name);
  private readonly deepgramApiKey: string;
  private readonly maxSessionMs: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly ingestionSvc: StreamIngestionService,
    config: ConfigService,
  ) {
    this.deepgramApiKey = config.get<string>('DEEPGRAM_API_KEY') ?? '';
    // Senate hearings/markups run for HOURS (marathon markups exceed 8h), so the
    // headless cap is generous + independently tunable — deliberately NOT the
    // gateway's 4h browser cap (MAX_SESSION_MS). The normal terminator is ffmpeg
    // EOF when the hearing actually ends; this cap is only a stuck-stream safety.
    this.maxSessionMs =
      Number.parseInt(config.get<string>('CAPTURE_MAX_SESSION_MS') ?? '', 10) ||
      12 * 60 * 60 * 1000;
  }

  async capture(input: { captureId: string; mediaUrl: string }): Promise<CaptureOutcome> {
    const { captureId, mediaUrl } = input;
    if (!this.deepgramApiKey) throw new Error('DEEPGRAM_API_KEY not configured');

    // Defense-in-depth SSRF gate (host allowlist + private-IP/rebind deny) before
    // ffmpeg is ever spawned — same contract the gateway honors.
    await this.ingestionSvc.assertIngestible(mediaUrl);

    // Claim the row as capturing (idempotent) + open the heartbeat.
    await this.prisma.senateHearingCapture.update({
      where: { id: captureId },
      data: { status: 'capturing', startedAt: new Date(), heartbeatAt: new Date(), mediaUrl },
    });

    return new Promise<CaptureOutcome>((resolve) => {
      let settled = false;
      let ingestion: IngestionHandle | undefined;
      let ingestionStarted = false;
      let segments = 0;
      const timeline = new MonotonicTimeline(); // T10: monotonic across reconnects

      const heartbeat = setInterval(() => {
        void this.prisma.senateHearingCapture
          .update({ where: { id: captureId }, data: { heartbeatAt: new Date() } })
          .catch(() => undefined);
      }, HEARTBEAT_MS);

      const finish = (status: 'ended' | 'failed', reason: string): void => {
        if (settled) return;
        settled = true;
        clearInterval(heartbeat);
        clearTimeout(capTimer);
        try {
          ingestion?.stop();
        } catch {
          /* already gone */
        }
        try {
          deepgram.stop();
        } catch {
          /* already gone */
        }
        this.logger.log(
          `capture ${status} captureId=${captureId} segments=${segments} reason=${reason}`,
        );
        void this.prisma.senateHearingCapture
          .update({
            where: { id: captureId },
            data: {
              status,
              endedAt: new Date(),
              ...(status === 'failed' ? { lastError: reason.slice(0, 500) } : {}),
            },
          })
          .catch((err) =>
            this.logger.warn(`capture end-status write failed: ${(err as Error).message}`),
          )
          .finally(() => resolve({ status, reason, segments }));
      };

      const persist = async (seg: FinalSegment): Promise<void> => {
        const { startMs, endMs } = timeline.apply(seg.startMs, seg.endMs);
        const text = seg.text?.trim();
        if (!text) return;
        try {
          await this.prisma.senateTranscriptSegment.create({
            data: {
              captureId,
              startMs,
              endMs,
              speakerLabel: seg.speakerLabel ?? null,
              isFinal: true,
              confidence: seg.confidence ?? null,
              source: 'deepgram',
              textPlain: text,
            },
          });
          segments++;
        } catch (err) {
          // Idempotent replay: unique (captureId,startMs,endMs) → treat P2002 as
          // a no-op (a reconnect re-delivered the same final).
          if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') return;
          this.logger.error(`segment persist failed captureId=${captureId}: ${(err as Error).message}`);
        }
      };

      const beginIngestion = (): void => {
        if (ingestionStarted) return;
        ingestionStarted = true;
        try {
          ingestion = this.ingestionSvc.start(
            mediaUrl,
            {
              onAudio: (pcm) => deepgram.sendAudio(pcm),
              onEnd: (reason) => finish('ended', reason),
              onError: (err) => finish('failed', err.message),
            },
            { liveEdge: true },
          );
        } catch (err) {
          finish('failed', (err as Error).message);
        }
      };

      const deepgram = new DeepgramStreamManager(
        this.deepgramApiKey,
        {
          // Advance the timestamp base at every (re)open so a reconnected socket's
          // near-zero timestamps continue after the last persisted segment.
          onOpen: () => {
            timeline.onOpen(); // continue timestamps past the last persisted segment
            beginIngestion(); // fires once (guarded); ffmpeg starts only when the socket is ready
          },
          onInterim: () => {
            /* headless: interims are UI-only; ignore */
          },
          onReconnecting: (attempt) =>
            this.logger.warn(`deepgram reconnecting attempt=${attempt} captureId=${captureId}`),
          onError: (err) => {
            this.logger.warn(`deepgram error captureId=${captureId}: ${err.message}`);
            // The manager reconnects on transient drops; only a terminal
            // "reconnect attempts exhausted" ends the capture.
            if (/reconnect attempts exhausted/i.test(err.message)) finish('failed', err.message);
          },
          onFinal: (seg) => {
            void persist(seg);
          },
        },
        { encoding: 'linear16', sampleRate: StreamIngestionService.SAMPLE_RATE },
      );

      // Hard duration cap (cost + stuck-stream guard) — headless equivalent of the
      // gateway's per-connection setTimeout.
      const capTimer = setTimeout(() => finish('ended', 'max_duration_reached'), this.maxSessionMs);

      deepgram.start();
    });
  }
}
