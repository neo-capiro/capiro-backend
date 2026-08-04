/**
 * R8.1-G — Operator review CLI refusal behavior.
 *
 * These invoke the actual TSX entry point in a child process. They require no
 * DATABASE_URL because parse/required-input refusals happen before Prisma is
 * created, so they cannot reach a database or write a review decision.
 */
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';

describe('review-defense-budget-verification-v1 CLI', () => {
  const script = path.join(__dirname, 'review-defense-budget-verification-v1.ts');
  const tsxCli = require.resolve('tsx/cli');

  function invoke(args: string[]) {
    return spawnSync(process.execPath, [tsxCli, script, ...args], {
      cwd: process.cwd(),
      env: { ...process.env, DATABASE_URL: '' },
      encoding: 'utf8',
    });
  }

  it('refuses an unknown flag with exit code 1 before database initialization', () => {
    const result = invoke(['--unexpected-flag']);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Unknown flag: --unexpected-flag');
    expect(result.stderr).not.toContain('Database connection required');
  });

  it('refuses incomplete required review input with exit code 1 before database initialization', () => {
    const result = invoke(['--candidate-id', 'candidate-example']);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Missing --run-id');
    expect(result.stderr).not.toContain('Database connection required');
  });
});
