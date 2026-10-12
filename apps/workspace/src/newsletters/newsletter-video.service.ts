import { BadGatewayException, BadRequestException, Injectable } from '@nestjs/common';
import sharp from 'sharp';
import { newsletterVideoSource } from '@capiro/shared/newsletter';
import {
  downloadNewsletterVideoJson,
  newsletterImportUrl,
  newsletterImageMime,
} from './newsletter-asset-import.service.js';

export function newsletterVideoMetadata(value: unknown, provider: 'youtube' | 'vimeo') {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new BadGatewayException('The video provider returned invalid metadata.');
  const data = value as Record<string, unknown>;
  if (
    data.type !== 'video' ||
    data.provider_name !== (provider === 'youtube' ? 'YouTube' : 'Vimeo') ||
    typeof data.thumbnail_url !== 'string' ||
    data.thumbnail_url.length > 2048
  )
    throw new BadGatewayException(
      'This video has no available thumbnail. Choose a custom thumbnail.',
    );
  const url = newsletterImportUrl(data.thumbnail_url, 'video thumbnail');
  const host = url.hostname.toLowerCase();
  const trusted =
    provider === 'youtube'
      ? host === 'img.youtube.com' || host.endsWith('.ytimg.com')
      : host.endsWith('.vimeocdn.com');
  if (!trusted)
    throw new BadGatewayException(
      'The video thumbnail host is not supported. Choose a custom thumbnail.',
    );
  const title =
    typeof data.title === 'string'
      ? data.title
          .replace(/[\x00-\x1f\x7f<>/\\]/g, ' ')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 160)
      : '';
  return { imageUrl: url.href, title };
}

/** The badge is baked into the PNG rather than relying on email-client overlays. */
export async function newsletterVideoPlayImage(buffer: Buffer, provider: 'youtube' | 'vimeo') {
  if (!newsletterImageMime(buffer))
    throw new BadRequestException('The video thumbnail must be a supported raster image.');
  try {
    const resized = await sharp(buffer, {
      limitInputPixels: 20_000_000,
      animated: false,
      failOn: 'error',
    })
      .rotate()
      .resize({ width: 1280, height: 720, fit: 'inside', withoutEnlargement: true })
      .png()
      .timeout({ seconds: 3 })
      .toBuffer({ resolveWithObject: true });
    const { width, height } = resized.info;
    const badgeWidth = Math.max(
      1,
      Math.min(128, Math.round(width * 0.2), Math.round(height * 0.5)),
    );
    const badgeHeight = Math.max(1, Math.round(badgeWidth * 0.7));
    const left = (width - badgeWidth) / 2,
      top = (height - badgeHeight) / 2;
    const badge = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect x="${left}" y="${top}" width="${badgeWidth}" height="${badgeHeight}" rx="${badgeHeight * 0.2}" fill="${provider === 'youtube' ? '#ff0000' : '#00adef'}"/><path d="M${left + badgeWidth * 0.4} ${top + badgeHeight * 0.25} L${left + badgeWidth * 0.4} ${top + badgeHeight * 0.75} L${left + badgeWidth * 0.7} ${top + badgeHeight * 0.5}Z" fill="#ffffff"/></svg>`;
    return await sharp(resized.data)
      .composite([{ input: Buffer.from(badge) }])
      .png()
      .timeout({ seconds: 3 })
      .toBuffer();
  } catch {
    throw new BadGatewayException(
      'The video thumbnail could not be prepared. Choose a custom thumbnail.',
    );
  }
}

@Injectable()
export class NewsletterVideoService {
  async preview(value: string) {
    const source = newsletterVideoSource(value);
    if (!source)
      throw new BadRequestException(
        'Automatic thumbnails support YouTube and Vimeo video URLs. Add a custom thumbnail for other video URLs.',
      );
    const endpoint = new URL(
      source.provider === 'youtube'
        ? 'https://www.youtube.com/oembed'
        : 'https://vimeo.com/api/oembed.json',
    );
    endpoint.searchParams.set('url', source.url);
    endpoint.searchParams.set('format', 'json');
    const response = await downloadNewsletterVideoJson(
      endpoint.href,
      source.provider === 'youtube'
        ? ['www.youtube.com', 'youtube.com']
        : ['vimeo.com', 'www.vimeo.com'],
    );
    let data: unknown;
    try {
      data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(response.buffer));
    } catch {
      throw new BadGatewayException('The video provider returned invalid metadata.');
    }
    return {
      provider: source.provider,
      sourceUrl: source.url,
      ...newsletterVideoMetadata(data, source.provider),
    };
  }
  render(buffer: Buffer, provider: 'youtube' | 'vimeo') {
    return newsletterVideoPlayImage(buffer, provider);
  }
}
