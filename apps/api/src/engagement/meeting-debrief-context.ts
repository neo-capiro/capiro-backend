import { conservativeTokens, MEETING_DEBRIEF_POLICY } from './meeting-prep-policy.js';

/**
 * The only context a debrief may see (D2): the reviewed source, the meeting's own
 * notes and prep, the attendee roster, minimal meeting/client identity, and BOUNDED
 * continuity (open commitments + the client's last few debriefs).
 *
 * Deliberately absent: mail threads, mail bodies, unrelated meetings, the full client
 * timeline, directory matches and client memory. Those were the unbounded inputs that
 * produced a 53k-token prompt for a three-line source.
 */
export interface MeetingDebriefSource {
  method: 'upload' | 'manual' | 'voice';
  text: string;
}
export interface MeetingDebriefOpenTask {
  title: string;
  status: string;
  dueOn?: string | null;
}
export interface MeetingDebriefPriorDebrief {
  createdAt: string;
  recap: string;
}
export interface MeetingDebriefContextInput {
  meeting: Record<string, unknown>;
  client: Record<string, unknown> | null;
  attendees: Array<Record<string, unknown>>;
  prep: Record<string, unknown> | null;
  source: MeetingDebriefSource;
  visibleNotes: Array<Record<string, unknown>>;
  openTasks: MeetingDebriefOpenTask[];
  recentDebriefs: MeetingDebriefPriorDebrief[];
  steeringContext?: string | null;
}

export type DebriefContextSectionState = 'kept' | 'shortened' | 'dropped';

export interface DebriefContextSection {
  name: keyof MeetingDebriefContextInput;
  tokens: number;
  state: DebriefContextSectionState;
}

/** What the model actually saw. Persisted with the artifact so a reviewer can check it. */
export interface DebriefContextSummary {
  version: string;
  boundTokens: number;
  totalTokens: number;
  sourceTruncated: boolean;
  sections: DebriefContextSection[];
}

const SOURCE_MARKER = '\n\n[… transcript truncated to fit the debrief context bound …]\n\n';

/**
 * Sections in DROP order: the first entry is the least important and is reduced
 * first. `source` is never in this list — it is only shortened, and only after every
 * other section has been given up.
 *
 * `meeting`/`client` themselves are NOT reducible, because the governed provider seam
 * re-asserts their identity (meeting.id plus the matching client identity) — but only the
 * MANDATORY fields are protected: optional metadata (description, location, subject,
 * client name/sector) is reduced FIRST, before any reviewed evidence.
 *
 * `steeringContext` is also NOT reducible. It is the canonical governed projection (or the
 * firm voice block when no Context Plane bundle applies); the provider seam treats it as
 * authoritative, so deleting it under pressure silently removed approved steering. It is
 * budgeted by its renderer and retained; background context and then the transcript give
 * way instead.
 */
const REDUCIBLE: Array<keyof MeetingDebriefContextInput> = [
  'recentDebriefs',
  'openTasks',
  'attendees',
  'visibleNotes',
  'prep',
];

/** The fields assertInputScope re-asserts: never reduced. */
const MANDATORY_MEETING_FIELDS = new Set(['id', 'clientId', 'isInternal']);
const MANDATORY_CLIENT_FIELDS = new Set(['id']);
const OPTIONAL_MEETING_FIELDS = ['description', 'location', 'subject', 'status'];
const OPTIONAL_CLIENT_FIELDS = ['sectorTag', 'name'];

/** Drops the least-important optional identity metadata; false when nothing is left. */
function reduceOptionalMetadata(bounded: MeetingDebriefContextInput): boolean {
  for (const field of OPTIONAL_MEETING_FIELDS) {
    if (field in bounded.meeting) {
      delete bounded.meeting[field];
      return true;
    }
  }
  for (const field of OPTIONAL_CLIENT_FIELDS) {
    if (bounded.client && field in bounded.client) {
      delete bounded.client[field];
      return true;
    }
  }
  return false;
}

const size = (value: unknown): number =>
  typeof value === 'string'
    ? conservativeTokens(value)
    : conservativeTokens(JSON.stringify(value ?? null));

/** The typed canonical item boundaries the Context Plane renderer emits. */
const CONTEXT_ITEM = /<context_item\b[\s\S]*?<\/context_item>/g;

/** UTF-8 length, in bytes. */
function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

/** A code-point-safe excerpt: never splits a surrogate pair. */
function codePointExcerpt(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return '';
  let text = '';
  let used = 0;
  for (const character of value) {
    const next = utf8Bytes(character);
    if (used + next > maxBytes) break;
    text += character;
    used += next;
  }
  return text;
}

