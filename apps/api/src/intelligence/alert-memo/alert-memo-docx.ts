import {
  AlignmentType,
  BorderStyle,
  Document,
  HeadingLevel,
  Packer,
  Paragraph,
  TextRun,
} from 'docx';

/**
 * Renders an alert→client memo as a properly formatted Word document — a real
 * government-affairs MEMORANDUM: Capiro letterhead, a TO/FROM/DATE/RE block,
 * navy section headings, bulleted Recommended actions / Talking points, a
 * numbered Sources list, and a confidentiality footer. Full control via the
 * `docx` lib (vs the generic meri-docgen WordSpec) so the deliverable looks
 * client-ready straight out of the client's Documents.
 */

const NAVY = '1C2E4A';
const GOLD = '9F7518';
const GREY = '6B7280';
const RULE = 'D0D5DD';

export interface MemoDocInput {
  clientName: string;
  dateStr: string;
  reLine: string;
  sections: Array<{ heading: string; paragraphs: string[] }>;
  sources: Array<{ label: string; url?: string | null }>;
}

/** Headings whose prose reads as a list → render as bullets. */
const BULLET_HEADINGS = new Set(['recommended actions', 'talking points', 'next steps']);

export async function renderMemoDocx(input: MemoDocInput): Promise<Buffer> {
  const children: Paragraph[] = [];

  // ---- Letterhead ----
  children.push(
    new Paragraph({
      spacing: { after: 40 },
      children: [
        new TextRun({ text: 'CAPIRO', bold: true, size: 30, color: NAVY }),
        new TextRun({
          text: '   Government Affairs Intelligence',
          bold: true,
          size: 16,
          color: GOLD,
        }),
      ],
    }),
  );
  children.push(rule(GOLD, 12, 200));

  // ---- MEMORANDUM title ----
  children.push(
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 160 },
      children: [new TextRun({ text: 'MEMORANDUM', bold: true, size: 26, color: NAVY })],
    }),
  );

  // ---- TO / FROM / DATE / RE ----
  children.push(metaLine('TO:', input.clientName));
  children.push(metaLine('FROM:', 'Capiro Government Affairs'));
  children.push(metaLine('DATE:', input.dateStr));
  children.push(
    new Paragraph({
      spacing: { after: 160 },
      children: [
        new TextRun({ text: 'RE:', bold: true, color: NAVY }),
        new TextRun({ text: `\t${input.reLine}`, bold: true }),
      ],
    }),
  );
  children.push(rule(RULE, 6, 160));

  // ---- Sections ----
  for (const s of input.sections) {
    if (!s.paragraphs.length) continue;
    children.push(
      new Paragraph({
        heading: HeadingLevel.HEADING_2,
        spacing: { before: 140, after: 60 },
        children: [new TextRun({ text: s.heading, bold: true, color: NAVY })],
      }),
    );
    const bulletize = BULLET_HEADINGS.has(s.heading.trim().toLowerCase());
    for (const p of s.paragraphs) {
      if (bulletize) {
        for (const item of splitToBullets(p)) {
          children.push(
            new Paragraph({
              bullet: { level: 0 },
              spacing: { after: 40 },
              children: [new TextRun(item)],
            }),
          );
        }
      } else {
        children.push(new Paragraph({ spacing: { after: 120 }, children: [new TextRun(p)] }));
      }
    }
  }

  // ---- Sources ----
  if (input.sources.length) {
    children.push(
      new Paragraph({
        heading: HeadingLevel.HEADING_2,
        spacing: { before: 160, after: 60 },
        children: [new TextRun({ text: 'Sources', bold: true, color: NAVY })],
      }),
    );
    input.sources.forEach((src, i) =>
      children.push(
        new Paragraph({
          spacing: { after: 24 },
          children: [
            new TextRun({
              text: `${i + 1}. ${src.label}${src.url ? `  —  ${src.url}` : ''}`,
              size: 18,
              color: GREY,
            }),
          ],
        }),
      ),
    );
  }

  // ---- Footer note ----
  children.push(
    new Paragraph({
      spacing: { before: 260 },
      border: { top: { color: RULE, style: BorderStyle.SINGLE, size: 6, space: 6 } },
      children: [
        new TextRun({
          text: 'Prepared by Capiro Intelligence · Confidential — for internal client use',
          italics: true,
          size: 16,
          color: GREY,
        }),
      ],
    }),
  );

  const doc = new Document({ sections: [{ properties: {}, children }] });
  return Buffer.from(await Packer.toBuffer(doc));
}

