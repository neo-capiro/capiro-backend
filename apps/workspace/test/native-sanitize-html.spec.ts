import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import sanitizeHtml from 'sanitize-html';

describe('Workspace native sanitizer bridge', () => {
  it('exposes the real installed parser with its defaults and policy transforms', () => {
    expect(sanitizeHtml.defaults.allowedTags).toContain('strong');
    const input = '<p>Hello <strong>fixture</strong><script>alert(1)</script>'
      + '<a href="javascript:alert(1)">link</a></p>';
    expect(sanitizeHtml(input)).toBe('<p>Hello <strong>fixture</strong><a>link</a></p>');
    expect(sanitizeHtml('<b>fixture</b><i>tail</i>', {
      allowedTags: ['strong'], transformTags: { b: 'strong' },
    })).toBe('<strong>fixture</strong>tail');
    expect(sanitizeHtml('<iframe><b>fixture</b>', {
      allowedTags: ['b'], nestingLimit: 3,
    })).toBe('<b>fixture</b>');
  });

  it('fails closed when the native export is missing or malformed', () => {
    const bridge = readFileSync(path.resolve(__dirname, '../jest.native-sanitize-html.cjs'), 'utf8');
    for (const candidate of [undefined, null, {}, 'stub']) {
      expect(() => vm.runInNewContext(bridge, {
        module: { exports: {} }, __CAPIRO_JEST_NATIVE_SANITIZE_HTML__: candidate,
      })).toThrow(/refusing a stub or fallback/);
    }
  });
});
