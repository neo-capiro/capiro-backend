import { Injectable, Logger } from '@nestjs/common';
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';

export interface IngestionHandle {
  stop(): void;
  readonly pid?: number;
}

export interface IngestionCallbacks {
  onAudio: (pcm: Buffer) => void;
  onEnd: (reason: string) => void;
  onError: (err: Error) => void;
}

/**
 * Server-side audio ingestion for a hearing session.
 *
 * Pulls a public hearing audio/video stream (HLS .m3u8, direct MP3/AAC, or any
 * URL ffmpeg can open) and decodes it to raw 16 kHz mono linear16 PCM, emitting
 * chunks to `onAudio` — which the gateway forwards to that session's Deepgram
 * socket (configured with encoding=linear16, sample_rate=16000).
 *
 * This is the "paste a hearing URL and it transcribes" path: the browser becomes
 * a viewer, not the audio source. One ffmpeg process per active ingestion.
 *
 * SAFETY: read-only pull; no audio is persisted here (recording policy governs
 * downstream storage). ffmpeg is sandboxed to the given URL and killed on stop,
 * session end, or the gateway's max-duration cap.
 */
@Injectable()
export class StreamIngestionService {
  private readonly logger = new Logger(StreamIngestionService.name);

  /** Sample rate the decoded PCM is produced at; must match the Deepgram config. */
  static readonly SAMPLE_RATE = 16000;

  start(audioUrl: string, cb: IngestionCallbacks): IngestionHandle {
    // Validate scheme early — only http(s). Prevents file:// / pipe: abuse.
    let parsed: URL;
    try {
      parsed = new URL(audioUrl);
    } catch {
      throw new Error('Invalid audio URL');
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error('Audio URL must be http(s)');
    }

    const args = [
      '-loglevel',
      'error',
      // Reconnect on transient network drops (live streams stutter).
      '-reconnect',
      '1',
      '-reconnect_streamed',
      '1',
      '-reconnect_delay_max',
      '5',
      '-i',
      audioUrl,
      '-vn', // drop video — audio only
      '-ac',
      '1', // mono
      '-ar',
      String(StreamIngestionService.SAMPLE_RATE),
      '-f',
      's16le', // raw linear16
      'pipe:1',
    ];

    let proc: ChildProcessByStdio<null, Readable, Readable>;
    try {
      proc = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      throw new Error(`Failed to start ffmpeg: ${(err as Error).message}`);
    }

    let stopped = false;
    proc.stdout.on('data', (chunk: Buffer) => {
      if (!stopped) cb.onAudio(chunk);
    });
    proc.stderr.on('data', (d: Buffer) => {
      const line = d.toString().trim();
      if (line) this.logger.warn(`ffmpeg: ${line}`);
    });
    proc.on('error', (err) => {
      if (!stopped) cb.onError(new Error(`ffmpeg spawn error: ${err.message}`));
    });
    proc.on('close', (code) => {
      if (!stopped) cb.onEnd(`ffmpeg exited (code ${code ?? 'null'})`);
    });

    this.logger.log(`ingestion started pid=${proc.pid} url=${parsed.host}${parsed.pathname}`);

    return {
      pid: proc.pid,
      stop: () => {
        if (stopped) return;
        stopped = true;
        try {
          proc.kill('SIGKILL');
        } catch {
          /* already gone */
        }
      },
    };
  }
}
