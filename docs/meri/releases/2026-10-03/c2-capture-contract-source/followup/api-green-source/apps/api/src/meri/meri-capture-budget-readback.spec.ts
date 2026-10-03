jest.mock('./meri-server-readonly-capture.js', () => ({
  assertMeriServerReadonlyCaptureCurrentAuthority: jest.fn(async () => undefined),
}));
jest.mock('./meri-capture-provider-budget-owner.js', () => ({
  captureProviderBudgetOwner: jest.fn(),
}));

import {
  completeMeriCaptureEvidenceReceipt,
  signMeriCaptureEvidenceReceipt,
  type MeriServerReadonlyCapturePolicy,
} from '@capiro/meriv2-core';
import { buildApiOnlyMeriServerCaptureEvidence } from './meri-server-capture-evidence.js';
import { captureProviderBudgetOwner } from './meri-capture-provider-budget-owner.js';
import { captureBudgetHash } from './meri-capture-provider-budget.js';
import { authorizeMeriCaptureMessageReadback } from './meri-capture-policy-readback.js';

const id = (n: string) =>
  `${n.repeat(8)}-${n.repeat(4)}-4${n.repeat(3)}-8${n.repeat(3)}-${n.repeat(12)}`;
const SECRET = 'local-receipt-ceiling-secret';

describe('capture receipt ceiling remains bound to the current qualified ledger', () => {
  it.each([15_000_000, 14_000_000, 15_000_001])(
    'checks signed receipt limit %s against the actual owner state',
    async (ceiling) => {
      const issuedAt = Date.now();
      const policy: MeriServerReadonlyCapturePolicy = {
        version: 1,
        kind: 'server_readonly_acceptance_capture',
        policyId: id('1'),
        requestId: id('2'),
        traceId: id('3'),
        turnId: id('4'),
        caseId: '01',
        captureRunId: id('5'),
        fixtureVersion: 'local-storage-test',
        physicalMapSha256: 'a'.repeat(64),
        resetReceiptId: 'reset',
        seedReceiptId: 'seed',
        fixtureNamespace: 'meri-foundation-20260928',
        tenantId: id('6'),
        tenantSlug: 'meri-foundation-20260928-t1',
        actorUserId: id('7'),
        conversationId: id('8'),
        clientId: id('9'),
        issuedAt,
        expiresAt: issuedAt + 60000,
        toolAuthority: 'shared_static_registry_read_only',
        toolCatalogSha256: 'b'.repeat(64),
        dynamicMcpAllowed: false,
        incidentalWriters: 'suppressed',
        expectedCaptureWrites: [
          'context_packet_and_evidence',
          'conversation_user_message',
          'conversation_assistant_message',
          'provider_budget_ledger',
        ],
      };
      const ctx = { tenantId: policy.tenantId, userId: policy.actorUserId } as never;
      // This test isolates summary-to-owner equality. Canonical ledger authority
      // and actual SQL remain covered by capture-provider-budget.postgres tests.
      const state = { admissionId: id('1'), ledger: { limits: { maxCostMicros: 15_000_000 } } };
      (captureProviderBudgetOwner as jest.Mock).mockResolvedValueOnce({ state });
      const before = process.env.INTERNAL_SERVICE_SECRET;
      process.env.INTERNAL_SERVICE_SECRET = SECRET;
      try {
        const assistantMessageId = id('2');
        const base = buildApiOnlyMeriServerCaptureEvidence({
          policy,
          userMessageId: policy.turnId!,
          assistantMessageId,
          citations: [],
          usage: null,
          secret: SECRET,
        });
        const receipt = signMeriCaptureEvidenceReceipt(
          completeMeriCaptureEvidenceReceipt({
            ...base.receipt,
            providerBudget: {
              version: 1,
              boundary: 'case01_memory_turn',
              status: 'SETTLED',
              admissionId: state.admissionId,
              turnId: policy.turnId!,
              ledgerSha256: captureBudgetHash(state),
              qualificationSha256: 'c'.repeat(64),
              attempts: 5,
              chargedTokens: 90733,
              chargedCostMicros: 2_292_602,
              maxCostMicros: ceiling,
              unaccountedBoundaries: [],
            },
            effects: {
              ...base.receipt.effects,
              writes: [
                ...base.receipt.effects.writes,
                {
                  logicalWriteId: 'ledger',
                  kind: 'provider_budget_ledger',
                  phase: 'during',
                  status: 'observed',
                  recordId: policy.conversationId,
                },
              ],
            },
          }),
          SECRET,
        );
        const prisma = {
          withTenant: async (_tenant: string, fn: (tx: unknown) => unknown) =>
            fn({ clioMessage: { findFirst: async () => ({ id: policy.turnId }) } }),
        } as never;
        const call = authorizeMeriCaptureMessageReadback({
          prisma,
          ctx,
          conversationId: policy.conversationId,
          message: {
            id: assistantMessageId,
            role: 'assistant',
            tenantId: policy.tenantId,
            userId: policy.actorUserId,
            conversationId: policy.conversationId,
            clientId: policy.clientId,
            metadata: {
              serverReadonlyCapturePolicy: policy,
              serverCaptureEvidenceReceipt: receipt,
            },
          },
        });
        if (ceiling === 15_000_000) await expect(call).resolves.toBeUndefined();
        else await expect(call).rejects.toMatchObject({ status: 403 });
        expect(captureProviderBudgetOwner).toHaveBeenLastCalledWith(
          expect.objectContaining({ policy, operation: { kind: 'read' } }),
        );
      } finally {
        if (before === undefined) delete process.env.INTERNAL_SERVICE_SECRET;
        else process.env.INTERNAL_SERVICE_SECRET = before;
        jest.clearAllMocks();
      }
    },
  );
});
