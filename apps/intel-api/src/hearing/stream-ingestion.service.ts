import { Injectable, Logger } from '@nestjs/common';
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import { assertUrlAllowed, BROWSER_UA, isHostAllowed, SsrfError } from './net-guard.js';

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
 *
 * SSRF (P8): before spawning ffmpeg on an operator-supplied URL, the caller MUST
 * `await assertIngestible(url)` — host allowlist + private/link-local IP deny +
 * DNS-rebind check (net-guard.ts). `start()` also does a synchronous scheme +
 * allowlist re-check as defense-in-depth so ffmpeg is NEVER pointed at an
 * arbitrary host even if a caller forgets the async gate. ffmpeg is also given a
 * browser UA (gov/broadcast HLS origins reject a bare ffmpeg UA).
 *
 * ffmpeg does its OWN network I/O once spawned, so `start()` also locks it down:
 *  - `-follow_redirects 0` — ffmpeg's http protocol follows 3xx by default; a
 *    redirect off an allowlisted host would bypass the guard. The resolver hands
 *    us the FINAL post-redirect URL (guardedProbe re-validated every hop), so
 *    ffmpeg never needs to follow a redirect itself.
 *  - `-protocol_whitelist crypto,data,http,https,tcp,tls` — restricts what a
 *    fetched manifest can pull in. `file` is DELIBERATELY EXCLUDED so a malicious
 *    HLS manifest cannot make ffmpeg read local files; `crypto`+`data` stay for
 *    AES-128 HLS keys + inline data URIs.
 * RESIDUAL: a malicious manifest on an allowlisted host can still list ABSOLUTE
 * http(s) segment URIs at internal IPs — see net-guard.ts "RESIDUAL RISK" note
 * and the TODO(infra) egress-deny follow-up.
 */
@Injectable()
export class StreamIngestionService {
  private readonly logger = new Logger(StreamIngestionService.name);

  /** Sample rate the decoded PCM is produced at; must match the Deepgram config. */
  static readonly SAMPLE_RATE = 16000;

  /**
   * Async SSRF gate — call (and await) this BEFORE `start()`. Enforces the
   * host allowlist and resolves the host, denying any private/link-local IP
   * (anti-rebind). Throws `SsrfError` on a policy violation. `start()` itself is
   * synchronous (spawns ffmpeg), so the async DNS check has to happen here.
   */
  async assertIngestible(audioUrl: string): Promise<void> {
    await assertUrlAllowed(audioUrl);
  }

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
    // Defense-in-depth: synchronous host-allowlist re-check (the full DNS/IP-deny
    // check runs in `assertIngestible`, which the gateway awaits first). This
    // guarantees ffmpeg is never spawned against a non-allowlisted host.
    try {
      // assertUrlAllowed with skipDnsCheck is synchronous-safe (no await needed
      // for the allowlist branch); we only need the host check here.
      if (!isHostAllowed(parsed.hostname)) {
        throw new SsrfError(`Host not allowed: ${parsed.hostname}`);
      }
    } catch (err) {
      throw err instanceof SsrfError ? err : new Error('Audio URL rejected by network policy');
    }

    const args = [
      '-loglevel',
      'error',
      // Browser UA — gov/broadcast HLS origins (Akamai, C-SPAN CDN) 403 a bare
      // ffmpeg/lavf UA. Must precede `-i` (it is an input/protocol option).
      '-user_agent',
      BROWSER_UA,
      // Pace the input to real time (native timestamp rate). For a LIVE stream
      // this is a near no-op (already ~realtime); for a RECORDING it is
      // essential — without it ffmpeg decodes the whole file in seconds and
      // floods Deepgram's realtime socket far faster than it opens/accepts, so
      // the audio is dropped and zero transcripts come back. `-re` must precede
      // `-i` (it is an input option).
      '-re',
      // Reconnect on transient network drops (live streams stutter).
      '-reconnect',
      '1',
      '-reconnect_streamed',
      '1',
      '-reconnect_delay_max',
      '5',
      // SSRF hardening (P8): ffmpeg does its own fetching once spawned. Do NOT let
      // it follow HTTP redirects (the resolver already handed us the final,
      // guard-validated URL) — a redirect off an allowlisted host would bypass
      // net-guard. Must precede `-i` (it is an http-protocol input option).
      '-follow_redirects',
      '0',
      // Restrict the protocols a fetched manifest may pull in. `file` is
      // DELIBERATELY OMITTED so a malicious HLS manifest can't make ffmpeg read
      // local files; crypto+data stay for AES-128 HLS keys + inline data URIs.
      // Must precede `-i`.
      '-protocol_whitelist',
      'crypto,data,http,https,tcp,tls',
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
