import { ConflictException } from '@nestjs/common';
import { ContextCompiler, type SteeringRow } from '@capiro/meriv2-core';
import type { Prisma } from '@prisma/client';
import {
  buildCanonicalGovernance,
  governedClioMetadata,
  upsertCanonicalMemoryItemInTx,
  type CanonicalMemoryRecord,
} from './memory-canonical-activation.helpers.js';
import { clioMemoryToItem } from './memory-clio-adapter.helpers.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const PROPOSER = '22222222-2222-4222-8222-222222222222';
const REVIEWER = '33333333-3333-4333-8333-333333333333';
const CLIO = '44444444-4444-4444-8444-444444444444';
const ITEM = '55555555-5555-4555-8555-555555555555';
const CANDIDATE = '77777777-7777-4777-8777-777777777777';

function record(scope: CanonicalMemoryRecord['scope']): CanonicalMemoryRecord {
  return {
    scope,
    ownerUserId: scope === 'user_private' ? PROPOSER : null,
    clientId: scope === 'client' ? '66666666-6666-4666-8666-666666666666' : null,
    key: 'fy27-position',
    value: 'Support the verified plus-up.',
    source: 'chat',
    sourceConversationId: 'conversation-1',
    sourceMessageId: 'message-1',
    sourceExcerpt: 'The analyst explicitly asked Meri to remember this position.',
  };
}

function settingsRecord(): CanonicalMemoryRecord {
  return {
    ...record('firm'),
    key: 'settings-file:firm-soul:firm',
    value: JSON.stringify([
      { key: 'mission', heading: 'Mission', owner: 'human', body: 'Reviewed' },
    ]),
    source: 'settings_memory_editor',
    canonicalItem: {
      type: 'firm-soul',
      slug: 'firm',
      title: 'Firm Soul',
      sections: [{ key: 'mission', heading: 'Mission', owner: 'human', body: 'Reviewed' }],
    },
  };
}

function embeddedSql(values: unknown[]): string {
  return values
    .map((value) => {
      if (!value || typeof value !== 'object') return '';
      const sql = (value as { sql?: unknown }).sql;
      return typeof sql === 'string' ? sql : '';
    })
    .join('\n');
}

