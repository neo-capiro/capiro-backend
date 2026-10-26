/** Provider results are proposed content, not document edits or durable receipts. */
import type { NewsletterCapabilities } from './newsletter.js';
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
import { newsletterAssetUrl } from './newsletter-asset-url-receiving.js';
import { parseNewsletterAssetItem, type NewsletterAssetItem } from './newsletter-receiving.js';

/** Neither endpoint echoes document, block, source text, token or revision. */
export interface NewsletterTextProposal {
  text: string;
}
/** Saved library revisions; only a fresh details read establishes which item is current. */
export interface NewsletterImageRefinement {
  items: NewsletterAssetItem[];
}
export interface NewsletterVideoThumbnail {
  sourceUrl: string;
  provider: 'youtube' | 'vimeo';
  title: string;
  imageUrl: string;
}
/** sourceUrl is the final page URL after redirects, not an input identity echo. */
export interface NewsletterLinkProposal {
  sourceUrl: string;
  title: string;
  description: string;
  imageUrl: string;
  warnings: string[];
}
const bounded =
  (max: number, nonblank = false): Rule =>
  (value, path) => {
    if (typeof value !== 'string' || value.length > max || (nonblank && !value.trim()))
      refuse(path);
  };
function closed(fields: Record<string, Rule>): Rule {
  return (value, path) => {
    object(fields)(value, path);
    for (const key of Object.keys(row(value, path)))
      if (!Object.prototype.hasOwnProperty.call(fields, key)) refuse(`${path}.${key}`);
  };
}
const available = closed({ available: bool, reason: nullable(bounded(2048)) });
const unavailable = closed({
  available: (value, path) => {
    if (value !== false) refuse(path);
  },
  reason: nullable(bounded(2048)),
});
export function parseNewsletterCapabilities(value: unknown): ReceiveResult<NewsletterCapabilities> {
  return receive(
    value,
    closed({
      ai: available,
      imageAi: available,
      altTextAi: available,
      htmlCheck: available,
      inboxPreview: unavailable,
      send: unavailable,
    }),
  );
}
/** 30000 is an explicit proposal receiving budget; the provider is not a length guarantee. */
export function parseNewsletterWritingProposal(
  value: unknown,
): ReceiveResult<NewsletterTextProposal> {
  return receive(value, closed({ text: bounded(30_000, true) }));
}
export function parseNewsletterAltText(value: unknown): ReceiveResult<NewsletterTextProposal> {
  return receive(
    value,
    closed({
      text: (value, path) => {
        bounded(500, true)(value, path);
        if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(value as string)) refuse(path);
      },
    }),
  );
}
/** Count is the captured requested result count, not evidence of source/document identity. */
export function parseNewsletterImageRefinement(
  value: unknown,
  expected: { count: 1 | 4 },
): ReceiveResult<NewsletterImageRefinement> {
  return receive(
    value,
    closed({
      items: array((value, path) => {
        const admitted = parseNewsletterAssetItem(value);
        if (!admitted.ok) refuse(path + admitted.error.path.slice(1), admitted.error.code);
      }, 4),
    }),
    (value) => {
      const capture = row(snapshot(expected), '$expected');
      closed({ count: literal(1, 4) })(capture, '$expected');
      if ((row(value, '$').items as unknown[]).length !== capture.count)
        refuse('$.items', 'identity_mismatch');
    },
  );
}
/** Syntax only. Core owns URL resolution, redirects and private-address policy. */
const sourceUrl: Rule = (value, path) => {
  // A receiving budget for redirect/canonical URLs, not a claimed producer request limit.
  bounded(8192)(value, path);
  let url: URL;
  try {
    url = new URL(value as string);
  } catch {
    refuse(path);
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash)
    refuse(path);
};
/** Capture sourceUrl/provider from the existing newsletterVideoSource(requestUrl) helper. */
export function parseNewsletterVideoThumbnail(
  value: unknown,
  expected: Pick<NewsletterVideoThumbnail, 'sourceUrl' | 'provider'>,
): ReceiveResult<NewsletterVideoThumbnail> {
  const source = { sourceUrl, provider: literal('youtube', 'vimeo') };
  return receive(
    value,
    closed({ ...source, title: bounded(160), imageUrl: newsletterAssetUrl }),
    (value) => {
      const capture = row(snapshot(expected), '$expected');
      closed(source)(capture, '$expected');
      const result = row(value, '$');
      for (const key of ['sourceUrl', 'provider'])
        if (result[key] !== capture[key]) refuse(`$.${key}`, 'identity_mismatch');
    },
  );
}
export function parseNewsletterLinkProposal(value: unknown): ReceiveResult<NewsletterLinkProposal> {
  return receive(
    value,
    closed({
      sourceUrl,
      title: bounded(2000),
      description: bounded(6000),
      imageUrl: (value, path) => {
        if (value !== '') newsletterAssetUrl(value, path);
      },
      warnings: array(bounded(2048), 1),
    }),
  );
}
// HTML checks reuse parseNewsletterHtmlCheck(value, { revision }) without another response owner.
