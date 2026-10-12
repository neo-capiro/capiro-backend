import {
  meriCase12SetupBindingsEqual,
  readMeriCase12SetupBinding,
  validateMeriCase12SetupPolicyBinding,
} from './case12-setup-binding';
import {
  decodeAndVerifyMeriCapturePolicyTransport,
  encodeMeriCapturePolicyTransport,
  type MeriServerReadonlyCapturePolicy,
} from './server-readonly-capture';

const setup = () => ({
  setupRunId: '11111111-1111-4111-8111-111111111111',
  fixtureInstanceId: '22222222-2222-4222-8222-222222222222',
  setupPlanSha256: 'a'.repeat(64),
  setupClaimSha256: 'b'.repeat(64),
  setupLedgerSha256: 'c'.repeat(64),
});
const binding = () => ({
  caseId: '12',
  captureRunId: '33333333-3333-4333-8333-333333333333',
  resetReceiptId: null,
  seedReceiptId: null,
  case12Setup: setup(),
});

describe('separate completed Case12 setup provenance', () => {
  it('copies exact fields and compares independently of object insertion order', () => {
    const input = setup(),
      parsed = readMeriCase12SetupBinding(input);
    input.setupClaimSha256 = 'd'.repeat(64);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(parsed.setupClaimSha256).toBe('b'.repeat(64));
    expect(
      meriCase12SetupBindingsEqual(parsed, Object.fromEntries(Object.entries(parsed).reverse())),
    ).toBe(true);
    expect(meriCase12SetupBindingsEqual(parsed, input)).toBe(false);
    expect(() => validateMeriCase12SetupPolicyBinding(binding())).not.toThrow();
  });
  it.each([
    null,
    [],
    'true',
    { ...setup(), ready: true },
    { ...setup(), setupRunId: [setup().setupRunId] },
    { ...setup(), setupLedgerSha256: { toString: () => 'c'.repeat(64) } },
    { ...setup(), setupClaimSha256: 'A'.repeat(64) },
    { ...setup(), fixtureInstanceId: setup().fixtureInstanceId.replace('-4222-', '-5222-') },
    { ...setup(), setupPlanSha256: undefined },
  ])('rejects malformed or coercible provenance %#', (value) => {
    expect(() => readMeriCase12SetupBinding(value)).toThrow();
  });
  it.each([
    { ...binding(), case12Setup: undefined },
    { ...binding(), caseId: '14' },
    { ...binding(), captureRunId: setup().setupRunId },
    { ...binding(), captureRunId: null },
    { ...binding(), resetReceiptId: 'invented-reset' },
    { ...binding(), seedReceiptId: 'invented-seed' },
    { ...binding(), syntheticReadBudget: {} },
  ])('rejects missing, borrowed, repeated, or mixed authority %#', (value) => {
    expect(() => validateMeriCase12SetupPolicyBinding(value)).toThrow();
  });
  it('leaves existing cases unchanged when setup provenance is absent', () => {
    expect(() =>
      validateMeriCase12SetupPolicyBinding({
        caseId: '14',
        captureRunId: 'old-run',
        resetReceiptId: 'actual-reset',
        seedReceiptId: 'actual-seed',
      }),
    ).not.toThrow();
  });
  it('authenticates the separate setup binding and rejects a signed invalid Case12 binding', () => {
    const now = 1800000000000,
      secret = 'local-shape-test-secret';
    const policy: MeriServerReadonlyCapturePolicy = {
      ...binding(),
      version: 1,
      kind: 'server_readonly_acceptance_capture',
      policyId: '44444444-4444-4444-8444-444444444444',
      requestId: '55555555-5555-4555-8555-555555555555',
      traceId: '66666666-6666-4666-8666-666666666666',
      turnId: null,
      fixtureVersion: 'meri-live-v1-2026-09-26.1',
      physicalMapSha256: 'd'.repeat(64),
      fixtureNamespace: 'meri-foundation-20260928',
      tenantId: 'tenant',
      tenantSlug: 'meri-foundation-20260928-t1',
      actorUserId: 'actor',
      conversationId: 'conversation',
      clientId: 'client',
      issuedAt: now,
      expiresAt: now + 10000,
      toolAuthority: 'shared_static_registry_read_only',
      toolCatalogSha256: 'e'.repeat(64),
      dynamicMcpAllowed: false,
      incidentalWriters: 'suppressed',
      expectedCaptureWrites: [
        'context_packet_and_evidence',
        'conversation_user_message',
        'conversation_assistant_message',
      ],
    };
    const decode = (value: MeriServerReadonlyCapturePolicy) =>
      decodeAndVerifyMeriCapturePolicyTransport(
        encodeMeriCapturePolicyTransport(value, 'tool', 'search_memory', secret),
        { purpose: 'tool', toolName: 'search_memory', tenantId: 'tenant', actorUserId: 'actor' },
        secret,
        now,
      );
    expect(decode(policy).case12Setup).toEqual(setup());
    expect(() => decode({ ...policy, seedReceiptId: 'invented' })).toThrow();
    expect(() => decode({ ...policy, case12Setup: undefined })).toThrow();
  });
});
