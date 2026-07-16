import { Injectable, NotFoundException } from '@nestjs/common';
import {
  Document,
  HeadingLevel,
  ImageRun,
  Packer,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from 'docx';
import PDFDocument from 'pdfkit';
import { PrismaService } from '../prisma/prisma.service.js';
import { CollaboratorsService } from '../collaborators/collaborators.service.js';
import { canRead } from '../collaborators/role-policy.js';
import { anonymizeText, applyRedactions } from '../generation/anonymize.js';

/** Decode the handful of HTML entities our sanitized section HTML can contain.
 *  `&amp;` is decoded LAST so an escaped entity like `&amp;lt;` (the literal
 *  text "&lt;") resolves to "&lt;", not double-decoded to "<". */
export function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&mdash;/g, '—')
    .replace(/&ndash;/g, '–')
    .replace(/&amp;/g, '&');
}

/**
 * Convert a sanitized section-HTML body into clean text lines for a flat
 * renderer (PDF). Block tags become line breaks, <li> becomes a bullet,
 * everything else is stripped — so prose + bullet lists survive but no raw tags
 * ever reach the document. Returns { text, bullet } lines, blank lines dropped.
 */
function htmlToLines(html: string): Array<{ text: string; bullet: boolean }> {
  const marked = html
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\s*li[^>]*>/gi, '\n') //  marks a bullet line
    .replace(/<\/\s*(p|div|h[1-6]|li|ul|ol|tr|table)\s*>/gi, '\n')
    .replace(/<[^>]+>/g, '');
  return decodeEntities(marked)
    .split('\n')
    .map((raw) => {
      const bullet = raw.startsWith('');
      const text = (bullet ? raw.slice(1) : raw).replace(/\s+/g, ' ').trim();
      return { text, bullet };
    })
    .filter((l) => l.text.length > 0);
}

// ── HTML → docx conversion (Phase 3.1 fix: DOCX must not leak raw markup) ────
//
// Meri's generated section HTML is constrained to a known, narrow vocabulary
// (generation.service.ts's own prompt + the web sanitizer's ALLOWED_TAGS):
// <p>, <ul>/<ol>/<li>, <table>/<thead>/<tbody>/<tr>/<th>/<td>, <strong>, <em>,
// and now <sup> (citation footnote markers). This converter targets exactly
// that vocabulary rather than being a general HTML parser — it only needs to
// handle what the model is ever instructed to produce.

interface InlineRun {
  text: string;
  bold?: boolean;
  italics?: boolean;
  superScript?: boolean;
}

/** Walk inline markup (<strong>/<b>, <em>/<i>, <sup>) into styled text runs. */
export function parseInlineRuns(html: string): InlineRun[] {
  const runs: InlineRun[] = [];
  const stack: Array<Omit<InlineRun, 'text'>> = [{}];
  const re = /<(\/?)(strong|b|em|i|sup)\s*>|([^<]+)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) != null) {
    if (m[3] !== undefined) {
      const text = decodeEntities(m[3]);
      if (text.length === 0) continue;
      runs.push({ text, ...stack[stack.length - 1] });
      continue;
    }
    const closing = m[1] === '/';
    const tag = m[2]!.toLowerCase();
    if (!closing) {
      const next = { ...stack[stack.length - 1] };
      if (tag === 'strong' || tag === 'b') next.bold = true;
      else if (tag === 'em' || tag === 'i') next.italics = true;
      else if (tag === 'sup') next.superScript = true;
      stack.push(next);
    } else if (stack.length > 1) {
      stack.pop();
    }
  }
  return runs;
}

function toTextRun(r: InlineRun, forceBold = false): TextRun {
  return new TextRun({
    text: r.text,
    bold: forceBold || r.bold,
    italics: r.italics,
    superScript: r.superScript,
  });
}

function docxRunsFromInline(html: string, forceBold = false): TextRun[] {
  const runs = parseInlineRuns(html).map((r) => toTextRun(r, forceBold));
  return runs.length ? runs : [new TextRun('')];
}

