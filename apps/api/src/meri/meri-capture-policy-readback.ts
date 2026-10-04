import { ForbiddenException } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import {
  verifyMeriCaptureEvidenceReceipt,
  validateMeriSyntheticReadBudgetGuard,
  validateMeriFixtureSemanticClock,
  validateMeriCase12SetupPolicyBinding,
  meriCase12SetupBindingsEqual,
  type MeriServerReadonlyCapturePolicy,
  type SignedMeriCaptureEvidenceReceipt,
} from '@capiro/meriv2-core';
import type { PrismaService } from '../prisma/prisma.service.js';
import { assertMeriServerReadonlyCaptureCurrentAuthority } from './meri-server-readonly-capture.js';
import { captureProviderBudgetOwner } from './meri-capture-provider-budget-owner.js';
import { captureBudgetHash } from './meri-capture-provider-budget.js';
import { authorizeSyntheticReadBudgetMessageReadback } from './meri-synthetic-read-budget-owner.js';

const POLICY_FIELDS = [
  'version',
  'kind',
  'policyId',
  'requestId',
  'traceId',
  'turnId',
  'caseId',
  'captureRunId',
  'fixtureVersion',
  'physicalMapSha256',
  'resetReceiptId',
  'seedReceiptId',
  'fixtureNamespace',
  'tenantId',
  'tenantSlug',
  'actorUserId',
  'conversationId',
  'clientId',
  'issuedAt',
  'expiresAt',
  'toolAuthority',
  'toolCatalogSha256',
  'dynamicMcpAllowed',
  'incidentalWriters',
  'expectedCaptureWrites',
].sort();

function denied(): never {
  // Never return receipt, policy, secret or parser diagnostics in an error.
  throw new ForbiddenException('meri_capture_policy_readback_denied');
}

/** The stored policy is an API-issued input, never reconstructed from the receipt. */
export function validateMeriCapturePolicyPair(
  value: unknown,
  envelope: unknown,
  now = Date.now(),
): MeriServerReadonlyCapturePolicy {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) denied();
    const policy = value as MeriServerReadonlyCapturePolicy;
    const fields = [...POLICY_FIELDS,
      ...(Object.hasOwn(value, 'syntheticReadBudget') ? ['syntheticReadBudget'] : []),
      ...(Object.hasOwn(value, 'semanticClock') ? ['semanticClock'] : []),
      ...(Object.hasOwn(value, 'case12Setup') ? ['case12Setup'] : []),
    ].sort();
    if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(fields)) denied();
    validateMeriSyntheticReadBudgetGuard(policy);
    validateMeriCase12SetupPolicyBinding(policy);
    const clockQualified = !policy.syntheticReadBudget && policy.fixtureVersion === 'meri-live-v1-2026-09-26.1' &&
      ['01', '12', '14', '20', '72'].includes(policy.caseId ?? '');
    if (clockQualified !== Boolean(policy.semanticClock)) denied();
    if (Object.hasOwn(value, 'semanticClock')) validateMeriFixtureSemanticClock(policy.semanticClock!, policy);
    if (
      !Number.isSafeInteger(policy.issuedAt) ||
      !Number.isSafeInteger(policy.expiresAt) ||
      policy.issuedAt > now + 30_000 ||
      policy.expiresAt <= now ||
      policy.expiresAt <= policy.issuedAt ||
      policy.expiresAt - policy.issuedAt > 30 * 60_000 ||
      typeof policy.turnId !== 'string' ||
      !policy.turnId.trim() ||
      !/^[a-f0-9-]{20,100}$/i.test(policy.policyId) ||
      !Array.isArray(policy.expectedCaptureWrites)
    )
      denied();
    const receipt = verifyMeriCaptureEvidenceReceipt(
      envelope as SignedMeriCaptureEvidenceReceipt,
      policy,
      process.env.INTERNAL_SERVICE_SECRET,
      now,
    );
    if (receipt.fixture.namespace !== policy.fixtureNamespace) denied();
    if (policy.caseId === '12') {
      if (receipt.fixture.case12Setup?.status !== 'OBSERVED' ||
          !meriCase12SetupBindingsEqual(receipt.fixture.case12Setup.value, policy.case12Setup)) denied();
    } else if (Object.hasOwn(receipt.fixture, 'case12Setup')) denied();
    for (const [key, expected] of [
      ['version', policy.fixtureVersion],
      ['physicalMapSha256', policy.physicalMapSha256],
      ['resetReceiptId', policy.resetReceiptId],
      ['seedReceiptId', policy.seedReceiptId],
    ] as const) {
      const observation = receipt.fixture[key];
      if (expected === null) {
        if (observation.status === 'OBSERVED' || observation.value !== null) denied();
      } else if (
        typeof expected !== 'string' ||
        !expected.trim() ||
        observation.status !== 'OBSERVED' ||
        observation.value !== expected
      )
        denied();
    }
    return policy;
  } catch {
    return denied();
  }
}

