import childProcess, { type ChildProcess } from 'node:child_process';
import { extractWebPdfText } from './meri-web-pdf-worker.js';
import { withGuardedWebResponse } from './hardenedWebTransport.js';

jest.mock('node:dns/promises', () => ({
  lookup: jest.fn(async () => [{ address: '93.184.216.34', family: 4 }]),
}));

function smallPdf(): Uint8Array {
  const stream = 'BT /F1 12 Tf 72 720 Td (Meri public PDF) Tj ET';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((value, index) => {
    offsets.push(pdf.length);
    pdf += `${index + 1} 0 obj\n${value}\nendobj\n`;
  });
  const xref = pdf.length;
  pdf += `xref\n0 6\n0000000000 65535 f \n${offsets
    .slice(1)
    .map((offset) => String(offset).padStart(10, '0') + ' 00000 n ')
    .join('\n')}\ntrailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(pdf);
}

describe('public PDF extraction worker', () => {
  const originalFetch = global.fetch;
  beforeEach(() => {
    global.fetch = jest.fn().mockResolvedValue(new Response(null));
  });
  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it('extracts a real PDF in a worker and joins its termination', async () => {
    const spawn = jest.spyOn(childProcess, 'spawn');
    const result = await withGuardedWebResponse(
      'https://example.com/report.pdf',
      (_response, _url, scope) => extractWebPdfText(smallPdf(), scope),
    );
    expect(result.text).toContain('Meri public PDF');
    expect(result.pages).toBe(1);
    expect(spawn).toHaveBeenCalledTimes(1);
    const worker = spawn.mock.results[0]!.value as ChildProcess;
    expect(worker.exitCode !== null || worker.signalCode !== null).toBe(true);
  });

  it('terminates an actual parser worker when the shared deadline expires', async () => {
    const spawn = jest.spyOn(childProcess, 'spawn');
    await expect(
      withGuardedWebResponse(
        'https://example.com/report.pdf',
        async (_response, _url, scope) => {
          const pending = extractWebPdfText(smallPdf(), scope);
          // The same request scope is cancelled while the worker is loading/parsing.
          await pending;
        },
        { deadlineMs: 20 },
      ),
    ).rejects.toThrow('timed out');
    expect(spawn).toHaveBeenCalledTimes(1);
    const worker = spawn.mock.results[0]!.value as ChildProcess;
    expect(worker.killed).toBe(true);
    expect(worker.exitCode !== null || worker.signalCode !== null).toBe(true);
  });
});
