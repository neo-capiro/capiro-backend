import { describe, expect, jest, test } from '@jest/globals';
import type { PrismaClient } from '@prisma/client';
import { EMBEDDING_SCOPES, embedDocument, main, pendingDocumentsSql, readPendingDocuments } from './embed-funding-catalog.js';
import type { RecordData } from '../src/external/tango/funding-catalog.mapper.js';

const squash = (sql: string) => sql.replace(/\s+/g, ' ').trim();

describe('embed-funding-catalog pending selection', () => {
  test('active scope keeps the open-opportunity predicate per kind and resumes oldest embedding first', () => {
    const grant = squash(pendingDocumentsSql('grant', 'active'));
    expect(grant).toContain('FROM federal_grant WHERE (embedded_at IS NULL OR embedded_at < synced_at)');
    expect(grant).toContain("AND (status IN ('posted','forecasted') AND (close_date IS NULL OR close_date >= CURRENT_DATE))");
    expect(grant).toMatch(/ORDER BY embedded_at ASC NULLS FIRST,id LIMIT \$1$/);

    const notice = squash(pendingDocumentsSql('notice', 'active'));
    expect(notice).toContain('FROM sam_opportunity WHERE (embedded_at IS NULL OR embedded_at < last_synced_at)');
    expect(notice).toContain('AND (active AND (response_deadline IS NULL OR response_deadline >= NOW()))');
    expect(notice).toMatch(/ORDER BY embedded_at ASC NULLS FIRST,id LIMIT \$1$/);

    const attachment = squash(pendingDocumentsSql('attachment', 'active'));
    expect(attachment).toContain('FROM opportunity_attachment WHERE (embedded_at IS NULL OR embedded_at < provider_observed_at)');
    expect(attachment).toContain('AND ((EXISTS (SELECT 1 FROM federal_grant g');
    expect(attachment).toMatch(/ORDER BY embedded_at ASC NULLS FIRST,id LIMIT \$1$/);
  });

  test('all scope drops the activity predicate, keeps the pending and text predicates, and orders newest first', () => {
    const grant = squash(pendingDocumentsSql('grant', 'all'));
    expect(grant).toContain('FROM federal_grant WHERE (embedded_at IS NULL OR embedded_at < synced_at) AND length(description)>10 ORDER BY close_date DESC NULLS LAST,id LIMIT $1');
    expect(grant).not.toContain('status IN');
    expect(grant).not.toContain('CURRENT_DATE');

    const notice = squash(pendingDocumentsSql('notice', 'all'));
    expect(notice).toContain('FROM sam_opportunity WHERE (embedded_at IS NULL OR embedded_at < last_synced_at) AND length(description)>10 ORDER BY posted_date DESC NULLS LAST,id LIMIT $1');
    expect(notice).not.toContain('response_deadline');
    expect(notice).not.toMatch(/\bactive\b/);

    const attachment = squash(pendingDocumentsSql('attachment', 'all'));
    expect(attachment).toContain("AND (length(provider_data->>'extracted_text')>10 OR length(");
    expect(attachment).not.toContain('EXISTS (SELECT 1 FROM federal_grant g');
    expect(attachment).toMatch(/ORDER BY provider_observed_at DESC NULLS LAST,id LIMIT \$1$/);
  });

  test('every scope binds the per-kind limit as the only parameter', async () => {
    const calls: Array<[string, unknown[]]> = [];
    const prisma = { $queryRawUnsafe: jest.fn(async (sql: string, ...params: unknown[]) => { calls.push([sql, params]); return []; }) } as unknown as PrismaClient;
    for (const scope of EMBEDDING_SCOPES) {
      for (const kind of ['grant', 'notice', 'attachment'] as const) {
        await readPendingDocuments(prisma, kind, 10000, scope);
        const [sql, params] = calls.at(-1)!;
        expect(sql).toBe(pendingDocumentsSql(kind, scope));
        expect(params).toEqual([10000]);
        expect(sql.match(/\$\d/g)).toEqual(['$1']);
      }
    }
    expect(calls).toHaveLength(6);
    // The default is the scheduled active scope.
    await readPendingDocuments(prisma, 'grant', 300);
    expect(calls.at(-1)![0]).toBe(pendingDocumentsSql('grant', 'active'));
  });

  test('scope and limits are refused before configuration or database access', async () => {
    await expect(main(['--scope='])).rejects.toThrow('Usage:');
    await expect(main(['--scope=all', '--limit=10001'])).rejects.toThrow('Invalid embedding limits');
    await expect(main(['--scope=all', '--max-chunks=20001'])).rejects.toThrow('Invalid embedding limits');
  });
});

