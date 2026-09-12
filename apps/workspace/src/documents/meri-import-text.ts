/**
 * Plain-text projection for Meri's import chooser.
 *
 * Document bodies store HTML inside `blocks[].content`, and every draft is
 * created with one empty primary document tab whose prose actually lives in
 * `config.sectionContent`. Meri's composer takes text, so the import falls back
 * to the draft's sections when the selected tab has no body of its own.
 */

const BLOCK_BREAK = /<\/(?:p|div|h[1-6]|li|tr|blockquote|section)\s*>|<br\s*\/?>/gi;

export function htmlToPlainText(html: string): string {
  return html
    .replace(BLOCK_BREAK, '\n')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/[^\S\n]+/g, ' ')
    .replace(/[^\S\n]?\n[^\S\n]?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function documentBlocksText(body: unknown): string {
  const blocks = asObject(body).blocks;
  if (!Array.isArray(blocks)) return '';
  return blocks
    .map((raw) => {
      const block = asObject(raw);
      const title = typeof block.title === 'string' ? htmlToPlainText(block.title) : '';
      const content = typeof block.content === 'string' ? htmlToPlainText(block.content) : '';
      return [title, content].filter(Boolean).join('\n');
    })
    .filter(Boolean)
    .join('\n\n');
}

function draftSectionsText(config: unknown): string {
  const cfg = asObject(config);
  const sectionContent = asObject(cfg.sectionContent);
  const ordered = Array.isArray(cfg.sections)
    ? cfg.sections.filter((section): section is string => typeof section === 'string')
    : [];
  const sections = ordered.length ? ordered : Object.keys(sectionContent);
  return sections
    .map((section) => {
      const raw = sectionContent[section];
      const text = typeof raw === 'string' ? htmlToPlainText(raw) : '';
      return text ? `${section}\n${text}` : '';
    })
    .filter(Boolean)
    .join('\n\n');
}

export function meriImportText(body: unknown, draftConfig: unknown): string {
  return documentBlocksText(body) || draftSectionsText(draftConfig);
}
