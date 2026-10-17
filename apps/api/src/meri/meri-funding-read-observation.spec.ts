import { describe, expect, it } from '@jest/globals';
import { BadRequestException, ForbiddenException, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import { ToolServiceSecretGuard } from './tool-service-secret.guard.js';
import {
  admitMeriFundingReadObservation,
  currentMeriFundingReadAsOf,
  withMeriFundingReadObservation,
} from './meri-funding-read-observation.js';

// neo-capiro/meri-greenfield@b4daa4a, native-read-observation-0.2/golden.json,
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
const malformedCases: [string, string, Record<string, unknown>, string][] = [
  ['changed original request', NAME, { ...BODY, query: BODY.query.trim() }, GOLDEN_CARRIER],
  ['other route', 'get_funding_opportunity', BODY, GOLDEN_CARRIER],
  ['unlisted route', 'explain_opportunity_match', BODY, GOLDEN_CARRIER],
  ['padding', NAME, BODY, `${GOLDEN_CARRIER}=`],
  ['invalid alphabet', NAME, BODY, `${GOLDEN_CARRIER}*`],
];

function request(header?: unknown, serviceSecret?: unknown): Request {
  return {
    headers: {
      ...(header === undefined ? {} : { 'x-meri-read-observation': header }),
      ...(serviceSecret === undefined ? {} : { 'x-internal-service-secret': serviceSecret }),
    },
    method: 'POST',
    path: `/api/clio/tools/${NAME}`,
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