describe('active SBIR topic embeddings', () => {
  test('topic chunks retain provider identity and reuse vectors when text is unchanged', async () => {
    const row: RecordData = { id: 'synthetic-topic', provider_topic_id: 'provider-topic',
      body: 'Synthetic quantum sensing research description.', source_url: 'https://example.invalid/topic',
      changed: '2026-11-03T00:00:00Z', embedded_content_hash: null };
    let stored: Array<{ source_id: string; content_hash: string; vector: string; metadata: RecordData }> = [];
    let marker: unknown;
    const mutations: string[] = [];
    const tx = {
      $queryRawUnsafe: async () => [{ body: row.body, changed: row.changed }],
      $executeRawUnsafe: async (sql: string, ...args: unknown[]) => {
        mutations.push(sql);
        if (sql.startsWith('INSERT INTO context_embeddings')) {
          expect(args[0]).toBe('funding_sbir_topic_chunk');
          stored = JSON.parse(String(args[2])) as typeof stored;
        }
        if (sql.startsWith('UPDATE tango_sbir_topic')) marker = args[0];
        return 1;
      },
    };
    const prisma = {
      $queryRawUnsafe: async () => stored,
      $transaction: async (fn: (value: typeof tx) => Promise<void>) => fn(tx),
    } as unknown as PrismaClient;
    const invoke = jest.fn(async () => Array<number>(1024).fill(0.1));
    expect(await embedDocument(prisma, 'sbir_topic', row, invoke)).toBe(1);
    expect(stored[0]?.metadata).toMatchObject({ sourceTable: 'tango_sbir_topic',
      providerTopicId: 'provider-topic', binding: 'provider_topic_id', parentId: 'synthetic-topic',
      sourceUrl: row.source_url });
    row.embedded_content_hash = marker;
    mutations.length = 0;
    expect(await embedDocument(prisma, 'sbir_topic', row, invoke)).toBe(0);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(mutations.some((sql) => sql.startsWith('DELETE') || sql.startsWith('INSERT'))).toBe(false);
  });

  test('the active scope selects only topics the read path calls open', () => {
    const sql = pendingDocumentsSql('sbir_topic', 'active');
    expect(sql).toContain('FROM tango_sbir_topic');
    expect(sql).toContain("lower(coalesce(activity,'')) = 'open'");
    expect(sql).toContain('close_date IS NULL OR close_date >= CURRENT_DATE');
    expect(sql).toContain('embedded_at IS NULL OR embedded_at < last_synced_at');
    // Description is the only prose source; a null one is not embeddable.
    expect(sql).toContain('length(description)>10');
  });

  test('the historical scope drops the activity filter but keeps its own type', () => {
    const active = pendingDocumentsSql('sbir_topic', 'active');
    const all = pendingDocumentsSql('sbir_topic', 'all');
    expect(all).not.toContain("= 'open'");
    expect(active).not.toBe(all);
    // No DIBBS or SBIR-cycle title-only kind exists.
    expect(() => pendingDocumentsSql('dibbs_solicitation' as never, 'active')).toThrow();
    expect(() => pendingDocumentsSql('sbir_solicitation' as never, 'active')).toThrow();
  });
});
