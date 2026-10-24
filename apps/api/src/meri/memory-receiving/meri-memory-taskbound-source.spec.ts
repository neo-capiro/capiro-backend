import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { ForbiddenException } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';

jest.mock('../../memory/memory-wall.helpers.js', () => ({
  clientMemoryAllowed: jest.fn(async () => true),
}));

import { clientMemoryAllowed } from '../../memory/memory-wall.helpers.js';
import { readPassiveMemoryPage } from './meri-memory-page-source.js';
import { parseTaskBoundMemoryProposalSelection, readTaskBoundMemoryProposalPage } from './meri-memory-proposal-source.js';

const tenantId = '11111111-1111-4111-8111-111111111111';
const actorId = '22222222-2222-4222-8222-222222222222';
const clientId = '33333333-3333-4333-8333-333333333333';
const conversationId = '44444444-4444-4444-8444-444444444444';
const runId = '55555555-5555-4555-8555-555555555555';
const attemptId = '66666666-6666-4666-8666-666666666666';
const workerId = '77777777-7777-4777-8777-777777777777';
const policyRevision = 'a'.repeat(64);
const nowMs = 1_792_000_000_000;
const ctx = { tenantId, userId: actorId, role: 'standard_user' } as TenantContext;

function memoryWire(selected: string | null = clientId) {
  return { input: { query: 'authorized memory', clientId: selected, k: 3, cursor: null,
    memoryItemId: null, contentCursor: null },
  metadata: { sourceConnected: false, authoritative: false, currentPolicyQualified: false,
    cursorAuthenticated: false, absenceEvidence: false } };
}

function correlation() {
  return { binding: { tenantId, actorId, conversationId, runId, attemptId, workerId, writerFence: 2 },
    subject: { kind: 'client', entityType: 'client', entityIds: [clientId], tenantId, actorId,
      policyRevision,
      scopes: [{ tenantId, kind: 'client', resourceId: clientId, policyRevision }], rosterVersionId: null },
    policyRevision, normalizationContext: { tenantId, userId: actorId } };
}

describe('ordinary passive memory source', () => {
  const page = { tool: 'search_memory', records: [{ recordId: workerId, payload: { title: 'Approved fact' } }],
    results: [{ id: workerId }] };
  it('reads the selected client through the canonical owner and returns its bounded page', async () => {
    const read = jest.fn(async () => page);
    expect(await readPassiveMemoryPage(ctx, memoryWire(), correlation(), true, nowMs + 5_000,
      { executeFromAuthenticatedUser: read } as never, () => nowMs)).toEqual(page);
    expect(read).toHaveBeenCalledWith(ctx, 'search_memory', memoryWire().input);
  });

  it('allows explicit actor General memory and never supplies another client to the owner', async () => {
    const held = correlation();
    const general = { ...held, subject: { ...held.subject, kind: 'personal', entityType: 'user', entityIds: [actorId],
      scopes: [{ tenantId, kind: 'private-user', resourceId: actorId, policyRevision }] } };
    const read = jest.fn(async () => page);
    await readPassiveMemoryPage(ctx, memoryWire(null), general, true, nowMs + 5_000,
      { executeFromAuthenticatedUser: read } as never, () => nowMs);
    expect(read).toHaveBeenCalledWith(ctx, 'search_memory', memoryWire(null).input);
    read.mockClear();
    await expect(readPassiveMemoryPage(ctx, memoryWire(actorId), general, true, nowMs + 5_000,
      { executeFromAuthenticatedUser: read } as never, () => nowMs)).rejects.toThrow(ForbiddenException);
    expect(read).not.toHaveBeenCalled();
  });

  it('refuses wrong service, actor/tenant context and stale requests before owner access', async () => {
    for (const [held, service, deadline] of [
      [correlation(), false, nowMs + 5_000], [correlation(), true, nowMs],
      [{ ...correlation(), normalizationContext: { tenantId: actorId, userId: actorId } }, true, nowMs + 5_000],
      [{ ...correlation(), normalizationContext: { tenantId, userId: clientId } }, true, nowMs + 5_000],
    ] as const) {
      const read = jest.fn(async () => page);
      await expect(readPassiveMemoryPage(ctx, memoryWire(), held, service, deadline,
        { executeFromAuthenticatedUser: read } as never, () => nowMs)).rejects.toThrow(ForbiddenException);
      expect(read).not.toHaveBeenCalled();
    }
  });

  it('withholds duplicated/overfull/malformed owner records and output after expiry', async () => {
    for (const records of [[{ recordId: workerId }, { recordId: workerId }],
      [{ recordId: 'not-a-record' }], Array.from({ length: 4 }, () => ({ recordId: workerId }))]) {
      const read = jest.fn(async () => ({ ...page, records }));
      await expect(readPassiveMemoryPage(ctx, memoryWire(), correlation(), true, nowMs + 5_000,
        { executeFromAuthenticatedUser: read } as never, () => nowMs)).rejects.toThrow(ForbiddenException);
    }
    let stamp = nowMs;
    const read = jest.fn(async () => { stamp += 5_000; return page; });
    await expect(readPassiveMemoryPage(ctx, memoryWire(), correlation(), true, nowMs + 5_000,
      { executeFromAuthenticatedUser: read } as never, () => stamp)).rejects.toThrow(ForbiddenException);
  });

  it('preserves a canonical empty-query response', async () => {
    const empty = { error: 'Provide a search query.' };
    const read = jest.fn(async () => empty);
    expect(await readPassiveMemoryPage(ctx, memoryWire(), correlation(), true, nowMs + 5_000,
      { executeFromAuthenticatedUser: read } as never, () => nowMs)).toEqual(empty);
  });
});

