import { describe, expect, it } from '@jest/globals';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BadRequestException, ForbiddenException, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import { ToolServiceSecretGuard } from './tool-service-secret.guard.js';
import {
  admitMeriFundingReadObservation,
  admitMeriReadObservation,
  currentMeriFundingReadAsOf,
  currentMeriReadAsOf,
  withMeriFundingReadObservation,
  withMeriReadObservation,
  MERI_EVIDENCE_MODE_READS,
  currentMeriEvidenceAccuracyMode,
} from './meri-funding-read-observation.js';
const modeOnlyReads = MERI_EVIDENCE_MODE_READS.filter(id => id !== 'search_sam_opportunities');

// neo-capiro/meri-greenfield@b4daa4adf6e8269e7c341751db9a02bf6d4f062b,
// packages/contracts/native-read-observation-0.2/test/golden.json,
// search_funding_opportunities: original request keeps whitespace and Unicode.
const GOLDEN_CARRIER =
  'eyJjb250ZXh0Ijp7ImFzT2YiOiIyMDI2LTEwLTE3VDEyOjM0OjU2Ljc4OVoifSwib3BlcmF0aW9uIjp7ImlkIjoic2VhcmNoX2Z1bmRpbmdfb3Bwb3J0dW5pdGllcyIsInZlcnNpb24iOiIwLjIuMCJ9LCJyZXF1ZXN0U2hhMjU2IjoiNTA5MmY4ZWJmYTE3OTc4MzNmOTYzNTNlOTNiODA3ZGZjMjRjZjExMDdhNmM5OGNlOTlhZDQ5ZjhiODY0YjRlOCIsInNjaGVtYVZlcnNpb24iOiJtZXJpLW5hdGl2ZS1yZWFkLW9ic2VydmF0aW9uLzEifQ';
const NAME = 'search_funding_opportunities';
const BODY = {
  query: ' Civic & energía 🌱 ',
  clientId: 'a1234567-b123-4c12-8d12-e123456789ab',
  pageSize: 5,
};
const AS_OF = '2026-10-17T12:34:56.789Z';
const SECRET = 'funding-observation-service-secret';
const KB_NAME = 'search_client_knowledge';
const KB_BODY = {
  query: '  Civic & energ\u00eda \ud83c\udf31  ',
  clientId: 'A1234567-B123-4C12-8D12-E123456789AB',
  kind: 'client_doc_chunk',
  limit: 5,
};
const KB_REQUEST_SHA256 = '5a1fe25a9a0a88616f200c7e135c55f689f30b20cf481b7d1e137d06432f8e70';
// Exact UTF-8 source: neo-capiro/meri-greenfield@56627c1fe31e5c7386f79ca23e7605ba5dc59b83,
// docs/coordination/proposals/native-kb-observation-20261017/golden.json,
// Git blob a807a90718c2260f2c980bd04e04cec2d8c9414f (2018 bytes).
const KB_FIXTURE = JSON.parse(readFileSync(
  join(__dirname, '__fixtures__', 'native-kb-observation-0.2-golden.json'), 'utf8',
)) as {
  format: string;
  vectors: Array<{
    operation: { id: string; version: string };
    request: Record<string, unknown>;
    context: { asOf: string };
    requestCanonicalJson: string;
    requestSha256: string;
    observation: Record<string, unknown>;
    canonicalJson: string;
    decodedBytes: number;
    carrier: string;
    observationSha256: string;
  }>;
};
const KB_CARRIER = KB_FIXTURE.vectors[0]!.carrier;
const malformedCases: [string, string, Record<string, unknown>, string][] = [
  ['changed original request', NAME, { ...BODY, query: BODY.query.trim() }, GOLDEN_CARRIER],
  ['other route', 'get_funding_opportunity', BODY, GOLDEN_CARRIER],
  ['unlisted route', 'explain_opportunity_match', BODY, GOLDEN_CARRIER],
  ['padding', NAME, BODY, `${GOLDEN_CARRIER}=`],
  ['invalid alphabet', NAME, BODY, `${GOLDEN_CARRIER}*`],
];

