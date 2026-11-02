import {
  byteHash,
  readFederalBytes,
  decodeFederalUtf8,
  qualifyFederalOriginal,
  FEDERAL_DOCUMENT_MAX_BYTES,
} from './federal-document-bytes';
describe('exact federal original byte retention', () => {
  const original = (bytes: Buffer) => ({
    base64: bytes.toString('base64'),
    sha256: byteHash(bytes),
    mime: 'application/xml; charset=utf-8',
  });
  it('retains exact original bytes and distinguishes equal decoded text with different BOM bytes', async () => {
    const plain = Buffer.from('<bill>Text</bill>'),
      bom = Buffer.concat([Buffer.from([239, 187, 191]), plain]);
    const one = qualifyFederalOriginal(
      decodeFederalUtf8(plain, 'application/xml'),
      original(plain),
    );
    const two = qualifyFederalOriginal(decodeFederalUtf8(bom, 'application/xml'), original(bom));
    expect(one.parserVersion).not.toBe(two.parserVersion);
    expect(two.parserVersion.length).toBeLessThanOrEqual(64);
    expect(Buffer.from(two.metadata.originalBytesBase64, 'base64')).toEqual(bom);
    const response = new Response(bom);
    expect(await readFederalBytes(response, AbortSignal.timeout(1000))).toEqual(bom);
  });
  it('rejects wrong hash, decoded content, unsupported encoding and oversized headers', async () => {
    const bytes = Buffer.from('<bill/>');
    expect(() => qualifyFederalOriginal('different', original(bytes))).toThrow(
      'FEDERAL_ORIGINAL_DECODE_MISMATCH',
    );
    expect(() =>
      qualifyFederalOriginal('<bill/>', { ...original(bytes), sha256: '0'.repeat(64) }),
    ).toThrow('FEDERAL_ORIGINAL_HASH_MISMATCH');
    expect(() => decodeFederalUtf8(Buffer.from([255]), 'text/plain')).toThrow(
      'ENCODING_UNSUPPORTED',
    );
    expect(() => decodeFederalUtf8(bytes, 'text/plain; charset=windows-1252')).toThrow(
      'CHARSET_UNSUPPORTED',
    );
    await expect(
      readFederalBytes(
        new Response(bytes, {
          headers: { 'content-length': String(FEDERAL_DOCUMENT_MAX_BYTES + 1) },
        }),
        AbortSignal.timeout(1000),
      ),
    ).rejects.toThrow('SIZE_LIMIT');
  });
  it('bounds actual streamed bytes and cancels a body stalled beyond its deadline', async () => {
    const response = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(FEDERAL_DOCUMENT_MAX_BYTES));
          controller.enqueue(new Uint8Array(1));
          controller.close();
        },
      }),
    );
    await expect(readFederalBytes(response, AbortSignal.timeout(1000))).rejects.toThrow(
      'SIZE_LIMIT',
    );
    let cancelled = false;
    const controller = new AbortController();
    const pending = readFederalBytes(
      new Response(
        new ReadableStream({
          cancel() {
            cancelled = true;
          },
        }),
      ),
      controller.signal,
    );
    controller.abort();
    await expect(pending).rejects.toThrow('DEADLINE');
    expect(cancelled).toBe(true);
  });
  it('admits retained unsupported bytes only with an explicit empty unreadable projection', () => {
    const bytes = Buffer.from([255]);
    const bad = { ...original(bytes), encoding: 'unsupported' as const };
    expect(
      qualifyFederalOriginal('', bad, { completeness: 'unreadable', extractedText: '' }).metadata
        .originalBytesEncoding,
    ).toBe('unsupported');
    expect(() =>
      qualifyFederalOriginal('', bad, { completeness: 'complete', extractedText: 'invented' }),
    ).toThrow('FEDERAL_ORIGINAL_UNREADABLE_REQUIRED');
    const pdf = Buffer.from('%PDF-original');
    const source = { ...original(pdf), mime: 'application/pdf', encoding: 'pdf' as const };
    expect(
      qualifyFederalOriginal(source.base64, source, {
        completeness: 'partial',
        extractedText: 'Native portion',
      }).metadata.rawContentEncoding,
    ).toBe('base64');
  });
});
