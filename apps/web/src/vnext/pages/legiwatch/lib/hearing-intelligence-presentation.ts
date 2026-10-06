import type { HearingIntelligenceItem, PublicTranscriptSegment } from './canonical-hearings.js';
import { speakerDisplay } from './hearing-detail-states.js';

/** Expand only a contiguous same-speaker turn; never splice across another speaker. */
export function transcriptContext(segments: Array<{ text: string; speakerLabel?: string | null; startMs: number; endMs: number }>, index: number): string | undefined {
  const anchor = segments[index];
  if (!anchor) return undefined;
  let first = index, last = index;
  if (anchor.speakerLabel?.trim()) {
    while (first > Math.max(0, index - 2) && segments[first - 1]?.speakerLabel === anchor.speakerLabel && anchor.startMs - segments[first - 1]!.endMs <= 15_000) first--;
    while (last < Math.min(segments.length - 1, index + 2) && segments[last + 1]?.speakerLabel === anchor.speakerLabel && segments[last + 1]!.startMs - anchor.endMs <= 15_000) last++;
  }
  const text = segments.slice(first, last + 1).map((segment) => segment.text.trim()).join(' ');
  return text.length > 900 ? `${text.slice(0, 900)}…` : text;
}

/** Findings remain navigation aids: verified transcript labels own attribution. */
export function presentHearingIntelligence(items: HearingIntelligenceItem[], segments: PublicTranscriptSegment[]) {
  const seen = new Set<string>();
  return items.flatMap((item) => {
    const index = segments.findIndex((segment) => segment.id === item.segmentId);
    const anchor = segments[index];
    const normalized = (item.evidenceText || item.summary || item.title).replace(/\s+/g, ' ').trim().toLowerCase();
    const identity = `${item.insightType}|${item.segmentId ?? item.startMs ?? item.id}|${normalized}`;
    if (seen.has(identity)) return [];
    seen.add(identity);
    const context = anchor ? transcriptContext(segments, index) : item.evidenceText?.trim();
    const fragment = item.title.trim().split(/\s+/).length < 4 && item.summary.trim().split(/\s+/).length < 5;
    return [{ ...item,
      title: fragment ? `${item.insightType === 'QUESTION' ? 'Question' : 'Transcript finding'} — review in context` : item.title,
      summary: fragment ? 'This automatic finding is a short transcript fragment. Review the surrounding testimony before relying on it.' : item.summary,
      preliminary: Boolean(item.preliminary || fragment || !anchor),
      evidenceText: context ? (context.length > 900 ? `${context.slice(0, 900)}…` : context) : undefined,
      speakerName: anchor ? speakerDisplay(anchor) ?? undefined : undefined,
      startMs: anchor?.startMs ?? item.startMs,
    }];
  });
}
