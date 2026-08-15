import { sanitizeGeneratedHtml } from './html-sanitizer.js';

describe('sanitizeGeneratedHtml', () => {
  it('returns empty string for falsy input', () => {
    expect(sanitizeGeneratedHtml('')).toBe('');
    expect(sanitizeGeneratedHtml(null as unknown as string)).toBe('');
  });

  it('preserves safe HTML tags', () => {
    const input = '<p>Hello <strong>world</strong> and <em>emphasis</em>.</p>';
    expect(sanitizeGeneratedHtml(input)).toBe(input);
  });

  it('preserves lists and tables', () => {
    const input = '<ul><li>One</li><li>Two</li></ul><table><tr><td>A</td></tr></table>';
    expect(sanitizeGeneratedHtml(input)).toBe(input);
  });

  it('strips script tags completely', () => {
    const input = '<p>Safe</p><script>alert("xss")</script><p>Also safe</p>';
    const result = sanitizeGeneratedHtml(input);
    expect(result).toBe('<p>Safe</p><p>Also safe</p>');
    expect(result).not.toContain('script');
    expect(result).not.toContain('alert');
  });

  it('strips style tags', () => {
    const input = '<p>Text</p><style>body { color: red; }</style>';
    expect(sanitizeGeneratedHtml(input)).toBe('<p>Text</p>');
  });

  it('strips iframe tags', () => {
    const input = '<p>Text</p><iframe src="https://evil.com"></iframe>';
    expect(sanitizeGeneratedHtml(input)).toBe('<p>Text</p>');
  });

  it('strips object and embed tags', () => {
    const input = '<p>Text</p><object data="evil.swf"></object><embed src="evil.swf">';
    expect(sanitizeGeneratedHtml(input)).toBe('<p>Text</p>');
  });

  it('strips svg and math tags', () => {
    const input = '<p>Text</p><svg onload="alert(1)"></svg><math></math>';
    expect(sanitizeGeneratedHtml(input)).toBe('<p>Text</p>');
  });

  it('strips event handler attributes', () => {
    const input = '<p onclick="alert(1)">Text</p>';
    expect(sanitizeGeneratedHtml(input)).toBe('<p>Text</p>');
  });

  it('strips onmouseover, onfocus, etc', () => {
    const input = '<a href="https://safe.com" onmouseover="evil()">Link</a>';
    const result = sanitizeGeneratedHtml(input);
    expect(result).not.toContain('onmouseover');
    expect(result).toContain('href=');
  });

  it('replaces javascript: URLs with #', () => {
    const input = '<a href="javascript:alert(1)">Link</a>';
    const result = sanitizeGeneratedHtml(input);
    expect(result).not.toContain('javascript:');
    expect(result).toContain('href="#"');
  });

  it('strips style attributes', () => {
    const input = '<p style="color: red">Text</p>';
    expect(sanitizeGeneratedHtml(input)).toBe('<p>Text</p>');
  });

  it('strips class attributes', () => {
    const input = '<p class="evil">Text</p>';
    expect(sanitizeGeneratedHtml(input)).toBe('<p>Text</p>');
  });

  it('strips id attributes', () => {
    const input = '<p id="evil">Text</p>';
    expect(sanitizeGeneratedHtml(input)).toBe('<p>Text</p>');
  });

  it('strips HTML comments', () => {
    const input = '<p>Text</p><!-- evil comment -->';
    expect(sanitizeGeneratedHtml(input)).toBe('<p>Text</p>');
  });

  it('strips CDATA sections', () => {
    const input = '<p>Text</p><![CDATA[evil]]>';
    expect(sanitizeGeneratedHtml(input)).toBe('<p>Text</p>');
  });

  it('strips processing instructions', () => {
    const input = '<p>Text</p><?php echo "evil"; ?>';
    expect(sanitizeGeneratedHtml(input)).toBe('<p>Text</p>');
  });

  it('strips unapproved tags but keeps content', () => {
    const input = '<p>Text</p><div>div content</div><form>form content</form>';
    const result = sanitizeGeneratedHtml(input);
    expect(result).toContain('<p>Text</p>');
    expect(result).toContain('<div>div content</div>');
    expect(result).not.toContain('<form');
    expect(result).toContain('form content');
  });

  it('adds rel="noopener noreferrer" to target="_blank" links', () => {
    const input = '<a href="https://safe.com" target="_blank">Link</a>';
    const result = sanitizeGeneratedHtml(input);
    expect(result).toContain('rel="noopener noreferrer"');
  });

  it('preserves safe href protocols', () => {
    const input = '<a href="https://example.com">Link</a><a href="mailto:test@example.com">Email</a>';
    const result = sanitizeGeneratedHtml(input);
    expect(result).toContain('https://example.com');
    expect(result).toContain('mailto:test@example.com');
  });

  it('replaces data: URLs in src with #', () => {
    const input = '<img src="data:image/png;base64,evil">';
    const result = sanitizeGeneratedHtml(input);
    expect(result).not.toContain('data:');
  });

  it('wraps plain text in paragraphs', () => {
    const input = 'First paragraph\n\nSecond paragraph';
    const result = sanitizeGeneratedHtml(input);
    expect(result).toContain('<p>');
    expect(result).toContain('First paragraph');
    expect(result).toContain('Second paragraph');
  });

  it('converts single newlines to br within paragraphs', () => {
    const input = 'Line one\nLine two';
    const result = sanitizeGeneratedHtml(input);
    expect(result).toContain('<br>');
  });

  it('handles nested safe tags', () => {
    const input = '<div><p>Nested <strong>text</strong></p></div>';
    expect(sanitizeGeneratedHtml(input)).toBe(input);
  });

  it('strips form, input, textarea, button, select tags but keeps text content', () => {
    const input = '<p>Text</p><form><input type="text"><button>Click</button><select><option>A</option></select>form content</form>';
    const result = sanitizeGeneratedHtml(input);
    expect(result).toContain('<p>Text</p>');
    expect(result).not.toContain('<form');
    expect(result).not.toContain('<input');
    expect(result).not.toContain('<button');
    expect(result).not.toContain('<select');
    expect(result).toContain('form content');
  });

  it('preserves sup and sub tags for citations', () => {
    const input = '<p>Claim<sup>[1]</sup> and H<sub>2</sub>O</p>';
    expect(sanitizeGeneratedHtml(input)).toBe(input);
  });

  it('handles empty input gracefully', () => {
    expect(sanitizeGeneratedHtml('   ')).toBe('');
  });

  it('strips meta, base, link tags', () => {
    const input = '<p>Text</p><meta charset="utf-8"><base href="evil"><link rel="stylesheet" href="evil.css">';
    const result = sanitizeGeneratedHtml(input);
    expect(result).toBe('<p>Text</p>');
  });
});
