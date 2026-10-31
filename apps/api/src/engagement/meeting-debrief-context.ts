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
 */
const REDUCIBLE: Array<keyof MeetingDebriefContextInput> = [
  'steeringContext',
  'recentDebriefs',
  'openTasks',
  'client',
  'meeting',
  'attendees',
  'visibleNotes',
  'prep',
];

const size = (value: unknown): number =>
  typeof value === 'string'
    ? conservativeTokens(value)
    : conservativeTokens(JSON.stringify(value ?? null));

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
  const bounded: MeetingDebriefContextInput = {
    meeting: input.meeting,
    client: input.client,
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
