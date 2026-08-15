import { describe, expect, jest, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  PROBE_STATUSES,
  TangoCapabilityProbeService,
  createProbeClient,
  type ProbeStatus,
} from './tango-capability-probe.service.js';

const TEST_KEY = 'sk_live_NOTAREALKEY_0123456789abcdef';

/**
 * A hand-rolled double, unlike tango.client.spec.ts's real-SDK-via-fake-fetch
 * approach. That is deliberate here: `TangoCapabilityProbeService.run()`'s own
 * logic (ceiling enforcement, auth short-circuit, skippedReason branching,
 * redaction) is independent of the SDK entirely — it only ever calls methods
 * on the narrow `ProbeClient` shape. `createProbeClient` — the one function
 * that DOES touch the real SDK — gets its own real-SDK-via-fake-fetch test
 * below, mirroring tango.client.spec.ts exactly.
 */
function fakeClient(overrides: Partial<Record<string, jest.Mock>> = {}) {
  const ok = (value: unknown = {}) => jest.fn(async () => value);
  const client = {
    rateLimitInfo: null as unknown,
    getVersion: ok({ version: '1.0.0' }),
    getEntity: ok({}),
    listOpportunities: ok({}),
    listNotices: ok({}),
    searchOpportunityAttachments: ok({}),
    listForecasts: ok({}),
    listVehicles: ok({}),
    listVehicleAwardees: ok({}),
    listVehicleOrders: ok({}),
    listContracts: ok({}),
    listIdvs: ok({}),
    listOtas: ok({}),
    listOtidvs: ok({}),
    listProtests: ok({}),
    listBudgetAccounts: ok({}),
    getEntityBudgetFlows: ok({}),
    listWebhookEventTypes: ok({}),
    listWebhookEndpoints: ok({}),
    listApiKeys: ok({}),
    ...overrides,
  };
  return client as unknown as Parameters<TangoCapabilityProbeService['run']>[0] & typeof client;
}

const ALL_KEYS = [
  'version',
  'entities',
  'opportunities',
  'notice_history',
  'attachment_metadata',
  'extracted_text',
  'forecasts',
  'vehicles',
  'vehicle_awardees',
  'vehicle_orders',
  'contracts',
  'idvs',
  'otas',
  'otidvs',
  'protests',
  'exclusions',
  'dibbs',
  'sbir_sttr',
  'budget_accounts_flows',
  'budget_flows_by_entity',
  'webhook_event_types',
  'webhook_endpoints_list',
  'webhook_write_apis',
  'api_keys_list',
  'mcp_key_header_compatibility',
];

function byKey(report: Awaited<ReturnType<TangoCapabilityProbeService['run']>>, key: string) {
  const found = report.probes.find((p) => p.key === key);
  if (!found) throw new Error(`no probe result for key "${key}"`);
  return found;
}

describe('the probe registry — structural invariants', () => {
  test('every probe key from the ALL_KEYS baseline is present, exactly once, with no extras', async () => {
    const service = new TangoCapabilityProbeService();
    const report = await service.run(fakeClient(), TEST_KEY, { requestCeiling: 100 });
    const keys = report.probes.map((p) => p.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys.sort()).toEqual([...ALL_KEYS].sort());
  });

  test('version runs first — the auth short-circuit depends on this order', async () => {
    const service = new TangoCapabilityProbeService();
    const report = await service.run(fakeClient(), TEST_KEY, { requestCeiling: 100 });
    expect(report.probes[0]!.key).toBe('version');
  });

  test('every reported status is one of the declared PROBE_STATUSES', async () => {
    const service = new TangoCapabilityProbeService();
    const report = await service.run(fakeClient(), TEST_KEY, { requestCeiling: 100 });
    for (const p of report.probes) {
      expect(PROBE_STATUSES).toContain(p.status);
    }
  });
});

