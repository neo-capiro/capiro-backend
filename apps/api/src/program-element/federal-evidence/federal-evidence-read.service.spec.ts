import { BadRequestException } from '@nestjs/common';
import { FederalEvidenceReadService } from './federal-evidence-read.service.js';

const UUID_A = '00000000-0000-4000-8000-000000000001';
const UUID_B = '00000000-0000-4000-8000-000000000002';

function mockPrisma(rows: Array<Record<string, unknown>>) {
  return {
    $queryRawUnsafe: jest.fn().mockResolvedValue(rows),
  } as never;
}

describe('FederalEvidenceReadService', () => {
  it('reads only current active qualified mentions and provides a filter-bound keyset cursor', async () => {
    const prisma = mockPrisma([
      { id: UUID_A, createdAt: new Date('2026-01-02T00:00:00Z'), contentHash: 'a'.repeat(64) },
      { id: UUID_B, createdAt: new Date('2026-01-01T00:00:00Z'), contentHash: 'b'.repeat(64) },
    ]);
    const service = new FederalEvidenceReadService(prisma);

    const first = await service.currentQualifiedMentions('  PE-0001  ', { limit: 1 });

    expect(first.items).toHaveLength(1);
    expect(first.hasMore).toBe(true);
    expect(first.nextCursor).toBeTruthy();
    const [sql, peCode, cursorTime, cursorId, limit] = (prisma as any).$queryRawUnsafe.mock.calls[0];
    expect(sql).toContain('DISTINCT ON (source_key)');
    expect(sql).toContain("o.state = 'present'");
    expect(sql).toContain("e.event_type = 'resolved'");
    expect(sql).toContain('COALESCE(m.canonical_pe_code, resolved.canonical_pe_code) = $1');
    expect(sql).toContain('r.content_hash AS "contentHash"');
    expect(sql).toContain('m.locator');
    expect([peCode, cursorTime, cursorId, limit]).toEqual(['PE-0001', null, null, 2]);

    await service.currentQualifiedMentions('PE-0001', { limit: 1, cursor: first.nextCursor });
    const nextCall = (prisma as any).$queryRawUnsafe.mock.calls[1];
    expect(nextCall[2]).toBe('2026-01-02T00:00:00.000Z');
    expect(nextCall[3]).toBe(UUID_A);
    expect(nextCall[4]).toBe(2);
  });

  it('rejects a cursor reused for a different PE', async () => {
    const service = new FederalEvidenceReadService(mockPrisma([]));
    const first = await service.currentQualifiedMentions('PE-0001', {
      limit: 1,
    });
    expect(first.nextCursor).toBeNull();
    const foreignCursor = Buffer.from(JSON.stringify({
      v: 1,
      kind: 'qualified-mentions',
      scope: 'pe:PE-0001',
      createdAt: '2026-01-01T00:00:00.000Z',
      id: UUID_A,
    })).toString('base64url');
    await expect(service.currentQualifiedMentions('PE-0002', { cursor: foreignCursor }))
      .rejects.toBeInstanceOf(BadRequestException);
  });

  it('reads the append-only PE/bill timeline with revision provenance for resolved pending mentions', async () => {
    const resolvedEvent = {
      id: UUID_A,
      eventType: 'resolved',
      rawMention: 'PE 0001',
      canonicalPeCode: 'PE-0001',
      qualificationState: 'qualified',
      revisionId: UUID_B,
      contentHash: 'c'.repeat(64),
      sourceUrl: 'https://example.test/bill.xml',
      locator: 'section 4',
    };
    const prisma = mockPrisma([resolvedEvent]);
    const service = new FederalEvidenceReadService(prisma);

    const result = await service.lifecycleTimeline({ peCode: 'PE-0001', billId: '119-hr-42' });

    expect(result.items).toEqual([resolvedEvent]);
    const [sql, peCode, billId, cursorTime, cursorId, limit] = (prisma as any).$queryRawUnsafe.mock.calls[0];
    expect(sql).toContain('FROM federal_evidence_mention_event e');
    expect(sql).toContain('LEFT JOIN federal_evidence_mention m');
    expect(sql).toContain('COALESCE(e.current_revision_id, e.previous_revision_id)');
    expect(sql).toContain('e.canonical_pe_code = $1');
    expect(sql).toContain('e.bill_id = $2');
    expect([peCode, billId, cursorTime, cursorId, limit]).toEqual(['PE-0001', '119-hr-42', null, null, 26]);
  });

  it('requires a timeline filter and rejects invalid page sizes', async () => {
    const service = new FederalEvidenceReadService(mockPrisma([]));
    await expect(service.lifecycleTimeline({})).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.currentQualifiedMentions('PE-0001', { limit: 101 }))
      .rejects.toBeInstanceOf(BadRequestException);
  });
});
