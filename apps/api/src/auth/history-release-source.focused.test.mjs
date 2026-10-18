import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';

async function moduleUrl(path, replacements = {}) {
  let source = await readFile(new URL(path, import.meta.url), 'utf8');
  for (const [from, to] of Object.entries(replacements)) source = source.replaceAll(`from '${from}'`, `from '${to}'`);
  return `data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(source)).toString('base64')}`;
}
const jcsUrl = await moduleUrl('../../../../packages/shared/src/core-retained-jcs.ts');
const sourceUrl = await moduleUrl('./history-release-source.ts', { '@capiro/shared/core-retained-jcs': jcsUrl });
const {
  HISTORY_RELEASE_MAX_SUBJECTS, HISTORY_RELEASE_RECEIPT_TTL_MS,
  HistoryReleaseSourceError, parseHistoryReleaseRequest, historyReleaseSubjectsSha256,
  readHistoryReleaseSource, buildHistoryReleaseReceipt,
} = await import(sourceUrl);

const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const principal = { tenantId: id(1), actorId: id(9) };
const scope = (clientId = id(3)) => ({ tenantId: principal.tenantId, kind: 'client', resourceId: clientId,
  policyRevision: 'pinned-policy' });
const subject = (n = 2) => ({ conversationId: id(n), clientId: id(3), scopes: [scope()] });
const body = (subjects = [subject()], route = 'list') => ({ schemaVersion: 1, observationId: id(10), route,
  responseSha256: 'a'.repeat(64), subjects });
const sha = value => createHash('sha256').update(value, 'utf8').digest('hex');
const now = 1_000_000;
const denied = code => error => error instanceof HistoryReleaseSourceError && error.code === code;
const decision = (request, expectedPrincipal, subjectsSha256) => ({ authorized: true,
  observationId: request.observationId, route: request.route, principal: expectedPrincipal,
  subjectsSha256, responseSha256: request.responseSha256, checkedAtMs: now - 100,
  expiresAtMs: now + 1_000 });

test('pins ordered RFC 8785 subject SHA across the wire, including an independent literal vector', () => {
  const request = parseHistoryReleaseRequest(body());
  const canonical = '[{"clientId":"00000000-0000-4000-8000-000000000003","conversationId":"00000000-0000-4000-8000-000000000002","scopes":[{"kind":"client","policyRevision":"pinned-policy","resourceId":"00000000-0000-4000-8000-000000000003","tenantId":"00000000-0000-4000-8000-000000000001"}]}]';
  assert.equal(historyReleaseSubjectsSha256(request.subjects), sha(canonical));
  // This pinned digest can be compared directly with Meri's canonicalSha256.
  assert.equal(historyReleaseSubjectsSha256(request.subjects), 'c236d2c58ae34e62dbdc413ffa6e321a7eb60b9c6cba1ead88e5af492dd9863a');
  const reorderedKeys = body([{ scopes: [{ policyRevision: 'pinned-policy', resourceId: id(3),
    kind: 'client', tenantId: principal.tenantId }], clientId: id(3), conversationId: id(2) }]);
  assert.equal(historyReleaseSubjectsSha256(parseHistoryReleaseRequest(reorderedKeys).subjects), sha(canonical));
  assert.notEqual(historyReleaseSubjectsSha256(parseHistoryReleaseRequest(body([subject(2), subject(4)])).subjects),
    historyReleaseSubjectsSha256(parseHistoryReleaseRequest(body([subject(4), subject(2)])).subjects));
  assert.notEqual(historyReleaseSubjectsSha256(parseHistoryReleaseRequest(body([{
    ...subject(), scopes: [scope(), { ...scope(), kind: 'tenant', resourceId: principal.tenantId }],
  }])).subjects), historyReleaseSubjectsSha256(parseHistoryReleaseRequest(body([{
    ...subject(), scopes: [{ ...scope(), kind: 'tenant', resourceId: principal.tenantId }, scope()],
  }])).subjects));
});

test('empty list, list and transcript each use exactly one all-subject decision and exact receipt', async () => {
  for (const input of [body([], 'list'), body([subject(2), subject(4)]), body([subject()], 'transcript')]) {
    const calls = [];
    const receipt = await readHistoryReleaseSource(input, principal, { decideAll: async (...args) => {
      calls.push(args); return decision(...args);
    } }, () => now);
    assert.equal(calls.length, 1);
    assert.deepEqual(receipt, { schemaVersion: 1, observationId: input.observationId, route: input.route,
      principal, subjectsSha256: historyReleaseSubjectsSha256(input.subjects),
      responseSha256: input.responseSha256, checkedAtMs: now - 100, expiresAtMs: now + 1_000 });
    assert.deepEqual(calls[0][0], parseHistoryReleaseRequest(input));
    assert.deepEqual(calls[0][1], principal);
    assert.equal(calls[0][2], receipt.subjectsSha256);
  }
});

test('the batch port receives a detached frozen vector and principal', async () => {
  const input = body();
  const original = historyReleaseSubjectsSha256(parseHistoryReleaseRequest(input).subjects);
  const receipt = await readHistoryReleaseSource(input, principal, { decideAll: async (request, who, vectorSha) => {
    assert.ok(Object.isFrozen(request) && Object.isFrozen(request.subjects) &&
      Object.isFrozen(request.subjects[0]) && Object.isFrozen(request.subjects[0].scopes) &&
      Object.isFrozen(request.subjects[0].scopes[0]) && Object.isFrozen(who));
    input.subjects[0].clientId = id(77);
    assert.throws(() => request.subjects[0].scopes.push(scope()), TypeError);
    return decision(request, who, vectorSha);
  } }, () => now);
  assert.equal(receipt.subjectsSha256, original);
});

