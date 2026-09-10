import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import type { PDFFont, PDFPage, RGB } from 'pdf-lib';
import type { DocTable, WordSpec } from './meri-docgen.helpers.js';

export type MeriPdfRenderFailure = 'unsupported_text' | 'document_too_large' | 'invalid_image';

/** Safe reasons that the download endpoint can turn into recoverable user errors. */
export class MeriPdfRenderError extends Error {
  constructor(
    readonly reason: MeriPdfRenderFailure,
    message: string,
  ) {
    super(message);
    this.name = 'MeriPdfRenderError';
  }
}

const PAGE_WIDTH = 612;
const PAGE_HEIGHT = 792;
const MARGIN = 48;
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2;
const TOP = PAGE_HEIGHT - MARGIN;
const BOTTOM = 54;
const CONTENT_HEIGHT = TOP - BOTTOM;
const MAX_PAGES = 250;
const MAX_TEXT_CHARACTERS = 500_000;
const MAX_TOTAL_IMAGE_BYTES = 32 * 1024 * 1024;
const MAX_IMAGE_PIXELS = 40_000_000;
const NAVY = rgb(0.11, 0.18, 0.29);
const INK = rgb(0.15, 0.18, 0.23);
const MUTED = rgb(0.4, 0.44, 0.49);
const BORDER = rgb(0.82, 0.86, 0.9);
const HEADER_FILL = rgb(0.93, 0.95, 0.97);
const ROW_FILL = rgb(0.98, 0.985, 0.99);

function tooLarge(message: string): never {
  throw new MeriPdfRenderError('document_too_large', message);
}

function displayText(value: string): string {
  return value.replace(/\r\n?/g, '\n').replace(/\t/g, '    ');
}

/** No lossy glyph substitution: callers can offer Word for unsupported scripts. */
function assertEncodable(value: string, font: PDFFont): void {
  for (const line of displayText(value).split('\n')) {
    try {
      font.encodeText(line);
    } catch {
      for (const character of line) {
        try {
          font.encodeText(character);
        } catch {
          const code = character.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0');
          throw new MeriPdfRenderError(
            'unsupported_text',
            `PDF cannot render character U+${code}. Download Word to preserve this text.`,
          );
        }
      }
      throw new MeriPdfRenderError(
        'unsupported_text',
        'PDF cannot render this text. Download Word instead.',
      );
    }
  }
}

/** Wrap words, splitting long identifiers/URLs only when a whole word cannot fit. */
function wrapText(value: string, font: PDFFont, size: number, width: number): string[] {
  const result: string[] = [];
  const spaceWidth = font.widthOfTextAtSize(' ', size);
  for (const sourceLine of displayText(value).split('\n')) {
    let line = '';
    let lineWidth = 0;
    const flush = () => {
      result.push(line.trimEnd());
      line = '';
      lineWidth = 0;
    };
    for (const token of sourceLine.match(/[^ ]+| +/g) ?? []) {
      if (token[0] === ' ') {
        if (line) {
          line += ' ';
          lineWidth += spaceWidth;
        }
        continue;
      }
      const tokenWidth = font.widthOfTextAtSize(token, size);
      if (lineWidth + tokenWidth <= width) {
        line += token;
        lineWidth += tokenWidth;
      } else if (tokenWidth <= width) {
        if (line) flush();
        line = token;
        lineWidth = tokenWidth;
      } else {
        if (line) flush();
        for (const character of token) {
          const characterWidth = font.widthOfTextAtSize(character, size);
          if (characterWidth > width)
            tooLarge('A PDF table column is too narrow. Use fewer columns or download Word.');
          if (line && lineWidth + characterWidth > width) flush();
          line += character;
          lineWidth += characterWidth;
        }
      }
    }
    // Preserve explicit paragraph line breaks, including blank lines.
    if (line || sourceLine.length === 0 || /^ +$/.test(sourceLine)) flush();
  }
  return result.length ? result : [''];
}

