import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

test('pdf-parse and unpdf read the fixture PDF with no pdf.js warnings', () => {
  const output = execFileSync(process.execPath, [join(__dirname, 'verify-pdf-text-extraction.cjs')], {
    encoding: 'utf8',
  });
  expect(output).toContain('pdf text extraction ok');
}, 60_000);