interface CaptureMessage {
  id: string;
  role: string;
  tenantId: string;
  userId: string;
  conversationId: string;
  clientId: string | null;
  metadata: unknown;
}

/** Additional authority checks only for server-capture metadata on the existing GET. */
export async function authorizeMeriCaptureMessageReadback(args: {
  prisma: PrismaService;
  ctx: TenantContext;
  conversationId: string;
  message: CaptureMessage;
}): Promise<void> {
  const row = args.message;
  const metadata =
    row.metadata && typeof row.metadata === 'object' && !Array.isArray(row.metadata)
      ? (row.metadata as Record<string, unknown>)
      : {};
  if (
    ![
      'serverReadonlyCapturePolicy',
      'serverCaptureEvidenceReceipt',
      'serverReadonlyCaptureReceipt',
    ].some((key) => Object.hasOwn(metadata, key))
  )
    return;
  // Budget-only turns deliberately persist a public dispatch receipt, not a
  // signed fixture/capture receipt. Re-read their separate current owner.
  if (
    Object.hasOwn(metadata, 'serverReadonlyCaptureReceipt') &&
    !Object.hasOwn(metadata, 'serverReadonlyCapturePolicy') &&
    !Object.hasOwn(metadata, 'serverCaptureEvidenceReceipt')
  ) {
    try {
      await authorizeSyntheticReadBudgetMessageReadback(args);
      return;
    } catch {
      return denied();
    }
  }
  const policy = validateMeriCapturePolicyPair(
    metadata.serverReadonlyCapturePolicy,
    metadata.serverCaptureEvidenceReceipt,
  );
  if (
    row.role !== 'assistant' ||
    row.tenantId !== args.ctx.tenantId ||
    row.userId !== args.ctx.userId ||
    row.conversationId !== args.conversationId ||
    policy.conversationId !== args.conversationId ||
    row.clientId !== policy.clientId
  )
    denied();
  await assertMeriServerReadonlyCaptureCurrentAuthority({
    prisma: args.prisma,
    ctx: args.ctx,
    policy,
  });
  const userMessage = await args.prisma.withTenant(args.ctx.tenantId, (tx) =>
    tx.clioMessage.findFirst({
      where: {
        id: policy.turnId!,
        role: 'user',
        tenantId: args.ctx.tenantId,
        userId: args.ctx.userId,
        conversationId: args.conversationId,
        clientId: policy.clientId,
      },
      select: { id: true },
    }),
  );
  if (!userMessage) denied();
  const receipt = (metadata.serverCaptureEvidenceReceipt as SignedMeriCaptureEvidenceReceipt)
    .receipt;
  if (receipt.providerBudget) {
    const { state } = await captureProviderBudgetOwner({
      prisma: args.prisma,
      ctx: args.ctx,
      policy,
      operation: { kind: 'read' },
    });
    if (
      receipt.providerBudget.ledgerSha256 !== captureBudgetHash(state) ||
      receipt.providerBudget.admissionId !== state.admissionId ||
      receipt.providerBudget.maxCostMicros !== state.ledger.limits.maxCostMicros ||
      receipt.providerBudget.turnId !== policy.turnId
    )
      denied();
    const ledgerWrites = receipt.effects.writes.filter(
      (write) => write.kind === 'provider_budget_ledger',
    );
    if (
      policy.expectedCaptureWrites[3] !== 'provider_budget_ledger' ||
      ledgerWrites.length !== 1 ||
      ledgerWrites[0]?.recordId !== policy.conversationId ||
      ledgerWrites[0].status !== 'observed'
    )
      denied();
  }
  for (const [kind, expectedId] of [
    ['conversation_user_message', policy.turnId],
    ['conversation_assistant_message', row.id],
    ['assistant_receipt_metadata', row.id],
  ] as const) {
    const writes = receipt.effects.writes.filter((write) => write.kind === kind);
    if (
      !writes.length ||
      writes.some((write) => write.recordId !== expectedId || write.status !== 'observed')
    )
      denied();
  }
  // Re-check after canonical turn readback before returning private capture metadata.
  await assertMeriServerReadonlyCaptureCurrentAuthority({
    prisma: args.prisma,
    ctx: args.ctx,
    policy,
  });
}
