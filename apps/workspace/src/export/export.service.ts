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
import { anonymizeText, applyRedactions } from '../generation/anonymize.js';

/** Decode the handful of HTML entities our sanitized section HTML can contain. */
function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&mdash;/g, '—')
    .replace(/&ndash;/g, '–');
}

/**
 * Convert a sanitized section-HTML body into clean text lines for a flat
 * renderer (PDF / DOCX). Block tags become line breaks, <li> becomes a bullet,
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

/**
 * Document export (Phase 7). Renders a draft to a .docx via the `docx` library
 * (MIT — already a vetted dependency in apps/api). PDF export is done
 * client-side via the browser print pipeline (a print stylesheet on the
 * Preview canvas), so no headless-Chrome dependency is added server-side.
 *
 * Honors the draft's anonymize flag: client/office names are stripped from the
 * exported text exactly as they are in generation/preview.
 */
@Injectable()
export class ExportService {
  constructor(private readonly prisma: PrismaService) {}

  async buildDocx(
    tenantId: string,
    draftId: string,
  ): Promise<{ filename: string; buffer: Buffer }> {
    const draft = await this.prisma.wsDraft.findFirst({ where: { id: draftId, tenantId } });
    if (!draft) throw new NotFoundException('Draft not found');

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
    // Per-term scope='this' is applied document-wide here (the export has no
    // per-mention offset to target): over-redacting is the fail-safe direction —
    // it never leaks a name the user approved for redaction.
    const anonymizeMap = cfg.anonymizeMap as
      | { redactions?: Array<{ from: string; to: string }>; exportMode?: 'anonymized' | 'original' }
      | undefined;
    const exportOriginal = anonymizeMap?.exportMode === 'original';
    const anonymize = Boolean(cfg.anonymize) && !exportOriginal;
    const redactions = anonymizeMap?.redactions ?? [];

    const redact = (text: string): string => {
      if (!anonymize) return text;
      if (redactions.length) return applyRedactions(text, redactions);
      return anonymizeText(text, { client, offices }).text;
    };

    const children: Array<Paragraph | Table> = [];

    if (letterhead?.custom) {
      let lhHasContent = false;

      // Branded logo (PNG/JPEG). Scaled to a max 64pt height, aspect preserved;
      // SVG/unparseable logos are silently skipped (export must never crash).
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

    children.push(new Paragraph({ text: redact(draft.docTitle), heading: HeadingLevel.TITLE }));

    for (const s of sections) {
      children.push(new Paragraph({ text: redact(s), heading: HeadingLevel.HEADING_2 }));
      const body = content[s];
      if (body) {
        for (const para of redact(body).split(/\n{2,}/)) {
          children.push(new Paragraph({ children: [new TextRun(para.trim())] }));
        }
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

    // Inserted media blocks (photo / table / logo) — match the editor + preview,
    // which render cfg.mainBlocks after the prose. Without this they were dropped
    // from the .docx entirely.
    const blocks = (cfg.mainBlocks as Array<Record<string, unknown>> | undefined) ?? [];
    for (const b of blocks) {
      const type = b.type;
      if (type === 'photo' || type === 'logo') {
        const img = decodeLogo(typeof b.src === 'string' ? b.src : undefined);
        if (img) {
          const maxH = type === 'logo' ? 64 : 240;
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
      } else if (type === 'table') {
        const cellRows = (Array.isArray(b.cells) ? (b.cells as unknown[][]) : []).filter((r) =>
          Array.isArray(r),
        );
        if (cellRows.length) {
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
    }

    const doc = new Document({ sections: [{ children }] });
    const buffer = await Packer.toBuffer(doc);
    const safeTitle = (draft.docTitle || 'document')
      .replace(/[^a-z0-9]+/gi, '-')
      .replace(/^-+|-+$/g, '')
      .toLowerCase();
    return { filename: `${safeTitle || 'document'}.docx`, buffer };
  }

  /**
   * Server-rendered PDF (deterministic — no headless browser, no client print).
   * Mirrors buildDocx: optional firm letterhead, title, sections (HTML → clean
   * prose/bullets), and inserted blocks (tables + images). Honors the draft's
   * anonymize choices. Uses pdfkit's built-in Times fonts for a professional look.
   */
  async buildPdf(tenantId: string, draftId: string): Promise<{ filename: string; buffer: Buffer }> {
    const draft = await this.prisma.wsDraft.findFirst({ where: { id: draftId, tenantId } });
    if (!draft) throw new NotFoundException('Draft not found');

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
    const redact = (t: string): string => {
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

    // Firm letterhead (only when the user opted into a custom letterhead).
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

    // Title.
    doc.font('Times-Bold').fontSize(20).fillColor('#111111').text(redact(draft.docTitle));
    doc.fillColor('#000000').moveDown(0.6);

    // Sections.
    for (const s of sections) {
      ensureSpace(doc, 48, bottom);
      doc.font('Times-Bold').fontSize(13).fillColor('#111111').text(redact(s));
      doc.fillColor('#000000').moveDown(0.2);
      const body = content[s];
      if (body && body.replace(/<[^>]*>/g, '').trim()) {
        for (const line of htmlToLines(redact(body))) {
          doc.font('Times-Roman').fontSize(11).fillColor('#1a1a1a');
          if (line.bullet) {
            doc.text(`•  ${line.text}`, left + 14, doc.y, { width: contentWidth - 14 });
          } else {
            doc.text(line.text, left, doc.y, { width: contentWidth });
          }
          doc.moveDown(0.3);
        }
        doc.fillColor('#000000');
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

    // Inserted media blocks (photo / table / logo) — match the editor + preview.
    const blocks = (cfg.mainBlocks as Array<Record<string, unknown>> | undefined) ?? [];
    for (const b of blocks) {
      const type = b.type;
      if (type === 'photo' || type === 'logo') {
        const img = decodeLogo(typeof b.src === 'string' ? b.src : undefined);
        if (img) {
          const maxH = type === 'logo' ? 80 : 300;
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
      } else if (type === 'table') {
        const cellRows = (Array.isArray(b.cells) ? (b.cells as unknown[][]) : [])
          .filter((r) => Array.isArray(r))
          .map((r) => r.map((c) => redact(String(c ?? ''))));
        if (cellRows.length) drawPdfTable(doc, cellRows, left, contentWidth, bottom);
      }
    }

    doc.end();
    const buffer = await done;
    const safeTitle = (draft.docTitle || 'document')
      .replace(/[^a-z0-9]+/gi, '-')
      .replace(/^-+|-+$/g, '')
      .toLowerCase();
    return { filename: `${safeTitle || 'document'}.pdf`, buffer };
  }
}
