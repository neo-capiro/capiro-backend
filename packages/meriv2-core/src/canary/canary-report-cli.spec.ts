import { afterEach, describe, expect, it } from '@jest/globals';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true }); });

const sample = { event: 'meri.canary.turn', conversationId: 'c', tenantId: 't', surface: 'chat', modes: {},
  outcome: 'released', clarificationRequested: false, heldReason: null,
  coverage: { gaps: 0, followUps: 0, residual: 0 }, passageSelection: { candidates: 1, kept: 1,
    dropped: 0, requiredCandidates: 1, requiredRetained: 1, contradictoryRetained: 0, fallback: false },
  repair: { attempted: 0, corrected: 0, qualified: 0, omitted: 0, documentRequested: 0, budgetExhausted: 0 },
  latencyMs: { timeToText: 100, assessment: 0, passageSelection: 10, coverageFollowUp: 0, repair: 0, total: 100 },
  tokens: { synthesis: 10, jev: 1, legacy: 0, repair: 0 }, estimatedCostUsd: .01, sampled: false };

describe('canary report CLI', () => {
  it('runs offline and writes deterministic artifacts', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'canary-cli-')); directories.push(directory);
    const events = path.join(directory, 'events.jsonl'); const out = path.join(directory, 'out');
    writeFileSync(events, `${JSON.stringify(sample)}\n`);
    const packageRoot = path.resolve(__dirname, '../..');
    const output = execFileSync(process.execPath, [path.join(packageRoot, 'node_modules/tsx/dist/cli.mjs'),
      path.join(packageRoot, 'scripts/canary-report.ts'), '--events', events, '--limits-version', 'v2',
      '--out', out], { encoding: 'utf8' });
    expect(output).toContain('1 canary, 0 baseline');
    expect(JSON.parse(readFileSync(path.join(out, 'canary-report.json'), 'utf8')).hash).toHaveLength(64);
    expect(readFileSync(path.join(out, 'canary-report.md'), 'utf8')).toContain('passageRequiredRetention | pass');
  });

  it('requires an explicit limits version', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'canary-cli-version-')); directories.push(directory);
    const events = path.join(directory, 'events.jsonl');
    writeFileSync(events, `${JSON.stringify(sample)}\n`);
    const packageRoot = path.resolve(__dirname, '../..');
    expect(() => execFileSync(process.execPath, [path.join(packageRoot, 'node_modules/tsx/dist/cli.mjs'),
      path.join(packageRoot, 'scripts/canary-report.ts'), '--events', events, '--out', path.join(directory, 'out')],
    { encoding: 'utf8', stdio: 'pipe' })).toThrow();
  });
});
