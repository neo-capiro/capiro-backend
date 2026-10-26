/** Stock discovery and import are content replies, never durable write receipts. */
import {
  array,
  bool,
  literal,
  nullable,
  object,
  receive,
  refuse,
  row,
  snapshot,
  type Rule,
  type ReceiveResult,
} from './json-receiving.js';
import { parseNewsletterAssetItem, type NewsletterAssetItem } from './newsletter-receiving.js';

export interface NewsletterStockStatus {
  provider: 'pexels';
  available: boolean;
  reason: string | null;
}
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
export interface NewsletterStockPage {
  provider: 'pexels';
  items: NewsletterStockImage[];
  page: number;
  pageSize: 10;
  total: number;
}
/** Import does not echo the selected photo ID, photographer or source URL. */
export interface NewsletterStockImport extends NewsletterAssetItem {
  altText: string;
}
const bounded =
  (max: number): Rule =>
  (value, path) => {
    if (typeof value !== 'string' || value.length > max) refuse(path);
  };
const integer =
  (min: number, max = Number.MAX_SAFE_INTEGER): Rule =>
  (value, path) => {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max)
      refuse(path);
  };
function closed(fields: Record<string, Rule>): Rule {
  return (value, path) => {
    object(fields)(value, path);
    for (const key of Object.keys(row(value, path)))
      if (!Object.prototype.hasOwnProperty.call(fields, key)) refuse(`${path}.${key}`);
  };
}
const providerUrl =
  (host: string): Rule =>
  (value, path) => {
    bounded(2048)(value, path);
    let url: URL;
    try {
      url = new URL(value as string);
    } catch {
      refuse(path);
    }
    if (
      url.protocol !== 'https:' ||
      url.hostname !== host ||
      url.port ||
      url.username ||
      url.password
    )
      refuse(path);
  };
const photo = closed({
  id: integer(1),
  title: bounded(500),
  photographer: bounded(200),
  photographerUrl: providerUrl('www.pexels.com'),
  sourceUrl: providerUrl('www.pexels.com'),
  thumbnailUrl: providerUrl('images.pexels.com'),
  imageUrl: providerUrl('images.pexels.com'),
  width: integer(1),
  height: integer(1),
});
export function parseNewsletterStockStatus(value: unknown): ReceiveResult<NewsletterStockStatus> {
  return receive(
    value,
    closed({ provider: literal('pexels'), available: bool, reason: nullable(bounded(2048)) }),
  );
}
/** Only page is echoed. Search text and actor scope remain with the query owner. */
export function parseNewsletterStockPage(
  value: unknown,
  expected: { page: number },
): ReceiveResult<NewsletterStockPage> {
  return receive(
    value,
    closed({
      provider: literal('pexels'),
      items: array(photo, 10),
      page: integer(1, 10_000),
      pageSize: literal(10),
      total: integer(0, 100_000),
    }),
    (value) => {
      const capture = row(snapshot(expected), '$expected');
      closed({ page: integer(1, 10_000) })(capture, '$expected');
      if (row(value, '$').page !== capture.page) refuse('$.page', 'identity_mismatch');
    },
  );
}
export function parseNewsletterStockImport(value: unknown): ReceiveResult<NewsletterStockImport> {
  return receive(value, (value, path) => {
    const { altText, ...asset } = row(value, path);
    bounded(500)(altText!, `${path}.altText`);
    const admitted = parseNewsletterAssetItem(asset);
    if (!admitted.ok) refuse(path + admitted.error.path.slice(1), admitted.error.code);
  });
}
