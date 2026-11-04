import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

const script = resolve(__dirname, 'generate-profile-build-reference-catalog.ts');
const snapshot = resolve(__dirname, '../src/clients/reference-data/naics-psc.generated.json');

function run(args: string[]) {
  return spawnSync(process.execPath, ['--import', 'tsx', script, ...args], {
    cwd: resolve(__dirname, '..'), encoding: 'utf8', timeout: 10_000,
  });
}

describe('reference catalog generator CLI', () => {
  it('advertises usage and exit codes without generation, and rejects invalid flags before download', () => {
    const before = readFileSync(snapshot, 'utf8');
    const help = run(['--help']);
    expect(help.status).toBe(0);
    expect(help.stdout).toContain('Exit codes: 0 success; 1 source/validation/reproduction failure; 2 invalid arguments.');
    for (const args of [[], ['--unknown'], ['--download', '--source-dir', '/nonexistent'], ['--download', '--unknown']]) {
      const result = run(args);
      expect(result.status).toBe(2);
      expect(result.stderr).toContain('Usage:');
    }
    expect(readFileSync(snapshot, 'utf8')).toBe(before);
  });

  it('fails closed on changed source bytes before parsing or replacing the pinned data', () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'profile-reference-checksum-'));
    const before = readFileSync(snapshot, 'utf8');
    try {
      writeFileSync(resolve(dir, '2022_NAICS_Structure.xlsx'), 'changed source');
      const result = run(['--source-dir', dir]);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('source checksum changed');
      expect(readFileSync(snapshot, 'utf8')).toBe(before);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('can be imported without starting generation, network or output', () => {
    const result = spawnSync(process.execPath, ['--import', 'tsx', '-e', 'require(process.argv[1])', script], {
      cwd: resolve(__dirname, '..'), encoding: 'utf8', timeout: 10_000,
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('');
  });
});
