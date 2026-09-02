import { extractStreamingJsonStringField } from './streaming-json-field.js';

describe('extractStreamingJsonStringField', () => {
  it('extracts a complete simple string value', () => {
    expect(extractStreamingJsonStringField('{"subject":"Hello there"}', 'subject')).toBe(
      'Hello there',
    );
  });

  it('extracts a value that is still arriving, before its closing quote', () => {
    expect(extractStreamingJsonStringField('{"subject":"Hello th', 'subject')).toBe('Hello th');
  });

  it('returns empty before the field key has appeared at all', () => {
    expect(extractStreamingJsonStringField('{"subj', 'subject')).toBe('');
    expect(extractStreamingJsonStringField('', 'subject')).toBe('');
  });

  it('returns empty once the key has arrived but the colon/value has not', () => {
    expect(extractStreamingJsonStringField('{"subject"', 'subject')).toBe('');
    expect(extractStreamingJsonStringField('{"subject":', 'subject')).toBe('');
    expect(extractStreamingJsonStringField('{"subject": ', 'subject')).toBe('');
    expect(extractStreamingJsonStringField('{"subject":"', 'subject')).toBe('');
  });

  it('tolerates whitespace between the key, colon, and opening quote', () => {
    expect(extractStreamingJsonStringField('{"subject" :  "Hi"', 'subject')).toBe('Hi');
    expect(extractStreamingJsonStringField('{\n  "subject"\n:\n"Hi"', 'subject')).toBe('Hi');
  });

  it('returns empty when the value is not a string', () => {
    expect(extractStreamingJsonStringField('{"count":42', 'count')).toBe('');
    expect(extractStreamingJsonStringField('{"active":true', 'active')).toBe('');
  });

  // The fixtures below build the RAW (as-if-on-the-wire) JSON text, which
  // itself contains literal backslash-escape sequences the function under
  // test must decode. Written as plain single-quoted strings with `\\`
  // rather than String.raw template literals: a template literal tagged with
  // String.raw is still checked for escape-sequence validity before the tag
  // runs, and several of these are deliberately invalid or incomplete (an
  // unterminated \u escape, an unrecognized \q) — exactly the cases under
  // test — which this project's TS/Jest transform rejects as a syntax error
  // in tagged-template form.

  it('decodes every simple JSON escape', () => {
    const quote = String.fromCharCode(0x22);
    const raw =
      '{"body":"Quote: \\' +
      quote +
      ' Backslash: \\\\ Slash: \\/ Newline:\\nTab:\\tCR:\\rBS:\\bFF:\\f"';
    expect(extractStreamingJsonStringField(raw, 'body')).toBe(
      'Quote: ' + quote + ' Backslash: \\ Slash: / Newline:\nTab:\tCR:\rBS:\bFF:\f',
    );
  });

  it('decodes a unicode escape', () => {
    // \u2014 is an em dash.
    expect(extractStreamingJsonStringField('{"body":"a\\u2014b"', 'body')).toBe(
      'a' + String.fromCharCode(0x2014) + 'b',
    );
  });

  it('stops cleanly at a backslash cut off at the very end of the buffer', () => {
    // The chunk boundary landed right after the escaping backslash — nothing
    // after it has arrived yet.
    expect(extractStreamingJsonStringField('{"body":"before\\', 'body')).toBe('before');
  });

  it('stops cleanly at a unicode escape cut off mid-sequence', () => {
    expect(extractStreamingJsonStringField('{"body":"before\\u20', 'body')).toBe('before');
    expect(extractStreamingJsonStringField('{"body":"before\\u', 'body')).toBe('before');
  });

  it('passes an unrecognized escape character through raw rather than throwing', () => {
    expect(extractStreamingJsonStringField('{"body":"a\\qb"', 'body')).toBe('aqb');
  });

  it('extracts the requested field among several already-streamed fields, in either order', () => {
    const raw = '{"subject":"Re: Support","body":"Thanks for reaching out","contextNote":"n/a"}';
    expect(extractStreamingJsonStringField(raw, 'subject')).toBe('Re: Support');
    expect(extractStreamingJsonStringField(raw, 'body')).toBe('Thanks for reaching out');
    expect(extractStreamingJsonStringField(raw, 'contextNote')).toBe('n/a');
  });

  it('does not confuse an occurrence of the key text inside a PRIOR value with the real key', () => {
    // The subject value itself contains the literal text `"body"` — a naive
    // first-match search for `"body"` would anchor here and never find the
    // real body key that comes after.
    const raw = '{"subject":"Please read the \\"body\\" section","body":"Real content here';
    expect(extractStreamingJsonStringField(raw, 'body')).toBe('Real content here');
  });

  it('is stable and idempotent across repeated calls as more text arrives', () => {
    const full = '{"subject":"Hi","body":"Line one.\\nLine two."}';
    let seen = '';
    for (let i = 1; i <= full.length; i++) {
      const value = extractStreamingJsonStringField(full.slice(0, i), 'body');
      // Once non-empty, it must only ever grow (or stay the same while an
      // escape sequence is mid-arrival) — never shrink or change retroactively.
      expect(value.startsWith(seen) || seen.startsWith(value)).toBe(true);
      if (value.length >= seen.length) seen = value;
    }
    expect(seen).toBe('Line one.\nLine two.');
  });
});
