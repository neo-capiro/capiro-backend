import { assertUrlAllowed, BROWSER_UA, isHostAllowed, isPrivateIp } from '../net-guard.js';

export interface FfmpegAudioCommandInput {
  mediaUrl: string;
  userAgent?: string;
  referer?: string;
  sampleRate?: number;
  channels?: number;
  reconnectDelayMaxSec?: number;
  readTimeoutMs?: number;
}

export interface FfmpegAudioCommand {
  executable: 'ffmpeg';
  args: string[];
  output: {
    encoding: 'linear16';
    sampleRate: number;
    channels: number;
    bytesPerSample: 2;
  };
}

/**
 * Build argv for spawn/execFile. Never concatenate this into a shell command.
 * The media URL is one argv element and credentials/CRLF are rejected.
 */

/**
 * Worker entry point: re-run DNS/IP validation immediately before spawning
 * FFmpeg. This keeps resolution and media consumption in the same egress
 * environment and closes the gap between a previously-probed URL and capture.
 */
export async function buildValidatedFfmpegAudioCommand(
  input: FfmpegAudioCommandInput,
): Promise<FfmpegAudioCommand> {
  await assertUrlAllowed(input.mediaUrl);
  // A canonical event page may be a provenance URL (for example congress.gov)
  // that is intentionally outside the media resolver's fetch allowlist. Do not
  // fail an otherwise valid first-party media capture or leak an arbitrary
  // reference header; transmit a Referer only when it passes the same guarded
  // host and DNS/IP policy as a server-side fetch.
  const referer = captureRefererIfAllowed(input.referer);
  if (referer) await assertUrlAllowed(referer);
  return buildFfmpegAudioCommand({ ...input, referer });
}

export function buildFfmpegAudioCommand(input: FfmpegAudioCommandInput): FfmpegAudioCommand {
  const mediaUrl = assertCaptureMediaUrl(input.mediaUrl);
  const sampleRate = boundedInteger(input.sampleRate ?? 16_000, 8_000, 48_000);
  const channels = boundedInteger(input.channels ?? 1, 1, 2);
  const reconnectDelayMaxSec = boundedInteger(input.reconnectDelayMaxSec ?? 5, 1, 30);
  const readTimeoutMs = boundedInteger(input.readTimeoutMs ?? 15_000, 1_000, 120_000);
  const userAgent = sanitizeHeaderValue(input.userAgent ?? BROWSER_UA);
  const referer = input.referer ? assertCaptureReferer(input.referer) : undefined;

  const args = [
    '-hide_banner',
    '-loglevel',
    'warning',
    '-nostdin',
    '-rw_timeout',
    String(readTimeoutMs * 1_000),
    '-protocol_whitelist',
    'https,tls,tcp,crypto',
    '-user_agent',
    userAgent,
    ...(referer ? ['-referer', referer] : []),
    '-reconnect',
    '1',
    '-reconnect_streamed',
    '1',
    '-reconnect_on_network_error',
    '1',
    '-reconnect_delay_max',
    String(reconnectDelayMaxSec),
    // HLS segments and archive media can otherwise decode far faster than the
    // speech provider accepts, overflowing the bounded reconnect PCM queue.
    '-re',
    '-i',
    mediaUrl,
    '-map',
    '0:a:0?',
    '-vn',
    '-sn',
    '-dn',
    '-ac',
    String(channels),
    '-ar',
    String(sampleRate),
    '-acodec',
    'pcm_s16le',
    '-f',
    's16le',
    'pipe:1',
  ];

  return {
    executable: 'ffmpeg',
    args,
    output: { encoding: 'linear16', sampleRate, channels, bytesPerSample: 2 },
  };
}


export function captureRefererIfAllowed(rawUrl: string | undefined): string | undefined {
  if (!rawUrl) return undefined;
  try {
    const url = new URL(rawUrl);
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      /[\r\n\0]/.test(rawUrl) ||
      !isHostAllowed(url.hostname)
    ) {
      return undefined;
    }
    return url.toString();
  } catch {
    return undefined;
  }
}

export function assertCaptureMediaUrl(rawUrl: string): string {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error('Capture media URL is invalid');
  }
  if (url.protocol !== 'https:') throw new Error('Capture media URL must use HTTPS');
  if (url.username || url.password) throw new Error('Capture media URL must not contain credentials');
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  if (!hostname || isPrivateIp(hostname) || !isHostAllowed(hostname)) {
    throw new Error('Capture media URL host is not allowed');
  }
  return url.toString();
}

function assertCaptureReferer(rawUrl: string): string {
  const referer = assertCaptureMediaUrl(rawUrl);
  return sanitizeHeaderValue(referer);
}

function sanitizeHeaderValue(value: string): string {
  const normalized = value.trim();
  if (!normalized || /[\r\n\0]/.test(normalized)) {
    throw new Error('FFmpeg header value is invalid');
  }
  return normalized.slice(0, 512);
}

function boundedInteger(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) throw new Error('FFmpeg numeric option must be finite');
  return Math.max(min, Math.min(max, Math.floor(value)));
}
