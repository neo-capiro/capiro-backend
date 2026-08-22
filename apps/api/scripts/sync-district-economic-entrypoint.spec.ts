import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const dispatcher = readFileSync(join(__dirname, 'entrypoint-dispatcher.inc'), 'utf8');

describe('District Nexus Release 3 economic-source container commands', () => {
  const verbs = [
    ['sync-district-economic-acs', 'sync-district-economic-acs.ts'],
    ['sync-district-economic-cbp', 'sync-district-economic-cbp.ts'],
    ['sync-district-economic-lodes', 'sync-district-economic-lodes.ts'],
  ] as const;

  for (const [verb, script] of verbs) {
    test(`${verb} dispatches to ${script}`, () => {
      expect(dispatcher).toContain(`exec ./node_modules/.bin/tsx scripts/${script}`);
    });

    test(`${verb} is listed in the unknown-command usage message`, () => {
      expect(dispatcher).toMatch(new RegExp(`expected:.*\\b${verb}\\b`));
    });
  }

  test('entrypoint-dispatcher.inc still parses as valid shell', () => {
    try {
      execFileSync('sh', ['-n', join(__dirname, 'entrypoint-dispatcher.inc')], { stdio: 'pipe' });
    } catch (err) {
      const e = err as { code?: string; stderr?: Buffer };
      if (e.code === 'ENOENT') return; // no POSIX shell on this box -- not evidence about the file
      throw new Error(e.stderr?.toString().trim() || 'parse failed');
    }
  });
});
