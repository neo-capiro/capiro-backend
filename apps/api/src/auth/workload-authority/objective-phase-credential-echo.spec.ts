import { describe, expect, it } from '@jest/globals';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { canonicalizeCoreRetainedJson } from '@capiro/shared/core-retained-jcs';
import { objectivePhaseCredentialEcho, type ObjectiveMeriPhase } from './objective-phase-credential-echo.js';
import { OBJECTIVE_GENERATION_WORKER_SUBJECT, OBJECTIVE_STRATEGY_AUDIENCE,
  issueObjectiveWorkloadJwt } from './objective-workload-jwt.js';

// Synthetic, process-local issuer only. No live key or source is used here.
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 3072 });
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const now = 1_800_000_000;
const checkedAtMs = now * 1000 + 250;
const jobId = id(1), tenantId = id(2), actorId = 'clerk-user-synthetic';
const binding = { tenantId, actorId, conversationId: id(3), runId: id(4),
  attemptId: id(5), workerId: id(6), writerFence: 7 };
const source = { generationJobId: jobId, binding };
const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');
const canonicalSha = (v: unknown) => sha(canonicalizeCoreRetainedJson(v));
const identity = { schemaVersion: 1, generationJobId: jobId };
const routeRoot = '/strategy-api/internal/objective-canonical';
// Mirrored from Meri core-http.mjs 8e7bf0e8, independently of the helper map.
const phases: Record<ObjectiveMeriPhase, { method: 'GET' | 'POST'; path: string; accepted: boolean }> = {
  admit: { method: 'POST', path: `${routeRoot}/generation-admissions`, accepted: false },
  publish: { method: 'POST', path: `${routeRoot}/generation-requests`, accepted: false },
  accept: { method: 'POST', path: `${routeRoot}/generation-acceptances`, accepted: true },
  'admission-read': { method: 'GET', path: `${routeRoot}/generation-admissions`, accepted: false },
  'request-read': { method: 'GET', path: `${routeRoot}/generation-requests`, accepted: false },
  complete: { method: 'POST', path: `${routeRoot}/generation-completions`, accepted: true },
  'completion-read': { method: 'GET', path: `${routeRoot}/generation-completions`, accepted: true },
};

function request(phase: ObjectiveMeriPhase) {
  const target = phases[phase];
  return { operation: 'objective.strategy.draft', phase, method: target.method,
    route: target.method === 'GET' ? `${target.path}/${jobId}` : target.path,
    source, sourceSha256: canonicalSha(source), requestSha256: canonicalSha(identity),
    bodySha256: sha(target.method === 'GET' ? '' : JSON.stringify(identity)) };
}

function issued(phase: ObjectiveMeriPhase, overrides: Record<string, unknown> = {}) {
  const target = phases[phase], r = request(phase), accepted = target.accepted;
  const authorizationJti = id(20);
  const token = issueObjectiveWorkloadJwt({
    subject: OBJECTIVE_GENERATION_WORKER_SUBJECT, audience: OBJECTIVE_STRATEGY_AUDIENCE,
    method: target.method, path: r.route, query: '',
    body: Buffer.from(target.method === 'GET' ? '' : JSON.stringify(identity), 'utf8'),
    operation: 'objective.strategy.draft', phase, tenantId, generationJobId: jobId,
    delegationRef: id(7), consentId: id(8),
    attemptId: accepted ? binding.attemptId : null, runId: accepted ? binding.runId : null,
    acceptedBindingSha256: accepted ? canonicalSha(binding) : null, sourceSha256: null,
    ...overrides,
  } as never, { issuer: 'capiro-core-objective', kid: 'objective-synthetic-1', privateKey },
  { jti: authorizationJti, nowSeconds: now, expiresAtSeconds: now + 60 });
  return { token, authorizationJti, iatSeconds: now, expSeconds: now + 60 };
}

const echo = (phase: ObjectiveMeriPhase, options: { request?: unknown; issued?: unknown;
  delegatedActorId?: string; checkedAtMs?: number } = {}) => objectivePhaseCredentialEcho({
  issued: (options.issued ?? issued(phase)) as never,
  request: (options.request ?? request(phase)) as never,
  delegatedActorId: options.delegatedActorId ?? actorId,
  checkedAtMs: options.checkedAtMs ?? checkedAtMs,
});

/** Meri core-http.mjs readCredential correlation subset and closed response. */
function meriAccepts(raw: Record<string, unknown>, phase: ObjectiveMeriPhase): boolean {
  const r = request(phase), keys = ['credential', 'actorId', 'tenantId', 'generationJobId', 'operation',
    'method', 'route', 'phase', 'sourceSha256', 'requestSha256', 'bodySha256', 'checkedAtMs', 'expiresAtMs'];
  return Object.keys(raw).length === keys.length && keys.every(k => Object.hasOwn(raw, k)) &&
    raw.actorId === actorId && raw.tenantId === tenantId && raw.generationJobId === jobId &&
    ['operation', 'method', 'route', 'phase', 'sourceSha256', 'requestSha256', 'bodySha256']
      .every(k => raw[k] === (r as unknown as Record<string, unknown>)[k]) &&
    typeof raw.credential === 'string' && /^[A-Za-z0-9._~+/-]{1,8192}={0,2}$/u.test(raw.credential) &&
    Number.isSafeInteger(raw.checkedAtMs) && raw.checkedAtMs === checkedAtMs &&
    Number.isSafeInteger(raw.expiresAtMs) && (raw.expiresAtMs as number) > checkedAtMs;
}