describe('canonical governed memory activation', () => {
  it.each([
    ['firm', 'firm_approved', 'institutional_authoritative'],
    ['client', 'client_approved', 'client_steering'],
    ['user_private', 'user_asserted', 'user_preference'],
  ] as const)(
    'assigns approved authority for %s memory',
    (scope, expectedAuthority, expectedClass) => {
      const governance = buildCanonicalGovernance({
        record: record(scope),
        sourceKind: 'explicit_user',
        candidateId: CANDIDATE,
        assertedByUserId: PROPOSER,
        approvedByUserId: REVIEWER,
        decision: 'approved',
        approvedAt: new Date('2026-07-30T00:00:00.000Z'),
      });
      expect(governance).toMatchObject({
        canonicalType:
          scope === 'firm' ? 'playbook' : scope === 'client' ? 'client-compass' : 'user-profile',
        memoryScope: scope === 'user_private' ? 'user_private' : scope,
        memoryAuthority: expectedAuthority,
        memoryClass: expectedClass,
        governedStatus: 'active',
        assertedByUserId: PROPOSER,
        approvedByUserId: REVIEWER,
        sourceId: 'message-1',
        sourceRef: 'chat',
        sourceVersion: `candidate:${CANDIDATE}`,
      });
      expect(governance.sourceContentHash).toMatch(/^[a-f0-9]{64}$/);
    },
  );

  it('promotes reviewed model extraction to analyst-verified authority', () => {
    const governance = buildCanonicalGovernance({
      record: record('firm'),
      sourceKind: 'model_extraction',
      candidateId: CANDIDATE,
      assertedByUserId: PROPOSER,
      approvedByUserId: REVIEWER,
      decision: 'approved',
    });
    expect(governance.memoryAuthority).toBe('analyst_verified');
    expect(governance.approvedByUserId).toBe(REVIEWER);
  });

  it('writes a non-catalog canonical item with governed fields and upsert recovery', async () => {
    let sql = '';
    let params: unknown[] = [];
    const tx = {
      $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
        sql = strings.join('?');
        params = values;
        return [{ id: ITEM }];
      },
    } as unknown as Prisma.TransactionClient;
    const governance = buildCanonicalGovernance({
      record: record('firm'),
      sourceKind: 'explicit_user',
      candidateId: CANDIDATE,
      assertedByUserId: PROPOSER,
      approvedByUserId: REVIEWER,
      decision: 'approved',
    });

    await expect(
      upsertCanonicalMemoryItemInTx(tx, TENANT, CLIO, record('firm'), governance),
    ).resolves.toBe(ITEM);
    expect(sql).toContain('INSERT INTO memory_items');
    expect(sql).toContain('memory_authority');
    expect(sql).toContain('governed_status');
    expect(embeddedSql(params)).toContain('DO UPDATE SET');
    expect(params).toContain('firm_approved');
    expect(params).toContain('active');
    expect(params).toContain(PROPOSER);
    expect(params).toContain(REVIEWER);
  });

  it('activates an approved first-time Settings proposal insert-only', async () => {
    let params: unknown[] = [];
    const tx = {
      $queryRaw: async (_strings: TemplateStringsArray, ...values: unknown[]) => {
        params = values;
        return [{ id: ITEM }];
      },
    } as unknown as Prisma.TransactionClient;
    const proposed = settingsRecord();
    const governance = buildCanonicalGovernance({
      record: proposed,
      sourceKind: 'settings_sections',
      candidateId: CANDIDATE,
      assertedByUserId: PROPOSER,
      approvedByUserId: REVIEWER,
      decision: 'approved',
    });
    expect(governance.sourceType).toBe('approved_document_edit');
    await upsertCanonicalMemoryItemInTx(tx, TENANT, CLIO, proposed, governance);
    expect(embeddedSql(params)).toContain('DO NOTHING');
    expect(params).toContain('firm-soul');
    expect(params).toContain('firm');
    expect(params).toContain('Firm Soul');
    expect(params).toContain('firm_approved');
    expect(params).toContain('approved_document_edit');
    expect(params).toContainEqual(expect.stringContaining('Reviewed'));
  });

  it('refuses a racing first-time Settings approval without replacing active truth', async () => {
    const tx = {
      $queryRaw: async () => [],
    } as unknown as Prisma.TransactionClient;
    const proposed = settingsRecord();
    const governance = buildCanonicalGovernance({
      record: proposed,
      sourceKind: 'settings_sections',
      candidateId: CANDIDATE,
      assertedByUserId: PROPOSER,
      approvedByUserId: REVIEWER,
      decision: 'approved',
    });

    await expect(
      upsertCanonicalMemoryItemInTx(tx, TENANT, CLIO, proposed, governance),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('preserves authoritative governance when rebuilding the Clio projection', () => {
    const governance = buildCanonicalGovernance({
      record: record('client'),
      sourceKind: 'explicit_user',
      candidateId: CANDIDATE,
      assertedByUserId: PROPOSER,
      approvedByUserId: REVIEWER,
      decision: 'approved',
      approvedAt: new Date('2026-07-30T00:00:00.000Z'),
    });
    const item = clioMemoryToItem({
      id: CLIO,
      tenantId: TENANT,
      scope: 'client',
      ownerUserId: null,
      clientId: record('client').clientId,
      key: 'fy27-position',
      value: 'Support the verified plus-up.',
      source: 'chat',
      metadata: governedClioMetadata(governance),
      createdAt: '2026-07-30T00:00:00.000Z',
      updatedAt: '2026-07-30T00:00:00.000Z',
    });
    expect(item).toMatchObject({
      type: 'client-compass',
      memoryClass: 'client_steering',
      memoryAuthority: 'client_approved',
      memoryScope: 'client',
      governedStatus: 'active',
      approvedByUserId: REVIEWER,
      sourceRef: 'chat',
    });
  });

  it('makes the approved canonical version eligible for Context Packet v2 with the same authority', async () => {
    const governance = buildCanonicalGovernance({
      record: record('firm'),
      sourceKind: 'explicit_user',
      candidateId: CANDIDATE,
      assertedByUserId: PROPOSER,
      approvedByUserId: REVIEWER,
      decision: 'approved',
      approvedAt: new Date('2026-07-30T00:00:00.000Z'),
    });
    const item = clioMemoryToItem({
      id: CLIO,
      tenantId: TENANT,
      scope: 'firm',
      ownerUserId: null,
      key: 'fy27-position',
      value: 'Support the verified plus-up.',
      source: 'chat',
      metadata: governedClioMetadata(governance),
      createdAt: '2026-07-30T00:00:00.000Z',
      updatedAt: '2026-07-30T00:00:00.000Z',
    });
    const steering: SteeringRow = {
      id: ITEM,
      type: item.type,
      slug: item.slug,
      title: item.title,
      clientId: item.clientId,
      ownerUserId: item.ownerUserId,
      visibility: item.visibility,
      status: item.status,
      legacyStatus: item.status,
      governedStatus: item.governedStatus,
      expiresAt: item.expiresAt ?? null,
      updatedAt: item.updatedAt,
      confirmedAt: item.lastConfirmedAt,
      authority: item.provenance,
      sections: item.sections,
      memoryClass: item.memoryClass,
      governedAuthority: item.memoryAuthority,
      sourceType: item.sourceType,
      sourceId: item.sourceId,
      sourceRef: item.sourceRef,
      sourceContentHash: item.sourceContentHash,
      sourceVersion: item.sourceVersion,
      assertedByUserId: item.assertedByUserId,
      approvedByUserId: item.approvedByUserId,
      approvedAt: item.approvedAt,
      asOf: item.asOf,
      effectiveFrom: item.effectiveFrom,
      validUntil: item.validUntil,
      conflictStatus: item.conflictStatus,
      conflictGroupId: item.conflictGroupId,
      controllingItemId: item.controllingItemId,
      sensitivity: item.sensitivity,
      instructionsAllowed: item.instructionsAllowed,
      originSurface: item.originSurface,
      originTraceId: item.originTraceId,
      originContextPacketId: item.originContextPacketId,
      originModel: item.originModel,
      originPromptVersion: item.originPromptVersion,
    };
    const compiler = new ContextCompiler({
      loadSteeringRows: async () => [steering],
      loadGovernedSteeringRows: async () => [steering],
    });

    const packet = await compiler.compile({
      tenantId: TENANT,
      effectiveTenantId: TENANT,
      userId: REVIEWER,
      actorUserId: REVIEWER,
      clientId: null,
      surface: 'ga-chat',
      layers: ['firm-playbook'],
      contractVersion: 2,
      ethicalWallAllowed: true,
      allowedSensitivities: ['normal'],
      now: new Date('2026-07-30T00:01:00.000Z'),
    });

    expect(packet.version).toBe(2);
    expect(packet.items).toHaveLength(1);
    expect(packet.items[0]).toMatchObject({
      id: ITEM,
      type: 'playbook',
      memoryClass: 'institutional_authoritative',
      authority: 'firm_approved',
      status: 'active',
      humanApproved: true,
    });
  });

  it('withholds the same canonical identity while governance is still pending review', async () => {
    const governance = buildCanonicalGovernance({
      record: record('firm'),
      sourceKind: 'explicit_user',
      candidateId: CANDIDATE,
      assertedByUserId: PROPOSER,
      approvedByUserId: REVIEWER,
      decision: 'approved',
    });
    const item = clioMemoryToItem({
      id: CLIO,
      tenantId: TENANT,
      scope: 'firm',
      ownerUserId: null,
      key: 'fy27-position',
      value: 'Support the verified plus-up.',
      source: 'chat',
      metadata: governedClioMetadata(governance),
      createdAt: '2026-07-30T00:00:00.000Z',
      updatedAt: '2026-07-30T00:00:00.000Z',
    });
    const steering: SteeringRow = {
      id: ITEM,
      type: item.type,
      slug: item.slug,
      title: item.title,
      clientId: item.clientId,
      ownerUserId: item.ownerUserId,
      visibility: item.visibility,
      status: item.status,
      legacyStatus: item.status,
      governedStatus: 'pending_review',
      sections: item.sections,
      memoryClass: item.memoryClass,
      governedAuthority: item.memoryAuthority,
      sourceType: item.sourceType,
      sourceId: item.sourceId,
      sourceRef: item.sourceRef,
      sourceVersion: item.sourceVersion,
      assertedByUserId: item.assertedByUserId,
      approvedByUserId: null,
      approvedAt: null,
      sensitivity: item.sensitivity,
      conflictStatus: item.conflictStatus,
    };
    const compiler = new ContextCompiler({
      loadSteeringRows: async () => [steering],
      loadGovernedSteeringRows: async () => [steering],
    });
    const packet = await compiler.compile({
      tenantId: TENANT,
      userId: REVIEWER,
      surface: 'ga-chat',
      layers: ['firm-playbook'],
      contractVersion: 2,
    });
    expect(packet.items).toEqual([]);
    expect(packet.exclusions).toEqual([
      expect.objectContaining({ id: ITEM, reason: 'unapproved' }),
    ]);
  });
});
