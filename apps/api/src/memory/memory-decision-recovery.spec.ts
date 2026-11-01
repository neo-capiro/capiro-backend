import { randomUUID } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import type { TenantContext } from '@capiro/shared';
import type { MemoryAuthorizationService } from './memory-authorization.service.js';
import { sanitizeAuditMetadata } from './memory-governance-lifecycle.helpers.js';
import {
  memoryDecisionMetadata,
  recoverMemoryDecisionInTx,
  type MemoryDecisionAction,
  type RecordedMemoryDecision,
} from './memory-decision-recovery.js';

const ctx = { tenantId: randomUUID(), userId: randomUUID(), role: 'user_admin' } as TenantContext;
const candidateId = randomUUID(),
  memoryId = randomUUID(),
  conflictGroupId = randomUUID(),
  targetId = randomUUID();
function harness(action: MemoryDecisionAction, result: RecordedMemoryDecision, reason = '') {
  const state = {
    present: true,
    role: 'user_admin',
    actor: ctx.userId,
    access: true,
    status: action === 'reject' ? 'rejected' : 'approved',
    sourceKind: ['standard', 'learning_signal_conflict'].includes(result.candidateKind)
      ? result.candidateKind === 'standard'
        ? 'settings_sections'
        : 'learning_signal'
      : 'memory_' + result.candidateKind,
    receipts: [sanitizeAuditMetadata(memoryDecisionMetadata(action, result, reason))] as Record<
      string,
      unknown
    >[],
  };
  const tx = {
    $queryRaw: jest.fn(async (parts: TemplateStringsArray) => {
      const sql = parts.join('?');
      if (sql.includes('FROM memory_candidate'))
        return state.present
          ? [{ status: state.status, decidedBy: state.actor, sourceKind: state.sourceKind }]
          : [];
      if (sql.includes('FROM tenant_memberships')) return [{ role: state.role }];
      if (sql.includes('FROM memory_transition_audit'))
        return state.receipts.map((metadata) => ({ metadata }));
      throw Error('Unexpected recovery query');
    }),
  } as unknown as Prisma.TransactionClient;
  const auth = {
    loadCandidateInTx: jest.fn(async () => ({ id: candidateId })),
    evaluateInTx: jest.fn(async () => ({ allowed: state.access })),
  } as unknown as MemoryAuthorizationService;
  return {
    state,
    auth,
    recover: (a = action, r = reason) =>
      recoverMemoryDecisionInTx(tx, ctx, auth, candidateId, a, r),
  };
}
const cases: [MemoryDecisionAction, RecordedMemoryDecision][] = [
  ['approve', { candidateId, candidateKind: 'standard', outcome: 'activated', memoryId }],
  ['reject', { candidateId, candidateKind: 'standard', outcome: 'rejected' }],
  [
    'approve',
    {
      candidateId,
      candidateKind: 'correction',
      outcome: 'activated',
      memoryItemId: memoryId,
      controllingItemId: memoryId,
    },
  ],
  [
    'approve',
    {
      candidateId,
      candidateKind: 'restore',
      outcome: 'duplicate',
      memoryItemId: memoryId,
      controllingItemId: memoryId,
    },
  ],
  [
    'approve',
    {
      candidateId,
      candidateKind: 'contradiction',
      outcome: 'conflict',
      memoryItemId: memoryId,
      controllingItemId: targetId,
      conflictGroupId,
    },
  ],
  ['reject', { candidateId, candidateKind: 'correction', outcome: 'rejected' }],
  [
    'duplicate',
    {
      candidateId,
      candidateKind: 'learning_signal_conflict',
      decision: 'duplicate',
      outcome: 'duplicate',
      memoryItemId: memoryId,
      controllingItemId: memoryId,
    },
  ],
  [
    'corroborate_existing',
    {
      candidateId,
      candidateKind: 'learning_signal_conflict',
      decision: 'corroborate_existing',
      outcome: 'corroborated',
      memoryItemId: memoryId,
      controllingItemId: memoryId,
    },
  ],
  [
    'supersede_existing',
    {
      candidateId,
      candidateKind: 'learning_signal_conflict',
      decision: 'supersede_existing',
      outcome: 'activated',
      memoryItemId: memoryId,
      controllingItemId: memoryId,
    },
  ],
  [
    'conflict_requires_review',
    {
      candidateId,
      candidateKind: 'learning_signal_conflict',
      decision: 'conflict_requires_review',
      outcome: 'conflict',
      memoryItemId: memoryId,
      controllingItemId: targetId,
      conflictGroupId,
    },
  ],
];
describe('Content-free memory transition decision recovery', () => {
  it.each(cases)(
    'retains the exact %s result through audit sanitization: %j',
    async (action, result) => {
      const h = harness(action, result, 'Private review explanation');
      expect(JSON.stringify(h.state.receipts)).not.toContain('Private review explanation');
      expect(await h.recover()).toEqual(result);
      expect(h.auth.evaluateInTx).toHaveBeenCalledWith(
        expect.anything(),
        ctx,
        expect.anything(),
        'read',
        { emitDenialMetrics: false },
      );
    },
  );
  it.each([
    ['decisionVersion', 2],
    ['decisionMemoryId', 'not-a-uuid'],
    ['decisionKind', 'correction'],
    ['decisionOutcome', 'rejected'],
    ['decisionReasonHash', null],
    ['decisionMemoryItemId', memoryId],
  ])('refuses inconsistent receipt %s without inventing an outcome', async (key, value) => {
    const h = harness(...cases[0]!);
    h.state.receipts[0]![key as string] = value;
    await expect(h.recover()).rejects.toThrow('unavailable');
  });
  it.each(['missing', 'duplicate'] as const)('refuses %s evidence', async (mode) => {
    const h = harness(...cases[0]!);
    h.state.receipts = mode === 'missing' ? [] : [h.state.receipts[0]!, h.state.receipts[0]!];
    await expect(h.recover()).rejects.toThrow('unavailable');
  });
  it.each(['absent', 'other_actor', 'role_changed', 'wall_denied'] as const)(
    'rechecks %s before reading the outcome',
    async (condition) => {
      const h = harness(...cases[0]!);
      if (condition === 'absent') h.state.present = false;
      if (condition === 'other_actor') h.state.actor = randomUUID();
      if (condition === 'role_changed') h.state.role = 'standard_user';
      if (condition === 'wall_denied') h.state.access = false;
      await expect(h.recover()).rejects.toThrow();
    },
  );
  it('refuses another resolution or changed reason for the decided candidate', async () => {
    const h = harness(...cases[6]!, 'Original reason');
    await expect(h.recover('corroborate_existing', 'Original reason')).rejects.toThrow(
      'different action or reason',
    );
    await expect(h.recover('duplicate', 'New reason')).rejects.toThrow(
      'different action or reason',
    );
  });
});
