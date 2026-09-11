import { describe, expect, it } from '@jest/globals';
import JSZip from 'jszip';
import { extractPptxDocument, extractPptxText, isPowerPointAttachment, PPTX_MAX_XML_BYTES } from './pptx-extract.js';

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
  zip.file('ppt/presentation.xml', `<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldIdLst>${slides.map((_, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 1}"/>`).join('')}</p:sldIdLst></p:presentation>`);
  zip.file('ppt/_rels/presentation.xml.rels', `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${slides.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${i + 1}.xml"/>`).join('')}</Relationships>`);
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
  it('follows manifest order and excludes orphaned parts rather than sorting part names', async () => {
    const zip = await JSZip.loadAsync(await buildPptx([['Original first'], ['Now first'], ['Deleted slide']]));
    const manifest = await zip.file('ppt/presentation.xml')!.async('string');
    const ids = manifest.match(/<p:sldId\s[^>]*\/>/g)!;
    zip.file('ppt/presentation.xml', manifest.replace(ids.join(''), `${ids[1]}${ids[0]}`));
    // Slide parts may also have nonnumeric filenames.
    zip.file('ppt/slides/overview.xml', await zip.file('ppt/slides/slide2.xml')!.async('string'));
    zip.remove('ppt/slides/slide2.xml');
    zip.file('ppt/_rels/presentation.xml.rels', (await zip.file('ppt/_rels/presentation.xml.rels')!.async('string')).replace('slides/slide2.xml', '/ppt/slides/overview.xml'));
    const result = await extractPptxDocument(await zip.generateAsync({ type: 'nodebuffer' }));
    expect(result).toEqual({ text: 'Slide 1:\nNow first\n\nSlide 2:\nOriginal first', truncated: false, unreadableSlides: [] });
  });

  it('rejects missing or malformed manifests instead of treating arbitrary ZIP slide parts as a deck', async () => {
    const zip = await JSZip.loadAsync(await buildPptx([['Not proof of a valid deck']]));
    zip.remove('ppt/presentation.xml');
    await expect(extractPptxDocument(await zip.generateAsync({ type: 'nodebuffer' }))).rejects.toThrow('manifest');
    zip.file('ppt/presentation.xml', '<p:presentation><p:sldIdLst></p:presentation>');
    await expect(extractPptxDocument(await zip.generateAsync({ type: 'nodebuffer' }))).rejects.toThrow('Invalid PowerPoint XML');
  });

  it('keeps valid slides and discloses missing or external slide relationships', async () => {
    const zip = await JSZip.loadAsync(await buildPptx([['Missing part'], ['External part'], ['Still readable']]));
    zip.remove('ppt/slides/slide1.xml');
    zip.file('ppt/_rels/presentation.xml.rels', (await zip.file('ppt/_rels/presentation.xml.rels')!.async('string')).replace('Target="slides/slide2.xml"', 'Target="https://example.invalid/slide.xml" TargetMode="External"'));
    const result = await extractPptxDocument(await zip.generateAsync({ type: 'nodebuffer' }));
    expect(result.text).toBe('Slide 3:\nStill readable');
    expect(result.unreadableSlides).toEqual([1, 2]);
  });

  it('does not claim malformed slide XML or declared entities were read successfully', async () => {
    const zip = await JSZip.loadAsync(await buildPptx([['Broken'], ['Entity'], ['Usable']]));
    zip.file('ppt/slides/slide1.xml', '<p:sld><a:t>Broken but parsable</p:sld>');
    zip.file('ppt/slides/slide2.xml', '<!DOCTYPE p:sld [<!ENTITY hidden "Invented text">]>' + slideXml('&hidden;'));
    const result = await extractPptxDocument(await zip.generateAsync({ type: 'nodebuffer' }));
    expect(result.text).toBe('Slide 3:\nUsable');
    expect(result.unreadableSlides).toEqual([1, 2]);
  });

  it('bounds actual inflated XML even if a tiny ZIP lies about the uncompressed size', async () => {
    const zip = await JSZip.loadAsync(await buildPptx([['Too big'], ['Usable']]));
    zip.file('ppt/slides/slide1.xml', slideXml('A'.repeat(PPTX_MAX_XML_BYTES + 1)));
    const bytes = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
    expect(bytes.length).toBeLessThan(10_000);
    const expected = { text: 'Slide 2:\nUsable', truncated: true, unreadableSlides: [1] };
    expect(await extractPptxDocument(bytes)).toEqual(expected);
    // Forge the central-directory size, so the guard must count stream bytes
    // rather than trusting ZIP metadata or only clamping the extracted text.
    for (let i = 0; i < bytes.length - 46; i++) {
      if (bytes.readUInt32LE(i) === 0x02014b50 &&
          bytes.subarray(i + 46, i + 46 + bytes.readUInt16LE(i + 28)).toString() === 'ppt/slides/slide1.xml') {
        bytes.writeUInt32LE(1, i + 24);
        break;
      }
    }
    expect(await extractPptxDocument(bytes)).toEqual(expected);
  });

  it('bounds total XML parsing across a deck with little extracted text', async () => {
    const zip = await JSZip.loadAsync(await buildPptx(Array.from({ length: 10 }, (_, i) => [`Marker ${i + 1}`])));
    for (let i = 1; i <= 10; i++) {
      const xml = slideXml(`Marker ${i}`);
      zip.file(`ppt/slides/slide${i}.xml`, xml.replace('</p:sld>', `<!--${' '.repeat(PPTX_MAX_XML_BYTES - xml.length - 16)}--></p:sld>`));
    }
    const result = await extractPptxDocument(await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
    expect(result.truncated).toBe(true);
    expect(result.text).toContain('Marker 1');
    expect(result.text).not.toContain('Marker 10');
    expect(result.unreadableSlides).toContain(10);
  });

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

  it('preserves manifest order with double-digit slide part names', async () => {
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
