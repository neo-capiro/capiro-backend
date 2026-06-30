import sanitizeHtml from 'sanitize-html';

/**
 * Server-authoritative sanitizer for per-user HTML email signatures.
 *
 * Signatures are richer than outreach bodies: users paste branded blocks from
 * Outlook/Gmail or upload an exported .html file, so we must preserve images
 * (logos), simple table layout, and a scrubbed set of inline styles — while
 * still stripping every script/style/handler/javascript: vector. This is the
 * ONLY trust boundary for signature HTML: it runs at save time (PUT
 * /me/email-signature), and the stored result is appended verbatim at send
 * time, so it has to be airtight here.
 *
 * The outbound email *body* keeps its own much stricter allowlist (no images);
 * only the signature block carries the broader markup.
 */

// Bound the stored blob. A signature with one inline (base64 data-URI) logo or
// an uploaded signature image is commonly 50–500 KB, but branded blocks pasted
// from Outlook/Gmail with a high-res photo can run several MB; 18 MB keeps even
// those intact (so the sanitizer never slices an image mid-base64 into a broken
// signature) while still bounding abuse. Must stay below the route's JSON body
// limit (24mb in main.ts) so an upload that survives parsing isn't then
// truncated here. The users-row read stays cheap because the hot /me path does
// NOT select this blob (only derives a boolean); the HTML loads on demand via
// GET /me/email-signature.
export const MAX_SIGNATURE_HTML_LENGTH = 18_000_000;

