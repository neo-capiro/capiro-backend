import { Logger } from '@nestjs/common';
import { createClient, type ListenLiveClient, LiveTranscriptionEvents } from '@deepgram/sdk';
import type { DeepgramStreamCallbacks } from '../deepgram-stream.manager.js';

export interface ServerDeepgramStreamCallbacks extends DeepgramStreamCallbacks {
  onGap: (gap: {
    startMs: number;
    endMs: number;
    reason: 'BUFFER_OVERFLOW' | 'DEEPGRAM_DISCONNECT';
  }) => void;
}

export interface ServerDeepgramStreamOptions {
  model?: string;
  endpointingMs?: number;
  sampleRate?: number;
  channels?: number;
  maxReconnects?: number;
  reconnectBaseDelayMs?: number;
  reconnectMaxDelayMs?: number;
  bufferDurationMs?: number;
  /** Resume canonical transcript timestamps after a prior worker attempt. */
  initialTimelineMs?: number;
}

interface BufferedPcmChunk {
  bytes: Buffer;
  startMs: number;
  endMs: number;
}

/**
 * Deepgram stream for server-side headerless PCM from FFmpeg.
 *
 * Unlike browser WebM, linear16 can safely reconnect at an arbitrary chunk
 * boundary. Audio received while the socket reopens is buffered, and each new
 * Deepgram socket gets a global timeline base so its zero-based timestamps remain
 * monotonic in the canonical hearing transcript.
 */
export class ServerDeepgramStreamManager {
  private readonly logger = new Logger(ServerDeepgramStreamManager.name);
  private readonly model: string;
  private readonly endpointingMs: number;
  private readonly sampleRate: number;
  private readonly channels: number;
  private readonly maxReconnects: number;
  private readonly reconnectBaseDelayMs: number;
  private readonly reconnectMaxDelayMs: number;
  private readonly maxBufferBytes: number;

  private connection?: ListenLiveClient;
  private connectionGeneration = 0;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private keepAliveTimer?: ReturnType<typeof setInterval>;
  private drainTimer?: ReturnType<typeof setTimeout>;
  private nextSendAt = 0;
  private reconnectAttempt = 0;
  private reconnectScheduled = false;
  private started = false;
  private opened = false;
  private stopped = false;
  private terminalErrorSent = false;
  private connectionBaseMs = 0;
  private sourceCursorMs = 0;
  private bufferedBytes = 0;
  private buffer: BufferedPcmChunk[] = [];
  private closeWaiters = new Set<() => void>();
  private lastConnectionError?: Error;

  constructor(
    private readonly apiKey: string,
    private readonly callbacks: ServerDeepgramStreamCallbacks,
    options?: ServerDeepgramStreamOptions,
  ) {
    if (!apiKey.trim()) throw new Error('Deepgram API key is required');
    this.model = options?.model?.trim() || 'nova-3';
    this.endpointingMs = boundedInteger(options?.endpointingMs ?? 300, 1, 10_000, 'endpointingMs');
    this.sampleRate = boundedInteger(options?.sampleRate ?? 16_000, 8_000, 48_000, 'sampleRate');
    this.channels = boundedInteger(options?.channels ?? 1, 1, 2, 'channels');
    this.maxReconnects = boundedInteger(options?.maxReconnects ?? 5, 0, 20, 'maxReconnects');
    this.reconnectBaseDelayMs = boundedInteger(
      options?.reconnectBaseDelayMs ?? 500,
      50,
      60_000,
      'reconnectBaseDelayMs',
    );
    this.reconnectMaxDelayMs = Math.max(
      this.reconnectBaseDelayMs,
      boundedInteger(
        options?.reconnectMaxDelayMs ?? 10_000,
        50,
        120_000,
        'reconnectMaxDelayMs',
      ),
    );
    const bufferDurationMs = boundedInteger(
      options?.bufferDurationMs ?? 30_000,
      1_000,
      5 * 60_000,
      'bufferDurationMs',
    );
    this.maxBufferBytes = Math.ceil(
      (this.sampleRate * this.channels * 2 * bufferDurationMs) / 1_000,
    );
    this.sourceCursorMs = boundedNonNegative(
      options?.initialTimelineMs ?? 0,
      'initialTimelineMs',
    );
    this.connectionBaseMs = this.sourceCursorMs;
  }

