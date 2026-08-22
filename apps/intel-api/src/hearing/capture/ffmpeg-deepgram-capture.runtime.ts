import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import { Logger } from '@nestjs/common';
import type { FinalSegment, InterimSegment } from '../hearing.types.js';
import {
  buildValidatedFfmpegAudioCommand,
  type FfmpegAudioCommand,
} from './ffmpeg-audio-command.js';
import type { CaptureGap } from './public-hearing-capture-state.js';
import type { PublicCaptureRuntimePort } from './public-capture.orchestrator.js';
import {
  ServerDeepgramStreamManager,
  type ServerDeepgramStreamCallbacks,
  type ServerDeepgramStreamOptions,
} from './server-deepgram-stream.manager.js';

export interface PublicTranscriptSinkPort {
  appendFinal(input: {
    captureId: string;
    hearingId: string;
    segment: FinalSegment;
  }): Promise<void>;
  publishInterim?(input: {
    captureId: string;
    hearingId: string;
    segment: InterimSegment;
  }): Promise<void>;
  appendGap(input: {
    captureId: string;
    hearingId: string;
    gap: CaptureGap;
  }): Promise<void>;
}

type FfmpegProcess = ChildProcessByStdio<null, Readable, Readable>;

export interface ServerTranscriberPort {
  readonly timelineCursorMs: number;
  start(): void;
  sendAudio(chunk: Buffer): boolean;
  stopAndWait(timeoutMs?: number): Promise<void>;
}

export interface FfmpegProcessFactoryPort {
  spawn(command: FfmpegAudioCommand): FfmpegProcess;
}

