// Plain-text extraction for .pptx decks (client-profile documents used as
// outreach/AI context, and read by Meri's read_client_documents tool).
//
// A .pptx is an OOXML zip: each slide is ppt/slides/slideN.xml, and the visible
// text lives in <a:t> runs inside the DrawingML tree. We unzip with jszip
// (already in the dependency tree via mammoth) and pull the <a:t> values in
// slide order with fast-xml-parser (already a direct dependency). No native
// binaries, no headless renderer.
//
// Legacy binary .ppt (pre-2007 OLE/BIFF) is NOT supported — same boundary as
// xlsx-extract.ts dropping legacy .xls. Bounded per slide and overall so a huge
// deck can't blow memory or the response.
import { XMLParser } from 'fast-xml-parser';

const PPTX_CT = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';

export function isPowerPointAttachment(fileName: string, contentType: string): boolean {
  return /\.pptx$/i.test(fileName) || contentType.toLowerCase() === PPTX_CT;
}

const MAX_SLIDES = 500;
const MAX_CHARS_PER_SLIDE = 20_000;
const MAX_TOTAL_CHARS = 200_000;

/** Numeric suffix of ppt/slides/slideN.xml, for natural slide ordering. */
function slideIndex(path: string): number {
  const m = /slide(\d+)\.xml$/i.exec(path);
  return m?.[1] ? Number.parseInt(m[1], 10) : Number.MAX_SAFE_INTEGER;
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
 * + its text runs newline-joined), slides in natural order. jszip is
 * lazy-loaded (heavy at import time, like exceljs/pdf-parse elsewhere).
 */
export async function extractPptxText(buffer: Buffer): Promise<string> {
  return (await extractPptxDocument(buffer)).text;
}

/** Preserve reading limits and gaps for callers that display attachment status. */
export async function extractPptxDocument(buffer: Buffer): Promise<{
  text: string;
  truncated: boolean;
  unreadableSlides: number[];
}> {
  const { default: JSZip } = await import('jszip');
  const zip = await JSZip.loadAsync(buffer);

  const allSlidePaths = Object.keys(zip.files)
    .filter((p) => /^ppt\/slides\/slide\d+\.xml$/i.test(p))
    .sort((a, b) => slideIndex(a) - slideIndex(b));
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
    const file = zip.file(path);
    if (!file) continue;
    const xml = await file.async('string');
    let parsed: unknown;
    try {
      parsed = parser.parse(xml);
    } catch {
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