describe('identifier-gated probes: entities / vehicle_awardees / vehicle_orders / budget_flows_by_entity', () => {
  test('with no uei/vehicleUuid, all four report not_attempted and never call the SDK', async () => {
    const client = fakeClient();
    const service = new TangoCapabilityProbeService();
    const report = await service.run(client, TEST_KEY, { requestCeiling: 100 });

    for (const key of ['entities', 'vehicle_awardees', 'vehicle_orders', 'budget_flows_by_entity']) {
      const result = byKey(report, key);
      expect(result.status).toBe('not_attempted');
      expect(result.reason).toMatch(/no real identifier was supplied/i);
    }
    expect(client.getEntity).not.toHaveBeenCalled();
    expect(client.listVehicleAwardees).not.toHaveBeenCalled();
    expect(client.listVehicleOrders).not.toHaveBeenCalled();
    expect(client.getEntityBudgetFlows).not.toHaveBeenCalled();
  });

  test('a real uei actually invokes getEntity and getEntityBudgetFlows, and reports supported', async () => {
    const client = fakeClient();
    const service = new TangoCapabilityProbeService();
    const report = await service.run(client, TEST_KEY, { uei: 'ZZTESTUEI001', requestCeiling: 100 });

    expect(client.getEntity).toHaveBeenCalledWith('ZZTESTUEI001');
    expect(client.getEntityBudgetFlows).toHaveBeenCalledWith('ZZTESTUEI001');
    expect(byKey(report, 'entities').status).toBe('supported');
    expect(byKey(report, 'budget_flows_by_entity').status).toBe('supported');
    // vehicle probes are independently gated — a uei alone must not satisfy them.
    expect(byKey(report, 'vehicle_awardees').status).toBe('not_attempted');
    expect(byKey(report, 'vehicle_orders').status).toBe('not_attempted');
  });

  test('a real vehicle uuid actually invokes listVehicleAwardees/listVehicleOrders', async () => {
    const client = fakeClient();
    const service = new TangoCapabilityProbeService();
    const uuid = '11111111-1111-1111-1111-111111111111';
    const report = await service.run(client, TEST_KEY, { vehicleUuid: uuid, requestCeiling: 100 });

    expect(client.listVehicleAwardees).toHaveBeenCalledWith(uuid, { limit: 1 });
    expect(client.listVehicleOrders).toHaveBeenCalledWith(uuid, { limit: 1 });
    expect(byKey(report, 'vehicle_awardees').status).toBe('supported');
    expect(byKey(report, 'vehicle_orders').status).toBe('supported');
    // uei-gated probes are independently gated — a vehicle uuid alone must not satisfy them.
    expect(byKey(report, 'entities').status).toBe('not_attempted');
    expect(byKey(report, 'budget_flows_by_entity').status).toBe('not_attempted');
  });
});

