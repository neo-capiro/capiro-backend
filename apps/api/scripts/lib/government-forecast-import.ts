import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export function validateImportReceipt(stdout: string, args: string[]) {
  const value: unknown = JSON.parse(stdout.trim());
  if (!value || typeof value !== 'object') throw new Error('IMPORT_RECEIPT_INVALID');
  const receipt = value as Record<string, unknown>;
  const count = (x: unknown) => typeof x === 'number' && Number.isSafeInteger(x) && x >= 0;
  const valid = args.includes('--record-failure')
    ? receipt.mode === 'record-failure' && receipt.recorded === true
    : args.includes('--apply')
      ? receipt.mode === 'apply' &&
        typeof receipt.checkId === 'string' &&
        /^\d+$/.test(receipt.checkId) &&
        count(receipt.accepted) &&
        count(receipt.rejected) &&
        typeof receipt.replay === 'boolean'
      : receipt.mode === 'dry-run' && count(receipt.candidates) && count(receipt.rejected);
  if (!valid) throw new Error('IMPORT_RECEIPT_INVALID');
  return receipt;
}

/** Existing importer in a bounded child; any error after apply starts is uncertain. */
export function invokeForecastImporter(args: string[]): Promise<Record<string, unknown>> {
  return new Promise((accept, reject) => {
    execFile(
      process.execPath,
      [
        '--import',
        pathToFileURL(require.resolve('tsx')).href,
        resolve(__dirname, '../sync-government-forecasts.ts'),
        ...args,
      ],
      {
        cwd: resolve(__dirname, '../..'),
        env: process.env,
        timeout: 150000,
        maxBuffer: 64 * 1024,
        windowsHide: true,
      },
      (error, stdout) => {
        // Do not expose child stderr, environment, connection strings or raw exception text.
        if (error) {
          reject(new Error('IMPORT_PROCESS_FAILED'));
          return;
        }
        try {
          accept(validateImportReceipt(stdout, args));
        } catch {
          reject(new Error('IMPORT_RECEIPT_INVALID'));
        }
      },
    );
  });
}
