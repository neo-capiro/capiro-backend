import { afterEach, describe, expect, it } from '@jest/globals';
import { createHash } from 'node:crypto';
import { BadRequestException, ForbiddenException, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import { canonicalizeCoreRetainedJson } from '@capiro/shared/core-retained-jcs';
import type { MeriReadDelegationGrant } from '../auth/read-delegation/read-delegation-request.js';
import { ToolServiceSecretGuard } from './tool-service-secret.guard.js';
import {
  admitMeriReadObservation, currentMeriCertificationComparisonLocale,
  currentMeriRuleStatusClocks, currentMeriSamProducerContext, withMeriReadObservation,
} from './meri-funding-read-observation.js';

const tenantId = '11111111-1111-4111-8111-111111111111';
const userId = '22222222-2222-4222-8222-222222222222';
const secret = 'second-package-observation-test-secret';
const asOf = '2026-10-19T00:00:00.000Z';
const later = '2026-10-19T01:00:00.000Z';
const bodyFor = {
  get_certification_status: { program: 'fedramp', query: 'I' },
  get_state_rule_status: { query: 'FL-31100933' },
  search_sam_opportunities: { query: 'radar', limit: 3 },
};
type Operation = keyof typeof bodyFor;
const contexts = {
  get_certification_status: { comparisonLocale: 'tr-TR' },
  get_state_rule_status: { stageAsOf: asOf, commentAsOf: later },
  search_sam_opportunities: {
    asOf, sourceStatusAsOf: later, sourceHealthAsOf: asOf,
    evidenceAccuracyMode: 'off',
  },
} as const;

function carrier(name: Operation, context: Record<string, unknown> = contexts[name],
  body: Record<string, unknown> = bodyFor[name], version = '0.2.0') {
  const requestSha256 = createHash('sha256').update(canonicalizeCoreRetainedJson(body), 'utf8').digest('hex');
  return Buffer.from(canonicalizeCoreRetainedJson({
    schemaVersion: 'meri-native-read-observation/1',
    operation: { id: name, version }, requestSha256, context,
  }), 'utf8').toString('base64url');
}

function request(name: Operation, header: string | null = carrier(name),
  provided = secret): Request {
  const path = `/api/clio/tools/${name}`;
  return {
    method: 'POST', path, originalUrl: path, url: path,
    headers: {
      authorization: 'CapiroMeriRead signed-token',
      'x-internal-service-secret': provided,
      ...(header === null ? {} : { 'x-meri-read-observation': header }),
    },
  } as unknown as Request;
}

function verifyService(req: Request, expected = secret) {
  const guard = new ToolServiceSecretGuard({
    get: (key: string) => key === 'INTERNAL_SERVICE_SECRET' ? expected :
      key === 'NODE_ENV' ? 'production' : undefined,
  } as never);
  return guard.canActivate({ switchToHttp: () => ({ getRequest: () => req }) } as unknown as ExecutionContext);
}

function grant(name: Operation): MeriReadDelegationGrant {
  return {
    kind: 'tool', operation: { id: name, version: '0.2.0' },
    tenantId, actorId: userId,
    bodySha256: 'a'.repeat(64), argumentsSha256: 'b'.repeat(64),
  } as MeriReadDelegationGrant;
}

function admit(name: Operation, req = request(name), body: Record<string, unknown> = bodyFor[name],
  target = grant(name)) {
  verifyService(req);
  return admitMeriReadObservation(name, body, req, { tenantId, userId }, target);
}

const previousEnv = process.env;
afterEach(() => { process.env = previousEnv; });

describe('second-package Core producer observations', () => {
  it('admits three distinct closed contexts with exact operation, version, original request and delegated target', () => {
    for (const name of Object.keys(bodyFor) as Operation[]) {
      expect(admit(name)).toEqual({ operationId: name, ...contexts[name] });
    }
  });

  it('requires a verified service identity AND the admitted run-bound target', () => {
    const name = 'get_certification_status';
    const req = request(name);
    expect(() => admitMeriReadObservation(name, bodyFor[name], req,
      { tenantId, userId }, grant(name))).toThrow(ForbiddenException);
    verifyService(req);
    expect(() => admitMeriReadObservation(name, bodyFor[name], req)).toThrow(ForbiddenException);
    expect(() => admitMeriReadObservation(name, bodyFor[name], req,
      { tenantId: 'another', userId }, grant(name))).toThrow(ForbiddenException);
    expect(() => admitMeriReadObservation(name, bodyFor[name], req,
      { tenantId, userId: 'another' }, grant(name))).toThrow(ForbiddenException);
    expect(() => admitMeriReadObservation(name, bodyFor[name], req,
      { tenantId, userId }, { ...grant(name), operation: { id: name, version: '0.2.1' } })).toThrow(ForbiddenException);
    req.originalUrl += '?scope=all';
    expect(() => admitMeriReadObservation(name, bodyFor[name], req,
      { tenantId, userId }, grant(name))).toThrow(ForbiddenException);
  });

  it('refuses changed original body, operation and version before producer work', () => {
    const name = 'get_state_rule_status';
    expect(() => admit(name, request(name), { query: 'changed' })).toThrow(BadRequestException);
    expect(() => admit(name, request(name, carrier(name, contexts[name], bodyFor[name], '0.2.1'))))
      .toThrow(BadRequestException);
    const req = request(name, carrier('get_certification_status'));
    expect(() => admit(name, req)).toThrow(BadRequestException);
  });

  it.each([
    ['certification extra field', 'get_certification_status', { comparisonLocale: 'tr-TR', source: 'model' }],
    ['noncanonical locale', 'get_certification_status', { comparisonLocale: 'en-us' }],
    ['unsupported locale', 'get_certification_status', { comparisonLocale: 'zz-ZZ' }],
    ['rule missing clock', 'get_state_rule_status', { stageAsOf: asOf }],
    ['rule noncanonical time', 'get_state_rule_status', { stageAsOf: asOf, commentAsOf: '2026-10-19T01:00:00Z' }],
    ['SAM missing source health', 'search_sam_opportunities', { asOf, sourceStatusAsOf: later, evidenceAccuracyMode: 'off' }],
    ['SAM extra field', 'search_sam_opportunities', { ...contexts.search_sam_opportunities, clientId: tenantId }],
    ['SAM bad mode', 'search_sam_opportunities', { ...contexts.search_sam_opportunities, evidenceAccuracyMode: 'audit' }],
  ] as Array<[string, Operation, Record<string, unknown>]>)('rejects %s', (_label, name, context) => {
    expect(() => admit(name, request(name, carrier(name, context)))).toThrow(BadRequestException);
  });

  it('keeps each calculation anchor operation-specific and request-local', async () => {
    const certification = admit('get_certification_status')!;
    const rule = admit('get_state_rule_status')!;
    const values = await Promise.all([
      withMeriReadObservation(certification, async () => {
        await Promise.resolve();
        expect(() => currentMeriRuleStatusClocks()).toThrow(ForbiddenException);
        return currentMeriCertificationComparisonLocale();
      }),
      withMeriReadObservation(rule, async () => {
        await Promise.resolve();
        expect(() => currentMeriCertificationComparisonLocale()).toThrow(ForbiddenException);
        return currentMeriRuleStatusClocks();
      }),
    ]);
    expect(values).toEqual(['tr-TR', { stageAsOf: asOf, commentAsOf: later }]);
    expect(currentMeriCertificationComparisonLocale()).toBeUndefined();
  });

  it('compares observed SAM mode with current Core policy instead of letting the carrier select it', () => {
    process.env = { ...previousEnv, MERI_EVIDENCE_ACCURACY_MODE: 'off',
      MERI_EVIDENCE_ACCURACY_TENANTS: 'all', MERI_EVIDENCE_ACCURACY_SURFACES: 'chat' };
    const observed = admit('search_sam_opportunities')!;
    withMeriReadObservation(observed, () => {
      expect(currentMeriSamProducerContext(tenantId)).toEqual(contexts.search_sam_opportunities);
      process.env.MERI_EVIDENCE_ACCURACY_MODE = 'enforce';
      expect(() => currentMeriSamProducerContext(tenantId)).toThrow(ForbiddenException);
    });
  });

  it('leaves legacy no-header calls without a producer context', () => {
    const req = request('get_certification_status', null);
    verifyService(req);
    expect(admitMeriReadObservation('get_certification_status', bodyFor.get_certification_status,
      req, { tenantId, userId }, grant('get_certification_status'))).toBeUndefined();
    expect(currentMeriRuleStatusClocks()).toBeUndefined();
  });
});
