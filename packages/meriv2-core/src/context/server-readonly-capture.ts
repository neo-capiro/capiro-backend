import { createHmac, timingSafeEqual } from 'node:crypto';
import { validateMeriCase12SetupPolicyBinding, type MeriCase12SetupBinding } from './case12-setup-binding.js';
import {
  validateMeriSyntheticReadBudgetGuard,
  type MeriSyntheticReadBudgetBinding,
} from './synthetic-read-budget.js';

export const MERI_CAPTURE_POLICY_VERSION = 1 as const;
export const MERI_CAPTURE_POLICY_NAMESPACE = 'meri-foundation-20260928' as const;
export const MERI_CAPTURE_POLICY_HEADER = 'x-meri-server-readonly-capture' as const;

export const MERI_FIXTURE_SEMANTIC_INSTANT = '2026-09-26T16:00:00.000Z' as const;
export const MERI_FIXTURE_SEMANTIC_ZONE = 'America/New_York' as const;
export interface MeriPromptClockUse {
  instant: string;
  timeZone: string;
  date: string;
  renderedAt: number;
  groundingSha256: string;
}
export interface MeriFixtureSemanticClock {
  version: 1;
  kind: 'qualified_original_fixture_semantic_clock';
  instant: typeof MERI_FIXTURE_SEMANTIC_INSTANT;
  timeZone: typeof MERI_FIXTURE_SEMANTIC_ZONE;
  caseId: '01' | '12' | '14' | '20' | '46' | '72';
  captureRunId: string;
  currentVerifySha256: string;
  /** Real observation time; never used to rewind authority, expiry or deadlines. */
  observedAt: number;
}

/** Shape/binding validation only. API issuance additionally requires the current canonical owner. */
export function validateMeriFixtureSemanticClock(value: MeriFixtureSemanticClock, binding: {
  caseId: string | null; captureRunId: string | null; issuedAt: number; syntheticReadBudget?: unknown;
}): MeriFixtureSemanticClock {
  if (!value || binding.syntheticReadBudget ||
    Object.keys(value).sort().join('|') !== 'captureRunId|caseId|currentVerifySha256|instant|kind|observedAt|timeZone|version' ||
    value.version !== 1 || value.kind !== 'qualified_original_fixture_semantic_clock' ||
    value.instant !== MERI_FIXTURE_SEMANTIC_INSTANT || value.timeZone !== MERI_FIXTURE_SEMANTIC_ZONE ||
    !['01', '12', '14', '20', '46', '72'].includes(value.caseId) || value.caseId !== binding.caseId ||
    value.captureRunId !== binding.captureRunId ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value.captureRunId) ||
    !/^[a-f0-9]{64}$/.test(value.currentVerifySha256) ||
    !Number.isSafeInteger(value.observedAt) || value.observedAt !== binding.issuedAt) {
    throw new Error('meri_fixture_semantic_clock_invalid');
  }
  return value;
}

export interface MeriServerReadonlyCapturePolicy {
  case12Setup?: MeriCase12SetupBinding;
  semanticClock?: MeriFixtureSemanticClock;
  /** Independent accounting identity; all source/fixture fields remain null. */
  syntheticReadBudget?: MeriSyntheticReadBudgetBinding;
  version: typeof MERI_CAPTURE_POLICY_VERSION;
  kind: 'server_readonly_acceptance_capture';
  policyId: string;
  /** Server-generated correlation identities; never accepted from model/tool text. */
  requestId: string;
  traceId: string;
  /** Bound by the API after its authorized user-message write. */
  turnId: string | null;
  /** Current fixture-owner bindings. Null remains an explicit evidence blocker. */
  caseId: string | null;
  captureRunId: string | null;
  fixtureVersion: string | null;
  physicalMapSha256: string | null;
  resetReceiptId: string | null;
  seedReceiptId: string | null;
  fixtureNamespace: typeof MERI_CAPTURE_POLICY_NAMESPACE;
  tenantId: string;
  tenantSlug: 'meri-foundation-20260928-t1' | 'meri-foundation-20260928-t2';
  actorUserId: string;
  conversationId: string;
  clientId: string | null;
  issuedAt: number;
  expiresAt: number;
  toolAuthority: 'shared_static_registry_read_only';
  toolCatalogSha256: string;
  dynamicMcpAllowed: false;
  incidentalWriters: 'suppressed';
  expectedCaptureWrites: readonly [
    'context_packet_and_evidence',
    'conversation_user_message',
    'conversation_assistant_message',
    'provider_budget_ledger'?,
  ];
}

export interface MeriServerReadonlyCaptureReceipt {
  version: 1;
  policyId: string;
  fixtureNamespace: typeof MERI_CAPTURE_POLICY_NAMESPACE;
  authority: 'server_current';
  tenantId: string;
  actorUserId: string;
  conversationId: string;
  clientId: string | null;
  issuedAt: number;
  expiresAt: number;
  toolCatalogSha256: string;
  dispatchBoundary: 'read_only_enforced';
  dynamicMcpAllowed: false;
  incidentalWriters: 'suppressed';
  expectedCaptureWrites: MeriServerReadonlyCapturePolicy['expectedCaptureWrites'];
}

