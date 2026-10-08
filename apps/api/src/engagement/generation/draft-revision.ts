import { extractJsonObject } from './json-extract.js';

// The server copies every byte outside these spans, including hand edits and HTML.
export const REVISION_OUTPUT_CONTRACT = [
  'REVISION OUTPUT CONTRACT: return ONLY JSON with "edits" (array) and "contextNote" (string).',
  'Each edit has "field" ("subject" or "body"), "find" (an exact non-empty substring of the ORIGINAL field), "replacement" (string), and "occurrence" (1-based occurrence of find in that ORIGINAL field).',
  'Return the smallest replacements needed to fulfill EVERY part of the latest editing instruction. Do not return a new subject or body. Leave unaffected text out of edits.',
  "All edits refer to the original draft, never to another edit's replacement. Include separate edits for every occurrence the user asks to change. Edits must not overlap.",
  'Copy find literally, including whitespace and HTML. Preserve HTML tags, links, and attributes unless the user requests a formatting change. To insert text, replace a small adjacent anchor with that anchor plus the insertion.',
  'For example, replacing "government affairs" with "Lobbying Firm" means find="government affairs", replacement="Lobbying Firm". Removing dashes requires an edit for each dash, with only nearby punctuation/spacing repaired as needed.',
].join('\n');

export const REVISION_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['edits', 'contextNote'],
  properties: {
    edits: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['field', 'find', 'replacement', 'occurrence'],
        properties: {
          field: { type: 'string', enum: ['subject', 'body'] },
          find: { type: 'string', description: 'Exact non-empty substring of the original field.' },
          replacement: { type: 'string' },
          occurrence: { type: 'integer', description: '1-based occurrence in the original field.' },
        },
      },
    },
    contextNote: { type: 'string' },
  },
} as const;

export function applyDraftRevision(
  output: string,
  original: { subject: string; body: string },
): { subject: string; body: string; contextNote: string } | null {
  try {
    const json = extractJsonObject(output);
    if (!json) return null;
    const parsed = JSON.parse(json);
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      Array.isArray(parsed) ||
      Object.keys(parsed).some((k) => !['edits', 'contextNote'].includes(k)) ||
      !Array.isArray(parsed.edits) ||
      typeof parsed.contextNote !== 'string'
    )
      return null;

    const spans: Record<'subject' | 'body', Array<{ start: number; end: number; text: string }>> = {
      subject: [],
      body: [],
    };
    for (const edit of parsed.edits) {
      if (
        !edit ||
        typeof edit !== 'object' ||
        Array.isArray(edit) ||
        Object.keys(edit).some(
          (k) => !['field', 'find', 'replacement', 'occurrence'].includes(k),
        ) ||
        (edit.field !== 'subject' && edit.field !== 'body') ||
        typeof edit.find !== 'string' ||
        !edit.find.length ||
        typeof edit.replacement !== 'string' ||
        !Number.isSafeInteger(edit.occurrence) ||
        edit.occurrence < 1
      )
        return null;
      const field: 'subject' | 'body' = edit.field;
      const source = original[field];
      let start = -1;
      let cursor = 0;
      for (let n = 0; n < edit.occurrence; n++) {
        start = source.indexOf(edit.find, cursor);
        if (start < 0) return null;
        cursor = start + edit.find.length;
      }
      spans[field].push({ start, end: cursor, text: edit.replacement });
    }
    const revised = { ...original, contextNote: parsed.contextNote };
    for (const field of ['subject', 'body'] as const) {
      const ordered = spans[field].sort((a, b) => a.start - b.start);
      let cursor = 0;
      let result = '';
      for (const span of ordered) {
        if (span.start < cursor) return null;
        result += original[field].slice(cursor, span.start) + span.text;
        cursor = span.end;
      }
      revised[field] = result + original[field].slice(cursor);
    }
    return revised;
  } catch {
    return null;
  }
}