describe('genuinely unsupported probes (a fact about the SDK, not this run)', () => {
  test('exclusions / mcp_key_header_compatibility are ALWAYS unsupported', async () => {
    const client = fakeClient();
    const service = new TangoCapabilityProbeService();
    // Supply every identifier — proves these report unsupported regardless,
    // not because an identifier happened to be missing.
    const report = await service.run(client, TEST_KEY, {
      uei: 'ZZTESTUEI001',
      vehicleUuid: '11111111-1111-1111-1111-111111111111',
      requestCeiling: 100,
    });
    for (const key of ['exclusions', 'mcp_key_header_compatibility']) {
      expect(byKey(report, key).status).toBe('unsupported');
    }
  });

  /**
   * D-62. `dibbs` and `sbir_sttr` USED TO BE in the list above, asserted
   * `unsupported` — a status this file's own ProbeDef doc defines as "a fact
   * about the provider/SDK surface itself". That was wrong, and the test
   * cemented it: what had actually been verified was only that the SDK wraps
   * neither dataset. Both have published REST APIs.
   *
   * `unsupported` for these two is now a REGRESSION, not a baseline.
   */
  test('dibbs and sbir_sttr are never reported `unsupported` — that was the D-62 error', async () => {
    const client = fakeClient();
    const service = new TangoCapabilityProbeService();
    const report = await service.run(client, TEST_KEY, {
      uei: 'ZZTESTUEI001',
      vehicleUuid: '11111111-1111-1111-1111-111111111111',
      requestCeiling: 100,
    });

    for (const key of ['dibbs', 'sbir_sttr']) {
      const probe = byKey(report, key);
      expect(probe.status).not.toBe('unsupported');
      // No client was supplied, so this is a fact about the invocation.
      expect(probe.status).toBe('not_attempted');
      // And the reason must say the provider DOES document the endpoint,
      // rather than telling a reader to escalate to MakeGov.
      expect(probe.reason).toMatch(/provider DOES document/i);
      expect(probe.reason).not.toMatch(/escalate to MakeGov/i);
    }
  });

  test('a supplied DIBBS REST client makes the dibbs probe a REAL call', async () => {
    const client = fakeClient();
    const service = new TangoCapabilityProbeService();
    const listRfqs = jest.fn(async () => ({ items: [], totalCount: 0, nextPage: null, rate: null }));
    const report = await service.run(client, TEST_KEY, {
      requestCeiling: 100,
      dibbs: { configured: true, listRfqs, listRfps: jest.fn(), listAwards: jest.fn() } as any,
    });

    expect(listRfqs).toHaveBeenCalledTimes(1);
    // The smallest possible shaped call — same read-only policy as every other
    // probe in this file.
    expect(listRfqs).toHaveBeenCalledWith({ limit: 1 });
    expect(byKey(report, 'dibbs').status).toBe('supported');
  });

  /**
   * P42 part 1. The mirror of the DIBBS case above, and the reason the client
   * was built before any SBIR table: P42's plan gates the phase on "P17 must
   * show access", and P17 could only ever answer `no_rest_client_wired` — a
   * fact about Capiro's code (D-64), not an entitlement answer. A gate nothing
   * can satisfy is not a gate; supplying a client is what makes the question
   * answerable at all.
   */
  test('a supplied SBIR REST client makes the sbir_sttr probe a REAL call', async () => {
    const client = fakeClient();
    const service = new TangoCapabilityProbeService();
    const listTopics = jest.fn(async () => ({
      items: [],
      totalCount: 0,
      nextPage: null,
      rate: null,
    }));
    const report = await service.run(client, TEST_KEY, {
      requestCeiling: 100,
      sbir: { configured: true, listTopics, listSolicitations: jest.fn() } as any,
    });

    expect(listTopics).toHaveBeenCalledTimes(1);
    expect(listTopics).toHaveBeenCalledWith({ limit: 1 });
    expect(byKey(report, 'sbir_sttr').status).toBe('supported');
  });

  test('a supplied SBIR client does not make the probe claim anything about DIBBS', async () => {
    // The two REST surfaces are independent; wiring one must not change the
    // other's reported status, which is how a phantom "supported" would appear.
    const client = fakeClient();
    const service = new TangoCapabilityProbeService();
    const report = await service.run(client, TEST_KEY, {
      requestCeiling: 100,
      sbir: {
        configured: true,
        listTopics: jest.fn(async () => ({
          items: [],
          totalCount: 0,
          nextPage: null,
          rate: null,
        })),
        listSolicitations: jest.fn(),
      } as any,
    });

    expect(byKey(report, 'sbir_sttr').status).toBe('supported');
    const dibbs = byKey(report, 'dibbs');
    expect(dibbs.status).toBe('not_attempted');
    expect(dibbs.reason).toMatch(/no DIBBS REST client/i);
  });
});

describe('webhook_write_apis: deliberately excluded, not unsupported', () => {
  test('reports not_attempted (never unsupported) — the SDK demonstrably has these methods', async () => {
    const client = fakeClient();
    const service = new TangoCapabilityProbeService();
    const report = await service.run(client, TEST_KEY, {
      uei: 'ZZTESTUEI001',
      vehicleUuid: '11111111-1111-1111-1111-111111111111',
      requestCeiling: 100,
    });
    const result = byKey(report, 'webhook_write_apis');
    expect(result.status).toBe('not_attempted');
    expect(result.reason).toMatch(/mutating/i);
  });
});

