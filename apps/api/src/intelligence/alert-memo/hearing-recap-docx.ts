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
 * Dedicated DOCX renderer for the LEGACY saved hearing recap
 * (HearingRecapService.save). This is NOT the shared alert-memo parser: that
 * one only understands `## ` headings and leaks inline Markdown / opaque
 * evidence ids into the Word body. This helper is hearing-aware — it parses
 * the exact Markdown briefToMarkdown produces (title, `_…_` provenance lines,
 * `##`/`###` headings, `- ` bullets, readable `m:ss` citations) into clean Word
 * structure with NO raw Markdown tokens and NO `[segment:…]`/`[claim:…]` walls.
 *
 * The governed APPROVED path (renderApprovedHearingRecap) is intentionally
 * untouched and keeps using the memo renderer; this helper is only for the
 * legacy save so the two stay independent.
 *
 * Input is treated as data: structure is derived from line prefixes only, and
 * any residual inline emphasis/code markers are stripped to plain text, never
 * executed or rendered as markup.
 */

const NAVY = '1C2E4A';
const GOLD = '9F7518';
const GREY = '6B7280';
const RULE = 'D0D5DD';

export interface HearingRecapDocInput {
  clientName: string;
  dateStr: string;
  /** Concise recap title (RE line + document headline). */
  title: string;
  /** Formal hearing title, when distinct — kept as provenance. */
  hearingTitle?: string | null;
  sections: Array<{ heading: string; level: 2 | 3; blocks: HearingRecapBlock[] }>;
}

type HearingRecapBlock =
  | { kind: 'para'; text: string }
  | { kind: 'bullets'; items: string[] }
  | { kind: 'meta'; text: string };

/** Strip residual inline Markdown emphasis/code/links to plain text (data, not markup). */
function plain(text: string): string {
  return text
    .replace(/\\([\\`*_{}\[\]()#+\-.!|>~<])/g, '$1') // our own mdEscape backslashes
    .replace(/!\[([^\]]*)\]\(([^)]*)\)/g, '$1') // ![alt](img) → alt (before the link rule)
    .replace(/\[([^\]]*)\]\(([^)]*)\)/g, '$1') // [text](url) → text (never a live link/URL)
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/\b_([^_]+)_\b/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .trim();
}

/** Is this an `_…_` provenance / generated-by / prepared-for line? */
function isMetaLine(line: string): boolean {
  return /^_.+_$/.test(line.trim());
}

/**
 * Parse the recap Markdown into hearing-aware sections. Recognizes the real
 * structure briefToMarkdown emits; drops the top `# ` title (carried separately)
 * and never surfaces raw tokens or opaque ids (which briefToMarkdown no longer
 * writes — but if a stale/foreign line slips through, `plain` defangs it).
 */
export function markdownToHearingRecapDocInput(
  markdown: string,
  clientName: string,
  title: string,
  opts?: { dateStr?: string; hearingTitle?: string | null },
): HearingRecapDocInput {
  const sections: HearingRecapDocInput['sections'] = [];
  let cur: { heading: string; level: 2 | 3; blocks: HearingRecapBlock[] } | null = null;
  let bullets: string[] | null = null;

  const flushBullets = () => {
    if (cur && bullets?.length) cur.blocks.push({ kind: 'bullets', items: bullets });
    bullets = null;
  };
  const flush = () => {
    flushBullets();
    if (cur && (cur.heading || cur.blocks.length)) sections.push(cur);
    cur = null;
  };

  for (const raw of markdown.split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (!line.trim()) {
      flushBullets();
      continue;
    }
    if (/^#\s+/.test(line)) continue; // top title carried separately
    const h2 = line.match(/^##\s+(.*)$/);
    const h3 = line.match(/^###\s+(.*)$/);
    if (h2 || h3) {
      flush();
      cur = { heading: plain((h2 ?? h3)![1] ?? ''), level: h2 ? 2 : 3, blocks: [] };
      continue;
    }
    if (!cur) cur = { heading: '', level: 2, blocks: [] };
    const bullet = line.match(/^[-*]\s+(.*)$/);
    if (bullet) {
      (bullets ??= []).push(plain(bullet[1] ?? ''));
      continue;
    }
    flushBullets();
    const text = plain(line);
    if (!text) continue;
    cur.blocks.push(isMetaLine(line) ? { kind: 'meta', text } : { kind: 'para', text });
  }
  flush();
  if (!sections.length) {
    sections.push({ heading: '', level: 2, blocks: [{ kind: 'para', text: plain(markdown) }] });
  }
  return {
    clientName,
    dateStr: opts?.dateStr ?? formatRecapDate(),
    title: plain(title) || 'Hearing recap',
    hearingTitle: opts?.hearingTitle ? plain(opts.hearingTitle) : null,
    sections,
  };
}

/** Long-form date; parses YYYY-MM-DD as a local date to avoid tz drift. */
export function formatRecapDate(actionDate?: string | null): string {
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

export async function renderHearingRecapDocx(input: HearingRecapDocInput): Promise<Buffer> {
  const children: Paragraph[] = [];

  // ---- Letterhead ----
  children.push(
    new Paragraph({
      spacing: { after: 40 },
      children: [
        new TextRun({ text: 'CAPIRO', bold: true, size: 30, color: NAVY }),
        new TextRun({ text: '   Government Affairs Intelligence', bold: true, size: 16, color: GOLD }),
      ],
    }),
  );
  children.push(rule(GOLD, 12, 200));

  // ---- Title ----
  children.push(
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 60 },
      children: [new TextRun({ text: 'HEARING RECAP', bold: true, size: 22, color: GREY })],
    }),
  );
  children.push(
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 160 },
      children: [new TextRun({ text: input.title, bold: true, size: 28, color: NAVY })],
    }),
  );

  // ---- TO / DATE / (optional) HEARING ----
  children.push(metaLine('TO:', input.clientName));
  children.push(metaLine('DATE:', input.dateStr));
  if (input.hearingTitle && input.hearingTitle !== input.title) {
    children.push(metaLine('HEARING:', input.hearingTitle));
  }
  children.push(rule(RULE, 6, 160));

  // ---- Sections ----
  for (const s of input.sections) {
    if (s.heading) {
      children.push(
        new Paragraph({
          heading: s.level === 2 ? HeadingLevel.HEADING_2 : HeadingLevel.HEADING_3,
          spacing: { before: 140, after: 60 },
          children: [
            new TextRun({ text: s.heading, bold: true, color: NAVY, size: s.level === 2 ? 24 : 22 }),
          ],
        }),
      );
    }
    for (const b of s.blocks) {
      if (b.kind === 'bullets') {
        for (const item of b.items) {
          children.push(
            new Paragraph({
              bullet: { level: 0 },
              spacing: { after: 40 },
              children: [new TextRun(item)],
            }),
          );
        }
      } else if (b.kind === 'meta') {
        children.push(
          new Paragraph({
            spacing: { after: 100 },
            children: [new TextRun({ text: b.text, italics: true, color: GREY, size: 20 })],
          }),
        );
      } else {
        children.push(new Paragraph({ spacing: { after: 120 }, children: [new TextRun(b.text)] }));
      }
    }
  }

  // ---- Footer ----
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
