import { generatedOoxmlBytes, generatedPdfBytes, generatedPngBase64 } from './meri-artifact-test-fixtures.js';
import {
  readPersistedPng,
  sha256Bytes,
  validateDocumentArtifactBytes,
  validatePngBase64,
} from './meri-artifact-integrity.js';

describe('Meri artifact byte integrity', () => {
  test('rejects fake ZIP and PDF signatures that are not readable documents', async () => {
    const fakeZip = Buffer.from([0x50, 0x4b, 3, 4, 0x50, 0x4b, 5, 6]);
    const fakePdf = Buffer.from('%PDF-1.7\nnot a document\n%%EOF');
    await expect(validateDocumentArtifactBytes('docx', fakeZip)).rejects.toThrow();
    await expect(validateDocumentArtifactBytes('xlsx', fakeZip)).rejects.toThrow();
    await expect(validateDocumentArtifactBytes('pdf', fakePdf)).rejects.toThrow();
  });

  test.each(['docx', 'xlsx', 'pptx'] as const)(
    'opens generated %s ZIP bytes, verifies CRCs and requires its actual OOXML main part',
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
  });
});
