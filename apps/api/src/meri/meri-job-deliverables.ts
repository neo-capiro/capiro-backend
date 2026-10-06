import { normalizeWordSpec, type WordSpec } from './meri-docgen.helpers.js';
import type { MeriJobDeliverable, MeriJobKind } from './meri-job.js';

/**
 * Stage 2 Release B deliverables (program plan §5.3). A deliverable job asks
 * for a document; Release B supports one Word document per job. The document
 * is rendered on demand from the job's authorized report, so it is never
 * readable once the report itself would be withheld.
 */
export const MAX_JOB_DELIVERABLES = 1;
export const RELEASE_B_DELIVERABLE_FORMATS = ['docx'] as const;

export class MeriJobDeliverableRequestError extends Error {}

/** The deliverables a new job records; empty for every kind but `deliverable`. */
export function requestedJobDeliverables(
  kind: MeriJobKind,
  raw: unknown,
  fallbackTitle: string,
): MeriJobDeliverable[] {
  if (kind !== 'deliverable') {
    if (raw !== undefined && !(Array.isArray(raw) && raw.length === 0))
      throw new MeriJobDeliverableRequestError('Only a deliverable job can request deliverables.');
    return [];
  }
  const requested = raw === undefined ? [{ format: 'docx' }] : raw;
  if (!Array.isArray(requested) || requested.length < 1 || requested.length > MAX_JOB_DELIVERABLES)
    throw new MeriJobDeliverableRequestError(
      `A deliverable job requests exactly ${MAX_JOB_DELIVERABLES} document.`,
    );
  return requested.map((entry) => {
    const row =
      entry && typeof entry === 'object' && !Array.isArray(entry)
        ? (entry as Record<string, unknown>)
        : {};
    if (!(RELEASE_B_DELIVERABLE_FORMATS as readonly unknown[]).includes(row.format))
      throw new MeriJobDeliverableRequestError('Deliverables are Word documents (docx) for now.');
    const title =
      typeof row.title === 'string' && row.title.trim() ? row.title.trim() : fallbackTitle;
    return { format: 'docx', title: title.slice(0, 200), artifactId: null };
  });
}

/** Markdown emphasis, links and code markers become plain text for Word paragraphs. */
function plain(text: string): string {
  return text
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '$1 ($2)')
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/(^|[^*\w])[*_]([^*_\n]+)[*_](?=[^*\w]|$)/g, '$1$2')
    .replace(/`([^`]+)`/g, '$1')
    .trim();
}

/** A research report's markdown as a Word document spec (headings, paragraphs, lists). */
export function researchReportWordSpec(title: string, markdown: string): WordSpec {
  type Section = { heading: string; paragraphs: string[]; bullets: string[] };
  const sections: Section[] = [];
  let current: Section = { heading: 'Summary', paragraphs: [], bullets: [] };
  let paragraph: string[] = [];
  const flushParagraph = () => {
    if (paragraph.length) current.paragraphs.push(paragraph.join(' '));
    paragraph = [];
  };
  const flushSection = () => {
    flushParagraph();
    if (current.paragraphs.length || current.bullets.length) sections.push(current);
  };
  for (const raw of markdown.split(/\r?\n/)) {
    const line = raw.trim();
    const heading = /^#{1,6}\s+(.+)$/.exec(line);
    if (heading) {
      flushSection();
      const text = plain(heading[1]!);
      // The report's own top heading repeats the document title.
      current = {
        heading: text.toLowerCase() === title.trim().toLowerCase() ? 'Summary' : text,
        paragraphs: [],
        bullets: [],
      };
      continue;
    }
    const bullet = /^(?:[-*+]|\d+[.)])\s+(.+)$/.exec(line);
    if (bullet) {
      flushParagraph();
      const text = plain(bullet[1]!);
      if (text) current.bullets.push(text);
      continue;
    }
    if (!line || /^(?:-{3,}|\*{3,}|_{3,})$/.test(line)) {
      flushParagraph();
      continue;
    }
    const text = plain(line.replace(/^>\s?/, ''));
    if (text) paragraph.push(text);
  }
  flushSection();
  return normalizeWordSpec({
    title,
    subtitle: null,
    sections: sections.map((section) => ({
      ...section,
      tables: [],
      imageArtifactIds: [],
      images: [],
    })),
  });
}

export function deliverableFileName(title: string): string {
  const base = title
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 150);
  return `${base || 'Meri deliverable'}.docx`;
}
