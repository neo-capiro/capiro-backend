// Plain-text extraction for .pptx decks (client-profile documents used as
// outreach/AI context, and read by Meri's read_client_documents tool).
//
// A .pptx is an OOXML zip: slide parts are usually ppt/slides/slideN.xml, and the visible
// text lives in <a:t> runs inside the DrawingML tree. We unzip with jszip
// (already in the dependency tree via mammoth) and pull the <a:t> values in
// slide order with fast-xml-parser (already a direct dependency). No native
// binaries, no headless renderer.
//
// Legacy binary .ppt (pre-2007 OLE/BIFF) is NOT supported — same boundary as
// xlsx-extract.ts dropping legacy .xls. Bounded per slide and overall so a huge
// deck can't blow memory or the response.
import { posix } from 'node:path';
import type { Readable } from 'node:stream';
import type JSZip from 'jszip';
import { XMLParser, XMLValidator } from 'fast-xml-parser';

const PPTX_CT = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';

export function isPowerPointAttachment(fileName: string, contentType: string): boolean {
  return /\.pptx$/i.test(fileName) || contentType.toLowerCase() === PPTX_CT;
}

const MAX_SLIDES = 500;
const MAX_CHARS_PER_SLIDE = 20_000;
const MAX_TOTAL_CHARS = 200_000;
// Compressed upload size and output character caps cannot bound ZIP inflation
// or XML parsing. Apply limits to the actual inflated bytes before parsing.
export const PPTX_MAX_XML_BYTES = 2 * 1024 * 1024;
const MAX_TOTAL_XML_BYTES = 16 * 1024 * 1024;

class XmlReadingLimitError extends Error {}

async function readXml(file: JSZip.JSZipObject, budget: { remaining: number }): Promise<string> {
  const limit = Math.min(PPTX_MAX_XML_BYTES, budget.remaining);
  // JSZip has no public size accessor. This optional fast rejection avoids
  // inflating a known oversized entry; the stream count below remains the
  // authority, including when ZIP size metadata is missing or dishonest.
  const declaredSize = (file as JSZip.JSZipObject & { _data?: { uncompressedSize?: number } })._data?.uncompressedSize;
  if (limit <= 0 || (typeof declaredSize === 'number' && declaredSize > limit))
    throw new XmlReadingLimitError('PowerPoint XML exceeds the reading limit');
  const bytes = await new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    const stream = file.nodeStream('nodebuffer') as Readable;
    stream.on('data', (chunk: Buffer) => {
      total += chunk.length;
      budget.remaining -= chunk.length;
      if (total > limit) {
        stream.pause();
        stream.destroy();
        reject(new XmlReadingLimitError('PowerPoint XML exceeds the reading limit'));
        return;
      }
      chunks.push(chunk);
    });
    stream.on('error', reject);
    stream.on('end', () => resolve(Buffer.concat(chunks, total)));
  });
  const xml = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  // OOXML does not require custom entities. Reject declarations before either
  // validator or parser can expand user-controlled entity definitions.
  if (/<!DOCTYPE|<!ENTITY/i.test(xml) || XMLValidator.validate(xml) !== true)
    throw new Error('Invalid PowerPoint XML');
  return xml;
}

type XmlRecord = Record<string, unknown>;
const record = (value: unknown): XmlRecord | undefined =>
  value != null && typeof value === 'object' && !Array.isArray(value) ? value as XmlRecord : undefined;
const list = (value: unknown): unknown[] => value == null ? [] : Array.isArray(value) ? value : [value];
function child(value: unknown, name: string): unknown {
  return Object.entries(record(value) ?? {}).find(([key]) => !key.startsWith('@_') && key.split(':').pop() === name)?.[1];
}

