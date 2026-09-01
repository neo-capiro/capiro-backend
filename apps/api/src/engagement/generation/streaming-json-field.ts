/**
 * Best-effort extraction of one string field's value from a JSON document
 * that may still be INCOMPLETE — as it streams in token by token from a
 * structured-output model response.
 *
 * Pure and stateless by design: given the full raw text received so far, it
 * re-derives the current best-effort value from scratch rather than tracking
 * parser state across calls. A streaming draft is a handful of KB at most and
 * updates are throttled by the caller, so re-scanning the whole buffer on
 * each update is negligible cost against the multi-minute model call it rides
 * alongside — and it is far simpler to reason about (and get right without a
 * live provider to test against) than an incremental parser that carries
 * state between chunks.
 *
 * Handles JSON string escaping (\", \\, \/, \n, \t, \r, \b, \f, \uXXXX) so a
 * value containing a literal quote or newline extracts correctly even before
 * its closing quote has arrived. An escape sequence that is itself cut off
 * mid-stream (e.g. the buffer ends right after a bare `\`, or `\u00` with the
 * rest of the code point not yet arrived) stops extraction at that point
 * rather than guessing — the next call, with more text arrived, picks up
 * correctly from there.
 */
export function extractStreamingJsonStringField(rawSoFar: string, fieldName: string): string {
  const keyIndex = findKey(rawSoFar, fieldName);
  if (keyIndex === -1) return '';

  let i = keyIndex;
  i = skipWhitespace(rawSoFar, i);
  if (rawSoFar[i] !== ':') return '';
  i++;
  i = skipWhitespace(rawSoFar, i);
  if (rawSoFar[i] !== '"') return ''; // value hasn't started, or isn't a string
  i++;

  let out = '';
  while (i < rawSoFar.length) {
    const ch = rawSoFar[i];
    if (ch === '"') break; // closing quote — value complete
    if (ch !== '\\') {
      out += ch;
      i += 1;
      continue;
    }
    const decoded = decodeEscape(rawSoFar, i);
    if (decoded === null) break; // escape sequence cut off mid-stream — stop here
    out += decoded.char;
    i = decoded.next;
  }
  return out;
}

/**
 * Finds `"fieldName"` used as an object KEY (immediately followed, after
 * whitespace, by a colon) rather than merely appearing as a substring
 * somewhere in an already-emitted value. Scans for every occurrence instead
 * of trusting the first, since a value emitted before this field could
 * itself contain the literal text `"fieldName"`.
 */
function findKey(text: string, fieldName: string): number {
  const needle = `"${fieldName}"`;
  let from = 0;
  while (true) {
    const at = text.indexOf(needle, from);
    if (at === -1) return -1;
    const afterKey = skipWhitespace(text, at + needle.length);
    if (text[afterKey] === ':') return afterKey;
    from = at + needle.length;
  }
}

function skipWhitespace(text: string, index: number): number {
  let i = index;
  while (i < text.length && (text[i] === ' ' || text[i] === '\t' || text[i] === '\n' || text[i] === '\r')) {
    i++;
  }
  return i;
}

const SIMPLE_ESCAPES: Record<string, string> = {
  '"': '"',
  '\\': '\\',
  '/': '/',
  n: '\n',
  t: '\t',
  r: '\r',
  b: '\b',
  f: '\f',
};

function decodeEscape(text: string, backslashIndex: number): { char: string; next: number } | null {
  const marker = text[backslashIndex + 1];
  if (marker === undefined) return null; // buffer ends right after `\`
  if (marker === 'u') {
    const hex = text.slice(backslashIndex + 2, backslashIndex + 6);
    if (hex.length < 4 || !/^[0-9a-fA-F]{4}$/.test(hex)) return null; // code point not fully arrived
    return { char: String.fromCharCode(parseInt(hex, 16)), next: backslashIndex + 6 };
  }
  const simple = SIMPLE_ESCAPES[marker];
  if (simple !== undefined) return { char: simple, next: backslashIndex + 2 };
  // Unrecognized escape (shouldn't occur in a schema-conformant response) —
  // pass the character through raw rather than throw or drop it silently.
  return { char: marker, next: backslashIndex + 2 };
}
