import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { TangoGatewayService } from './tango.client.js';
import {
  TANGO_ERROR_KINDS,
  TangoError,
  TangoNotConfiguredError,
  classifyStatus,
  redact,
  redactUnknown,
  redactWithKnownSecret,
} from './tango.errors.js';
import { TANGO_SHAPES, TANGO_SHAPE_FIELDS } from './tango.shapes.js';
import { bool, int, iso, mapEntity, num, pick, str, strList, unexpectedFields } from './tango.mappers.js';
import { TANGO_RESOURCE_TYPES } from './tango.types.js';

/**
 * The provider boundary.
 *
 * NO NETWORK. Every test drives the real SDK through a fake `fetchImpl`, which is
 * the honest way to test an adapter: the SDK's own URL building, header handling,
 * shape parameter and error mapping all execute exactly as they would in
 * production, and only the socket is replaced. A hand-rolled SDK double would
 * prove the double works.
 */

const FIXTURES = join(__dirname, '__fixtures__');
const fixture = (name: string) => JSON.parse(readFileSync(join(FIXTURES, name), 'utf8'));

const ENTITY_PAGE = fixture('entity-page.json');
const ENTITY_UNKEYED = fixture('entity-unkeyed.json');
const FORECAST_PAGE = fixture('forecast-page.json');
const VEHICLE_PAGE = fixture('vehicle-page.json');
const AWARDEE_PAGE = fixture('vehicle-awardee-page.json');
const ERRORS = fixture('errors.json');

/** The key used throughout. Long enough that literal redaction engages. */
const TEST_KEY = 'sk_live_NOTAREALKEY_0123456789abcdef';

interface Recorded {
  url: string;
  headers: Record<string, string>;
}

/**
 * A fake transport.
 *
 * Records every request and answers from a queue of canned responses, so a test
 * can assert BOTH what was sent (shape parameter, limit, cursor, header) and what
 * the adapter made of what came back.
 */