describe('ordinary memory proposal continuation source', () => {
  beforeEach(() => { jest.clearAllMocks(); jest.mocked(clientMemoryAllowed).mockResolvedValue(true); });
  const selection = { clientId, cursor: null, limit: 5 };
  const row = { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', scope: 'client', clientId,
    sourceKind: 'user_chat', status: 'pending', createdAt: '2026-10-18T12:00:00.000Z',
    decidedAt: null, restricted: false, proposal: { key: 'Preference', value: 'Use SMS', canonicalItem: null },
    capabilities: { withdraw: true } };
  const prisma = () => ({ withTenantUser: jest.fn(async (_tenant: string, _actor: string,
    action: (tx: object) => Promise<unknown>) => action({})) });
  const owner = (rows = [row], nextCursor: string | null = null) => ({
    listOwnProposals: jest.fn(async () => ({ enabled: true, candidates: rows, nextCursor })),
  });

  it('accepts only the closed normalized selection for the selected client', () => {
    expect(parseTaskBoundMemoryProposalSelection(selection)).toEqual(selection);
    expect(() => parseTaskBoundMemoryProposalSelection({ ...selection, actorId })).toThrow(ForbiddenException);
    expect(() => parseTaskBoundMemoryProposalSelection({ ...selection, cursor: '' })).toThrow(ForbiddenException);
    expect(() => parseTaskBoundMemoryProposalSelection({ ...selection, limit: 11 })).toThrow(ForbiddenException);
    expect(() => parseTaskBoundMemoryProposalSelection({ ...selection,
      clientId: '33333333-3333-0333-8333-333333333333' })).toThrow(ForbiddenException);
  });

  it('rechecks the client wall before and after the canonical owner page, including continuation', async () => {
    const p = prisma(), o = owner();
    const result = await readTaskBoundMemoryProposalPage(ctx, selection,
      nowMs + 5_000, p as never, o as never, () => nowMs);
    expect(result.scope).toEqual({ tenantId, userId: actorId, clientId });
    expect(o.listOwnProposals).toHaveBeenCalledWith(ctx, { clientId, limit: 5, status: 'pending' });
    expect(p.withTenantUser).toHaveBeenCalledTimes(2);
    expect(clientMemoryAllowed).toHaveBeenCalledTimes(2);

    const next = { ...selection, cursor: 'opaque-next' };
    await readTaskBoundMemoryProposalPage(ctx, next,
      nowMs + 5_000, prisma() as never, owner([]) as never, () => nowMs);
  });

  it('withholds the page on a changed wall, expired request or stalled continuation', async () => {
    jest.mocked(clientMemoryAllowed).mockResolvedValueOnce(false);
    const o = owner();
    await expect(readTaskBoundMemoryProposalPage(ctx, selection,
      nowMs + 5_000, prisma() as never, o as never, () => nowMs))
      .rejects.toThrow(ForbiddenException);
    expect(o.listOwnProposals).not.toHaveBeenCalled();
    jest.mocked(clientMemoryAllowed).mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    await expect(readTaskBoundMemoryProposalPage(ctx, selection,
      nowMs + 5_000, prisma() as never,
      owner() as never, () => nowMs)).rejects.toThrow(ForbiddenException);
    await expect(readTaskBoundMemoryProposalPage(ctx, selection, nowMs, prisma() as never,
      owner() as never, () => nowMs)).rejects.toThrow(ForbiddenException);
    const next = { ...selection, cursor: 'opaque-next' };
    await expect(readTaskBoundMemoryProposalPage(ctx, next,
      nowMs + 5_000, prisma() as never,
      owner([row], 'opaque-next') as never, () => nowMs)).rejects.toThrow(ForbiddenException);
  });
});