describe('Objective seven-phase credential echo correlation (D29 source only)', () => {
  it.each(Object.keys(phases) as ObjectiveMeriPhase[])('matches Meri for %s', phase => {
    const mint = issued(phase), output = echo(phase, { issued: mint });
    expect(meriAccepts(output as unknown as Record<string, unknown>, phase)).toBe(true);
    expect(output.credential).toBe(mint.token);
    expect(output.expiresAtMs).toBe((now + 60) * 1000);
  });

  it.each(Object.keys(phases) as ObjectiveMeriPhase[])('rejects another route or body on %s', phase => {
    const r = request(phase);
    expect(() => echo(phase, { request: { ...r, route: `${r.route}/other` } }))
      .toThrow('OBJECTIVE_PHASE_CREDENTIAL_REFUSED');
    expect(() => echo(phase, { request: { ...r, bodySha256: 'a'.repeat(64) } }))
      .toThrow('OBJECTIVE_PHASE_CREDENTIAL_REFUSED');
    expect(() => echo(phase, { request: { ...r, method: r.method === 'GET' ? 'POST' : 'GET' } }))
      .toThrow('OBJECTIVE_PHASE_CREDENTIAL_REFUSED');
  });

  it('rejects a token from another phase, even when the Meri target is correct', () => {
    expect(() => echo('publish', { issued: issued('admit') })).toThrow('OBJECTIVE_PHASE_CREDENTIAL_REFUSED');
  });

  it('rejects changed source and identity digests, including a valid-looking sibling job', () => {
    const r = request('admit');
    expect(() => echo('admit', { request: { ...r, sourceSha256: 'a'.repeat(64) } }))
      .toThrow('OBJECTIVE_PHASE_CREDENTIAL_REFUSED');
    expect(() => echo('admit', { request: { ...r, requestSha256: 'b'.repeat(64) } }))
      .toThrow('OBJECTIVE_PHASE_CREDENTIAL_REFUSED');
    const other = { generationJobId: id(40), binding };
    expect(() => echo('admit', { request: { ...r, source: other, sourceSha256: canonicalSha(other) } }))
      .toThrow('OBJECTIVE_PHASE_CREDENTIAL_REFUSED');
  });

  it.each(['accept', 'complete', 'completion-read'] as ObjectiveMeriPhase[])(
    'requires the full original accepted binding on %s', phase => {
      const r = request(phase), altered = { ...binding, writerFence: binding.writerFence + 1 };
      const alteredSource = { generationJobId: jobId, binding: altered };
      expect(() => echo(phase, { request: { ...r, source: alteredSource,
        sourceSha256: canonicalSha(alteredSource) } })).toThrow('OBJECTIVE_PHASE_CREDENTIAL_REFUSED');
      expect(() => echo(phase, { issued: issued(phase, { acceptedBindingSha256: 'c'.repeat(64) }) }))
        .toThrow('OBJECTIVE_PHASE_CREDENTIAL_REFUSED');
    },
  );

  it('checks native actor, issuance JTI and expiry instead of echoing caller claims', () => {
    expect(() => echo('admit', { delegatedActorId: 'other' })).toThrow('OBJECTIVE_PHASE_CREDENTIAL_REFUSED');
    expect(() => echo('admit', { issued: { ...issued('admit'), authorizationJti: id(41) } }))
      .toThrow('OBJECTIVE_PHASE_CREDENTIAL_REFUSED');
    expect(() => echo('admit', { issued: { ...issued('admit'), expSeconds: now + 30 } }))
      .toThrow('OBJECTIVE_PHASE_CREDENTIAL_REFUSED');
    expect(() => echo('admit', { checkedAtMs: (now + 60) * 1000 }))
      .toThrow('OBJECTIVE_PHASE_CREDENTIAL_REFUSED');
  });

  it('rejects accessor fields and extra input instead of invoking them', () => {
    const r = request('request-read');
    Object.defineProperty(r, 'route', { enumerable: true, get: () => `${routeRoot}/generation-requests/${jobId}` });
    expect(() => echo('request-read', { request: r })).toThrow('OBJECTIVE_PHASE_CREDENTIAL_REFUSED');
    expect(() => echo('admit', { request: { ...request('admit'), extra: true } }))
      .toThrow('OBJECTIVE_PHASE_CREDENTIAL_REFUSED');
  });
});
