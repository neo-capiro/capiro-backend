/** Brand/font metadata only. Core owns access, CAS, asset bytes and MIME/size checks. */
import type {
  NewsletterBrandKit,
  NewsletterFont,
  NewsletterJson,
  NewsletterReceiveResult,
} from './newsletter.js';
import {
  array,
  literal,
  nullable,
  object,
  receive,
  refuse,
  revision,
  row,
  snapshot,
  timestamp,
  uuid,
  type Rule,
} from './json-receiving.js';

const text =
  (max: number): Rule =>
  (value, path) => {
    if (typeof value !== 'string' || value.length > max) refuse(path);
  };
const color: Rule = (value, path) => {
  if (typeof value !== 'string' || !/^#[a-f\d]{6}$/i.test(value)) refuse(path);
};
const family: Rule = (value, path) => {
  text(100)(value, path);
  if (!/^[a-z0-9 ,'-]+$/i.test(value as string)) refuse(path);
};
/** Syntax is not origin trust, permission to fetch, or proof of a validated font file. */
const assetUrl: Rule = (value, path) => {
  text(2000)(value, path);
  let url: URL;
  try {
    url = new URL(value as string);
  } catch {
    refuse(path);
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    refuse(path);
  if (!/\/workspace-api\/newsletters\/assets\/file\/[a-f0-9]{64}$/.test(url.pathname)) refuse(path);
};
const font: Rule = (value, path) => {
  object({
    assetId: uuid,
    name: text(200),
    family: text(90),
    url: assetUrl,
    format: literal('truetype', 'opentype', 'woff', 'woff2'),
  })(value, path);
  const item = row(value, path);
  if ((item.family as string).toLowerCase() !== `CapiroFont-${item.assetId}`.toLowerCase())
    refuse(`${path}.family`, 'identity_mismatch');
};
const logo = object({
  assetId: uuid,
  name: text(200),
  url: assetUrl,
  link: text(2000),
  alt: text(1000),
});
const button = object({
  id: (value, path) => {
    text(100)(value, path);
    if (!/^[a-z0-9_-]+$/i.test(value as string)) refuse(path);
  },
  name: text(200),
  shape: literal('square', 'rounded', 'pill'),
  variant: literal('filled', 'outlined'),
  background: color,
  color,
  fontFamily: family,
});
function unique(items: NewsletterJson, key: string, path: string) {
  const seen = new Set<string>();
  for (const [index, item] of (items as NewsletterJson[]).entries()) {
    const value = row(item, `${path}.${index}`)[key] as string;
    if (seen.has(value)) refuse(`${path}.${index}.${key}`);
    seen.add(value);
  }
}
const kit: Rule = (value, path) => {
  object({
    revision,
    updatedAt: timestamp,
    logos: array(logo, 20),
    primaryLogoId: nullable(uuid),
    colors: object({ primary: array(color, 20), secondary: array(color, 20) }),
    fonts: object({ heading: family, body: family, uploaded: array(font, 20) }),
    buttons: array(button, 20),
    primaryButtonId: nullable(text(200)),
  })(value, path);
  const record = row(value, path);
  unique(record.logos!, 'assetId', `${path}.logos`);
  unique(record.buttons!, 'id', `${path}.buttons`);
  unique(row(record.fonts!, `${path}.fonts`).uploaded!, 'assetId', `${path}.fonts.uploaded`);
  for (const [primary, collection, key] of [
    ['primaryLogoId', 'logos', 'assetId'],
    ['primaryButtonId', 'buttons', 'id'],
  ] as const) {
    // Empty primaryButtonId is a current producer value, not an inferred selection.
    if (
      record[primary] &&
      !(record[collection] as NewsletterJson[]).some(
        (item) => row(item, path)[key] === record[primary],
      )
    )
      refuse(`${path}.${primary}`, 'identity_mismatch');
  }
};

/** GET explicitly initializes a missing kit. PATCH returns its current committed revision.
 * A captured next revision can bind an acknowledged PATCH response; no durable replay receipt exists.
 * The wire contains no tenant/owner ID, so this parser cannot bind or authorize that scope.
 */
export function parseNewsletterBrandKit(
  value: unknown,
  expected?: { revision: number },
): NewsletterReceiveResult<NewsletterBrandKit> {
  return receive(value, kit, (parsed) => {
    if (expected === undefined) return;
    const binding = row(snapshot(expected), '$expected');
    object({ revision })(binding, '$expected');
    for (const key of Object.keys(binding)) if (key !== 'revision') refuse(`$expected.${key}`);
    if (binding.revision !== row(parsed, '$').revision) refuse('$.revision', 'identity_mismatch');
  });
}

/** Upload creates a standalone asset; this is not kit attachment, deletion or a request receipt. */
export function parseNewsletterFont(value: unknown): NewsletterReceiveResult<NewsletterFont> {
  return receive(value, font);
}
