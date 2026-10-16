import { createHash } from 'node:crypto';
import { parseRetainedReadBody } from './retained-read-request.js';
import type { RetainedReadOperation } from './retained-read-authority.js';

const portfolioId = '11111111-1111-4111-8111-111111111111';
const conversationId = '22222222-2222-4222-8222-222222222222';
const clientId = 'abcdefab-cdef-4abc-8def-abcdefabcdef';
const folderId = '44444444-4444-4444-8444-444444444444';
const DETAIL = 'get_research_portfolio';
const CHANGES = 'get_research_portfolio_changes';
const FLORIDA = 'get_florida_budget_project';

function portfolioBody(): any {
  return { schemaVersion: 1, request: {}, context: {
    binding: { tenantId: 'claimed-tenant', actorId: 'claimed-actor', conversationId,
      runId: conversationId, attemptId: conversationId, workerId: conversationId, writerFence: 1 },
    subject: { kind: 'entity', entityType: 'research-portfolio', entityIds: [portfolioId],
      tenantId: 'claimed-tenant', actorId: 'claimed-actor', authorizationDecisionId: conversationId,
      policyRevision: 'policy-1', scopes: [{ tenantId: 'claimed-tenant', kind: 'public',
        resourceId: 'claimed-public-scope', policyRevision: 'policy-1' }], rosterVersionId: null },
  } };
}
function floridaBody(): any {
  return { schemaVersion: 1, request: {}, context: { asOf: '2026-10-16T00:00:00.000Z',
    effectiveScope: { jurisdiction: 'FL', sessionKey: '', folderId: null, clientId: null }, clientResolution: null } };
}
// Value-preserving JSON test double, not JCS qualification. Deliberate whitespace
// proves digests use the exact injected bytes instead of a local serialization.
function canonicalizer() {
  return jest.fn((value: unknown) => '\n' + JSON.stringify(value) + '\n');
}
function parse(operation: RetainedReadOperation, body: unknown, issuer = false) {
  return parseRetainedReadBody(operation, body, { issuer }, canonicalizer());
}
function refusal(operation: RetainedReadOperation, body: unknown, status = 400, issuer = false) {
  let error: any;
  try { parse(operation, body, issuer); } catch (value) { error = value; }
  expect(error?.getStatus()).toBe(status);
}

