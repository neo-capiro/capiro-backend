import { Prisma } from '@prisma/client';
import type { TenantContext } from '@capiro/shared';
import type { AuthorizedCapabilityContext } from '../capability-context.js';
import { AttachmentContentService } from '../../engagement/attachment-content.service.js';
import { SearchMemoryCapability } from './search-memory.capability.js';
import { OutreachContextReferenceService } from './outreach-context-reference.service.js';

const tenantId = '11111111-1111-4111-8111-111111111111';
const userId = '22222222-2222-4222-8222-222222222222';
const clientId = '33333333-3333-4333-8333-333333333333';
const memoryId = '44444444-4444-4444-8444-444444444444';
const actor = {
  tenantId,
  actorUserId: userId,
  role: 'standard_user',
  requestId: 'memory-eligibility',
  surface: 'outreach',
} as AuthorizedCapabilityContext;
const ctx = { tenantId, userId, role: 'standard_user' } as TenantContext;
const searchInput = {
  query: 'budget', clientId, intendedClass: 'campaign_fact', scope: { kind: 'campaign' }, limit: 5,
} as const;
const selection = {
  locator: { source: 'memory_item', id: memoryId, clientId },
  contextClass: 'campaign_fact',
  scope: { kind: 'campaign' },
} as const;

function harness(allowed: boolean, memoryRows: Record<string, unknown>[] = []) {
  const query = jest.fn(async (_strings: TemplateStringsArray, ..._values: unknown[]) => memoryRows);
  const wall = jest.fn(async () => [{ allowed }]);
  const tx = { $queryRaw: query, $queryRawUnsafe: wall } as unknown as Prisma.TransactionClient;
  const prisma = {
    withTenantUser: jest.fn((_tenant: string, _user: string, run: (tx: Prisma.TransactionClient) => unknown) => run(tx)),
  };
  const search = new SearchMemoryCapability(prisma as never, {
    authorizeClient: jest.fn(async () => undefined),
  } as never);
  const references = new OutreachContextReferenceService(
    prisma as never, {} as never, {} as never, new AttachmentContentService(), {} as never,
  );
  return { search, references, tx, query, wall };
}

describe('Outreach V3 governed memory reads', () => {
  it('uses the canonical current-memory predicate for search and selected-reference recheck', async () => {
    const { search, references, tx, query } = harness(true);
    await search.execute(actor, searchInput);
    await expect(references.resolveOneWithinTx(tx, ctx, selection)).rejects.toMatchObject({
      code: 'CAPABILITY_NOT_FOUND',
    });
    expect(query).toHaveBeenCalledTimes(2);
    for (const [strings, ...values] of query.mock.calls) {
      const sql = Prisma.sql(strings, ...values);
      expect(sql.text).toContain("mi.status = 'active'");
      expect(sql.text).toContain('mi.effective_from <= now()');
      expect(sql.text).toContain('mi.valid_until > now()');
      expect(sql.text).toContain('mi.expires_at > now()');
      expect(sql.text).toContain('mi.approved_at IS NOT NULL');
      expect(sql.text).toContain("mi.governed_status IN ('active', 'stale')");
      expect(sql.text).toContain('mi.controlling_item_id = mi.id');
      expect(sql.values).toContain(clientId);
    }
  });

  it('does not query memory content after a client wall denial', async () => {
    const { search, references, tx, query } = harness(false);
    const result = await search.execute(actor, searchInput);
    expect(result.data.candidates).toEqual([]);
    await expect(references.resolveOneWithinTx(tx, ctx, selection)).rejects.toMatchObject({
      code: 'CAPABILITY_NOT_FOUND',
    });
    expect(query).not.toHaveBeenCalled();
  });

  it.each([
    ['stale', 'none'],
    ['conflicted', 'open'],
  ])('may display a %s controlling fact without promoting it to settled evidence', async (status, conflict) => {
    const row = {
      id: memoryId,
      client_id: clientId,
      owner_user_id: null,
      visibility: 'tenant',
      title: 'Budget position',
      type: 'client-compass',
      sections_jsonb: [{ key: 'memory', body: 'Client budget position' }],
      status: 'active',
      sensitivity: 'normal',
      instructions_allowed: true,
      source_type: 'client_record',
      source_version: 'v1',
      source_excerpt: null,
      governed_status: status,
      memory_authority: 'authoritative',
      conflict_status: conflict,
      as_of: null,
      valid_until: null,
      updated_at: new Date('2026-10-01T00:00:00Z'),
    };
    const { search, references, tx } = harness(true, [row]);
    const resolved = await references.resolveOneWithinTx(tx, ctx, selection);
    expect(resolved.summary).toContain('Client budget position');
    expect(resolved.usableAsEvidence).toBe(false);
    await expect(references.resolveOneWithinTx(tx, ctx, {
      ...selection, contextClass: 'writing_guidance',
    })).rejects.toMatchObject({ code: 'CAPABILITY_INVALID_INPUT' });

    const found = await search.execute(actor, searchInput);
    expect(found.data.candidates).toHaveLength(1);
    expect(found.data.candidates[0]).toMatchObject({
      verificationClass: 'unverified', instructionsAllowed: false,
    });
    expect((await search.execute(actor, { ...searchInput, intendedClass: 'required_policy' }))
      .data.candidates).toEqual([]);
    expect((await search.execute(actor, { ...searchInput, intendedClass: 'writing_guidance' }))
      .data.candidates).toEqual([]);
  });
});
