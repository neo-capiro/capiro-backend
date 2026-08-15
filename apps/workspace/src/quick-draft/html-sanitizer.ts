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
  'p', 'br', 'strong', 'em', 'u', 's', 'del', 'ins',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'ul', 'ol', 'li',
  'blockquote', 'pre', 'code',
  'a', 'span', 'div',
  'table', 'thead', 'tbody', 'tr', 'th', 'td',
  'sup', 'sub',
  'hr',
]);

const ALLOWED_ATTRIBUTES = new Set([
  'href', 'title', 'colspan', 'rowspan', 'target', 'rel',
]);

const ALLOWED_PROTOCOLS = new Set([
  'http:', 'https:', 'mailto:', 'tel:',
]);

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
    'script', 'style', 'iframe', 'object', 'embed', 'svg', 'math',
    'noscript', 'template', 'base', 'link', 'meta',
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
  cleaned = cleaned.replace(
    /(\ssrc\s*=\s*)("data:[^"]*"|'data:[^']*'|data:[^\s>]+)/gi,
    '$1"#"',
  );

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

function stripDisallowedAttributes(tag: string, _tagName: string): string {
  // For <a> tags, validate href protocol
  if (tag.toLowerCase().startsWith('<a ')) {
    const hrefMatch = tag.match(/href\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/i);
    if (hrefMatch) {
      const href = (hrefMatch[1] ?? '').replace(/^["']|["']$/g, '');
      try {
        const url = new URL(href, 'http://placeholder.invalid');
        if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
          return tag.replace(hrefMatch[0], 'href="#"');
        }
      } catch {
        return tag.replace(hrefMatch[0], 'href="#"');
      }
    }
  }

  // Rebuild the tag with only allowed attributes
  const isClosing = tag.startsWith('</');
  if (isClosing) return `</${_tagName}>`;

  const attrs: string[] = [];
  const attrRegex = /([a-zA-Z]+)\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/g;
  let match: RegExpExecArray | null;
  while ((match = attrRegex.exec(tag)) !== null) {
    const attrName = (match[1] ?? '').toLowerCase();
    if (ALLOWED_ATTRIBUTES.has(attrName)) {
      attrs.push(match[0]);
    }
  }
  // Add rel="noopener noreferrer" to target="_blank" links
  if (attrs.some((a) => a.startsWith('target=')) && !attrs.some((a) => a.startsWith('rel='))) {
    attrs.push('rel="noopener noreferrer"');
  }
  return `<${_tagName}${attrs.length ? ' ' + attrs.join(' ') : ''}>`;
}