describe('closed retained request admission and frozen normalization', () => {
  it('binds RP Detail to the claimed native conversation without a legacy lookup', () => {
    const body = portfolioBody();
    const value = parse(DETAIL, body);
    expect(value.normalizedArgs).toEqual({ conversationId, portfolioId });
    expect(value.selector).toEqual({ schemaVersion: 1, portfolioId });
    expect(Object.keys(value).sort()).toEqual(['context', 'digests', 'normalizedArgs', 'request', 'selector']);
    expect(value.context).toEqual(body.context);
    expect(Object.isFrozen(value)).toBe(true);
    expect(Object.isFrozen(value.context)).toBe(true);
    expect(Object.isFrozen((value.context.subject as any).scopes[0])).toBe(true);
    body.context.binding.writerFence = 99;
    expect((value.context.binding as any).writerFence).toBe(1);
  });

  it('uses the injected canonical owner exactly on parsed raw request, normalized args and context', () => {
    const body = portfolioBody(); body.request = { cursor: '  retained-event  ' };
    const canonicalize = canonicalizer();
    const value = parseRetainedReadBody(CHANGES, body, { issuer: false }, canonicalize);
    expect(canonicalize.mock.calls.map(([input]) => input)).toEqual([value.request, value.normalizedArgs, value.context]);
    expect(value.request).toEqual({ cursor: '  retained-event  ' });
    expect(value.normalizedArgs).toEqual({ conversationId, portfolioId, cursor: 'retained-event', limit: 25 });
    const expected = canonicalize.mock.results.map(result => createHash('sha256').update(result.value).digest('hex'));
    expect(value.digests).toEqual({ rawRequestSha256: expected[0], normalizedArgsSha256: expected[1], normalizationContextSha256: expected[2] });
  });

  it.each([{}, { cursor: null }, { cursor: '' }, { cursor: '   ' }])('preserves RP raw null/omission while normalizing cursor: %j', request => {
    const body = portfolioBody(); body.request = request;
    expect(parse(CHANGES, body).normalizedArgs).toEqual({ conversationId, portfolioId, cursor: null, limit: 25 });
  });

  it('admits exact explicit RP conversation and limit boundaries', () => {
    for (const limit of [1, 100]) {
      const body = portfolioBody(); body.request = { conversationId, cursor: 'x'.repeat(2048), limit };
      expect(parse(CHANGES, body).normalizedArgs.limit).toBe(limit);
    }
  });

  it.each([
    { schemaVersion: 2 }, { schemaVersion: '1' }, { extra: true },
    { originalExpiresAtMs: 1 }, { request: null }, { context: null },
  ])('rejects unsupported data-envelope shape %j', patch => refusal(DETAIL, { ...portfolioBody(), ...patch }));

  it('requires issuer expiry as an exact positive safe integer without renewing it', () => {
    const body = { ...portfolioBody(), originalExpiresAtMs: 1234 };
    expect(parse(DETAIL, body, true).originalExpiresAtMs).toBe(1234);
    for (const value of [null, 0, -1, 1.1, Number.MAX_SAFE_INTEGER + 1]) {
      refusal(DETAIL, { ...body, originalExpiresAtMs: value }, 400, true);
    }
    refusal(DETAIL, portfolioBody(), 400, true);
  });

  it.each([
    { cursor: null }, { limit: 25 }, { tenantId: 'claimed-tenant' }, { portfolioId },
    { conversationId: null }, { conversationId: clientId },
  ])('rejects Detail request additions/substitution %j', request => {
    const body = portfolioBody(); body.request = request; refusal(DETAIL, body);
  });

  it.each([{ limit: null }, { limit: 0 }, { limit: 101 }, { limit: 1.5 }, { cursor: 'x'.repeat(2049) }])('enforces Changes input schema %j', request => {
    const body = portfolioBody(); body.request = request; refusal(CHANGES, body);
  });

  it.each([
    { label: 'unknown context', mutate: (body: any) => { body.context.current = true; } },
    { label: 'unknown binding', mutate: (body: any) => { body.context.binding.role = 'owner'; } },
    { label: 'binding UUID', mutate: (body: any) => { body.context.binding.runId = 'not-a-uuid'; } },
    { label: 'binding bound', mutate: (body: any) => { body.context.binding.actorId = 'x'.repeat(129); } },
    { label: 'zero fence', mutate: (body: any) => { body.context.binding.writerFence = 0; } },
    { label: 'foreign actor', mutate: (body: any) => { body.context.subject.actorId = 'different'; } },
    { label: 'foreign tenant', mutate: (body: any) => { body.context.subject.tenantId = 'different'; } },
    { label: 'portfolio kind', mutate: (body: any) => { body.context.subject.kind = 'portfolio'; } },
    { label: 'entity type', mutate: (body: any) => { body.context.subject.entityType = 'client'; } },
    { label: 'multiple entities', mutate: (body: any) => { body.context.subject.entityIds.push(clientId); } },
    { label: 'roster claim', mutate: (body: any) => { body.context.subject.rosterVersionId = 'roster'; } },
    { label: 'scope tenant', mutate: (body: any) => { body.context.subject.scopes[0].tenantId = 'different'; } },
    { label: 'scope policy', mutate: (body: any) => { body.context.subject.scopes[0].policyRevision = 'different'; } },
    { label: 'scope kind', mutate: (body: any) => { body.context.subject.scopes[0].kind = 'role'; } },
    { label: 'scope bound', mutate: (body: any) => { body.context.subject.scopes[0].resourceId = 'x'.repeat(257); } },
    { label: 'empty scopes', mutate: (body: any) => { body.context.subject.scopes = []; } },
    { label: 'duplicate scopes', mutate: (body: any) => { body.context.subject.scopes.push({ ...body.context.subject.scopes[0] }); } },
  ])('rejects RP closed-shape/correlation failure: $label', ({ mutate }) => {
    const body = portfolioBody(); mutate(body); refusal(DETAIL, body);
  });

  it('refuses a valid native entity selector that is unavailable as a canonical Core portfolio ID', () => {
    const body = portfolioBody(); body.context.subject.entityIds = ['native-name']; refusal(DETAIL, body, 503);
    body.context.subject.entityIds = ['AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA']; refusal(DETAIL, body, 503);
  });

  it('normalizes Florida exact defaults and explicit nulls with an empty session key', () => {
    const body = floridaBody();
    body.request = { q: null, fiscalYear: null, projectId: null, sessionKey: null, folderId: null, clientId: null, offset: null };
    const value = parse(FLORIDA, body);
    expect(value.request).toEqual(body.request);
    expect(value.normalizedArgs).toEqual({ q: '', fiscalYear: '2026-27', projectId: '', offset: 0,
      sessionKey: '', folderId: null, clientId: null });
    expect(value.selector).toEqual({ schemaVersion: 1, sessionKey: '', folderId: null, clientSelector: null });
  });

  it('preserves exact session bytes, truncates q at200 and resolves a trimmed non-UUID client name', () => {
    const body = floridaBody(); const name = 'Client name'; const sessionKey = '  current session  ';
    body.request = { q: 'x'.repeat(201), clientId: `  ${name}  `, sessionKey, folderId, offset: '0x10' };
    body.context.effectiveScope = { jurisdiction: 'FL', sessionKey, folderId, clientId };
    body.context.clientResolution = { selector: name, clientId };
    const value = parse(FLORIDA, body);
    expect(value.normalizedArgs).toEqual({ q: 'x'.repeat(200), fiscalYear: '2026-27', projectId: '',
      offset: 16, sessionKey, folderId, clientId });
    expect(value.selector).toEqual({ schemaVersion: 1, sessionKey, folderId, clientSelector: name });
    expect((value.context.clientResolution as any).selector).toBe(name);
  });

  it('applies the frozen client selector80 bound and allows current folder-derived scope', () => {
    const body = floridaBody(); const selector = 'n'.repeat(80);
    body.request = { clientId: ` ${selector}extra ` };
    body.context.clientResolution = { selector, clientId };
    body.context.effectiveScope.clientId = clientId;
    expect((parse(FLORIDA, body).selector as any).clientSelector).toBe(selector);
    body.request = { folderId }; body.context.clientResolution = null;
    body.context.effectiveScope.folderId = folderId;
    expect(parse(FLORIDA, body).normalizedArgs.clientId).toBeNull();
  });

  it.each([
    { raw: '-1', normalized: 0 }, { raw: 'not-a-number', normalized: 0 },
    { raw: '', normalized: 0 }, { raw: '1e3', normalized: 1000 }, { raw: 10000, normalized: 10000 },
  ])('uses frozen Number/default offset conversion for $raw', ({ raw, normalized }) => {
    const body = floridaBody(); body.request = { offset: raw };
    expect(parse(FLORIDA, body).normalizedArgs.offset).toBe(normalized);
  });

  it.each([
    { label: 'unknown raw key', mutate: (body: any) => { body.request.jurisdiction = 'FL'; } },
    { label: 'raw type', mutate: (body: any) => { body.request.clientId = 5; } },
    { label: 'raw offset type', mutate: (body: any) => { body.request.offset = true; } },
    { label: 'offset fraction', mutate: (body: any) => { body.request.offset = '1.5'; } },
    { label: 'offset overflow', mutate: (body: any) => { body.request.offset = 10001; } },
    { label: 'offset infinity', mutate: (body: any) => { body.request.offset = 'Infinity'; } },
    { label: 'fiscal year', mutate: (body: any) => { body.request.fiscalYear = ''; } },
    { label: 'folder bound', mutate: (body: any) => { body.request.folderId = 'x'.repeat(101); } },
    { label: 'session bound', mutate: (body: any) => { body.request.sessionKey = 'x'.repeat(257); } },
    { label: 'unknown context', mutate: (body: any) => { body.context.binding = {}; } },
    { label: 'noncanonical clock', mutate: (body: any) => { body.context.asOf = '2026-10-16T00:00:00Z'; } },
    { label: 'invalid clock', mutate: (body: any) => { body.context.asOf = '2026-02-31T00:00:00.000Z'; } },
    { label: 'missing null', mutate: (body: any) => { delete body.context.clientResolution; } },
    { label: 'foreign jurisdiction', mutate: (body: any) => { body.context.effectiveScope.jurisdiction = 'NY'; } },
    { label: 'session substitution', mutate: (body: any) => { body.context.effectiveScope.sessionKey = 'different'; } },
    { label: 'folder substitution', mutate: (body: any) => { body.context.effectiveScope.folderId = folderId; } },
    { label: 'unselected client', mutate: (body: any) => { body.context.effectiveScope.clientId = clientId; } },
    { label: 'resolution without selector', mutate: (body: any) => { body.context.clientResolution = { selector: 'name', clientId }; } },
    { label: 'selector without resolution', mutate: (body: any) => { body.request.clientId = 'name'; } },
  ])('rejects Florida shape/correlation failure: $label', ({ mutate }) => {
    const body = floridaBody(); mutate(body); refusal(FLORIDA, body);
  });

  it('correlates UUID selectors case-insensitively but never substitutes actual client identity', () => {
    const body = floridaBody(); body.request.clientId = clientId.toUpperCase();
    body.context.clientResolution = { selector: clientId.toUpperCase(), clientId };
    body.context.effectiveScope.clientId = clientId;
    expect(parse(FLORIDA, body).normalizedArgs.clientId).toBe(clientId);
    body.context.clientResolution.clientId = portfolioId; refusal(FLORIDA, body);
  });

  it('retains empty and maximum session bytes and refuses unsupported native folder names as unavailable', () => {
    const body = floridaBody(); body.request.sessionKey = ' '.repeat(256);
    body.context.effectiveScope.sessionKey = body.request.sessionKey;
    expect(parse(FLORIDA, body).normalizedArgs.sessionKey).toBe(body.request.sessionKey);
    body.request.folderId = 'native-folder-name'; body.context.effectiveScope.folderId = body.request.folderId;
    refusal(FLORIDA, body, 503);
  });
});

