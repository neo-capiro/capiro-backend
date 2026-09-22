/**
 * Pure shaping between a Meri-drafted hearing brief and the Workspace document
 * model. Section content becomes the same HTML Workspace sections hold, so the
 * in-editor Meri assistant's edits apply directly and what the user reviewed
 * is exactly what gets saved.
 */
import type { WorkspaceSectionState } from '../../../../pages/workspace/editor/edit-review.js';
import type { HearingBrief } from './wave1-api.js';

const escape = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!,
  );
const inline = (line: string) => escape(line).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');

const HEADING = /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/;
const BULLET = /^\s*[-*•]\s+(.*)$/;
const NUMBERED = /^\s*\d+[.)]\s+(.*)$/;
const isBlockStart = (line: string) => HEADING.test(line) || BULLET.test(line) || NUMBERED.test(line);

/** Plain text with light markdown (as Meri writes it) → Workspace section HTML. */
export function textToHtml(text: string): string {
  const html: string[] = [];
  for (const block of text.replace(/\r\n?/g, '\n').split(/\n[ \t]*\n+/)) {
    const lines = block.split('\n').filter((line) => line.trim());
    let i = 0;
    while (i < lines.length) {
      const heading = HEADING.exec(lines[i]!);
      if (heading) {
        html.push(`<h3>${inline(heading[1]!)}</h3>`);
        i += 1;
        continue;
      }
      const list = BULLET.test(lines[i]!) ? 'ul' : NUMBERED.test(lines[i]!) ? 'ol' : null;
      if (list) {
        const pattern = list === 'ul' ? BULLET : NUMBERED;
        const items: string[] = [];
        for (let match = pattern.exec(lines[i]!); match; match = pattern.exec(lines[++i] ?? '')) {
          items.push(`<li>${inline(match[1]!)}</li>`);
        }
        html.push(`<${list}>${items.join('')}</${list}>`);
        continue;
      }
      const paragraph: string[] = [];
      while (i < lines.length && !isBlockStart(lines[i]!)) paragraph.push(inline(lines[i++]!.trim()));
      html.push(`<p>${paragraph.join('<br>')}</p>`);
    }
  }
  return html.join('');
}

export function briefToSectionState(brief: Pick<HearingBrief, 'sections'>): WorkspaceSectionState {
  const state: WorkspaceSectionState = { sections: [], content: {}, meta: {} };
  for (const section of brief.sections) {
    const base = section.name.replace(/\s+/g, ' ').trim() || 'Section';
    let name = base;
    for (let n = 2; state.sections.some((s) => s.toLowerCase() === name.toLowerCase()); n += 1) {
      name = `${base} ${n}`;
    }
    state.sections.push(name);
    state.content[name] = textToHtml(section.content ?? '');
    state.meta[name] = { status: 'review' };
  }
  return state;
}

export function briefToWorkspaceConfig({
  hearingId,
  clientId,
  mode,
  sources,
  state,
}: {
  hearingId: string;
  clientId: string;
  mode: HearingBrief['mode'];
  sources: HearingBrief['sources'];
  state: WorkspaceSectionState;
}) {
  return {
    legiwatch: { mode: 'hearing-brief' as const, hearingId, clientId, briefMode: mode },
    sources,
    sections: state.sections,
    sectionContent: state.content,
    sectionMeta: state.meta,
  };
}

/** `H:MM:SS`, the timecode rendering Hearing Detail uses. */
export function timecode(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(s / 60);
  return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

/** The grounding item attached to the saved draft, for later Meri turns in Workspace. */
export function briefContextText(brief: HearingBrief): string {
  const moments = brief.keyMoments.map((moment) =>
    `- ${[
      moment.startMs != null ? timecode(moment.startMs) : null,
      moment.speaker ? `${moment.speaker}:` : null,
      moment.summary,
    ]
      .filter(Boolean)
      .join(' ')}`,
  );
  return [
    `LegiWatch ${brief.mode} brief — ${brief.title}.`,
    brief.lowConfidence
      ? 'Meri flagged this draft as low confidence; verify claims against the sources before quoting.'
      : null,
    moments.length ? `Key moments:\n${moments.join('\n')}` : null,
    `Hearing context packet: ${JSON.stringify(brief.contextPacket)}`,
    `Sources: ${JSON.stringify(brief.sources)}`,
  ]
    .filter(Boolean)
    .join('\n');
}
