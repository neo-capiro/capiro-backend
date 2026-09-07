import { createHash } from 'node:crypto';
import type { KnowledgeJsonObject } from '../../knowledge/knowledge.types.js';

export interface HearingContentCursor {
  key: string;
  part: number;
  hash: string;
}
export const hearingContentRecordId = (key: string, hash: string, part?: number) =>
  part === undefined && key.length <= 80
    ? key
    : `hearing:${createHash('sha256').update(key).digest('hex').slice(0, 16)}:${hash.slice(0, 12)}:${part ?? 0}`;
export const encodeHearingContentCursor = (cursor: HearingContentCursor) =>
  `hearing:${Buffer.from(JSON.stringify(cursor)).toString('base64url')}`;

export function parseHearingContentCursor(value: string): HearingContentCursor | null {
  if (!value.startsWith('hearing:')) return null;
  try {
    const cursor = JSON.parse(
      Buffer.from(value.slice(8), 'base64url').toString('utf8'),
    ) as HearingContentCursor;
    if (
      !/^(event|official|segment|insight|relevance):/.test(cursor.key) ||
      cursor.key.length > 300 ||
      !Number.isSafeInteger(cursor.part) ||
      cursor.part < 1 ||
      !/^[a-f0-9]{64}$/.test(cursor.hash)
    )
      throw new Error('invalid');
    return cursor;
  } catch {
    throw new Error('invalid_cursor');
  }
}

/** Bound serialized content, including metadata and escaped text. Splitting the
 * complete JSON payload also preserves arbitrarily long intelligence fields,
 * witnesses and entities without inventing format-specific omissions. */
export function hearingContentChunks(payload: KnowledgeJsonObject) {
  const content = JSON.stringify(payload);
  const hash = createHash('sha256').update(content).digest('hex');
  if (content.length <= 6500) return { hash, chunks: [payload] };
  const chunkCount = Math.ceil(content.length / 2000);
  const chunks: KnowledgeJsonObject[] = [];
  // Repeat exact compact attribution on each page. Otherwise a transcript's
  // first fragment can contain a statement while its speaker/time is several
  // pages later in the serialized JSON, making the excerpt unsafe to attribute.
  const attribution: KnowledgeJsonObject = {};
  for (const key of [
    'id', 'hearingId', 'captureId', 'segmentId', 'sequence', 'startMs', 'endMs',
    'speakerLabel', 'speakerName', 'speakerConfidence', 'transcriptionConfidence',
    'confidence', 'preliminary', 'isOfficialTranscript', 'derivedFromMachineTranscript',
    'hasGapBefore', 'revision', 'date', 'publishedAt', 'fetchedAt', 'syncedAt',
  ]) {
    const value = payload[key];
    if (value === null || typeof value === 'number' || typeof value === 'boolean'
      || (typeof value === 'string' && value.length <= 240)) attribution[key] = value;
  }
  for (let part = 0; part < chunkCount; part += 1) {
    const start = part * 2000;
    chunks.push({
      kind: 'hearing_evidence_json_chunk',
      originalKind: typeof payload.kind === 'string' ? payload.kind.slice(0, 80) : null,
      ...attribution,
      title: typeof payload.title === 'string' ? payload.title.slice(0, 240) : 'Hearing evidence',
      sourceUrl:
        typeof payload.sourceUrl === 'string' && payload.sourceUrl.length <= 1000
          ? payload.sourceUrl
          : null,
      contentFormat: 'json_fragment',
      text: content.slice(start, start + 2000),
      characterStart: start,
      characterEnd: Math.min(start + 2000, content.length),
      totalCharacters: content.length,
      chunk: part + 1,
      chunkCount,
      contentHash: hash,
      note: 'Complete range of the original record JSON. Join consecutive text fragments to read all fields; this fragment is not the complete record.',
    });
  }
  return { hash, chunks };
}