describe('request ceiling', () => {
  test('stops issuing new calls once the ceiling is reached; remainder report not_attempted', async () => {
    const client = fakeClient();
    const service = new TangoCapabilityProbeService();
    const report = await service.run(client, TEST_KEY, { requestCeiling: 2 });

    expect(report.requestsIssued).toBe(2);
    expect(client.getVersion).toHaveBeenCalledTimes(1);
    expect(client.listOpportunities).toHaveBeenCalledTimes(1);
    expect(client.listNotices).not.toHaveBeenCalled();

    const ceilingStopped = byKey(report, 'notice_history');
    expect(ceilingStopped.status).toBe('not_attempted');
    expect(ceilingStopped.reason).toMatch(/ceiling/i);
  });

  test('a null-call probe (e.g. dibbs) does not itself count against the ceiling', async () => {
    // dibbs/sbir_sttr/exclusions have no `call` at all — they must not consume
    // budget that identifier-driven or unconditional real calls need.
    const client = fakeClient();
    const service = new TangoCapabilityProbeService();
    const report = await service.run(client, TEST_KEY, { requestCeiling: 100 });
    expect(report.requestsIssued).toBeLessThan(ALL_KEYS.length);
  });
});

describe('authentication short-circuit', () => {
  function authError() {
    const err = new Error('401 Unauthorized') as Error & { statusCode: number };
    err.statusCode = 401;
    return err;
  }

  test('an auth failure on version marks authenticationFailed and skips every remaining REAL call', async () => {
    const client = fakeClient({ getVersion: jest.fn(async () => { throw authError(); }) });
    const service = new TangoCapabilityProbeService();
    const report = await service.run(client, TEST_KEY, {
      uei: 'ZZTESTUEI001',
      vehicleUuid: '11111111-1111-1111-1111-111111111111',
      requestCeiling: 100,
    });

    expect(report.authenticationFailed).toBe(true);
    expect(client.listOpportunities).not.toHaveBeenCalled();
    expect(client.getEntity).not.toHaveBeenCalled();
    expect(byKey(report, 'opportunities').status).toBe('not_attempted');
    expect(byKey(report, 'opportunities').reason).toMatch(/authentication failure/i);
  });

  test('a null-call probe still reports its OWN status after an auth failure, not the auth reason', async () => {
    // A genuine SDK gap (exclusions — no dedicated endpoint, the fields live on
    // the Entity resource) is true regardless of whether this run's key
    // authenticates. Collapsing it into "skipped: auth failed" would erase a
    // real, independent finding.
    //
    // This test used to use `dibbs` as its example. It no longer can: dibbs is
    // not an SDK-gap probe any more (D-62), so it would be asserting the very
    // claim that correction removed.
    const client = fakeClient({ getVersion: jest.fn(async () => { throw authError(); }) });
    const service = new TangoCapabilityProbeService();
    const report = await service.run(client, TEST_KEY, { requestCeiling: 100 });

    const exclusions = byKey(report, 'exclusions');
    expect(exclusions.status).toBe('unsupported');
    expect(exclusions.reason).toMatch(/no dedicated exclusions endpoint/i);
    expect(exclusions.reason).not.toMatch(/authentication failure/i);

    // dibbs holds the same property for its own, different reason.
    const dibbs = byKey(report, 'dibbs');
    expect(dibbs.status).toBe('not_attempted');
    expect(dibbs.reason).toMatch(/provider DOES document/i);
    expect(dibbs.reason).not.toMatch(/authentication failure/i);
  });

  test('only ONE call is ever issued once auth fails (the version preflight itself)', async () => {
    const client = fakeClient({ getVersion: jest.fn(async () => { throw authError(); }) });
    const service = new TangoCapabilityProbeService();
    const report = await service.run(client, TEST_KEY, { requestCeiling: 100 });
    expect(report.requestsIssued).toBe(1);
  });

  test('a 401 on a LATER probe (not version) does not retroactively flip authenticationFailed', async () => {
    const client = fakeClient({
      listOpportunities: jest.fn(async () => { throw authError(); }),
    });
    const service = new TangoCapabilityProbeService();
    const report = await service.run(client, TEST_KEY, { requestCeiling: 100 });

    expect(report.authenticationFailed).toBe(false);
    expect(byKey(report, 'opportunities').status).toBe('error');
    // Everything after 'opportunities' still ran.
    expect(client.listNotices).toHaveBeenCalled();
  });
});

