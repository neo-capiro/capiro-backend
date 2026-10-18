import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { createHash, generateKeyPairSync, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { ConflictException, ForbiddenException, GoneException, HttpException, UnauthorizedException } from '@nestjs/common';
import type { Request, Response } from 'express';
import type { TenantContext } from '@capiro/shared';
import type { ClerkService } from '../clerk.service.js';
import type { PrismaService } from '../../prisma/prisma.service.js';
import type { TenantContextStore } from '../../tenant/tenant-context.store.js';
import { TenantContextMiddleware } from '../../tenant/tenant-context.middleware.js';
import { ApplicationMembershipService } from '../application-membership.service.js';
import { createInProcessEd25519Signer } from '../core-ed25519-signer.js';
import { ToolServiceSecretGuard } from '../tool-service-secret.guard.js';
import {
  MERI_DELEGATED_READ_TOOLS, assertDelegatedToolSelectors, canonicalSha256, currentBodySha256, delegationPath, operationsDigest,
  parseTokenRequest, schemaClientSelectors,
} from './read-delegation.contract.js';
import {
  assertMeriReadDelegationReleasable, isMeriReadDelegationServicePost, isMeriReadTokenRequest, meriReadDelegationOf,
  meriReadDelegationRawBody,
} from './read-delegation-request.js';
import { verifyReadToken } from './read-delegation-token.js';
import { ReadDelegationService } from './read-delegation.service.js';

jest.mock('@clerk/backend', () => ({ __esModule: true, createClerkClient: () => ({}), verifyToken: async () => ({}) }));

const T = '11111111-1111-4111-8111-111111111111';
const A = '22222222-2222-4222-8222-222222222222';
const M = '33333333-3333-4333-8333-333333333333';
const C = '44444444-4444-4444-8444-444444444444';
const C2 = '45454545-4545-4545-8545-454545454545';
const V = '55555555-5555-4555-8555-555555555555';
const R = '66666666-6666-4666-8666-666666666666';
const AT = '77777777-7777-4777-8777-777777777777';
const SCHED = '88888888-8888-4888-8888-888888888888';
const WORKER = '99999999-9999-4999-8999-999999999999';
const ORIGINAL_GRANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const WORKER_ARN = 'arn:aws:ecs:us-east-1:967807252336:task/capiro-dev/0123456789abcdef0123456789abcdef';
const CLERK = 'user_reader';
const SECRET = 'svc-secret';
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const P = sha('policy'), BP = sha('budget-policy'), PROJ = sha('projection'), OCC = sha('occurrence');
const OPS = [{ id: 'search_tracked_bills', version: '0.2.0' }, { id: 'get_bill_status', version: '0.2.0' }];
const binding = { tenantId: T, actorId: A, conversationId: V, runId: R, attemptId: AT, writerFence: 3 };
const originalBinding = { ...binding, workerId: WORKER, writerFence: 7 };
const allocation = {
  run: { tenantId: T, actorId: A, conversationId: V, runId: R },
  budgets: { maxTurns: 20, maxToolCalls: 1, maxRecoveryAttempts: 0, maxRuntimeSeconds: 3600,
    maxCostMicroUSD: 2_000_000, maxOutputBytes: 1_048_576 },
  schedule: { revision: sha('schedule'), expiresAt: new Date(Date.now() + 3 * 3_600_000).toISOString(), operations: [] },
  manifest: { allowedOperations: OPS },
};
const AL = canonicalSha256(allocation);
const ISSUER = 'capiro-core:meri-read:v1', KID = 'meri-read-synthetic-1';
const keys = generateKeyPairSync('ed25519');
const signer = createInProcessEd25519Signer({ issuer: ISSUER, kid: KID, privateKey: keys.privateKey });
const ENV: Record<string, string> = {
  MERI_READ_DELEGATION_SIGNER_ISSUER: ISSUER, MERI_READ_DELEGATION_SIGNER_KID: KID,
  MERI_READ_DELEGATION_SIGNER_KMS_KEY_ARN: 'arn:aws:kms:us-east-1:123456789012:key/00000000-0000-4000-8000-000000000000',
  MERI_READ_DELEGATION_SIGNER_PUBLIC_KEY_X: keys.publicKey.export({ format: 'jwk' }).x!, INTERNAL_SERVICE_SECRET: SECRET,
};

type Row = Record<string, any>;
/** In-memory Core tables and Meri facts views. Each transaction runs on a copy and commits only on success. */
function fakeDb() {
  const state = {
    now: Date.now(),
    delegations: new Map<string, Row>(), slots: new Map<string, Row>(), tokens: new Map<string, Row>(), consents: new Map<string, Row>(),
    facts: {
      run_id: R, tenant_id: T, conversation_id: V, allocation_sha256: AL, allowed_operations: OPS, max_tool_calls: '1',
      reserved_calls: '0', attempt: '1', fence: '7', policy_revision: BP, admitted: true, run_state: 'running',
      run_binding: binding, run_scopes: [{ kind: 'client', resourceId: C, policyRevision: P }], admitted_until_offset: 20 * 60_000,
    } as Row,
    reservations: new Map<string, Row>(), occurrences: new Map<string, Row>(), schedules: new Map<string, Row>(),
    visible: [C], memberActive: true, writes: [] as string[], budgetLocks: 0,
    originalGrantState: 'ACTIVE', omitOriginalGrant: false,
  };
  const clone = (s: typeof state) => ({
    ...s, delegations: new Map([...s.delegations].map(([k, v]) => [k, { ...v }])), slots: new Map([...s.slots].map(([k, v]) => [k, { ...v }])),
    tokens: new Map([...s.tokens].map(([k, v]) => [k, { ...v }])), consents: new Map([...s.consents].map(([k, v]) => [k, { ...v }])),
    writes: [...s.writes],
  });
  let db = state;
  const ms = (d: Date) => d.getTime();
  const nowDate = () => new Date(db.now);
  const tx = {
    async $queryRaw(strings: TemplateStringsArray, ...v: any[]) {
      const sql = strings.join('?');
      if (sql.includes('meri_core_authority.current_admission_v1')) {
        if (v[0] !== T || v[1] !== V || v[2] !== R) return [{ snapshot: null }];
        db.budgetLocks++;
        const qualification = { runId: R, attempt: 1, workerArn: WORKER_ARN, fence: 7, policyRevision: BP };
        const grantFacts = { grantId: ORIGINAL_GRANT, binding: originalBinding, qualificationBinding: qualification,
          capabilitySha256: sha('original grant'), allocationSha256: AL };
        return [{ snapshot: {
          contract: 'capiro.meri-core-admission-snapshot.v1', budgetPresent: true, quarantined: false, dbNowMs: db.now,
          admitted: { state: 'ADMITTED', binding: originalBinding, allocationSha256: AL, grantFactsJsons: [JSON.stringify(grantFacts)] },
          run: qualification,
          allocation: { allocation, allocationSha256: AL, startedAtMs: db.now - 60_000 },
          grants: db.omitOriginalGrant ? [] : [{ grantId: ORIGINAL_GRANT, runId: R, attempt: 1, workerArn: WORKER_ARN,
            fence: 7, policyRevision: BP, capabilitySha256: sha('original grant'),
            expiresAtMs: db.now + 40 * 60_000, state: db.originalGrantState,
            boundGrantId: ORIGINAL_GRANT, boundRunId: R, facts: grantFacts }],
        } }];
      }
      if (sql.includes('count(*)::text AS n FROM meri_read_delegation_slots')) {
        const n = [...db.slots.values()].filter((s) => s.run_id === v[0] && s.call_key !== v[1] && s.tool_tokens === 0 &&
          !db.reservations.has(s.call_key) && [...db.tokens.values()].some((t) => t.run_id === s.run_id && t.call_key === s.call_key &&
            ms(t.expires_at) > db.now)).length;
        return [{ n: String(n) }];
      }
      if (sql.includes('run_facts_v1')) {
        const f = db.facts;
        if (v[0] !== f.run_id || v[1] !== f.tenant_id) return [];
        return [{ ...f, admitted_until_ms: String(db.now + f.admitted_until_offset), db_now_ms: String(db.now) }];
      }
      if (sql.includes('reservations_v1')) { const r = db.reservations.get(v[0]); return r ? [r] : []; }
      if (sql.includes('occurrences_v1')) { const o = db.occurrences.get(v[1]); return o && v[0] === T ? [o] : []; }
      if (sql.includes('schedules_v1')) { const s = db.schedules.get(v[1]); return s && v[0] === T ? [s] : []; }
      if (sql.includes('FROM clients c')) return db.memberActive ? db.visible.map((id) => ({ id, revision: 'a'.repeat(32) })) : [];
      if (sql.startsWith('SELECT * FROM meri_read_delegations WHERE id =')) {
        const d = db.delegations.get(v[0]);
        return d && (!sql.includes('AND tenant_id') || d.tenant_id === v[1]) ? [d] : [];
      }
      if (sql.includes('SELECT id::text AS id, state FROM meri_read_delegations')) { const d = db.delegations.get(v[0]); return d ? [d] : []; }
      if (sql.includes('FROM meri_read_delegations WHERE idempotency_key')) {
        return [...db.delegations.values()].filter((d) => d.idempotency_key === v[0] && d.state === 'active');
      }
      if (sql.includes('FROM meri_read_delegations WHERE tenant_id') && sql.includes('occurrence_key')) {
        return [...db.delegations.values()].filter((d) => d.tenant_id === v[0] && d.occurrence_key === v[1]);
      }
      if (sql.includes('FROM meri_read_delegations WHERE supersedes')) {
        return [...db.delegations.values()].filter((d) => d.supersedes === v[0] && d.state === 'active' && d.idempotency_key === v[1]);
      }
      if (sql.includes('INSERT INTO meri_read_delegations')) {
        const [id, key, mode, tenant, user, membership, client, conversation, run, attempt, fence, ba, bf, bp, alloc, ops, policy, consent,
          occurrence, supersedes, issued, expires] = v;
        if (expires.getTime() > issued.getTime() + (mode === 'attended' ? 30 : 15) * 60_000) throw new Error('bound_check');
        if ([...db.delegations.values()].some((d) => d.idempotency_key === key && d.state === 'active')) throw new Error('idem_unique');
        const row = { id, idempotency_key: key, mode, tenant_id: tenant, user_id: user, membership_id: membership, client_id: client,
          conversation_id: conversation, run_id: run, attempt_id: attempt, writer_fence: fence, budget_attempt: ba, budget_fence: bf,
          budget_policy_revision: bp, allocation_sha256: alloc, operations_digest: ops, policy_revision: policy, consent_id: consent,
          occurrence_key: occurrence, revision: 1, state: 'active', supersedes, revoked_reason: null, issued_at: issued, expires_at: expires };
        db.delegations.set(id, row); db.writes.push('delegation');
        return [{ id, expires_at: expires }];
      }
      if (sql.includes('UPDATE meri_read_tokens SET consumed_at')) {
        const t = db.tokens.get(v[0]);
        if (!t || t.token_sha256 !== v[1] || t.delegation_id !== v[2] || t.tenant_id !== v[3] || t.consumed_at || t.superseded_at ||
            ms(t.expires_at) <= db.now) return [];
        t.consumed_at = nowDate(); db.writes.push('consume');
        return [{ kind: t.kind, target_path: t.target_path, body_sha256: t.body_sha256, call_key: t.call_key, arguments_sha256: t.arguments_sha256 }];
      }
      if (sql.includes('FROM meri_read_delegation_slots s WHERE run_id')) {
        const s = db.slots.get(`${v[0]}|${v[1]}`);
        if (!s) return [];
        const fresh = ![...db.tokens.values()].some((t) => t.run_id === s.run_id && t.call_key === s.call_key);
        return [{ ...s, fresh }];
      }
      if (sql.includes('FROM meri_read_tokens WHERE run_id') && sql.includes('request_digest')) {
        const all = [...db.tokens.values()].filter((t) => t.run_id === v[0] && t.call_key === v[1] && t.kind === v[2] && t.request_digest === v[3]);
        return all.map((t) => ({ jti: t.jti, consumed: !!t.consumed_at, superseded: !!t.superseded_at, live: ms(t.expires_at) > db.now }));
      }
      if (sql.includes('count(*)::text AS n FROM meri_read_tokens')) {
        return [{ n: String([...db.tokens.values()].filter((t) => t.run_id === v[0] && t.call_key === v[1] && t.kind === v[2] && t.superseded_at).length) }];
      }
      if (sql.includes('SELECT state, floor') && sql.includes('meri_read_delegation_consents')) {
        const c = db.consents.get(v[0]);
        return c && c.tenant_id === v[1] ? [{ state: c.state, expires_ms: String(ms(c.expires_at)), live: ms(c.expires_at) > db.now }] : [];
      }
      if (sql.includes('AS live FROM meri_read_delegation_consents')) {
        const c = db.consents.get(v[0]);
        return c && (!sql.includes('AND tenant_id') || c.tenant_id === v[1]) ? [{ ...c, live: ms(c.expires_at) > db.now }] : [];
      }
      if (sql.includes('SELECT id::text AS id FROM meri_read_delegation_consents')) {
        return [...db.consents.values()].filter((c) => c.tenant_id === v[0] && c.schedule_id === v[1] && c.state === 'active').map((c) => ({ id: c.id }));
      }
      if (sql.includes('SELECT floor(extract(epoch FROM clock_timestamp())')) return [{ now_ms: String(db.now) }];
      throw new Error(`unexpected query: ${sql}`);
    },
    async $executeRaw(strings: TemplateStringsArray, ...v: any[]) {
      const sql = strings.join('?');
      if (sql.includes('pg_advisory_xact_lock')) return 1;
      if (sql.includes('UPDATE meri_read_delegations SET state = \'superseded\'')) { db.delegations.get(v[0])!.state = 'superseded'; return 1; }
      if (sql.includes('UPDATE meri_read_delegations SET state = \'expired\'')) { db.delegations.get(v[0])!.state = 'expired'; return 1; }
      if (sql.includes('UPDATE meri_read_delegations SET state = \'revoked\', revoked_reason = ? WHERE id')) {
        Object.assign(db.delegations.get(v[1])!, { state: 'revoked', revoked_reason: v[0] }); return 1;
      }
      if (sql.includes('WHERE consent_id = ')) {
        let n = 0;
        for (const d of db.delegations.values()) if (d.consent_id === v[1] && d.state === 'active') { d.state = 'revoked'; d.revoked_reason = v[0]; n++; }
        return n;
      }
      if (sql.includes('INSERT INTO meri_read_delegation_slots')) {
        const key = `${v[0]}|${v[1]}`;
        if (!db.slots.has(key)) db.slots.set(key, { run_id: v[0], call_key: v[1], tenant_id: v[2], delegation_id: v[3], tool_tokens: 0,
          mode_tokens: 0, reference_tokens: 0, current_tokens: 0, reissues: 0 });
        return 1;
      }
      if (sql.includes('UPDATE meri_read_tokens SET superseded_at')) { db.tokens.get(v[0])!.superseded_at = nowDate(); return 1; }
      if (sql.includes('SET reissues = reissues + 1')) {
        const s = db.slots.get(`${v[0]}|${v[1]}`)!; if (s.reissues >= 8) throw new Error('reissues_check'); s.reissues++; return 1;
      }
      if (sql.includes('INSERT INTO meri_read_tokens')) {
        const [jti, tokenSha, tenant, delegation, run, callKey, kind, path, body, args, digest, issued, expires] = v;
        if (expires.getTime() > issued.getTime() + 60_000 || expires.getTime() <= issued.getTime()) throw new Error('expiry_check');
        db.tokens.set(jti, { jti, token_sha256: tokenSha, tenant_id: tenant, delegation_id: delegation, run_id: run, call_key: callKey, kind,
          target_path: path, body_sha256: body, arguments_sha256: args, request_digest: digest, issued_at: issued, expires_at: expires,
          consumed_at: null, superseded_at: null });
        return 1;
      }
      if (sql.includes('INSERT INTO meri_read_delegation_consents')) {
        const [id, tenant, user, client, schedule, projection, ops, policy, supersedes, created, expires] = v;
        db.consents.set(id, { id, tenant_id: tenant, user_id: user, client_id: client, schedule_id: schedule, schedule_projection_sha256: projection,
          operations_digest: ops, policy_revision: policy, state: 'active', supersedes, created_at: created, expires_at: expires });
        return 1;
      }
      if (sql.includes('UPDATE meri_read_delegation_consents SET state = \'superseded\'')) { db.consents.get(v[0])!.state = 'superseded'; return 1; }
      if (sql.includes('UPDATE meri_read_delegation_consents SET state = \'active\'')) { db.consents.get(v[0])!.state = 'active'; return 1; }
      if (sql.includes('UPDATE meri_read_delegation_consents SET state = ?')) { db.consents.get(v[1])!.state = v[0]; return 1; }
      throw new Error(`unexpected statement: ${sql}`);
    },
    async $executeRawUnsafe(sql: string, run: string, callKey: string, ceiling: number) {
      const column = /SET (\w+) = /.exec(sql)![1]!;
      const s = db.slots.get(`${run}|${callKey}`)!;
      if (s[column] >= ceiling) return 0;
      s[column]++; return 1;
    },
    user: { findUnique: async ({ where }: any) => (where.id === A ? { id: A, clerkUserId: CLERK } : null) },
    tenantMembership: {
      findFirst: async ({ where }: any) => (!db.memberActive || where.tenantId !== T || where.userId !== A || (where.id && where.id !== M) ? null : {
        id: M, tenantId: T, userId: A, status: 'active', role: 'standard_user', updatedAt: new Date(1_700_000_000_000),
        tenant: { id: T, status: 'active', clerkOrgId: null, slug: 'synthetic' },
      }),
    },
    client: { findFirst: async ({ where }: any) => (db.visible.includes(where.id) ? { id: where.id } : null) },
    clioConversation: {
      findFirst: async ({ where }: any) => (where.id === V && where.userId === A ? {
        id: V, tenantId: T, userId: A, clientId: db.facts.conversation_client ?? C, status: 'active', archivedAt: null, metadata: null,
      } : null),
    },
    clioMeriExecutionIssuance: { findMany: async () => [] },
  };
  const run = async <X>(fn: (t: any) => Promise<X>): Promise<X> => {
    const saved = db; db = clone(db);
    try { const out = await fn(tx); return out; } catch (error) { db = saved; throw error; }
  };
  const prisma = { withSystem: (fn: any) => run(fn), withTenant: (_t: string, fn: any) => run(fn) } as unknown as PrismaService;
  return { get state() { return db; }, prisma, tx };
}

const guard = new ToolServiceSecretGuard({
  get: (key: string) => ({ NODE_ENV: 'production', MERI_TOOLS_REQUIRE_SERVICE_SECRET: true, INTERNAL_SERVICE_SECRET: SECRET } as Record<string, unknown>)[key],
} as never);
function request(path: string, init: { body?: unknown; authorization?: string; secret?: string | null; headers?: Record<string, string>; method?: string } = {}) {
  const bytes = Buffer.from(JSON.stringify(init.body ?? {}), 'utf8');
  const headers: Record<string, string> = {
    'content-type': 'application/json', 'content-length': String(bytes.length),
    ...(init.secret === null ? {} : { 'x-internal-service-secret': init.secret ?? SECRET }),
    ...(init.authorization ? { authorization: init.authorization } : {}), ...(init.headers ?? {}),
  };
  const req = Object.assign(Readable.from([bytes]), {
    method: init.method ?? 'POST', path, originalUrl: path, url: path, baseUrl: '', headers, body: init.body,
    header: (name: string) => headers[name.toLowerCase()],
  }) as unknown as Request;
  return req;
}
const verified = (req: Request) => { guard.canActivate({ switchToHttp: () => ({ getRequest: () => req }) } as never); return req; };
const parsed = (req: Request) => new Promise<Request>((resolve, reject) => {
  meriReadDelegationRawBody()(req, {} as Response, (error?: unknown) => (error ? reject(error) : resolve(req)));
});
const control = { deadlineMs: Date.now() + 30_000, assertActive() {} };
const ctx: TenantContext = { tenantId: T, tenantSlug: 'synthetic', userId: A, clerkUserId: CLERK, role: 'standard_user' };

function harness() {
  const db = fakeDb();
  const live = jest.fn(async () => ({ principal: { tenantId: T, actorId: A }, identityRevision: 'f'.repeat(64), expiresAtMs: Date.now() + 60_000,
    recheckCurrent: async () => ({ principal: { tenantId: T, actorId: A }, identityRevision: 'f'.repeat(64), expiresAtMs: Date.now() + 60_000 }) }));
  const tenant = { readApplicationAuthority: live } as unknown as TenantContextMiddleware;
  const membership = new ApplicationMembershipService(db.prisma, tenant);
  const scope = { resolveApplicationAuthorityClient: jest.fn(async (_t: string, _a: string, id: string) => (id === C ? { id } : (() => { throw new ForbiddenException(); })())) };
  const service = new ReadDelegationService(db.prisma, tenant, membership, scope as never, {} as never, signer);
  const store = { run: (_c: unknown, next: () => void) => next() } as unknown as TenantContextStore;
  const verify = jest.fn(async () => { throw new Error('Clerk must not be reached for a read token'); });
  const middleware = new TenantContextMiddleware({ verifySessionToken: verify } as unknown as ClerkService, db.prisma, store);
  const createBody = (over: Record<string, unknown> = {}) => ({ schemaVersion: 1, mode: 'attended', binding, clientId: C, policyRevision: P,
    allocationSha256: AL, operationsDigest: operationsDigest(OPS), supersedes: null, ...over });
  const create = (over: Record<string, unknown> = {}) => service.createAttended(verified(request('/api/clio/application-authority/read-delegations')), ctx, createBody(over));
  const tokenBody = (delegationId: string, over: Record<string, unknown> = {}) => ({ schemaVersion: 1, kind: 'current', callKey: 'call-1', method: 'POST',
    path: delegationPath(delegationId, 'current'), bodySha256: currentBodySha256(false), operation: null, argumentsSha256: null,
    toolRequestSha256: null, referenceSha256: null, retryOf: null, ...over });
  const issue = (delegationId: string, over: Record<string, unknown> = {}) =>
    service.issueToken(verified(request(`/api/clio/application-authority/read-delegations/${delegationId}/tokens`)), delegationId, tokenBody(delegationId, over));
  /** The target request exactly as Meri sends it, through the raw-body capture and the tenant middleware. */
  async function use(path: string, token: string, body: unknown, init: { secret?: string | null; headers?: Record<string, string>; method?: string; url?: string } = {}) {
    const req = await parsed(request(path, { body, authorization: `CapiroMeriRead ${token}`, ...init }));
    if (init.url) Object.assign(req, { originalUrl: init.url });
    const next = jest.fn();
    await middleware.use(req, { setHeader() {} } as unknown as Response, next);
    return { req, next, ctx: (req as Request & { tenantContext?: TenantContext }).tenantContext! };
  }
  return { db, service, live, scope, verify, create, issue, tokenBody, use, createBody };
}

describe('RC1 option B read delegation, Core owner', () => {
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => { for (const [k, v] of Object.entries(ENV)) { saved[k] = process.env[k]; process.env[k] = v; } });
  afterEach(() => { for (const k of Object.keys(ENV)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

  describe('issuance', () => {
    it('creates an attended delegation bounded by 30 minutes and the run, idempotently, after the live session read', async () => {
      const h = harness();
      const first = await h.create();
      expect(h.live).toHaveBeenCalledTimes(1);
      expect(first.expiresAtMs).toBeLessThanOrEqual(h.db.state.now + 30 * 60_000);
      const row = h.db.state.delegations.get(first.delegationId)!;
      expect([row.budget_attempt, row.budget_fence, row.budget_policy_revision]).toEqual([1, 7, BP]);
      const again = await h.create();
      expect(again.delegationId).toBe(first.delegationId);
      expect(h.db.state.delegations.size).toBe(1);
      expect(h.db.state.budgetLocks).toBe(4); // two locked snapshots per currentness check
    });

    it('refuses a missing original ADMITTED grant even when the Meri view says admitted', async () => {
      const h = harness();
      h.db.state.omitOriginalGrant = true;
      await expect(h.create()).rejects.toBeInstanceOf(ConflictException);
      expect(h.db.state.facts.admitted).toBe(true);
      expect(h.db.state.delegations.size).toBe(0);
    });

    it('caps the attended expiry at admitted_until', async () => {
      const h = harness();
      h.db.state.facts.admitted_until_offset = 5 * 60_000;
      const r = await h.create();
      expect(r.expiresAtMs).toBe(h.db.state.now + 5 * 60_000);
    });

    it('refuses without the verified service identity (an observe-mode guard pass is not enough)', async () => {
      const h = harness();
      const req = request('/api/clio/application-authority/read-delegations', { secret: 'wrong' });
      await expect(h.service.createAttended(req, ctx, h.createBody())).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('refuses when the live session read refuses (sidless, inactive or marked credential)', async () => {
      const h = harness();
      h.live.mockRejectedValueOnce(new ForbiddenException('Application authority unavailable'));
      await expect(h.create()).rejects.toBeInstanceOf(ForbiddenException);
      expect(h.db.state.delegations.size).toBe(0);
    });

    it.each([
      ['a terminal run', (f: Row) => { f.run_state = 'completed'; }, ConflictException],
      ['an unadmitted run (grant revoked or budget quarantined)', (f: Row) => { f.admitted = false; }, ConflictException],
      ['another allocation', (f: Row) => { f.allocation_sha256 = sha('other'); }, ConflictException],
      ['another operation set', (f: Row) => { f.allowed_operations = [OPS[0]]; }, ConflictException],
      ['a wider scope', (f: Row) => { f.run_scopes = [...f.run_scopes, { kind: 'client', resourceId: C2, policyRevision: P }]; }, ForbiddenException],
      ['another writer fence', (f: Row) => { f.run_binding = { ...binding, writerFence: 4 }; }, ForbiddenException],
      ['another attempt', (f: Row) => { f.run_binding = { ...binding, attemptId: randomUUID() }; }, ConflictException],
      ['another scope policy', (f: Row) => { f.run_scopes = [{ kind: 'client', resourceId: C, policyRevision: sha('x') }]; }, ForbiddenException],
    ])('refuses %s', async (_name, mutate, type) => {
      const h = harness();
      mutate(h.db.state.facts);
      await expect(h.create()).rejects.toBeInstanceOf(type);
    });

    it('refuses a binding for another actor or a client the actor cannot see', async () => {
      const h = harness();
      await expect(h.create({ binding: { ...binding, actorId: randomUUID() } })).rejects.toBeInstanceOf(ForbiddenException);
      h.db.state.visible = [];
      await expect(h.create()).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('renews only by superseding the named active row; slots carry over and allowance is never added', async () => {
      const h = harness();
      const first = await h.create();
      await h.issue(first.delegationId);
      const renewed = await h.create({ supersedes: first.delegationId });
      expect(renewed.delegationId).not.toBe(first.delegationId);
      expect(h.db.state.delegations.get(first.delegationId)!.state).toBe('superseded');
      // A lost response to the same renewal returns the same successor.
      expect((await h.create({ supersedes: first.delegationId })).delegationId).toBe(renewed.delegationId);
      // The slot opened under the old row stays the run's slot; a second call still exhausts the one-call allowance.
      await h.issue(renewed.delegationId);
      expect(h.db.state.slots.get(`${R}|call-1`)!.current_tokens).toBe(2);
      await expect(h.issue(renewed.delegationId, { callKey: 'call-2' })).rejects.toMatchObject({ status: 429 });
    });

    it('unattended: needs an active consent of the schedule owner and a DISPATCHED occurrence of this run; never renewed', async () => {
      const h = harness();
      h.db.state.schedules.set(SCHED, { owner_actor_id: A, generation: '1', projection_sha256: PROJ });
      const consent = await h.service.createConsent(verified(request('/api/clio/application-authority/read-delegation-consents')), ctx, {
        schemaVersion: 1, scheduleId: SCHED, clientId: C, operationsDigest: operationsDigest(OPS), policyRevision: P,
        scheduleProjectionSha256: PROJ, requestedExpiresAtMs: h.db.state.now + 40 * 86_400_000,
      });
      expect(consent.expiresAtMs).toBe(consent.createdAtMs + 30 * 86_400_000);
      const body = h.createBody({ mode: 'unattended', consentId: consent.consentId, scheduleId: SCHED, occurrenceKey: OCC });
      const createUnattended = () => h.service.createUnattended(verified(request('/api/clio/application-authority/read-delegations')), body);
      await expect(createUnattended()).rejects.toBeInstanceOf(ForbiddenException); // no occurrence yet
      h.db.state.occurrences.set(OCC, { schedule_id: SCHED, generation: '1', state: 'DISPATCHED', run_binding: { tenantId: T, conversationId: V, runId: R },
        created_at_ms: String(h.db.state.now - 60_000) });
      const d = await createUnattended();
      expect(d.expiresAtMs).toBe(h.db.state.now - 60_000 + 15 * 60_000);
      expect((await createUnattended()).delegationId).toBe(d.delegationId);
      // Pause ends authority at once: the occurrence delegation is revoked in the same transaction.
      const paused = await h.service.setConsentState(verified(request(`/x`)), undefined, consent.consentId, { schemaVersion: 1, state: 'paused' });
      expect(paused.state).toBe('paused');
      expect(h.db.state.delegations.get(d.delegationId)!.state).toBe('revoked');
      await expect(h.issue(d.delegationId)).rejects.toBeInstanceOf(ConflictException);
      // Resume widens authority: refused without a live login.
      await expect(h.service.setConsentState(verified(request('/x')), undefined, consent.consentId, { schemaVersion: 1, state: 'active' }))
        .rejects.toBeInstanceOf(ForbiddenException);
      // A schedule whose projection changed refuses a new consent from a stale projection.
      h.db.state.schedules.set(SCHED, { owner_actor_id: A, generation: '2', projection_sha256: sha('changed') });
      await expect(h.service.setConsentState(verified(request('/x')), ctx, consent.consentId, { schemaVersion: 1, state: 'active' }))
        .rejects.toBeInstanceOf(ConflictException);
    });
  });

  describe('tokens', () => {
    it('issues a single-use, at most 60 s token bound to the exact target and counts it per kind', async () => {
      const h = harness();
      const d = await h.create();
      const t = await h.issue(d.delegationId);
      expect(t.expiresAtMs).toBeLessThanOrEqual(h.db.state.now + 60_000);
      const claims = verifyReadToken(t.token, { issuer: ISSUER, kid: KID, keyArn: ENV.MERI_READ_DELEGATION_SIGNER_KMS_KEY_ARN!, region: 'us-east-1',
        publicKey: keys.publicKey }, Date.now())!;
      expect([claims.kind, claims.path, claims.sub, claims.clientId]).toEqual(['current', delegationPath(d.delegationId, 'current'), d.delegationId, C]);
      expect([...h.db.state.tokens.values()][0]!.token_sha256).toBe(createHash('sha256').update(t.token, 'ascii').digest('hex'));
      expect(JSON.stringify([...h.db.state.tokens.values()])).not.toContain(t.token);
    });

    it('refuses a slot beyond the live allowance and a tool token without Meri\'s UNKNOWN reservation', async () => {
      const h = harness();
      const d = await h.create();
      await h.issue(d.delegationId, { callKey: 'call-1' });
      await expect(h.issue(d.delegationId, { callKey: 'call-2' })).rejects.toMatchObject({ status: 429 });
      const toolBody = { kind: 'tool', path: '/api/clio/tools/search_tracked_bills', operation: OPS[0], argumentsSha256: sha('args'), bodySha256: sha('body') };
      await expect(h.issue(d.delegationId, toolBody)).rejects.toBeInstanceOf(ForbiddenException);
      h.db.state.reservations.set('call-1', { invocation_id: 'call-1', run_id: R, operation: OPS[0], arguments_sha256: sha('args'), state: 'UNKNOWN' });
      await expect(h.issue(d.delegationId, toolBody)).resolves.toBeDefined();
      await expect(h.issue(d.delegationId, toolBody)).rejects.toMatchObject({ status: 429 }); // tool ceiling 1
    });

    it('refuses a write or unlisted tool name and an operation outside allowed_operations', async () => {
      const h = harness();
      const d = await h.create();
      const mail = { id: 'mail.list_messages', version: '0.2.0' };
      expect(parseTokenRequest(h.tokenBody(d.delegationId, { kind: 'tool', path: '/api/clio/tools/mail.list_messages',
        operation: mail, argumentsSha256: sha('a'), correlationSha256: sha('correlation') }), d.delegationId).operation).toEqual(mail);
      expect(() => parseTokenRequest(h.tokenBody(d.delegationId, { kind: 'tool', path: '/api/clio/tools/mail.list_messages',
        operation: mail, argumentsSha256: sha('a') }), d.delegationId)).toThrow();
      expect(() => parseTokenRequest(h.tokenBody(d.delegationId, { kind: 'tool', path: '/api/clio/tools/query_tasks',
        operation: { id: 'query_tasks', version: '0.2.0' }, argumentsSha256: sha('a'),
        correlationSha256: sha('correlation') }), d.delegationId)).toThrow();
      expect(() => parseTokenRequest(h.tokenBody(d.delegationId, { kind: 'tool', path: '/api/clio/tools/mail..list_messages',
        operation: { id: 'mail..list_messages', version: '0.2.0' }, argumentsSha256: sha('a') }), d.delegationId)).toThrow();
      expect(() => parseTokenRequest(h.tokenBody(d.delegationId, { kind: 'tool', path: '/api/clio/tools/update_task',
        operation: { id: 'update_task', version: '0.2.0' }, argumentsSha256: sha('a') }), d.delegationId)).not.toThrow();
      await expect(h.issue(d.delegationId, { kind: 'tool', path: '/api/clio/tools/update_task', operation: { id: 'update_task', version: '0.2.0' },
        argumentsSha256: sha('a') })).rejects.toBeInstanceOf(ForbiddenException);
      expect(MERI_DELEGATED_READ_TOOLS.has('update_task')).toBe(false);
      await expect(h.issue(d.delegationId, { kind: 'mode', path: '/api/clio/application-authority/read-mode-observation',
        operation: { id: 'search_federal_awards', version: '0.2.0' }, toolRequestSha256: sha('req') })).rejects.toThrow();
    });

    it('enforces the per-kind ceiling (current 35) and keeps it after a failure (atomic rollback)', async () => {
      const h = harness();
      const d = await h.create();
      for (let i = 0; i < 35; i++) await h.issue(d.delegationId);
      await expect(h.issue(d.delegationId)).rejects.toMatchObject({ status: 429 });
      expect(h.db.state.slots.get(`${R}|call-1`)!.current_tokens).toBe(35);
      expect(h.db.state.tokens.size).toBe(35);
    });

    it('supersedes an unconsumed token on a lost-response retry without spending, at most twice per kind', async () => {
      const h = harness();
      const d = await h.create();
      const first = h.tokenBody(d.delegationId);
      const digest = canonicalSha256({ ...first, retryOf: null });
      await h.issue(d.delegationId);
      await h.issue(d.delegationId, { retryOf: digest });
      await h.issue(d.delegationId, { retryOf: digest });
      const slot = h.db.state.slots.get(`${R}|call-1`)!;
      expect([slot.current_tokens, slot.reissues]).toEqual([1, 2]);
      expect([...h.db.state.tokens.values()].filter((t) => t.superseded_at).length).toBe(2);
      await expect(h.issue(d.delegationId, { retryOf: digest })).rejects.toMatchObject({ status: 429 });
      await expect(h.issue(d.delegationId, { retryOf: sha('not-the-digest') })).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('never re-issues a consumed token', async () => {
      const h = harness();
      const d = await h.create();
      const t = await h.issue(d.delegationId);
      const body = { schemaVersion: 1, conversation: false };
      await h.use(delegationPath(d.delegationId, 'current'), t.token, body);
      const digest = canonicalSha256({ ...h.tokenBody(d.delegationId), retryOf: null });
      await expect(h.issue(d.delegationId, { retryOf: digest })).rejects.toBeInstanceOf(ConflictException);
    });
  });

  describe('use, release and the current receipt', () => {
    const body = { schemaVersion: 1, conversation: false };
    async function admitted() {
      const h = harness();
      const d = await h.create();
      const t = await h.issue(d.delegationId);
      return { h, d, t, path: delegationPath(d.delegationId, 'current') };
    }

    it('admits the token once on its exact target, builds the context from the delegation and never reaches Clerk', async () => {
      const { h, d, t, path } = await admitted();
      const used = await h.use(path, t.token, body);
      expect(used.next).toHaveBeenCalledTimes(1);
      expect(used.ctx).toEqual(ctx);
      expect(meriReadDelegationOf(used.req)).toMatchObject({ delegationId: d.delegationId, kind: 'current', clientId: C,
        binding, policyRevision: P });
      expect(h.verify).not.toHaveBeenCalled();
      expect(h.db.state.writes.filter((w) => w !== 'delegation')).toEqual(['consume']);
      await expect(h.use(path, t.token, body)).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('withholds token issue, use and release after the original ADMITTED grant is revoked', async () => {
      const { h, d, t, path } = await admitted();
      h.db.state.originalGrantState = 'REVOKED';
      await expect(h.issue(d.delegationId, { callKey: 'call-2' })).rejects.toBeInstanceOf(ConflictException);
      await expect(h.use(path, t.token, body)).rejects.toBeInstanceOf(ConflictException);
      expect([...h.db.state.tokens.values()][0]!.consumed_at).toBeNull();
      h.db.state.originalGrantState = 'ACTIVE';
      const used = await h.use(path, t.token, body);
      h.db.state.originalGrantState = 'REVOKED';
      await expect(assertMeriReadDelegationReleasable(h.db.prisma, used.req)).rejects.toBeInstanceOf(ConflictException);
    });

    it.each([
      ['another body', { body: { schemaVersion: 1, conversation: true } }, ForbiddenException],
      ['a query string', { url: 'QUERY' }, ForbiddenException],
      ['another method', { method: 'PUT' }, ForbiddenException],
      ['no service identity', { secret: null }, ForbiddenException],
      ['an impersonation header', { headers: { 'x-capiro-impersonate-tenant': 'other' } }, ForbiddenException],
    ])('refuses %s before consuming the token', async (_name, variant: any, type) => {
      const { h, t, path } = await admitted();
      const url = variant.url === 'QUERY' ? `${path}?x=1` : undefined;
      await expect(h.use(path, t.token, variant.body ?? body, { ...variant, url })).rejects.toBeInstanceOf(type);
      expect([...h.db.state.tokens.values()][0]!.consumed_at).toBeNull();
    });

    it('refuses the token on any other route, including identity, context and membership', async () => {
      const { h, t } = await admitted();
      for (const leaf of ['identity', 'context', 'membership']) {
        await expect(h.use(`/api/clio/application-authority/${leaf}`, t.token, body)).rejects.toBeInstanceOf(ForbiddenException);
      }
      expect(h.verify).not.toHaveBeenCalled();
    });

    it('refuses a forged, re-signed or expired token', async () => {
      const { h, t, path } = await admitted();
      const [hd, pl, sg] = t.token.split('.');
      const forged = `${hd}.${Buffer.from(Buffer.from(pl!, 'base64url').toString().replace(C, C2)).toString('base64url')}.${sg}`;
      await expect(h.use(path, forged, body)).rejects.toBeInstanceOf(UnauthorizedException);
      h.db.state.now += 61_000;
      jest.useFakeTimers({ now: Date.now() + 61_000, doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
      try { await expect(h.use(path, t.token, body)).rejects.toBeInstanceOf(UnauthorizedException); } finally { jest.useRealTimers(); }
    });

    it('serves the current receipt with only the delegated client, then refuses on revocation or a terminal run', async () => {
      const { h, d, t, path } = await admitted();
      const used = await h.use(path, t.token, body);
      const receipt = await h.service.current(verified(used.req), used.ctx, d.delegationId, body, control);
      expect(Object.keys(receipt).sort()).toEqual(['actorRole', 'checkedAtMs', 'clientIds', 'delegationId', 'expiresAtMs', 'identityRevision',
        'membershipRevision', 'principal', 'schemaVersion'].sort());
      expect(receipt.clientIds).toEqual([C]);
      expect(receipt.principal).toEqual({ tenantId: T, actorId: A });
      expect(receipt.expiresAtMs).toBeLessThanOrEqual(d.expiresAtMs);
      // A run that goes terminal during the handler withholds the result.
      h.db.state.facts.run_state = 'cancelled';
      await expect(assertMeriReadDelegationReleasable(h.db.prisma, used.req)).rejects.toBeInstanceOf(ConflictException);
      h.db.state.facts.run_state = 'running';
      await h.service.revoke(verified(request('/x')), d.delegationId, { schemaVersion: 1, reason: 'run_terminal' });
      await expect(assertMeriReadDelegationReleasable(h.db.prisma, used.req)).rejects.toBeInstanceOf(ConflictException);
      expect((await h.service.revoke(verified(request('/x')), d.delegationId, { schemaVersion: 1, reason: 'cancelled' })).state).toBe('revoked');
    });

    it('builds the BD conversation block from the context owners and refuses a conversation for another client', async () => {
      const h = harness();
      const d = await h.create();
      const withConversation = { schemaVersion: 1, conversation: true };
      const t = await h.issue(d.delegationId, { bodySha256: currentBodySha256(true) });
      const used = await h.use(delegationPath(d.delegationId, 'current'), t.token, withConversation);
      const receipt = await h.service.current(verified(used.req), used.ctx, d.delegationId, withConversation, control);
      expect((receipt as any).conversation).toMatchObject({ conversationId: V, selectedClientId: C });
      h.db.state.facts.conversation_client = C2;
      const t2 = await h.issue(d.delegationId, { bodySha256: currentBodySha256(true) });
      const used2 = await h.use(delegationPath(d.delegationId, 'current'), t2.token, withConversation);
      await expect(h.service.current(verified(used2.req), used2.ctx, d.delegationId, withConversation, control)).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('refuses the receipt when the member leaves or the client stops being visible', async () => {
      const { h, d, t, path } = await admitted();
      const used = await h.use(path, t.token, body);
      h.db.state.visible = [C2];
      await expect(h.service.current(verified(used.req), used.ctx, d.delegationId, body, control)).rejects.toBeInstanceOf(HttpException);
      await expect(assertMeriReadDelegationReleasable(h.db.prisma, used.req)).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('expires with the delegation (410) even while the token is live', async () => {
      const { h, t, path } = await admitted();
      h.db.state.facts.admitted_until_offset = 0;
      await expect(h.use(path, t.token, body)).rejects.toBeInstanceOf(GoneException);
    });
  });

  describe('routing predicates and tool selectors', () => {
    it('admits only the exact bearer-less service POSTs', () => {
      const id = randomUUID();
      const ok = (p: string, headers: Record<string, string> = {}) => isMeriReadDelegationServicePost(request(p, { headers, secret: null }));
      expect(ok('/api/clio/application-authority/read-delegations')).toBe(true);
      expect(ok(`/api/clio/application-authority/read-delegations/${id}/tokens`)).toBe(true);
      expect(ok(`/api/clio/application-authority/read-delegations/${id}/revocations`)).toBe(true);
      expect(ok(`/api/clio/application-authority/read-delegation-consents/${id}/state`)).toBe(true);
      expect(ok(`/api/clio/application-authority/read-delegations/${id}/current`)).toBe(false);
      expect(ok('/api/clio/application-authority/read-delegation-consents')).toBe(false);
      expect(ok('/api/clio/application-authority/read-delegations', { authorization: 'Bearer x' })).toBe(false);
      expect(isMeriReadTokenRequest(request('/x', { authorization: 'capiromeriread a.b.c' }))).toBe(true);
      expect(isMeriReadTokenRequest(request('/x', { authorization: 'Bearer a.b.c' }))).toBe(false);
    });

    it('requires every client and conversation selector to name the delegated ones, and a declared client selector to be present', () => {
      const g = { clientId: C, conversationId: V };
      expect(() => assertDelegatedToolSelectors({ clientId: C, query: 'x' }, g, ['clientId'])).not.toThrow();
      expect(() => assertDelegatedToolSelectors({ clientId: C2 }, g, ['clientId'])).toThrow(ForbiddenException);
      expect(() => assertDelegatedToolSelectors({ filters: { client_ids: [C, C2] } }, g, [])).toThrow(ForbiddenException);
      expect(() => assertDelegatedToolSelectors({ clientId: 'Acme Corp' }, g, ['clientId'])).toThrow(ForbiddenException);
      expect(() => assertDelegatedToolSelectors({ conversationId: randomUUID() }, g, [])).toThrow(ForbiddenException);
      expect(() => assertDelegatedToolSelectors({ query: 'x' }, g, ['clientId'])).toThrow(ForbiddenException);
      expect(() => assertDelegatedToolSelectors({ query: 'x' }, g, [])).not.toThrow();
      expect(schemaClientSelectors({ properties: { clientId: {}, query: {} } })).toEqual(['clientId']);
    });
  });
});