export type MeriCaptureTransportPurpose = 'tool' | 'action_proposal' | 'provider_budget';

interface MeriCapturePolicyTransport {
  version: 1;
  purpose: MeriCaptureTransportPurpose;
  toolName: string | null;
  policy: MeriServerReadonlyCapturePolicy;
  signature: string;
}

function transportPayload(
  policy: MeriServerReadonlyCapturePolicy,
  purpose: MeriCaptureTransportPurpose,
  toolName: string | null,
): string {
  return JSON.stringify({
    audience: 'capiro:meri:server-readonly-capture:v1',
    purpose,
    toolName,
    policy,
  });
}

export function encodeMeriCapturePolicyTransport(
  policy: MeriServerReadonlyCapturePolicy,
  purpose: MeriCaptureTransportPurpose,
  toolName: string | null,
  secret: string | undefined,
): string {
  if (!secret?.trim()) throw new Error('meri_capture_service_identity_unavailable');
  const normalizedTool = typeof toolName === 'string' && toolName.trim() ? toolName.trim() : null;
  const signature = createHmac('sha256', secret.trim())
    .update(transportPayload(policy, purpose, normalizedTool))
    .digest('hex');
  const envelope: MeriCapturePolicyTransport = {
    version: 1,
    purpose,
    toolName: normalizedTool,
    policy,
    signature,
  };
  return Buffer.from(JSON.stringify(envelope), 'utf8').toString('base64url');
}

export function decodeAndVerifyMeriCapturePolicyTransport(
  encoded: string | undefined,
  binding: {
    purpose: MeriCaptureTransportPurpose;
    toolName?: string | null;
    tenantId: string;
    actorUserId: string;
  },
  secret: string | undefined,
  now = Date.now(),
): MeriServerReadonlyCapturePolicy {
  if (!secret?.trim() || !encoded || encoded.length > 8_192) {
    throw new Error('meri_capture_transport_authentication_failed');
  }
  let envelope: MeriCapturePolicyTransport;
  try {
    envelope = JSON.parse(
      Buffer.from(encoded, 'base64url').toString('utf8'),
    ) as MeriCapturePolicyTransport;
  } catch {
    throw new Error('meri_capture_transport_authentication_failed');
  }
  const expectedTool =
    typeof binding.toolName === 'string' && binding.toolName.trim()
      ? binding.toolName.trim()
      : null;
  const policy = envelope?.policy;
  if (
    envelope?.version !== 1 ||
    envelope.purpose !== binding.purpose ||
    envelope.toolName !== expectedTool ||
    !policy ||
    policy.version !== 1 ||
    policy.kind !== 'server_readonly_acceptance_capture' ||
    policy.fixtureNamespace !== MERI_CAPTURE_POLICY_NAMESPACE ||
    policy.tenantId !== binding.tenantId ||
    policy.actorUserId !== binding.actorUserId ||
    policy.toolAuthority !== 'shared_static_registry_read_only' ||
    policy.dynamicMcpAllowed !== false ||
    policy.incidentalWriters !== 'suppressed' ||
    !Number.isSafeInteger(policy.issuedAt) ||
    !Number.isSafeInteger(policy.expiresAt) ||
    policy.issuedAt > now + 30_000 ||
    policy.expiresAt <= now ||
    policy.expiresAt - policy.issuedAt > 30 * 60_000 ||
    !/^[a-f0-9]{64}$/.test(policy.toolCatalogSha256) ||
    !/^[a-f0-9-]{20,100}$/i.test(policy.policyId) ||
    !/^[a-f0-9-]{20,100}$/i.test(policy.requestId) ||
    !/^[a-f0-9-]{20,100}$/i.test(policy.traceId) ||
    (policy.turnId !== null && !policy.turnId.trim()) ||
    (policy.caseId !== null && !/^(0[1-9]|[1-6][0-9]|7[0-5])$/.test(policy.caseId)) ||
    (policy.captureRunId !== null && !policy.captureRunId.trim()) ||
    (policy.fixtureVersion !== null && !policy.fixtureVersion.trim()) ||
    (policy.physicalMapSha256 !== null && !/^[a-f0-9]{64}$/.test(policy.physicalMapSha256)) ||
    (policy.resetReceiptId !== null && !policy.resetReceiptId.trim()) ||
    (policy.seedReceiptId !== null && !policy.seedReceiptId.trim()) ||
    !/^[a-f0-9]{64}$/.test(envelope.signature)
  ) {
    throw new Error('meri_capture_transport_authentication_failed');
  }
  const expected = createHmac('sha256', secret.trim())
    .update(transportPayload(policy, envelope.purpose, envelope.toolName))
    .digest();
  const supplied = Buffer.from(envelope.signature, 'hex');
  if (supplied.length !== expected.length || !timingSafeEqual(expected, supplied)) {
    throw new Error('meri_capture_transport_authentication_failed');
  }
  validateMeriSyntheticReadBudgetGuard(policy);
  validateMeriCase12SetupPolicyBinding(policy);
  if (policy.semanticClock) validateMeriFixtureSemanticClock(policy.semanticClock, policy);
  return policy;
}
