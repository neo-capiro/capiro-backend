/**
 * Workspace-document body sanitizer.
 *
 * The shared outreach sanitizer (engagement/outreach/v2/richtext.ts) strips ALL
 * attributes except href, which silently erased font-family / font-size / text-
 * align / indent the moment the editor re-sanitized on every keystroke — the
 * root cause of E-13 (font does nothing) and E-14 (alignment/indent buttons do
 * nothing). This is a SEPARATE, slightly wider allowlist used ONLY by the
 * Workspace editor so the outreach body sanitizer stays tight.
 *
 * It keeps the same XSS guarantees: only allowlisted tags survive, only a safe
 * href on <a>, and a narrow style-property whitelist whose values reject
 * url()/expression()/javascript: and angle brackets. Tables + lists are allowed
 * so Meri-drafted sections (E-4) can emit real bullet lists / tables.
 */

const ALLOWED_TAGS = new Set([
  'B',
  'STRONG',
  'I',
  'EM',
  'U',
  'S',
  'P',
  'BR',
  'H2',
  'H3',
  'UL',
  'OL',
  'LI',
  'A',
  'BLOCKQUOTE',
  'DIV',
  'SPAN',
  // Tables (Meri section format E-4) — simple, no attributes beyond style.
  'TABLE',
  'THEAD',
  'TBODY',
  'TR',
  'TD',
  'TH',
]);

// Inline/formatting style properties we let through (everything else dropped).
const ALLOWED_STYLE_PROPS = new Set([
  'font-family',
  'font-size',
  'text-align',
  'margin-left',
  'padding-left',
  'font-weight',
  'font-style',
  'text-decoration',
]);

/** Keep only whitelisted, safe style declarations; drop the rest. */
function safeStyle(style: string): string {
  const out: string[] = [];
  for (const decl of style.split(';')) {
    const idx = decl.indexOf(':');
    if (idx < 0) continue;
    const prop = decl.slice(0, idx).trim().toLowerCase();
    const val = decl.slice(idx + 1).trim();
    if (!ALLOWED_STYLE_PROPS.has(prop) || !val) continue;
    // Reject anything that could smuggle script / external fetches.
    if (/url\(|expression\(|javascript:|[<>]/i.test(val)) continue;
    if (prop === 'text-align' && !/^(left|right|center|justify)$/i.test(val)) continue;
    if (
      prop === 'font-size' &&
      !/^(xx-small|x-small|small|medium|large|x-large|xx-large|\d+(\.\d+)?(px|pt|em|rem)?)$/i.test(
        val,
      )
    )
      continue;
    if (
      (prop === 'margin-left' || prop === 'padding-left') &&
      !/^\d+(\.\d+)?(px|pt|em|rem|%)?$/i.test(val)
    )
      continue;
    out.push(`${prop}: ${val}`);
  }
  return out.join('; ');
}

function cleanInto(node: Node, out: Node, doc: Document): void {
  node.childNodes.forEach((child) => {
    if (child.nodeType === Node.TEXT_NODE) {
      out.appendChild(doc.createTextNode(child.textContent ?? ''));
      return;
    }
    if (child.nodeType !== Node.ELEMENT_NODE) return; // drop comments etc.
    const el = child as Element;
    if (ALLOWED_TAGS.has(el.tagName)) {
      const clean = doc.createElement(el.tagName.toLowerCase());
      if (el.tagName === 'A') {
        const href = el.getAttribute('href') ?? '';
        if (/^(https?:|mailto:)/i.test(href)) {
          clean.setAttribute('href', href);
          clean.setAttribute('target', '_blank');
          clean.setAttribute('rel', 'noopener noreferrer');
        }
      }
      const style = el.getAttribute('style');
      if (style) {
        const safe = safeStyle(style);
        if (safe) clean.setAttribute('style', safe);
      }
      cleanInto(el, clean, doc);
      out.appendChild(clean);
    } else {
      // Disallowed element: keep its text, drop the tag (script/style never reach
      // here as executable — DOMParser doesn't run them).
      cleanInto(el, out, doc);
    }
  });
}

/**
 * Sanitize Workspace section/body HTML to the workspace allowlist, preserving
 * safe inline font/alignment/indent styling. Run on editor input/paste and at
 * render time (Preview).
 */
export function sanitizeWorkspaceBody(html: string): string {
  if (typeof document === 'undefined') return html;
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
  const out = doc.createElement('div');
  cleanInto(doc.body, out, doc);
  return out.innerHTML;
}
