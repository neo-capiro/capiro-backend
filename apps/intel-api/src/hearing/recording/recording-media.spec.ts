import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AUDIO_RECORDING_MIMES,
  VIDEO_RECORDING_MIME,
  recordingContentType,
  recordingMaps,
  recordingProbe,
} from './recording-media.js';
import { decodeRecordingFrame } from './recording-domain.js';

it('keeps negotiated wire lanes distinct and rejects old/new mismatches', () => {
  for (const magic of ['LWA4', 'LWV5', 'LWT5'] as const) {
    const frame = Buffer.alloc(20);
    frame.write(magic);
    frame.writeDoubleBE(1000, 8);
    expect(decodeRecordingFrame(frame, magic).endMs).toBe(1000);
    for (const other of ['LWA4', 'LWV5', 'LWT5'] as const)
      if (other !== magic) expect(() => decodeRecordingFrame(frame, other)).toThrow();
  }
});

it('does not declare an audio-only or unsupported artifact to be video', () => {
  const audio = {
    format: { duration: '1' },
    streams: [{ codec_type: 'audio', codec_name: 'opus' }],
  };
  expect(recordingProbe('audio/webm', audio)).toBe(1000);
  expect(() => recordingProbe(VIDEO_RECORDING_MIME, audio)).toThrow();
  for (const mime of AUDIO_RECORDING_MIMES) expect(recordingContentType(mime)).toBe('audio/webm');
  expect(recordingContentType(VIDEO_RECORDING_MIME)).toBe('video/webm');
  expect(() => recordingContentType('video/webm')).toThrow();
  const av = {
    ...audio,
    streams: [
      ...audio.streams,
      { codec_type: 'video', codec_name: 'vp8', width: 640, height: 360 },
    ],
  };
  expect(recordingProbe(VIDEO_RECORDING_MIME, av)).toBe(1000);
  expect(() => recordingProbe('audio/webm', av)).toThrow();
  expect(() =>
    recordingProbe(VIDEO_RECORDING_MIME, {
      ...av,
      streams: [
        ...audio.streams,
        { codec_type: 'video', codec_name: 'vp8', width: 1920, height: 1080 },
      ],
    }),
  ).toThrow();
});

it('assembles and decodes synthetic VP8+Opus while separate recovery selects only PCM audio', () => {
  const directory = mkdtempSync(join(tmpdir(), 'legiwatch-av-test-'));
  const input = join(directory, 'source.webm'),
    output = join(directory, 'saved.webm');
  const options = { windowsHide: true, timeout: 30000, maxBuffer: 1024 * 1024 };
  try {
    execFileSync(
      'ffmpeg',
      [
        '-nostdin',
        '-v',
        'error',
        '-f',
        'lavfi',
        '-i',
        'color=size=320x180:rate=12',
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=440:sample_rate=48000',
        '-t',
        '1',
        '-c:v',
        'libvpx',
        '-c:a',
        'libopus',
        input,
      ],
      options,
    );
    execFileSync(
      'ffmpeg',
      [
        '-nostdin',
        '-v',
        'error',
        '-i',
        input,
        ...recordingMaps(VIDEO_RECORDING_MIME),
        '-c',
        'copy',
        '-cues_to_front',
        '1',
        '-f',
        'webm',
        output,
      ],
      options,
    );
    execFileSync(
      'ffmpeg',
      [
        '-nostdin',
        '-v',
        'error',
        '-xerror',
        '-i',
        output,
        ...recordingMaps(VIDEO_RECORDING_MIME),
        '-f',
        'null',
        '-',
      ],
      options,
    );
    const probe = JSON.parse(
      execFileSync(
        'ffprobe',
        [
          '-v',
          'error',
          '-show_entries',
          'format=duration:stream=codec_type,codec_name,width,height',
          '-of',
          'json',
          output,
        ],
        options,
      ).toString(),
    );
    expect(recordingProbe(VIDEO_RECORDING_MIME, probe)).toBeGreaterThanOrEqual(1000);
    const pcm = execFileSync(
      'ffmpeg',
      [
        '-nostdin',
        '-v',
        'error',
        '-i',
        output,
        '-map',
        '0:a:0',
        '-ar',
        '16000',
        '-ac',
        '1',
        '-f',
        's16le',
        'pipe:1',
      ],
      options,
    );
    expect(pcm.length).toBe(32000);
  } finally {
    // mkdtemp owns this exact absolute directory, never a computed external path.
    rmSync(directory, { recursive: true, force: true });
  }
});