/** A block-of-text fallback (no recognized block tags) — split on blank lines. */
function strayTextParagraphs(html: string): Paragraph[] {
  const text = decodeEntities(html.replace(/<\s*br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, ''));
  return text
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
    .map((p) => new Paragraph({ children: [new TextRun(p)] }));
}

function parseListItems(innerHtml: string): Paragraph[] {
  const items: Paragraph[] = [];
  const liRe = /<li[^>]*>([\s\S]*?)<\/li>/gi;
  let m: RegExpExecArray | null;
  while ((m = liRe.exec(innerHtml)) != null) {
    items.push(new Paragraph({ children: docxRunsFromInline(m[1] ?? ''), bullet: { level: 0 } }));
  }
  return items;
}

function parseTableNode(innerHtml: string): Table {
  const rows: TableRow[] = [];
  const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let rm: RegExpExecArray | null;
  while ((rm = rowRe.exec(innerHtml)) != null) {
    const rowHtml = rm[1] ?? '';
    const cellRe = /<(th|td)[^>]*>([\s\S]*?)<\/\1>/gi;
    const cells: TableCell[] = [];
    let cm: RegExpExecArray | null;
    while ((cm = cellRe.exec(rowHtml)) != null) {
      const isHeader = cm[1]!.toLowerCase() === 'th';
      cells.push(
        new TableCell({
          children: [new Paragraph({ children: docxRunsFromInline(cm[2] ?? '', isHeader) })],
        }),
      );
    }
    if (cells.length) rows.push(new TableRow({ children: cells }));
  }
  if (rows.length === 0) return new Table({ rows: [new TableRow({ children: [] })] });
  return new Table({ rows, width: { size: 100, type: WidthType.PERCENTAGE } });
}

/**
 * Convert one section's sanitized HTML body into real docx nodes: paragraphs
 * (with bold/italic/superscript runs), bulleted list items, and real tables —
 * instead of the raw tag soup a naive `\n{2,}` split on the HTML previously
 * produced. Falls back to stray-text paragraphs for content with no
 * recognized block tags (defensive — Meri's real output is always
 * block-wrapped).
 */
export function htmlToDocxNodes(html: string): Array<Paragraph | Table> {
  const nodes: Array<Paragraph | Table> = [];
  const blockRe =
    /<table[^>]*>([\s\S]*?)<\/table>|<ul[^>]*>([\s\S]*?)<\/ul>|<ol[^>]*>([\s\S]*?)<\/ol>|<p[^>]*>([\s\S]*?)<\/p>/gi;
  let last = 0;
  let matched = false;
  let m: RegExpExecArray | null;
  while ((m = blockRe.exec(html)) != null) {
    matched = true;
    const strayBefore = html.slice(last, m.index);
    if (strayBefore.replace(/<[^>]+>/g, '').trim()) nodes.push(...strayTextParagraphs(strayBefore));
    if (m[1] !== undefined) nodes.push(parseTableNode(m[1]));
    else if (m[2] !== undefined) nodes.push(...parseListItems(m[2]));
    else if (m[3] !== undefined) nodes.push(...parseListItems(m[3]));
    else if (m[4] !== undefined) nodes.push(new Paragraph({ children: docxRunsFromInline(m[4]) }));
    last = blockRe.lastIndex;
  }
  const tail = html.slice(last);
  if (matched) {
    if (tail.replace(/<[^>]+>/g, '').trim()) nodes.push(...strayTextParagraphs(tail));
  } else if (html.replace(/<[^>]+>/g, '').trim()) {
    nodes.push(...strayTextParagraphs(html));
  }
  return nodes;
}

// ── PDF-side table extraction (fixes B9.3: an inline <table> in a section's
// rich text used to flatten to run-together plain text via htmlToLines). ────

interface HtmlSegment {
  kind: 'html' | 'table';
  html?: string;
  rows?: string[][];
}

