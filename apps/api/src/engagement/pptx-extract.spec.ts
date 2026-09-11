import { describe, expect, it } from '@jest/globals';
import JSZip from 'jszip';
import { extractPptxDocument, extractPptxText, isPowerPointAttachment } from './pptx-extract.js';

const PPTX_CT = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';

/** Minimal slide XML with the given text runs in <a:t> nodes. */
function slideXml(...runs: string[]): string {
  const paras = runs
    .map(
      (t) =>
        `<a:p><a:r><a:rPr lang="en-US"/><a:t>${t}</a:t></a:r></a:p>`,
    )
    .join('');
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ` +
    `xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">` +
    `<p:cSld><p:spTree><p:sp><p:txBody>${paras}</p:txBody></p:sp></p:spTree></p:cSld></p:sld>`
  );
}

async function buildPptx(slides: string[][]): Promise<Buffer> {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<?xml version="1.0"?><Types/>');
  slides.forEach((runs, i) => {
    zip.file(`ppt/slides/slide${i + 1}.xml`, slideXml(...runs));
  });
  return zip.generateAsync({ type: 'nodebuffer' });
}

describe('isPowerPointAttachment', () => {
  it('matches by .pptx extension and by content type', () => {
    expect(isPowerPointAttachment('deck.pptx', 'application/octet-stream')).toBe(true);
    expect(isPowerPointAttachment('DECK.PPTX', '')).toBe(true);
    expect(isPowerPointAttachment('noext', PPTX_CT)).toBe(true);
  });
  it('does not match other formats or legacy .ppt', () => {
    expect(isPowerPointAttachment('doc.docx', '')).toBe(false);
    expect(isPowerPointAttachment('sheet.xlsx', '')).toBe(false);
    expect(isPowerPointAttachment('old.ppt', 'application/vnd.ms-powerpoint')).toBe(false);
  });
});

describe('extractPptxText', () => {
  it('reports omitted slides even when a large deck is below the character cap', async () => {
    const buf = await buildPptx(Array.from({ length: 501 }, (_, i) => [`Marker ${i + 1}`]));
    const result = await extractPptxDocument(buf);
    expect(result.truncated).toBe(true);
    expect(result.text).toContain('Marker 500');
    expect(result.text).not.toContain('Marker 501');
  });

  it('extracts text runs from every slide in slide order', async () => {
    const buf = await buildPptx([
      ['Title One', 'Bullet A', 'Bullet B'],
      ['Title Two', 'Closing thought'],
    ]);
    const text = await extractPptxText(buf);
    expect(text).toContain('Slide 1:');
    expect(text).toContain('Title One');
    expect(text).toContain('Bullet A');
    expect(text).toContain('Slide 2:');
    expect(text).toContain('Closing thought');
    // Slide 1 must come before slide 2.
    expect(text.indexOf('Slide 1:')).toBeLessThan(text.indexOf('Slide 2:'));
  });

  it('orders slides numerically, not lexically (slide2 before slide10)', async () => {
    const slides: string[][] = [];
    for (let i = 1; i <= 10; i += 1) slides.push([`Marker ${i}`]);
    const buf = await buildPptx(slides);
    const text = await extractPptxText(buf);
    expect(text.indexOf('Marker 2')).toBeLessThan(text.indexOf('Marker 10'));
  });

  it('skips slides with no text and returns trimmed output', async () => {
    const buf = await buildPptx([['Only content here'], []]);
    const text = await extractPptxText(buf);
    expect(text).toContain('Only content here');
    // The empty slide produces no "Slide 2:" block.
    expect(text).not.toContain('Slide 2:');
    expect(text).toBe(text.trim());
  });

  it('returns empty string for a deck with no slides', async () => {
    const buf = await buildPptx([]);
    const text = await extractPptxText(buf);
    expect(text).toBe('');
  });
});
