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
 * Renders a Step 3.3 source-backed artifact (the fact-sheet `bodyText`) as a
 * client-ready Word document: Capiro letterhead, the artifact title, navy
 * section headings, bulleted Sources / Caveats, and a confidentiality footer.
 *
 * The input is the exact markdown that {@link assembleBody} emits — a bounded
 * subset:
 *   `# {Type}: {issue}`   → document title (dropped here; we render `title` in the header)
 *   `## Sources` / `## Caveats` → H2 section headings
 *   `- c1: <citation>`    → bullet
 *   plain lines            → prose paragraphs
 *   blank lines            → block separators
 * We parse defensively — an unexpected line renders as a plain paragraph, never
 * a crash — so this stays correct even if the assembler grows new sections.
 *
 * Mirrors the `docx`-lib approach in alert-memo-docx.ts so both intelligence
 * deliverables look consistent out of the box.
 */

const NAVY = '1C2E4A';
const GOLD = '9F7518';
const GREY = '6B7280';
const RULE = 'D0D5DD';

export interface ArtifactDocInput {
  /** The artifact's stored title (e.g. "Internal Brief: FY27 mark on PE 0603270A"). */
  title: string;
  /** The artifact `bodyText` markdown produced by the generator. */
  bodyText: string;
}

export async function renderArtifactDocx(input: ArtifactDocInput): Promise<Buffer> {
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

  // ---- Title ----
  children.push(
    new Paragraph({
      heading: HeadingLevel.HEADING_1,
      alignment: AlignmentType.LEFT,
      spacing: { after: 160 },
      children: [
        new TextRun({
          text: input.title.trim() || 'Intelligence Artifact',
          bold: true,
          size: 30,
          color: NAVY,
        }),
      ],
    }),
  );
  children.push(rule(RULE, 6, 160));

  // ---- Body ----
  for (const block of parseBlocks(input.bodyText)) {
    switch (block.kind) {
      case 'heading':
        children.push(
          new Paragraph({
            heading: HeadingLevel.HEADING_2,
            spacing: { before: 160, after: 60 },
            children: [new TextRun({ text: block.text, bold: true, color: NAVY })],
          }),
        );
        break;
      case 'bullet':
        children.push(
          new Paragraph({
            bullet: { level: 0 },
            spacing: { after: 40 },
            children: inlineRuns(block.text),
          }),
        );
        break;
      default:
        children.push(new Paragraph({ spacing: { after: 120 }, children: inlineRuns(block.text) }));
    }
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

type Block =
  | { kind: 'heading'; text: string }
  | { kind: 'bullet'; text: string }
  | { kind: 'paragraph'; text: string };

/**
 * Split the artifact markdown into renderable blocks. The leading `# ` title line
 * is dropped (the caller renders the stored title); `## ` become headings, `- `
 * become bullets, blank lines are separators, everything else is a paragraph.
 */
function parseBlocks(markdown: string): Block[] {
  const blocks: Block[] = [];
  for (const rawLine of (markdown ?? '').split('\n')) {
    const line = rawLine.trimEnd();
    if (!line.trim()) continue;
    if (line.startsWith('## ')) {
      blocks.push({ kind: 'heading', text: line.slice(3).trim() });
    } else if (line.startsWith('# ')) {
      // The document title — rendered from the stored title instead; skip.
      continue;
    } else if (/^[-*]\s+/.test(line)) {
      blocks.push({ kind: 'bullet', text: line.replace(/^[-*]\s+/, '').trim() });
    } else {
      blocks.push({ kind: 'paragraph', text: line.trim() });
    }
  }
  return blocks;
}

/** Convert a line with `**bold**` spans into docx TextRuns; plain text otherwise. */
function inlineRuns(text: string): TextRun[] {
  const runs: TextRun[] = [];
  const parts = text.split(/(\*\*[^*]+\*\*)/g);
  for (const part of parts) {
    if (!part) continue;
    const bold = part.startsWith('**') && part.endsWith('**') && part.length > 4;
    runs.push(new TextRun({ text: bold ? part.slice(2, -2) : part, bold }));
  }
  return runs.length ? runs : [new TextRun({ text })];
}

function rule(color: string, size: number, after: number): Paragraph {
  return new Paragraph({
    spacing: { after },
    border: { bottom: { color, style: BorderStyle.SINGLE, size, space: 1 } },
  });
}