function stripTags(s: string): string {
  return decodeEntities(s.replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

export function parsePlainTableRows(innerHtml: string): string[][] {
  const rows: string[][] = [];
  const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let rm: RegExpExecArray | null;
  while ((rm = rowRe.exec(innerHtml)) != null) {
    const cellRe = /<(?:th|td)[^>]*>([\s\S]*?)<\/(?:th|td)>/gi;
    const cells: string[] = [];
    let cm: RegExpExecArray | null;
    while ((cm = cellRe.exec(rm[1] ?? '')) != null) cells.push(stripTags(cm[1] ?? ''));
    if (cells.length) rows.push(cells);
  }
  return rows;
}

/** Split section HTML into ordinary prose/list segments and real <table> segments. */
export function splitOutTables(html: string): HtmlSegment[] {
  const segments: HtmlSegment[] = [];
  const tableRe = /<table[^>]*>([\s\S]*?)<\/table>/gi;
  let last = 0;
  let m: RegExpExecArray | null;
  let matched = false;
  while ((m = tableRe.exec(html)) != null) {
    matched = true;
    const before = html.slice(last, m.index);
    if (before.trim()) segments.push({ kind: 'html', html: before });
    const rows = parsePlainTableRows(m[1] ?? '');
    if (rows.length) segments.push({ kind: 'table', rows });
    last = tableRe.lastIndex;
  }
  const tail = html.slice(last);
  if (matched) {
    if (tail.trim()) segments.push({ kind: 'html', html: tail });
  } else {
    segments.push({ kind: 'html', html });
  }
  return segments;
}

/** Add a page if `needed` vertical points won't fit before the bottom margin. */
function ensureSpace(doc: PDFKit.PDFDocument, needed: number, bottom: number): void {
  if (doc.y + needed > bottom) doc.addPage();
}

/** Draw a simple bordered table (header row bold + shaded) with cell wrapping
 *  and page breaks. Columns are evenly sized across the content width. */
function drawPdfTable(
  doc: PDFKit.PDFDocument,
  rows: string[][],
  left: number,
  width: number,
  bottom: number,
): void {
  const ncols = Math.max(1, ...rows.map((r) => r.length));
  const colW = width / ncols;
  const padX = 5;
  const padY = 4;
  for (let ri = 0; ri < rows.length; ri += 1) {
    const isHeader = ri === 0;
    const font = isHeader ? 'Times-Bold' : 'Times-Roman';
    doc.font(font).fontSize(9.5);
    let rowH = 0;
    for (let ci = 0; ci < ncols; ci += 1) {
      rowH = Math.max(rowH, doc.heightOfString(rows[ri]?.[ci] ?? '', { width: colW - padX * 2 }));
    }
    rowH += padY * 2;
    if (doc.y + rowH > bottom) doc.addPage();
    const y0 = doc.y;
    for (let ci = 0; ci < ncols; ci += 1) {
      const x = left + ci * colW;
      if (isHeader) doc.rect(x, y0, colW, rowH).fillColor('#f0f0f0').fill();
      doc.rect(x, y0, colW, rowH).lineWidth(0.5).strokeColor('#999999').stroke();
      doc
        .font(font)
        .fontSize(9.5)
        .fillColor('#111111')
        .text(rows[ri]?.[ci] ?? '', x + padX, y0 + padY, { width: colW - padX * 2 });
      doc.fillColor('#000000');
    }
    doc.y = y0 + rowH;
  }
  doc.moveDown(0.6);
}

/** Render one section body to the PDF, extracting embedded <table>s as real tables. */
function renderSectionBodyPdf(
  doc: PDFKit.PDFDocument,
  html: string,
  left: number,
  contentWidth: number,
  bottom: number,
): void {
  for (const seg of splitOutTables(html)) {
    if (seg.kind === 'table' && seg.rows) {
      drawPdfTable(doc, seg.rows, left, contentWidth, bottom);
      continue;
    }
    for (const line of htmlToLines(seg.html ?? '')) {
      doc.font('Times-Roman').fontSize(11).fillColor('#1a1a1a');
      if (line.bullet) {
        doc.text(`•  ${line.text}`, left + 14, doc.y, { width: contentWidth - 14 });
      } else {
        doc.text(line.text, left, doc.y, { width: contentWidth });
      }
      doc.moveDown(0.3);
    }
  }
  doc.fillColor('#000000');
}

/**
 * Decode a letterhead logo data URL (PNG/JPEG only — the formats docx can embed
 * as a raster ImageRun) and read its intrinsic dimensions so the export keeps
 * the logo's aspect ratio. Returns null for SVG/other/unparseable input so the
 * caller silently omits the logo rather than distorting or crashing the export.
 */
function decodeLogo(
  dataUrl: string | undefined,
): { type: 'png' | 'jpg'; data: Buffer; width: number; height: number } | null {
  if (typeof dataUrl !== 'string') return null;
  const m = /^data:image\/(png|jpe?g);base64,([a-z0-9+/=\s]+)$/i.exec(dataUrl);
  if (!m) return null;
  let data: Buffer;
  try {
    data = Buffer.from(m[2]!.replace(/\s/g, ''), 'base64');
  } catch {
    return null;
  }
  const isPng = /png/i.test(m[1]!);
  if (isPng) {
    // PNG IHDR: width @ byte 16 (BE u32), height @ byte 20.
    if (data.length < 24 || data.readUInt32BE(0) !== 0x89504e47) return null;
    return { type: 'png', data, width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
  }
  // JPEG: scan segments for a Start-Of-Frame marker carrying height/width.
  if (data.length < 4 || data[0] !== 0xff || data[1] !== 0xd8) return null;
  let off = 2;
  while (off + 9 < data.length) {
    if (data[off] !== 0xff) {
      off++;
      continue;
    }
    const marker = data[off + 1]!;
    const len = data.readUInt16BE(off + 2);
    // SOF0..SOF15 except DHT(C4)/JPG(C8)/DAC(CC) carry frame dimensions.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      const height = data.readUInt16BE(off + 5);
      const width = data.readUInt16BE(off + 7);
      if (width && height) return { type: 'jpg', data, width, height };
      return null;
    }
    off += 2 + len;
  }
  return null;
}

interface WsBlockLike {
  type?: unknown;
  content?: unknown;
  src?: unknown;
  cells?: unknown;
}

/** A packet document's stored body (Q-ED-7): `{ title?, blocks: WsBlock[] }`. */
interface PacketDocLike {
  id: string;
  name: string;
  body: unknown;
}

type Redactor = (s: string) => string;

@Injectable()
export class ExportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly collaborators: CollaboratorsService,
  ) {}

  private async loadDraft(tenantId: string, draftId: string, actorId?: string) {
    const draft = await this.prisma.wsDraft.findFirst({
      where: { id: draftId, tenantId },
      include: { documents: { orderBy: { ordinal: 'asc' } } },
    });
    if (!draft) throw new NotFoundException('Draft not found');
    // GAI-31: export streams a private draft's full content — require read
    // access (owner or active collaborator) when the controller supplies
    // actorId. Tenant scope alone is not object authorization.
    if (actorId) {
      await this.collaborators.assertCan(
        tenantId,
        draftId,
        actorId,
        canRead,
        'You do not have access to this document',
      );
    }
    return draft;
  }

  /**
   * Every draft has a "primary" WsDocument (lowest ordinal) created at draft
   * creation — but the editor treats that row as vestigial: it's excluded from
   * the tab list and its body is never read or written (the main content lives
   * in `cfg.sections`/`cfg.sectionContent` instead — see EditorPage's own
   * `sortedDocs.filter(d => d.id !== primaryDocId)`). Only documents AFTER the
   * primary (cover letter, appendix, …) are genuine packet add-ons a user
   * actually authored. Including the primary here would add a spurious
   * near-empty title page to every single combined export.
   */
  private packetDocs(draft: { documents: PacketDocLike[] }): PacketDocLike[] {
    return draft.documents.slice(1);
  }

  /**
   * Resolve the export `part` query param against this draft's packet
   * documents. `undefined`/`'all'` = everything combined; `'main'` = only the
   * draft's own sections/mainBlocks; anything else must match a packet
   * document id (a standalone export of just that document) or 404s — a typo'd
   * id must never silently fall back to exporting everything.
   */
  private resolvePart(
    draft: { documents: PacketDocLike[] },
    part: string | undefined,
  ): { mode: 'all' | 'main' | 'doc'; doc?: PacketDocLike } {
    if (part === undefined || part === 'all') return { mode: 'all' };
    if (part === 'main') return { mode: 'main' };
    const doc = this.packetDocs(draft).find((d) => d.id === part);
    if (!doc) throw new NotFoundException('Packet document not found');
    return { mode: 'doc', doc };
  }

  async buildDocx(
    tenantId: string,
    draftId: string,
    part?: string,
    actorId?: string,
  ): Promise<{ filename: string; buffer: Buffer }> {
    const draft = await this.loadDraft(tenantId, draftId, actorId);
    const resolved = this.resolvePart(draft, part);

    const cfg = draft.config as Record<string, unknown>;
    const client = (cfg.client as string | null) ?? draft.client;
    const offices = (cfg.offices as string[] | undefined) ?? [];
    const sections = (cfg.sections as string[] | undefined) ?? [];
    const content = (cfg.sectionContent as Record<string, string> | undefined) ?? {};
    const letterhead = cfg.letterhead as
      | { custom?: boolean; firmName?: string; firmAddr?: string; logoDataUrl?: string }
      | undefined;

    // Anonymize behavior honors the review modal's choices (cfg.anonymizeMap):
    //  - exportMode 'original' → export the real names even when the flag is on.
    //  - a reviewed redaction map → use the approved terms/replacements.
    //  - no map (toggle-only) → fall back to the bare client/office default.
    const anonymizeMap = cfg.anonymizeMap as
      | { redactions?: Array<{ from: string; to: string }>; exportMode?: 'anonymized' | 'original' }
      | undefined;
    const exportOriginal = anonymizeMap?.exportMode === 'original';
    const anonymize = Boolean(cfg.anonymize) && !exportOriginal;
    const redactions = anonymizeMap?.redactions ?? [];
    const redact: Redactor = (text) => {
      if (!anonymize) return text;
      if (redactions.length) return applyRedactions(text, redactions);
      return anonymizeText(text, { client, offices }).text;
    };

    const children: Array<Paragraph | Table> = [];

    if (letterhead?.custom) {
      let lhHasContent = false;
      const logo = decodeLogo(letterhead.logoDataUrl);
      if (logo) {
        const maxH = 64;
        const height = Math.min(maxH, logo.height);
        const width = Math.max(1, Math.round((logo.width / logo.height) * height));
        children.push(
          new Paragraph({
            alignment: 'center',
            children: [
              new ImageRun({ type: logo.type, data: logo.data, transformation: { width, height } }),
            ],
          }),
        );
        lhHasContent = true;
      }
      if (letterhead.firmName) {
        children.push(
          new Paragraph({
            alignment: 'center',
            children: [new TextRun({ text: letterhead.firmName, bold: true, size: 28 })],
          }),
        );
        lhHasContent = true;
      }
      if (letterhead.firmAddr) {
        children.push(
          new Paragraph({
            alignment: 'center',
            children: [new TextRun({ text: letterhead.firmAddr, size: 18, color: '666666' })],
          }),
        );
        lhHasContent = true;
      }
      if (lhHasContent) children.push(new Paragraph({ text: '' }));
    }

    const pushPacketDoc = (doc: PacketDocLike, pageBreakBefore: boolean): void => {
      const body = (doc.body ?? {}) as { title?: string; blocks?: unknown };
      const title = (body.title && body.title.trim()) || doc.name;
      children.push(
        new Paragraph({ text: redact(title), heading: HeadingLevel.TITLE, pageBreakBefore }),
      );
      const blocks = Array.isArray(body.blocks) ? (body.blocks as WsBlockLike[]) : [];
      if (blocks.length === 0) {
        children.push(
          new Paragraph({
            children: [
              new TextRun({
                text: `[${redact(title)} — not yet drafted]`,
                italics: true,
                color: '999999',
              }),
            ],
          }),
        );
      }
      for (const b of blocks) this.pushBlockDocx(children, b, redact);
    };

    const pushMain = (pageBreakBefore: boolean): void => {
      children.push(
        new Paragraph({
          text: redact(draft.docTitle),
          heading: HeadingLevel.TITLE,
          pageBreakBefore,
        }),
      );
      for (const s of sections) {
        children.push(new Paragraph({ text: redact(s), heading: HeadingLevel.HEADING_2 }));
        const body = content[s];
        if (body && body.replace(/<[^>]*>/g, '').trim()) {
          children.push(...htmlToDocxNodes(redact(body)));
        } else {
          children.push(
            new Paragraph({
              children: [
                new TextRun({
                  text: `[${redact(s)} — not yet drafted]`,
                  italics: true,
                  color: '999999',
                }),
              ],
            }),
          );
        }
      }
      const mainBlocks = (cfg.mainBlocks as WsBlockLike[] | undefined) ?? [];
      for (const b of mainBlocks) this.pushBlockDocx(children, b, redact);
    };

    if (resolved.mode === 'doc') {
      pushPacketDoc(resolved.doc!, false);
    } else if (resolved.mode === 'main') {
      pushMain(false);
    } else {
      // 'all' — combined packet: every genuine packet document (e.g. a cover
      // letter — NOT the vestigial primary row, see packetDocs()), in order,
      // THEN the draft's own sections. Previously packet documents were never
      // read at all and silently vanished from export.
      const docs = this.packetDocs(draft);
      docs.forEach((doc, i) => pushPacketDoc(doc, i > 0));
      pushMain(docs.length > 0);
    }

    const doc = new Document({ sections: [{ children }] });
    const buffer = await Packer.toBuffer(doc);
    const safeTitle = (draft.docTitle || 'document')
      .replace(/[^a-z0-9]+/gi, '-')
      .replace(/^-+|-+$/g, '')
      .toLowerCase();
    return { filename: `${safeTitle || 'document'}.docx`, buffer };
  }

  private pushBlockDocx(
    children: Array<Paragraph | Table>,
    b: WsBlockLike,
    redact: Redactor,
  ): void {
    if (b.type === 'section') {
      const html = redact(String(b.content ?? ''));
      if (html.replace(/<[^>]*>/g, '').trim()) children.push(...htmlToDocxNodes(html));
      return;
    }
    if (b.type === 'photo' || b.type === 'logo') {
      const img = decodeLogo(typeof b.src === 'string' ? b.src : undefined);
      if (img) {
        const maxH = b.type === 'logo' ? 64 : 240;
        const height = Math.min(maxH, img.height);
        const width = Math.max(1, Math.round((img.width / img.height) * height));
        children.push(
          new Paragraph({
            children: [
              new ImageRun({ type: img.type, data: img.data, transformation: { width, height } }),
            ],
          }),
        );
      }
      return;
    }
    if (b.type === 'table') {
      const cellRows = (Array.isArray(b.cells) ? (b.cells as unknown[][]) : []).filter((r) =>
        Array.isArray(r),
      );
      if (!cellRows.length) return;
      const ncols = Math.max(1, ...cellRows.map((r) => r.length));
      const tableRows = cellRows.map(
        (r, ri) =>
          new TableRow({
            children: Array.from(
              { length: ncols },
              (_, ci) =>
                new TableCell({
                  children: [
                    new Paragraph({
                      children: [
                        new TextRun({ text: redact(String(r[ci] ?? '')), bold: ri === 0 }),
                      ],
                    }),
                  ],
                }),
            ),
          }),
      );
      children.push(
        new Table({ rows: tableRows, width: { size: 100, type: WidthType.PERCENTAGE } }),
      );
      children.push(new Paragraph({ text: '' }));
    }
  }

  /**
   * Server-rendered PDF (deterministic — no headless browser, no client print).
   * Mirrors buildDocx: optional firm letterhead, packet documents + sections
   * (HTML → real prose/bullets/tables), and inserted blocks. Honors the
   * draft's anonymize choices. Uses pdfkit's built-in Times fonts.
   */
  async buildPdf(
    tenantId: string,
    draftId: string,
    part?: string,
    actorId?: string,
  ): Promise<{ filename: string; buffer: Buffer }> {
    const draft = await this.loadDraft(tenantId, draftId, actorId);
    const resolved = this.resolvePart(draft, part);

    const cfg = draft.config as Record<string, unknown>;
    const client = (cfg.client as string | null) ?? draft.client;
    const offices = (cfg.offices as string[] | undefined) ?? [];
    const sections = (cfg.sections as string[] | undefined) ?? [];
    const content = (cfg.sectionContent as Record<string, string> | undefined) ?? {};
    const letterhead = cfg.letterhead as
      | { custom?: boolean; firmName?: string; firmAddr?: string; logoDataUrl?: string }
      | undefined;

    const anonymizeMap = cfg.anonymizeMap as
      | { redactions?: Array<{ from: string; to: string }>; exportMode?: 'anonymized' | 'original' }
      | undefined;
    const exportOriginal = anonymizeMap?.exportMode === 'original';
    const anonymize = Boolean(cfg.anonymize) && !exportOriginal;
    const redactions = anonymizeMap?.redactions ?? [];
    const redact: Redactor = (t) => {
      if (!anonymize) return t;
      if (redactions.length) return applyRedactions(t, redactions);
      return anonymizeText(t, { client, offices }).text;
    };

    const doc = new PDFDocument({
      size: 'LETTER',
      margins: { top: 72, bottom: 72, left: 72, right: 72 },
      autoFirstPage: true,
    });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    const done = new Promise<Buffer>((resolve, reject) => {
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);
    });

    const left = doc.page.margins.left;
    const contentWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
    const bottom = doc.page.height - doc.page.margins.bottom;

    // Firm letterhead (only when the user opted into a custom letterhead;
    // rendered once at the top of whichever file is being generated).
    if (letterhead?.custom) {
      const logo = decodeLogo(letterhead.logoDataUrl);
      if (logo) {
        const h = Math.min(48, logo.height);
        const w = Math.max(1, Math.round((logo.width / logo.height) * h));
        try {
          doc.image(logo.data, doc.page.width / 2 - w / 2, doc.y, { width: w, height: h });
          doc.y += h + 6;
        } catch {
          /* unparseable image — skip, never crash the export */
        }
      }
      if (letterhead.firmName) {
        doc.font('Times-Bold').fontSize(14).fillColor('#111111').text(letterhead.firmName, {
          align: 'center',
        });
      }
      if (letterhead.firmAddr) {
        doc
          .font('Times-Roman')
          .fontSize(9)
          .fillColor('#666666')
          .text(letterhead.firmAddr, { align: 'center' });
      }
      doc.fillColor('#000000').moveDown(0.5);
      doc
        .moveTo(left, doc.y)
        .lineTo(left + contentWidth, doc.y)
        .lineWidth(1)
        .strokeColor('#111111')
        .stroke()
        .strokeColor('#000000');
      doc.moveDown(0.8);
    }

    const renderPacketDocPdf = (docLike: PacketDocLike, addPageFirst: boolean): void => {
      if (addPageFirst) doc.addPage();
      const body = (docLike.body ?? {}) as { title?: string; blocks?: unknown };
      const title = (body.title && body.title.trim()) || docLike.name;
      doc.font('Times-Bold').fontSize(20).fillColor('#111111').text(redact(title));
      doc.fillColor('#000000').moveDown(0.6);
      const blocks = Array.isArray(body.blocks) ? (body.blocks as WsBlockLike[]) : [];
      if (blocks.length === 0) {
        doc
          .font('Times-Italic')
          .fontSize(11)
          .fillColor('#999999')
          .text(`[${redact(title)} — not yet drafted]`);
        doc.fillColor('#000000').moveDown(0.5);
      }
      for (const b of blocks) this.renderBlockPdf(doc, b, redact, left, contentWidth, bottom);
    };

    const renderMainPdf = (addPageFirst: boolean): void => {
      if (addPageFirst) doc.addPage();
      doc.font('Times-Bold').fontSize(20).fillColor('#111111').text(redact(draft.docTitle));
      doc.fillColor('#000000').moveDown(0.6);
      for (const s of sections) {
        ensureSpace(doc, 48, bottom);
        doc.font('Times-Bold').fontSize(13).fillColor('#111111').text(redact(s));
        doc.fillColor('#000000').moveDown(0.2);
        const body = content[s];
        if (body && body.replace(/<[^>]*>/g, '').trim()) {
          renderSectionBodyPdf(doc, redact(body), left, contentWidth, bottom);
        } else {
          doc
            .font('Times-Italic')
            .fontSize(11)
            .fillColor('#999999')
            .text(`[${redact(s)} — not yet drafted]`);
          doc.fillColor('#000000');
        }
        doc.moveDown(0.5);
      }
      const mainBlocks = (cfg.mainBlocks as WsBlockLike[] | undefined) ?? [];
      for (const b of mainBlocks) this.renderBlockPdf(doc, b, redact, left, contentWidth, bottom);
    };

    if (resolved.mode === 'doc') {
      renderPacketDocPdf(resolved.doc!, false);
    } else if (resolved.mode === 'main') {
      renderMainPdf(false);
    } else {
      const docs = this.packetDocs(draft);
      docs.forEach((d, i) => renderPacketDocPdf(d, i > 0));
      renderMainPdf(docs.length > 0);
    }

    doc.end();
    const buffer = await done;
    const safeTitle = (draft.docTitle || 'document')
      .replace(/[^a-z0-9]+/gi, '-')
      .replace(/^-+|-+$/g, '')
      .toLowerCase();
    return { filename: `${safeTitle || 'document'}.pdf`, buffer };
  }

  private renderBlockPdf(
    doc: PDFKit.PDFDocument,
    b: WsBlockLike,
    redact: Redactor,
    left: number,
    contentWidth: number,
    bottom: number,
  ): void {
    if (b.type === 'section') {
      const html = redact(String(b.content ?? ''));
      if (html.replace(/<[^>]*>/g, '').trim()) {
        renderSectionBodyPdf(doc, html, left, contentWidth, bottom);
        doc.moveDown(0.5);
      }
      return;
    }
    if (b.type === 'photo' || b.type === 'logo') {
      const img = decodeLogo(typeof b.src === 'string' ? b.src : undefined);
      if (img) {
        const maxH = b.type === 'logo' ? 80 : 300;
        const ratio = Math.min(contentWidth / img.width, maxH / img.height, 1);
        const w = Math.max(1, Math.round(img.width * ratio));
        const h = Math.max(1, Math.round(img.height * ratio));
        ensureSpace(doc, h + 12, bottom);
        try {
          doc.image(img.data, left, doc.y, { width: w, height: h });
          doc.y += h + 12;
        } catch {
          /* skip unparseable image */
        }
      }
      return;
    }
    if (b.type === 'table') {
      const cellRows = (Array.isArray(b.cells) ? (b.cells as unknown[][]) : [])
        .filter((r) => Array.isArray(r))
        .map((r) => r.map((c) => redact(String(c ?? ''))));
      if (cellRows.length) drawPdfTable(doc, cellRows, left, contentWidth, bottom);
    }
  }
}
