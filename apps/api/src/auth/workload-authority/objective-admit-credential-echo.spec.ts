import { describe, expect, it } from '@jest/globals';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { canonicalizeCoreRetainedJson } from '@capiro/shared/core-retained-jcs';
import { OBJECTIVE_ADMIT_ROUTE, objectiveAdmitCredentialEcho } from './objective-admit-credential-echo.js';
import {
  OBJECTIVE_GENERATION_WORKER_SUBJECT,
  OBJECTIVE_STRATEGY_AUDIENCE,
  issueObjectiveWorkloadJwt,
} from './objective-workload-jwt.js';

// SYNTHETIC process-local key and identifiers only.
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 3072 });
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const jobId = id(1), tenantId = id(2), actorId = id(3);
const now = 1_800_000_000;
const sha = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
const jcs = (value: unknown) => sha(canonicalizeCoreRetainedJson(value));
const body = JSON.stringify({ schemaVersion: 1, generationJobId: jobId });

function admitToken(overrides: Record<string, unknown> = {}) {
  return issueObjectiveWorkloadJwt({
    subject: OBJECTIVE_GENERATION_WORKER_SUBJECT, audience: OBJECTIVE_STRATEGY_AUDIENCE, method: 'POST',
    path: OBJECTIVE_ADMIT_ROUTE, query: '', body: Buffer.from(body, 'utf8'), operation: 'objective.strategy.draft',
    phase: 'admit', tenantId, generationJobId: jobId, delegationRef: id(4), consentId: id(5),
    attemptId: null, runId: null, acceptedBindingSha256: null, sourceSha256: null, ...overrides,
  } as never, { issuer: 'capiro-core-objective', kid: 'objective-synthetic-1', privateKey }, { jti: id(6), nowSeconds: now, expiresAtSeconds: now + 60 });
}

/** Exactly the request Meri's transport hands its readCredential port for `admit`. */
function meriRequest() {
  const source = { generationJobId: jobId, binding: {
    tenantId, actorId, conversationId: id(7), runId: id(8), attemptId: id(9), workerId: id(10), writerFence: 1 } };
  return { operation: 'objective.strategy.draft', phase: 'admit', method: 'POST', route: OBJECTIVE_ADMIT_ROUTE, source,
    sourceSha256: jcs(source), requestSha256: jcs({ schemaVersion: 1, generationJobId: jobId }), bodySha256: sha(body) };
}

/** Oracle: Meri core-http.mjs credential() checks (meri-greenfield 09781127). */
function meriAccepts(a: Record<string, unknown>, request: ReturnType<typeof meriRequest>, began: number, checked: number): boolean {
  const keys = ['credential', 'actorId', 'tenantId', 'generationJobId', 'operation', 'method', 'route', 'phase',
    'sourceSha256', 'requestSha256', 'bodySha256', 'checkedAtMs', 'expiresAtMs'];
  return Object.keys(a).length === keys.length && keys.every((k) => Object.hasOwn(a, k)) &&
    typeof a.credential === 'string' && /^[A-Za-z0-9._~+/-]{1,8192}={0,2}$/u.test(a.credential) &&
    a.actorId === request.source.binding.actorId && a.tenantId === request.source.binding.tenantId &&
    a.generationJobId === request.source.generationJobId && a.operation === request.operation && a.method === request.method &&
    a.route === request.route && a.phase === request.phase && a.sourceSha256 === request.sourceSha256 &&
    a.requestSha256 === request.requestSha256 && a.bodySha256 === request.bodySha256 &&
    Number.isSafeInteger(a.checkedAtMs) && (a.checkedAtMs as number) >= began && (a.checkedAtMs as number) <= checked &&
    Number.isSafeInteger(a.expiresAtMs) && (a.expiresAtMs as number) > checked;
}

const checkedAtMs = now * 1000 + 250;
const echo = (o: { request?: unknown; token?: string; actor?: string; exp?: number } = {}) => objectiveAdmitCredentialEcho({
  issued: { token: o.token ?? admitToken(), expSeconds: o.exp ?? now + 60 },
  request: (o.request ?? meriRequest()) as never, delegatedActorId: o.actor ?? actorId, checkedAtMs,
});

describe('Objective admit credential echo (D7-3, admit only)', () => {
  it("passes Meri's own readCredential echo checks for an admit token Core issued", () => {
    const a = echo();
    expect(meriAccepts(a as never, meriRequest(), checkedAtMs - 10, checkedAtMs + 10)).toBe(true);
    expect(a.expiresAtMs).toBe((now + 60) * 1000);
  });

  it.each([
    ['a later phase (Core has no later-phase issuer)', { request: { ...meriRequest(), phase: 'publish' } }],
    ['another route', { request: { ...meriRequest(), route: '/strategy-api/internal/objective-canonical/generation-requests' } }],
    ['a GET', { request: { ...meriRequest(), method: 'GET' } }],
    ['a source hash Meri did not compute from its source', { request: { ...meriRequest(), sourceSha256: 'a'.repeat(64) } }],
    ['a request hash other than Meri identity', { request: { ...meriRequest(), requestSha256: 'b'.repeat(64) } }],
    ['another delegated actor', { actor: id(11) }],
    ['a token for another job', { token: admitToken({ generationJobId: id(12) }) }],
    ['a token for another tenant', { token: admitToken({ tenantId: id(13) }) }],
    ['an expiry other than the token', { exp: now + 30 }],
  ] as Array<[string, Record<string, unknown>]>)('refuses %s', (_label, o) => {
    expect(() => echo(o as never)).toThrow('OBJECTIVE_ADMIT_CREDENTIAL_REFUSED');
  });
});
