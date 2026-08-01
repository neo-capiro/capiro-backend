import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from '@jest/globals';
import {
  PE_PRODUCTION_SCRIPTS,
  PE_PRODUCTION_SCRIPT_HELPERS,
  peProductionScriptBasenames,
} from './pe-production-scripts.js';

function apiRoot(): string {
  const cwd = process.cwd().replace(/\\/g, '/');
  return cwd.endsWith('/apps/api') ? process.cwd() : resolve(process.cwd(), 'apps/api');
}

describe('PE production script catalog (K1)', () => {
  test('every catalogued production script path exists on disk', () => {
    const root = apiRoot();
    for (const rel of PE_PRODUCTION_SCRIPTS) {
      expect(existsSync(resolve(root, rel))).toBe(true);
    }
  });

  test('helpers exist and basenames are unique', () => {
    const root = apiRoot();
    for (const rel of PE_PRODUCTION_SCRIPT_HELPERS) {
      expect(existsSync(resolve(root, rel))).toBe(true);
    }
    const names = peProductionScriptBasenames();
    expect(new Set(names).size).toBe(names.length);
  });

  test('catalog is bounded (no wildcards, searchable exact list)', () => {
    expect(PE_PRODUCTION_SCRIPTS.length).toBeGreaterThanOrEqual(20);
    expect(PE_PRODUCTION_SCRIPTS.length).toBeLessThanOrEqual(80);
    for (const rel of PE_PRODUCTION_SCRIPTS) {
      expect(rel).toMatch(/^scripts\/[a-z0-9][a-z0-9._-]*\.ts$/i);
      expect(rel.includes('*')).toBe(false);
    }
  });
});
