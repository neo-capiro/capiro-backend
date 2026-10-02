import {
  decodeAndVerifyMeriCapturePolicyTransport,
  MERI_CAPTURE_POLICY_HEADER,
  type MeriServerReadonlyCapturePolicy,
} from '@capiro/meriv2-core';
import { captureProviderAccounting } from './meriv3-capture-provider-budget.js';
import { MeriRunBudget } from './meriv3-run-budget.js';
const policy = {
  version: 1,
  kind: 'server_readonly_acceptance_capture',
  policyId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  requestId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  traceId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  tenantId: 'tenant',
  actorUserId: 'actor',
  tenantSlug: 'meri-foundation-20260928-t1',
  conversationId: 'conversation',
  turnId: 'actual-turn',
  clientId: 'client',
  caseId: '01',
  captureRunId: 'run',
  fixtureVersion: 'v1',
  physicalMapSha256: 'a'.repeat(64),
  seedReceiptId: 'seed',
  resetReceiptId: 'reset',
  fixtureNamespace: 'meri-foundation-20260928',
  issuedAt: Date.now(),
  expiresAt: Date.now() + 60000,
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
} as MeriServerReadonlyCapturePolicy;
const binding = {
  logicalOperationId: 'op',
  attemptId: 'attempt',
  retryOfAttemptId: null,
  kind: 'openai_responses' as const,
  phase: 'synthesis' as const,
  provider: 'openai',
  model: 'actual-selected-model',
  maxInputTokens: 100,
  maxOutputTokens: 500,
};
const args = {
  policy,
  apiBaseUrl: 'https://owned-api.invalid',
  serviceSecret: 'unit-only-secret',
  bearerToken: 'unit-only-bearer',
};
test('budget-only accounting is signed separately from null fixture fields and rejects source authority injection', async () => {
  const readPolicy: MeriServerReadonlyCapturePolicy = {
    ...policy,
    caseId: null,
    captureRunId: null,
    fixtureVersion: null,
    physicalMapSha256: null,
    seedReceiptId: null,
    resetReceiptId: null,
    syntheticReadBudget: {
      version: 1,
      kind: 'synthetic_read_budget_only',
      caseId: '02',
      captureRunId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      aggregateReservationId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      qualificationSha256: 'a'.repeat(64),
    },
  };
  let header = '';
  const accounting = captureProviderAccounting({
    ...args,
    policy: readPolicy,
    fetchImpl: (async (_url, init) => {
      header = new Headers(init?.headers).get(MERI_CAPTURE_POLICY_HEADER)!;
      return new Response(
        JSON.stringify({
          reservationId: 'real-owner-reservation',
          dispatchAllowed: true,
          deadlineAt: new Date(policy.expiresAt).toISOString(),
        }),
      );
    }) as typeof fetch,
  })!;
  await accounting.reserve(binding);
  const observed = decodeAndVerifyMeriCapturePolicyTransport(
    header,
    { purpose: 'provider_budget', tenantId: 'tenant', actorUserId: 'actor' },
    args.serviceSecret,
  );
  expect(observed.syntheticReadBudget?.caseId).toBe('02');
  expect(observed.caseId).toBeNull();
  expect(observed.fixtureVersion).toBeNull();
  expect(() =>
    captureProviderAccounting({ ...args, policy: { ...readPolicy, caseId: '02' } }),
  ).toThrow('guard_invalid');
  expect(() =>
    decodeAndVerifyMeriCapturePolicyTransport(
      header,
      { purpose: 'tool', tenantId: 'tenant', actorUserId: 'actor' },
      args.serviceSecret,
    ),
  ).toThrow();
  expect(() =>
    decodeAndVerifyMeriCapturePolicyTransport(
      header,
      { purpose: 'provider_budget', tenantId: 'tenant', actorUserId: 'another' },
      args.serviceSecret,
    ),
  ).toThrow();
});
test('ordinary and unarmed diagnostic turns retain existing accounting selection', () => {
  expect(captureProviderAccounting({ ...args, policy: null })).toBeUndefined();
  expect(
    captureProviderAccounting({
      ...args,
      policy: {
        ...policy,
        expectedCaptureWrites: [
          'context_packet_and_evidence',
          'conversation_user_message',
          'conversation_assistant_message',
        ],
      },
    }),
  ).toBeUndefined();
  expect(() => captureProviderAccounting({ ...args, bearerToken: undefined })).toThrow(
    'identity_missing',
  );
});
test('same signed actual turn carries reserve and settle for the real provider/model without research identity', async () => {
  const wire: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
    wire.push({ url: String(url), init: init! });
    return new Response(
      JSON.stringify(
        String(url).endsWith('reservations')
          ? {
              reservationId: 'reserved',
              dispatchAllowed: true,
              deadlineAt: new Date(policy.expiresAt).toISOString(),
            }
          : { settled: true },
      ),
      { status: 200 },
    );
  }) as typeof fetch;
  const accounting = captureProviderAccounting({ ...args, fetchImpl })!;
  const budget = MeriRunBudget.fromToolRoundCeiling(10, {}, accounting);
  const reservation = await budget.reserveProviderAttempt(binding);
  await budget.settleProviderAttempt(reservation, {
    kind: 'known',
    inputTokens: 10,
    outputTokens: 20,
  });
  expect(wire.map((r) => r.url)).toEqual([
    'https://owned-api.invalid/api/clio/capture-provider-budget/reservations',
    'https://owned-api.invalid/api/clio/capture-provider-budget/settlements',
  ]);
  expect(JSON.parse(String(wire[0]!.init.body))).toEqual(binding);
  expect(JSON.parse(String(wire[1]!.init.body))).toMatchObject({
    reservationId: 'reserved',
    binding: { model: binding.model, attemptId: binding.attemptId },
    outcome: { kind: 'known', inputTokens: 10, outputTokens: 20 },
  });
  const header = new Headers(wire[0]!.init.headers).get(MERI_CAPTURE_POLICY_HEADER)!;
  expect(
    decodeAndVerifyMeriCapturePolicyTransport(
      header,
      { purpose: 'provider_budget', tenantId: 'tenant', actorUserId: 'actor' },
      args.serviceSecret,
    ).turnId,
  ).toBe('actual-turn');
  expect(() =>
    decodeAndVerifyMeriCapturePolicyTransport(
      header,
      { purpose: 'tool', tenantId: 'tenant', actorUserId: 'actor' },
      args.serviceSecret,
    ),
  ).toThrow();
});
test('denied or replayed reservation prevents the underlying provider wire call', async () => {
  for (const response of [
    new Response('{}', { status: 403 }),
    new Response(
      JSON.stringify({
        reservationId: 'old',
        dispatchAllowed: false,
        deadlineAt: new Date(policy.expiresAt).toISOString(),
      }),
      { status: 200 },
    ),
  ]) {
    const accounting = captureProviderAccounting({
      ...args,
      fetchImpl: (async () => response) as typeof fetch,
    })!;
    const budget = MeriRunBudget.fromToolRoundCeiling(10, {}, accounting);
    const provider = jest.fn();
    await expect(
      budget.budgetedFetch('selection', provider)('https://provider.invalid/v1/responses', {
        method: 'POST',
        body: JSON.stringify({ model: 'actual-selected-model', max_output_tokens: 100 }),
      }),
    ).rejects.toThrow();
    expect(provider).not.toHaveBeenCalled();
  }
});
test('owner cannot extend policy deadline or hide settlement failure', async () => {
  const late = captureProviderAccounting({
    ...args,
    fetchImpl: (async () =>
      new Response(
        JSON.stringify({
          reservationId: 'id',
          dispatchAllowed: true,
          deadlineAt: new Date(policy.expiresAt + 1).toISOString(),
        }),
        { status: 200 },
      )) as typeof fetch,
  })!;
  await expect(late.reserve(binding)).rejects.toThrow('reservation_invalid');
  const failed = captureProviderAccounting({
    ...args,
    fetchImpl: (async () => new Response('{}', { status: 503 })) as typeof fetch,
  })!;
  await expect(
    failed.settle(
      { ...binding, reservationId: 'id', deadlineAt: new Date(policy.expiresAt).toISOString() },
      { kind: 'uncertain' },
    ),
  ).rejects.toThrow('http_503');
});