export class NodeFfmpegProcessFactory implements FfmpegProcessFactoryPort {
  spawn(command: FfmpegAudioCommand): FfmpegProcess {
    return spawn(command.executable, command.args, {
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
  }
}

function captureRuntimeFailure(
  cause: unknown,
  capturedMs: number,
  gaps: CaptureGap[],
): Error & { capturedMs: number; captureGaps: CaptureGap[] } {
  const error = cause instanceof Error ? cause : new Error(String(cause));
  return Object.assign(error, { capturedMs, captureGaps: [...gaps] });
}

export interface FfmpegDeepgramCaptureRuntimeOptions {
  sampleRate?: number;
  channels?: number;
  deepgram?: Omit<ServerDeepgramStreamOptions, 'sampleRate' | 'channels' | 'initialTimelineMs'>;
  ffmpegTerminationGraceMs?: number;
  maxStderrBytes?: number;
  processFactory?: FfmpegProcessFactoryPort;
  buildCommand?: typeof buildValidatedFfmpegAudioCommand;
  createTranscriber?: (
    callbacks: ServerDeepgramStreamCallbacks,
    options: ServerDeepgramStreamOptions,
  ) => ServerTranscriberPort;
}

/**
 * Long-running server capture runtime: approved media -> FFmpeg PCM -> Deepgram
 * -> canonical transcript sink. It never receives tenant/client context.
 */
export class FfmpegDeepgramCaptureRuntime implements PublicCaptureRuntimePort {
  private readonly logger = new Logger(FfmpegDeepgramCaptureRuntime.name);
  private readonly sampleRate: number;
  private readonly channels: number;
  private readonly terminationGraceMs: number;
  private readonly maxStderrBytes: number;
  private readonly processFactory: FfmpegProcessFactoryPort;
  private readonly buildCommand: typeof buildValidatedFfmpegAudioCommand;
  private readonly createTranscriber: NonNullable<
    FfmpegDeepgramCaptureRuntimeOptions['createTranscriber']
  >;

  constructor(
    private readonly deepgramApiKey: string,
    private readonly sink: PublicTranscriptSinkPort,
    private readonly options: FfmpegDeepgramCaptureRuntimeOptions = {},
  ) {
    if (!deepgramApiKey.trim()) throw new Error('Deepgram API key is required');
    this.sampleRate = boundedInteger(options.sampleRate ?? 16_000, 8_000, 48_000, 'sampleRate');
    this.channels = boundedInteger(options.channels ?? 1, 1, 2, 'channels');
    this.terminationGraceMs = boundedInteger(
      options.ffmpegTerminationGraceMs ?? 5_000,
      100,
      60_000,
      'ffmpegTerminationGraceMs',
    );
    this.maxStderrBytes = boundedInteger(
      options.maxStderrBytes ?? 16 * 1024,
      1_024,
      1024 * 1024,
      'maxStderrBytes',
    );
    this.processFactory = options.processFactory ?? new NodeFfmpegProcessFactory();
    this.buildCommand = options.buildCommand ?? buildValidatedFfmpegAudioCommand;
    this.createTranscriber =
      options.createTranscriber ??
      ((callbacks, managerOptions) =>
        new ServerDeepgramStreamManager(this.deepgramApiKey, callbacks, managerOptions));
  }

  async run(input: {
    captureId: string;
    hearingId: string;
    mediaUrl: string;
    officialPageUrl?: string;
    timelineOffsetMs: number;
    signal: AbortSignal;
  }): Promise<{ capturedMs: number; gaps: CaptureGap[] }> {
    if (!input.captureId.trim() || !input.hearingId.trim()) {
      throw new Error('captureId and hearingId are required');
    }
    if (!Number.isFinite(input.timelineOffsetMs) || input.timelineOffsetMs < 0) {
      throw new Error('timelineOffsetMs must be a finite non-negative number');
    }
    if (input.signal.aborted) throw abortError(input.signal.reason);

    const command = await this.buildCommand({
      mediaUrl: input.mediaUrl,
      referer: input.officialPageUrl,
      sampleRate: this.sampleRate,
      channels: this.channels,
    });

    const gaps: CaptureGap[] = [];
    let process: FfmpegProcess | undefined;
    let transcriptionError: Error | undefined;
    let sinkError: Error | undefined;
    let writeChain = Promise.resolve();
    let stderr = '';
    let stopped = false;

    const enqueueCriticalWrite = (operation: () => Promise<void>) => {
      writeChain = writeChain.then(operation).catch((error: unknown) => {
        sinkError = error instanceof Error ? error : new Error(String(error));
        stopProcess(process, this.terminationGraceMs);
      });
    };

    const callbacks: ServerDeepgramStreamCallbacks = {
      onOpen: () => undefined,
      onReconnecting: (attempt) =>
        this.logger.warn(
          `public hearing capture ${input.captureId} reconnecting Deepgram attempt=${attempt}`,
        ),
      onInterim: (segment) => {
        if (!this.sink.publishInterim) return;
        // Interim delivery is deliberately best-effort; only final segments and
        // gaps are canonical persistence requirements.
        void this.sink
          .publishInterim({ captureId: input.captureId, hearingId: input.hearingId, segment })
          .catch((error: unknown) =>
            this.logger.warn(`interim transcript publish failed: ${boundedError(error)}`),
          );
      },
      onFinal: (segment) => {
        enqueueCriticalWrite(() =>
          this.sink.appendFinal({
            captureId: input.captureId,
            hearingId: input.hearingId,
            segment,
          }),
        );
      },
      onGap: (gap) => {
        const canonicalGap: CaptureGap = { ...gap };
        gaps.push(canonicalGap);
        enqueueCriticalWrite(() =>
          this.sink.appendGap({
            captureId: input.captureId,
            hearingId: input.hearingId,
            gap: canonicalGap,
          }),
        );
      },
      onError: (error) => {
        transcriptionError = error;
        stopProcess(process, this.terminationGraceMs);
      },
    };

    const transcriber = this.createTranscriber(callbacks, {
      ...(this.options.deepgram ?? {}),
      sampleRate: this.sampleRate,
      channels: this.channels,
      initialTimelineMs: Math.floor(input.timelineOffsetMs),
    });
    transcriber.start();

    try {
      process = this.processFactory.spawn(command);
      const abortListener = () => {
        stopProcess(process, this.terminationGraceMs);
      };
      input.signal.addEventListener('abort', abortListener, { once: true });

      try {
        await new Promise<void>((resolve, reject) => {
          process!.stdout.on('data', (chunk: Buffer | Uint8Array | string) => {
            if (stopped || transcriptionError || sinkError) return;
            const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            if (bytes.byteLength === 0) return;
            if (!transcriber.sendAudio(bytes)) {
              transcriptionError ??= new Error('Server transcription rejected PCM audio');
              stopProcess(process, this.terminationGraceMs);
            }
          });
          process!.stderr.on('data', (chunk: Buffer | Uint8Array | string) => {
            if (stderr.length >= this.maxStderrBytes) return;
            stderr += Buffer.from(chunk).toString('utf8').slice(0, this.maxStderrBytes - stderr.length);
          });
          process!.once('error', (error) => reject(error));
          process!.once('close', (code, signal) => {
            if (input.signal.aborted) {
              reject(abortError(input.signal.reason));
              return;
            }
            if (transcriptionError) {
              reject(transcriptionError);
              return;
            }
            if (sinkError) {
              reject(sinkError);
              return;
            }
            if (code !== 0) {
              reject(
                new Error(
                  `FFmpeg exited with code ${code ?? 'unknown'} signal=${signal ?? 'none'}: ${boundedStderr(stderr)}`,
                ),
              );
              return;
            }
            resolve();
          });
        });
      } finally {
        stopped = true;
        input.signal.removeEventListener('abort', abortListener);
      }

      await transcriber.stopAndWait(5_000);
      await writeChain;
      if (transcriptionError) {
        throw captureRuntimeFailure(transcriptionError, transcriber.timelineCursorMs, gaps);
      }
      if (sinkError) {
        throw captureRuntimeFailure(sinkError, transcriber.timelineCursorMs, gaps);
      }
      if (transcriber.timelineCursorMs <= input.timelineOffsetMs) {
        throw captureRuntimeFailure(
          new Error('FFmpeg stream ended without producing audio'),
          transcriber.timelineCursorMs,
          gaps,
        );
      }
      return { capturedMs: Math.floor(transcriber.timelineCursorMs), gaps };
    } catch (error) {
      throw captureRuntimeFailure(error, transcriber.timelineCursorMs, gaps);
    } finally {
      stopped = true;
      stopProcess(process, this.terminationGraceMs);
      try {
        await transcriber.stopAndWait(1_000);
      } catch {
        // The primary failure remains authoritative.
      }
    }
  }
}

function stopProcess(process: FfmpegProcess | undefined, graceMs: number): void {
  if (!process || process.exitCode !== null || process.signalCode !== null) return;
  try {
    process.kill('SIGTERM');
  } catch {
    return;
  }
  const timer = setTimeout(() => {
    if (process.exitCode !== null || process.signalCode !== null) return;
    try {
      process.kill('SIGKILL');
    } catch {
      // Best-effort final termination.
    }
  }, graceMs);
  timer.unref?.();
}

function boundedInteger(value: number, min: number, max: number, field: string): number {
  if (!Number.isFinite(value)) throw new Error(`${field} must be finite`);
  const integer = Math.floor(value);
  if (integer < min || integer > max) {
    throw new Error(`${field} must be between ${min} and ${max}`);
  }
  return integer;
}

function boundedStderr(value: string): string {
  const normalized = value.replace(/[\r\n\t]+/g, ' ').trim();
  return normalized ? normalized.slice(-1_000) : 'no FFmpeg diagnostics';
}

function boundedError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/[\r\n\t]+/g, ' ')
    .trim()
    .slice(0, 1_000);
}

function abortError(reason: unknown): Error {
  const detail = reason instanceof Error ? reason.message : reason ? String(reason) : 'aborted';
  const error = new Error(`Public hearing capture aborted: ${detail}`);
  error.name = 'AbortError';
  return error;
}
