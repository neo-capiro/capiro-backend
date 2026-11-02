import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const resourceProbe = `
import net from 'node:net';
let network = 0;
net.Socket.prototype.connect = () => { network++; throw Error('Unexpected network request'); };
globalThis.fetch = () => { network++; throw Error('Unexpected provider request'); };
process.on('exit', () => process.stderr.write('NETWORK_ATTEMPTS=' + network + '\\n'));
`;
const probeUrl = `data:text/javascript,${encodeURIComponent(resourceProbe)}`;

// Exercise real script imports and the actual CLI path with no ambient credentials.
describe('bill ingestion CLI safety', () => {
  for (const script of ['embed-bill-passages', 'index-bill-passages', 'bill-text-postgres-smoke']) {
    it.each([
      { args: [] as string[], exit: 2 },
      { args: ['--help'], exit: 0 },
      { args: ['--cleanup-smoke-unknown-flag'], exit: 2 },
    ])(
      `${script} handles $args before database/provider access`,
      ({ args, exit }) => {
        const result = spawnSync(
          process.execPath,
          ['--import', 'tsx', '--import', probeUrl, join(__dirname, `${script}.ts`), ...args],
          {
            cwd: join(__dirname, '..'),
            env: {
              PATH: process.env.PATH,
              SystemRoot: process.env.SystemRoot,
              TEMP: process.env.TEMP,
              TMP: process.env.TMP,
              TSX_DISABLE_CACHE: '1',
              DOTENV_CONFIG_PATH: join(__dirname, '__absent_bill_fixture_env__'),
            },
            encoding: 'utf8',
            timeout: 20000,
          },
        );
        expect(result.error).toBeUndefined();
        expect(result.status).toBe(exit);
        expect(result.stdout + result.stderr).toContain('Usage:');
        expect(result.stderr).toContain('NETWORK_ATTEMPTS=0');
      },
      25000,
    );
  }
  it('registers the bill verbs in the safe wrapper and preserves legacy delegation', () => {
    const entrypoint = readFileSync(join(__dirname, 'entrypoint.sh'), 'utf8');
    const billCase = entrypoint.search(/^\s+index-bill-passages\|embed-bill-passages(?:\|[a-z-]+)*\)/m);
    const fallback = entrypoint.indexOf('exec /bin/sh /usr/local/lib/capiro/entrypoint-legacy.sh');
    expect(billCase).toBeGreaterThan(-1);
    expect(billCase).toBeLessThan(fallback);
    expect(entrypoint.slice(billCase, entrypoint.indexOf(';;', billCase))).toContain(
      'exec ./node_modules/.bin/tsx "scripts/$bill_command.ts" "$@"',
    );
  });
});
