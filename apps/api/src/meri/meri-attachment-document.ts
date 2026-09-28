import { createHash } from 'node:crypto';
import { posix as pathPosix } from 'node:path';
import mammoth from 'mammoth';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import type { ResolvedAiCredential } from '../ai-credentials/ai-credential-resolver.service.js';
import { AttachmentPdfVisionReader } from '../engagement/attachment-pdf-vision.js';
import { extractPptxDocument } from '../engagement/pptx-extract.js';
import { xlsxCellToText } from '../engagement/xlsx-extract.js';
import {
  MAX_SPREADSHEET_COLS,
  MAX_SPREADSHEET_ROWS,
} from '../engagement/generation/evidence-packet.types.js';
import { extractPdfText } from './meri-attachment-extract.js';
import { sha256Bytes, validateOoxmlArtifactPackage } from './meri-artifact-integrity.js';
import {
  DOC_TEXT_MAX_CHARS,
  TRUNCATION_MARKER,
  resolveDocumentStatus,
  type AttachmentKind,
  type DocumentExtractionResult,
} from './meri-attachment.helpers.js';

export const ATTACHMENT_OCR_MAX_PAGES = 8;
export const ATTACHMENT_OCR_TIMEOUT_MS = 45_000;
export const MAX_MERI_XLSX_CELLS = 50_000;
const visualReader = new AttachmentPdfVisionReader();

export class MeriXlsxValidationError extends Error {
  constructor(
    readonly code:
      | 'invalid_package'
      | 'macro_content'
      | 'worksheet_row_limit'
      | 'worksheet_column_limit'
      | 'worksheet_cell_limit',
  ) {
    super(code);
  }
}

interface MeriXlsxPackageInfo {
  hasExternalLinks: boolean;
  hasVisuals: boolean;
  workLimit: 'worksheet_row_limit' | 'worksheet_column_limit' | 'worksheet_cell_limit' | null;
}

type XmlNode = Record<string, unknown>;
type NamespaceBindings = Map<string, string>;
const SPREADSHEET_NAMESPACE = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const PACKAGE_RELATIONSHIPS_NAMESPACE =
  'http://schemas.openxmlformats.org/package/2006/relationships';
const OFFICE_RELATIONSHIPS_NAMESPACE =
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const WORKSHEET_RELATIONSHIP = `${OFFICE_RELATIONSHIPS_NAMESPACE}/worksheet`;
// Keep this aligned with ExcelJS 4.x XLSX.load's ZIP-entry dispatch. It is
// intentionally unanchored because ExcelJS's own match is unanchored.
const EXCELJS_WORKSHEET_ENTRY = /xl\/worksheets\/sheet(\d+)[.]xml/;

function xmlLocalName(name: string): string {
  const separator = name.lastIndexOf(':');
  return separator < 0 ? name : name.slice(separator + 1);
}

function xmlNode(value: unknown): XmlNode | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as XmlNode)
    : null;
}

function namespaceBindings(
  node: XmlNode,
  inherited: NamespaceBindings = new Map(),
): NamespaceBindings {
  const bindings = new Map(inherited);
  for (const [name, value] of Object.entries(node)) {
    if (name === '@_xmlns' && typeof value === 'string') bindings.set('', value);
    else if (name.startsWith('@_xmlns:') && typeof value === 'string')
      bindings.set(name.slice(8), value);
  }
  return bindings;
}

function elementNamespace(name: string, bindings: NamespaceBindings): string | null {
  const separator = name.indexOf(':');
  return bindings.get(separator < 0 ? '' : name.slice(0, separator)) ?? null;
}

interface XmlElement {
  name: string;
  node: XmlNode;
  bindings: NamespaceBindings;
}

