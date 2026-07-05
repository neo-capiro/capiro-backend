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
 *  - `-protocol_whitelist crypto,data,http,https,tcp,tls` — restricts what a
 *    fetched manifest can pull in. `file` is DELIBERATELY EXCLUDED so a malicious
 *    HLS manifest cannot make ffmpeg read local files; `crypto`+`data` stay for
 *    AES-128 HLS keys + inline data URIs.
 *
 * REDIRECTS: we do NOT pass `-follow_redirects 0` — the ffmpeg build shipped in
 * the runtime image (Debian bookworm, apt) rejects that option at argument-parse
 * time ("Unrecognized option 'follow_redirects'" -> "Error splitting the argument
 * list"), which aborts ffmpeg BEFORE it opens any input and silently broke all
 * ingestion. ffmpeg therefore follows 3xx as usual. The redirect vector is
 * covered instead by (a) the resolver handing us the FINAL post-redirect URL
 * (guardedProbe re-validates every hop) so ffmpeg normally has nothing to follow,
 * and (b) the network-layer egress deny.
 * RESIDUAL: a redirect — or a malicious manifest listing ABSOLUTE segment URIs —
 * pointing at an internal IP is fetched by ffmpeg unseen. See net-guard.ts
 * "RESIDUAL RISK" note and the TODO(infra) egress-deny follow-up, the real fix.
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
      // SSRF hardening (P8): restrict the protocols a fetched manifest may pull
      // in. `file` is DELIBERATELY OMITTED so a malicious HLS manifest can't make
      // ffmpeg read local files; crypto+data stay for AES-128 HLS keys + inline
      // data URIs. Must precede `-i`.
      //
      // NOTE: we intentionally do NOT pass `-follow_redirects 0` here — the
      // runtime image's ffmpeg build rejects that option and aborts before it
      // opens ANY input (it silently broke all ingestion). See the class-doc
      // "REDIRECTS" note for how the redirect vector is covered instead.
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
    let bytesEmitted = 0;
    let lastStderr = '';
    proc.stdout.on('data', (chunk: Buffer) => {
      if (stopped) return;
      bytesEmitted += chunk.length;
      cb.onAudio(chunk);
    });
    proc.stderr.on('data', (d: Buffer) => {
      const text = d.toString().trim();
      if (!text) return;
      // Keep the most recent non-empty line — ffmpeg's last stderr line is the
      // useful one for the operator ("Server returned 404 Not Found", "Invalid
      // data found when processing input", etc.).
      lastStderr = text.split('\n').filter(Boolean).pop() ?? text;
      this.logger.warn(`ffmpeg: ${text}`);
    });
    proc.on('error', (err) => {
      if (!stopped) cb.onError(new Error(`Could not start ffmpeg: ${err.message}`));
    });
    proc.on('close', (code) => {
      if (stopped) return;
      // Distinguish a real failure-to-open from a benign end. ZERO audio means
      // ffmpeg never opened the stream (dead/expired live URL, 404, geoblock,
      // unparseable manifest, or — historically — a rejected ffmpeg arg): surface
      // it as an actionable error carrying ffmpeg's own last line, so the UI can
      // say WHY nothing transcribed instead of showing an empty room. If audio
      // DID flow, a non-zero exit just means the live stream dropped or ended.
      if (bytesEmitted === 0) {
        const detail =
          lastStderr || `ffmpeg exited (code ${code ?? 'null'}) before producing any audio`;
        cb.onError(new Error(`Could not open the stream: ${detail}`));
      } else {
        cb.onEnd(code === 0 ? 'completed' : `stream ended (code ${code})`);
      }
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