function request(header?: unknown, serviceSecret?: unknown, name = NAME): Request {
  return {
    headers: {
      ...(header === undefined ? {} : { 'x-meri-read-observation': header }),
      ...(serviceSecret === undefined ? {} : { 'x-internal-service-secret': serviceSecret }),
    },
    method: 'POST',
    path: `/api/clio/tools/${name}`,
  } as unknown as Request;
}

function guardRequest(
  req: Request,
  expected: string | undefined = SECRET,
  environment = 'development',
): boolean {
  const guard = new ToolServiceSecretGuard({
    get: (key: string) =>
      key === 'NODE_ENV'
        ? environment
        : key === 'INTERNAL_SERVICE_SECRET'
          ? expected
          : key === 'MERI_TOOLS_REQUIRE_SERVICE_SECRET'
            ? false
            : undefined,
  } as never);
  return guard.canActivate({
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext);
}

function alteredCarrier(change: (value: Record<string, unknown>) => void): string {
  const value = JSON.parse(Buffer.from(GOLDEN_CARRIER, 'base64url').toString('utf8')) as Record<
    string,
    unknown
  >;
  change(value);
  // The golden object is in canonical key order; replacements retain order.
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

describe('finite funding read observation', () => {
  it('admits all five exact PR109 wire vectors, including a valid surrogate pair', () => {
    const fixture = JSON.parse(
      readFileSync(
        join(__dirname, '__fixtures__', 'native-read-observation-0.2-pr109-golden.json'),
        'utf8',
      ),
    ) as {
      format: string;
      vectors: Array<{
        operation: { id: string };
        request: Record<string, unknown>;
        context: { asOf: string };
        carrier: string;
      }>;
    };
    expect(fixture.format).toBe('meri-native-read-observation-golden/1');
    expect(fixture.vectors.map(({ operation }) => operation.id)).toEqual([
      'search_funding_opportunities',
      'get_funding_opportunity_requirements',
      'get_funding_opportunity',
      'get_opportunity_client_context',
      'get_opportunity_government_landscape',
    ]);
    expect(fixture.vectors[0]?.request.query).toContain('\ud83c\udf31');
    for (const vector of fixture.vectors) {
      const req = request(vector.carrier, SECRET, vector.operation.id);
      expect(guardRequest(req)).toBe(true);
      expect(admitMeriFundingReadObservation(vector.operation.id, vector.request, req)).toEqual({
        operationId: vector.operation.id,
        asOf: vector.context.asOf,
      });
    }
  });

  it('accepts the exact Meri wire vector only after a real service-secret match', () => {
    const req = request(GOLDEN_CARRIER, SECRET);
    expect(guardRequest(req)).toBe(true);
    expect(admitMeriFundingReadObservation(NAME, BODY, req)).toEqual({
      operationId: NAME,
      asOf: AS_OF,
    });
  });

  it.each(['staging', 'production'])(
    '%s accepts only a matched service secret for an observed read',
    (environment) => {
      const accepted = request(GOLDEN_CARRIER, SECRET);
      expect(guardRequest(accepted, SECRET, environment)).toBe(true);
      expect(admitMeriFundingReadObservation(NAME, BODY, accepted)?.asOf).toBe(AS_OF);

      const rejected = request(GOLDEN_CARRIER, 'wrong');
      expect(() => guardRequest(rejected, SECRET, environment)).toThrow(ForbiddenException);
      expect(() => admitMeriFundingReadObservation(NAME, BODY, rejected)).toThrow(
        ForbiddenException,
      );
    },
  );

  it('keeps legacy no-header requests independent of observe-mode service admission', () => {
    const req = request(undefined, 'wrong');
    expect(guardRequest(req)).toBe(true);
    expect(admitMeriFundingReadObservation(NAME, BODY, req)).toBeUndefined();
    expect(currentMeriFundingReadAsOf(NAME)).toBeUndefined();
  });

  it.each([undefined, 'wrong', ['wrong']])(
    'refuses an observed read without a verified service identity: %p',
    (provided) => {
      const req = request(GOLDEN_CARRIER, provided);
      expect(guardRequest(req)).toBe(true);
      expect(() => admitMeriFundingReadObservation(NAME, BODY, req)).toThrow(ForbiddenException);
    },
  );

  it('refuses an observed read when no service secret is configured', () => {
    const req = request(GOLDEN_CARRIER, SECRET);
    expect(guardRequest(req, '')).toBe(true);
    expect(() => admitMeriFundingReadObservation(NAME, BODY, req)).toThrow(ForbiddenException);
  });

  it('does not retain service proof if a request object is checked again without a match', () => {
    const req = request(GOLDEN_CARRIER, SECRET);
    expect(guardRequest(req)).toBe(true);
    req.headers['x-internal-service-secret'] = 'wrong';
    expect(guardRequest(req)).toBe(true);
    expect(() => admitMeriFundingReadObservation(NAME, BODY, req)).toThrow(ForbiddenException);
  });

  it.each(malformedCases)('rejects %s before producer work', (_reason, name, body, carrier) => {
    const req = request(carrier, SECRET);
    guardRequest(req);
    expect(() => admitMeriFundingReadObservation(name, body, req)).toThrow(BadRequestException);
  });

  it('rejects an overflowed original JSON number instead of hashing it as null', () => {
    const body = JSON.parse('{"page":1e400}') as Record<string, unknown>;
    expect(body.page).toBe(Infinity);
    const nullPageHash = createHash('sha256').update('{"page":null}', 'utf8').digest('hex');
    const carrier = alteredCarrier((value) => {
      value.requestSha256 = nullPageHash;
    });
    const req = request(carrier, SECRET);
    expect(guardRequest(req)).toBe(true);
    expect(() => admitMeriFundingReadObservation(NAME, body, req)).toThrow(BadRequestException);
  });

  it.each([
    ['value', { query: '\ud800' }],
    ['key', { ['\udc00']: 'query' }],
  ])('rejects an ill-formed Unicode %s in the original body', (_position, body) => {
    const requestSha256 = createHash('sha256')
      .update(JSON.stringify(body), 'utf8')
      .digest('hex');
    const carrier = alteredCarrier((value) => {
      value.requestSha256 = requestSha256;
    });
    const req = request(carrier, SECRET);
    expect(guardRequest(req)).toBe(true);
    expect(() => admitMeriFundingReadObservation(NAME, body, req)).toThrow(BadRequestException);
  });

  it('rejects changed operation, noncanonical timestamp and extra context', () => {
    for (const carrier of [
      alteredCarrier((value) => {
        (value.operation as Record<string, unknown>).version = '0.2.1';
      }),
      alteredCarrier((value) => {
        (value.context as Record<string, unknown>).asOf = '2026-10-17T12:34:56Z';
      }),
      alteredCarrier((value) => {
        (value.context as Record<string, unknown>).deadlineAt = AS_OF;
      }),
    ]) {
      const req = request(carrier, SECRET);
      guardRequest(req);
      expect(() => admitMeriFundingReadObservation(NAME, BODY, req)).toThrow(BadRequestException);
    }
  });

  it('rejects duplicate JSON keys, noncanonical order, invalid UTF-8 and oversize carriers', () => {
    const canonical = Buffer.from(GOLDEN_CARRIER, 'base64url').toString('utf8');
    const parsed = JSON.parse(canonical) as Record<string, unknown>;
    const badCarriers = [
      Buffer.from(canonical.replace('"schemaVersion":', '"schemaVersion":"duplicate","schemaVersion":')).toString('base64url'),
      Buffer.from(
        JSON.stringify({
          schemaVersion: parsed.schemaVersion,
          operation: parsed.operation,
          requestSha256: parsed.requestSha256,
          context: parsed.context,
        }),
      ).toString('base64url'),
      Buffer.from([0xff]).toString('base64url'),
      Buffer.alloc(2049, 0x61).toString('base64url'),
    ];
    for (const carrier of badCarriers) {
      const req = request(carrier, SECRET);
      guardRequest(req);
      expect(() => admitMeriFundingReadObservation(NAME, BODY, req)).toThrow(BadRequestException);
    }
  });

  it('keeps concurrent and nested calculation anchors request-local', async () => {
    const first = { operationId: NAME, asOf: AS_OF } as const;
    const second = { operationId: NAME, asOf: '2026-10-18T01:02:03.004Z' } as const;
    const values = await Promise.all([
      withMeriFundingReadObservation(first, async () => {
        await Promise.resolve();
        expect(
          withMeriFundingReadObservation(second, () => currentMeriFundingReadAsOf(NAME)?.toISOString()),
        ).toBe(second.asOf);
        return currentMeriFundingReadAsOf(NAME)?.toISOString();
      }),
      withMeriFundingReadObservation(second, async () => {
        await Promise.resolve();
        expect(() => currentMeriFundingReadAsOf('get_funding_opportunity')).toThrow(
          ForbiddenException,
        );
        return currentMeriFundingReadAsOf(NAME)?.toISOString();
      }),
    ]);
    expect(values).toEqual([AS_OF, second.asOf]);
    expect(currentMeriFundingReadAsOf(NAME)).toBeUndefined();
  });
});

describe('client knowledge read observation', () => {
  it('binds the original closed body and carries its KB-only clock', () => {
    expect(KB_FIXTURE.format).toBe('meri-native-read-observation-golden/1');
    expect(KB_FIXTURE.vectors).toHaveLength(1);
    const vector = KB_FIXTURE.vectors[0]!;
    expect(vector.operation).toEqual({ id: KB_NAME, version: '0.2.0' });
    expect(vector.request).toEqual(KB_BODY);
    expect(vector.context).toEqual({ asOf: AS_OF });
    expect(vector.requestSha256).toBe(KB_REQUEST_SHA256);
    expect(createHash('sha256').update(vector.requestCanonicalJson, 'utf8').digest('hex'))
      .toBe(KB_REQUEST_SHA256);
    const decoded = Buffer.from(vector.carrier, 'base64url');
    expect(decoded.byteLength).toBe(vector.decodedBytes);
    expect(decoded.toString('utf8')).toBe(vector.canonicalJson);
    expect(JSON.parse(vector.canonicalJson)).toEqual(vector.observation);
    expect(createHash('sha256').update(decoded).digest('hex')).toBe(vector.observationSha256);
    const req = request(KB_CARRIER, SECRET, KB_NAME);
    expect(guardRequest(req)).toBe(true);
    const observation = admitMeriReadObservation(KB_NAME, KB_BODY, req);
    expect(observation).toEqual({ operationId: KB_NAME, asOf: AS_OF });
    expect(withMeriReadObservation(observation!, () => currentMeriReadAsOf(KB_NAME))).toBe(AS_OF);
    expect(currentMeriReadAsOf(KB_NAME)).toBeUndefined();
    expect(() => admitMeriFundingReadObservation(KB_NAME, KB_BODY, req)).toThrow(BadRequestException);
  });

  it('refuses changed, open or mistyped KB bodies before dispatch', () => {
    for (const body of [
      { ...KB_BODY, query: KB_BODY.query.trim() },
      { ...KB_BODY, extra: true },
      { ...KB_BODY, limit: [] },
      { ...KB_BODY, clientId: 1 },
      { ...KB_BODY, kind: false },
      { ...KB_BODY, query: null },
    ]) {
      const req = request(KB_CARRIER, SECRET, KB_NAME);
      expect(guardRequest(req)).toBe(true);
      expect(() => admitMeriReadObservation(KB_NAME, body, req)).toThrow(BadRequestException);
    }
  });

  it('requires the same verified service proof and exact KB route', () => {
    for (const secret of [undefined, 'wrong']) {
      const req = request(KB_CARRIER, secret, KB_NAME);
      expect(guardRequest(req)).toBe(true);
      expect(() => admitMeriReadObservation(KB_NAME, KB_BODY, req)).toThrow(ForbiddenException);
    }
    const wrongRoute = request(KB_CARRIER, SECRET, NAME);
    expect(guardRequest(wrongRoute)).toBe(true);
    expect(() => admitMeriReadObservation(NAME, KB_BODY, wrongRoute)).toThrow(BadRequestException);
    const legacy = request(undefined, 'wrong', KB_NAME);
    expect(guardRequest(legacy)).toBe(true);
    expect(admitMeriReadObservation(KB_NAME, KB_BODY, legacy)).toBeUndefined();
  });

  it('keeps funding and KB anchors isolated even when nested', () => {
    withMeriReadObservation({ operationId: KB_NAME, asOf: AS_OF }, () => {
      expect(() => currentMeriFundingReadAsOf(NAME)).toThrow(ForbiddenException);
      expect(withMeriFundingReadObservation({ operationId: NAME, asOf: AS_OF }, () =>
        currentMeriFundingReadAsOf(NAME)?.toISOString(),
      )).toBe(AS_OF);
      expect(currentMeriReadAsOf(KB_NAME)).toBe(AS_OF);
    });
  });
});

type ModeVector = { operation: { id: string; version: string }; request: Record<string, unknown>; context: { evidenceAccuracyMode: 'off'|'shadow'|'enforce' }; requestCanonicalJson: string; requestSha256: string; canonicalJson: string; decodedBytes: number; observationSha256: string; carrier: string };
const MODE_VECTORS = (JSON.parse(readFileSync(join(__dirname, '../../../../docs/coordination/proposals/native-read-mode-20261017/golden.json'), 'utf8')) as {vectors: ModeVector[]}).vectors;
function modeCarrier(vector: ModeVector, context: Record<string, unknown>) {
  const value = JSON.parse(vector.canonicalJson);
  value.context = Object.fromEntries(Object.entries(context).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}
describe('finite current-mode read observation', () => {
  const originalEnv = process.env;
  const tenantId = '11111111-1111-4111-8111-111111111111';
  beforeEach(() => { process.env = { ...originalEnv, MERI_EVIDENCE_ACCURACY_TENANTS: tenantId, MERI_EVIDENCE_ACCURACY_SURFACES: 'chat' }; });
  afterEach(() => { process.env = originalEnv; });

  it('admits the exact independent Meri literal vectors and canonical raw-body hashes for all five arms', () => {
    expect(MODE_VECTORS.map(v => v.operation.id)).toEqual(modeOnlyReads);
    for (const vector of MODE_VECTORS) {
      expect(createHash('sha256').update(vector.requestCanonicalJson, 'utf8').digest('hex')).toBe(vector.requestSha256);
      const decoded = Buffer.from(vector.carrier, 'base64url');
      expect(decoded.toString('utf8')).toBe(vector.canonicalJson); expect(decoded.byteLength).toBe(vector.decodedBytes);
      expect(createHash('sha256').update(decoded).digest('hex')).toBe(vector.observationSha256);
      const req = request(vector.carrier, SECRET, vector.operation.id); guardRequest(req);
      expect(admitMeriReadObservation(vector.operation.id, vector.request, req)).toEqual({ operationId: vector.operation.id, evidenceAccuracyMode: vector.context.evidenceAccuracyMode });
      expect(() => admitMeriFundingReadObservation(vector.operation.id, vector.request, req)).toThrow(BadRequestException);
    }
  });

  it.each(modeOnlyReads)('compares and consumes all three actual enums for %s', name => {
    const vector = MODE_VECTORS.find(v => v.operation.id === name)!;
    for (const mode of ['off', 'shadow', 'enforce'] as const) {
      process.env.MERI_EVIDENCE_ACCURACY_MODE = mode;
      const req = request(modeCarrier(vector, {evidenceAccuracyMode: mode}), SECRET, name); guardRequest(req);
      const observation = admitMeriReadObservation(name, vector.request, req)!;
      expect(withMeriReadObservation(observation, () => currentMeriEvidenceAccuracyMode(name, tenantId))).toBe(mode);
    }
    expect(currentMeriEvidenceAccuracyMode(name, tenantId)).toBeUndefined();
  });

  it('refuses wrong contexts, operation/version/body and genuine-service absence before producer work', () => {
    const vector = MODE_VECTORS[0]!;
    for (const context of [{}, {asOf: AS_OF}, {evidenceAccuracyMode: 'OFF'}, {evidenceAccuracyMode: null}, {evidenceAccuracyMode: 1}, {evidenceAccuracyMode: 'off', rolloutRevision: 'a'.repeat(64)}, {asOf: AS_OF, evidenceAccuracyMode: 'off'}]) {
      const req = request(modeCarrier(vector, context), SECRET, vector.operation.id); guardRequest(req);
      expect(() => admitMeriReadObservation(vector.operation.id, vector.request, req)).toThrow(BadRequestException);
    }
    const req = request(vector.carrier, SECRET, vector.operation.id); guardRequest(req);
    expect(() => admitMeriReadObservation(vector.operation.id, {...vector.request, query: 'changed'}, req)).toThrow(BadRequestException);
    expect(() => admitMeriReadObservation('search_federal_awards', vector.request, req)).toThrow(BadRequestException);
    const unverified = request(vector.carrier, 'wrong', vector.operation.id); guardRequest(unverified);
    expect(() => admitMeriReadObservation(vector.operation.id, vector.request, unverified)).toThrow(ForbiddenException);
  });

  it('refuses policy and operation mismatch, preserving funding/KB isolation', () => {
    process.env.MERI_EVIDENCE_ACCURACY_MODE = 'off';
    expect(() => withMeriReadObservation({operationId: 'search_federal_grants', evidenceAccuracyMode: 'shadow'}, () => currentMeriEvidenceAccuracyMode('search_federal_grants', tenantId))).toThrow('Current read mode changed');
    withMeriReadObservation({operationId: 'search_federal_grants', evidenceAccuracyMode: 'off'}, () => {
      expect(() => currentMeriEvidenceAccuracyMode('search_federal_awards', tenantId)).toThrow(ForbiddenException);
      expect(() => currentMeriReadAsOf(KB_NAME)).toThrow(ForbiddenException);
      expect(withMeriReadObservation({operationId: KB_NAME, asOf: AS_OF}, () => currentMeriReadAsOf(KB_NAME))).toBe(AS_OF);
    });
    // Configuration history adds no semantics when the actual consumed enum is again identical.
    process.env.MERI_EVIDENCE_ACCURACY_MODE = 'shadow'; process.env.MERI_EVIDENCE_ACCURACY_MODE = 'off';
    expect(withMeriReadObservation({operationId: 'search_federal_grants', evidenceAccuracyMode: 'off'}, () => currentMeriEvidenceAccuracyMode('search_federal_grants', tenantId))).toBe('off');
  });

  it('keeps concurrent mode contexts request-local across asynchronous boundaries', async () => {
    process.env.MERI_EVIDENCE_ACCURACY_MODE = 'off';
    await Promise.all(modeOnlyReads.map(operationId => withMeriReadObservation({operationId, evidenceAccuracyMode: 'off'}, async () => {
      await Promise.resolve(); expect(currentMeriEvidenceAccuracyMode(operationId, tenantId)).toBe('off');
    })));
  });
});
