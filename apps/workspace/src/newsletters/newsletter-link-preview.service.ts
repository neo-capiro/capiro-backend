import { BadRequestException, Injectable } from '@nestjs/common';
import { Parser } from 'htmlparser2';
import sanitizeHtml from 'sanitize-html';
import { downloadNewsletterPage, newsletterImportUrl } from './newsletter-asset-import.service.js';

function plain(value: string, max: number) {
  let result = '';
  const parser = new Parser(
    {
      ontext: (text) => {
        result += text;
      },
    },
    { decodeEntities: true },
  );
  parser.end(sanitizeHtml(value.slice(0, 32_000), { allowedTags: [], allowedAttributes: {} }));
  return result
    .replace(/[\x00-\x1f\x7f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

export function newsletterLinkMetadata(html: string, sourceUrl: string) {
  const url = newsletterImportUrl(sourceUrl, 'page');
  const metadata = new Map<string, string>();
  let title = '';
  let inTitle = false;
  let headFinished = false;
  const parser = new Parser(
    {
      onopentag(name, attrs) {
        if (name === 'body') headFinished = true;
        if (headFinished) return;
        if (name === 'title') inTitle = true;
        if (name === 'meta') {
          const key = (attrs.property || attrs.name || '').toLowerCase();
          if (!metadata.has(key) && attrs.content) metadata.set(key, attrs.content);
        }
      },
      ontext(text) {
        if (inTitle && !headFinished) title += text;
      },
      onclosetag(name) {
        if (name === 'title') inTitle = false;
        if (name === 'head') headFinished = true;
      },
    },
    { decodeEntities: true },
  );
  parser.end(html);
  let imageUrl = '';
  const image =
    metadata.get('og:image:secure_url') ||
    metadata.get('og:image') ||
    metadata.get('twitter:image') ||
    metadata.get('twitter:image:src');
  if (image && image.length <= 2048) {
    try {
      imageUrl = newsletterImportUrl(new URL(image, url).href).href;
    } catch {
      /* Text previews remain available. */
    }
  }
  return {
    sourceUrl: url.href,
    title:
      [metadata.get('og:title'), metadata.get('twitter:title'), title]
        .map((value) => plain(value || '', 2000))
        .find(Boolean) || url.hostname,
    description: plain(
      metadata.get('og:description') ||
        metadata.get('twitter:description') ||
        metadata.get('description') ||
        '',
      6000,
    ),
    imageUrl,
  };
}

@Injectable()
export class NewsletterLinkPreviewService {
  async preview(value: string) {
    if (value.length > 2048)
      throw new BadRequestException('Choose a URL of up to 2048 characters.');
    const page = await downloadNewsletterPage(value);
    const charset =
      page.contentType.match(/charset\s*=\s*["']?([^\s;"']+)/i)?.[1]?.toLowerCase() || 'utf-8';
    if (!['utf-8', 'utf8', 'windows-1252', 'iso-8859-1', 'us-ascii'].includes(charset))
      throw new BadRequestException('This page uses an unsupported text encoding.');
    return newsletterLinkMetadata(new TextDecoder(charset).decode(page.buffer), page.url);
  }
}
