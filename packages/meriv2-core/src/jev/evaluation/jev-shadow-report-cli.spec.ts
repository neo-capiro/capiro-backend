import { afterEach, describe, expect, it } from '@jest/globals';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true });
});

describe('jev shadow report CLI', () => {
  it('uses live events only unless fixture replay is explicitly requested', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'jev-shadow-cli-'));
    directories.push(directory);
    const events = path.join(directory, 'events.jsonl');
    const recordings = path.join(directory, 'recordings.jsonl');
    const out = path.join(directory, 'out');
    writeFileSync(events, '');
    writeFileSync(recordings, '');
    const packageRoot = path.resolve(__dirname, '../../..');
    const tsx = path.join(packageRoot, 'node_modules/tsx/dist/cli.mjs');
    const script = path.join(packageRoot, 'scripts/jev-shadow-report.ts');
    const output = execFileSync(
      process.execPath,
      [tsx, script, '--events', events, '--recordings', recordings, '--out', out],
      { encoding: 'utf8' },
    );
    expect(output).toContain('0 live events, 0 replay misses');
    expect(existsSync(path.join(out, 'shadow-report.json'))).toBe(true);
    expect(readFileSync(path.join(out, 'shadow-report.md'), 'utf8')).toContain('## No live events');

    const replayOut = path.join(directory, 'replay-out');
    const replayOutput = execFileSync(
      process.execPath,
      [
        tsx,
        script,
        '--events',
        events,
        '--recordings',
        recordings,
        '--include-fixtures',
        '--out',
        replayOut,
      ],
      { encoding: 'utf8' },
    );
    expect(replayOutput).toContain('0 live events, 24 replay misses');
  });
});