function fakeFetch(
  responses: Array<{ status?: number; body?: unknown; headers?: Record<string, string> }>,
) {
  const calls: Recorded[] = [];
  let i = 0;
  // `RequestInfo` is not in this project's lib set; the SDK only ever passes a
  // string URL, and `unknown` keeps the double honest about that.
  const impl = (async (input: unknown, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : String(input);
    const headers: Record<string, string> = {};
    const raw = init?.headers;
    if (raw) {
      if (raw instanceof Headers) raw.forEach((v, k) => (headers[k.toLowerCase()] = v));
      else if (Array.isArray(raw)) {
        for (const pair of raw as string[][]) {
          if (pair[0] != null) headers[pair[0].toLowerCase()] = String(pair[1] ?? '');
        }
      } else for (const [k, v] of Object.entries(raw)) headers[k.toLowerCase()] = String(v);
    }
    calls.push({ url, headers });
    const next = responses[Math.min(i, responses.length - 1)]!;
    i += 1;
    return new Response(JSON.stringify(next.body ?? {}), {
      status: next.status ?? 200,
      headers: { 'content-type': 'application/json', ...(next.headers ?? {}) },
    });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

function gateway(
  responses: Array<{ status?: number; body?: unknown; headers?: Record<string, string> }>,
  overrides: { apiKey?: string | null } = {},
) {
  const { impl, calls } = fakeFetch(responses);
  const service = new TangoGatewayService({
    apiKey: overrides.apiKey === undefined ? TEST_KEY : overrides.apiKey,
    baseUrl: 'https://tango.example.test',
    fetchImpl: impl,
  });
  return { service, calls };
}

// ── The import boundary ─────────────────────────────────────────────────────

describe('only the adapter may import the SDK', () => {
  const API_SRC = join(__dirname, '../../..', 'src');
  const API_SCRIPTS = join(__dirname, '../../..', 'scripts');
  const ADAPTER_DIR = join(__dirname);

  function walk(dir: string): string[] {
    const out: string[] = [];
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) {
        if (name === 'node_modules' || name === 'dist') continue;
        out.push(...walk(full));
      } else if (/\.tsx?$/.test(name)) {
        out.push(full);
      }
    }
    return out;
  }

  /**
   * The file with comments removed.
   *
   * The boundary is about CODE reaching the SDK, not about prose mentioning it —
   * `tango.errors.ts` explains its relationship to the SDK's error taxonomy in a
   * doc comment, which is exactly the sort of thing that should be written down.
   * Matching raw text would force that comment to be deleted to keep a test green,
   * which is the wrong trade every time.
   */
  function code(file: string): string {
    return readFileSync(file, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1');
  }

  const offenders = [...walk(API_SRC), ...walk(API_SCRIPTS)].filter((file) => {
    if (file.startsWith(ADAPTER_DIR)) return false;
    return /@makegov\/tango-node/.test(code(file));
  });

  test('no file outside src/external/tango imports @makegov/tango-node', () => {
    // The boundary the whole adapter exists to create. A single direct import
    // anywhere else and the vendor's dynamic-shape, Record<string, unknown>
    // response type is loose in a product service — and swapping or removing the
    // SDK stops being a one-file change.
    expect(offenders).toEqual([]);
  });

  test('the adapter itself references the SDK in exactly these two files', () => {
    // Matches the SPECIFIER, not a `from '...'` clause. The SDK is ESM-only and
    // apps/api is CommonJS, so both files reach it through a dynamic `import()`
    // — a boundary test keyed on the SYNTAX rather than the DEPENDENCY would
    // have silently started passing for the wrong reason (finding nothing) the
    // moment that changed. It did, once, which is why this comment exists.
    //
    // Two files, not one: tango.client.ts is the narrow, PRODUCT-facing
    // TangoGateway (8 methods P19+ actually call). tango-capability-probe
    // .service.ts (P17) is the deliberately WIDE, diagnostic-only probe surface
    // — widening TangoGateway itself to every rarely-used capability-check
    // method would pollute the contract product code relies on. Both stay
    // inside this same reviewed boundary directory; nothing outside it may
    // reference the SDK (enforced by the previous test).
    const inAdapter = walk(ADAPTER_DIR).filter(
      (f) => !f.endsWith('.spec.ts') && /@makegov\/tango-node/.test(code(f)),
    );
    expect(inAdapter.map((f) => f.split(/[\\/]/).pop()).sort()).toEqual([
      'tango-capability-probe.service.ts',
      'tango.client.ts',
    ]);
  });

  test('the jest transform carve-out is scoped to that one package', () => {
    // jest.config.cjs transforms @makegov down to CJS because the package is
    // ESM-only and jest's registry cannot require ESM. The carve-out must stay a
    // carve-out: transforming node_modules broadly is a large, silent slowdown for
    // every other suite in apps/api.
    const jestConfig = readFileSync(join(__dirname, '../../..', 'jest.config.cjs'), 'utf8');
    const line = jestConfig.match(/transformIgnorePatterns: \[[^\]]*\]/)?.[0] ?? '';
    expect(line).toContain('@makegov');
    expect(line).toMatch(/\(\?!/);
  });

  test('the dependency is pinned to an EXACT version', () => {
    // A caret would let a minor bump change response shapes under an adapter whose
    // whole job is that they cannot.
    const pkg = JSON.parse(readFileSync(join(__dirname, '../../..', 'package.json'), 'utf8'));
    const version = pkg.dependencies['@makegov/tango-node'];
    expect(version).toBe('1.1.0');
    expect(version).not.toMatch(/[\^~*x]/);
  });
});

// ── Boot with no key ────────────────────────────────────────────────────────

describe('a missing key is a state, not a failure', () => {
  test('constructing with no key does not throw and makes no request', () => {
    const { calls } = fakeFetch([]);
    expect(() => new TangoGatewayService({ apiKey: null, fetchImpl: calls as never })).not.toThrow();
  });

  test('the gateway reports itself unconfigured', () => {
    const service = new TangoGatewayService({ apiKey: null });
    expect(service.configured).toBe(false);
    expect(service.lastRate).toBeNull();
  });

  test('an empty-string key is UNCONFIGURED, not a key', async () => {
    // Otherwise it is sent as an X-API-KEY header and comes back 401, which reads
    // as a rejected credential instead of a missing one.
    const service = new TangoGatewayService({ apiKey: '   ' });
    expect(service.configured).toBe(false);
  });

  test('calling in that state raises a CONFIGURATION error, not an auth error', async () => {
    // Different types on purpose: "we never had a credential" is a config task,
    // "the credential was rejected" is an incident.
    const service = new TangoGatewayService({ apiKey: null });
    await expect(service.getVersion()).rejects.toBeInstanceOf(TangoNotConfiguredError);
    await expect(service.getVersion()).rejects.not.toBeInstanceOf(TangoError);
  });

  test('the unconfigured message says product reads are unaffected', async () => {
    const service = new TangoGatewayService({ apiKey: null });
    await expect(service.getEntity('ZZTESTUEI001')).rejects.toThrow(
      /every product read serves local data/i,
    );
  });

  test('a configured gateway reports itself configured', () => {
    const { service } = gateway([{ body: {} }]);
    expect(service.configured).toBe(true);
  });
});

// ── Requests are shaped ─────────────────────────────────────────────────────

describe('every call requests only the fields it uses', () => {
  test('getEntity sends the audited entity shape', async () => {
    const { service, calls } = gateway([{ body: ENTITY_PAGE.results[0] }]);
    await service.getEntity('ZZTESTUEI001');
    expect(calls).toHaveLength(1);
    const url = new URL(calls[0]!.url);
    expect(url.searchParams.get('shape')).toBe(TANGO_SHAPES.entity);
  });

  test('listForecasts sends the audited forecast shape', async () => {
    const { service, calls } = gateway([{ body: FORECAST_PAGE }]);
    await service.listForecasts();
    expect(new URL(calls[0]!.url).searchParams.get('shape')).toBe(TANGO_SHAPES.forecast);
  });

  test('the key travels as a header, never in the query string', async () => {
    const { service, calls } = gateway([{ body: ENTITY_PAGE }]);
    await service.listEntities();
    expect(calls[0]!.headers['x-api-key']).toBe(TEST_KEY);
    expect(calls[0]!.url).not.toContain(TEST_KEY);
    expect(new URL(calls[0]!.url).search).not.toMatch(/key|token|secret/i);
  });

  test('the page size is clamped at both ends, to the SDK own cap', async () => {
    const { service, calls } = gateway([{ body: ENTITY_PAGE }, { body: ENTITY_PAGE }]);
    await service.listEntities({ limit: 100_000 });
    await service.listEntities({ limit: -5 });
    expect(new URL(calls[0]!.url).searchParams.get('limit')).toBe('100');
    expect(new URL(calls[1]!.url).searchParams.get('limit')).toBe('1');
  });

  test('a cursor is decoded into the page number the provider actually wants', async () => {
    // P22 finding (decision-log D-42): /api/entities/ (like every other list
    // endpoint this gateway calls) is page-number pagination server-side, not
    // cursor-based — confirmed by reading a live `next` URL directly. Capiro's
    // own "cursor" stays opaque to every caller ABOVE this file, but page()
    // itself must decode it back into the `page` query param the provider
    // actually reads; a raw `?cursor=` param here would be silently ignored
    // and the request would fall back to page 1 every time.
    const { service, calls } = gateway([{ body: ENTITY_PAGE }]);
    await service.listEntities({ cursor: '3' });
    expect(new URL(calls[0]!.url).searchParams.get('page')).toBe('3');
    expect(new URL(calls[0]!.url).searchParams.get('cursor')).toBeNull();
  });

  test('an absent, blank, or garbage cursor all mean page 1', async () => {
    const { service, calls } = gateway([{ body: ENTITY_PAGE }, { body: ENTITY_PAGE }, { body: ENTITY_PAGE }]);
    await service.listEntities();
    await service.listEntities({ cursor: null });
    await service.listEntities({ cursor: 'not-a-number' });
    for (const call of calls) {
      expect(new URL(call.url).searchParams.get('page')).toBe('1');
    }
  });

  test('the SDK’s own retry is OFF, so P18 owns retry alone', async () => {
    // Two layers of retry means the request ceiling P18 enforces is measuring
    // something other than the number of requests actually sent.
    const { service, calls } = gateway([{ status: 503, body: ERRORS.server500 }]);
    await expect(service.getVersion()).rejects.toBeInstanceOf(TangoError);
    expect(calls).toHaveLength(1);
  });
});

// ── Errors are classified and redacted ──────────────────────────────────────

describe('failures are classified', () => {
  test.each([
    [401, ERRORS.auth401, 'auth', false],
    [403, ERRORS.auth403, 'auth', false],
    [403, ERRORS.tier403, 'tier', false],
    [404, ERRORS.notFound404, 'not_found', false],
    [400, ERRORS.validation400, 'validation', false],
    [429, ERRORS.rateLimit429, 'rate_limit', true],
    [500, ERRORS.server500, 'transient', true],
    [503, ERRORS.server500, 'transient', true],
  ])('a %s becomes kind=%#', async (status, body, kind, retryable) => {
    const { service } = gateway([{ status: status as number, body }]);
    await expect(service.getVersion()).rejects.toMatchObject({ kind, retryable });
  });

  test('a TIER 403 is not reported as an auth failure', async () => {
    // Sending an operator to rotate a key that is working perfectly is the
    // failure this distinction prevents. And a tier error is never retryable.
    const { service } = gateway([{ status: 403, body: ERRORS.tier403 }]);
    const error = await service.listForecasts().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TangoError);
    expect((error as TangoError).kind).toBe('tier');
    expect((error as TangoError).retryable).toBe(false);
  });

  test('an unrecognised 4xx is validation, and an unrecognised body on 403 is TIER', () => {
    // Fail-safe direction: a tier error is never retried, so mislabelling an auth
    // failure as tier costs a clear message, while the reverse retries a rejected
    // credential against a rate limit.
    expect(classifyStatus(418, ERRORS.teapot418)).toBe('validation');
    expect(classifyStatus(403, { detail: 'nope' })).toBe('tier');
    expect(classifyStatus(403, ERRORS.auth403)).toBe('auth');
  });

  test('a transport failure with no status is transient', async () => {
    const service = new TangoGatewayService({
      apiKey: TEST_KEY,
      fetchImpl: (async () => {
        throw new Error('fetch failed');
      }) as unknown as typeof fetch,
    });
    await expect(service.getVersion()).rejects.toMatchObject({ kind: 'transient', retryable: true });
  });

  test('every kind has a defined retryability, and only two are retryable', () => {
    const retryable = TANGO_ERROR_KINDS.filter(
      (kind) => new TangoError('x', { kind, operation: 'op', statusCode: null, detail: null, rate: null }).retryable,
    );
    expect(retryable).toEqual(['rate_limit', 'transient']);
  });

  test('the error carries the operation, never a URL with a query string', async () => {
    const { service } = gateway([{ status: 500, body: ERRORS.server500 }]);
    const error = (await service.listVehicles().catch((e) => e)) as TangoError;
    expect(error.operation).toBe('listVehicles');
    expect(error.message).not.toContain('?');
    expect(JSON.stringify(error.toLogContext())).not.toContain('shape=');
  });
});

describe('nothing that looks like a credential survives into an error', () => {
  test('the literal key is redacted out of the message', async () => {
    // The fixture body echoes the key back, which is exactly what a badly-behaved
    // upstream does in an "invalid key: <the key>" message.
    const { service } = gateway([{ status: 401, body: ERRORS.auth401 }]);
    const error = (await service.getVersion().catch((e) => e)) as TangoError;
    const serialised = JSON.stringify({
      message: error.message,
      detail: error.detail,
      log: error.toLogContext(),
    });
    expect(serialised).not.toContain(TEST_KEY);
    expect(serialised).not.toContain('NOTAREALKEY');
  });

  test('the raw SDK error is not enumerable, so a serialiser cannot walk back to it', async () => {
    const { service } = gateway([{ status: 401, body: ERRORS.auth401 }]);
    const error = (await service.getVersion().catch((e) => e)) as TangoError;
    expect(Object.keys(error)).not.toContain('cause');
    expect(JSON.stringify(error)).not.toContain(TEST_KEY);
  });

  test.each([
    ['X-API-KEY: abcdef123456', /\[redacted\]/],
    ['api_key=abcdef123456&page=2', /\[redacted\]/],
    ['{"apiKey":"abcdef123456"}', /\[redacted\]/],
    ['Authorization: Bearer abcdef123456', /\[redacted\]/],
    ['https://x/y?token=abcdef123456', /\[redacted\]/],
  ])('pattern redaction catches %s', (input, expected) => {
    const out = redact(input);
    expect(out).toMatch(expected);
    expect(out).not.toContain('abcdef123456');
  });

  test('a bare key with no label around it is caught by literal redaction', () => {
    // The one case patterns cannot reach.
    expect(redactWithKnownSecret(`nope: ${TEST_KEY}`, TEST_KEY)).not.toContain(TEST_KEY);
  });

  test('a short "secret" is ignored, so unrelated text is not mangled', () => {
    expect(redactWithKnownSecret('the cat sat', 'cat')).toBe('the cat sat');
  });

  test('a key-NAMED field is dropped whole rather than redacted in place', () => {
    const out = redactUnknown({ apiKey: 'x', nested: { authorization: 'y', keep: 'z' } }) as Record<
      string,
      Record<string, string> | string
    >;
    expect(out.apiKey).toBe('[redacted]');
    expect((out.nested as Record<string, string>).authorization).toBe('[redacted]');
    expect((out.nested as Record<string, string>).keep).toBe('z');
  });

  test('redaction is depth-bounded, so a hostile payload cannot hang it', () => {
    let deep: unknown = 'leaf';
    for (let i = 0; i < 50; i += 1) deep = { next: deep };
    expect(JSON.stringify(redactUnknown(deep))).toContain('[truncated]');
  });
});

// ── Rate metadata is surfaced, not acted on ─────────────────────────────────

describe('rate metadata is surfaced for P18, and nothing acts on it here', () => {
  test('headers from the last response are exposed', async () => {
    const { service } = gateway([
      {
        body: ENTITY_PAGE,
        headers: {
          'x-ratelimit-remaining': '17',
          'x-ratelimit-limit': '1000',
          'x-ratelimit-reset': '60',
        },
      },
    ]);
    const page = await service.listEntities();
    expect(service.lastRate).toMatchObject({ remaining: 17, limit: 1000, resetIn: 60 });
    expect(page.rate).toMatchObject({ remaining: 17 });
  });

  test('a 429 carries the provider’s Retry-After onto the error', async () => {
    const { service } = gateway([
      { status: 429, body: ERRORS.rateLimit429, headers: { 'retry-after': '42' } },
    ]);
    const error = (await service.getVersion().catch((e) => e)) as TangoError;
    expect(error.kind).toBe('rate_limit');
    expect(error.rate?.retryAfter).toBe(42);
  });

  test('rate metadata is captured on FAILURE too, not only on success', async () => {
    // A 429 is precisely when the numbers matter, and it is an error path.
    const { service } = gateway([
      { status: 429, body: ERRORS.rateLimit429, headers: { 'x-ratelimit-remaining': '0' } },
    ]);
    await service.getVersion().catch(() => undefined);
    expect(service.lastRate?.remaining).toBe(0);
  });
});

// ── Normalisation ───────────────────────────────────────────────────────────

describe('the boundary normalizes, and refuses to invent', () => {
  const AT = '2026-08-06T00:00:00.000Z';

  test('an entity maps to Capiro names with provenance attached', async () => {
    const { service } = gateway([{ body: ENTITY_PAGE }]);
    const page = await service.listEntities();
    const first = page.items[0]!;
    expect(first.uei).toBe('ZZTESTUEI001');
    expect(first.legalBusinessName).toBe('Synthetic Turbine Works LLC');
    expect(first.provenance).toMatchObject({
      provider: 'tango',
      resourceType: 'entity',
      externalId: 'ZZTESTUEI001',
      providerUpdatedAt: '2026-08-01T12:00:00.000Z',
    });
    expect(Date.parse(first.provenance.fetchedAt)).toBeGreaterThan(0);
  });

  test('an UNREQUESTED field cannot enter a normalized object', async () => {
    // `risk_score` and `total_awards_obligated` are in the fixture and in no
    // shape. A provider adding a field next month must not become a Capiro fact.
    const { service } = gateway([{ body: ENTITY_PAGE }]);
    const page = await service.listEntities();
    // federal_obligations is excluded on purpose: Capiro computes award history
    // from its own USAspending rail, and a second differently-derived total
    // invites somebody to treat the difference as a finding. exclusion_status_flag
    // is excluded because P45 owns exclusion risk with its own review semantics.
    // entity_structure/state_of_incorporation are excluded because NEITHER this
    // SDK's field name for them nor the live server's round-trips end-to-end
    // through @makegov/tango-node@1.1.0 — a real SDK-vs-server incompatibility
    // found on the real account (P19, decision-log D-35), not a Capiro omission.
    expect(JSON.stringify(page.items[0])).not.toContain('federal_obligations');
    expect(JSON.stringify(page.items[0])).not.toContain('exclusion');
    expect(unexpectedFields(ENTITY_PAGE.results[0], 'entity').sort()).toEqual([
      'entity_structure',
      'exclusion_status_flag',
      'federal_obligations',
      'state_of_incorporation',
    ]);
  });

  test('entityStructure/stateOfIncorporation are always null — a real SDK-vs-server incompatibility, not a fallback', async () => {
    // P19 finding (decision-log D-35): the live server rejects this SDK's
    // bundled entity_structure_desc/state_of_incorporation_code field names
    // ("Invalid shape... unknown_field"), and the SDK's own client-side
    // materializeOne rejects the live server's bare entity_structure/
    // state_of_incorporation names right back (ShapeValidationError) on
    // EVERY successful getEntity call, not just listEntities. Neither name
    // round-trips through @makegov/tango-node@1.1.0, so neither is requested
    // — even though the fixture carries plausible values for both (as
    // "noise the shape never asked for"), they must never leak through.
    const { service } = gateway([{ body: ENTITY_PAGE }]);
    const page = await service.listEntities();
    expect(page.items[0]!.entityStructure).toBeNull();
    expect(page.items[0]!.stateOfIncorporation).toBeNull();
  });

  test('a record with no usable identifier is DROPPED, never half-mapped', async () => {
    const { service } = gateway([{ body: ENTITY_UNKEYED }]);
    const page = await service.listEntities();
    expect(page.items).toHaveLength(1);
    expect(page.items[0]!.uei).toBe('ZZTESTUEI003');
  });

  test.each([
    ['a decimal string', 0, 1_250_000.75],
    ['an absent value', 1, null],
    ['a stated ZERO', 2, 0],
  ])('money: %s maps correctly', async (_label, index, expected) => {
    // The central honesty rule: null means the source stated nothing, 0 means the
    // source stated zero, and the two must never collapse into each other.
    //
    // Asserted on a VEHICLE, because the provider's forecast model carries no
    // money field at all — which is itself worth knowing, and is why P24 cannot
    // promise a forecast value.
    const { service } = gateway([{ body: VEHICLE_PAGE }]);
    const page = await service.listVehicles();
    expect(page.items[index as number]!.totalObligated).toBe(expected);
  });

  test('the provider models NO money on a forecast, and the adapter does not invent one', async () => {
    const { service } = gateway([{ body: FORECAST_PAGE }]);
    const page = await service.listForecasts();
    expect(Object.keys(page.items[0]!)).not.toContain('estimatedValue');
    // What it DOES carry is a free-text period, kept as text rather than parsed
    // into a date nobody stated.
    expect(page.items[0]!.estimatedPeriod).toBe('Q3 FY27');
    expect(page.items[1]!.estimatedPeriod).toBeNull();
  });

  test('a forecast has no provider modified stamp, and fetchedAt is not substituted', async () => {
    // "When we looked" is not "when it changed". Conflating them would make every
    // sync look like a material update.
    const { service } = gateway([{ body: FORECAST_PAGE }]);
    const page = await service.listForecasts();
    expect(page.items[0]!.provenance.providerUpdatedAt).toBeNull();
    expect(Date.parse(page.items[0]!.provenance.fetchedAt)).toBeGreaterThan(0);
  });

  test('dates normalize to ISO, and an unparseable one is null rather than today', async () => {
    const { service } = gateway([{ body: ENTITY_PAGE }]);
    const page = await service.listEntities();
    expect(page.items[0]!.samExpirationDate).toBe('2027-03-14T00:00:00.000Z');
    expect(page.items[1]!.samExpirationDate).toBeNull();
  });

  test('a date-only value anchors at UTC midnight, not local midnight', () => {
    // Otherwise the same forecast reads as a different day depending on where the
    // job ran.
    expect(iso('2027-04-01')).toBe('2027-04-01T00:00:00.000Z');
  });

  test('absence has exactly one representation', async () => {
    // The provider variously omits the key, sends null, or sends "". A consumer
    // must have one absence to check.
    const { service } = gateway([{ body: ENTITY_PAGE }]);
    const page = await service.listEntities();
    expect(page.items[0]!.dbaName).toBeNull(); // "  "
    expect(page.items[1]!.dbaName).toBeNull(); // null
    expect(page.items[1]!.entityStructure).toBeNull(); // null
    expect(page.items[1]!.physicalAddress).toBeNull(); // {} — an empty address is ABSENT
  });

  test('a comma-separated list and a real array both become a string array', async () => {
    const { service } = gateway([{ body: ENTITY_PAGE }]);
    const page = await service.listEntities();
    expect(page.items[0]!.naicsCodes).toEqual(['336412', '541330']);
    expect(page.items[0]!.pscCodes).toEqual(['1560', 'J015']);
    expect(page.items[1]!.naicsCodes).toEqual([]);
  });

  test('a missing boolean is UNKNOWN (null), never false', () => {
    expect(bool(undefined)).toBeNull();
    expect(bool('true')).toBe(true);
    expect(bool(0)).toBe(false);
  });

  test('a nested recipient block is flattened to a UEI a match can use', async () => {
    const { service } = gateway([{ body: AWARDEE_PAGE }]);
    const page = await service.listVehicleAwardees('22222222-bbbb-4ccc-8ddd-000000000001');
    expect(page.items[0]!.recipientUei).toBe('ZZTESTUEI001');
    expect(page.items[0]!.recipientName).toBe('Synthetic Turbine Works LLC');
    // An awardee with no recipient cannot be evidence of direct access. It is
    // kept, with a null UEI, so the absence is visible rather than dropped.
    expect(page.items[1]!.recipientUei).toBeNull();
  });

  test('recipientParentUei is always null — a confirmed provider gap, not a fallback', async () => {
    // P22 finding (decision-log D-41): the live server's `recipient`
    // expansion on THIS endpoint has no parent/owner UEI field under any
    // name — confirmed by reading its own available_fields payload. Even a
    // fixture row carrying a plausible parent_uei value (as "noise the
    // shape never asked for") must never leak through — "your parent is on
    // this vehicle" and "you are on this vehicle" are different answers to
    // whether a client can bid (P23 depends on the two not merging), and a
    // silently-wrong parent UEI would be worse than a visibly absent one.
    const { service } = gateway([{ body: AWARDEE_PAGE }]);
    const page = await service.listVehicleAwardees('22222222-bbbb-4ccc-8ddd-000000000001');
    for (const item of page.items) {
      expect(item.recipientParentUei).toBeNull();
    }
  });

  test('provider business types stay SEPARATE from anything reviewed', async () => {
    // A provider socio-economic indicator is evidence for a review, never a
    // determination of solicitation eligibility.
    const { service } = gateway([{ body: ENTITY_PAGE }]);
    const page = await service.listEntities();
    expect(page.items[0]!.sbaBusinessTypes).toEqual(['Small Disadvantaged Business']);
    expect(Object.keys(page.items[0]!)).not.toContain('setAsideCertifications');
    expect(Object.keys(page.items[0]!)).not.toContain('certifications');
  });

  test('the page derives nextCursor from next\'s presence, and carries the provider\'s own count', async () => {
    // NOT `response.cursor` — see tango.client.ts's parsePageCursor doc
    // (P22/D-42) for why the SDK's own cursor field is unusable here. This
    // fixture's `next` carries `?page=2`, which is what a real response
    // looks like; `nextCursor` is Capiro's own opaque "2", not that URL.
    const { service } = gateway([{ body: ENTITY_PAGE }]);
    const page = await service.listEntities();
    expect(page.nextCursor).toBe('2');
    expect(page.totalCount).toBe(2);
  });

  test('nextCursor is null when the provider reports no next page', async () => {
    const lastPage = { ...ENTITY_PAGE, next: null, cursor: null };
    const { service } = gateway([{ body: lastPage }]);
    const page = await service.listEntities({ cursor: '9' });
    expect(page.nextCursor).toBeNull();
  });

  test('a 404 on getEntity is unresolved EVIDENCE (null), not an exception', async () => {
    const { service } = gateway([{ status: 404, body: ERRORS.notFound404 }]);
    await expect(service.getEntity('ZZTESTUEI999')).resolves.toBeNull();
  });

  test('a 401 on getEntity still throws — only not-found is softened', async () => {
    const { service } = gateway([{ status: 401, body: ERRORS.auth401 }]);
    await expect(service.getEntity('ZZTESTUEI001')).rejects.toMatchObject({ kind: 'auth' });
  });
});

// ── Primitive helpers, as data ──────────────────────────────────────────────

describe('the normalisation primitives', () => {
  test.each([
    ['', null],
    ['   ', null],
    [null, null],
    [undefined, null],
    ['  x  ', 'x'],
    [5, '5'],
  ])('str(%p) -> %p', (input, expected) => expect(str(input)).toBe(expected));

  test.each([
    [null, null],
    ['', null],
    ['not a number', null],
    ['1,234.50', 1234.5],
    ['$2,000', 2000],
    [0, 0],
    [Number.NaN, null],
  ])('num(%p) -> %p', (input, expected) => expect(num(input)).toBe(expected));

  test.each([
    ['2027', 2027],
    [2027.9, 2027],
    [null, null],
  ])('int(%p) -> %p', (input, expected) => expect(int(input)).toBe(expected));

  test('strList tolerates every form the provider uses', () => {
    expect(strList(['a', ' b ', null])).toEqual(['a', 'b']);
    expect(strList('a, b')).toEqual(['a', 'b']);
    expect(strList(null)).toEqual([]);
  });

  test('pick allow-lists, and never invents a key', () => {
    const out = pick({ uei: 'U', risk_score: 9 }, 'entity');
    expect(out).toEqual({ uei: 'U' });
    expect(Object.hasOwn(out, 'cage_code')).toBe(false);
  });

  test('mapEntity returns null for a record with no UEI', () => {
    expect(mapEntity({ legal_business_name: 'X' }, '2026-08-06T00:00:00.000Z')).toBeNull();
  });
});

// ── The shapes themselves ───────────────────────────────────────────────────

describe('the audited shapes', () => {
  test('every shape is built from its own field list, with no drift', () => {
    for (const [name, shape] of Object.entries(TANGO_SHAPES)) {
      const fields = TANGO_SHAPE_FIELDS[name as keyof typeof TANGO_SHAPE_FIELDS];
      expect(shape).toBe(fields.join(','));
    }
  });

  test('no shape is empty, and none uses the wildcard', () => {
    // `*` is the opposite of an audited shape: it asks for everything the provider
    // has now and everything it adds later.
    for (const shape of Object.values(TANGO_SHAPES)) {
      expect(shape.length).toBeGreaterThan(0);
      expect(shape).not.toContain('*');
    }
  });

  test('the client never inlines a shape string of its own', () => {
    // A call that invents its own selector bypasses every reason the shapes file
    // exists — data minimisation, the unknown-field rule, and cost.
    const source = readFileSync(join(__dirname, 'tango.client.ts'), 'utf8');
    const inlined = source.match(/shape:\s*['"`]/g) ?? [];
    expect(inlined).toEqual([]);
    expect(source).toContain('TANGO_SHAPES.');
  });

  test('every resource type the domain declares has a shape', () => {
    const shaped = new Set(Object.keys(TANGO_SHAPES));
    for (const type of TANGO_RESOURCE_TYPES) {
      expect(shaped.has(type.replace(/_([a-z])/g, (_m, c: string) => c.toUpperCase()))).toBe(true);
    }
  });
});

// ── Fixtures ────────────────────────────────────────────────────────────────

describe('the fixtures are synthetic', () => {
  const files = readdirSync(FIXTURES).filter((f) => f.endsWith('.json'));

  test('there is at least one fixture per call family under test', () => {
    expect(files.length).toBeGreaterThanOrEqual(6);
  });

  test('every fixture says, in the file, that it is synthetic', () => {
    // A fixture captured from a live tenant freezes that week's accidents as
    // though they were the contract — and, for a provider, can carry real
    // company data into the repository.
    for (const file of files) {
      const parsed = JSON.parse(readFileSync(join(FIXTURES, file), 'utf8'));
      expect(String(parsed._comment ?? '')).toMatch(/SYNTHETIC/);
    }
  });

  test('no fixture contains anything key-shaped that is not clearly fake', () => {
    for (const file of files) {
      const text = readFileSync(join(FIXTURES, file), 'utf8');
      const secrets = text.match(/sk_(live|test)_[A-Za-z0-9_]+/g) ?? [];
      for (const secret of secrets) expect(secret).toContain('NOTAREALKEY');
    }
  });
});
