import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { FfmpegAudioCommand } from './ffmpeg-audio-command.js';
import {
  FfmpegDeepgramCaptureRuntime,
  type FfmpegProcessFactoryPort,
  type PublicTranscriptSinkPort,
  type ServerTranscriberPort,
} from './ffmpeg-deepgram-capture.runtime.js';
import type { ServerDeepgramStreamCallbacks } from './server-deepgram-stream.manager.js';

class FakeFfmpegProcess extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly kill = jest.fn((signal: NodeJS.Signals = 'SIGTERM') => {
    this.signalCode = signal;
    return true;
  });

  complete(code = 0): void {
    this.exitCode = code;
    this.emit('close', code, null);
  }
}

function command(): FfmpegAudioCommand {
  return {
    executable: 'ffmpeg',
    args: ['-i', 'https://media.senate.gov/live/master.m3u8', 'pipe:1'],
    output: { encoding: 'linear16', sampleRate: 16_000, channels: 1, bytesPerSample: 2 },
  };
}

describe('FfmpegDeepgramCaptureRuntime', () => {
  it('streams PCM to the server transcriber and writes canonical finals', async () => {
    const process = new FakeFfmpegProcess();
    const appendFinal = jest.fn(async () => undefined);
    const appendGap = jest.fn(async () => undefined);
    const sink: PublicTranscriptSinkPort = { appendFinal, appendGap };
    let callbacks: ServerDeepgramStreamCallbacks | undefined;
    let timelineCursorMs = 5_000;
    const transcriber: ServerTranscriberPort = {
      get timelineCursorMs() {
        return timelineCursorMs;
      },
      start: jest.fn(),
      sendAudio: jest.fn((chunk: Buffer) => {
        timelineCursorMs += 1_000;
        callbacks?.onFinal({
          startMs: 5_000,
          endMs: 6_000,
          text: `heard ${chunk.byteLength} bytes`,
          confidence: 0.99,
        });
        return true;
      }),
      stopAndWait: jest.fn(async () => undefined),
    };
    const processFactory: FfmpegProcessFactoryPort = {
      spawn: jest.fn(() => {
        queueMicrotask(() => {
          process.stdout.write(Buffer.alloc(32_000));
          process.complete(0);
        });
        return process as never;
      }),
    };
    const runtime = new FfmpegDeepgramCaptureRuntime('platform-key', sink, {
      processFactory,
      buildCommand: jest.fn(async () => command()),
      createTranscriber: (nextCallbacks) => {
        callbacks = nextCallbacks;
        return transcriber;
      },
    });

    const result = await runtime.run({
      captureId: 'capture-1',
      hearingId: 'hearing-1',
      mediaUrl: 'https://media.senate.gov/live/master.m3u8',
      officialPageUrl: 'https://www.armed-services.senate.gov/hearings/example',
      timelineOffsetMs: 5_000,
      signal: new AbortController().signal,
    });

    expect(result).toEqual({ capturedMs: 6_000, gaps: [] });
    expect(transcriber.sendAudio).toHaveBeenCalledWith(expect.any(Buffer));
    expect(appendFinal).toHaveBeenCalledWith(
      expect.objectContaining({
        captureId: 'capture-1',
        hearingId: 'hearing-1',
        segment: expect.objectContaining({ text: 'heard 32000 bytes' }),
      }),
    );
  });

  it('fails the capture when FFmpeg exits non-zero and keeps stderr bounded', async () => {
    const process = new FakeFfmpegProcess();
    const runtime = new FfmpegDeepgramCaptureRuntime(
      'platform-key',
      {
        appendFinal: jest.fn(async () => undefined),
        appendGap: jest.fn(async () => undefined),
      },
      {
        processFactory: {
          spawn: jest.fn(() => {
            queueMicrotask(() => {
              process.stderr.write('upstream refused the manifest');
              process.complete(1);
            });
            return process as never;
          }),
        },
        buildCommand: jest.fn(async () => command()),
        createTranscriber: () => ({
          timelineCursorMs: 0,
          start: jest.fn(),
          sendAudio: jest.fn(() => true),
          stopAndWait: jest.fn(async () => undefined),
        }),
      },
    );

    await expect(
      runtime.run({
        captureId: 'capture-1',
        hearingId: 'hearing-1',
        mediaUrl: 'https://media.senate.gov/live/master.m3u8',
        timelineOffsetMs: 0,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/upstream refused the manifest/);
  });
});
