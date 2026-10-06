import type { SpeakerTurn } from './hearing-speaker-attribution.service.js';

export const BRIEF_TRANSCRIPT_CHAR_LIMIT = 120_000;
const TURN_LIMIT = 600;

export function briefClock(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(seconds / 3600);
  const m = String(Math.floor(seconds / 60) % 60).padStart(2, '0');
  const s = String(seconds % 60).padStart(2, '0');
  return h ? `${h}:${m}:${s}` : `${m}:${s}`;
}

/** Preserve unlabeled speech and split long monologues at real segment starts. */
export function briefTurns(
  rows: Array<{
    sequence: number;
    startMs: number;
    text: string;
    speakerLabel: string | null;
  }>,
): SpeakerTurn[] {
  const turns: SpeakerTurn[] = [];
  for (const row of rows) {
    if (!row.text.trim() || !Number.isFinite(row.startMs)) continue;
    const label = row.speakerLabel?.trim() ?? '';
    const previous = turns.at(-1);
    if (previous?.label === label && previous.text.length + row.text.length < 2000)
      previous.text += ` ${row.text.trim()}`;
    else turns.push({ label, sequence: row.sequence, startMs: row.startMs, text: row.text.trim() });
  }
  return turns;
}

export function briefSpeaker(label: string, speakers: Map<string, string>): string {
  return (
    speakers.get(label) ??
    (/^\d+$/.test(label) ? `Speaker ${Number(label) + 1}` : label || 'Unidentified speaker')
  );
}

export function buildBriefEvidence(
  turns: SpeakerTurn[],
  findingStarts: number[],
  speakers: Map<string, string>,
) {
  const selected = new Set<number>();
  if (turns.length) {
    selected.add(0);
    selected.add(turns.length - 1);
  }
  // Reserve half of a long-hearing packet for chronological coverage before
  // adding matched topics, which can otherwise crowd out the whole middle.
  const chronological = Math.min(
    turns.length,
    turns.length <= TURN_LIMIT ? TURN_LIMIT : TURN_LIMIT / 2,
  );
  for (let i = 0; i < chronological; i++)
    selected.add(Math.round((i * (turns.length - 1)) / Math.max(1, chronological - 1)));
  for (const start of findingStarts) {
    const index = turns.findIndex(
      (t, i) => t.startMs <= start && (!turns[i + 1] || turns[i + 1]!.startMs > start),
    );
    for (const neighbor of [index - 1, index, index + 1])
      if (neighbor >= 0 && neighbor < turns.length && selected.size < TURN_LIMIT)
        selected.add(neighbor);
  }
  const available = Math.min(TURN_LIMIT, turns.length);
  for (let i = 0; i < available && selected.size < TURN_LIMIT; i++)
    selected.add(Math.round((i * (turns.length - 1)) / Math.max(1, available - 1)));
  const picked = [...selected].sort((a, b) => a - b).map((i) => turns[i]!);
  // Allocate the whole budget before chronological rendering: a long opening
  // statement cannot consume the budget and silently drop closing commitments.
  const overhead = picked.map(
    (t) => `[${briefClock(t.startMs)}] ${briefSpeaker(t.label, speakers)}: `,
  );
  const budget = Math.max(
    0,
    BRIEF_TRANSCRIPT_CHAR_LIMIT - overhead.reduce((a, s) => a + s.length + 1, 0),
  );
  let cap = Math.floor(budget / Math.max(1, picked.length));
  let remaining = budget;
  let slots = picked.length;
  for (const length of picked.map((t) => t.text.length).sort((a, b) => a - b)) {
    if (length > cap) break;
    remaining -= length;
    slots--;
    cap = Math.max(cap, Math.floor(remaining / Math.max(1, slots)));
  }
  let truncatedTurns = 0;
  const evidence = picked.map((turn, index) => {
    const truncated = turn.text.length > cap;
    if (truncated) truncatedTurns++;
    const text = truncated ? `${turn.text.slice(0, Math.max(0, cap - 1))}…` : turn.text;
    return {
      ...turn,
      text,
      speaker: briefSpeaker(turn.label, speakers),
      line: overhead[index]! + text,
    };
  });
  return {
    evidence,
    lines: evidence.map((e) => e.line),
    coverage: {
      availableTurns: turns.length,
      includedTurns: evidence.length,
      truncatedTurns,
      limited: evidence.length < turns.length || truncatedTurns > 0,
    },
  };
}

/** Model times and speaker names never become source authority. */
export function validateBriefCitations(
  sections: Array<{ name: string; content: string }>,
  evidence: ReturnType<typeof buildBriefEvidence>['evidence'],
  moments: Array<{ startMs?: number; speaker?: string; summary: string }>,
) {
  const clocks = new Set(evidence.map((e) => briefClock(e.startMs)));
  const normalize = (text: string) =>
    text.replace(/[’‘]/g, "'").replace(/\s+/g, ' ').trim().toLowerCase();
  const sourceText = normalize(evidence.map((e) => e.text).join(' '));
  for (const section of sections) {
    const citations = [...section.content.matchAll(/\[(\d{1,2}:\d{2}(?::\d{2})?)\]/g)];
    if (citations.some((match) => !clocks.has(match[1]!)))
      throw new Error('Unverified transcript citation');
    for (const quote of section.content.matchAll(/[“"]([^“”"\n]{20,})[”"]/g))
      if (!sourceText.includes(normalize(quote[1]!)))
        throw new Error('Quotation is not present in supplied transcript');
    if (
      /^(Executive summary|Key exchanges|Positions on the record|Commitments, deadlines and open questions)$/.test(
        section.name,
      ) &&
      !citations.length &&
      !/no (?:supported|recorded|specific|verifiable)|not (?:recorded|available|established)|insufficient (?:evidence|transcript)/i.test(
        section.content,
      )
    )
      throw new Error(`Transcript citation required for ${section.name}`);
  }
  return moments.map((moment) => {
    const source = evidence.find((e) => e.startMs === moment.startMs);
    if (!source) throw new Error('Key moment is outside supplied transcript evidence');
    return { startMs: source.startMs, speaker: source.speaker, summary: moment.summary };
  });
}
