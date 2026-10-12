import { BadGatewayException, BadRequestException } from '@nestjs/common';
import sharp from 'sharp';
import {
  createNewsletterBlock,
  createNewsletterSection,
  defaultNewsletterStyles,
  defaultNewsletterConfig,
  newsletterVideoSource,
  type NewsletterBlock,
} from '@capiro/shared/newsletter';
import {
  newsletterStyleCss,
  newsletterPlainText,
  renderNewsletterDesign,
} from '@capiro/shared/newsletter-render';
import {
  newsletterVideoMetadata,
  newsletterVideoPlayImage,
  NewsletterVideoService,
} from './newsletter-video.service.js';
import * as transport from './newsletter-asset-import.service.js';
import { validateNewsletterDesign, validateNewsletterStyle } from './newsletter-validation.js';
import { NewsletterService } from './newsletter.service.js';

const youtube = 'https://www.youtube.com/watch?v=M7lc1UVf-VE';
const metadata = {
  type: 'video',
  provider_name: 'YouTube',
  thumbnail_url: 'https://i.ytimg.com/vi/M7lc1UVf-VE/hqdefault.jpg',
  title: 'Policy briefing',
  html: '<iframe src="https://unsafe.example"></iframe>',
};
function design(block = createNewsletterBlock('video')) {
  return {
    version: 1 as const,
    styles: defaultNewsletterStyles(),
    sections: [createNewsletterSection('Video', [block])],
  };
}
afterEach(() => jest.restoreAllMocks());
describe('video source and private thumbnail', () => {
  it.each([
    ['https://youtu.be/M7lc1UVf-VE?t=30', youtube],
    ['https://m.youtube.com/watch?v=M7lc1UVf-VE&list=ignored', youtube],
    ['https://www.youtube-nocookie.com/embed/M7lc1UVf-VE', youtube],
    ['https://youtube.com/shorts/M7lc1UVf-VE', youtube],
    ['https://youtube.com/live/M7lc1UVf-VE', youtube],
    [
      'https://player.vimeo.com/video/123456789?h=abcdef1234&autoplay=1',
      'https://vimeo.com/123456789?h=abcdef1234',
    ],
    ['https://vimeo.com/123456789/abcdef1234', 'https://vimeo.com/123456789/abcdef1234'],
    ['https://vimeo.com/channels/policy/123456789', 'https://vimeo.com/channels/policy/123456789'],
    [
      'https://vimeo.com/groups/policy/videos/123456789',
      'https://vimeo.com/groups/policy/videos/123456789',
    ],
    [
      'https://vimeo.com/album/1234/video/123456789',
      'https://vimeo.com/album/1234/video/123456789',
    ],
  ])('resolves supported URL %s without losing Vimeo access hashes', (input, expected) =>
    expect(newsletterVideoSource(input)?.url).toBe(expected),
  );
  it.each([
    'https://youtube.com.evil.example/watch?v=M7lc1UVf-VE',
    'https://u:p@youtube.com/watch?v=M7lc1UVf-VE',
    'https://youtube.com:8443/watch?v=M7lc1UVf-VE',
    'https://youtube.com/watch?v=M7lc1UVf-VE&v=other',
    'https://youtu.be/invalid',
    'javascript:alert(1)',
    'https://127.0.0.1/video',
    'https://vimeo.com/settings',
    'https://player.vimeo.com/video/123?h=bad',
  ])('refuses unsupported or unsafe source %s', (input) =>
    expect(newsletterVideoSource(input)).toBeNull(),
  );
  it('ignores provider HTML and bounds the title to a safe file name', () => {
    expect(
      newsletterVideoMetadata(
        { ...metadata, title: '<Policy> / briefing\n' + 'x'.repeat(200) },
        'youtube',
      ),
    ).toEqual({
      imageUrl: metadata.thumbnail_url,
      title: ('Policy briefing ' + 'x'.repeat(200)).slice(0, 160),
    });
    expect(
      newsletterVideoMetadata(
        {
          ...metadata,
          provider_name: 'Vimeo',
          thumbnail_url: 'https://i.vimeocdn.com/video/123.jpg',
        },
        'vimeo',
      ).imageUrl,
    ).toContain('vimeocdn.com');
  });
  it.each([
    null,
    { ...metadata, type: 'rich' },
    { ...metadata, provider_name: 'Vimeo' },
    { ...metadata, thumbnail_url: 'https://i.ytimg.com.evil.example/a.jpg' },
    { ...metadata, thumbnail_url: 'http://i.ytimg.com/a.jpg' },
    { ...metadata, thumbnail_url: 'https://127.0.0.1/a.jpg' },
  ])('rejects missing or untrusted metadata %#', (value) =>
    expect(() => newsletterVideoMetadata(value, 'youtube')).toThrow(),
  );
  it('fetches only the fixed provider endpoint and rejects invalid JSON/UTF-8', async () => {
    const fetch = jest.spyOn(transport, 'downloadNewsletterVideoJson').mockResolvedValue({
      buffer: Buffer.from(JSON.stringify(metadata)),
      originalname: 'oembed',
      url: 'https://www.youtube.com/oembed',
      contentType: 'application/json',
    });
    const service = new NewsletterVideoService();
    expect(await service.preview('https://youtu.be/M7lc1UVf-VE?t=30')).toEqual({
      provider: 'youtube',
      sourceUrl: youtube,
      imageUrl: metadata.thumbnail_url,
      title: 'Policy briefing',
    });
    const request = new URL(fetch.mock.calls[0]![0]);
    expect(request.origin + request.pathname).toBe('https://www.youtube.com/oembed');
    expect(request.searchParams.get('url')).toBe(youtube);
    expect(fetch.mock.calls[0]![1]).toEqual(['www.youtube.com', 'youtube.com']);
    for (const buffer of [Buffer.from('<iframe>'), Buffer.from([0xff])]) {
      fetch.mockResolvedValueOnce({
        buffer,
        originalname: 'oembed',
        url: request.href,
        contentType: 'application/json',
      });
      await expect(service.preview(youtube)).rejects.toBeInstanceOf(BadGatewayException);
    }
    const before = fetch.mock.calls.length;
    await expect(service.preview('https://private.example/video')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(fetch.mock.calls.length).toBe(before);
  });
  it.each(['youtube', 'vimeo'] as const)(
    'bakes a visible %s play badge into a bounded PNG',
    async (provider) => {
      const original = await sharp({
        create: { width: 2560, height: 1440, channels: 3, background: '#ffffff' },
      })
        .jpeg()
        .toBuffer();
      const rendered = await newsletterVideoPlayImage(original, provider);
      expect(transport.newsletterImageMime(rendered)).toBe('image/png');
      const { data, info } = await sharp(rendered)
        .removeAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
      expect([info.width, info.height]).toEqual([1280, 720]);
      const at = (x: number, y: number) => [
        ...data.subarray(
          (y * info.width + x) * info.channels,
          (y * info.width + x) * info.channels + 3,
        ),
      ];
      expect(at(600, 360)).toEqual(provider === 'youtube' ? [255, 0, 0] : [0, 173, 239]);
      expect(at(640, 360)).toEqual([255, 255, 255]);
    },
  );
  it('rejects unsupported, corrupted and oversized raster input', async () => {
    await expect(newsletterVideoPlayImage(Buffer.from('<svg/>'), 'youtube')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(
      newsletterVideoPlayImage(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), 'youtube'),
    ).rejects.toBeInstanceOf(BadGatewayException);
    const oversized = await sharp({
      create: { width: 5001, height: 4000, channels: 3, background: '#fff' },
    })
      .png()
      .toBuffer();
    await expect(newsletterVideoPlayImage(oversized, 'youtube')).rejects.toThrow(
      'could not be prepared',
    );
  });
});
describe('Video document, email and staging', () => {
  it('persists custom/automatic source settings and asymmetric corners without adding settings to legacy blocks', () => {
    const block = createNewsletterBlock('video', {
      url: youtube,
      imageUrl: 'https://assets.example/private.png',
      video: { thumbnail: 'auto', sourceUrl: youtube, paddingLinked: true },
      style: { radius: 8, radiusTopLeft: 22, radiusBottomRight: 0, paddingLeft: 24 },
    });
    expect(validateNewsletterDesign(design(block)).sections[0]!.blocks[0]).toEqual(block);
    expect(() =>
      validateNewsletterDesign(
        design({ ...block, video: { ...block.video!, paddingLinked: 'false' as never } }),
      ),
    ).toThrow(BadRequestException);
    delete block.video;
    expect(validateNewsletterDesign(design(block)).sections[0]!.blocks[0]!.video).toBeUndefined();
    expect(() => validateNewsletterStyle({ radiusTopLeft: 1001 })).toThrow(BadRequestException);
    expect(() =>
      validateNewsletterDesign(
        design({ ...block, video: { thumbnail: 'unsafe' as never, sourceUrl: youtube } }),
      ),
    ).toThrow(BadRequestException);
    expect(() =>
      validateNewsletterDesign(
        design({ ...block, kind: 'paragraph', video: { thumbnail: 'auto', sourceUrl: youtube } }),
      ),
    ).toThrow(BadRequestException);
  });
  it('renders one linked thumbnail, applies padding once, preserves legacy captions and puts corner overrides after the radius shorthand', () => {
    const block = createNewsletterBlock('video', {
      url: youtube,
      imageUrl: 'https://assets.example/private.png',
      alt: 'Policy briefing',
      text: 'Old caption',
      style: { radiusTopLeft: 22, radius: 8, paddingTop: 12, paddingLeft: 24 },
    });
    const html = renderNewsletterDesign(design(block), defaultNewsletterConfig());
    expect(html.match(/<a\b/g)).toHaveLength(1);
    expect(html).toContain('target="_blank"');
    expect(html).toContain('alt="Policy briefing"');
    expect(html).not.toContain('Old caption');
    expect(newsletterPlainText(design(block), defaultNewsletterConfig())).toBe(
      `Policy briefing\n${youtube}`,
    );
    expect(html.match(/padding:12px 0px 12px 24px/g)).toHaveLength(1);
    expect(newsletterStyleCss(block.style)).toMatch(
      /border-radius:8px.*border-top-left-radius:22px/,
    );
    delete block.video;
    expect(newsletterPlainText(design(block), defaultNewsletterConfig())).toContain('Old caption');
    expect(renderNewsletterDesign(design(block), defaultNewsletterConfig())).toContain(
      'Old caption',
    );
  });
  it('prevents staging unresolved, stale or non-web videos and accepts a finished automatic or custom image', () => {
    const service = new NewsletterService({} as never, {} as never, {} as never, {} as never);
    const check = (block: NewsletterBlock) =>
      service
        .checks(design(block), defaultNewsletterConfig())
        .filter((item) => item.blockId === block.id && item.severity === 'error');
    const block = createNewsletterBlock('video', { url: youtube });
    expect(check(block)).toEqual([expect.objectContaining({ label: 'Finish video thumbnail' })]);
    block.imageUrl = 'https://assets.example/private.png';
    block.video!.sourceUrl = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
    expect(check(block)).toHaveLength(1);
    block.video!.sourceUrl = youtube;
    expect(check(block)).toEqual([]);
    block.video!.thumbnail = 'custom';
    block.url = 'https://example.com/committee-hearing';
    expect(check(block)).toEqual([]);
    block.url = 'mailto:client@example.com';
    expect(check(block)).toHaveLength(1);
  });
});