/**
 * Reduce the canonical steering INSIDE the room the rest of the input leaves, keeping the
 * renderer's whole typed items (item identity, attributes and closing tags) instead of an
 * arbitrary character prefix. Omitted items are counted and named in the block, so the
 * reduction is truthful; only a single item larger than the remaining room is excerpted, and
 * that excerpt is code-point safe.
 */
function reduceSteering(
  bounded: MeetingDebriefContextInput,
  bound: number,
  total: number,
): boolean {
  const steering = bounded.steeringContext;
  if (!steering) return false;
  const room = bound - (total - size(steering));
  if (size(steering) <= room) return false;

  const units = steering.match(CONTEXT_ITEM) ?? [];
  if (!units.length) {
    // Nothing canonical to select from (the assembly's voice block): a code-point excerpt is
    // the only honest reduction, and it carries its own marker.
    const marker = '\n…[approved steering excerpt reduced to fit the debrief context budget]';
    const excerpt = codePointExcerpt(steering, Math.max(0, room - utf8Bytes(marker)));
    if (!excerpt) return false;
    bounded.steeringContext = `${excerpt}${marker}`;
    return true;
  }

  // Whole canonical items only: the plane framing (head) and its closing tail are kept
  // complete, and an item either fits or is omitted in full. Never clip an item into a
  // lone opening tag, and never clip the preamble down to a prefix.
  const head = steering.slice(0, steering.indexOf(units[0]!));
  const last = units[units.length - 1]!;
  const tail = steering.slice(steering.indexOf(last) + last.length);
  const note = (omitted: number) =>
    `\n…[${omitted} approved steering item${omitted === 1 ? '' : 's'} omitted to fit the debrief context budget; item boundaries preserved]`;
  const compose = (kept: string[], omitted: number) =>
    `${head}${kept.join('')}${note(omitted)}${tail}`;

  const kept: string[] = [];
  let omitted = 0;
  for (const unit of units) {
    const candidate = compose([...kept, unit], omitted);
    if (size(candidate) <= room) kept.push(unit);
    else omitted += 1;
  }
  if (!kept.length) {
    // Not even one complete item fits: keep the complete framing and omit every item. If that
    // still exceeds the room the caller's final guard refuses the generation.
    bounded.steeringContext = compose([], units.length);
    return true;
  }
  bounded.steeringContext = compose(kept, omitted);
  return true;
}

function truncateTranscript(text: string, allowedBytes: number): string {
  if (allowedBytes <= SOURCE_MARKER.length) return SOURCE_MARKER.trim();
  const budget = allowedBytes - conservativeTokens(SOURCE_MARKER);
  const head = Math.ceil(budget * 0.6);
  let headText = '';
  let headBytes = 0;
  for (const char of text) {
    const next = conservativeTokens(char);
    if (headBytes + next > head) break;
    headText += char;
    headBytes += next;
  }
  const tail: string[] = [];
  let tailBytes = 0;
  const characters = [...text];
  for (let index = characters.length - 1; index >= 0; index -= 1) {
    const char = characters[index]!;
    const next = conservativeTokens(char);
    if (tailBytes + next > budget - headBytes) break;
    tail.unshift(char);
    tailBytes += next;
  }
  return `${headText}${SOURCE_MARKER}${tail.join('')}`;
}

/**
 * A copy holding only the declared identity fields. Field by field, so an unexpected key
 * on the caller's object (a mail body, a timeline) can never reach the model.
 */
function identitySlice(
  source: Record<string, unknown>,
  mandatory: ReadonlySet<string>,
  optional: readonly string[],
): Record<string, unknown> {
  const slice: Record<string, unknown> = {};
  for (const field of [...mandatory, ...optional])
    if (field in source) slice[field] = source[field];
  return slice;
}

export function debriefContextTokens(input: MeetingDebriefContextInput): number {
  return (
    size(input.meeting) +
    size(input.client) +
    size(input.attendees) +
    size(input.prep) +
    size(input.source.text) +
    size(input.visibleNotes) +
    size(input.openTasks) +
    size(input.recentDebriefs) +
    size(input.steeringContext)
  );
}

/**
 * Bound the assembled context at MEETING_DEBRIEF_POLICY.contextTokens, using the
 * existing conservative byte-based upper bound (tokens <= UTF-8 bytes) rather than a
 * new tokenizer. Sections are reduced in a fixed priority order; the reviewed source
 * survives unless it alone exceeds the bound, in which case it is shortened head+tail
 * and the truncation is recorded.
 */
