export const KRISP_CATALOG_ID = 'meriv3-krisp';
export const KRISP_POLL_MS = 3 * 60_000;
export const KRISP_LEASE_MS = 15 * 60_000;
export const KRISP_MAX_TRANSCRIPT_CHARS = 500_000;

export function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** MCP can deliver structuredContent or JSON inside text blocks. Never parse prose as metadata. */
export function krispPayload(value: unknown): unknown {
  const row = object(value);
  if (row.isError === true) throw new Error('Krisp could not complete this request.');
  if (row.structuredResult !== undefined) return krispPayload(row.structuredResult);
  if (row.structuredContent !== undefined) return row.structuredContent;
  if (Array.isArray(row.content)) {
    const blocks = row.content.map(object).filter((part) => part.type === 'text');
    const parsed = blocks
      .map((part) => {
        try {
          return JSON.parse(String(part.text));
        } catch {
          return null;
        }
      })
      .filter((part) => part !== null);
    if (parsed.length === 1) return parsed[0];
    if (parsed.length > 1) return parsed;
    throw new Error('Krisp returned an unsupported response format.');
  }
  return value;
}

export function krispRows(value: unknown, keys: string[]): Record<string, unknown>[] {
  if (Array.isArray(value)) return value.map(object);
  const row = object(value);
  for (const key of keys) {
    if (Array.isArray(row[key])) return (row[key] as unknown[]).map(object);
  }
  if (row.data !== undefined) return krispRows(row.data, keys);
  return [];
}

export function documentId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const id = value.replaceAll('-', '').toLowerCase();
  return /^[a-f0-9]{32}$/.test(id) ? id : null;
}

export interface KrispMeeting {
  documentId: string;
  title: string;
  startsAt: Date;
  calendarId: string | null;
  joinUrl: string | null;
  organizer: string | null;
}

export function normalizeKrispMeeting(row: Record<string, unknown>): KrispMeeting | null {
  const id = documentId(row.document_id ?? row.documentId ?? row.id ?? row.meeting_id);
  const title = row.title ?? row.name ?? row.subject;
  const time = row.start_time ?? row.starts_at ?? row.started_at ?? row.startTime ?? row.date;
  const startsAt = new Date(typeof time === 'string' ? time : NaN);
  if (!id || typeof title !== 'string' || !Number.isFinite(startsAt.getTime())) return null;
  const string = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);
  return {
    documentId: id,
    title: title.slice(0, 500),
    startsAt,
    calendarId: string(row.ical_uid ?? row.iCalUId ?? row.calendar_event_id),
    joinUrl: string(row.meeting_url ?? row.join_url ?? row.conference_url),
    organizer: string(row.organizer_email ?? object(row.organizer).email)?.toLowerCase() ?? null,
  };
}

export interface MatchCandidate {
  id: string;
  subject: string;
  startsAt: Date;
  iCalUId: string | null;
  externalId: string | null;
  joinLink: string | null;
  organizerEmail: string | null;
}

/** Never match by title alone, and never pick the first of several plausible meetings. */
export function matchKrispMeeting(
  source: KrispMeeting,
  candidates: MatchCandidate[],
): string | null {
  const nearby = candidates.filter(
    (candidate) =>
      Math.abs(candidate.startsAt.getTime() - source.startsAt.getTime()) <= 10 * 60_000,
  );
  const exact = nearby.filter(
    (candidate) =>
      source.calendarId &&
      (candidate.iCalUId === source.calendarId || candidate.externalId === source.calendarId),
  );
  if (exact.length) return exact.length === 1 ? exact[0]!.id : null;
  const matches = nearby.filter(
    (candidate) =>
      (source.joinUrl && candidate.joinLink === source.joinUrl) ||
      (source.organizer &&
        candidate.organizerEmail?.toLowerCase() === source.organizer &&
        candidate.subject.trim().toLowerCase() === source.title.trim().toLowerCase()),
  );
  return matches.length === 1 ? matches[0]!.id : null;
}

