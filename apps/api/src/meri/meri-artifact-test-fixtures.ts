import { deflateSync } from 'node:zlib';
import JSZip from 'jszip';
import { PDFDocument, StandardFonts } from 'pdf-lib';

let crcTable: Uint32Array | undefined;
function crc32(bytes: Buffer): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let value = n;
      for (let bit = 0; bit < 8; bit += 1) value = (value & 1) ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
      crcTable[n] = value >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const kind = Buffer.from(type, 'ascii');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([kind, data])));
  return Buffer.concat([length, kind, data, checksum]);
}

export function generatedPngBase64(red = 31): string {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0);
  ihdr.writeUInt32BE(1, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const raster = Buffer.from([0, red & 0xff, 97, 173, 255]);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raster)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]).toString('base64');
}

export async function generatedPdfBytes(text = 'Generated artifact fixture'): Promise<Buffer> {
  const document = await PDFDocument.create();
  const page = document.addPage([300, 200]);
  const font = await document.embedFont(StandardFonts.Helvetica);
  page.drawText(text, { x: 24, y: 150, font, size: 12 });
  return Buffer.from(await document.save({ useObjectStreams: false }));
}

const OOXML = {
  docx: {
    path: 'word/document.xml',
    relationshipType: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument',
    contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml',
    xml: '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Generated document fixture</w:t></w:r></w:p></w:body></w:document>',
  },
  xlsx: {
    path: 'xl/workbook.xml',
    relationshipType: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument',
    contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml',
    xml: '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheets/></workbook>',
  },
  pptx: {
    path: 'ppt/presentation.xml',
    relationshipType: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument',
    contentType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml',
    xml: '<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:sldIdLst/></p:presentation>',
  },
} as const;

export async function generatedOoxmlBytes(format: keyof typeof OOXML): Promise<Buffer> {
  const fixture = OOXML[format];
  const zip = new JSZip();
  zip.file('[Content_Types].xml', `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/${fixture.path}" ContentType="${fixture.contentType}"/></Types>`);
  zip.file('_rels/.rels', `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${fixture.relationshipType}" Target="${fixture.path}"/></Relationships>`);
  zip.file(fixture.path, fixture.xml);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}
