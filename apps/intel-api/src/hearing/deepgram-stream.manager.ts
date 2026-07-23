import { Logger } from '@nestjs/common';
import { createClient, type ListenLiveClient, LiveTranscriptionEvents } from '@deepgram/sdk';
import type { FinalSegment, InterimSegment } from './hearing.types.js';

export interface DeepgramStreamCallbacks {
  onInterim: (seg: InterimSegment) => void;
  onFinal: (seg: FinalSegment) => void;
  onError: (err: Error) => void;
  onReconnecting: (attempt: number) => void;
  onOpen: () => void;
}

const RECONNECT_MAX_ATTEMPTS = 8;
const RECONNECT_BASE_MS = 500;

/**
 * Owns ONE Deepgram live-transcription WebSocket for a single hearing session.
 *
 * Deepgram is STT ONLY: it returns interim then final transcript segments with
 * word-level diarization and timestamps. All policy reasoning happens elsewhere
 * (ExtractionDispatcher -> orchestrator registry). Handles reconnect/recovery
 * (SC5.9): a dropped Deepgram socket reconnects with exponential backoff;
 * already-committed final segments are untouched because commit is idempotent
 * on (sessionId,startMs,endMs) in SegmentCommitService.
 */
export class DeepgramStreamManager {
  private readonly logger = new Logger(DeepgramStreamManager.name);
  private connection?: ListenLiveClient;
  private reconnectAttempts = 0;
  private closedByUs = false;
  private firstAudioLogged = false;
  private firstTranscriptLogged = false;
  private readonly model: string;
  private readonly endpointingMs: number;
  private readonly encoding: string;
  private readonly sampleRate?: number;

  constructor(
    private readonly apiKey: string,
    private readonly callbacks: DeepgramStreamCallbacks,
    opts?: { model?: string; endpointingMs?: number; encoding?: string; sampleRate?: number },
  ) {
    // nova-3 for live streaming. The DEEPGRAM_MODEL=nova-2 env is stale: this
    // project's Deepgram key does not serve streaming nova-2 (the socket opens
    // then closes with no transcript — the LegiWatch "nothing transcribes"
    // symptom), while nova-3 works on the same account (the notetaker/Recall
    // path uses it). Env read intentionally dropped; re-add once DEEPGRAM_MODEL
    // is reconciled to nova-3 in infra.
    this.model = opts?.model ?? 'nova-3';
    this.endpointingMs = opts?.endpointingMs ?? Number.parseInt(process.env.DEEPGRAM_ENDPOINTING_MS ?? '300', 10);
    // Browser capture sends MediaRecorder's default output: opus audio
    // wrapped in a WebM container, NOT raw/headerless opus frames. Deepgram's
    // `encoding` param means "headerless, decode as this codec" — passing
    // `encoding: 'opus'` for WebM-container bytes makes Deepgram try to parse
    // Matroska framing as raw Opus and fail silently. Leaving `encoding`
    // unset lets Deepgram auto-detect the container from its header, which is
    // what containerized formats (WebM/WAV/Ogg) require. Server-side ffmpeg
    // ingestion explicitly passes `encoding: 'linear16'` (headerless PCM,
    // where sample_rate is required) — that path is unaffected.
    this.encoding = opts?.encoding ?? '';
    this.sampleRate = opts?.sampleRate;
  }

  start(): void {
    this.closedByUs = false;
    this.open();
  }

