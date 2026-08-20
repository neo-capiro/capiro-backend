import {
  assertCaptureMediaUrl,
  buildFfmpegAudioCommand,
  captureRefererIfAllowed,
} from './ffmpeg-audio-command.js';

describe('FFmpeg server capture argv', () => {
  it('emits mono 16 kHz linear16 PCM to stdout without invoking a shell', () => {
    const command = buildFfmpegAudioCommand({
      mediaUrl:
        'https://www-senate-gov-media-srs.akamaized.net/hls/live/2036800/armed/example/master.m3u8',
      referer: 'https://www.armed-services.senate.gov/hearings/example',
    });

    expect(command.executable).toBe('ffmpeg');
    expect(command.args).toEqual(
      expect.arrayContaining([
        '-nostdin',
        '-protocol_whitelist',
        'https,tls,tcp,crypto',
        '-ac',
        '1',
        '-ar',
        '16000',
        '-acodec',
        'pcm_s16le',
        '-f',
        's16le',
        'pipe:1',
      ]),
    );
    expect(command.args).not.toContain('sh');
    expect(command.output).toEqual({
      encoding: 'linear16',
      sampleRate: 16_000,
      channels: 1,
      bytesPerSample: 2,
    });
  });

  it('keeps the untrusted media URL in one argv element', () => {
    const mediaUrl = 'https://media.senate.gov/live/master.m3u8?name=value%20with%20spaces';
    const command = buildFfmpegAudioCommand({ mediaUrl });
    const inputIndex = command.args.indexOf('-i');
    expect(command.args[inputIndex + 1]).toBe(mediaUrl);
  });

  it('rejects non-HTTPS, credential-bearing, local, and header-injection inputs', () => {
    expect(() => assertCaptureMediaUrl('http://example.com/live.m3u8')).toThrow(/HTTPS/);
    expect(() => assertCaptureMediaUrl('https://user:pass@example.com/live.m3u8')).toThrow(
      /credentials/,
    );
    expect(() => assertCaptureMediaUrl('https://localhost/live.m3u8')).toThrow(/not allowed/);
    expect(() =>
      buildFfmpegAudioCommand({
        mediaUrl: 'https://media.senate.gov/live.m3u8',
        userAgent: 'safe\r\nX-Injected: yes',
      }),
    ).toThrow(/header value/i);
  });
});


describe('validated FFmpeg references', () => {
  it('retains only credential-free HTTPS referers on guarded hosts', () => {
    expect(
      captureRefererIfAllowed(
        'https://www.armed-services.senate.gov/hearings/example#video',
      ),
    ).toBe('https://www.armed-services.senate.gov/hearings/example#video');
    expect(
      captureRefererIfAllowed(
        'https://www.congress.gov/event/119th-congress/senate-event/337163',
      ),
    ).toBeUndefined();
    expect(captureRefererIfAllowed('https://user:secret@senate.gov/hearing')).toBeUndefined();
    expect(captureRefererIfAllowed('javascript:alert(1)')).toBeUndefined();
  });
});