/** Presentation order is defined by sldIdLst, never by slide part filenames. */
async function presentationSlides(zip: JSZip, budget: { remaining: number }): Promise<Array<string | null>> {
  const manifest = zip.file('ppt/presentation.xml');
  const relationships = zip.file('ppt/_rels/presentation.xml.rels');
  if (!manifest || !relationships) throw new Error('Missing PowerPoint presentation manifest');
  const parser = new XMLParser({ ignoreAttributes: false, parseTagValue: false, trimValues: true });
  const presentation = child(parser.parse(await readXml(manifest, budget)), 'presentation');
  const relRoot = child(parser.parse(await readXml(relationships, budget)), 'Relationships');
  if (!record(presentation) || relRoot === undefined) throw new Error('Invalid PowerPoint presentation manifest');
  const targets = new Map<string, string>();
  for (const value of list(child(relRoot, 'Relationship'))) {
    const rel = record(value);
    if (!rel || typeof rel['@_Id'] !== 'string' || typeof rel['@_Target'] !== 'string' ||
        typeof rel['@_Type'] !== 'string' || !rel['@_Type'].endsWith('/slide') ||
        String(rel['@_TargetMode'] ?? '').toLowerCase() === 'external') continue;
    const target = rel['@_Target'];
    if (/[\\?#]/.test(target) || /^[a-z][a-z\d+.-]*:/i.test(target)) continue;
    const path = posix.normalize(target.startsWith('/') ? target.slice(1) : posix.join('ppt', target));
    if (path === '..' || path.startsWith('../')) continue;
    targets.set(rel['@_Id'], path);
  }
  return list(child(child(presentation, 'sldIdLst'), 'sldId')).map(value => {
    const slide = record(value);
    // Relationship IDs are namespace-qualified; the unqualified id is the
    // presentation's numeric slide identity, which is a different value.
    const id = Object.entries(slide ?? {}).find(([key]) => key.startsWith('@_') && key.endsWith(':id'))?.[1];
    return typeof id === 'string' ? targets.get(id) ?? null : null;
  });
}

function relatedPartPath(ownerPath: string, target: string): string | null {
  if (!target || /[\\?#]/.test(target) || /^[a-z][a-z\d+.-]*:/i.test(target)) return null;
  const path = posix.normalize(
    target.startsWith('/') ? target.slice(1) : posix.join(posix.dirname(ownerPath), target),
  );
  return path === '..' || path.startsWith('../') ? null : path;
}

async function slideNotesPath(
  zip: JSZip,
  slidePath: string,
  budget: { remaining: number },
): Promise<string | null> {
  const relationshipsPath = posix.join(
    posix.dirname(slidePath),
    '_rels',
    `${posix.basename(slidePath)}.rels`,
  );
  const relationships = zip.file(relationshipsPath);
  if (!relationships) return null;
  const parser = new XMLParser({ ignoreAttributes: false, parseTagValue: false, trimValues: true });
  const root = child(parser.parse(await readXml(relationships, budget)), 'Relationships');
  for (const value of list(child(root, 'Relationship'))) {
    const rel = record(value);
    if (
      !rel ||
      typeof rel['@_Type'] !== 'string' ||
      !rel['@_Type'].endsWith('/notesSlide') ||
      typeof rel['@_Target'] !== 'string' ||
      String(rel['@_TargetMode'] ?? '').toLowerCase() === 'external'
    )
      continue;
    return relatedPartPath(slidePath, rel['@_Target']);
  }
  return null;
}

/**
 * Walk a parsed-XML subtree and collect every `a:t` text run in document
 * order. fast-xml-parser yields a string for a single run, an array for
 * repeated runs, and nested objects for the surrounding shapes — handle all
 * three by recursing over every value.
 */
export function collectTextRuns(node: unknown, out: string[]): void {
  if (node == null) return;
  if (typeof node === 'string') return;
  if (Array.isArray(node)) {
    for (const child of node) collectTextRuns(child, out);
    return;
  }
  if (typeof node === 'object') {
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (key === 'a:t') {
        if (typeof value === 'string') out.push(value);
        else if (typeof value === 'number' || typeof value === 'boolean') out.push(String(value));
        else if (Array.isArray(value)) {
          for (const v of value) {
            if (typeof v === 'string') out.push(v);
            else if (typeof v === 'number' || typeof v === 'boolean') out.push(String(v));
          }
        }
      } else {
        collectTextRuns(value, out);
      }
    }
  }
}

/**
 * Plain-text rendering of a .pptx deck: one block per slide ("Slide N:" header
 * + its text runs newline-joined), slides in presentation order. jszip is
 * lazy-loaded (heavy at import time, like exceljs/pdf-parse elsewhere).
 */
export async function extractPptxText(buffer: Buffer): Promise<string> {
  return (await extractPptxDocument(buffer)).text;
}

/** Read one presentation-ordered slide and its speaker-notes part. The same
 * bounded XML inflater and package traversal used by full extraction remain the
 * authority; unrelated slides are not inflated or parsed. */
export async function extractPptxSlide(buffer: Buffer, slideNumber: number): Promise<{
  slideNumber: number;
  slideCount: number;
  text: string;
  notes: string;
  truncated: boolean;
  readable: boolean;
}> {
  if (!Number.isSafeInteger(slideNumber) || slideNumber < 1 || slideNumber > MAX_SLIDES)
    throw new Error('PowerPoint slide is outside the reading limit');
  const { default: JSZip } = await import('jszip');
  const zip = await JSZip.loadAsync(buffer);
  const budget = { remaining: MAX_TOTAL_XML_BYTES };
  const paths = await presentationSlides(zip, budget);
  const path = paths[slideNumber - 1];
  if (slideNumber > paths.length) throw new Error('PowerPoint slide does not exist');
  if (!path) {
    return { slideNumber, slideCount: paths.length, text: '', notes: '', truncated: false, readable: false };
  }
  const parser = new XMLParser({ ignoreAttributes: true, parseTagValue: false, trimValues: true });
  const readRuns = async (partPath: string, expectedRoot: 'sld' | 'notes'): Promise<string> => {
    const file = zip.file(partPath);
    if (!file) return '';
    const parsed = parser.parse(await readXml(file, budget));
    if (!record(child(parsed, expectedRoot))) throw new Error('Invalid PowerPoint section');
    const runs: string[] = [];
    collectTextRuns(parsed, runs);
    return runs.join('\n').trim();
  };
  let text = '';
  let notes = '';
  let truncated = false;
  try {
    text = await readRuns(path, 'sld');
    const notesPath = await slideNotesPath(zip, path, budget);
    if (notesPath) notes = await readRuns(notesPath, 'notes');
  } catch (error) {
    if (error instanceof XmlReadingLimitError) truncated = true;
    else throw error;
  }
  if (text.length > MAX_CHARS_PER_SLIDE) {
    text = text.slice(0, MAX_CHARS_PER_SLIDE);
    truncated = true;
  }
  if (notes.length > MAX_CHARS_PER_SLIDE) {
    notes = notes.slice(0, MAX_CHARS_PER_SLIDE);
    truncated = true;
  }
  return {
    slideNumber,
    slideCount: paths.length,
    text,
    notes,
    truncated,
    readable: Boolean(text || notes),
  };
}

/** Preserve reading limits and gaps for callers that display attachment status. */
export async function extractPptxDocument(buffer: Buffer): Promise<{
  text: string;
  truncated: boolean;
  unreadableSlides: number[];
}> {
  const { default: JSZip } = await import('jszip');
  const zip = await JSZip.loadAsync(buffer);

  const budget = { remaining: MAX_TOTAL_XML_BYTES };
  const allSlidePaths = await presentationSlides(zip, budget);
  const slidePaths = allSlidePaths.slice(0, MAX_SLIDES);
  let truncated = allSlidePaths.length > slidePaths.length;
  const unreadableSlides: number[] = [];

  const parser = new XMLParser({
    ignoreAttributes: true,
    // Keep empty <a:t/> runs from collapsing into booleans.
    parseTagValue: false,
    trimValues: true,
  });

  const blocks: string[] = [];
  let total = 0;
  let slideNumber = 0;
  for (const path of slidePaths) {
    slideNumber += 1;
    const file = path ? zip.file(path) : null;
    if (!file) {
      unreadableSlides.push(slideNumber);
      continue;
    }
    let parsed: unknown;
    try {
      parsed = parser.parse(await readXml(file, budget));
      if (!record(child(parsed, 'sld'))) throw new Error('Invalid PowerPoint slide');
    } catch (error) {
      truncated ||= error instanceof XmlReadingLimitError;
      unreadableSlides.push(slideNumber);
      continue; // a malformed slide must not abort the whole deck
    }
    const runs: string[] = [];
    collectTextRuns(parsed, runs);
    const raw = runs.join('\n').trim();
    const text = raw.slice(0, MAX_CHARS_PER_SLIDE);
    truncated ||= text.length < raw.length;
    if (!text) {
      unreadableSlides.push(slideNumber);
      continue;
    }
    const block = `Slide ${slideNumber}:\n${text}`;
    blocks.push(block);
    total += block.length;
    if (total >= MAX_TOTAL_CHARS) {
      truncated ||= slideNumber < allSlidePaths.length;
      break;
    }
  }

  const raw = blocks.join('\n\n');
  return { text: raw.slice(0, MAX_TOTAL_CHARS).trim(),
    truncated: truncated || raw.length > MAX_TOTAL_CHARS, unreadableSlides };
}
