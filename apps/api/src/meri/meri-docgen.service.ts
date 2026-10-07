/**
 * Meri document generation service.
 *
 * Turns a normalized document spec (see meri-docgen.helpers.ts) into a real
 * Office Open XML binary buffer: Word (.docx via `docx`), Excel (.xlsx via
 * `exceljs`), or PowerPoint (.pptx via `pptxgenjs`). The spec normalization /
 * validation lives in the pure helpers; this service is the thin binary layer.
 */
import { Injectable, Logger } from '@nestjs/common';
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
import * as ExcelJS from 'exceljs';
import PptxGenJS from 'pptxgenjs';
import { buildMeriPdf } from './meri-docgen-pdf.js';
import type {
  DocTable,
  ExcelSpec,
  PptxSpec,
  WordSpec,
} from './meri-docgen.helpers.js';

const CAPIRO_NAVY = '1C2E4A';

@Injectable()
export class MeriDocgenService {
  private readonly logger = new Logger(MeriDocgenService.name);

  /** Render the same canonical document content used by Word as a real PDF. */
  buildPdf(spec: WordSpec): Promise<Buffer> {
    return buildMeriPdf(spec);
  }

  /** Build a Word .docx buffer from a normalized spec. */
  async buildDocx(spec: WordSpec): Promise<Buffer> {
    const children: (Paragraph | Table)[] = [];

    children.push(
      new Paragraph({
        heading: HeadingLevel.TITLE,
        children: [new TextRun({ text: spec.title, bold: true })],
      }),
    );
    if (spec.subtitle) {
      children.push(
        new Paragraph({
          children: [new TextRun({ text: spec.subtitle, italics: true, color: '6B7280' })],
        }),
      );
    }

    for (const section of spec.sections) {
      children.push(
        new Paragraph({
          heading: HeadingLevel.HEADING_1,
          children: [new TextRun({ text: section.heading, bold: true, color: CAPIRO_NAVY })],
        }),
      );
      for (const p of section.paragraphs) {
        children.push(new Paragraph({ children: [new TextRun(p)] }));
      }
      for (const b of section.bullets) {
        children.push(new Paragraph({ text: b, bullet: { level: 0 } }));
      }
      for (const table of section.tables) {
        children.push(this.docxTable(table));
        children.push(new Paragraph({ children: [] }));
      }
      // Embedded analysis charts (F4) — resolved PNGs only.
      for (const image of section.images) {
        children.push(
          new Paragraph({
            children: [
              new ImageRun({
                type: 'png',
                data: Buffer.from(image.dataBase64, 'base64'),
                transformation: { width: 540, height: 340 },
              }),
            ],
          }),
        );
      }
    }

    const doc = new Document({ sections: [{ children }] });
    return Buffer.from(await Packer.toBuffer(doc));
  }

