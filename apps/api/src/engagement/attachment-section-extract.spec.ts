import { extractAttachmentSection } from './attachment-section-extract.js';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { Document, Packer, Paragraph } from 'docx';

describe('canonical attachment section extraction', () => {
  it('keeps late plain text and DOCX paragraphs reachable beyond the summary cap', async () => {
    const text = `${'Context '.repeat(30000)}A final binding restriction.`;
    const plain = await extractAttachmentSection(Buffer.from(text), 'text', 1);
    expect(plain.text).toBe(text);
    const bytes = await Packer.toBuffer(
      new Document({ sections: [{ children: [new Paragraph(text)] }] }),
    );
    const word = await extractAttachmentSection(bytes, 'docx', 1);
    expect(word.text).toContain('A final binding restriction.');
    expect(word.text.length).toBeGreaterThan(200000);
  });

  it('reads an exact PDF page without parsing/joining the other pages', async () => {
    const document = await PDFDocument.create();
    const font = await document.embedFont(StandardFonts.Helvetica);
    for (let page = 1; page <= 3; page += 1)
      document.addPage().drawText(`Page ${page} evidence`, { font });
    const result = await extractAttachmentSection(Buffer.from(await document.save()), 'pdf', 3);
    expect(result).toMatchObject({ section: 3, sectionCount: 3, sectionKind: 'page' });
    expect(result.text).toContain('Page 3 evidence');
    expect(result.text).not.toContain('Page 1 evidence');
    await expect(
      extractAttachmentSection(Buffer.from(await document.save()), 'pdf', 4),
    ).rejects.toThrow('between 1 and 3');
  });

  it('reads rows past the old 5000-row summary cap and keeps Excel coordinates', async () => {
    const ExcelJS = await import('exceljs');
    const workbook = new (ExcelJS.default ?? ExcelJS).Workbook();
    const sheet = workbook.addWorksheet('Awards');
    sheet.getCell('C6001').value = 'Final award condition';
    const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
    const result = await extractAttachmentSection(buffer, 'spreadsheet', 7);
    expect(result).toMatchObject({
      section: 7,
      sectionCount: 7,
      sectionKind: 'sheet_rows',
      sectionLabel: 'Awards',
      rowStart: 6001,
      rowEnd: 6001,
    });
    expect(result.text).toContain('Row 6001\t3:Final award condition');
  });

  it('reads long slide text without the old per-slide clipping', async () => {
    const { default: JSZip } = await import('jszip');
    const zip = new JSZip();
    zip.file('ppt/slides/slide1.xml', '<p:sld><a:t>First slide</a:t></p:sld>');
    zip.file(
      'ppt/slides/slide2.xml',
      `<p:sld><a:t>${'details '.repeat(4000)}Final facility limitation</a:t></p:sld>`,
    );
    const result = await extractAttachmentSection(
      await zip.generateAsync({ type: 'nodebuffer' }),
      'pptx',
      2,
    );
    expect(result).toMatchObject({ section: 2, sectionCount: 2, sectionKind: 'slide' });
    expect(result.text.length).toBeGreaterThan(20000);
    expect(result.text).toContain('Final facility limitation');
  });
});