describe('errors are classified and redacted', () => {
  test('a tier-gated (403) error on a non-version probe reports tier_gated, and later probes still run', async () => {
    const err = new Error('403 Forbidden: this endpoint requires a higher plan tier') as Error & {
      statusCode: number;
    };
    err.statusCode = 403;
    const client = fakeClient({ listForecasts: jest.fn(async () => { throw err; }) });
    const service = new TangoCapabilityProbeService();
    const report = await service.run(client, TEST_KEY, { requestCeiling: 100 });

    expect(byKey(report, 'forecasts').status).toBe('tier_gated');
    expect(client.listVehicles).toHaveBeenCalled();
  });

  test('the raw API key never survives into a reason string', async () => {
    const err = new Error(`upstream said: X-API-KEY ${TEST_KEY} was rejected`);
    const client = fakeClient({ listOpportunities: jest.fn(async () => { throw err; }) });
    const service = new TangoCapabilityProbeService();
    const report = await service.run(client, TEST_KEY, { requestCeiling: 100 });

    const result = byKey(report, 'opportunities');
    expect(result.status).toBe('error');
    expect(result.reason).not.toContain(TEST_KEY);
  });

  test('a reason string is truncated to 300 characters', async () => {
    const err = new Error('x'.repeat(1000));
    const client = fakeClient({ listOpportunities: jest.fn(async () => { throw err; }) });
    const service = new TangoCapabilityProbeService();
    const report = await service.run(client, TEST_KEY, { requestCeiling: 100 });
    expect(byKey(report, 'opportunities').reason.length).toBeLessThanOrEqual(300);
  });

  test('a non-Error throw (e.g. a string) does not crash the run', async () => {
    const client = fakeClient({ listOpportunities: jest.fn(async () => { throw 'boom'; }) });
    const service = new TangoCapabilityProbeService();
    const report = await service.run(client, TEST_KEY, { requestCeiling: 100 });
    expect(byKey(report, 'opportunities').status).toBe('error');
    expect(byKey(report, 'opportunities').reason).toContain('boom');
  });
});

describe('a 404 is its own status, not folded into generic error', () => {
  // Live-run finding (2026-08-07, real Tango account): searchOpportunityAttachments
  // answered a synthetic single-character query with a classified 404, not 200 +
  // an empty page. Collapsing that into generic 'error' would make it
  // indistinguishable from a genuinely broken call — see the ProbeResult.status doc.
  function notFoundError() {
    const err = new Error('Resource not found') as Error & { statusCode: number };
    err.statusCode = 404;
    return err;
  }

  test('a 404 on a non-version probe reports not_found, and later probes still run', async () => {
    const client = fakeClient({
      searchOpportunityAttachments: jest.fn(async () => { throw notFoundError(); }),
    });
    const service = new TangoCapabilityProbeService();
    const report = await service.run(client, TEST_KEY, { requestCeiling: 100 });

    expect(byKey(report, 'attachment_metadata').status).toBe('not_found');
    expect(byKey(report, 'attachment_metadata').reason).toMatch(/resource not found/i);
    expect(client.listForecasts).toHaveBeenCalled();
  });

  test('not_found does not set authenticationFailed and is not a tier_gated finding', async () => {
    const client = fakeClient({
      searchOpportunityAttachments: jest.fn(async () => { throw notFoundError(); }),
    });
    const service = new TangoCapabilityProbeService();
    const report = await service.run(client, TEST_KEY, { requestCeiling: 100 });
    expect(report.authenticationFailed).toBe(false);
    expect(byKey(report, 'attachment_metadata').status).not.toBe('tier_gated');
  });
});

