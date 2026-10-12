import {
  newsletterLinkMetadata,
  NewsletterLinkPreviewService,
} from './newsletter-link-preview.service.js';
import { downloadNewsletterPage } from './newsletter-asset-import.service.js';
jest.mock('./newsletter-asset-import.service.js', () => ({
  ...jest.requireActual('./newsletter-asset-import.service.js'),
  downloadNewsletterPage: jest.fn(),
}));
const download = downloadNewsletterPage as jest.Mock;
beforeEach(() => jest.clearAllMocks());

describe('public link preview metadata', () => {
  it('prefers Open Graph data, decodes entities and resolves image URLs against the final page', () => {
    expect(
      newsletterLinkMetadata(
        '<html><head><title>Fallback</title><meta property="og:title" content="Policy &amp; funding"><meta name="twitter:title" content="Other"><meta property="og:description" content="&lt;b&gt;Committee&lt;/b&gt; update"><meta property="og:image" content="../image.png"></head><body>Ignored</body></html>',
        'https://news.example/policy/article',
      ),
    ).toEqual({
      sourceUrl: 'https://news.example/policy/article',
      title: 'Policy & funding',
      description: 'Committee update',
      imageUrl: 'https://news.example/image.png',
    });
  });
  it('keeps markup, body metadata, scripts and base elements out of the preview', () => {
    const data = newsletterLinkMetadata(
      '<head><title>Safe title</title><base href="https://evil.example"><script>document.title="Bad"</script><meta property="og:image" content="/image.png"></head><body><meta property="og:title" content="Injected"></body>',
      'https://news.example/article',
    );
    expect(data.title).toBe('Safe title');
    expect(data.imageUrl).toBe('https://news.example/image.png');
  });
  it.each([
    'https://127.0.0.1/image.png',
    'http://news.example/image.png',
    'data:image/png;base64,AA',
    'https://name:secret@news.example/image.png',
    '//local.internal/image.png',
  ])('rejects an unsafe thumbnail %s while retaining text', (image) => {
    expect(
      newsletterLinkMetadata(
        `<head><title>Title</title><meta property="og:image" content="${image}"></head>`,
        'https://news.example',
      ).imageUrl,
    ).toBe('');
  });
  it('bounds text and uses page title or host when metadata is absent or blank', () => {
    expect(
      newsletterLinkMetadata(
        '<head><meta property="og:title" content="   "><title>Real title</title></head>',
        'https://news.example',
      ).title,
    ).toBe('Real title');
    const data = newsletterLinkMetadata(
      `<head><meta property="og:title" content="${'A'.repeat(3000)}"><meta property="og:description" content="${'B'.repeat(7000)}"></head>`,
      'https://news.example',
    );
    expect(data.title).toHaveLength(2000);
    expect(data.description).toHaveLength(6000);
    expect(newsletterLinkMetadata('<html></html>', 'https://news.example').title).toBe(
      'news.example',
    );
  });
  it('decodes a supported legacy encoding and rejects unsupported encodings or long URLs', async () => {
    const service = new NewsletterLinkPreviewService();
    download.mockResolvedValueOnce({
      buffer: Buffer.from('<head><title>Caf\xe9</title></head>', 'latin1'),
      contentType: 'text/html; charset=windows-1252',
      url: 'https://news.example/final',
    });
    expect(await service.preview('https://news.example')).toMatchObject({
      title: 'Café',
      sourceUrl: 'https://news.example/final',
    });
    download.mockResolvedValueOnce({
      buffer: Buffer.from('x'),
      contentType: 'text/html; charset=utf-16',
      url: 'https://news.example',
    });
    await expect(service.preview('https://news.example')).rejects.toThrow('encoding');
    await expect(service.preview('https://news.example/' + 'x'.repeat(2048))).rejects.toThrow(
      '2048',
    );
    expect(download).toHaveBeenCalledTimes(2);
  });
});