describe('inert bounded retained body boundary', () => {
  it('rejects accessors, proxies, symbols and toJSON without invoking caller code', () => {
    const effect = jest.fn(() => { throw new Error('must not run'); });
    const getter = portfolioBody(); Object.defineProperty(getter.request, 'conversationId', { enumerable: true, get: effect });
    const proxy = new Proxy(portfolioBody(), { get: effect, getPrototypeOf: effect, ownKeys: effect });
    const symbol = portfolioBody(); symbol.context[Symbol('hidden')] = true;
    const json = portfolioBody(); json.context.toJSON = effect;
    for (const body of [getter, proxy, symbol, json]) refusal(DETAIL, body);
    expect(effect).not.toHaveBeenCalled();
  });

  it('rejects exotic, sparse, cyclic and undefined data before canonicalization', () => {
    const date = portfolioBody(); date.request.conversationId = new Date();
    const sparse = portfolioBody(); sparse.context.subject.scopes = new Array(1);
    const cycle = portfolioBody(); cycle.request.self = cycle;
    const undefinedValue = portfolioBody(); undefinedValue.request.conversationId = undefined;
    for (const body of [date, sparse, cycle, undefinedValue]) refusal(DETAIL, body);
  });

  it('enforces total UTF-8/escaped body size and array work bounds before hashing', () => {
    const body = floridaBody(); const canonicalize = canonicalizer();
    body.request.q = 'x'.repeat(2 * 1024 * 1024 + 1);
    expect(() => parseRetainedReadBody(FLORIDA, body, { issuer: false }, canonicalize)).toThrow();
    body.request.q = '\u0000'.repeat(350000);
    expect(() => parseRetainedReadBody(FLORIDA, body, { issuer: false }, canonicalize)).toThrow();
    const portfolio = portfolioBody(); portfolio.context.subject.scopes = new Array(4097).fill(portfolio.context.subject.scopes[0]);
    expect(() => parseRetainedReadBody(DETAIL, portfolio, { issuer: false }, canonicalize)).toThrow();
    expect(canonicalize).not.toHaveBeenCalled();
  });

  it('refuses a failed or detached canonicalizer as unavailable without local JSON hashing', () => {
    for (const canonicalize of [() => { throw new Error('missing trusted encoder'); }, () => undefined, () => 'x'.repeat(2 * 1024 * 1024 + 1)]) {
      let error: any;
      try { parseRetainedReadBody(DETAIL, portfolioBody(), { issuer: false }, canonicalize as (value: unknown) => string); }
      catch (value) { error = value; }
      expect(error?.getStatus()).toBe(503);
    }
  });
});
