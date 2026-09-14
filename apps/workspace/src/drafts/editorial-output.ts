import { sanitizeGeneratedHtml } from '../quick-draft/html-sanitizer.js';
import { htmlToPlainText } from '../documents/meri-import-text.js';
import { anonymizeText, applyRedactions } from '../generation/anonymize.js';

const object = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const escape = (v: unknown) =>
  String(v ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );

/** Same content model and order as Workspace export: packet additions, then
 * edited config sections and main blocks. The primary document row is vestigial.
 * Both formats are frozen in the report approval; source receipts stay intact. */
export function renderEditorialOutput(snapshot: {
  title: string;
  config: unknown;
  documents: Array<{ name: string; body: unknown }>;
}) {
  const cfg = object(snapshot.config),
    content = object(cfg.sectionContent);
  const sections = Array.isArray(cfg.sections)
    ? cfg.sections.filter((s): s is string => typeof s === 'string')
    : [];
  const map = object(cfg.anonymizeMap);
  const redact = (text: string) => {
    if (!cfg.anonymize || map.exportMode === 'original') return text;
    const redactions = Array.isArray(map.redactions)
      ? (map.redactions as Array<{ from: string; to: string }>)
      : [];
    return redactions.length
      ? applyRedactions(text, redactions)
      : anonymizeText(text, {
          client: typeof cfg.client === 'string' ? cfg.client : null,
          offices: Array.isArray(cfg.offices) ? (cfg.offices as string[]) : [],
        }).text;
  };
  const rich = (value: unknown) => sanitizeGeneratedHtml(redact(String(value ?? '')));
  const blocks = (value: unknown) =>
    (Array.isArray(value) ? value : [])
      .map((raw) => {
        const b = object(raw);
        if (b.type === 'section') return rich(b.content);
        if (b.type === 'table' && Array.isArray(b.cells))
          return (
            '<table>' +
            b.cells
              .filter(Array.isArray)
              .map(
                (row, i) =>
                  '<tr>' +
                  row
                    .map(
                      (cell: unknown) =>
                        `<${i ? 'td' : 'th'}>${escape(redact(String(cell ?? '')))}</${i ? 'td' : 'th'}>`,
                    )
                    .join('') +
                  '</tr>',
              )
              .join('') +
            '</table>'
          );
        // Reports cannot silently claim exact output while dropping inserted media.
        if (b.type === 'photo' || b.type === 'logo')
          throw new Error('EDITORIAL_MEDIA_REQUIRES_DOCUMENT_EXPORT');
        return '';
      })
      .join('');
  const additions = snapshot.documents
    .slice(1)
    .map((d) => {
      const body = object(d.body);
      return `<h1>${escape(redact(String(body.title || d.name)))}</h1>${blocks(body.blocks)}`;
    })
    .join('');
  const main = sections
    .map(
      (name) =>
        `<h2>${escape(redact(name))}</h2>${rich(content[name]) || '<p>Not yet drafted.</p>'}`,
    )
    .join('');
  const body = `${additions}<h1>${escape(redact(snapshot.title))}</h1>${main}${blocks(cfg.mainBlocks)}`;
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>body{font:16px/1.6 Arial,sans-serif;color:#182230;max-width:760px;margin:32px auto;padding:0 24px}h1{font-size:28px}h2{font-size:21px;margin-top:28px}h3{font-size:17px}table{border-collapse:collapse;width:100%}th,td{border:1px solid #d0d5dd;padding:8px;text-align:left}blockquote{border-left:3px solid #d0d5dd;margin-left:0;padding-left:16px;color:#475467}a{color:#175cd3;overflow-wrap:anywhere}</style></head><body>${body}</body></html>`;
  return { html, text: htmlToPlainText(body), rendererVersion: 'workspace-editorial-html-v1' };
}