describe('success path', () => {
  test('rate metadata is carried from the client onto a successful result', async () => {
    const rate = { remaining: 99, limit: 100, resetIn: 60, retryAfter: null, limitType: 'standard' };
    const client = fakeClient();
    client.rateLimitInfo = rate;
    const service = new TangoCapabilityProbeService();
    const report = await service.run(client, TEST_KEY, { requestCeiling: 100 });
    expect(byKey(report, 'version').rate).toEqual(rate);
  });

  test('durationMs is a non-negative number and generatedAt is a valid ISO timestamp', async () => {
    const service = new TangoCapabilityProbeService();
    const report = await service.run(fakeClient(), TEST_KEY, { requestCeiling: 100 });
    expect(byKey(report, 'version').durationMs).toBeGreaterThanOrEqual(0);
    expect(new Date(report.generatedAt).toISOString()).toBe(report.generatedAt);
  });

  test('requestCeiling on the report echoes the option passed in', async () => {
    const service = new TangoCapabilityProbeService();
    const report = await service.run(fakeClient(), TEST_KEY, { requestCeiling: 7 });
    expect(report.requestCeiling).toBe(7);
  });
});

describe('createProbeClient — the real SDK, driven through a fake transport', () => {
  // Same reasoning as tango.client.spec.ts: NO NETWORK. Drives the real SDK
  // through a fake fetchImpl so the dynamic import, URL building, and header
  // handling all execute exactly as they would in production.
  const FIXTURES = join(__dirname, '__fixtures__');
  const ENTITY_PAGE = JSON.parse(readFileSync(join(FIXTURES, 'entity-page.json'), 'utf8'));

  function fakeFetch(responses: Array<{ status?: number; body?: unknown }>) {
    let i = 0;
    const calls: string[] = [];
    const impl = (async (input: unknown) => {
      calls.push(typeof input === 'string' ? input : String(input));
      const next = responses[Math.min(i, responses.length - 1)]!;
      i += 1;
      return new Response(JSON.stringify(next.body ?? {}), {
        status: next.status ?? 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;
    return { impl, calls };
  }

  test('constructs a working client whose getVersion resolves through the real SDK', async () => {
    const { impl, calls } = fakeFetch([{ body: { version: '1.2.3' } }]);
    const client = await createProbeClient({ apiKey: TEST_KEY, baseUrl: 'https://tango.example.test', fetchImpl: impl });
    const result = await client.getVersion();
    expect(result).toEqual({ version: '1.2.3' });
    expect(calls[0]).toContain('/api/version/');
  });

  test('getEntity resolves a real fixture through the real SDK, given the fake transport', async () => {
    const { impl } = fakeFetch([{ body: ENTITY_PAGE.results[0] }]);
    const client = await createProbeClient({ apiKey: TEST_KEY, baseUrl: 'https://tango.example.test', fetchImpl: impl });
    await expect(client.getEntity('ZZTESTUEI001')).resolves.toBeTruthy();
  });

  test('rateLimitInfo starts null and is populated after a real call carries rate headers', async () => {
    let i = 0;
    const impl = (async () => {
      i += 1;
      return new Response(JSON.stringify({}), {
        status: 200,
        headers: {
          'content-type': 'application/json',
          'x-ratelimit-remaining': '42',
          'x-ratelimit-limit': '100',
        },
      });
    }) as unknown as typeof fetch;
    const client = await createProbeClient({ apiKey: TEST_KEY, baseUrl: 'https://tango.example.test', fetchImpl: impl });
    expect(client.rateLimitInfo).toBeNull();
    await client.getVersion();
    expect(client.rateLimitInfo).toEqual(
      expect.objectContaining({ remaining: 42, limit: 100 }),
    );
    expect(i).toBe(1);
  });

  test('the raw SDK client, run through the actual probe service end to end, never leaks the key', async () => {
    const { impl } = fakeFetch([
      { status: 401, body: { detail: `Invalid credential X-API-KEY ${TEST_KEY}` } },
    ]);
    const client = await createProbeClient({ apiKey: TEST_KEY, baseUrl: 'https://tango.example.test', fetchImpl: impl });
    const service = new TangoCapabilityProbeService();
    const report = await service.run(client, TEST_KEY, { requestCeiling: 100 });
    const json = JSON.stringify(report);
    expect(json).not.toContain(TEST_KEY);
    expect(report.authenticationFailed).toBe(true);
  });
});
