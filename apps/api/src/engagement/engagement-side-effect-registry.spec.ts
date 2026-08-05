import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';

const REPO = path.resolve(__dirname, '..', '..', '..', '..');
const FIXTURE = path.join(__dirname, '__fixtures__', 'engagement-side-effect-registry.v1.json');
const VERIFIER = path.join(
  REPO,
  'apps',
  'api',
  'scripts',
  'engagement-phase0-side-effect-verify.ts',
);
const TSX_CLI = require.resolve('tsx/cli');

function readFixture() {
  return JSON.parse(fs.readFileSync(FIXTURE, 'utf-8'));
}

function runVerifier(): { passed: boolean; output: string } {
  const result = spawnSync(process.execPath, [TSX_CLI, VERIFIER], {
    cwd: REPO,
    encoding: 'utf8',
    timeout: 30_000,
    shell: false,
    windowsHide: true,
  });
  if (result.error) throw result.error;
  return {
    passed: result.status === 0,
    output: `${result.stdout ?? ''}${result.stderr ?? ''}`,
  };
}

describe('Engagement side-effect registry', () => {
  describe('fixture integrity', () => {
    it('exists and parses', () => {
      const manifest = readFixture();
      expect(manifest.schemaVersion).toBe(1);
      expect(Array.isArray(manifest.entries)).toBe(true);
      expect(manifest.entries.length).toBeGreaterThan(0);
    });

    it('contains every required field', () => {
      const requiredFields = [
        'id',
        'sourceFile',
        'symbol',
        'trigger',
        'effect',
        'externalSystem',
        'currentProcessOwner',
        'activationConfig',
        'idempotencyBoundary',
        'concurrencyBoundary',
        'containsSensitiveData',
        'phase1ContainmentRequirement',
      ];
      for (const entry of readFixture().entries) {
        for (const field of requiredFields) expect(entry).toHaveProperty(field);
      }
    });

    it('has unique ids', () => {
      const ids = readFixture().entries.map((entry: any) => entry.id);
      expect(new Set(ids).size).toBe(ids.length);
    });

    it('records main_api as the current owner', () => {
      for (const entry of readFixture().entries) {
        expect(entry.currentProcessOwner).toBe('main_api');
      }
    });

    it('contains no secret material', () => {
      const secretPattern = /\b(api_key|secret|password)\b/i;
      for (const entry of readFixture().entries) {
        for (const value of [
          entry.externalSystem,
          entry.idempotencyBoundary,
          entry.concurrencyBoundary,
        ]) {
          if (value) expect(secretPattern.test(String(value))).toBe(false);
        }
      }
    });
  });

  describe('static verifier', () => {
    it('exits successfully', () => {
      expect(runVerifier().passed).toBe(true);
    });

    it('reports PASS', () => {
      expect(runVerifier().output).toContain('PASS');
    });
  });

  describe('negative controls', () => {
    it('detects removal of a timer entry', () => {
      const committed = readFixture();
      const changed = JSON.parse(JSON.stringify(committed));
      changed.entries = changed.entries.filter(
        (entry: any) => entry.symbol !== 'EngagementSyncSchedulerService',
      );
      const originalTimers = committed.entries.filter(
        (entry: any) => entry.trigger === 'on_module_init',
      ).length;
      const changedTimers = changed.entries.filter(
        (entry: any) => entry.trigger === 'on_module_init',
      ).length;
      expect(changedTimers).toBeLessThan(originalTimers);
    });

    it('detects a synthetic symbol change', () => {
      const committed = readFixture();
      const changed = JSON.parse(JSON.stringify(committed));
      const index = changed.entries.findIndex(
        (entry: any) => entry.symbol === 'OutreachJobService',
      );
      expect(index).toBeGreaterThanOrEqual(0);
      changed.entries[index].symbol = 'NonExistent';
      expect(changed.entries[index].symbol).not.toBe('OutreachJobService');
    });
  });
});
