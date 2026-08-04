/**
 * rdte-phase4-gates-v1.spec — the permanent architecture gates must fire on
 * injected violations and hold on the real Phase 4 source tree.
 */
import { describe, it, expect } from '@jest/globals';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { runRdtePhase4Gates, stripComments } from './rdte-phase4-gates-v1.js';

function collectRdteSources(): Record<string, string> {
  const rdteRoot = path.resolve(__dirname, '..');
  const files: Record<string, string> = {};
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === '__tmp__') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.spec.ts')) {
        files[path.relative(rdteRoot, full)] = fs.readFileSync(full, 'utf8');
      }
    }
  };
  walk(rdteRoot);
  return files;
}

describe('rdte-phase4-gates-v1', () => {
  it('holds on the real Phase 4 source tree', () => {
    const violations = runRdtePhase4Gates({ files: collectRdteSources() });
    expect(violations).toEqual([]);
  });

  it('detects a writer import (negative control 17)', () => {
    const violations = runRdtePhase4Gates({
      files: {
        'evil.ts':
          "import { ProgramElementWriterService } from '../../../program-element/program-element-writer.service.js';",
      },
    });
    expect(violations.some((v) => v.gateId === 'writer_import')).toBe(true);
  });

  it('detects a Prisma canonical mutation (negative control 18)', () => {
    const violations = runRdtePhase4Gates({
      files: {
        'evil.ts':
          "await prisma.programElementProjectBudgetPosition.upsert({ where: {}, create: {}, update: {} });",
      },
    });
    expect(violations.some((v) => v.gateId === 'prisma_canonical_mutation')).toBe(true);
  });

  it('detects ingest --commit invocation', () => {
    const violations = runRdtePhase4Gates({
      files: {
        'evil.ts': "run('ingest-defense-budget-pdf.ts --commit')",
      },
    });
    expect(violations.some((v) => v.gateId === 'ingest_commit')).toBe(true);
  });

  it('detects a paid parser call', () => {
    const violations = runRdtePhase4Gates({
      files: { 'evil.ts': 'await executeLlamaParsePages({ pages: [1] });' },
    });
    expect(violations.some((v) => v.gateId === 'paid_call_default')).toBe(true);
  });

  it('ignores doc comments mentioning prohibited terms', () => {
    const violations = runRdtePhase4Gates({
      files: {
        'pure.ts':
          "/**\n * Pure module. Never invokes a parser, never calls LlamaParse, never writes\n * to a database. No ProgramElementWriterService here.\n */\nexport const x = 1;\n",
      },
    });
    expect(violations).toEqual([]);
  });

  it('strips comments without losing line numbers', () => {
    const source = 'const a = 1; // trailing\n/* block\nspanning */\nconst b = 2;';
    const stripped = stripComments(source);
    expect(stripped.split('\n')).toHaveLength(4);
    expect(stripped).toContain('const a = 1;');
    expect(stripped).toContain('const b = 2;');
  });
});