function directXmlElements(
  parent: XmlElement,
  wantedName: string,
  wantedNamespace: string,
): XmlElement[] {
  const out: XmlElement[] = [];
  for (const [name, value] of Object.entries(parent.node)) {
    if (
      name.startsWith('@_') ||
      name.startsWith('?') ||
      name.startsWith('#') ||
      name.startsWith('!') ||
      xmlLocalName(name) !== wantedName
    )
      continue;
    for (const candidate of Array.isArray(value) ? value : [value]) {
      const node = xmlNode(candidate);
      if (!node) continue;
      const bindings = namespaceBindings(node, parent.bindings);
      if (elementNamespace(name, bindings) === wantedNamespace) out.push({ name, node, bindings });
    }
  }
  return out;
}

function parseXmlRoot(
  content: Buffer,
  updateTag?: (name: string, path: string, attributes: Record<string, string>) => string,
): XmlElement {
  let xml: string;
  try {
    xml = new TextDecoder('utf-8', { fatal: true }).decode(content);
  } catch {
    throw new Error('xlsx_xml_encoding_invalid');
  }
  if (/<!DOCTYPE|<!ENTITY/i.test(xml) || XMLValidator.validate(xml) !== true) {
    throw new Error('xlsx_xml_invalid');
  }
  let parsed: unknown;
  try {
    parsed = new XMLParser({
      ignoreAttributes: false,
      parseTagValue: false,
      trimValues: true,
      removeNSPrefix: false,
      processEntities: false,
      ...(updateTag ? { updateTag } : {}),
    }).parse(xml);
  } catch (error) {
    if (error instanceof MeriXlsxValidationError) throw error;
    throw new Error('xlsx_xml_invalid');
  }
  const document = xmlNode(parsed);
  const roots = document
    ? Object.entries(document).filter(
        ([name]) => !name.startsWith('?') && !name.startsWith('#') && !name.startsWith('!'),
      )
    : [];
  if (roots.length !== 1) throw new Error('xlsx_xml_root_invalid');
  const [name, value] = roots[0]!;
  const node = xmlNode(value);
  if (!node) throw new Error('xlsx_xml_root_invalid');
  const bindings = namespaceBindings(node);
  return { name, node, bindings };
}

function namespacedAttribute(
  element: XmlElement,
  wantedName: string,
  wantedNamespace: string,
): string | null {
  for (const [name, value] of Object.entries(element.node)) {
    if (!name.startsWith('@_') || typeof value !== 'string') continue;
    const qualified = name.slice(2);
    const separator = qualified.indexOf(':');
    if (separator < 0 || qualified.slice(separator + 1) !== wantedName) continue;
    if (element.bindings.get(qualified.slice(0, separator)) === wantedNamespace) return value;
  }
  return null;
}

