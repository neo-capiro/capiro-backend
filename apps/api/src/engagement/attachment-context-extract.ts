import { BadRequestException } from '@nestjs/common';
import { posix } from 'node:path';
import { XMLParser } from 'fast-xml-parser';
import { PDFDict, PDFDocument, PDFName, PDFRawStream } from 'pdf-lib';
import type { ResolvedAiCredential } from '../ai-credentials/ai-credential-resolver.service.js';
import { AttachmentContentService, isPdfAttachment } from './attachment-content.service.js';
import type { AttachmentPdfVisionReader } from './attachment-pdf-vision.js';
import { collectTextRuns, isPowerPointAttachment } from './pptx-extract.js';
import { isSpreadsheetAttachment, xlsxCellToText } from './xlsx-extract.js';
import {
  MAX_EXTRACTED_CHARS,
  MAX_EXTRACTION_PAGES,
  MAX_SPREADSHEET_COLS,
  MAX_SPREADSHEET_ROWS,
} from './generation/evidence-packet.types.js';

export interface ContextSourceSection {
  ref: string;
  label: string;
  text: string;
}

export interface ContextAttachmentText {
  text: string;
  sections: ContextSourceSection[];
  truncated: boolean;
  warnings: string[];
  extractionMetadata: {
    chars: number;
    sectionsRead: number;
    visualPagesRead: number;
    maxChars: number;
    maxPages: number;
  };
}

/** Check inherited page/form resources without rendering images. A selectable
 * header does not establish that a page's scanned body has been read. */
function resourceHasImages(resources: PDFDict | undefined, depth = 0): boolean {
  if (!resources) return false;
  if (depth >= 8) return true; // An unusually nested form needs visual review.
  const objects = resources.lookupMaybe(PDFName.of('XObject'), PDFDict);
  if (!objects) return false;
  for (const key of objects.keys()) {
    const object = objects.lookup(key);
    if (!(object instanceof PDFRawStream)) continue;
    const kind = object.dict.get(PDFName.of('Subtype'))?.toString();
    if (kind === '/Image') return true;
    if (
      kind === '/Form' &&
      resourceHasImages(object.dict.lookupMaybe(PDFName.of('Resources'), PDFDict), depth + 1)
    )
      return true;
  }
  return false;
}

/** Context imports use the same stored attachment, authorization, parser helpers,
 * and tenant-selected visual reader as document inspection. The returned refs
 * identify original pages/slides/sheets; the model cannot invent source refs. */
