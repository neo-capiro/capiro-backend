/** Version 2 keeps AV retention and audio transcription as distinct wire lanes. */
export const VIDEO_RECORDING_MIME = 'video/webm;codecs=vp8,opus';
export const TRANSCRIPTION_MIME = 'audio/webm;codecs=opus';
export const MAX_RECORDING_BYTES = 1024 * 1024 * 1024;
export const AUDIO_RECORDING_MIMES = new Set(['audio/webm', TRANSCRIPTION_MIME]);

export function recordingContentType(mimeType: string): 'video/webm' | 'audio/webm' {
  if (mimeType === VIDEO_RECORDING_MIME) return 'video/webm';
  if (AUDIO_RECORDING_MIMES.has(mimeType)) return 'audio/webm';
  throw new Error('Unsupported recording media type');
}

export function recordingMaps(mimeType: string) {
  return recordingContentType(mimeType) === 'video/webm'
    ? ['-map', '0:v:0', '-map', '0:a:0']
    : ['-map', '0:a:0', '-vn'];
}

/** Metadata accompanies a full decode check; neither mux success nor MIME is proof. */
export function recordingProbe(
  mimeType: string,
  probe: {
    format?: { duration?: string };
    streams?: Array<{ codec_type?: string; codec_name?: string; width?: number; height?: number }>;
  },
) {
  const video = recordingContentType(mimeType) === 'video/webm';
  const audioTracks = probe.streams?.filter((s) => s.codec_type === 'audio') ?? [];
  const videoTracks = probe.streams?.filter((s) => s.codec_type === 'video') ?? [];
  if (audioTracks.length !== 1 || audioTracks[0]?.codec_name !== 'opus')
    throw new Error('Recording must contain one Opus audio track');
  if (
    video
      ? videoTracks.length !== 1 ||
        videoTracks[0]?.codec_name !== 'vp8' ||
        !videoTracks[0]?.width ||
        !videoTracks[0]?.height ||
        videoTracks[0].width > 1280 ||
        videoTracks[0].height > 720
      : videoTracks.length !== 0
  )
    throw new Error('Recording video tracks do not match negotiated media');
  const durationMs = Math.round(Number(probe.format?.duration) * 1000);
  if (!Number.isSafeInteger(durationMs) || durationMs <= 0 || durationMs > 12 * 3600_000 + 30_000)
    throw new Error('Invalid decoded media duration');
  return durationMs;
}
