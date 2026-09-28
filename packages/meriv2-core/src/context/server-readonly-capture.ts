import { createHmac, timingSafeEqual } from 'node:crypto';

export const MERI_CAPTURE_POLICY_VERSION = 1 as const;
export const MERI_CAPTURE_POLICY_NAMESPACE = 'meri-foundation-20260928' as const;
export const MERI_CAPTURE_POLICY_HEADER = 'x-meri-server-readonly-capture' as const;

export interface MeriServerReadonlyCapturePolicy {
  version: typeof MERI_CAPTURE_POLICY_VERSION;
  kind: 'server_readonly_acceptance_capture';
  policyId: string;
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

export type MeriCaptureTransportPurpose = 'tool' | 'action_proposal';

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
    envelope = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as MeriCapturePolicyTransport;
  } catch {
    throw new Error('meri_capture_transport_authentication_failed');
  }
  const expectedTool =
    typeof binding.toolName === 'string' && binding.toolName.trim() ? binding.toolName.trim() : null;
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
  return policy;
}
