import { describe, expect, it, jest } from '@jest/globals';
import { ForbiddenException } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import { canonicalSha256, sha256Hex } from '../../auth/read-delegation/read-delegation.contract.js';
import type { MeriReadDelegationGrant } from '../../auth/read-delegation/read-delegation-request.js';

jest.mock('../../memory/memory-wall.helpers.js', () => ({
  clientMemoryAllowed: jest.fn(async () => true),
}));

import { clientMemoryAllowed } from '../../memory/memory-wall.helpers.js';
import { admitPassiveMemoryPage } from './meri-memory-page-admission.js';
import { readTaskBoundPassiveMemoryPage } from './meri-memory-signed-page-source.js';
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
      authorizationDecisionId: '88888888-8888-4888-8888-888888888888', policyRevision,
      scopes: [{ tenantId, kind: 'client', resourceId: clientId, policyRevision }], rosterVersionId: null },
    policyRevision, normalizationContext: { tenantId, userId: actorId } };
}

function grant(operation = 'search_memory', argumentsSha256 = canonicalSha256(memoryWire().input)) {
  return { delegationId: '99999999-9999-4999-8999-999999999999', mode: 'attended', tenantId, actorId,
    clientId, conversationId, runId, binding: { tenantId, actorId, conversationId, runId, attemptId, writerFence: 2 },
    admittedBinding: { tenantId, actorId, conversationId, runId, attemptId, workerId, writerFence: 2 },
    policyRevision, correlationSha256: canonicalSha256(correlation()), argumentsSha256,
    bodySha256: sha256Hex(JSON.stringify(memoryWire())),
    callKey: 'invocation_1', kind: 'tool', operation: { id: operation, version: '0.2.0' },
    toolRequestSha256: null, referenceSha256: null, jti: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    hardExpiryMs: nowMs + 5_000 } as MeriReadDelegationGrant;
}

describe('unmounted task-bound passive memory page admission', () => {
  it('pins the exact original worker binding, selected client, signed correlation and page hashes', () => {
    const accepted = admitPassiveMemoryPage(ctx, memoryWire(), grant(), correlation(), nowMs);
    expect(accepted).toMatchObject({ clientId, callKey: 'invocation_1',
      parentTokenJti: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      parentBodySha256: sha256Hex(JSON.stringify(memoryWire())),
      requestSha256: canonicalSha256(memoryWire()) });
    expect(Object.isFrozen(accepted.wire.input)).toBe(true);
  });

  it('refuses unselected personal recall, stale authority and a different reservation argument', () => {
    expect(() => admitPassiveMemoryPage(ctx, memoryWire(null), grant(), correlation(), nowMs))
      .toThrow(ForbiddenException);
    expect(() => admitPassiveMemoryPage(ctx, memoryWire(), grant(), correlation(), nowMs + 5_000))
      .toThrow(ForbiddenException);
    expect(() => admitPassiveMemoryPage(ctx, memoryWire(), grant('search_memory', 'b'.repeat(64)), correlation(), nowMs))
      .toThrow(ForbiddenException);
  });

  it('refuses a signed header with a substituted subject or original worker', () => {
    const substituted = correlation();
    substituted.subject.entityIds = [actorId];
    expect(() => admitPassiveMemoryPage(ctx, memoryWire(), grant(), substituted, nowMs))
      .toThrow(ForbiddenException);
    const changedGrant = grant();
    changedGrant.admittedBinding.workerId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    expect(() => admitPassiveMemoryPage(ctx, memoryWire(), changedGrant, correlation(), nowMs))
      .toThrow(ForbiddenException);
    const noEmittedBodyHash = grant();
    delete noEmittedBodyHash.bodySha256;
    expect(() => admitPassiveMemoryPage(ctx, memoryWire(), noEmittedBodyHash, correlation(), nowMs))
      .toThrow(ForbiddenException);
  });
});

