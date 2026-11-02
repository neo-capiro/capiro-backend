import { captureFederalResponse, assertFederalSourceCapture } from './capture.js';

describe('federal response-byte capture', () => {
  test('preserves exact BOM, CRLF, entity, non-ASCII and supplementary Unicode bytes', async () => {
    const bytes = Buffer.from(
      '\uFEFF<?xml version="1.0" encoding="UTF-8"?>\r\n<x>€ 😀 &amp;</x>\r\n',
    );
    const result = await captureFederalResponse(
      new Response(bytes, { headers: { 'content-type': 'application/xml; charset=UTF-8' } }),
      'xml',
    );
    expect(Buffer.from(result.text)).toEqual(bytes);
    expect(result.text.charCodeAt(0)).toBe(0xfeff);
    expect(result.capture.byteLength).toBe(bytes.length);
    expect(assertFederalSourceCapture(result.text, result.capture)).toEqual(result.capture);
    expect(() => assertFederalSourceCapture(result.text + 'x', result.capture)).toThrow();
  });
  test.each([
    [Buffer.from([0xc3, 0x28]), 'application/xml'],
    [Buffer.from('x\0y'), 'text/plain'],
    [Buffer.alloc(0), 'text/plain'],
    [Buffer.from('<x/>'), 'application/xml; charset=ISO-8859-1'],
    [Buffer.from('<?xml version="1.0" encoding="ISO-8859-1"?><x/>'), 'application/xml'],
  ])(
    'refuses invalid or unsupported captured bytes without a receipt',
    async (bytes, contentType) => {
      await expect(
        captureFederalResponse(
          new Response(bytes as Buffer, { headers: { 'content-type': contentType as string } }),
          'xml',
        ),
      ).rejects.toThrow();
    },
  );
  test('bounds actual stream bytes with no trusted Content-Length and cancels on overflow', async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(8));
      },
      cancel() {
        cancelled = true;
      },
    });
    await expect(captureFederalResponse(new Response(body), 'txt', 4)).rejects.toThrow();
    expect(cancelled).toBe(true);
    expect(body.locked).toBe(false);
  });
  test('rejects a declared oversize body before reading and releases its reader', async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
      },
    });
    await expect(
      captureFederalResponse(new Response(body, { headers: { 'content-length': '5' } }), 'txt', 4),
    ).rejects.toThrow();
    expect(cancelled).toBe(true);
    expect(body.locked).toBe(false);
  });
  test('midstream failure releases the reader and cannot produce a receipt', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error('synthetic read failure'));
      },
    });
    await expect(captureFederalResponse(new Response(body), 'txt')).rejects.toThrow(
      'synthetic read failure',
    );
    expect(body.locked).toBe(false);
  });
  test('general evidence capture retains sources larger than the dedicated workbench bound', async () => {
    const text = 'x'.repeat(200000);
    const result = await captureFederalResponse(new Response(text), 'txt');
    expect(result.text).toBe(text);
    expect(result.capture.byteLength).toBe(200000);
  });
});
