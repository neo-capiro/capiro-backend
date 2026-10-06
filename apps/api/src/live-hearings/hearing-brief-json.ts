import { extractJsonObject } from '../engagement/generation/json-extract.js';

/** Preserve prose when a model emits literal newlines/tabs inside JSON strings.
 * Only JSON encoding is repaired. Missing syntax and incomplete output still fail.
 */
export function parseHearingBriefJson(text: string): Record<string, unknown> {
  const json = extractJsonObject(text);
  if (!json) throw new Error('Missing generated brief object');
  let quoted = false;
  let escaped = false;
  let encoded = '';
  for (const character of json) {
    if (quoted && escaped) {
      // Invalid escape sequences must remain invalid, including line continuations.
      encoded += character;
      escaped = false;
      continue;
    }
    if (quoted && character === '\\') {
      escaped = true;
    } else if (character === '"') {
      quoted = !quoted;
    } else if (quoted && character.charCodeAt(0) < 0x20) {
      encoded += JSON.stringify(character).slice(1, -1);
      continue;
    }
    encoded += character;
  }
  return JSON.parse(encoded) as Record<string, unknown>;
}