export function boundDebriefContext(
  input: MeetingDebriefContextInput,
): { input: MeetingDebriefContextInput; summary: DebriefContextSummary } {
  const bound = MEETING_DEBRIEF_POLICY.contextTokens;
  // Built field by field, never spread: an unexpected key on the caller's object
  // (recentThreads, mail bodies, a client timeline) must not reach the model.
  // meeting/client are copied unconditionally: they are mandatory identity, not
  // optional context, and the governed wrapper refuses input without them.
  const bounded: MeetingDebriefContextInput = {
    // Copied, not referenced: the reduction below must never mutate the caller's meeting.
    // Mandatory identity is always present; optional metadata may be reduced first.
    meeting: identitySlice(input.meeting, MANDATORY_MEETING_FIELDS, OPTIONAL_MEETING_FIELDS),
    client: input.client
      ? identitySlice(input.client, MANDATORY_CLIENT_FIELDS, OPTIONAL_CLIENT_FIELDS)
      : null,
    attendees: [...input.attendees],
    prep: input.prep,
    source: { method: input.source.method, text: input.source.text },
    visibleNotes: [...input.visibleNotes],
    openTasks: [...input.openTasks],
    recentDebriefs: input.recentDebriefs
      .slice(0, MEETING_DEBRIEF_POLICY.recentDebriefs)
      .map((entry) => ({
        createdAt: entry.createdAt,
        recap: entry.recap.length > 600 ? `${entry.recap.slice(0, 600)}…` : entry.recap,
      })),
    steeringContext: input.steeringContext ?? null,
  };
  const adjusted = new Set<keyof MeetingDebriefContextInput>();

  for (;;) {
    let total = debriefContextTokens(bounded);
    if (total <= bound) break;
    let reduced = false;
    // Optional meeting/client metadata gives way before any reviewed evidence.
    if (reduceOptionalMetadata(bounded)) {
      adjusted.add('meeting');
      adjusted.add('client');
      reduced = true;
    }
    if (reduced) continue;
    for (const name of REDUCIBLE) {
      const value = bounded[name];
      if (Array.isArray(value) && value.length > 0) {
        (bounded[name] as unknown[]).pop();
        adjusted.add(name);
        reduced = true;
        break;
      }
      if (Array.isArray(value)) continue;
      if (value === null || value === undefined || value === '') continue;
      (bounded as unknown as Record<string, unknown>)[name] = null;
      adjusted.add(name);
      reduced = true;
      break;
    }
    if (!reduced) break;
  }

  let truncated = false;
  let total = debriefContextTokens(bounded);
  if (total > bound) {
    const others = total - size(bounded.source.text);
    const allowed = Math.max(0, bound - others);
    bounded.source = { ...bounded.source, text: truncateTranscript(input.source.text, allowed) };
    truncated = true;
    total = debriefContextTokens(bounded);
  }

  // Only when the reviewed evidence is already at its floor does the canonical steering give
  // way — and then by whole typed items inside the actual remaining room, never by deleting
  // the block or by an arbitrary prefix.
  if (total > bound) {
    // Repeat while progress is made: whole-item selection first, then a code-point excerpt of
    // whatever still does not fit. The loop exists so the accounting converges on the same
    // measurement the final guard uses.
    const original = bounded.steeringContext;
    let guard = 0;
    while (total > bound && guard < 8) {
      guard += 1;
      if (!reduceSteering(bounded, bound, total)) break;
      const next = debriefContextTokens(bounded);
      if (next >= total) break;
      total = next;
    }
    if (bounded.steeringContext !== original) {
      adjusted.add('steeringContext');
      total = debriefContextTokens(bounded);
    }
  }

  const sections: DebriefContextSection[] = (
    [
      'source',
      'prep',
      'visibleNotes',
      'attendees',
      'meeting',
      'client',
      'openTasks',
      'recentDebriefs',
      'steeringContext',
    ] as Array<keyof MeetingDebriefContextInput>
  ).map((name) => {
    const value = bounded[name];
    const empty =
      value === null ||
      value === undefined ||
      value === '' ||
      (Array.isArray(value) && value.length === 0);
    const state: DebriefContextSectionState = empty
      ? 'dropped'
      : name === 'source' && truncated
        ? 'shortened'
        : adjusted.has(name)
          ? 'shortened'
          : 'kept';
    // The source section reports the transcript's own bytes, matching the total;
    // other sections are measured as their serialized JSON.
    const tokens = name === 'source' ? size(input.source.text) : size(value);
    return { name, tokens, state };
  });

  return {
    input: bounded,
    summary: {
      version: MEETING_DEBRIEF_POLICY.version,
      boundTokens: bound,
      totalTokens: total,
      sourceTruncated: truncated,
      sections,
    },
  };
}
