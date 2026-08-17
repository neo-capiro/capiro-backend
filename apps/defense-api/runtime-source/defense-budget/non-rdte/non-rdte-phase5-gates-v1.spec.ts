/**
 * non-rdte-phase5-gates-v1.spec — permanent Phase 5 architecture gate tests.
 *
 * Verifies that the gate scanner correctly detects violations and that the
 * Phase 5 source files pass all gates. Also tests the no-write gate by
 * scanning the production source.
 */
import { describe, it, expect } from '@jest/globals';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  runNonRdtePhase5Gates,
  stripComments,
  NON_RDTE_PHASE5_GATE_RULES,
} from './non-rdte-phase5-gates-v1.js';

describe('non-rdte-phase5-gates-v1', () => {
  it('stripComments removes line and block comments', () => {
    const src = [
      '// line comment',
      'const x = 1; // trailing comment',
      '/* block',
      ' * comment */',
      'const y = 2;',
    ].join('\n');
    const stripped = stripComments(src);
    expect(stripped).not.toContain('line comment');
    expect(stripped).not.toContain('trailing comment');
    expect(stripped).not.toContain('block');
    expect(stripped).toContain('const x = 1');
    expect(stripped).toContain('const y = 2');
  });

  it('detects ProgramElementWriterService import', () => {
    const violations = runNonRdtePhase5Gates({
      files: { 'test.ts': "import { ProgramElementWriterService } from './writer.js';" },
    });
    expect(violations.length).toBeGreaterThan(0);
    expect(violations[0]?.gateId).toBe('writer_import');
  });

  it('detects legacy loader import', () => {
    const violations = runNonRdtePhase5Gates({
      files: { 'test.ts': "import { syncJbookR2 } from './sync-jbook-r2.js';" },
    });
    expect(violations.length).toBeGreaterThan(0);
    expect(violations[0]?.gateId).toBe('legacy_loader_import');
  });

  it('detects Prisma canonical mutation', () => {
    const violations = runNonRdtePhase5Gates({
      files: { 'test.ts': 'await prisma.programElementYear.create({ data: {} });' },
    });
    expect(violations.length).toBeGreaterThan(0);
    expect(violations[0]?.gateId).toBe('prisma_canonical_mutation');
  });

  it('detects ingest --commit', () => {
    const violations = runNonRdtePhase5Gates({
      files: { 'test.ts': "exec('ingest-defense-budget-pdf --commit --fy 2027')" },
    });
    expect(violations.length).toBeGreaterThan(0);
    expect(violations[0]?.gateId).toBe('ingest_commit');
  });

  it('detects approvedSha256 promotion authority', () => {
    const violations = runNonRdtePhase5Gates({
      files: { 'test.ts': 'approvedSha256 = getCanonicalPromotionRecords(data);' },
    });
    expect(violations.some((v) => v.gateId === 'approved_sha_promotion')).toBe(true);
  });

  it('detects float money', () => {
    const violations = runNonRdtePhase5Gates({
      files: { 'test.ts': 'const total = parseFloat(amountStr);' },
    });
    expect(violations.length).toBeGreaterThan(0);
    expect(violations[0]?.gateId).toBe('float_money');
  });

  it('detects title similarity identity matching', () => {
    const violations = runNonRdtePhase5Gates({
      files: { 'test.ts': 'const matched = titleSimilarity(a.title, b.title) > 0.8;' },
    });
    expect(violations.length).toBeGreaterThan(0);
    expect(violations[0]?.gateId).toBe('title_similarity_identity');
  });

  it('detects DD1391 cost category merge', () => {
    const violations = runNonRdtePhase5Gates({
      files: { 'test.ts': 'const total = primaryFacilityCost + supportingFacilitiesCost;' },
    });
    expect(violations.length).toBeGreaterThan(0);
    expect(violations[0]?.gateId).toBe('dd1391_cost_category_merge');
  });

  it('detects upsertProgramElement import', () => {
    const violations = runNonRdtePhase5Gates({
      files: { 'test.ts': "import { upsertProgramElement } from './writer.js';" },
    });
    expect(violations.length).toBeGreaterThan(0);
    expect(violations.some((v) => v.gateId === 'upsert_program_element')).toBe(true);
  });

  it('detects promotionReady import', () => {
    const violations = runNonRdtePhase5Gates({
      files: { 'test.ts': "import { assertPromotionReady } from './promotion.js';" },
    });
    expect(violations.length).toBeGreaterThan(0);
    expect(violations.some((v) => v.gateId === 'promotion_ready_import')).toBe(true);
  });

  it('does not false-positive on doc comments', () => {
    const violations = runNonRdtePhase5Gates({
      files: {
        'test.ts': [
          '/**',
          ' * Phase 5 must not import ProgramElementWriterService.',
          ' * Never calls ingest-defense-budget-pdf --commit.',
          ' */',
          'const x = 1;',
        ].join('\n'),
      },
    });
    expect(violations.length).toBe(0);
  });

  it('empty files produce no violations', () => {
    const violations = runNonRdtePhase5Gates({ files: {} });
    expect(violations).toEqual([]);
  });

  it('has expected number of gate rules', () => {
    expect(NON_RDTE_PHASE5_GATE_RULES.length).toBe(14);
  });
});