/** Render the same stored WordSpec used for DOCX; no second model generation. */
export async function buildMeriPdf(spec: WordSpec): Promise<Buffer> {
  const document = await PDFDocument.create();
  const regular = await document.embedFont(StandardFonts.Helvetica);
  const bold = await document.embedFont(StandardFonts.HelveticaBold);
  document.setTitle(spec.title);
  document.setAuthor('Meri');
  document.setCreator('Meri');
  document.setProducer('Meri');

  let characterCount = 0;
  const preflightText = (value: string) => {
    characterCount += value.length;
    if (characterCount > MAX_TEXT_CHARACTERS) {
      tooLarge(
        'This document exceeds the PDF text limit. Split it into smaller documents or download Word.',
      );
    }
    assertEncodable(value, regular);
    assertEncodable(value, bold);
  };
  preflightText(spec.title);
  if (spec.subtitle) preflightText(spec.subtitle);
  let imageBytes = 0;
  let imagePixels = 0;
  const images = new Map<string, Awaited<ReturnType<PDFDocument['embedPng']>>>();
  for (const section of spec.sections) {
    preflightText(section.heading);
    for (const paragraph of section.paragraphs) preflightText(paragraph);
    for (const bullet of section.bullets) preflightText(bullet);
    for (const table of section.tables) {
      for (const header of table.headers) preflightText(header);
      for (const row of table.rows) for (const cell of row) preflightText(cell);
    }
    for (const image of section.images) {
      if (images.has(image.dataBase64)) continue;
      // Buffer.from(base64) is permissive, so reject malformed encodings first.
      if (!/^[A-Za-z0-9+/]+={0,2}$/.test(image.dataBase64) || image.dataBase64.length % 4 !== 0) {
        throw new MeriPdfRenderError(
          'invalid_image',
          'A saved chart image is invalid. Regenerate the chart and try again.',
        );
      }
      const bytes = Buffer.from(image.dataBase64, 'base64');
      imageBytes += bytes.length;
      if (imageBytes > MAX_TOTAL_IMAGE_BYTES) {
        tooLarge('This document exceeds the PDF image limit. Split it into smaller documents.');
      }
      if (
        bytes.length < 24 ||
        !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
        bytes.toString('ascii', 12, 16) !== 'IHDR'
      ) {
        throw new MeriPdfRenderError(
          'invalid_image',
          'A saved chart is not a valid PNG. Regenerate the chart and try again.',
        );
      }
      const width = bytes.readUInt32BE(16);
      const height = bytes.readUInt32BE(20);
      imagePixels += width * height;
      if (!width || !height || imagePixels > MAX_IMAGE_PIXELS) {
        tooLarge('A saved chart exceeds the PDF image dimensions. Regenerate a smaller chart.');
      }
      try {
        images.set(image.dataBase64, await document.embedPng(bytes));
      } catch {
        throw new MeriPdfRenderError(
          'invalid_image',
          'A saved chart image cannot be read. Regenerate the chart and try again.',
        );
      }
    }
  }

  let page: PDFPage = document.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
  let y = TOP;
  const newPage = () => {
    if (document.getPageCount() >= MAX_PAGES) {
      tooLarge(
        `This document exceeds ${MAX_PAGES} PDF pages. Split it into smaller documents or download Word.`,
      );
    }
    page = document.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
    y = TOP;
  };
  const ensureSpace = (height: number) => {
    if (height > CONTENT_HEIGHT)
      tooLarge('A PDF block is too large for a page. Simplify the document or download Word.');
    if (y - height < BOTTOM) newPage();
  };
  const drawLines = (
    lines: string[],
    font: PDFFont,
    size: number,
    lineHeight: number,
    color: RGB,
    indent = 0,
    bullet = false,
  ) => {
    for (let index = 0; index < lines.length; index += 1) {
      ensureSpace(lineHeight);
      if (bullet && index === 0) {
        page.drawText('\u2022', { x: MARGIN + 2, y: y - size, size, font: regular, color });
      }
      page.drawText(lines[index]!, { x: MARGIN + indent, y: y - size, size, font, color });
      y -= lineHeight;
    }
  };

  drawLines(wrapText(spec.title, bold, 22, CONTENT_WIDTH), bold, 22, 27, NAVY);
  y -= 5;
  if (spec.subtitle) {
    drawLines(wrapText(spec.subtitle, regular, 10, CONTENT_WIDTH), regular, 10, 14, MUTED);
    y -= 6;
  }
  y -= 8;

  const drawTable = (table: DocTable) => {
    if (table.headers.length === 0) return;
    const size = table.headers.length > 8 ? 8 : 9;
    const lineHeight = size * 1.35;
    const padding = 5;
    const columnWidth = CONTENT_WIDTH / table.headers.length;
    const headerLines = table.headers.map((text) =>
      wrapText(text, bold, size, columnWidth - padding * 2),
    );
    const headerHeight =
      Math.max(...headerLines.map((lines) => lines.length)) * lineHeight + padding * 2;
    const minimumRowHeight = lineHeight + padding * 2;
    if (headerHeight + minimumRowHeight > CONTENT_HEIGHT) {
      tooLarge('A PDF table header is too tall. Shorten its labels or download Word.');
    }

    const drawCells = (cells: string[][], height: number, isHeader: boolean, alternate = false) => {
      for (let column = 0; column < table.headers.length; column += 1) {
        const x = MARGIN + column * columnWidth;
        page.drawRectangle({
          x,
          y: y - height,
          width: columnWidth,
          height,
          borderWidth: 0.5,
          borderColor: BORDER,
          color: isHeader ? HEADER_FILL : alternate ? ROW_FILL : rgb(1, 1, 1),
        });
        for (let line = 0; line < (cells[column]?.length ?? 0); line += 1) {
          page.drawText(cells[column]![line]!, {
            x: x + padding,
            y: y - padding - size - line * lineHeight,
            font: isHeader ? bold : regular,
            size,
            color: isHeader ? NAVY : INK,
          });
        }
      }
      y -= height;
    };
    const drawHeader = () => drawCells(headerLines, headerHeight, true);
    ensureSpace(headerHeight + (table.rows.length ? minimumRowHeight : 0));
    drawHeader();

    for (let rowIndex = 0; rowIndex < table.rows.length; rowIndex += 1) {
      const row = table.rows[rowIndex]!;
      const cells = table.headers.map((_, column) =>
        wrapText(row[column] ?? '', regular, size, columnWidth - padding * 2),
      );
      const totalLines = Math.max(...cells.map((lines) => lines.length));
      const fullRowHeight = totalLines * lineHeight + padding * 2;
      // Keep normal rows together; only split a row when it cannot fit on a fresh page.
      if (fullRowHeight <= CONTENT_HEIGHT - headerHeight && y - fullRowHeight < BOTTOM) {
        newPage();
        drawHeader();
      }
      let offset = 0;
      while (offset < totalLines) {
        let availableLines = Math.floor((y - BOTTOM - padding * 2 + 1e-6) / lineHeight);
        if (availableLines < 1) {
          newPage();
          drawHeader();
          availableLines = Math.floor((y - BOTTOM - padding * 2 + 1e-6) / lineHeight);
        }
        const count = Math.min(totalLines - offset, availableLines);
        drawCells(
          cells.map((lines) => lines.slice(offset, offset + count)),
          count * lineHeight + padding * 2,
          false,
          rowIndex % 2 === 1,
        );
        offset += count;
        if (offset < totalLines) {
          newPage();
          drawHeader();
        }
      }
    }
    y -= 10;
  };

  for (const section of spec.sections) {
    const heading = wrapText(section.heading, bold, 13, CONTENT_WIDTH);
    ensureSpace(heading.length * 17 + 20);
    drawLines(heading, bold, 13, 17, NAVY);
    y -= 5;
    for (const paragraph of section.paragraphs) {
      drawLines(wrapText(paragraph, regular, 10.5, CONTENT_WIDTH), regular, 10.5, 14.5, INK);
      y -= 7;
    }
    for (const bullet of section.bullets) {
      drawLines(
        wrapText(bullet, regular, 10.5, CONTENT_WIDTH - 15),
        regular,
        10.5,
        14.5,
        INK,
        15,
        true,
      );
      y -= 4;
    }
    if (section.bullets.length) y -= 3;
    for (const table of section.tables) drawTable(table);
    for (const saved of section.images) {
      const image = images.get(saved.dataBase64)!;
      const scale = Math.min(CONTENT_WIDTH / image.width, CONTENT_HEIGHT / image.height, 1);
      const width = image.width * scale;
      const height = image.height * scale;
      ensureSpace(height);
      page.drawImage(image, {
        x: MARGIN + (CONTENT_WIDTH - width) / 2,
        y: y - height,
        width,
        height,
      });
      y -= height + 10;
    }
    y -= 8;
  }

  const pages = document.getPages();
  for (let index = 0; index < pages.length; index += 1) {
    const current = pages[index]!;
    current.drawLine({
      start: { x: MARGIN, y: 40 },
      end: { x: PAGE_WIDTH - MARGIN, y: 40 },
      color: BORDER,
      thickness: 0.5,
    });
    current.drawText('Prepared with Meri', {
      x: MARGIN,
      y: 27,
      font: regular,
      size: 8,
      color: MUTED,
    });
    const label = `${index + 1} / ${pages.length}`;
    current.drawText(label, {
      x: PAGE_WIDTH - MARGIN - regular.widthOfTextAtSize(label, 8),
      y: 27,
      font: regular,
      size: 8,
      color: MUTED,
    });
  }
  return Buffer.from(await document.save());
}
