import { BadRequestException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export interface NewsletterStockImage {
  id: number;
  title: string;
  photographer: string;
  photographerUrl: string;
  sourceUrl: string;
  thumbnailUrl: string;
  imageUrl: string;
  width: number;
  height: number;
}

const unavailable = () =>
  new ServiceUnavailableException('Stock images are temporarily unavailable. Try again later.');
function providerUrl(value: unknown, host: string): string {
  if (typeof value !== 'string' || value.length > 2048) throw unavailable();
  try {
    const url = new URL(value);
    if (
      url.protocol !== 'https:' ||
      url.hostname !== host ||
      url.port ||
      url.username ||
      url.password
    )
      throw unavailable();
    return value;
  } catch {
    throw unavailable();
  }
}

/** Pexels search is separate from Uploads. Only an explicitly selected photo is
 * copied into an owner's newsletter assets; the provider key stays server-side. */
@Injectable()
export class NewsletterStockImageService {
  constructor(private readonly env: ConfigService) {}
  status() {
    const available = !!this.env.get<string>('NEWSLETTER_PEXELS_API_KEY')?.trim();
    return {
      provider: 'pexels' as const,
      available,
      reason: available ? null : 'Stock image search is not connected yet.',
    };
  }
  private async request(path: string): Promise<Record<string, unknown>> {
    const key = this.env.get<string>('NEWSLETTER_PEXELS_API_KEY')?.trim();
    if (!key) throw new ServiceUnavailableException('Stock image search is not connected yet.');
    try {
      const response = await fetch(`https://api.pexels.com/v1/${path}`, {
        headers: { Authorization: key, Accept: 'application/json' },
        signal: AbortSignal.timeout(12_000),
        redirect: 'error',
      });
      if (response.status === 429) {
        await response.body?.cancel();
        throw new ServiceUnavailableException(
          'The stock image search limit has been reached. Try again later or upload an image.',
        );
      }
      if (!response.ok || Number(response.headers.get('content-length')) > 2 * 1024 * 1024) {
        await response.body?.cancel();
        throw unavailable();
      }
      // Bound streamed JSON too: Content-Length is not guaranteed to be present.
      const reader = response.body?.getReader();
      if (!reader) throw unavailable();
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      try {
        for (;;) {
          const part = await reader.read();
          if (part.done) break;
          bytes += part.value.byteLength;
          if (bytes > 2 * 1024 * 1024) {
            await reader.cancel();
            throw unavailable();
          }
          chunks.push(part.value);
        }
      } finally {
        reader.releaseLock();
      }
      const result: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!result || typeof result !== 'object' || Array.isArray(result)) throw unavailable();
      return result as Record<string, unknown>;
    } catch (error) {
      // Never forward provider bodies, headers, URLs or keys in errors/logs.
      if (error instanceof ServiceUnavailableException) throw error;
      throw unavailable();
    }
  }
  private image(value: unknown): NewsletterStockImage {
    if (!value || typeof value !== 'object') throw unavailable();
    const item = value as Record<string, unknown>;
    if (
      !Number.isSafeInteger(item.id) ||
      Number(item.id) < 1 ||
      !Number.isSafeInteger(item.width) ||
      Number(item.width) < 1 ||
      !Number.isSafeInteger(item.height) ||
      Number(item.height) < 1
    )
      throw unavailable();
    if (!item.src || typeof item.src !== 'object') throw unavailable();
    const src = item.src as Record<string, unknown>;
    return {
      id: Number(item.id),
      title: typeof item.alt === 'string' ? item.alt.slice(0, 500) : 'Stock photo',
      photographer:
        typeof item.photographer === 'string'
          ? item.photographer.slice(0, 200)
          : 'Pexels contributor',
      photographerUrl: providerUrl(item.photographer_url, 'www.pexels.com'),
      sourceUrl: providerUrl(item.url, 'www.pexels.com'),
      thumbnailUrl: providerUrl(src.medium, 'images.pexels.com'),
      imageUrl: providerUrl(src.large2x, 'images.pexels.com'),
      width: Number(item.width),
      height: Number(item.height),
    };
  }
  async search(search = '', page = 1) {
    if (
      typeof search !== 'string' ||
      search.length > 100 ||
      !Number.isInteger(page) ||
      page < 1 ||
      page > 10_000
    )
      throw new BadRequestException('Choose a valid stock image search and page.');
    const query = search.trim();
    const params = new URLSearchParams({
      page: String(page),
      per_page: '10',
      ...(query ? { query } : {}),
    });
    const data = await this.request(`${query ? 'search' : 'curated'}?${params}`);
    if (
      !Array.isArray(data.photos) ||
      data.photos.length > 10 ||
      !Number.isSafeInteger(data.total_results) ||
      Number(data.total_results) < 0 ||
      data.page !== page ||
      data.per_page !== 10
    )
      throw unavailable();
    return {
      provider: 'pexels' as const,
      items: data.photos.map((item) => this.image(item)),
      page,
      pageSize: 10,
      total: Math.min(Number(data.total_results), 100_000),
    };
  }
  async get(id: string) {
    if (!/^[1-9]\d{0,14}$/.test(id) || !Number.isSafeInteger(Number(id)))
      throw new BadRequestException('Choose a valid stock image.');
    const image = this.image(await this.request(`photos/${id}`));
    if (image.id !== Number(id)) throw unavailable();
    return image;
  }
}
