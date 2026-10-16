import { describe, expect, it, jest } from '@jest/globals';
import { createHash } from 'node:crypto';
import {
  parseRetainedReadBody, CoreRetainedReadRequestInvalidError, CoreRetainedReadRequestUnavailableError,
  type CoreRetainedReadCanonicalizer,
} from './core-retained-read-request.js';

const conversationId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const portfolioId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const operation = 'get_research_portfolio';
function body(): any {
  return { schemaVersion: 1, request: {}, context: {
    binding: { tenantId: 'native-tenant', actorId: 'native-actor', conversationId,
      runId: conversationId, attemptId: conversationId, workerId: conversationId, writerFence: 1 },
    subject: { kind: 'entity', entityType: 'research-portfolio', entityIds: [portfolioId], tenantId: 'native-tenant',
      actorId: 'native-actor', authorizationDecisionId: conversationId, policyRevision: 'policy',
      scopes: [{ tenantId: 'native-tenant', kind: 'public', resourceId: 'public', policyRevision: 'policy' }], rosterVersionId: null },
  } };
}

describe('framework-independent retained request boundary', () => {
  it('exports typed400 admission errors before calling the encoder', () => {
    const provider = jest.fn((_value: unknown): string => { throw new Error('must not run'); });
    expect(() => parseRetainedReadBody(operation, {}, { issuer: false }, provider)).toThrow(CoreRetainedReadRequestInvalidError);
    expect(new CoreRetainedReadRequestInvalidError().status).toBe(400);
    expect(provider).not.toHaveBeenCalled();
  });

  it('exports typed503 for schema-valid unavailable Core resource selectors', () => {
    const input = body(); input.context.subject.entityIds = ['native-name'];
    const provider = jest.fn((_value: unknown): string => { throw new Error('must not run'); });
    expect(() => parseRetainedReadBody(operation, input, { issuer: false }, provider)).toThrow(CoreRetainedReadRequestUnavailableError);
    expect(new CoreRetainedReadRequestUnavailableError().status).toBe(503);
    expect(provider).not.toHaveBeenCalled();
  });

  it.each(['', '{}', 'not-json', '"\ud800"', '{"wrong":"value"}'])('refuses detached/malformed encoder output %j as unavailable', text => {
    expect(() => parseRetainedReadBody(operation, body(), { issuer: false }, () => text)).toThrow(CoreRetainedReadRequestUnavailableError);
  });

  it('refuses a throwing encoder and does not hash a fallback representation', () => {
    expect(() => parseRetainedReadBody(operation, body(), { issuer: false }, () => { throw new Error('provider failed'); }))
      .toThrow(CoreRetainedReadRequestUnavailableError);
  });

  it.each(['portfolioId', '\\u0070ortfolioId'])('rejects duplicate or escaped-alias JSON keys from a misconfigured encoder: %s', duplicate => {
    const provider: CoreRetainedReadCanonicalizer = value => {
      if (value && typeof value === 'object' && Object.hasOwn(value, 'portfolioId')) {
        return `{"conversationId":"${conversationId}","portfolioId":"${portfolioId}","${duplicate}":"${portfolioId}"}`;
      }
      return JSON.stringify(value);
    };
    expect(() => parseRetainedReadBody(operation, body(), { issuer: false }, provider)).toThrow(CoreRetainedReadRequestUnavailableError);
  });

  it('checks JSON values independently of key order/prototype while hashing only injected bytes', () => {
    // Deliberately non-JCS value-preserving test double: this establishes the
    // consistency guard/exact-byte use, never RFC8785 provider qualification.
    const outputs: string[] = [];
    const provider: CoreRetainedReadCanonicalizer = value => {
      const text = '\n' + JSON.stringify(value) + '\n'; outputs.push(text); return text;
    };
    const result = parseRetainedReadBody(operation, body(), { issuer: false }, provider);
    expect(result.digests).toEqual({
      rawRequestSha256: createHash('sha256').update(outputs[0]!).digest('hex'),
      normalizedArgsSha256: createHash('sha256').update(outputs[1]!).digest('hex'),
      normalizationContextSha256: createHash('sha256').update(outputs[2]!).digest('hex'),
    });
    expect(Object.isFrozen(result.context)).toBe(true);
    expect(Object.isFrozen(result.normalizedArgs)).toBe(true);
  });

  it('rejects raw non-I-JSON Unicode before the trusted encoder', () => {
    const input = body(); input.context.subject.scopes[0].resourceId = '\ud800';
    const provider = jest.fn((_value: unknown): string => { throw new Error('must not run'); });
    expect(() => parseRetainedReadBody(operation, input, { issuer: false }, provider)).toThrow(CoreRetainedReadRequestInvalidError);
    expect(provider).not.toHaveBeenCalled();
  });
});