test('closed request and nested Scope parser refuses malformed, duplicated and oversized vectors before calling owner', async () => {
  const many = Array.from({ length: HISTORY_RELEASE_MAX_SUBJECTS + 1 }, (_, index) => subject(index + 100));
  const tooManyScopes = { ...subject(), scopes: Array.from({ length: 101 }, (_, index) =>
    ({ ...scope(), resourceId: id(index + 100) })) };
  const cases = [
    { ...body(), schemaVersion: 2 }, { ...body(), route: 'next-turn' },
    { ...body(), responseSha256: 'A'.repeat(64) }, { ...body(), observationId: 'not-uuid' },
    { ...body(), extra: 1 }, body([], 'transcript'), body([subject(), subject(4)], 'transcript'),
    body([subject(), subject()]), body(many), body([tooManyScopes]),
    body([{ ...subject(), extra: true }]), body([{ ...subject(), conversationId: id(2).replace('00000000', 'AAAAAAAA') }]),
    body([{ ...subject(), clientId: 'foreign' }]), body([{ ...subject(), scopes: [] }]),
    body([{ ...subject(), scopes: [scope(), scope()] }]),
    body([{ ...subject(), scopes: [{ ...scope(), kind: 'other' }] }]),
    body([{ ...subject(), scopes: [{ ...scope(), extra: 'grant' }] }]),
    body([{ ...subject(), scopes: [{ ...scope(), policyRevision: '' }] }]),
    body([{ ...subject(), scopes: [{ ...scope(), policyRevision: 'x'.repeat(129) }] }]),
    body([{ ...subject(), scopes: [{ ...scope(), policyRevision: '\ud800' }] }]),
    body([Object.defineProperty({ ...subject() }, 'clientId', { get() { throw Error('getter ran'); }, enumerable: true })]),
    body([new Proxy(subject(), {})]),
    body(Object.assign([subject()], { extra: true })),
  ];
  for (const [index, input] of cases.entries()) {
    let calls = 0;
    await assert.rejects(readHistoryReleaseSource(input, principal, { decideAll: async () => { calls++; } }, () => now),
      denied('INVALID_REQUEST'), `case ${index}`);
    assert.equal(calls, 0);
  }
  const max = body(Array.from({ length: 100 }, (_, index) => subject(index + 100)));
  assert.equal(parseHistoryReleaseRequest(max).subjects.length, 100);
  const totalOverflow = body([{
    ...subject(), scopes: Array.from({ length: 100 }, (_, index) => ({ ...scope(), resourceId: id(index + 100) })),
  }, subject(4)]);
  assert.throws(() => parseHistoryReleaseRequest(totalOverflow), denied('INVALID_REQUEST'));
});

test('all seven Meri Scope kinds parse, but the owner must decide their authority', async () => {
  const kinds = ['tenant', 'client', 'mailbox', 'memory', 'document', 'private-user', 'public'];
  const input = body([{ ...subject(), clientId: null, scopes: kinds.map((kind, index) => ({
    tenantId: principal.tenantId, kind, resourceId: id(index + 20), policyRevision: 'pinned-policy',
  })) }]);
  let called = false;
  await assert.rejects(readHistoryReleaseSource(input, principal, { decideAll: async request => {
    called = true; assert.equal(request.subjects[0].scopes.length, 7); throw Error('scope unavailable');
  } }, () => now), denied('UNAVAILABLE'));
  assert.equal(called, true);
});

test('decision exceptions, partial grants, wrong echoes and stale time yield no receipt', async () => {
  const input = body([subject(), subject(4)]);
  const parsed = parseHistoryReleaseRequest(input);
  const vectorSha = historyReleaseSubjectsSha256(parsed.subjects);
  const correct = decision(parsed, principal, vectorSha);
  const mutations = [
    { ...correct, authorized: false }, { ...correct, observationId: id(11) },
    { ...correct, route: 'transcript' }, { ...correct, responseSha256: 'b'.repeat(64) },
    { ...correct, subjectsSha256: 'b'.repeat(64) },
    { ...correct, principal: { ...principal, actorId: id(8) } },
    { ...correct, checkedAtMs: now + 1 },
    { ...correct, checkedAtMs: now - HISTORY_RELEASE_RECEIPT_TTL_MS - 1 },
    { ...correct, expiresAtMs: now },
    { ...correct, expiresAtMs: now + HISTORY_RELEASE_RECEIPT_TTL_MS + 1 },
    { ...correct, extra: true }, null, { grantedSubjects: [subject()] },
  ];
  for (const value of mutations) {
    await assert.rejects(readHistoryReleaseSource(input, principal,
      { decideAll: async () => value }, () => now), denied('UNAVAILABLE'));
  }
  await assert.rejects(readHistoryReleaseSource(input, principal,
    { decideAll: async () => { throw Error('owner unavailable'); } }, () => now), denied('UNAVAILABLE'));
  await assert.rejects(readHistoryReleaseSource(input, { ...principal, tenantId: 'wrong' },
    { decideAll: async () => correct }, () => now), denied('UNAVAILABLE'));
  assert.deepEqual(buildHistoryReleaseReceipt(parsed, principal, vectorSha, correct, now),
    { schemaVersion: 1, ...Object.fromEntries(Object.entries(correct).filter(([key]) => key !== 'authorized')) });
});