function positiveInteger(value: unknown): number | null {
  if (typeof value !== 'string' || !/^[1-9][0-9]*$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function cellPosition(reference: unknown): { row: number; column: number } | null {
  if (typeof reference !== 'string') return null;
  const match = /^([A-Z]{1,3})([1-9][0-9]*)$/.exec(reference.toUpperCase());
  if (!match) return null;
  let column = 0;
  for (const character of match[1]!) column = column * 26 + character.charCodeAt(0) - 64;
  const row = Number(match[2]);
  return Number.isSafeInteger(row) ? { row, column } : null;
}

function rangeBounds(
  reference: unknown,
): { rows: number; columns: number; maxRow: number; maxColumn: number } | null {
  if (typeof reference !== 'string') return null;
  const parts = reference.split(':');
  if (parts.length > 2) return null;
  const start = cellPosition(parts[0]);
  const end = cellPosition(parts[1] ?? parts[0]);
  if (!start || !end || end.row < start.row || end.column < start.column) return null;
  return {
    rows: end.row - start.row + 1,
    columns: end.column - start.column + 1,
    maxRow: end.row,
    maxColumn: end.column,
  };
}

function enforcePosition(row: number, column: number): void {
  if (row > MAX_SPREADSHEET_ROWS) throw new MeriXlsxValidationError('worksheet_row_limit');
  if (column > MAX_SPREADSHEET_COLS) throw new MeriXlsxValidationError('worksheet_column_limit');
}

function worksheetPath(target: string): string | null {
  if (!target || target.includes('\\') || target.includes('\0')) return null;
  const resolved = pathPosix.normalize(
    target.startsWith('/') ? target.slice(1) : pathPosix.join('xl', target),
  );
  return resolved.startsWith('xl/') && !resolved.split('/').includes('..') ? resolved : null;
}

function inspectWorksheetXml(content: Buffer, totals: { rows: number; cells: number }): void {
  let implicitColumn = 0;
  const root = parseXmlRoot(content, (name, path, attributes) => {
    const element = xmlLocalName(name);
    const hierarchy = path.split('.').map(xmlLocalName);
    const parent = hierarchy[hierarchy.length - 2];
    const grandparent = hierarchy[hierarchy.length - 3];
    if (element === 'row' && parent === 'sheetData') {
      totals.rows += 1;
      if (totals.rows > MAX_SPREADSHEET_ROWS)
        throw new MeriXlsxValidationError('worksheet_row_limit');
      const row = attributes['@_r'] === undefined ? null : positiveInteger(attributes['@_r']);
      if (attributes['@_r'] !== undefined && row === null)
        throw new Error('xlsx_row_reference_invalid');
      if (row !== null) enforcePosition(row, 1);
      implicitColumn = 0;
    } else if (element === 'c' && parent === 'row' && grandparent === 'sheetData') {
      totals.cells += 1;
      if (totals.cells > MAX_MERI_XLSX_CELLS)
        throw new MeriXlsxValidationError('worksheet_cell_limit');
      const position = attributes['@_r'] === undefined ? null : cellPosition(attributes['@_r']);
      if (attributes['@_r'] !== undefined && position === null)
        throw new Error('xlsx_cell_reference_invalid');
      implicitColumn = position?.column ?? implicitColumn + 1;
      enforcePosition(position?.row ?? 1, implicitColumn);
    } else if (element === 'dimension' || element === 'mergeCell') {
      const range = rangeBounds(attributes['@_ref']);
      if (!range) throw new Error('xlsx_range_reference_invalid');
      enforcePosition(range.maxRow, range.maxColumn);
      if (element === 'mergeCell') {
        totals.cells += range.rows * range.columns;
        if (totals.cells > MAX_MERI_XLSX_CELLS)
          throw new MeriXlsxValidationError('worksheet_cell_limit');
      }
    } else if (element === 'col') {
      const minimum = positiveInteger(attributes['@_min']);
      const maximum = positiveInteger(attributes['@_max']);
      if (!minimum || !maximum || maximum < minimum)
        throw new Error('xlsx_column_reference_invalid');
      enforcePosition(1, maximum);
    }
    return name;
  });
  if (
    xmlLocalName(root.name) !== 'worksheet' ||
    elementNamespace(root.name, root.bindings) !== SPREADSHEET_NAMESPACE
  ) {
    throw new Error('xlsx_worksheet_root_invalid');
  }
}

function inspectWorkbookSheets(entries: ReadonlyMap<string, Buffer>): void {
  const workbookBytes = entries.get('xl/workbook.xml');
  const relationshipBytes = entries.get('xl/_rels/workbook.xml.rels');
  if (!workbookBytes || !relationshipBytes) throw new Error('xlsx_workbook_relationships_missing');
  const workbook = parseXmlRoot(workbookBytes);
  const relationships = parseXmlRoot(relationshipBytes);
  if (
    xmlLocalName(workbook.name) !== 'workbook' ||
    elementNamespace(workbook.name, workbook.bindings) !== SPREADSHEET_NAMESPACE ||
    xmlLocalName(relationships.name) !== 'Relationships' ||
    elementNamespace(relationships.name, relationships.bindings) !== PACKAGE_RELATIONSHIPS_NAMESPACE
  ) {
    throw new Error('xlsx_workbook_relationships_invalid');
  }

  const targets = new Map<string, string>();
  for (const relationship of directXmlElements(
    relationships,
    'Relationship',
    PACKAGE_RELATIONSHIPS_NAMESPACE,
  )) {
    const id = relationship.node['@_Id'];
    const type = relationship.node['@_Type'];
    const target = relationship.node['@_Target'];
    if (type !== WORKSHEET_RELATIONSHIP) continue;
    if (
      typeof id !== 'string' ||
      typeof target !== 'string' ||
      relationship.node['@_TargetMode'] !== undefined ||
      targets.has(id)
    ) {
      throw new Error('xlsx_worksheet_relationship_invalid');
    }
    const path = worksheetPath(target);
    if (!path) throw new Error('xlsx_worksheet_relationship_invalid');
    targets.set(id, path);
  }

  const sheetsContainers = directXmlElements(workbook, 'sheets', SPREADSHEET_NAMESPACE);
  if (sheetsContainers.length !== 1) throw new Error('xlsx_sheets_invalid');
  const sheets = directXmlElements(sheetsContainers[0]!, 'sheet', SPREADSHEET_NAMESPACE);
  const worksheetPaths = new Set<string>();
  for (const sheet of sheets) {
    const relationshipId = namespacedAttribute(sheet, 'id', OFFICE_RELATIONSHIPS_NAMESPACE);
    const target = relationshipId ? targets.get(relationshipId) : undefined;
    const worksheet = target ? entries.get(target) : undefined;
    if (!worksheet) throw new Error('xlsx_worksheet_relationship_invalid');
    worksheetPaths.add(target!);
  }

  // ExcelJS decodes every matching ZIP entry, even when workbook.xml does not
  // link it. Union those paths with linked parts so each decoded XML is bounded
  // and namespace-validated exactly once before workbook.xlsx.load.
  for (const path of entries.keys()) {
    if (EXCELJS_WORKSHEET_ENTRY.test(path)) worksheetPaths.add(path);
  }
  const totals = { rows: 0, cells: 0 };
  for (const path of worksheetPaths) {
    inspectWorksheetXml(entries.get(path)!, totals);
  }
}

/** Validate the real OOXML workbook root/type and reject executable package
 * content before ExcelJS sees it. External links are never followed; their
 * presence is returned so cached remote formula values can be withheld. */
export async function validateMeriXlsxPackage(bytes: Buffer): Promise<MeriXlsxPackageInfo> {
  let entries: ReadonlyMap<string, Buffer>;
  try {
    entries = validateOoxmlArtifactPackage('xlsx', bytes);
  } catch (error) {
    if (error instanceof MeriXlsxValidationError) throw error;
    throw new MeriXlsxValidationError('invalid_package');
  }
  const paths = [...entries.keys()];
  if (
    paths.some((path) =>
      /(^|\/)(?:vbaProject(?:Signature)?\.bin|macrosheets\/|dialogsheets\/|activeX\/|embeddings\/)/i.test(
        path,
      ),
    )
  ) {
    throw new MeriXlsxValidationError('macro_content');
  }
  let workLimit: MeriXlsxPackageInfo['workLimit'] = null;
  try {
    inspectWorkbookSheets(entries);
  } catch (error) {
    if (error instanceof MeriXlsxValidationError && error.code.endsWith('_limit')) {
      workLimit = error.code as MeriXlsxPackageInfo['workLimit'];
    } else if (error instanceof MeriXlsxValidationError) {
      throw error;
    } else {
      throw new MeriXlsxValidationError('invalid_package');
    }
  }
  return {
    hasExternalLinks: paths.some((path) => /^xl\/externalLinks\//i.test(path)),
    hasVisuals: paths.some((path) => /^xl\/(?:charts|media)\//i.test(path) && !path.endsWith('/')),
    workLimit,
  };
}

function xlsxCoordinate(sheetName: string, address: string): string {
  return `'${sheetName.replace(/'/g, "''")}'!${address}`;
}

function formulaText(
  value: Record<string, unknown>,
  packageHasExternalLinks: boolean,
): {
  text: string;
  cached: boolean;
  unavailable: 'external' | 'missing' | null;
} {
  const formula =
    typeof value.formula === 'string'
      ? value.formula
      : typeof value.sharedFormula === 'string'
        ? value.sharedFormula
        : '';
  const external =
    /\[[^\]]+\]/.test(formula) ||
    /\b(?:WEBSERVICE|RTD|DDE)\s*\(/i.test(formula) ||
    (packageHasExternalLinks && /external/i.test(formula));
  if (external) {
    return {
      text: '[external formula result unavailable; external links were not read]',
      cached: false,
      unavailable: 'external',
    };
  }
  if (!Object.prototype.hasOwnProperty.call(value, 'result') || value.result === undefined) {
    return {
      text: '[formula result unavailable; recalculate and save the workbook]',
      cached: false,
      unavailable: 'missing',
    };
  }
  const result = value.result;
  const text = xlsxCellToText(result);
  if (text) return { text, cached: true, unavailable: null };
  if (result === '' || result === null) {
    return { text: '[cached formula result: empty]', cached: true, unavailable: null };
  }
  if (
    result &&
    typeof result === 'object' &&
    typeof (result as Record<string, unknown>).error === 'string'
  ) {
    return {
      text: `[cached formula error: ${(result as Record<string, unknown>).error as string}]`,
      cached: true,
      unavailable: null,
    };
  }
  return { text: String(result ?? ''), cached: true, unavailable: null };
}

async function extractMeriXlsxDocument(
  bytes: Buffer,
  packageInfo: MeriXlsxPackageInfo,
): Promise<DocumentExtractionResult> {
  const ExcelJS = await import('exceljs');
  const workbook = new (ExcelJS.default ?? ExcelJS).Workbook();
  await workbook.xlsx.load(bytes as unknown as Parameters<typeof workbook.xlsx.load>[0]);

  const lines: string[] = [];
  const reasons = new Set<string>();
  const contentLimit = DOC_TEXT_MAX_CHARS - TRUNCATION_MARKER.length - 1;
  let chars = 0;
  let inspectedRows = 0;
  let readableCells = 0;
  let partial = false;
  let textLimitReached = false;
  let sawCachedFormula = false;
  let sawMissingFormula = false;
  let sawExternalFormula = false;

  const add = (line: string): boolean => {
    const needed = line.length + (lines.length ? 1 : 0);
    if (chars + needed > contentLimit) {
      partial = true;
      textLimitReached = true;
      return false;
    }
    lines.push(line);
    chars += needed;
    return true;
  };

  add(`Source SHA-256: ${sha256Bytes(bytes)}`);

  for (const [sheetIndex, sheet] of workbook.worksheets.entries()) {
    if (textLimitReached) break;
    const visibility = sheet.state === 'veryHidden' ? 'very hidden' : sheet.state;
    if (!add(`Worksheet ${sheetIndex + 1}: ${JSON.stringify(sheet.name)} (${visibility})`)) break;
    let sheetCells = 0;
    const lastRow = Math.min(sheet.rowCount, MAX_SPREADSHEET_ROWS - inspectedRows);
    for (let rowNumber = 1; rowNumber <= lastRow && !textLimitReached; rowNumber += 1) {
      inspectedRows += 1;
      const row = sheet.getRow(rowNumber);
      const lastColumn = Math.min(row.cellCount, MAX_SPREADSHEET_COLS);
      if (row.cellCount > MAX_SPREADSHEET_COLS) {
        partial = true;
        reasons.add(`Cells after column ${MAX_SPREADSHEET_COLS} were not read.`);
      }
      for (let column = 1; column <= lastColumn; column += 1) {
        const cell = row.getCell(column);
        const master = (cell as unknown as { master?: { address?: string } }).master;
        if (master?.address && master.address !== cell.address) continue;
        const value = cell.value;
        if (value == null) continue;
        let text: string;
        let suffix = '';
        if (typeof value === 'object' && ('formula' in value || 'sharedFormula' in value)) {
          const rendered = formulaText(
            value as unknown as Record<string, unknown>,
            packageInfo.hasExternalLinks,
          );
          text = rendered.text;
          if (rendered.cached) {
            sawCachedFormula = true;
            suffix = ' (saved cached formula result; not recalculated)';
          } else if (rendered.unavailable === 'external') {
            sawExternalFormula = true;
            partial = true;
          } else {
            sawMissingFormula = true;
            partial = true;
          }
        } else {
          text = xlsxCellToText(value);
        }
        if (!text) continue;
        if (!add(`${xlsxCoordinate(sheet.name, cell.address)} = ${JSON.stringify(text)}${suffix}`))
          break;
        sheetCells += 1;
        readableCells += 1;
      }
    }
    if (!sheetCells && !textLimitReached) add('[no non-empty cells]');
    if (sheet.rowCount > lastRow) {
      partial = true;
      reasons.add(
        `Only the first ${MAX_SPREADSHEET_ROWS} row positions across the workbook were inspected.`,
      );
    }
    if (inspectedRows >= MAX_SPREADSHEET_ROWS && sheetIndex + 1 < workbook.worksheets.length) {
      partial = true;
      reasons.add('Later worksheets were not read because the workbook reached the row limit.');
      break;
    }
  }

  if (!readableCells) {
    return {
      status: 'unsupported',
      text: null,
      truncated: false,
      reason: 'No readable cell values were found in this workbook.',
    };
  }
  if (textLimitReached)
    reasons.add('Only part of the workbook is included because it reached the text limit.');
  if (sawCachedFormula)
    reasons.add('Formula cells use saved cached results; formulas were not recalculated.');
  if (sawMissingFormula)
    reasons.add('Some formulas had no saved result and are marked unavailable.');
  if (sawExternalFormula || packageInfo.hasExternalLinks) {
    reasons.add('External workbook links and their cached values were not read.');
    partial = true;
  }
  if (packageInfo.hasVisuals) {
    reasons.add('Spreadsheet charts and images are not represented by cell extraction.');
    partial = true;
  }
  if (partial) lines.push(TRUNCATION_MARKER);
  const reason = reasons.size ? [...reasons].join(' ').slice(0, 300) : null;
  return {
    status: partial ? 'truncated' : 'parsed',
    text: lines.join('\n').trim(),
    truncated: partial,
    reason,
  };
}

/** Reuse the canonical provider page reader; persist its literal result once so
 * regeneration and follow-ups do not run nondeterministic OCR again. */
export async function extractMeriDocument(
  input: {
    bytes: Buffer;
    kind: AttachmentKind;
    tenantId: string;
    userId: string;
    resolveCredential: () => Promise<ResolvedAiCredential | null>;
  },
  reader: Pick<AttachmentPdfVisionReader, 'read'> = visualReader,
): Promise<DocumentExtractionResult & { pages: number | null }> {
  if (input.kind === 'xlsx') {
    const packageInfo = await validateMeriXlsxPackage(input.bytes);
    if (packageInfo.workLimit) {
      const reason =
        packageInfo.workLimit === 'worksheet_row_limit'
          ? `Workbook exceeds the ${MAX_SPREADSHEET_ROWS.toLocaleString('en-US')}-row-position reading limit. Split it into smaller workbooks.`
          : packageInfo.workLimit === 'worksheet_column_limit'
            ? `Workbook exceeds the ${MAX_SPREADSHEET_COLS}-column reading limit. Split it into smaller workbooks.`
            : `Workbook exceeds the ${MAX_MERI_XLSX_CELLS.toLocaleString('en-US')}-cell reading limit. Split it into smaller workbooks.`;
      return { status: 'unsupported', text: null, truncated: false, reason, pages: null };
    }
    return { ...(await extractMeriXlsxDocument(input.bytes, packageInfo)), pages: null };
  }
  if (input.kind === 'pptx') {
    const extracted = await extractPptxDocument(input.bytes);
    const resolved = resolveDocumentStatus('pptx', extracted.text);
    if (!resolved.text)
      return {
        ...resolved,
        pages: null,
        reason:
          'No readable slide text was found. Export the presentation to PDF or upload images of the slides.',
      };
    const partial =
      resolved.truncated || extracted.truncated || extracted.unreadableSlides.length > 0;
    const reasons = [
      'PowerPoint slide text only. Images, charts, and speaker notes are not included; upload a PDF or slide images for those details.',
    ];
    if (extracted.unreadableSlides.length)
      reasons.push(`${extracted.unreadableSlides.length} slide(s) had no readable text.`);
    if (resolved.truncated || extracted.truncated)
      reasons.push('Only part of the slide text is included because it exceeds the reading limit.');
    return {
      ...resolved,
      pages: null,
      status: partial ? 'truncated' : 'parsed',
      truncated: partial,
      reason: reasons.join(' ').slice(0, 300),
    };
  }
  if (input.kind !== 'pdf') {
    const raw =
      input.kind === 'docx'
        ? (await mammoth.extractRawText({ buffer: input.bytes })).value
        : new TextDecoder('utf-8', { fatal: true }).decode(input.bytes);
    // A binary .txt should not be accepted as readable replacement characters.
    if (raw.includes('\u0000')) throw new Error('Binary text attachment');
    return { ...resolveDocumentStatus(input.kind, raw), pages: null };
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ATTACHMENT_OCR_TIMEOUT_MS);
  const cacheScope = `${input.tenantId}:${input.userId}:${createHash('sha256').update(input.bytes).digest('hex')}`;
  let attempts = 0;
  try {
    const extracted = await extractPdfText(input.bytes, {
      signal: controller.signal,
      readScannedPage: async (section, sectionCount) => {
        if (controller.signal.aborted || attempts >= ATTACHMENT_OCR_MAX_PAGES)
          return { text: '', partial: true };
        attempts += 1;
        let onAbort: () => void = () => {};
        try {
          const deadline = new Promise<never>((_, reject) => {
            onAbort = () => reject(new Error('Scanned-page reading timed out'));
            controller.signal.addEventListener('abort', onAbort, { once: true });
          });
          const result = await Promise.race([
            reader.read({
              bytes: input.bytes,
              cacheScope,
              section,
              sectionCount,
              resolveCredential: input.resolveCredential,
              signal: controller.signal,
            }),
            deadline,
          ]);
          return { text: result.text, partial: result.readability.status !== 'ocr_readable' };
        } catch {
          // Keep earlier readable pages and disclose the gap if the deadline expires.
          return { text: '', partial: true };
        } finally {
          controller.signal.removeEventListener('abort', onAbort);
        }
      },
    });
    const resolved = resolveDocumentStatus('pdf', extracted.text);
    const partial =
      extracted.truncated || extracted.unreadablePages.length > 0 || resolved.truncated;
    const reasons: string[] = [];
    if (extracted.visuallyReadPages.length)
      reasons.push(
        'Includes text read from scanned pages. Verify important names and figures against the original.',
      );
    if (extracted.unreadablePages.length)
      reasons.push(
        `${extracted.unreadablePages.length} page(s) could not be read completely. Retry this file or upload those pages separately.`,
      );
    if (extracted.truncated || resolved.truncated)
      reasons.push('Only part of this document is included because it exceeds the reading limit.');
    return {
      ...resolved,
      pages: extracted.pages,
      ...(resolved.text
        ? { status: partial ? ('truncated' as const) : ('parsed' as const), truncated: partial }
        : {}),
      reason: reasons.length ? reasons.join(' ').slice(0, 300) : resolved.reason,
    };
  } finally {
    clearTimeout(timeout);
  }
}