  get isOpen(): boolean {
    return this.opened;
  }

  get bufferedDurationMs(): number {
    return this.bytesToMs(this.bufferedBytes);
  }

  get timelineCursorMs(): number {
    return this.sourceCursorMs;
  }

  start(): void {
    if (this.started || this.stopped) return;
    this.started = true;
    this.openConnection();
  }

  /**
   * Accept one contiguous PCM chunk. `true` means it was sent or safely buffered;
   * `false` means the manager reached a terminal state and the worker must stop.
   */
  sendAudio(chunk: Buffer): boolean {
    if (this.stopped || this.terminalErrorSent || chunk.byteLength === 0) return false;
    const startMs = this.sourceCursorMs;
    const endMs = startMs + this.bytesToMs(chunk.byteLength);
    this.sourceCursorMs = endMs;
    const bufferedChunk: BufferedPcmChunk = {
      bytes: Buffer.from(chunk),
      startMs,
      endMs,
    };

    if (!this.bufferChunk(bufferedChunk)) return false;
    this.flushBuffer();
    return !this.terminalErrorSent;
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.opened = false;
    this.clearConnectionTimers();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    this.reconnectScheduled = false;
    this.buffer = [];
    this.bufferedBytes = 0;
    try {
      this.connection?.requestClose();
    } catch {
      this.resolveCloseWaiters();
    }
  }

