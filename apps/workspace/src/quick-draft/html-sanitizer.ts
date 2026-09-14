/**
 * Canonical server-side rich-text sanitizer for Workspace generation output.
 *
 * Replaces the regex-only `safeHtmlFragment` trust boundary. This allowlist-based
 * sanitizer blocks scripts, styles, event handlers, dangerous URL schemes, unsafe
 * SVG/MathML, iframe/object/embed, unapproved tags and attributes, and CSS-based
 * script or data exfiltration vectors.
 *
 * Defense-in-depth: sanitize before persistence AND again at rendering.
 */

const ALLOWED_TAGS = new Set([
  'p',
  'br',
  'strong',
  'em',
  'u',
  's',
  'del',
  'ins',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'ul',
  'ol',
  'li',
  'blockquote',
  'pre',
  'code',
  'a',
  'span',
  'div',
  'table',
  'thead',
  'tbody',
  'tr',
  'th',
  'td',
  'sup',
  'sub',
  'hr',
]);

const ALLOWED_ATTRIBUTES = new Set(['href', 'title', 'colspan', 'rowspan', 'target', 'rel']);

const ALLOWED_PROTOCOLS = new Set(['http:', 'https:', 'mailto:', 'tel:']);

/**
 * Sanitize an HTML fragment from model generation output.
 * Returns clean HTML containing only allowlisted tags and attributes.
 * Strips all scripts, event handlers, dangerous URLs, and unapproved content.
 */
export function sanitizeGeneratedHtml(input: string): string {
  if (!input || typeof input !== 'string') return '';

  // The input from the model may contain HTML. We parse it in a controlled
  // way by operating on the string directly (no DOM parser in Node.js by
  // default). This is a tag-allowlist approach, not a denylist.

  // Step 1: Remove entire dangerous blocks (script, style, iframe, object,
  // embed, svg, math, noscript, template, form, input, textarea, button,
  // select, option).
  const dangerousBlocks = [
    'script',
    'style',
    'iframe',
    'object',
    'embed',
    'svg',
    'math',
    'noscript',
    'template',
    'base',
    'link',
    'meta',
  ];
  let cleaned = input;
  for (const tag of dangerousBlocks) {
    const openTag = new RegExp(`<\\s*${tag}\\b[^>]*>[\\s\\S]*?<\\s*/\\s*${tag}\\s*>`, 'gi');
    cleaned = cleaned.replace(openTag, '');
    // Also remove self-closing variants
    const selfClosing = new RegExp(`<\\s*${tag}\\b[^>]*/\\s*>`, 'gi');
    cleaned = cleaned.replace(selfClosing, '');
    // And unclosed opening tags
    const openOnly = new RegExp(`<\\s*${tag}\\b[^>]*>`, 'gi');
    cleaned = cleaned.replace(openOnly, '');
  }

  // Step 2: Remove all event handler attributes (on*).
  cleaned = cleaned.replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '');

  // Step 3: Remove javascript: URLs in href and src.
  cleaned = cleaned.replace(
    /(\shref\s*=\s*)("javascript:[^"]*"|'javascript:[^']*'|javascript:[^\s>]+)/gi,
    '$1"#"',
  );
  cleaned = cleaned.replace(
    /(\ssrc\s*=\s*)("javascript:[^"]*"|'javascript:[^']*'|javascript:[^\s>]+)/gi,
    '$1"#"',
  );

  // Step 4: Remove data: URLs in src (can be used for exfiltration).
  cleaned = cleaned.replace(/(\ssrc\s*=\s*)("data:[^"]*"|'data:[^']*'|data:[^\s>]+)/gi, '$1"#"');

  // Step 5: Remove style attributes (CSS-based exfiltration).
  cleaned = cleaned.replace(/\sstyle\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '');

  // Step 6: Remove class attributes (can be used with CSS injection).
  cleaned = cleaned.replace(/\sclass\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '');

  // Step 7: Remove id attributes (can be used with CSS injection).
  cleaned = cleaned.replace(/\sid\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '');

  // Step 8: Remove HTML comments (can hide conditional-comment attacks).
  cleaned = cleaned.replace(/<!--[\s\S]*?-->/g, '');

  // Step 9: Remove CDATA sections.
  cleaned = cleaned.replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, '');

  // Step 10: Remove processing instructions.
  cleaned = cleaned.replace(/<\?[\s\S]*?\?>/g, '');

  // Step 11: Remove XML declarations.
  cleaned = cleaned.replace(/<\?xml[^>]*\?>/gi, '');

  // Step 12: Remove DOCTYPE declarations.
  cleaned = cleaned.replace(/<!DOCTYPE[^>]*>/gi, '');

  // Step 13: Strip tags not in the allowlist. We do this by parsing the
  // remaining tags and keeping only allowlisted ones.
  cleaned = cleaned.replace(/<\/?([a-zA-Z][a-zA-Z0-9]*)\b[^>]*>/g, (match, tagName) => {
    const lower = tagName.toLowerCase();
    if (ALLOWED_TAGS.has(lower)) {
      // Keep the tag but strip disallowed attributes
      return stripDisallowedAttributes(match, lower);
    }
    return '';
  });

  // Step 14: If the result doesn't contain any HTML tags, wrap paragraphs.
  if (!/<[a-z][\s\S]*>/i.test(cleaned) && cleaned.trim()) {
    return cleaned
      .split(/\n{2,}/)
      .map(
        (paragraph) =>
          `<p>${paragraph
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/\n/g, '<br>')}</p>`,
      )
      .join('');
  }

  return cleaned.trim();
}

function stripDisallowedAttributes(tag: string, tagName: string): string {
  if (tag.startsWith('</')) return `</${tagName}>`;
  const decode = (value: string) =>
    value.replace(
      /&#(x[0-9a-f]+|[0-9]+);?|&(amp|quot|apos|lt|gt|colon|tab|newline);/gi,
      (entity, numeric, named) => {
        if (numeric) {
          const n = parseInt(
            numeric[0].toLowerCase() === 'x' ? numeric.slice(1) : numeric,
            numeric[0].toLowerCase() === 'x' ? 16 : 10,
          );
          return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : '\ufffd';
        }
        return (
          (
            {
              amp: '&',
              quot: '"',
              apos: "'",
              lt: '<',
              gt: '>',
              colon: ':',
              tab: '\t',
              newline: '\n',
            } as Record<string, string>
          )[named.toLowerCase()] ?? entity
        );
      },
    );
  const escape = (value: string) =>
    value.replace(
      /[&<>"']/g,
      (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
    );
  const attrs = new Map<string, string>();
  const pattern = /\s([a-zA-Z][a-zA-Z0-9-]*)\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(tag))) {
    const name = match[1]!.toLowerCase();
    if (!ALLOWED_ATTRIBUTES.has(name) || attrs.has(name)) continue;
    let value = decode(match[2]!.replace(/^["']|["']$/g, ''));
    if (name === 'href') {
      if (tagName !== 'a') continue;
      try {
        if (!ALLOWED_PROTOCOLS.has(new URL(value, 'https://placeholder.invalid').protocol))
          value = '#';
      } catch {
        value = '#';
      }
    }
    if ((name === 'colspan' || name === 'rowspan') && !/^[1-9][0-9]{0,2}$/.test(value)) continue;
    if (name === 'target' && !['_blank', '_self'].includes(value)) continue;
    if (name === 'rel') continue;
    attrs.set(name, value);
  }
  if (attrs.has('target')) attrs.set('rel', 'noopener noreferrer');
  return `<${tagName}${Array.from(attrs, ([name, value]) => ` ${name}="${escape(value)}"`).join('')}>`;
}
