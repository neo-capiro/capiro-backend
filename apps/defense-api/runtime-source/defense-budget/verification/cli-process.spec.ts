/**
 * R8.3 — actual operator CLI refusal tests.
 *
 * These execute the TSX entry points in child processes. The tested paths
 * fail during argument parsing, before any database or AWS client is created.
 */
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';

const scriptsDir = path.join(__dirname, '..', '..', '..', 'scripts');
const tsxCli = require.resolve('tsx/cli');

function invoke(scriptName: string, args: string[]) {
  return spawnSync(process.execPath, [tsxCli, path.join(scriptsDir, scriptName), ...args], {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_URL: '' },
    encoding: 'utf8',
  });
}

describe('Phase 2 operator CLI process behavior', () => {
  it('verify CLI refuses unknown flags with exit code 4', () => {
    const result = invoke('verify-defense-budget-extraction-v1.ts', ['--unexpected-flag']);
    expect(result.status).toBe(4);
    expect(result.stderr).toContain('Unknown flag: --unexpected-flag');
    expect(result.stderr).not.toContain('production proof wiring');
  });

  it('verify CLI refuses incomplete input before proof wiring', () => {
    const result = invoke('verify-defense-budget-extraction-v1.ts', [
      '--manifest',
      '/tmp/missing.json',
    ]);
    expect(result.status).toBe(4);
    expect(result.stderr).toContain('Missing --document');
    expect(result.stderr).not.toContain('production proof wiring');
  });

  it('cycle report refuses unknown flags with exit code 1', () => {
    const result = invoke('report-defense-budget-verification-cycle-v1.ts', [
      '--unexpected-flag',
    ]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Unknown flag: --unexpected-flag');
  });

  it('cycle report refuses missing manifest input with exit code 1', () => {
    const result = invoke('report-defense-budget-verification-cycle-v1.ts', []);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Usage: report-defense-budget-verification-cycle-v1');
  });
});