  private docxTable(table: DocTable): Table {
    const headerRow = new TableRow({
      tableHeader: true,
      children: table.headers.map(
        (h) =>
          new TableCell({
            shading: { fill: 'EEF1F7' },
            children: [new Paragraph({ children: [new TextRun({ text: h, bold: true })] })],
          }),
      ),
    });
    const bodyRows = table.rows.map(
      (row) =>
        new TableRow({
          children: row.map(
            (cell) => new TableCell({ children: [new Paragraph({ children: [new TextRun(cell)] })] }),
          ),
        }),
    );
    return new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      rows: [headerRow, ...bodyRows],
    });
  }

  /** Build an Excel .xlsx buffer from a normalized spec. */
  async buildXlsx(spec: ExcelSpec): Promise<Buffer> {
    const wb = new ExcelJS.Workbook();
    wb.creator = 'Meri';
    wb.created = new Date();
    for (const sheet of spec.sheets) {
      const ws = wb.addWorksheet(sheet.name);
      if (sheet.headers.length > 0) {
        const headerRow = ws.addRow(sheet.headers);
        headerRow.font = { bold: true, color: { argb: 'FF1C2E4A' } };
        headerRow.fill = {
          type: 'pattern',
          pattern: 'solid',
          fgColor: { argb: 'FFEEF1F7' },
        };
      }
      for (const row of sheet.rows) {
        ws.addRow(row.map((c) => coerceCell(c)));
      }
      // Auto-ish column widths.
      const width = Math.max(sheet.headers.length, ...sheet.rows.map((r) => r.length), 1);
      for (let c = 1; c <= width; c++) {
        const col = ws.getColumn(c);
        let max = 10;
        col.eachCell({ includeEmpty: false }, (cell) => {
          const len = String(cell.value ?? '').length;
          if (len > max) max = len;
        });
        col.width = Math.min(60, max + 2);
      }
    }
    const out = await wb.xlsx.writeBuffer();
    return Buffer.from(out as ArrayBuffer);
  }

  /** Build a PowerPoint .pptx buffer from a normalized spec. */
  async buildPptx(spec: PptxSpec): Promise<Buffer> {
    const pptx = new PptxGenJS();
    pptx.author = 'Meri';
    pptx.layout = 'LAYOUT_WIDE';

    // Title slide.
    const title = pptx.addSlide();
    title.background = { color: CAPIRO_NAVY };
    title.addText(spec.title, {
      x: 0.5,
      y: 2.2,
      w: 12,
      h: 1.2,
      fontSize: 40,
      bold: true,
      color: 'FFFFFF',
      align: 'center',
    });
    if (spec.subtitle) {
      title.addText(spec.subtitle, {
        x: 0.5,
        y: 3.5,
        w: 12,
        h: 0.8,
        fontSize: 20,
        color: 'C3CEE0',
        align: 'center',
      });
    }
    if (spec.titleNotes) title.addNotes(spec.titleNotes);

    for (const slide of spec.slides) {
      const s = pptx.addSlide();
      s.addText(slide.title, {
        x: 0.5,
        y: 0.3,
        w: 12,
        h: 0.8,
        fontSize: 28,
        bold: true,
        color: CAPIRO_NAVY,
      });
      let y = 1.3;
      if (slide.bullets.length > 0) {
        s.addText(
          slide.bullets.map((t) => ({ text: t, options: { bullet: true } })),
          {
            x: 0.7,
            y,
            w: 11.5,
            h: 4.5,
            fontSize: bulletFontSize(slide.bullets),
            color: '1A1A1A',
            valign: 'top',
          },
        );
        y += Math.min(4.5, slide.bullets.length * 0.4 + 0.5);
      }
      if (slide.table) {
        const rows = [
          slide.table.headers.map((h) => ({
            text: h,
            options: { bold: true, color: 'FFFFFF', fill: { color: CAPIRO_NAVY } },
          })),
          ...slide.table.rows.map((r) => r.map((c) => ({ text: c }))),
        ];
        s.addTable(rows, {
          x: 0.7,
          y: Math.min(y, 5),
          w: 11.5,
          fontSize: 12,
          border: { type: 'solid', pt: 1, color: 'D7DFEA' },
        });
        y += 1.5;
      }
      // Embedded analysis charts (F4) — resolved PNGs only.
      for (const image of slide.images) {
        s.addImage({
          data: `image/png;base64,${image.dataBase64}`,
          x: 1.5,
          y: Math.min(y, 4.2),
          w: 7.5,
          h: 4.6,
        });
        y += 4.8;
      }
      if (slide.notes) s.addNotes(slide.notes);
    }

    const out = (await pptx.write({ outputType: 'nodebuffer' })) as Buffer;
    return out;
  }
}

/**
 * Body text size for a slide's bullets: 16 pt fits about 700 characters in the
 * 11.5 x 4.5 inch box, 14 pt about 1,000 and 12 pt about 1,300.
 */
export function bulletFontSize(bullets: readonly string[]): number {
  const chars = bullets.reduce((sum, bullet) => sum + bullet.length, 0);
  return chars <= 700 ? 16 : chars <= 1_000 ? 14 : 12;
}

/** Coerce a string cell into a number when it cleanly parses, else keep the string. */
function coerceCell(value: string): string | number {
  if (value === '') return '';
  const cleaned = value.replace(/[$,%]/g, '').replace(/,/g, '').trim();
  if (cleaned !== '' && /^-?\d+(\.\d+)?$/.test(cleaned)) {
    const n = Number(cleaned);
    if (Number.isFinite(n)) return n;
  }
  return value;
}
