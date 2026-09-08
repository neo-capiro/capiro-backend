import { ServiceUnavailableException } from '@nestjs/common';
import type { MeetingPrepInput } from './engagement-ai.service.js';

export interface PrepEvidenceSource {
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
  review?: { attendeeNamesConsistent: true; factualClaimsSupported: true };
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

/** The same resolved logistics feed the draft prompt and the source reviewer. */
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
      excerpt: JSON.stringify(record).slice(0, 1800),
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

/** Validate identities and citation targets, never rewrite names or invent support.
 * Source existence is a mechanical check; semantic claim review remains with the
 * provider and user and is explicitly described that way in the UI. */
export function validatePrepGrounding(
  input: MeetingPrepInput,
  parsed: Record<string, unknown>,
): MeetingPrepGrounding {
  // Keep citation indexes identical to the displayed arrays: normalization must
  // not silently remove an empty/non-string item and shift every later link.
  for (const section of SECTIONS) {
    const values = section === 'summary' ? [parsed.summary] : parsed[section];
    if (
      !Array.isArray(values) ||
      values.some((value) => typeof value !== 'string' || !value.trim())
    ) {
      throw new ServiceUnavailableException(
        'Meeting prep returned incomplete content. Please retry generation.',
      );
    }
  }
  const attendees = prepAttendees(input);
  const supplied = Array.isArray(parsed.attendeeReferences) ? parsed.attendeeReferences : [];
  if (
    supplied.length !== attendees.length ||
    attendees.some(
      (attendee) =>
        supplied.filter((raw) => {
          const value = raw as Record<string, unknown> | null;
          return value?.attendeeId === attendee.id && value?.name === attendee.name;
        }).length !== 1,
    )
  ) {
    throw new ServiceUnavailableException(
      'Meeting prep attendee names did not match the meeting record. Please retry generation.',
    );
  }
  const sources = prepEvidenceSources(input);
  const allowed = new Set(sources.map((source) => source.id));
  if (!Array.isArray(parsed.evidenceReferences)) {
    throw new ServiceUnavailableException(
      'Meeting prep did not include source references. Please retry generation.',
    );
  }
  const references: MeetingPrepGrounding['references'] = [];
  for (const raw of parsed.evidenceReferences) {
    const ref = raw as Record<string, unknown> | null;
    const section = text(ref?.section);
    const itemIndex = ref?.itemIndex;
    const sourceIds = Array.isArray(ref?.sourceIds) ? ref.sourceIds : [];
    const items = section === 'summary' ? [parsed.summary] : parsed[section];
    if (
      !SECTIONS.includes(section) ||
      !Number.isInteger(itemIndex) ||
      (itemIndex as number) < 0 ||
      !Array.isArray(items) ||
      (itemIndex as number) >= items.length ||
      !sourceIds.length ||
      sourceIds.some((id) => typeof id !== 'string' || !allowed.has(id))
    ) {
      throw new ServiceUnavailableException(
        'Meeting prep returned an unavailable source reference. Please retry generation.',
      );
    }
    references.push({
      section,
      itemIndex: itemIndex as number,
      sourceIds: Array.from(new Set(sourceIds as string[])),
    });
  }
  const used = new Set(references.flatMap((reference) => reference.sourceIds));
  const limitations = Array.isArray(parsed.limitations)
    ? parsed.limitations.filter((item): item is string => typeof item === 'string' && !!item.trim())
    : [];
  for (const section of SECTIONS) {
    const items = section === 'summary' ? [parsed.summary] : parsed[section];
    if (
      Array.isArray(items) &&
      items.some(
        (item, index) =>
          text(item) &&
          !references.some((ref) => ref.section === section && ref.itemIndex === index),
      )
    ) {
      throw new ServiceUnavailableException(
        'Meeting prep is missing source links for its content. Please retry generation.',
      );
    }
  }
  return {
    version: 1,
    contentEdited: false,
    attendees,
    sources: sources.filter((source) => used.has(source.id)),
    references,
    limitations,
  };
}
