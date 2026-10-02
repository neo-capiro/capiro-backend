import {
  decodeMeriGovernedArtifactTransport,
  MERI_GOVERNED_ARTIFACT_HEADER,
  MERI_CAPTURE_POLICY_HEADER,
} from '@capiro/meriv2-core';
import { governedArtifactProviderAccounting } from './meriv3-governed-artifact-budget.js';
import { MeriRunBudget } from './meriv3-run-budget.js';
import { governedArtifactTestPolicy } from './meriv3-governed-artifact.spec-helper.js';

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
function args() {
  return {
    policy: governedArtifactTestPolicy(),
    apiBaseUrl: 'https://owned-api.invalid',
    serviceSecret: 'unit-only-secret',
    bearerToken: 'unit-only-bearer',
  };
}
test('governed export has separate turn-bound purpose and settles the actual provider attempt', async () => {
  const a = args();
  const wire: Array<{ url: string; init: RequestInit }> = [];
  const accounting = governedArtifactProviderAccounting({
    ...a,
    fetchImpl: (async (url, init) => {
      wire.push({ url: String(url), init: init! });
      return new Response(
        JSON.stringify(
          String(url).endsWith('reservations')
            ? {
                reservationId: 'reserved',
                dispatchAllowed: true,
                deadlineAt: new Date(a.policy.expiresAt).toISOString(),
              }
            : { settled: true },
        ),
        { status: 200 },
      );
    }) as typeof fetch,
  })!;
  const budget = MeriRunBudget.fromToolRoundCeiling(10, {}, accounting);
  const reserved = await budget.reserveProviderAttempt(binding);
  await budget.settleProviderAttempt(reserved, {
    kind: 'known',
    inputTokens: 10,
    outputTokens: 20,
  });
  expect(wire).toHaveLength(2);
  expect(wire[0]!.init.redirect).toBe('error');
  expect(JSON.parse(String(wire[0]!.init.body))).toEqual(binding);
  expect(JSON.parse(String(wire[1]!.init.body))).toMatchObject({
    binding: { attemptId: 'attempt', model: binding.model },
    outcome: { kind: 'known', inputTokens: 10, outputTokens: 20 },
  });
  const h = new Headers(wire[0]!.init.headers);
  expect(h.has(MERI_CAPTURE_POLICY_HEADER)).toBe(false);
  const token = h.get(MERI_GOVERNED_ARTIFACT_HEADER)!;
  expect(
    decodeMeriGovernedArtifactTransport(
      token,
      {
        purpose: 'provider_budget',
        tenantId: a.policy.tenantId,
        actorUserId: a.policy.actorUserId,
      },
      a.serviceSecret,
    ).turnId,
  ).toBe(a.policy.turnId);
  expect(() =>
    decodeMeriGovernedArtifactTransport(
      token,
      {
        purpose: 'action_proposal',
        tenantId: a.policy.tenantId,
        actorUserId: a.policy.actorUserId,
      },
      a.serviceSecret,
    ),
  ).toThrow();
});
test('missing identity, mixed authority and altered caller headers fail before dispatch; ordinary accounting is absent', () => {
  const a = args();
  expect(governedArtifactProviderAccounting({ ...a, policy: null })).toBeUndefined();
  const patches: Array<Partial<Parameters<typeof governedArtifactProviderAccounting>[0]>> = [
    { bearerToken: undefined },
    { serviceSecret: undefined },
    { impersonateTenantId: 'other' },
    { policy: { ...a.policy, turnId: null } },
    { headers: { [MERI_CAPTURE_POLICY_HEADER]: 'forged' } },
    { headers: { Authorization: 'forged' } },
  ];
  for (const patch of patches)
    expect(() => governedArtifactProviderAccounting({ ...a, ...patch })).toThrow();
});
test('denied, replayed and invalid deadline reservations never invoke the provider', async () => {
  const a = args();
  for (const payload of [
    null,
    {
      reservationId: 'old',
      dispatchAllowed: false,
      deadlineAt: new Date(a.policy.expiresAt).toISOString(),
    },
    {
      reservationId: 'id',
      dispatchAllowed: true,
      deadlineAt: new Date(a.policy.expiresAt + 1).toISOString(),
    },
  ]) {
    const accounting = governedArtifactProviderAccounting({
      ...a,
      fetchImpl: (async () =>
        new Response(JSON.stringify(payload ?? {}), {
          status: payload ? 200 : 403,
        })) as typeof fetch,
    })!;
    const provider = jest.fn();
    const budget = MeriRunBudget.fromToolRoundCeiling(10, {}, accounting);
    await expect(
      budget.budgetedFetch('selection', provider)('https://provider.invalid/v1/responses', {
        method: 'POST',
        body: JSON.stringify({ model: binding.model, max_output_tokens: 100 }),
      }),
    ).rejects.toThrow();
    expect(provider).not.toHaveBeenCalled();
  }
});
test('settlement uncertainty is surfaced instead of converted to successful accounting', async () => {
  const a = args();
  const accounting = governedArtifactProviderAccounting({
    ...a,
    fetchImpl: (async () => new Response('{}', { status: 503 })) as typeof fetch,
  })!;
  await expect(
    accounting.settle(
      { ...binding, reservationId: 'id', deadlineAt: new Date(a.policy.expiresAt).toISOString() },
      { kind: 'uncertain' },
    ),
  ).rejects.toThrow('http_503');
});
