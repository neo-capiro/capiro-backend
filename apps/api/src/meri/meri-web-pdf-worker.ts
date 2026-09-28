import { spawn } from 'node:child_process';
import { BadGatewayException } from '@nestjs/common';
import type { WebReadScope } from './hardenedWebTransport.js';

// A process boundary also contains native PDF dependencies that cannot safely
// unload during worker-thread termination. Input and output never touch disk.
const workerProgram = `
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { input += chunk; if (input.length > 32000000) process.exit(2); });
process.stdin.on('end', async () => {
  try {
    const data = JSON.parse(input);
    const { PDFParse } = require(data.pdfModule);
    const parser = new PDFParse({ data: new Uint8Array(Buffer.from(data.bytes, 'base64')) });
    try {
      const result = await parser.getText();
      const text = (result.text ?? '').replace(/\\s+/g, ' ').trim();
      process.stdout.write(JSON.stringify({ text: text.slice(0, data.maxChars + 1), totalChars: text.length, pages: result.total ?? 0 }));
    } finally { await parser.destroy(); }
  } catch { process.exitCode = 2; }
});
`;

export async function extractWebPdfText(
  bytes: Uint8Array,
  scope: WebReadScope,
  maxChars = 20_000,
): Promise<{ text: string; totalChars: number; pages: number }> {
  scope.check();
  if (
    bytes.length > 15 * 1024 * 1024 ||
    !Number.isInteger(maxChars) ||
    maxChars < 1 ||
    maxChars > 20_000
  ) {
    throw new BadGatewayException('PDF extraction bounds exceeded');
  }
  const child = spawn(process.execPath, ['--max-old-space-size=128', '-e', workerProgram], {
    stdio: ['pipe', 'pipe', 'ignore'],
    windowsHide: true,
  });
  const exited = new Promise<void>((resolve) => child.once('close', () => resolve()));
  let termination: Promise<void> | undefined;
  const terminate = () =>
    (termination ??= (async () => {
      if (child.exitCode === null && child.signalCode === null) child.kill();
      await exited;
    })());
  const unregister = scope.registerCleanup(terminate);
  try {
    return await scope.wait(
      new Promise<{ text: string; totalChars: number; pages: number }>((resolve, reject) => {
        const fail = () => reject(new BadGatewayException('PDF text extraction failed'));
        let output = '';
        child.once('error', fail);
        child.stdin.once('error', fail);
        child.stdout.setEncoding('utf8');
        child.stdout.on('data', (chunk: string) => {
          output += chunk;
          if (Buffer.byteLength(output) > 512_000) {
            child.kill();
            fail();
          }
        });
        child.once('close', (code) => {
          if (code !== 0) return fail();
          try {
            const value = JSON.parse(output) as Record<string, unknown>;
            if (
              typeof value.text !== 'string' ||
              value.text.length > maxChars + 1 ||
              typeof value.totalChars !== 'number' ||
              !Number.isSafeInteger(value.totalChars) ||
              value.totalChars < value.text.length ||
              typeof value.pages !== 'number' ||
              !Number.isSafeInteger(value.pages) ||
              value.pages < 0
            )
              return fail();
            resolve({ text: value.text, totalChars: value.totalChars, pages: value.pages });
          } catch {
            fail();
          }
        });
        child.stdin.end(
          JSON.stringify({
            pdfModule: require.resolve('pdf-parse'),
            bytes: Buffer.from(bytes).toString('base64'),
            maxChars,
          }),
        );
      }),
    );
  } finally {
    await terminate();
    unregister();
  }
}