describe('unmounted signed passive memory page composition', () => {
  it('reads the exact selected client, preserves the result and computes helper correlation after release recheck', async () => {
    const record = { recordId: workerId, payload: { title: 'Approved fact' } };
    const result = { tool: 'search_memory', records: [record], results: [{ id: workerId }] };
    const read = jest.fn(async () => result);
    const release = jest.fn(async () => undefined);
    const page = await readTaskBoundPassiveMemoryPage(ctx, memoryWire(), grant(), correlation(),
      { executeFromAuthenticatedUser: read } as never, release, () => nowMs);
    expect(read).toHaveBeenCalledWith(ctx, 'search_memory', memoryWire().input);
    expect(release).toHaveBeenCalledTimes(1);
    expect(page.result).toEqual(result);
    expect(page.eligibility).toMatchObject({
      parentTokenJti: grant().jti, parentBodySha256: sha256Hex(JSON.stringify(memoryWire())),
      callKey: grant().callKey, clientId,
      argumentsSha256: canonicalSha256(memoryWire().input),
      requestSha256: canonicalSha256(memoryWire()), resultSha256: canonicalSha256(result),
      records: [{ memoryItemId: workerId, recordSha256: canonicalSha256(record) }],
    });
  });

  it('withholds a page if the owner output or pre-byte delegation check fails', async () => {
    const read = jest.fn(async () => ({ tool: 'search_memory', records: [], results: [] }));
    const release = jest.fn(async () => { throw new ForbiddenException('revoked'); });
    await expect(readTaskBoundPassiveMemoryPage(ctx, memoryWire(), grant(), correlation(),
      { executeFromAuthenticatedUser: read } as never, release, () => nowMs))
      .rejects.toThrow(ForbiddenException);
    expect(release).toHaveBeenCalledTimes(1);

    const bad = jest.fn(async () => ({ tool: 'search_memory', records: [
      { recordId: workerId }, { recordId: workerId },
    ] }));
    const unreached = jest.fn(async () => undefined);
    await expect(readTaskBoundPassiveMemoryPage(ctx, memoryWire(), grant(), correlation(),
      { executeFromAuthenticatedUser: bad } as never, unreached, () => nowMs))
      .rejects.toThrow(ForbiddenException);
    expect(unreached).not.toHaveBeenCalled();
  });

  it('refuses a page that expires during retrieval or immediately after release', async () => {
    const result = { tool: 'search_memory', records: [], results: [] };
    const read = jest.fn(async () => result);
    const afterRead = jest.fn().mockReturnValueOnce(nowMs).mockReturnValueOnce(nowMs + 5_000);
    const release = jest.fn(async () => undefined);
    await expect(readTaskBoundPassiveMemoryPage(ctx, memoryWire(), grant(), correlation(),
      { executeFromAuthenticatedUser: read } as never, release, afterRead as () => number))
      .rejects.toThrow(ForbiddenException);
    expect(release).not.toHaveBeenCalled();

    const afterRelease = jest.fn().mockReturnValueOnce(nowMs).mockReturnValueOnce(nowMs)
      .mockReturnValueOnce(nowMs + 5_000);
    await expect(readTaskBoundPassiveMemoryPage(ctx, memoryWire(), grant(), correlation(),
      { executeFromAuthenticatedUser: read } as never, release, afterRelease as () => number))
      .rejects.toThrow(ForbiddenException);
    expect(release).toHaveBeenCalledTimes(1);
  });
});

describe('unmounted task-bound memory proposal continuation source', () => {
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

  it('accepts only the closed normalized selection bound to the delegated client', () => {
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
      grant('memory.list_own_proposals', canonicalSha256(selection)), p as never, o as never, () => nowMs);
    expect(result.scope).toEqual({ tenantId, userId: actorId, clientId });
    expect(o.listOwnProposals).toHaveBeenCalledWith(ctx, { clientId, limit: 5, status: 'pending' });
    expect(p.withTenantUser).toHaveBeenCalledTimes(2);
    expect(clientMemoryAllowed).toHaveBeenCalledTimes(2);

    const next = { ...selection, cursor: 'opaque-next' };
    await readTaskBoundMemoryProposalPage(ctx, next,
      grant('memory.list_own_proposals', canonicalSha256(next)), prisma() as never, owner([]) as never, () => nowMs);
  });

  it('withholds the page on a changed wall, wrong grant or stalled continuation', async () => {
    jest.mocked(clientMemoryAllowed).mockResolvedValueOnce(false);
    const o = owner();
    await expect(readTaskBoundMemoryProposalPage(ctx, selection,
      grant('memory.list_own_proposals', canonicalSha256(selection)), prisma() as never, o as never, () => nowMs))
      .rejects.toThrow(ForbiddenException);
    expect(o.listOwnProposals).not.toHaveBeenCalled();
    jest.mocked(clientMemoryAllowed).mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    await expect(readTaskBoundMemoryProposalPage(ctx, selection,
      grant('memory.list_own_proposals', canonicalSha256(selection)), prisma() as never,
      owner() as never, () => nowMs)).rejects.toThrow(ForbiddenException);
    await expect(readTaskBoundMemoryProposalPage(ctx, selection, grant(), prisma() as never,
      owner() as never, () => nowMs)).rejects.toThrow(ForbiddenException);
    const next = { ...selection, cursor: 'opaque-next' };
    await expect(readTaskBoundMemoryProposalPage(ctx, next,
      grant('memory.list_own_proposals', canonicalSha256(next)), prisma() as never,
      owner([row], 'opaque-next') as never, () => nowMs)).rejects.toThrow(ForbiddenException);
  });
});