// Inline-style scrub: only these properties survive, and only when the value
// matches the paired pattern. Notably absent: background-image / anything that
// can carry url(...) (data exfiltration / request smuggling) and position/z-index.
const COLOR = [
  /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i,
  /^rgb\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*\)$/i,
  /^rgba\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*(?:0|1|0?\.\d+)\s*\)$/i,
  /^[a-z]+$/i,
];
const LENGTH = [/^-?\d+(?:\.\d+)?(?:px|pt|em|rem|%)$/i, /^0$/];
const MULTI_LENGTH = [
  /^(?:-?\d+(?:\.\d+)?(?:px|pt|em|rem|%)?|auto)(?:\s+(?:-?\d+(?:\.\d+)?(?:px|pt|em|rem|%)?|auto)){0,3}$/i,
];
// Border shorthand as a concrete grammar (width | style | color, 1–3 tokens):
// deliberately admits NO '(' so url()/expression() can never appear — earlier a
// permissive char-class allowed parens, a latent CSS-exfiltration footgun.
const BORDER = [
  /^(?:-?\d+(?:\.\d+)?(?:px|pt|em|rem|%)?|#[0-9a-f]{3,8}|[a-z]+)(?:\s+(?:-?\d+(?:\.\d+)?(?:px|pt|em|rem|%)?|#[0-9a-f]{3,8}|[a-z]+)){0,2}$/i,
];

const ALLOWED_STYLES: sanitizeHtml.IOptions['allowedStyles'] = {
  '*': {
    color: COLOR,
    'background-color': COLOR,
    'text-align': [/^(?:left|right|center|justify)$/i],
    'text-decoration': [/^(?:none|underline|line-through|overline)$/i],
    'font-size': LENGTH,
    'font-weight': [/^(?:normal|bold|bolder|lighter|\d{3})$/i],
    'font-style': [/^(?:normal|italic|oblique)$/i],
    'font-family': [/^[\w\s",'-]+$/i],
    'line-height': [/^\d+(?:\.\d+)?(?:px|pt|em|rem|%)?$/i],
    'letter-spacing': LENGTH,
    width: LENGTH,
    'max-width': LENGTH,
    height: LENGTH,
    margin: MULTI_LENGTH,
    'margin-top': LENGTH,
    'margin-bottom': LENGTH,
    'margin-left': LENGTH,
    'margin-right': LENGTH,
    padding: MULTI_LENGTH,
    'padding-top': LENGTH,
    'padding-bottom': LENGTH,
    'padding-left': LENGTH,
    'padding-right': LENGTH,
    'vertical-align': [/^(?:top|middle|bottom|baseline|sub|super)$/i],
    display: [/^(?:block|inline|inline-block|table|table-row|table-cell|none)$/i],
    border: BORDER,
    'border-color': COLOR,
    'border-top': BORDER,
    'border-bottom': BORDER,
  },
};

const OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: [
    'p',
    'br',
    'div',
    'span',
    'b',
    'strong',
    'i',
    'em',
    'u',
    's',
    'sub',
    'sup',
    'a',
    'img',
    'h1',
    'h2',
    'h3',
    'h4',
    'ul',
    'ol',
    'li',
    'blockquote',
    'hr',
    'table',
    'thead',
    'tbody',
    'tfoot',
    'tr',
    'td',
    'th',
    'font',
    'small',
    'center',
  ],
  allowedAttributes: {
    '*': ['style'],
    a: ['href', 'target', 'rel', 'style'],
    img: ['src', 'alt', 'title', 'width', 'height', 'style'],
    font: ['color', 'face', 'size'],
    table: ['width', 'cellpadding', 'cellspacing', 'border', 'align', 'bgcolor', 'style'],
    tr: ['align', 'valign', 'bgcolor', 'style'],
    td: ['width', 'height', 'align', 'valign', 'colspan', 'rowspan', 'bgcolor', 'style'],
    th: ['width', 'height', 'align', 'valign', 'colspan', 'rowspan', 'bgcolor', 'style'],
  },
  allowedStyles: ALLOWED_STYLES,
  // mailto/tel are common in signatures; data: is permitted for <img> only and
  // is further narrowed to base64 raster images by the img transform below.
  allowedSchemes: ['http', 'https', 'mailto', 'tel'],
  allowedSchemesByTag: { img: ['http', 'https', 'data'] },
  allowedSchemesAppliedToAttributes: ['href', 'src'],
  // Default nonTextTags ['script','style','textarea','option','noscript'] drop
  // both the tag AND its text content — exactly what we want for script/style.
  transformTags: {
    a: (_tagName, attribs) => {
      const href = (attribs.href ?? '').trim();
      const safeHref = /^(?:https?:|mailto:|tel:)/i.test(href);
      return {
        tagName: 'a',
        attribs: {
          ...(safeHref ? { href } : {}),
          target: '_blank',
          rel: 'noopener noreferrer',
          ...(attribs.style ? { style: attribs.style } : {}),
        },
      };
    },
    img: (_tagName, attribs) => {
      const src = (attribs.src ?? '').trim();
      // https(s) hosted images, or inline base64 RASTER images only. Reject
      // data:image/svg+xml (can carry script) and any non-image data URI.
      const ok =
        /^https?:\/\//i.test(src) || /^data:image\/(?:png|jpe?g|gif|webp|bmp);base64,/i.test(src);
      const out: Record<string, string> = {};
      if (ok) out.src = src;
      if (attribs.alt) out.alt = attribs.alt;
      if (attribs.width) out.width = attribs.width;
      if (attribs.height) out.height = attribs.height;
      if (attribs.style) out.style = attribs.style;
      return { tagName: 'img', attribs: out };
    },
  },
  // Drop <img> whose src was rejected above (an img with no src is dead weight).
  exclusiveFilter: (frame) => frame.tag === 'img' && !frame.attribs.src,
};

/**
 * Sanitize a user-supplied HTML email signature to a safe, storable fragment.
 * Returns '' for empty/whitespace-only input. Input is truncated to
 * {@link MAX_SIGNATURE_HTML_LENGTH} before processing.
 */
export function sanitizeSignatureHtml(html: string | null | undefined): string {
  if (!html) return '';
  const bounded =
    html.length > MAX_SIGNATURE_HTML_LENGTH ? html.slice(0, MAX_SIGNATURE_HTML_LENGTH) : html;
  const clean = sanitizeHtml(bounded, OPTIONS).trim();
  // If nothing but whitespace/empty tags survived, treat as "no signature".
  return clean.replace(/<[^>]+>/g, '').trim().length || /<img\b/i.test(clean) ? clean : '';
}
