import { randomUUID } from 'node:crypto';
import {
  MERI_CASE46,
  encodeMeriGovernedArtifactTransport,
  decodeMeriGovernedArtifactTransport,
  validateMeriGovernedArtifactPolicy,
  assertMeriCase46ToolInput,
  type MeriGovernedArtifactCapturePolicy,
} from './governed-artifact-capture';
import { decodeAndVerifyMeriCapturePolicyTransport } from './server-readonly-capture';

const policy = (): MeriGovernedArtifactCapturePolicy => ({
  version: 1,
  kind: 'governed_artifact_acceptance_capture',
  caseId: '46',
  fixtureNamespace: MERI_CASE46.namespace,
  tenantId: MERI_CASE46.tenantId,
  tenantSlug: MERI_CASE46.tenantSlug,
  actorUserId: MERI_CASE46.actorUserId,
  clientId: MERI_CASE46.clientId,
  conversationId: randomUUID(),
  captureRunId: randomUUID(),
  policyId: randomUUID(),
  requestId: 'test-request',
  traceId: 'test-trace',
  turnId: randomUUID(),
  source: {
    owner: 'engagement_attachment',
    logicalId: 'ARTIFACT-BRIEF-1',
    physicalId: randomUUID(),
    rowVersion: '42',
    ownershipSha256: 'a'.repeat(64),
    contentSha256: MERI_CASE46.sha256,
    byteLength: 28,
  },
  currentVerifySha256: 'b'.repeat(64),
  qualificationSha256: 'c'.repeat(64),
  issuedAt: Date.now(),
  expiresAt: Date.now() + 600_000,
  allowedTool: 'create_word',
  approval: 'canonical_current_user_required',
  maximumProposals: 1,
  maximumArtifactEffects: 1,
  dynamicMcpAllowed: false,
  incidentalWriters: 'suppressed',
  expectedWrites: [
    'context_packet_and_evidence',
    'conversation_user_message',
    'conversation_assistant_message',
    'provider_budget_ledger',
    'canonical_action_proposal',
    'approved_text_artifact',
  ],
});
describe('separate case46 governed capability', () => {
  const secret = 'test-service-identity-only';
  test('purpose and actor bound MAC cannot become readonly authority', () => {
    const p = policy();
    const token = encodeMeriGovernedArtifactTransport(p, 'provider_budget', secret);
    expect(
      decodeMeriGovernedArtifactTransport(token, { ...p, purpose: 'provider_budget' }, secret),
    ).toEqual(p);
    for (const changed of [
      { ...p, purpose: 'tool' as const },
      { ...p, purpose: 'provider_budget' as const, actorUserId: randomUUID() },
      { ...p, purpose: 'provider_budget' as const, conversationId: randomUUID() },
    ])
      expect(() => decodeMeriGovernedArtifactTransport(token, changed, secret)).toThrow();
    expect(() =>
      decodeAndVerifyMeriCapturePolicyTransport(
        token,
        { purpose: 'provider_budget', tenantId: p.tenantId, actorUserId: p.actorUserId },
        secret,
      ),
    ).toThrow();
    expect(() =>
      decodeMeriGovernedArtifactTransport(token, { ...p, purpose: 'provider_budget' }, 'other'),
    ).toThrow();
  });
  test.each(['source', 'tool', 'expiry', 'scope', 'writes', 'unknown'])(
    'rejects unsigned %s expansion',
    (kind) => {
      const p = policy();
      const token = encodeMeriGovernedArtifactTransport(p, 'tool', secret);
      const data = JSON.parse(Buffer.from(token, 'base64url').toString());
      if (kind === 'source') data.policy.source.physicalId = randomUUID();
      if (kind === 'tool') data.policy.allowedTool = 'send_email';
      if (kind === 'expiry') data.policy.expiresAt += 1;
      if (kind === 'scope') data.policy.clientId = randomUUID();
      if (kind === 'writes') data.policy.expectedWrites.push('external_mail');
      if (kind === 'unknown') data.policy.approvalBypass = true;
      expect(() =>
        decodeMeriGovernedArtifactTransport(
          Buffer.from(JSON.stringify(data)).toString('base64url'),
          { ...p, purpose: 'tool' },
          secret,
        ),
      ).toThrow();
    },
  );
  test('rejects expired/future/overlong policy and malformed transport', () => {
    const p = policy();
    for (const altered of [
      { ...p, expiresAt: Date.now() - 1 },
      { ...p, issuedAt: Date.now() + 60_000 },
      { ...p, expiresAt: p.issuedAt + 900_001 },
    ])
      expect(() => validateMeriGovernedArtifactPolicy(altered, p)).toThrow();
    for (const token of [
      undefined,
      'a'.repeat(8193),
      '====',
      Buffer.from('{}').toString('base64url'),
    ])
      expect(() =>
        decodeMeriGovernedArtifactTransport(token, { ...p, purpose: 'tool' }, secret),
      ).toThrow();
  });
  test('exact text/tool/client/turn required without normalized alternate writes', () => {
    const p = policy();
    const input = {
      title: MERI_CASE46.title,
      format: 'txt',
      text: MERI_CASE46.text,
      conversationId: p.conversationId,
      clientId: p.clientId,
    };
    expect(() => assertMeriCase46ToolInput(p, 'create_word', input)).not.toThrow();
    expect(() =>
      assertMeriCase46ToolInput(p, 'create_word', { ...input, sections: [] }),
    ).not.toThrow();
    for (const changed of [
      { ...input, text: MERI_CASE46.text.trimEnd() },
      { ...input, format: 'docx' },
      { ...input, title: 'other' },
      { ...input, clientId: randomUUID() },
      { ...input, conversationId: randomUUID() },
      { ...input, recipient: 'unexpected' },
      { ...input, sections: [{ heading: 'changed' }] },
    ])
      expect(() => assertMeriCase46ToolInput(p, 'create_word', changed)).toThrow();
    expect(() => assertMeriCase46ToolInput({ ...p, turnId: null }, 'create_word', input)).toThrow();
    expect(() => assertMeriCase46ToolInput(p, 'send_email', input)).toThrow();
  });
});