export async function extractAttachmentContext(input: {
  bytes: Buffer;
  fileName: string;
  contentType: string;
  cacheScope: string;
  content: AttachmentContentService;
  vision: AttachmentPdfVisionReader;
  resolveCredential: () => Promise<ResolvedAiCredential | null>;
  signal?: AbortSignal;
}): Promise<ContextAttachmentText> {
  const { bytes, fileName, content, vision } = input;
  const contentType = input.contentType.split(';')[0]!.trim().toLowerCase();
  const sections: ContextSourceSection[] = [];
  const warnings: string[] = [];
  let chars = 0;
  let truncated = false;
  let visualPagesRead = 0;
  let visualUnavailable = false;
  const visualDeadline = Date.now() + 45_000;
  const warn = (message: string) => {
    truncated = true;
    if (!warnings.includes(message)) warnings.push(message);
  };
  const add = (ref: string, label: string, value: string) => {
    const text = value.trim();
    if (!text) return;
    const available = MAX_EXTRACTED_CHARS - chars;
    if (text.length > available)
      warn(
        'This file contains more text than can be read in one import. Split it into smaller files to include the remaining content.',
      );
    const included = text.slice(0, Math.max(0, available));
    if (included) {
      sections.push({ ref, label, text: included });
      chars += included.length;
    }
  };
  const readVisual = async (pdf: Buffer, page: number, count: number) => {
    input.signal?.throwIfAborted();
    if (visualUnavailable || visualPagesRead >= 4 || Date.now() >= visualDeadline) {
      warn(
        'Some scanned pages could not be read within this import. Upload those pages separately or use a PDF with selectable text.',
      );
      return '';
    }
    visualPagesRead += 1;
    const controller = new AbortController();
    const abort = () => controller.abort();
    input.signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, Math.max(1, visualDeadline - Date.now()));
    try {
      const result = await vision.read({
        bytes: pdf,
        cacheScope: input.cacheScope,
        section: page,
        sectionCount: count,
        resolveCredential: input.resolveCredential,
        signal: controller.signal,
      });
      if (result.readability.status === 'ocr_unavailable') {
        visualUnavailable = true;
        warn(
          'Visual reading is unavailable for this file. Add a searchable PDF or paste the missing text.',
        );
      } else if (result.readability.status === 'ocr_partial' || !result.text.trim()) {
        warn(
          `Page ${page} has unreadable content. Check the original and add any missing information.`,
        );
      }
      return result.text;
    } catch {
      input.signal?.throwIfAborted();
      visualUnavailable = true;
      warn(
        'Visual reading did not finish. Add a searchable PDF or upload the unread pages separately.',
      );
      return '';
    } finally {
      clearTimeout(timer);
      input.signal?.removeEventListener('abort', abort);
    }
  };

  input.signal?.throwIfAborted();
  if (/\.(ppt|xls)$/i.test(fileName)) {
    throw new BadRequestException(
      'This older Office format needs conversion. Save the file as PowerPoint (.pptx), Excel (.xlsx), or PDF and upload it again.',
    );
  }
  try {
    if (contentType.startsWith('image/')) {
      const detected = content.detectContentType(bytes);
      if (detected !== 'image/png' && detected !== 'image/jpeg') {
        throw new BadRequestException(
          'For image documents, upload a PNG or JPG, or save the image as a PDF.',
        );
      }
      if (bytes.length > 5 * 1024 * 1024) {
        throw new BadRequestException(
          'Image documents must be 5 MB or smaller. Resize the image or save it as a searchable PDF.',
        );
      }
      const pdf = await PDFDocument.create();
      const raster =
        detected === 'image/png' ? await pdf.embedPng(bytes) : await pdf.embedJpg(bytes);
      const scale = Math.min(1, 2000 / Math.max(raster.width, raster.height));
      const page = pdf.addPage([raster.width * scale, raster.height * scale]);
      page.drawImage(raster, { x: 0, y: 0, width: page.getWidth(), height: page.getHeight() });
      add('image:1', 'Image', await readVisual(Buffer.from(await pdf.save()), 1, 1));
    } else if (isPdfAttachment(fileName, contentType)) {
      const { PDFParse } = await import('pdf-parse');
      const parser = new PDFParse({ data: bytes });
      try {
        const info = await parser.getInfo();
        const pageCount = Math.min(info.total, MAX_EXTRACTION_PAGES);
        if (info.total > pageCount)
          warn(
            `Only the first ${pageCount} pages were read. Upload the remaining pages separately.`,
          );
        const parsed = await parser.getText({
          partial: Array.from({ length: pageCount }, (_, index) => index + 1),
          pageJoiner: '',
        });
        const imagePages = new Set<number>();
        let imagesChecked = false;
        try {
          const document = await PDFDocument.load(bytes);
          for (const [index, page] of document.getPages().slice(0, pageCount).entries()) {
            if (resourceHasImages(page.node.Resources())) imagePages.add(index + 1);
          }
          imagesChecked = true;
        } catch {
          warn(
            'This PDF could not be checked for embedded scanned content. Review the original for information missing from its selectable text.',
          );
        }
        for (let page = 1; page <= pageCount; page += 1) {
          input.signal?.throwIfAborted();
          if (chars >= MAX_EXTRACTED_CHARS) {
            warn(
              'This file contains more text than can be read in one import. Split it into smaller files to include the remaining content.',
            );
            break;
          }
          const native = parsed.pages.find((value) => value.num === page)?.text ?? '';
          const requiresVisual =
            !native.trim() || imagePages.has(page) || (!imagesChecked && native.trim().length < 80);
          const visual = requiresVisual ? await readVisual(bytes, page, info.total) : '';
          // Keep the exact native text even when visual reading is incomplete
          // or unavailable; successful OCR adds the scanned body to that page.
          const text =
            native.trim() && visual.trim()
              ? `${native.trim()}\n\n[Visual reading]\n${visual.trim()}`
              : native.trim() || visual;
          add(`page:${page}`, `Page ${page}`, text);
        }
      } finally {
        await parser.destroy().catch(() => {});
      }
    } else if (isPowerPointAttachment(fileName, contentType)) {
      const { default: JSZip } = await import('jszip');
      const zip = await JSZip.loadAsync(bytes);
      let paths = Object.keys(zip.files)
        .filter((path) => /^ppt\/slides\/slide\d+\.xml$/i.test(path))
        .sort(
          (a, b) =>
            Number(/slide(\d+)\.xml$/i.exec(a)?.[1]) - Number(/slide(\d+)\.xml$/i.exec(b)?.[1]),
        );
      // OOXML part numbers are not the visible slide order after a user moves
      // slides. Resolve the presentation relationship order for honest labels.
      const presentation = zip.file('ppt/presentation.xml');
      const relationships = zip.file('ppt/_rels/presentation.xml.rels');
      if (presentation && relationships) {
        const manifestParser = new XMLParser({
          ignoreAttributes: false,
          attributeNamePrefix: '',
          parseTagValue: false,
        });
        const manifest = manifestParser.parse(await presentation.async('string'));
        const rels = manifestParser.parse(await relationships.async('string'));
        const asArray = (value: unknown): Array<Record<string, string>> =>
          !value ? [] : ((Array.isArray(value) ? value : [value]) as Array<Record<string, string>>);
        const targets = new Map(
          asArray(rels.Relationships?.Relationship)
            .filter((rel) => rel.TargetMode !== 'External')
            .map((rel) => [rel.Id, rel.Target?.replace(/^\/?ppt\//, '').replace(/^\.\//, '')]),
        );
        const ordered = asArray(manifest['p:presentation']?.['p:sldIdLst']?.['p:sldId']).map(
          (slide) => `ppt/${targets.get(slide['r:id']) ?? ''}`,
        );
        if (ordered.length && ordered.every((path) => paths.includes(path))) paths = ordered;
        else
          warn(
            'The presentation slide order could not be verified. Check slide references against the original.',
          );
      }
      const parser = new XMLParser({
        ignoreAttributes: true,
        parseTagValue: false,
        trimValues: true,
      });
      if (paths.length > MAX_EXTRACTION_PAGES)
        warn(
          `Only the first ${MAX_EXTRACTION_PAGES} slides were read. Upload the remaining slides separately.`,
        );
      for (const [index, path] of paths.slice(0, MAX_EXTRACTION_PAGES).entries()) {
        input.signal?.throwIfAborted();
        const runs: string[] = [];
        const slideXml = await zip.file(path)!.async('string');
        collectTextRuns(parser.parse(slideXml), runs);
        const slideRels = zip.file(`${posix.dirname(path)}/_rels/${posix.basename(path)}.rels`);
        if (slideRels) {
          const relParser = new XMLParser({
            ignoreAttributes: false,
            attributeNamePrefix: '',
            parseTagValue: false,
          });
          const raw = relParser.parse(await slideRels.async('string')).Relationships?.Relationship;
          const rels = (Array.isArray(raw) ? raw : raw ? [raw] : []) as Array<
            Record<string, string>
          >;
          const notesRel = rels.find(
            (rel) => rel.Type?.endsWith('/notesSlide') && rel.TargetMode !== 'External',
          );
          const notesPath = notesRel?.Target
            ? posix.normalize(posix.join(posix.dirname(path), notesRel.Target))
            : '';
          const notesFile = /^ppt\/notesSlides\/notesSlide\d+\.xml$/i.test(notesPath)
            ? zip.file(notesPath)
            : null;
          if (notesRel && !notesFile)
            warn(
              `Speaker notes for slide ${index + 1} could not be read. Check the original and add any missing information.`,
            );
          if (notesFile) {
            const notesRuns: string[] = [];
            collectTextRuns(parser.parse(await notesFile.async('string')), notesRuns);
            if (notesRuns.some((run) => run.trim())) runs.push('[Speaker notes]', ...notesRuns);
          }
        }
        if (/<p:pic\b|<a:graphicData\b/.test(slideXml)) {
          warn(
            `Slide ${index + 1} contains an image, diagram, or chart that is not fully represented by its text. Add a PDF or image for any material information in it.`,
          );
        }
        add(`slide:${index + 1}`, `Slide ${index + 1}`, runs.join('\n'));
        if (!runs.some((run) => run.trim()))
          warn(
            `Slide ${index + 1} has no readable text. If it contains an image or chart, export it to PDF or upload an image of the slide.`,
          );
        if (chars >= MAX_EXTRACTED_CHARS) {
          if (index + 1 < paths.length)
            warn(
              'Additional slides were not read because this file reached the text limit. Split the presentation into smaller files.',
            );
          break;
        }
      }
    } else if (isSpreadsheetAttachment(fileName, contentType)) {
      const ExcelJS = await import('exceljs');
      const workbook = new (ExcelJS.default ?? ExcelJS).Workbook();
      await workbook.xlsx.load(bytes as unknown as Parameters<typeof workbook.xlsx.load>[0]);
      const { default: JSZip } = await import('jszip');
      const zip = await JSZip.loadAsync(bytes);
      if (
        Object.keys(zip.files).some(
          (path) => /^xl\/(charts|media)\//.test(path) && !zip.files[path]?.dir,
        )
      ) {
        warn(
          'This spreadsheet contains images or charts that are not fully represented by its cell values. Add a PDF or image for material information in them.',
        );
      }
      let rowsRead = 0;
      for (const [sheetIndex, sheet] of workbook.worksheets.entries()) {
        for (let start = 1; start <= sheet.rowCount; start += 1000) {
          input.signal?.throwIfAborted();
          if (rowsRead >= MAX_SPREADSHEET_ROWS || chars >= MAX_EXTRACTED_CHARS) {
            warn(
              'Some spreadsheet rows were not read because the file reached the import limit. Split the workbook into smaller files.',
            );
            break;
          }
          const end = Math.min(
            start + 999,
            sheet.rowCount,
            start + MAX_SPREADSHEET_ROWS - rowsRead - 1,
          );
          const rows: string[] = [];
          for (let number = start; number <= end; number += 1) {
            const cells: string[] = [];
            sheet.getRow(number).eachCell({ includeEmpty: false }, (cell, col) => {
              if (col > MAX_SPREADSHEET_COLS) {
                warn(
                  `Only the first ${MAX_SPREADSHEET_COLS} columns were read. Move important later columns into a smaller file.`,
                );
              } else {
                const text = xlsxCellToText(cell.value);
                if (text.trim()) cells.push(`${col}:${text}`);
                if (
                  cell.value &&
                  typeof cell.value === 'object' &&
                  'formula' in cell.value &&
                  !('result' in cell.value)
                ) {
                  warn(
                    'Some formulas have no saved result. Recalculate and save the workbook before importing those values.',
                  );
                }
              }
            });
            if (cells.length) rows.push(`Row ${number}\t${cells.join('\t')}`);
          }
          rowsRead += end - start + 1;
          add(
            `sheet:${sheetIndex + 1}:rows:${start}-${end}`,
            `${sheet.name}, rows ${start}–${end}`,
            rows.join('\n'),
          );
        }
      }
    } else {
      if (!content.isExtractableDocument(fileName, contentType)) {
        throw new BadRequestException(
          'Upload a PDF, Word document (.doc or .docx), PowerPoint (.pptx), Excel workbook (.xlsx), CSV, text file, PNG, or JPG. For other formats, save a PDF or paste the text.',
        );
      }
      const result = await content.extractBounded(bytes, fileName, contentType);
      if (result.metadata.truncated)
        warn(
          'Only part of this file was read. Split it into smaller files to include the remaining content.',
        );
      add('document:1', 'Document text', result.text);
      if (result.source === 'docx' && /\.docx$/i.test(fileName)) {
        const { default: JSZip } = await import('jszip');
        const zip = await JSZip.loadAsync(bytes);
        if (
          Object.keys(zip.files).some(
            (path) => /^word\/(media|charts)\//.test(path) && !zip.files[path]?.dir,
          )
        ) {
          warn(
            'This Word document contains images or charts that are not fully represented by its text. Add a PDF or image for material information in them.',
          );
        }
      }
    }
  } catch (error) {
    input.signal?.throwIfAborted();
    if (error instanceof BadRequestException) throw error;
    throw new BadRequestException(
      'This file could not be read. It may be damaged or password-protected. Save an unlocked PDF or a new copy and try again.',
    );
  }
  if (!sections.length) {
    throw new BadRequestException(
      warnings[0] ??
        'No readable text was found. Upload a searchable PDF, clear PNG or JPG, or paste the text.',
    );
  }
  if (visualPagesRead > 0) {
    warnings.push(
      'Some content was read from an image. Check important names, amounts, dates, and quotations against the original; visual diagrams may need your review.',
    );
  }
  return {
    text: sections.map((section) => `[${section.label}]\n${section.text}`).join('\n\n'),
    sections,
    truncated,
    warnings,
    extractionMetadata: {
      chars,
      sectionsRead: sections.length,
      visualPagesRead,
      maxChars: MAX_EXTRACTED_CHARS,
      maxPages: MAX_EXTRACTION_PAGES,
    },
  };
}
