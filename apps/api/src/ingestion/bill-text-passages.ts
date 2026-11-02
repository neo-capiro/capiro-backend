import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
export const CHUNKER_VERSION = 'bill-full-text-utf16-v1';
export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
export type Cursor = { id: string; chunk: number };
export type Section = { locator: string; text: string };
export type Passage = Section & { ordinal: number; start: number; end: number; section: number };
/** Offsets are UTF-16 within the immutable section, explicitly distinct from PG passage offsets. */
export function passages(sections: Section[], size = 6000): Passage[] {
  if (!Number.isSafeInteger(size) || size < 20 || size > 7000) throw Error('INVALID_CHUNK_SIZE');
  const result: Passage[] = [];
  sections.forEach((section, sectionIndex) => {
    for (let start = 0; start < section.text.length;) {
      let end = Math.min(start + size, section.text.length);
      if (end < section.text.length && /[\uD800-\uDBFF]/.test(section.text[end - 1]!)) end--;
      // Keep short tails attached: embedAndUpsert rejects inputs shorter than ten chars.
      if (section.text.length - end < 10) end = section.text.length;
      result.push({
        text: section.text.slice(start, end),
        locator: section.locator,
        ordinal: result.length,
        section: sectionIndex,
        start,
        end,
      });
      start = end;
    }
  });
  return result;
}
export function parseCursor(raw?: string): Cursor {
  if (!raw) return { id: '', chunk: -1 };
  const c = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as Cursor;
  if (
    typeof c.id !== 'string' ||
    !/^[a-zA-Z0-9_~-]{0,128}$/.test(c.id) ||
    !Number.isSafeInteger(c.chunk) ||
    c.chunk < -1
  )
    throw Error('INVALID_CURSOR');
  return c;
}
export const encodeCursor = (c: Cursor) => Buffer.from(JSON.stringify(c)).toString('base64url');
export function parseBillTextArgs(argv: string[], env: NodeJS.ProcessEnv) {
  const { values: a } = parseArgs({
    args: argv,
    options: {
      source: { type: 'string' },
      limit: { type: 'string' },
      after: { type: 'string' },
      commit: { type: 'boolean' },
      'expected-host': { type: 'string' },
    },
  });
  if (a.source !== 'federal' && a.source !== 'state')
    throw Error('SOURCE_MUST_BE_FEDERAL_OR_STATE');
  const limit = Number(a.limit ?? 100);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000)
    throw Error('LIMIT_MUST_BE_1_TO_1000');
  const host = env.DATABASE_URL ? new URL(env.DATABASE_URL).hostname : env.DB_HOST;
  if (a.commit && (!a['expected-host'] || host !== a['expected-host']))
    throw Error('DATABASE_HOST_MISMATCH');
  // The persisted checkpoint is authoritative in write mode; arbitrary jumps could skip unfinished work.
  if (a.commit && a.after) throw Error('COMMIT_USES_DURABLE_CURSOR');
  return { source: a.source, limit, commit: a.commit === true, cursor: parseCursor(a.after) };
}