  /**
   * Give a reconnecting socket a bounded chance to flush buffered PCM before
   * requesting Deepgram finalization. Any bytes still buffered at the deadline
   * are surfaced as an explicit transcript gap rather than silently discarded.
   */
  async stopAndWait(timeoutMs = 2_500): Promise<void> {
    if (this.stopped) return;
    const timeout = boundedInteger(timeoutMs, 1, 60_000, 'timeoutMs');
    const deadline = Date.now() + timeout;
    await this.waitForBufferDrain(deadline);
    if (this.buffer.length > 0) {
      this.emitBufferedGap('DEEPGRAM_DISCONNECT');
    }

    const connection = this.connection;
    if (!connection) {
      this.stop();
      return;
    }

    const remainingMs = Math.max(1, deadline - Date.now());
    await new Promise<void>((resolve) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const waiter = () => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        this.closeWaiters.delete(waiter);
        resolve();
      };
      this.closeWaiters.add(waiter);
      timer = setTimeout(waiter, remainingMs);
      this.stop();
    });
    // CloseStream is only a protocol request. Release a socket that never
    // acknowledges it, and ignore finals arriving after the drain deadline.
    this.connectionGeneration += 1;
    try { connection.disconnect(); } catch { /* Bounded shutdown is complete. */ }
  }

  private openConnection(): void {
    if (this.stopped || this.terminalErrorSent) return;
    this.reconnectScheduled = false;
    this.lastConnectionError = undefined;

    const generation = ++this.connectionGeneration;
    try { this.connection?.disconnect(); } catch { /* Retired socket cleanup. */ }
    const deepgram = createClient(this.apiKey);
    const connection = deepgram.listen.live({
      model: this.model,
      interim_results: true,
      diarize: true,
      punctuate: true,
      smart_format: true,
      endpointing: this.endpointingMs,
      encoding: 'linear16',
      sample_rate: this.sampleRate,
      channels: this.channels,
    });
    this.connection = connection;
    const isCurrent = () =>
      this.connection === connection && this.connectionGeneration === generation;

    connection.on(LiveTranscriptionEvents.Open, () => {
      if (!isCurrent() || this.stopped) {
        try {
          connection.requestClose();
        } catch {
          // Stale sockets are best-effort cleanup only.
        }
        return;
      }
      this.opened = true;
      this.nextSendAt = Date.now();
      this.connectionBaseMs = this.buffer[0]?.startMs ?? this.sourceCursorMs;
      // A recess or a stalled media input must not hit Deepgram's 10-second
      // idle timeout. The SDK sends KeepAlive as a text control message.
      this.keepAliveTimer = setInterval(() => {
        if (!isCurrent() || !this.opened || this.stopped) return;
        try {
          connection.keepAlive();
        } catch (error) {
          this.opened = false;
          this.scheduleReconnect(error instanceof Error ? error : new Error(String(error)));
          try { connection.requestClose(); } catch { /* Reconnect owns recovery. */ }
        }
      }, 3_000);
      this.logger.log(
        `server deepgram open model=${this.model} sampleRate=${this.sampleRate} ` +
          `channels=${this.channels} baseMs=${Math.round(this.connectionBaseMs)}`,
      );
      this.callbacks.onOpen();
      this.flushBuffer();
    });

    connection.on(LiveTranscriptionEvents.Transcript, (data: DeepgramTranscript) => {
      if (!isCurrent()) return;
      const alternative = data.channel?.alternatives?.[0];
      if (!alternative?.transcript) return;
      // A real transcript proves the replacement socket is healthy; only then
      // reset the consecutive reconnect budget.
      this.reconnectAttempt = 0;
      const localStartMs = Math.round((data.start ?? 0) * 1_000);
      const localEndMs = Math.round(((data.start ?? 0) + (data.duration ?? 0)) * 1_000);
      const startMs = Math.round(this.connectionBaseMs + localStartMs);
      const endMs = Math.max(startMs, Math.round(this.connectionBaseMs + localEndMs));
      const speakerLabel =
        alternative.words?.[0]?.speaker != null
          ? String(alternative.words[0].speaker)
          : undefined;

      if (data.is_final) {
        this.callbacks.onFinal({
          startMs,
          endMs,
          text: alternative.transcript,
          speakerLabel,
          confidence: alternative.confidence,
        });
      } else {
        this.callbacks.onInterim({
          startMs,
          endMs,
          text: alternative.transcript,
          speakerLabel,
        });
      }
    });

    connection.on(LiveTranscriptionEvents.Error, (error: unknown) => {
      if (!isCurrent() || this.stopped) return;
      this.lastConnectionError = error instanceof Error ? error : new Error(String(error));
      this.logger.warn(`server deepgram error: ${this.lastConnectionError.message}`);
      this.opened = false;
      this.scheduleReconnect(this.lastConnectionError);
      try {
        connection.requestClose();
      } catch {
        // Reconnect is already scheduled; Close is not required to proceed.
      }
    });

    connection.on(LiveTranscriptionEvents.Close, (event: unknown) => {
      if (!isCurrent()) return;
      this.opened = false;
      const close = event as { code?: number; reason?: string } | undefined;
      this.logger.warn(
        `server deepgram close code=${close?.code ?? '?'} reason=${close?.reason || '(none)'} ` +
          `stopped=${this.stopped}`,
      );
      this.resolveCloseWaiters();
      if (!this.stopped) {
        this.scheduleReconnect(
          this.lastConnectionError ??
            new Error(`Deepgram closed unexpectedly (${close?.code ?? 'unknown'})`),
        );
      }
    });
  }

  private scheduleReconnect(cause: Error): void {
    this.clearConnectionTimers();
    if (this.reconnectScheduled || this.stopped || this.terminalErrorSent) return;
    if (this.reconnectAttempt >= this.maxReconnects) {
      this.emitBufferedGap('DEEPGRAM_DISCONNECT');
      this.emitTerminalError(
        new Error(`Server transcription reconnect limit reached: ${cause.message}`),
      );
      return;
    }

    this.reconnectAttempt += 1;
    this.reconnectScheduled = true;
    this.callbacks.onReconnecting(this.reconnectAttempt);
    const delay = Math.min(
      this.reconnectMaxDelayMs,
      this.reconnectBaseDelayMs * 2 ** (this.reconnectAttempt - 1),
    );
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.openConnection();
    }, delay);
  }

  private flushBuffer(): void {
    if (this.drainTimer) return;
    while (this.opened && this.buffer.length > 0) {
      const waitMs = this.nextSendAt - Date.now();
      if (waitMs > 0) {
        this.drainTimer = setTimeout(() => {
          this.drainTimer = undefined;
          this.flushBuffer();
        }, Math.ceil(waitMs));
        return;
      }
      const chunk = this.buffer[0]!;
      // Pace both HLS bursts and reconnect replay. Sending the whole backlog
      // synchronously exceeds the provider's 1.25x realtime input limit.
      const size = Math.min(chunk.bytes.byteLength, this.sampleRate * this.channels * 2 / 10);
      const bytes = chunk.bytes.subarray(0, size);
      if (!this.sendToConnection(bytes)) return;
      const durationMs = this.bytesToMs(bytes.byteLength);
      this.nextSendAt = Date.now() + durationMs / 1.25;
      this.bufferedBytes -= bytes.byteLength;
      if (size === chunk.bytes.byteLength) this.buffer.shift();
      else {
        chunk.bytes = chunk.bytes.subarray(size);
        chunk.startMs += durationMs;
      }
    }
  }

  private bufferChunk(chunk: BufferedPcmChunk): boolean {
    if (this.bufferedBytes + chunk.bytes.byteLength > this.maxBufferBytes) {
      const gapStart = this.buffer[0]?.startMs ?? chunk.startMs;
      const gapEnd = chunk.endMs;
      this.buffer = [];
      this.bufferedBytes = 0;
      this.callbacks.onGap({ startMs: gapStart, endMs: gapEnd, reason: 'BUFFER_OVERFLOW' });
      this.emitTerminalError(
        new Error('Server transcription PCM buffer overflowed during reconnect'),
      );
      return false;
    }
    this.buffer.push(chunk);
    this.bufferedBytes += chunk.bytes.byteLength;
    return true;
  }

  private sendToConnection(chunk: Buffer): boolean {
    if (!this.connection || !this.opened) return false;
    try {
      const arrayBuffer = chunk.buffer.slice(
        chunk.byteOffset,
        chunk.byteOffset + chunk.byteLength,
      ) as ArrayBuffer;
      this.connection.send(arrayBuffer);
      return true;
    } catch (error) {
      const cause = error instanceof Error ? error : new Error(String(error));
      this.logger.warn(`server Deepgram send failed: ${cause.message}`);
      this.opened = false;
      this.scheduleReconnect(cause);
      try {
        this.connection?.requestClose();
      } catch {
        // The reconnect timer is already the recovery authority.
      }
      return false;
    }
  }

  private async waitForBufferDrain(deadlineMs: number): Promise<void> {
    while (
      this.buffer.length > 0 &&
      !this.terminalErrorSent &&
      !this.stopped &&
      Date.now() < deadlineMs
    ) {
      if (this.opened) this.flushBuffer();
      if (this.buffer.length === 0) return;
      await delay(Math.min(25, Math.max(1, deadlineMs - Date.now())));
    }
  }

  private emitBufferedGap(reason: 'DEEPGRAM_DISCONNECT'): void {
    const first = this.buffer[0];
    if (!first) return;
    const last = this.buffer.at(-1)!;
    this.callbacks.onGap({ startMs: first.startMs, endMs: last.endMs, reason });
    this.buffer = [];
    this.bufferedBytes = 0;
  }

  private bytesToMs(bytes: number): number {
    return (bytes / (this.sampleRate * this.channels * 2)) * 1_000;
  }

  private emitTerminalError(error: Error): void {
    if (this.terminalErrorSent || this.stopped) return;
    this.terminalErrorSent = true;
    this.opened = false;
    this.clearConnectionTimers();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    this.reconnectScheduled = false;
    try {
      this.connection?.requestClose();
    } catch {
      this.resolveCloseWaiters();
    }
    this.callbacks.onError(error);
  }

  private resolveCloseWaiters(): void {
    const waiters = [...this.closeWaiters];
    this.closeWaiters.clear();
    for (const resolve of waiters) resolve();
  }

  private clearConnectionTimers(): void {
    if (this.keepAliveTimer) clearInterval(this.keepAliveTimer);
    if (this.drainTimer) clearTimeout(this.drainTimer);
    this.keepAliveTimer = undefined;
    this.drainTimer = undefined;
  }
}

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

function boundedInteger(
  value: number,
  min: number,
  max: number,
  field: string,
): number {
  if (!Number.isFinite(value)) throw new Error(`${field} must be finite`);
  const integer = Math.floor(value);
  if (integer < min || integer > max) {
    throw new Error(`${field} must be between ${min} and ${max}`);
  }
  return integer;
}

function boundedNonNegative(value: number, field: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${field} must be a finite non-negative number`);
  }
  return Math.floor(value);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