/** Map only fields advertised by the live schema. Unknown required fields fail visibly. */
export function krispArguments(
  schema: Record<string, unknown>,
  values: {
    since?: string;
    until?: string;
    folderId?: string | null;
    ids?: string[];
    cursor?: string;
    offset?: number;
    page?: number;
  },
): Record<string, unknown> {
  const properties = object(schema.properties);
  const out: Record<string, unknown> = {};
  const aliases: Record<string, unknown> = {
    start_date: values.since,
    date_from: values.since,
    from_date: values.since,
    end_date: values.until,
    date_to: values.until,
    to_date: values.until,
    folder_id: values.folderId ?? undefined,
    folderId: values.folderId ?? undefined,
    document_ids: values.ids,
    documentIds: values.ids,
    ids: values.ids,
    include_transcript: values.ids ? true : undefined,
    include_full_transcript: values.ids ? true : undefined,
    include_summary: values.ids ? false : undefined,
    cursor: values.cursor,
    page_token: values.cursor,
    offset: values.offset,
    page: values.page,
    page_number: values.page,
    limit: 50,
    page_size: 50,
  };
  for (const [key, definition] of Object.entries(properties)) {
    const prop = object(definition);
    if (aliases[key] !== undefined) out[key] = aliases[key];
    else if (['filters', 'filter', 'options'].includes(key) && prop.type === 'object') {
      out[key] = krispArguments(prop, values);
    } else if (['fields', 'include', 'parts'].includes(key) && values.ids) {
      const allowed = object(prop.items).enum;
      if (prop.type === 'array' && Array.isArray(allowed) && allowed.includes('transcript'))
        out[key] = ['transcript'];
    }
    if (out[key] === undefined && prop.default !== undefined) out[key] = prop.default;
  }
  for (const key of Array.isArray(schema.required) ? schema.required : []) {
    if (typeof key === 'string' && out[key] === undefined)
      throw new Error(`Krisp requires an unsupported parameter: ${key}`);
  }
  const encoded = JSON.stringify(out);
  if (values.ids && !values.ids.every((id) => encoded.includes(id)))
    throw new Error('Krisp document lookup schema is not supported.');
  if (values.folderId && !encoded.includes(values.folderId))
    throw new Error('Krisp folder filtering is not supported by this tool schema.');
  if (values.cursor && !encoded.includes(values.cursor))
    throw new Error('Krisp pagination schema is not supported.');
  if (
    values.offset &&
    !values.cursor &&
    !('offset' in out || 'page' in out || 'page_number' in out)
  )
    throw new Error('Krisp pagination schema is not supported.');
  return out;
}

export function krispTranscript(payload: unknown, expectedId: string): string | null {
  const rows = krispRows(payload, ['documents', 'meetings', 'results', 'items']);
  const single = object(payload);
  if (!rows.length && (single.transcript !== undefined || single.full_transcript !== undefined))
    rows.push(single);
  const row = rows.find(
    (candidate) =>
      documentId(candidate.document_id ?? candidate.id ?? candidate.documentId) === expectedId,
  );
  if (!row) return null;
  const raw = row.transcript ?? row.full_transcript;
  let text: string | undefined;
  if (typeof raw === 'string') text = raw;
  else if (typeof object(raw).text === 'string') text = object(raw).text as string;
  else {
    const segments = Array.isArray(raw) ? raw : (object(raw).segments ?? object(raw).utterances);
    if (Array.isArray(segments))
      text = segments
        .map((segment) => {
          const part = object(segment);
          if (typeof part.text !== 'string') return '';
          const speaker =
            typeof part.speaker === 'string' ? part.speaker : object(part.speaker).name;
          return `${typeof speaker === 'string' ? speaker + ': ' : ''}${part.text}`;
        })
        .filter(Boolean)
        .join('\n');
  }
  if (!text?.trim()) return null;
  if (text.length > KRISP_MAX_TRANSCRIPT_CHARS)
    throw new Error('Krisp transcript exceeds the import limit.');
  return text.trim();
}
