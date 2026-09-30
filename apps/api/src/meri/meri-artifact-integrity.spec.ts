import { deflateSync } from 'node:zlib';
import JSZip from 'jszip';
import { generatedOoxmlBytes, generatedPdfBytes, generatedPngBase64 } from './meri-artifact-test-fixtures.js';
import {
  PERSISTED_PNG_BYTE_AUTHORITY,
  readPersistedPng,
  sha256Bytes,
  validateDocumentArtifactBytes,
  validatePngBase64,
} from './meri-artifact-integrity.js';

function testCrc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc & 1) ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const name = Buffer.from(type, 'ascii');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(testCrc32(Buffer.concat([name, data])));
  return Buffer.concat([length, name, data, crc]);
}

function indexedPng(index: number): string {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0);
  ihdr.writeUInt32BE(1, 4);
  ihdr[8] = 8;
  ihdr[9] = 3;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('PLTE', Buffer.from([255, 0, 0])),
    pngChunk('IDAT', deflateSync(Buffer.from([0, index]))),
    pngChunk('IEND', Buffer.alloc(0)),
  ]).toString('base64');
}

async function craftedDocx(parts: {
  contentTypes: string;
  relationships: string;
  main: string;
}): Promise<Buffer> {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', parts.contentTypes);
  zip.file('_rels/.rels', parts.relationships);
  zip.file('word/document.xml', parts.main);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

describe('Meri artifact byte integrity', () => {
  test('rejects fake ZIP and PDF signatures that are not readable documents', async () => {
    const fakeZip = Buffer.from([0x50, 0x4b, 3, 4, 0x50, 0x4b, 5, 6]);
    const fakePdf = Buffer.from('%PDF-1.7\nnot a document\n%%EOF');
    await expect(validateDocumentArtifactBytes('docx', fakeZip)).rejects.toThrow();
    await expect(validateDocumentArtifactBytes('xlsx', fakeZip)).rejects.toThrow();
    await expect(validateDocumentArtifactBytes('pdf', fakePdf)).rejects.toThrow();
  });

  test.each(['docx', 'xlsx', 'pptx'] as const)(
    'parses generated %s ZIP bytes, bounded streams, CRCs and its namespaced OOXML main part',
    async (format) => {
      const bytes = await generatedOoxmlBytes(format);
      await expect(validateDocumentArtifactBytes(format, bytes)).resolves.toBeUndefined();
      const wrong = format === 'docx' ? 'xlsx' : 'docx';
      await expect(validateDocumentArtifactBytes(wrong, bytes)).rejects.toThrow('ooxml_required_part_missing');
      const corrupt = Buffer.from(bytes);
      const corruptOffset = Math.floor(corrupt.length / 3);
      corrupt.writeUInt8(corrupt.readUInt8(corruptOffset) ^ 1, corruptOffset);
      await expect(validateDocumentArtifactBytes(format, corrupt)).rejects.toThrow();
    },
  );

  test('rejects comment-only OOXML proof, wrong namespaces and a wrong main root', async () => {
    const relationshipType = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument';
    const contentType = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml';
    const contentTypes = `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="${contentType}"/></Types>`;
    const relationships = `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${relationshipType}" Target="word/document.xml"/></Relationships>`;
    const main = '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body/></w:document>';

    await expect(validateDocumentArtifactBytes('docx', await craftedDocx({
      contentTypes: `<Types><!-- <Override PartName="/word/document.xml" ContentType="${contentType}"/> --></Types>`,
      relationships: `<Relationships><!-- <Relationship Type="${relationshipType}" Target="word/document.xml"/> --></Relationships>`,
      main: '<not-a-word-document/>',
    }))).rejects.toThrow();
    await expect(validateDocumentArtifactBytes('docx', await craftedDocx({
      contentTypes: contentTypes.replace('package/2006/content-types', 'wrong/content-types'),
      relationships,
      main,
    }))).rejects.toThrow('ooxml_type_mismatch');
    await expect(validateDocumentArtifactBytes('docx', await craftedDocx({
      contentTypes,
      relationships: relationships.replace('package/2006/relationships', 'wrong/relationships'),
      main,
    }))).rejects.toThrow('ooxml_relationship_mismatch');
    await expect(validateDocumentArtifactBytes('docx', await craftedDocx({
      contentTypes,
      relationships,
      main: '<w:workbook xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"/>',
    }))).rejects.toThrow('ooxml_main_root_mismatch');
  });

  test('bounds ZIP inflation before CRC verification', async () => {
    const bytes = Buffer.from(await generatedOoxmlBytes('docx'));
    const name = Buffer.from('word/document.xml');
    let central = -1;
    for (let offset = 0; offset + 46 + name.length <= bytes.length; offset += 1) {
      if (bytes.readUInt32LE(offset) === 0x02014b50 && bytes.subarray(offset + 46, offset + 46 + name.length).equals(name)) {
        central = offset;
        break;
      }
    }
    expect(central).toBeGreaterThanOrEqual(0);
    const local = bytes.readUInt32LE(central + 42);
    bytes.writeUInt32LE(1, central + 24);
    bytes.writeUInt32LE(1, local + 22);
    await expect(validateDocumentArtifactBytes('docx', bytes)).rejects.toThrow('ooxml_decompression_bound_exceeded');
  });

  test('opens a generated PDF and rejects a same-signature unreadable body', async () => {
    await expect(validateDocumentArtifactBytes('pdf', await generatedPdfBytes())).resolves.toBeUndefined();
    await expect(validateDocumentArtifactBytes('pdf', Buffer.from('%PDF-1.7\n%%EOF'))).rejects.toThrow();
  });

  test('requires bounded PNG chunks, CRCs and valid inflation, and enforces persisted hashes', () => {
    const base64 = generatedPngBase64();
    const valid = validatePngBase64(base64);
    expect(valid).toMatchObject({ width: 1, height: 1, sha256: expect.stringMatching(/^[0-9a-f]{64}$/) });

    const corruptCrc = Buffer.from(base64, 'base64');
    corruptCrc.writeUInt8(corruptCrc.readUInt8(corruptCrc.length - 1) ^ 1, corruptCrc.length - 1);
    expect(validatePngBase64(corruptCrc.toString('base64'))).toBeNull();
    expect(validatePngBase64(Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from('not-png-chunks'),
    ]).toString('base64'))).toBeNull();

    const corruptInflation = Buffer.from(base64, 'base64');
    const idat = corruptInflation.indexOf(Buffer.from('IDAT'));
    expect(idat).toBeGreaterThan(0);
    corruptInflation.writeUInt8(corruptInflation.readUInt8(idat + 4) ^ 1, idat + 4);
    expect(validatePngBase64(corruptInflation.toString('base64'))).toBeNull();

    expect(readPersistedPng({ imageBase64: base64 })).toMatchObject({
      integrityPolicy: 'validated_legacy_no_persisted_hash',
    });
    expect(readPersistedPng({
      imageBase64: base64,
      imageSha256: sha256Bytes(Buffer.from(base64, 'base64')),
    })).toMatchObject({ integrityPolicy: 'persisted_hash_match' });
    expect(readPersistedPng({ imageBase64: base64, imageSha256: '0'.repeat(64) })).toBeNull();
    expect(validatePngBase64(indexedPng(0))).not.toBeNull();
    expect(validatePngBase64(indexedPng(1))).toBeNull();
    expect(readPersistedPng({
      imageBase64: base64,
      imageByteAuthority: PERSISTED_PNG_BYTE_AUTHORITY,
    })).toBeNull();
    expect(readPersistedPng({
      imageBase64: base64,
      imageSha256: sha256Bytes(Buffer.from(base64, 'base64')),
      imageByteAuthority: PERSISTED_PNG_BYTE_AUTHORITY,
    })).toMatchObject({ integrityPolicy: 'persisted_hash_match' });
  });
});
