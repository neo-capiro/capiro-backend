/** Convert source HTML to readable text. The result must be rendered as React text,
 * never injected as HTML: decoded entities can themselves contain markup. */
export function opportunityDescriptionText(description: string): string {
  if (typeof DOMParser === 'undefined') return description;
  const document = new DOMParser().parseFromString(description, 'text/html');
  document
    .querySelectorAll('script, style, template, iframe, object, embed, noscript, svg, math')
    .forEach((element) => element.remove());
  const blocks = new Set([
    'P',
    'DIV',
    'SECTION',
    'ARTICLE',
    'H1',
    'H2',
    'H3',
    'H4',
    'H5',
    'H6',
    'UL',
    'OL',
    'BLOCKQUOTE',
    'TR',
  ]);
  function read(node: Node): string {
    if (node.nodeType === 3) return node.textContent ?? '';
    if (node.nodeType !== 1) return '';
    const element = node as Element;
    if (element.tagName === 'BR') return '\n';
    const content = Array.from(element.childNodes, read).join('');
    if (element.tagName === 'LI') return `\n• ${content.trim()}\n`;
    if (element.tagName === 'TD' || element.tagName === 'TH') return `${content}\t`;
    return blocks.has(element.tagName) ? `\n${content}\n` : content;
  }
  return Array.from(document.body.childNodes, read)
    .join('')
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
