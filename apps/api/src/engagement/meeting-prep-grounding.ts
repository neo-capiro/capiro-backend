import type { MeetingPrepInput } from './engagement-ai.service.js';
import { currentMeetingPrepExecution } from './meeting-prep-job-runtime.js';

export interface PrepEvidenceSource {
  access?: {
    meetings?: string[];
    notes?: string[];
    debriefs?: string[];
    mail?: string[];
    tasks?: string[];
    clients?: string[];
    mondayUsers?: string[];
    mondayBoards?: string[];
  };
  id: string;
  kind: string;
  title: string;
  recordId: string | null;
  observedAt: string | null;
  excerpt: string;
}

export interface MeetingPrepGrounding {
  version: 1;
  contentEdited: boolean;
  /** Authorization provenance is independent of optional display citations. */
  accessSources?: Array<Pick<PrepEvidenceSource, 'access'>>;
  attendees: Array<{ id: string; name: string; email: string | null }>;
  sources: PrepEvidenceSource[];
  references: Array<{ section: string; itemIndex: number; sourceIds: string[] }>;
  limitations: string[];
}

const SECTIONS = ['summary', 'agenda', 'talkingPoints', 'risks', 'followUps', 'emailEvidence'];

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function prepAttendees(input: MeetingPrepInput): MeetingPrepGrounding['attendees'] {
  return input.attendees.map((attendee, index) => ({
    id: text(attendee.id) || `attendee-${index + 1}`,
    name: text(attendee.name) || text(attendee.email) || 'Unnamed attendee',
    email: text(attendee.email) || null,
  }));
}

/** Use the same resolved logistics in the prompt and displayed source metadata. */
export function prepMeetingLogistics(meeting: Record<string, unknown>): {
  timeZone: string;
  formattedTime: string;
} {
  const rawTimeZone = text(meeting.timeZone);
  const timeZone =
    rawTimeZone && rawTimeZone.toUpperCase() !== 'UTC' ? rawTimeZone : 'America/New_York';
  let formattedTime = '';
  try {
    const date =
      meeting.startsAt instanceof Date ? meeting.startsAt : new Date(text(meeting.startsAt));
    if (!Number.isNaN(date.getTime()))
      formattedTime = date.toLocaleString('en-US', {
        weekday: 'short',
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
        timeZone,
      });
  } catch {
    /* Unknown timezones remain an explicit gap, never a guessed time. */
  }
  return { timeZone, formattedTime };
}

// Threads carry several messages and prior meetings carry their notes/debriefs;
// the model reads the registry excerpt, so those kinds need room.
const EXCERPT_CHARS: Record<string, number> = { mail: 5_000, 'prior-meeting': 7_000 };
const DEFAULT_EXCERPT_CHARS = 1_800;

/** Only source records actually supplied at the provider seam enter this registry. */
export function prepEvidenceSources(input: MeetingPrepInput): PrepEvidenceSource[] {
  const sources: PrepEvidenceSource[] = [];
  function add(kind: string, record: Record<string, unknown>, title: string, index = 0) {
    const recordId = text(record.id) || text(record.directoryContactId) || null;
    sources.push({
      id: `${kind}:${recordId ?? index + 1}`,
      kind,
      title,
      recordId,
      observedAt:
        text(record.updatedAt) || text(record.lastMessageAt) || text(record.startsAt) || null,
      excerpt: JSON.stringify(record).slice(0, EXCERPT_CHARS[kind] ?? DEFAULT_EXCERPT_CHARS),
      ...(currentMeetingPrepExecution() && recordId
        ? {
            access:
              kind === 'client'
                ? { clients: [recordId] }
                : kind === 'meeting'
                  ? {
                      meetings: [recordId],
                      clients: text(input.client?.id) ? [text(input.client?.id)] : [],
                    }
                  : {},
          }
        : {}),
    });
  }
  add(
    'meeting',
    {
      id: input.meeting.id,
      startsAt: input.meeting.startsAt,
      endsAt: input.meeting.endsAt,
      ...prepMeetingLogistics(input.meeting),
      subject: text(input.meeting.subject).slice(0, 300),
      location: text(input.meeting.location).slice(0, 300),
      description: text(input.meeting.description).slice(0, 700),
    },
    text(input.meeting.subject) || 'Current meeting',
  );
  if (input.client) add('client', input.client, text(input.client.name) || 'Client profile');
  prepAttendees(input).forEach((attendee, index) =>
    add('attendee', attendee, attendee.name, index),
  );
  input.congressionalDirectoryMatches.forEach((record, index) =>
    add(
      'directory',
      record,
      text(record.fullName) || text(record.name) || 'Directory contact',
      index,
    ),
  );
  input.recentMeetings.forEach((record, index) =>
    add('prior-meeting', record, text(record.subject) || 'Prior meeting', index),
  );
  input.recentThreads.forEach((record, index) =>
    add('mail', record, text(record.subject) || 'Email thread', index),
  );
  input.tasks.forEach((record, index) =>
    add('task', record, text(record.title) || 'Open task', index),
  );
  if (input.additionalContext?.trim())
    add('user-context', { text: input.additionalContext.trim() }, 'Context supplied for this prep');
  // These have already passed the canonical Context Plane projection and budget.
  sources.push(...(input.evidenceSources ?? []));
  return Array.from(new Map(sources.map((source) => [source.id, source])).values());
}

/** Assemble best-effort display links. Missing/invalid links never reject prose.
 * Source metadata always comes from supplied records, never model inventions. */
export function buildPrepEvidence(
  input: MeetingPrepInput,
  parsed: Record<string, unknown>,
): MeetingPrepGrounding {
  const sources = prepEvidenceSources(input);
  const allowed = new Set(sources.map((source) => source.id));
  const references: MeetingPrepGrounding['references'] = [];
  for (const raw of Array.isArray(parsed.evidenceReferences) ? parsed.evidenceReferences : []) {
    const ref = raw as Record<string, unknown> | null;
    const section = text(ref?.section);
    const itemIndex = ref?.itemIndex;
    const sourceIds = Array.isArray(ref?.sourceIds)
      ? ref.sourceIds.filter((id): id is string => typeof id === 'string' && allowed.has(id))
      : [];
    const items = section === 'summary' ? [parsed.summary] : parsed[section];
    if (
      !SECTIONS.includes(section) ||
      !Number.isInteger(itemIndex) ||
      (itemIndex as number) < 0 ||
      !Array.isArray(items) ||
      (itemIndex as number) >= items.length ||
      !sourceIds.length
    )
      continue;
    // Match the existing provider text normalization without moving a link onto
    // the wrong bullet when an earlier empty item was removed.
    const nonEmpty = (value: unknown) => String(value ?? '').trim().length > 0;
    if (!nonEmpty(items[itemIndex as number])) continue;
    const displayedIndex =
      section === 'summary' ? 0 : items.slice(0, itemIndex as number).filter(nonEmpty).length;
    references.push({
      section,
      itemIndex: displayedIndex,
      sourceIds: Array.from(new Set(sourceIds)),
    });
  }
  const used = new Set(references.flatMap((reference) => reference.sourceIds));
  const limitations = Array.isArray(parsed.limitations)
    ? parsed.limitations.filter((item): item is string => typeof item === 'string' && !!item.trim())
    : [];
  return {
    version: 1,
    contentEdited: false,
    attendees: prepAttendees(input),
    accessSources: sources
      .filter((source) => source.access)
      .map((source) => ({ access: source.access })),
    sources: sources.filter((source) => used.has(source.id)),
    references,
    limitations,
  };
}
