/// <reference path="../types/word-extractor.d.ts" />
import { BadRequestException } from '@nestjs/common';
import mammoth from 'mammoth';
import WordExtractor from 'word-extractor';
import { XMLParser } from 'fast-xml-parser';
import { xlsxCellToText } from './xlsx-extract.js';
import { collectTextRuns } from './pptx-extract.js';

export interface AttachmentTextSection {
  source: 'text' | 'docx' | 'pdf' | 'spreadsheet' | 'pptx';
  text: string;
  section: number;
  sectionCount: number;
  sectionKind: 'document' | 'page' | 'slide' | 'sheet_rows';
  sectionLabel: string;
  rowStart?: number;
  rowEnd?: number;
}

/** Extract one navigable section. Every section remains reachable; response
 * character limits are applied after extraction and return a continuation.
 * Existing bounded summary extraction is intentionally unchanged. */
export async function extractAttachmentSection(
  bytes: Buffer,
  source: AttachmentTextSection['source'],
  section: number,
  legacyWord = false,
  signal?: AbortSignal,
): Promise<AttachmentTextSection> {
  signal?.throwIfAborted();
  const check = (count: number) => {
    if (!Number.isSafeInteger(section) || section < 1 || section > Math.max(1, count)) {
      throw new BadRequestException(`section must be between 1 and ${Math.max(1, count)}`);
    }
  };
  if (source === 'pdf') {
    const { PDFParse } = await import('pdf-parse');
    const parser = new PDFParse({ data: bytes });
    try {
      const info = await parser.getInfo();
      signal?.throwIfAborted();
      check(info.total);
      const parsed = await parser.getText({ partial: [section], pageJoiner: '' });
      signal?.throwIfAborted();
      const page = parsed.pages.find((value) => value.num === section);
      return {
        source,
        text: page?.text ?? '',
        section,
        sectionCount: info.total,
        sectionKind: 'page',
        sectionLabel: `Page ${section}`,
      };
    } finally {
      await parser.destroy().catch(() => {});
    }
  }
  if (source === 'spreadsheet') {
    const ExcelJS = await import('exceljs');
    const workbook = new (ExcelJS.default ?? ExcelJS).Workbook();
    await workbook.xlsx.load(bytes as unknown as Parameters<typeof workbook.xlsx.load>[0]);
    signal?.throwIfAborted();
    // Each section is an exact range of actual Excel row numbers. Unlike the
    // summary exporter, later rows and sheets are never silently discarded.
    const ranges: Array<{
      sheet: (typeof workbook.worksheets)[number];
      start: number;
      end: number;
    }> = [];
    for (const sheet of workbook.worksheets) {
      for (let start = 1; start <= Math.max(1, sheet.rowCount); start += 1000) {
        ranges.push({ sheet, start, end: Math.min(start + 999, sheet.rowCount) });
      }
    }
    check(ranges.length);
    const range = ranges[section - 1];
    const rows: string[] = [];
    if (range)
      for (let number = range.start; number <= range.end; number += 1) {
        signal?.throwIfAborted();
        const cells: string[] = [];
        range.sheet.getRow(number).eachCell({ includeEmpty: false }, (cell, col) => {
          cells.push(`${col}:${xlsxCellToText(cell.value)}`);
        });
        if (cells.length) rows.push(`Row ${number}\t${cells.join('\t')}`);
      }
    return {
      source,
      text: rows.join('\n'),
      section,
      sectionCount: Math.max(1, ranges.length),
      sectionKind: 'sheet_rows',
      sectionLabel: range?.sheet.name ?? 'Empty workbook',
      rowStart: range?.start ?? 0,
      rowEnd: range?.end ?? 0,
    };
  }
  if (source === 'pptx') {
    const { default: JSZip } = await import('jszip');
    const zip = await JSZip.loadAsync(bytes);
    signal?.throwIfAborted();
    const paths = Object.keys(zip.files)
      .filter((path) => /^ppt\/slides\/slide\d+\.xml$/i.test(path))
      .sort(
        (a, b) =>
          Number(/slide(\d+)\.xml$/i.exec(a)?.[1]) - Number(/slide(\d+)\.xml$/i.exec(b)?.[1]),
      );
    check(paths.length);
    const path = paths[section - 1];
    const xml = path ? await zip.file(path)!.async('string') : null;
    signal?.throwIfAborted();
    const runs: string[] = [];
    if (xml)
      collectTextRuns(
        new XMLParser({ ignoreAttributes: true, parseTagValue: false, trimValues: true }).parse(
          xml,
        ),
        runs,
      );
    return {
      source,
      text: runs.join('\n'),
      section,
      sectionCount: Math.max(1, paths.length),
      sectionKind: 'slide',
      sectionLabel: `Slide ${section}`,
    };
  }
  check(1);
  const text =
    source === 'text'
      ? bytes.toString('utf8')
      : legacyWord
        ? (await new WordExtractor().extract(bytes)).getBody()
        : (await mammoth.extractRawText({ buffer: bytes })).value;
  signal?.throwIfAborted();
  return {
    source,
    text,
    section,
    sectionCount: 1,
    sectionKind: 'document',
    sectionLabel: 'Document text',
  };
}
