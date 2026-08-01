import { describe, expect, it } from '@jest/globals';
import {
  governedClioSuppressionSql,
  governedRecallEligibilitySql,
  governedRecallSuppressionEnabled,
  governedRecallSuppressionSql,
  TERMINAL_GOVERNED_STATUSES,
} from './memory-recall-suppression.helpers.js';

/**
 * These fragments are appended to eleven live recall queries. The OFF behaviour is
 * the load-bearing assertion: `governed_status` does not exist until
 * 20260729010000 is applied, so anything other than an empty string here breaks
 * every memory read in prod.
 */
describe('governedRecallSuppressionSql', () => {
  it('emits nothing at all when disabled', () => {
    expect(governedRecallSuppressionSql(false)).toBe('');
    expect(governedRecallSuppressionSql(false, 'mi')).toBe('');
  });

  it('uses the exact active/stale/controlling-conflict predicate when armed', () => {
    const sql = governedRecallSuppressionSql(true, 'mi');
    expect(sql).toContain("mi.governed_status IN ('active', 'stale')");
    expect(sql).toContain("mi.governed_status = 'conflicted'");
    expect(sql).toContain('mi.controlling_item_id = mi.id');
    for (const status of TERMINAL_GOVERNED_STATUSES) {
      expect(sql).not.toContain(`'${status}'`);
    }
  });

  it('supports an unaliased FROM memory_items', () => {
    expect(governedRecallSuppressionSql(true)).toContain("governed_status IN ('active', 'stale')");
    expect(governedRecallEligibilitySql()).toContain('controlling_item_id = id');
  });

  it('refuses an alias that is not a bare identifier', () => {
    for (const alias of ['mi; DROP TABLE memory_items --', 'mi.client_id', 'mi ', '1', '']) {
      if (alias === '') continue;
      expect(() => governedRecallSuppressionSql(true, alias)).toThrow(/unsafe alias/);
    }
  });
});

describe('governedClioSuppressionSql', () => {
  it('emits nothing at all when disabled', () => {
    expect(governedClioSuppressionSql(false)).toBe('');
  });

  /**
   * clio_memory has no governed_status of its own, so the only handle is the
   * memory_items projection keyed 'clio:'||id — served by the existing
   * memory_items_tenant_type_slug_unique index, so no new index is required.
   */
  it('suppresses through the memory_items projection on the unique-index key', () => {
    const sql = governedClioSuppressionSql(true);
    expect(sql).toContain('NOT EXISTS');
    expect(sql).toContain("mi_sup.type = 'note'");
    expect(sql).toContain("mi_sup.slug = 'clio:' || clio_memory.id::text");
    expect(sql).toContain('mi_sup.tenant_id = clio_memory.tenant_id');
    expect(sql).toContain('AND NOT');
    expect(sql).toContain("mi_sup.governed_status IN ('active', 'stale')");
    expect(sql).toContain('mi_sup.controlling_item_id = mi_sup.id');
  });

  it('refuses an unsafe alias', () => {
    expect(() => governedClioSuppressionSql(true, 'cm; DELETE FROM clio_memory --')).toThrow(
      /unsafe alias/,
    );
  });
});

describe('governedRecallSuppressionEnabled', () => {
  const original = process.env.MEMORY_GOVERNANCE_LIFECYCLE;
  afterEach(() => {
    if (original === undefined) delete process.env.MEMORY_GOVERNANCE_LIFECYCLE;
    else process.env.MEMORY_GOVERNANCE_LIFECYCLE = original;
  });

  it('is off with no environment variable set', () => {
    delete process.env.MEMORY_GOVERNANCE_LIFECYCLE;
    expect(governedRecallSuppressionEnabled()).toBe(false);
  });

  it('reads the same switch as the rest of the lifecycle', () => {
    process.env.MEMORY_GOVERNANCE_LIFECYCLE = 'enforce';
    expect(governedRecallSuppressionEnabled()).toBe(true);
    process.env.MEMORY_GOVERNANCE_LIFECYCLE = 'true';
    expect(governedRecallSuppressionEnabled()).toBe(false);
  });
});
