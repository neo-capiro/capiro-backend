import { NEWSLETTER_FONT_RECORDS } from './newsletter-fonts.catalog.js';
import type { NewsletterDesign, NewsletterStyle } from './newsletter.js';

export interface NewsletterCatalogFont {
  label: string;
  family: string;
  weight: number;
  italic: boolean;
}
/** The two default Brand Kit selections are retained alongside the rendered catalog. */
export const NEWSLETTER_FONT_CATALOG: readonly NewsletterCatalogFont[] = [
  ...NEWSLETTER_FONT_RECORDS.map(([label, family, weight, italic]) => ({
    label,
    family,
    weight,
    italic,
  })),
  { label: 'DM Sans', family: 'DM Sans', weight: 400, italic: false },
  { label: 'Instrument Serif', family: 'Instrument Serif', weight: 400, italic: false },
];
const byLabel = new Map(NEWSLETTER_FONT_CATALOG.map((font) => [font.label.toLowerCase(), font]));
const byFamily = new Map<string, NewsletterCatalogFont>();
for (const font of NEWSLETTER_FONT_CATALOG) {
  const key = font.family.toLowerCase(),
    current = byFamily.get(key);
  if (!current || (font.weight === 400 && !font.italic)) byFamily.set(key, font);
}
export function newsletterCatalogFont(value: string): NewsletterCatalogFont | undefined {
  const label = value
    .split(',')[0]!
    .trim()
    .replace(/^['"]|['"]$/g, '')
    .toLowerCase();
  return byLabel.get(label) ?? byFamily.get(label);
}
export function newsletterCatalogStyle(
  value: string,
): { fontFamily: string; fontWeight: number; fontStyle: 'normal' | 'italic' } | undefined {
  const font = newsletterCatalogFont(value);
  return font
    ? {
        fontFamily: `'${font.family}', Arial, sans-serif`,
        fontWeight: font.weight,
        fontStyle: font.italic ? 'italic' : 'normal',
      }
    : undefined;
}
export interface NewsletterFontRequest {
  value: string;
  bold?: boolean;
  italic?: boolean;
  weight?: number;
}
const systemFonts = new Set(
  [
    'Arial',
    'Arial Black',
    'Comic Sans MS',
    'Courier',
    'Courier New',
    'Georgia',
    'Helvetica',
    'Impact',
    'Lucida Console',
    'Lucida Grande',
    'Lucida Sans Unicode',
    'Palatino Linotype',
    'Tahoma',
    'Times New Roman',
    'Trebuchet MS',
    'Verdana',
  ].map((name) => name.toLowerCase()),
);
/** Only known catalog families are sent to a fixed public stylesheet origin. */
export function newsletterWebFontUrls(requests: readonly NewsletterFontRequest[]): string[] {
  const groups = new Map<string, Set<string>>();
  for (const request of requests) {
    const font = newsletterCatalogFont(request.value);
    if (!font || systemFonts.has(font.family.toLowerCase())) continue;
    const requestedWeight =
      request.weight ?? (request.bold === undefined ? font.weight : request.bold ? 700 : 400);
    const requestedItalic = request.italic ?? font.italic;
    // Use a real available face; the browser can synthesize unsupported emphasis.
    const variants = NEWSLETTER_FONT_CATALOG.filter((item) => item.family === font.family);
    const face =
      variants.find((item) => item.weight === requestedWeight && item.italic === requestedItalic) ??
      font;
    const group = groups.get(font.family) ?? new Set<string>();
    group.add(`${face.italic ? 1 : 0},${face.weight}`);
    groups.set(font.family, group);
  }
  return [...groups]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([family, faces]) => {
      const pairs = [...faces].sort((a, b) => {
        const [ai, aw] = a.split(',').map(Number),
          [bi, bw] = b.split(',').map(Number);
        return ai! - bi! || aw! - bw!;
      });
      const italic = pairs.some((pair) => pair.startsWith('1,'));
      const styles = italic ? pairs.join(';') : pairs.map((pair) => pair.split(',')[1]).join(';');
      return `https://fonts.googleapis.com/css2?family=${encodeURIComponent(family).replace(/%20/g, '+')}:${italic ? 'ital,wght' : 'wght'}@${styles}&display=swap`;
    });
}
/** Extract font settings, including inline rich text, without exposing message text. */
export function newsletterDesignFontRequests(design: NewsletterDesign): NewsletterFontRequest[] {
  const requests: NewsletterFontRequest[] = [];
  const style = (value: NewsletterStyle) => {
    if (value.fontFamily)
      requests.push({
        value: value.fontFamily,
        bold: value.bold,
        italic: value.italic,
        weight: value.fontWeight,
      });
  };
  const html = (markup: string) => {
    for (const match of markup.matchAll(/\bstyle="([^"]*)"/gi)) {
      const css = match[1]!.replace(/&quot;/g, '"').replace(/&#(?:39|x27);/gi, "'");
      const family = /(?:^|;)\s*font-family\s*:\s*([^;]+)/i.exec(css)?.[1];
      if (!family) continue;
      const weight = /(?:^|;)\s*font-weight\s*:\s*(\d+|bold|normal)/i.exec(css)?.[1];
      const italic = /(?:^|;)\s*font-style\s*:\s*(italic|normal)/i.exec(css)?.[1];
      requests.push({
        value: family,
        ...(weight
          ? { weight: weight === 'bold' ? 700 : weight === 'normal' ? 400 : Number(weight) }
          : {}),
        ...(italic ? { italic: italic === 'italic' } : {}),
      });
    }
  };
  for (const value of Object.values(design.styles)) {
    if (value && typeof value === 'object') {
      if ('fontFamily' in value) style(value as NewsletterStyle);
      else
        for (const nested of Object.values(value))
          if (nested && typeof nested === 'object') style(nested as NewsletterStyle);
    }
  }
  const blocks = (items: NewsletterDesign['sections'][number]['blocks']) => {
    for (const block of items) {
      style(block.style);
      style(block.mobileStyle);
      html(block.html);
      for (const column of block.columns) blocks(column);
    }
  };
  for (const section of design.sections) {
    style(section.style);
    blocks(section.blocks);
  }
  return requests;
}
