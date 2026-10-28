import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  currentMemoryReadSql,
  currentMemoryReadSqlInTx,
  governedRecallEligibilitySql,
  governedRecallColumnsAvailableInTx,
  governedRecallSuppressionEnabled,
  governedRecallSuppressionSql,
  TERMINAL_GOVERNED_STATUSES,
} from './memory-recall-suppression.helpers.js';
import { memoryEmbeddingEligibilitySql } from './memory-embedding-lifecycle.js';

describe('currentMemoryReadSql', () => {
  it('withholds Clio projections without the lifecycle columns and keeps legacy files current', () => {
    const sql = currentMemoryReadSql(false, 'mi');
    expect(sql).toContain("mi.slug NOT LIKE 'clio:%'");
    expect(sql).toContain("mi.status = 'active'");
    expect(sql).toContain('mi.expires_at > now()');
    expect(sql).not.toContain('governed_status');
    expect(sql).not.toContain('effective_from');
  });

  it('requires the shared current-memory predicate for every governed row', () => {
    const sql = currentMemoryReadSql(true, 'mi');
    expect(sql).toMatch(/mi\.governed_status IS NULL\s+AND mi\.slug NOT LIKE 'clio:%'/);
    expect(sql).toMatch(/mi\.slug NOT LIKE 'clio:%'[\s\S]*mi\.effective_from <= now\(\)/);
    expect(sql).toContain('mi.controlling_item_id IS NULL');
    expect(sql).toContain("COALESCE(mi.conflict_status, 'none') NOT IN ('open', 'controlling')");
    expect(sql).toContain("mi.governed_status IN ('active', 'stale')");
    expect(sql).toContain("mi.governed_status = 'conflicted'");
    expect(sql).toContain('mi.controlling_item_id = mi.id');
    expect(sql).toContain('mi.effective_from <= now()');
    expect(sql).toContain('mi.valid_until > now()');
    expect(sql).toContain("mi.status = 'active'");
  });

  it('probes the actual schema and does not turn probe failure into permission', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce([{ ready: true }])
      .mockResolvedValueOnce([]);
    const tx = { $queryRaw: query } as never;
    expect(await governedRecallColumnsAvailableInTx(tx)).toBe(true);
    expect(await currentMemoryReadSqlInTx(tx)).toContain("slug NOT LIKE 'clio:%'");
    query.mockRejectedValueOnce(new Error('schema unavailable'));
    await expect(currentMemoryReadSqlInTx(tx)).rejects.toThrow('schema unavailable');
    expect(query).toHaveBeenCalledTimes(3);
  });

  it('uses the same gate before indexing source content', () => {
    const oldSchema = memoryEmbeddingEligibilitySql(false);
    expect(oldSchema).toContain("mi.slug NOT LIKE 'clio:%'");
    expect(oldSchema).not.toContain('governed_status');
    const migrated = memoryEmbeddingEligibilitySql(true);
    expect(migrated).toContain('mi.effective_from <= now()');
    expect(migrated).toContain("mi.governed_status IN ('active', 'stale')");
    expect(migrated).toContain("mi.visibility = 'tenant' AND mi.owner_user_id IS NULL");
  });

  it('keeps both model-facing graph inputs behind the owner and current-memory gate', () => {
    const source = readFileSync(join(__dirname, '..', 'meri', 'meri-tools.service.ts'), 'utf8');
    const entry = source.split('private async loadGraphForCtx(')[1]?.split('private async queryKnowledgeGraph(')[0];
    expect(entry).toContain('return loadMeriGraph(this.prisma, ctx,');
    const graph = readFileSync(join(__dirname, '..', 'meri', 'meri-graph-source.ts'), 'utf8');
    expect(graph).toContain("visibility = 'tenant' AND owner_user_id IS NULL");
    expect(graph).toContain("visibility = 'user' AND owner_user_id = ${ctx.userId}::uuid");
    expect(graph).toContain('WHERE tenant_id = ${ctx.tenantId}::uuid');
    expect(graph).toContain("i.visibility = 'tenant' AND i.owner_user_id IS NULL");
    expect(graph).toContain("i.visibility = 'user' AND i.owner_user_id = ${ctx.userId}::uuid");
    expect(graph).toContain('WHERE e.tenant_id = ${ctx.tenantId}::uuid AND i.tenant_id = ${ctx.tenantId}::uuid');
    expect(graph?.match(/currentMemoryReadSql\(memoryColumnsAvailable/g)).toHaveLength(2);
  });
});

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
