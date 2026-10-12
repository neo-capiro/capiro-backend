import { BadRequestException } from '@nestjs/common';
import type { NewsletterBrandKit, NewsletterFont } from '@capiro/shared/newsletter';
import { newsletterSafeUrl } from '@capiro/shared/newsletter-render';

const fail = (message: string): never => {
  throw new BadRequestException(message);
};
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : fail('Brand settings must be an object.');
const string = (value: unknown, label: string, max = 200): string =>
  typeof value === 'string' && value.length <= max ? value : fail(`${label} is invalid.`);
const list = (value: unknown, label: string): unknown[] =>
  Array.isArray(value) && value.length <= 20 ? value : fail(`${label} can contain up to 20 items.`);
const uuid = (value: unknown): string => {
  const id = string(value, 'Asset ID');
  return /^[a-f\d]{8}-[a-f\d]{4}-[1-5][a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/i.test(id)
    ? id
    : fail('Asset ID is invalid.');
};
const color = (value: unknown): string =>
  /^#[a-f\d]{6}$/i.test(String(value))
    ? String(value)
    : fail('Brand colors must use six-digit hex values.');
const family = (value: unknown): string => {
  const font = string(value, 'Font family', 100);
  return /^[a-z0-9 ,'-]+$/i.test(font) ? font : fail('Font family is invalid.');
};
const unique = <T>(items: T[], key: (item: T) => string): T[] =>
  new Set(items.map(key)).size === items.length ? items : fail('Brand item IDs must be unique.');

export function validateNewsletterFonts(value: unknown, max = 20): NewsletterFont[] {
  const values = value ?? [];
  if (!Array.isArray(values) || values.length > max)
    fail(`Uploaded fonts can contain up to ${max} items.`);
  return unique(
    (values as unknown[]).map((raw) => {
      const item = object(raw);
      const assetId = uuid(item.assetId);
      const fontFamily = string(item.family, 'Uploaded font family', 90);
      if (fontFamily !== `CapiroFont-${assetId}`) fail('Uploaded font family is invalid.');
      const url = string(item.url, 'Font URL', 2000);
      const safeUrl = newsletterSafeUrl(url, true);
      if (!/^https?:\/\//i.test(safeUrl)) fail('Font URL is invalid.');
      if (!['truetype', 'opentype', 'woff', 'woff2'].includes(String(item.format)))
        fail('Font format is invalid.');
      return {
        assetId,
        name: string(item.name, 'Font name'),
        family: fontFamily,
        url: safeUrl,
        format: item.format as NewsletterFont['format'],
      };
    }),
    (item) => item.assetId,
  );
}
export function validateNewsletterBrandKit(value: unknown): NewsletterBrandKit {
  const row = object(value);
  if (!Number.isSafeInteger(row.revision) || Number(row.revision) < 1)
    fail('Brand revision is invalid.');
  const logos = unique(
    list(row.logos, 'Logos').map((raw) => {
      const logo = object(raw);
      const link = string(logo.link, 'Logo link', 2000);
      const safeLink = link ? newsletterSafeUrl(link) : '';
      if (link && (!safeLink || !/^https?:\/\//i.test(safeLink)))
        fail('Use a web URL for the logo link.');
      return {
        assetId: uuid(logo.assetId),
        name: string(logo.name, 'Logo name'),
        url: '',
        link: safeLink,
        alt: string(logo.alt, 'Logo alt text', 1000),
      };
    }),
    (logo) => logo.assetId,
  );
  const colors = object(row.colors);
  const fonts = object(row.fonts);
  const uploaded = validateNewsletterFonts(fonts.uploaded);
  const buttons = unique(
    list(row.buttons, 'Buttons').map((raw) => {
      const button = object(raw);
      const id = string(button.id, 'Button ID', 100);
      if (!/^[a-z0-9_-]+$/i.test(id)) fail('Button ID is invalid.');
      if (!['square', 'rounded', 'pill'].includes(String(button.shape)))
        fail('Button shape is invalid.');
      if (!['filled', 'outlined'].includes(String(button.variant)))
        fail('Button style is invalid.');
      return {
        id,
        name: string(button.name, 'Button name'),
        shape: button.shape as 'square' | 'rounded' | 'pill',
        variant: button.variant as 'filled' | 'outlined',
        background: color(button.background),
        color: color(button.color),
        fontFamily: family(button.fontFamily),
      };
    }),
    (button) => button.id,
  );
  const primaryLogoId = row.primaryLogoId === null ? null : uuid(row.primaryLogoId);
  if (primaryLogoId && !logos.some((logo) => logo.assetId === primaryLogoId))
    fail('Choose a logo from this Brand Kit.');
  const primaryButtonId =
    row.primaryButtonId === null ? null : string(row.primaryButtonId, 'Primary button');
  if (primaryButtonId && !buttons.some((button) => button.id === primaryButtonId))
    fail('Choose a button from this Brand Kit.');
  return {
    revision: Number(row.revision),
    updatedAt: '',
    logos,
    primaryLogoId,
    primaryButtonId,
    buttons,
    colors: {
      primary: list(colors.primary, 'Primary colors').map(color),
      secondary: list(colors.secondary, 'Secondary colors').map(color),
    },
    fonts: { heading: family(fonts.heading), body: family(fonts.body), uploaded },
  };
}

/** Validate container signatures and bounds before storing font bytes. */
export function newsletterFontFormat(bytes: Buffer): NewsletterFont['format'] | null {
  if (bytes.length < 12 || bytes.length > 2 * 1024 * 1024) return null;
  const magic = bytes.subarray(0, 4).toString('latin1');
  if (magic === 'wOFF' || magic === 'wOF2') {
    const header = magic === 'wOFF' ? 44 : 48;
    if (
      bytes.length <= header ||
      bytes.readUInt32BE(8) !== bytes.length ||
      bytes.readUInt16BE(14) !== 0
    )
      return null;
    const tables = bytes.readUInt16BE(12);
    if (!tables || tables > 256) return null;
    if (magic === 'wOFF') {
      const directoryEnd = header + 20 * tables;
      if (directoryEnd > bytes.length) return null;
      for (let i = 0; i < tables; i++) {
        const entry = header + 20 * i;
        const offset = bytes.readUInt32BE(entry + 4),
          size = bytes.readUInt32BE(entry + 8);
        if (
          offset < directoryEnd ||
          offset + size > bytes.length ||
          size > bytes.readUInt32BE(entry + 12)
        )
          return null;
      }
      return 'woff';
    }
    return bytes.readUInt32BE(20) > 0 && bytes.readUInt32BE(20) <= bytes.length - header
      ? 'woff2'
      : null;
  }
  if (magic !== 'OTTO' && magic !== 'true' && bytes.readUInt32BE(0) !== 0x00010000) return null;
  const tables = bytes.readUInt16BE(4),
    directoryEnd = 12 + 16 * tables;
  if (!tables || tables > 256 || directoryEnd > bytes.length) return null;
  for (let i = 0; i < tables; i++) {
    const entry = 12 + 16 * i;
    const offset = bytes.readUInt32BE(entry + 8),
      size = bytes.readUInt32BE(entry + 12);
    if (offset < directoryEnd || offset + size > bytes.length) return null;
  }
  return magic === 'OTTO' ? 'opentype' : 'truetype';
}
