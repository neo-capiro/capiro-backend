import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

const entrypoint = join(__dirname, 'entrypoint.sh');
describe('forecast commands preserve the existing entrypoint safety envelope', () => {
  it.each(['sync-government-forecasts', 'refresh-government-forecasts'])(
    '%s forwards arguments and preserves supplied DB authority without DB_* composition',
    (verb) => {
      const dir = mkdtempSync(join(tmpdir(), 'forecast-dispatch-'));
      try {
        mkdirSync(join(dir, 'node_modules/.bin'), { recursive: true });
        const stub = join(dir, 'node_modules/.bin/tsx');
        writeFileSync(stub, '#!/bin/sh\nprintf "%s\\n" "$DATABASE_URL" "$@"\n');
        chmodSync(stub, 0o755);
        const env: NodeJS.ProcessEnv = {
          ...process.env,
          TMPDIR: dir.replaceAll('\\', '/'),
          DATABASE_URL: 'postgresql://synthetic/synthetic?connection_limit=1',
          DB_HOST: '',
          DB_PORT: '',
          DB_USER: '',
          DB_NAME: '',
          DB_PASSWORD: '',
        };
        delete env.MERI_CONTROL_ORIGIN;
        delete env.MERI_CONTROL_CA_BASE64;
        delete env.MERI_CONTROL_CA_SHA256;
        const args = [
          '--input',
          '/archive/path with spaces.xml',
          '--run-id',
          'daily-20261101',
          '--apply',
        ];
        const output = execFileSync('sh', [entrypoint.replaceAll('\\', '/'), verb, ...args], {
          cwd: dir,
          env,
          encoding: 'utf8',
        });
        expect(output.trim().split(/\r?\n/)).toEqual([
          env.DATABASE_URL,
          `scripts/${verb}.ts`,
          ...args,
        ]);
      } finally {
        if (
          dirname(resolve(dir)) !== resolve(tmpdir()) ||
          !basename(dir).startsWith('forecast-dispatch-')
        )
          throw new Error('Unsafe fixture cleanup');
        rmSync(dir, { recursive: true });
      }
    },
  );
  it('parses as POSIX shell and is not implicitly added to default backfill', () => {
    execFileSync('sh', ['-n', entrypoint.replaceAll('\\', '/')]);
    expect(readFileSync(join(__dirname, 'backfill-all.ts'), 'utf8')).not.toContain(
      'government-forecasts',
    );
    const text = readFileSync(entrypoint, 'utf8');
    expect(text.indexOf('\nselect_writable_tmpdir\n')).toBeLessThan(
      text.indexOf('\n  refresh-government-forecasts)'),
    );
    expect(text).toContain('exec /bin/sh /usr/local/lib/capiro/entrypoint-legacy.sh "$@"');
  });
});