  /** Forward a raw audio frame to Deepgram. No-op if the socket isn't open. */
  sendAudio(chunk: Buffer): void {
    try {
      if (!this.firstAudioLogged) {
        this.firstAudioLogged = true;
        this.logger.log(`deepgram first audio chunk sent (${chunk.byteLength}B)`);
      }
      // Deepgram's send() expects an ArrayBuffer-like; pass a tightly-scoped
      // ArrayBuffer copy of the Node Buffer (avoids SharedArrayBuffer typing).
      const ab = chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength) as ArrayBuffer;
      this.connection?.send(ab);
    } catch (err) {
      this.logger.debug(`sendAudio failed: ${(err as Error).message}`);
    }
  }

  stop(): void {
    this.closedByUs = true;
    try {
      this.connection?.requestClose();
    } catch {
      // ignore
    }
    this.connection = undefined;
  }

  private open(): void {
    const deepgram = createClient(this.apiKey);
    const connection = deepgram.listen.live({
      model: this.model,
      interim_results: true,
      diarize: true,
      punctuate: true,
      smart_format: true,
      endpointing: this.endpointingMs,
      ...(this.encoding ? { encoding: this.encoding } : {}),
      ...(this.sampleRate ? { sample_rate: this.sampleRate } : {}),
    });
    this.connection = connection;

    connection.on(LiveTranscriptionEvents.Open, () => {
      this.reconnectAttempts = 0;
      this.logger.log(
        `deepgram open model=${this.model} encoding=${this.encoding || 'auto-detect'} sampleRate=${this.sampleRate ?? 'n/a'}`,
      );
      this.callbacks.onOpen();
    });

    connection.on(LiveTranscriptionEvents.Metadata, (meta: unknown) => {
      const m = meta as { request_id?: string } | undefined;
      this.logger.log(`deepgram metadata request_id=${m?.request_id ?? '?'}`);
    });

    connection.on(LiveTranscriptionEvents.Transcript, (data: DeepgramTranscript) => {
      if (!this.firstTranscriptLogged) {
        this.firstTranscriptLogged = true;
        this.logger.log(
          `deepgram first transcript is_final=${data.is_final ?? false} textLen=${data.channel?.alternatives?.[0]?.transcript?.length ?? 0}`,
        );
      }
      const alt = data.channel?.alternatives?.[0];
      if (!alt || !alt.transcript) return;
      const startMs = Math.round((data.start ?? 0) * 1000);
      const endMs = Math.round(((data.start ?? 0) + (data.duration ?? 0)) * 1000);
      const speakerLabel = alt.words?.[0]?.speaker != null ? String(alt.words[0].speaker) : undefined;

      if (data.is_final) {
        this.callbacks.onFinal({
          startMs,
          endMs,
          text: alt.transcript,
          speakerLabel,
          confidence: alt.confidence,
        });
      } else {
        this.callbacks.onInterim({ startMs, endMs, text: alt.transcript, speakerLabel });
      }
    });

    connection.on(LiveTranscriptionEvents.Error, (err: unknown) => {
      this.callbacks.onError(err instanceof Error ? err : new Error(String(err)));
    });

    connection.on(LiveTranscriptionEvents.Close, (event: unknown) => {
      const e = event as { code?: number; reason?: string } | undefined;
      this.logger.warn(
        `deepgram close code=${e?.code ?? '?'} reason=${e?.reason || '(none)'} closedByUs=${this.closedByUs} attempts=${this.reconnectAttempts}`,
      );
      if (this.closedByUs) return;
      this.scheduleReconnect();
    });
  }

  private scheduleReconnect(): void {
    if (this.reconnectAttempts >= RECONNECT_MAX_ATTEMPTS) {
      this.callbacks.onError(new Error('Deepgram reconnect attempts exhausted'));
      return;
    }
    this.reconnectAttempts += 1;
    const delay = RECONNECT_BASE_MS * 2 ** (this.reconnectAttempts - 1);
    this.callbacks.onReconnecting(this.reconnectAttempts);
    setTimeout(() => {
      if (!this.closedByUs) this.open();
    }, delay);
  }
}

/** Minimal shape of the Deepgram live transcript event we consume. */
interface DeepgramTranscript {
  is_final?: boolean;
  start?: number;
  duration?: number;
  channel?: {
    alternatives?: Array<{
      transcript: string;
      confidence?: number;
      words?: Array<{ speaker?: number }>;
    }>;
  };
}
