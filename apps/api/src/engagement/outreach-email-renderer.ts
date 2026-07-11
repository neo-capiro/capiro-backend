/**
 * OutreachEmailRenderer (plan W6.1) — the ONE place outreach email bodies are
 * rendered for send: HTML sanitize (a single shared allowlist), plaintext escape,
 * and signature append. Extracted verbatim from sendBatchEmails so every send
 * path (batch send, the async send worker, and the legacy campaign send when it
 * adopts this) produces byte-identical output. Pure — no I/O — so it is
 * golden-tested directly.
 *
 * The signature is appended AFTER the body's own sanitize, without re-stripping:
 * it arrives already sanitized (sanitize-signature.ts on save + a defensive
 * re-sanitize on read in the caller), which is how branded markup (logos/tables)
 * survives that a body-level allowlist would strip.
 */
import sanitizeHtml from 'sanitize-html';

export type OutreachBodyContentType = 'Text' | 'HTML';

export interface RenderedOutreachBody {
  content: string;
  contentType: OutreachBodyContentType;
}

/** Body sanitize allowlist for outbound outreach (defense-in-depth on send). */
export const OUTREACH_BODY_SANITIZE_OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: [
    'b',
    'strong',
    'i',
    'em',
    'u',
    's',
    'p',
    'br',
    'h2',
    'h3',
    'ul',
    'ol',
    'li',
    'a',
    'blockquote',
    'div',
    'span',
  ],
  allowedAttributes: { a: ['href', 'target', 'rel'] },
  allowedSchemes: ['http', 'https', 'mailto'],
  transformTags: {
    a: sanitizeHtml.simpleTransform('a', { target: '_blank', rel: 'noopener noreferrer' }),
  },
};

/**
 * Render a draft body for send. v2 wizard drafts are HTML → sanitized + sent as
 * 'HTML'; a plaintext body (no tags) passes through as 'Text'. Mirrors the old
 * inline `renderBody` exactly.
 */
export function renderOutreachBody(raw: string | undefined): RenderedOutreachBody {
  const body = raw ?? '';
  if (!/<[a-z][\s\S]*>/i.test(body)) return { content: body, contentType: 'Text' };
  return { content: sanitizeHtml(body, OUTREACH_BODY_SANITIZE_OPTIONS), contentType: 'HTML' };
}

/** Escape a plaintext body so a following HTML signature renders. */
export function escapeOutreachPlaintext(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\n/g, '<br>');
}

/**
 * Append an (already-sanitized) signature to a rendered body. A plaintext body is
 * escaped to HTML first so the signature's markup renders; the result always
 * sends as HTML. No-op when there's no signature. Mirrors the old inline
 * `withSignature` exactly.
 */
export function appendOutreachSignature(
  rendered: RenderedOutreachBody,
  signatureHtml: string,
): RenderedOutreachBody {
  if (!signatureHtml) return rendered;
  const bodyHtml =
    rendered.contentType === 'HTML' ? rendered.content : escapeOutreachPlaintext(rendered.content);
  return { content: `${bodyHtml}<br><br>${signatureHtml}`, contentType: 'HTML' };
}