function rule(color: string, size: number, after: number): Paragraph {
  return new Paragraph({
    spacing: { after },
    border: { bottom: { color, style: BorderStyle.SINGLE, size, space: 1 } },
  });
}

function metaLine(label: string, value: string): Paragraph {
  return new Paragraph({
    spacing: { after: 40 },
    children: [
      new TextRun({ text: label, bold: true, color: NAVY }),
      new TextRun({ text: `\t${value}` }),
    ],
  });
}

/** Split "1. a 2. b" / newline / semicolon list prose into individual bullets. */
function splitToBullets(text: string): string[] {
  const byNum = text
    .split(/(?:^|\s)\d+\.\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (byNum.length > 1) return byNum;
  const byLine = text
    .split(/[\n;]+/)
    .map((s) => s.replace(/^[-*•]\s*/, '').trim())
    .filter(Boolean);
  if (byLine.length > 1) return byLine;
  return [text.trim()];
}

/** MIME type for the generated memo/brief .docx (auto-file + reviews-release paths). */
export const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

/** Split edited memo markdown into a MemoDocInput (## headings → sections; a "Sources" section → source lines). */
export function markdownToMemoDocInput(
  markdown: string,
  clientName: string,
  title: string,
  actionDate?: string,
): MemoDocInput {
  const sections: MemoDocInput['sections'] = [];
  const sources: MemoDocInput['sources'] = [];
  let cur: { heading: string; paragraphs: string[] } | null = null;
  let inSources = false;
  const flush = () => {
    if (cur && (cur.heading || cur.paragraphs.length)) sections.push(cur);
  };
  for (const raw of markdown.split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (/^#\s+/.test(line)) continue; // top title
    if (/^\*Prepared for/.test(line)) continue; // subtitle line
    const h = line.match(/^##\s+(.*)$/);
    if (h) {
      flush();
      const heading = (h[1] ?? '').trim();
      inSources = /^sources$/i.test(heading);
      cur = inSources ? null : { heading, paragraphs: [] };
      continue;
    }
    if (inSources) {
      const m = line.match(/^[-*]\s+(.*)$/);
      if (m) sources.push(splitSourceLine(m[1] ?? ''));
      continue;
    }
    if (!cur) cur = { heading: '', paragraphs: [] };
    if (line.trim()) cur.paragraphs.push(line.replace(/^[-*]\s+/, '').trim());
  }
  flush();
  if (!sections.length) sections.push({ heading: '', paragraphs: [markdown.trim()] });
  return {
    clientName,
    dateStr: formatMemoDate(actionDate),
    reLine: title.replace(/^client memo\s*[—-]\s*/i, '').trim() || 'Client update',
    sections,
    sources,
  };
}

function splitSourceLine(s: string): { label: string; url: string | null } {
  const m = s.match(/^(.*?)\s+[—-]\s+(https?:\/\/\S+)$/);
  if (m) return { label: (m[1] ?? '').trim(), url: (m[2] ?? '').trim() || null };
  return { label: s.trim(), url: null };
}

/** Long-form memo date; parses YYYY-MM-DD as a local date to avoid tz drift. */
export function formatMemoDate(actionDate?: string | null): string {
  let d: Date;
  if (actionDate && /^\d{4}-\d{2}-\d{2}/.test(actionDate)) {
    const parts = actionDate.slice(0, 10).split('-').map(Number);
    d = new Date(parts[0] ?? 1970, (parts[1] ?? 1) - 1, parts[2] ?? 1);
  } else if (actionDate) {
    d = new Date(actionDate);
  } else {
    d = new Date();
  }
  if (Number.isNaN(d.getTime())) d = new Date();
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
}
