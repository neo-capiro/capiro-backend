import { constants, createHash, generateKeyPairSync, sign } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import { createObjectiveAdmissionIngress, type ObjectiveAdmissionHttpRequest } from './objective-workload-admission-ingress.js';
import { createPrismaObjectiveAdmissionSource, type ObjectiveAdmissionSource, type ObjectiveAdmissionSourceHint } from './objective-workload-admission-source.js';
import { OBJECTIVE_WORKLOAD_PROOF_TYPE, OBJECTIVE_WORKLOAD_PROOF_AUDIENCE, OBJECTIVE_WORKLOAD_PROOF_PATH } from './objective-workload-proof.js';
import { OBJECTIVE_GENERATION_WORKER_SUBJECT, OBJECTIVE_STRATEGY_AUDIENCE,
  verifyObjectiveWorkloadJwt, type ObjectiveWorkloadRequestBinding } from './objective-workload-jwt.js';
import { ObjectiveCurrentSourceUnavailable } from './objective-workload-current.js';
import { createPrismaObjectiveIssuancePort } from './objective-workload-issuance-prisma.js';
import type { PrismaService } from '../../prisma/prisma.service.js';
import type { CurrentObjectiveIssuanceSource, ObjectiveIssuanceTransactionPort,
  ObjectiveWorkloadIssueDecisionRecord, ObjectiveWorkloadIssuanceRecord,
  ObjectiveWorkloadDeliveryRecord, ObjectiveWorkloadProofUseRecord } from './objective-workload-issuance.js';

// Actual proof verifier, source resolver, durable issuer and final JWT verifier.
// Native rows/transactions/current-source observations remain explicitly
// synthetic; this suite establishes no enabled delegation, DB grants or RLS.
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const NOW = 1_800_000_000, JOB = id(1), OP = id(2), TENANT = id(3), CONSENT = id(7);
const callerIssuer = 'urn:capiro:worker:test:v1', coreIssuer = 'urn:capiro:core:test:v1';
const caller = generateKeyPairSync('rsa', { modulusLength: 3072 });
const core = generateKeyPairSync('rsa', { modulusLength: 3072 });
const sha = (value: Uint8Array) => createHash('sha256').update(value).digest('hex');
const bodyFor = (jobId = JOB, operationId = OP) => Buffer.from(JSON.stringify({ schemaVersion: 1,
  operationId, generationJobId: jobId, phase: 'admit' }));
function request(body = bodyFor(), subject = OBJECTIVE_GENERATION_WORKER_SUBJECT, proofJti = id(100)): ObjectiveAdmissionHttpRequest {
  const parsed = JSON.parse(body.toString('utf8').replace(/^\uFEFF/, ''));
  const claims = { iss: callerIssuer, sub: subject, aud: OBJECTIVE_WORKLOAD_PROOF_AUDIENCE,
    iat: NOW, nbf: NOW, exp: NOW + 30, jti: proofJti, operationId: parsed.operationId,
    method: 'POST', path: OBJECTIVE_WORKLOAD_PROOF_PATH, query: '', bodySha256: sha(body) };
  const text = `${Buffer.from(JSON.stringify({ alg: 'RS256', typ: OBJECTIVE_WORKLOAD_PROOF_TYPE, kid: 'worker-test-1' })).toString('base64url')}.` +
    Buffer.from(JSON.stringify(claims)).toString('base64url');
  const token = `${text}.${sign('RSA-SHA256', Buffer.from(text, 'ascii'),
    { key: caller.privateKey, padding: constants.RSA_PKCS1_PADDING }).toString('base64url')}`;
  return { method: 'POST', originalUrl: OBJECTIVE_WORKLOAD_PROOF_PATH, authorization: `Bearer ${token}`, rawBody: body };
}
function harness() {
  const f = { routeTenant: TENANT, routeJob: JOB, current: true, commitLostAt: 0, txCount: 0,
    afterResolve: null as (() => void) | null, deferred: null as Promise<void> | null };
  let state = { decisions: [] as ObjectiveWorkloadIssueDecisionRecord[], issuances: [] as ObjectiveWorkloadIssuanceRecord[],
    deliveries: [] as ObjectiveWorkloadDeliveryRecord[], proofs: [] as ObjectiveWorkloadProofUseRecord[] };
  const events: string[] = [], audits: any[] = [];
  const nativeQuery = jest.fn(async (parts: TemplateStringsArray, ...values: unknown[]) => {
    const sql = parts.join('?');
    if (sql.includes('FROM sp_draft_job')) return values[0] === f.routeJob ? [{ generationJobId: f.routeJob,
      tenantId: f.routeTenant, clientId: id(4), objectiveId: id(5), delegationRef: id(6), consentId: CONSENT,
      clerkUserId: 'user_original', workAction: 'objective.strategy.draft', serviceSubject: OBJECTIVE_GENERATION_WORKER_SUBJECT,
      audience: OBJECTIVE_STRATEGY_AUDIENCE }] : [];
    const d = state.decisions.find(row => row.operationId === values[0]);
    return d ? [{ operationId: d.operationId, callerIssuer: d.callerIssuer, callerSubject: d.callerSubject,
      requestSha256: d.issuanceRequestSha256, decision: d.decision, tenantId: d.tenantId,
      generationJobId: d.generationJobId, phase: d.phase }] : [];
  });
  const source = createPrismaObjectiveAdmissionSource({ withSystem: async (run: any) => {
    events.push('native-routing'); return run({ $queryRaw: nativeQuery, auditLog: { create: async ({ data }: any) => { audits.push(data); } } });
  } } as unknown as Pick<PrismaService, 'withSystem'>, { enabled: true });
  const resolve = jest.fn(async (hint: ObjectiveAdmissionSourceHint) => {
    const found = await source(hint); f.afterResolve?.(); if (f.deferred) await f.deferred; return found;
  });
  const port: ObjectiveIssuanceTransactionPort = {
    withTenantTransaction: async (tenantId, run) => {
      events.push('issuance-tx'); f.txCount++; const draft = structuredClone(state);
      const value = await run({
        lockOperation: async () => { events.push('operation-lock'); },
        findDecision: async operationId => draft.decisions.find(row => row.operationId === operationId && row.tenantId === tenantId) ?? null,
        insertDecision: async row => { if (draft.decisions.some(saved => saved.operationId === row.operationId)) throw Error('Synthetic global PK'); draft.decisions.push(row); },
        findIssuance: async operationId => draft.issuances.find(row => row.operationId === operationId && row.tenantId === tenantId) ?? null,
        insertIssuance: async row => { draft.issuances.push(row); },
        findDelivery: async operationId => draft.deliveries.find(row => row.operationId === operationId && row.tenantId === tenantId) ?? null,
        insertDelivery: async row => { draft.deliveries.push(row); },
        finalizeDelivery: async (operationId, status, tokenSha256) => {
          const row = draft.deliveries.find(row => row.operationId === operationId)!;
          Object.assign(row, { state: status, tokenSha256 });
        },
        findProofUse: async (issuer, jti) => draft.proofs.find(row => row.callerIssuer === issuer && row.proofJti === jti) ?? null,
        insertProofUse: async row => { draft.proofs.push(row); },
      });
      state = draft;
      if (f.commitLostAt === f.txCount) throw Error('Synthetic committed lost response');
      return value;
    },
    loadCurrent: async (_tx, selector) => {
      events.push('current-source');
      if (!f.current || selector.tenantId !== f.routeTenant || selector.generationJobId !== f.routeJob)
        throw new ObjectiveCurrentSourceUnavailable();
      return { enabled: true, databaseNowSeconds: NOW, validUntilSeconds: NOW + 45,
        tenantId: f.routeTenant, clientId: id(4), objectiveId: id(5), workAction: 'objective.strategy.draft',
        controlId: id(8), consentId: CONSENT, generationJobId: f.routeJob, delegationRef: id(6),
        serviceSubject: OBJECTIVE_GENERATION_WORKER_SUBJECT, audience: OBJECTIVE_STRATEGY_AUDIENCE,
        sourceSha256: null } satisfies CurrentObjectiveIssuanceSource;
    },
  };
  const signer = { issuer: coreIssuer, kid: 'core-test-1', privateKey: core.privateKey };
  const pins = { active: jest.fn(() => signer), byKid: jest.fn(() => signer) };
  const callerKeys = { 'worker-test-1': { issuer: callerIssuer, subject: OBJECTIVE_GENERATION_WORKER_SUBJECT, publicKey: caller.publicKey } };
  const options = { enabled: true, callerKeys, nowSeconds: () => NOW };
  const ingress = createObjectiveAdmissionIngress(resolve, port, pins, options);
  return { f, resolve, nativeQuery, pins, signer, events, audits, port, options, ingress, state: () => state };
}

describe('admit-only raw Objective workload ingress', () => {
  it('authenticates exact raw proof, resolves/audits native scope, and releases the actual durable JWT', async () => {
    const h = harness(), raw = request(), result = await h.ingress(raw), stored = h.state();
    expect(stored.decisions).toHaveLength(1); expect(stored.issuances).toHaveLength(1);
    expect(stored.deliveries[0]!.state).toBe('issued'); expect(h.audits).toHaveLength(1);
    const target = h.resolve.mock.results[0]!; expect(target.type).toBe('return');
    const source = await target.value;
    const claims = verifyObjectiveWorkloadJwt(result.token, source.binding,
      { issuer: coreIssuer, audience: OBJECTIVE_STRATEGY_AUDIENCE, publicKeys: { 'core-test-1': core.publicKey }, nowSeconds: NOW });
    expect(claims.tenantId).toBe(TENANT); expect(claims.jti).toBe(result.authorizationJti);
    expect(stored.issuances[0]!.issuanceRequestSha256).toBe(sha(raw.rawBody));
    expect(claims.bodySha256).toBe(sha(source.binding.body)); expect(claims.bodySha256).not.toBe(sha(raw.rawBody));
    expect(h.events.indexOf('native-routing')).toBeLessThan(h.events.indexOf('issuance-tx'));
  });
  it('replays only the original issued token/JTI with a fresh authenticated proof', async () => {
    const h = harness(), first = await h.ingress(request()), second = await h.ingress(request(bodyFor(), undefined, id(101)));
    expect(second).toEqual(first); expect(h.state().issuances).toHaveLength(1); expect(h.state().proofs).toHaveLength(2);
    expect(h.pins.active).toHaveBeenCalledTimes(1);
  });
  it('a committed lost claim reply remains uncertain and cannot sign/reallocate on retry', async () => {
    const h = harness(); h.f.commitLostAt = 1;
    await expect(h.ingress(request())).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    expect(h.state().deliveries[0]!.state).toBe('claimed'); expect(h.pins.byKid).not.toHaveBeenCalled();
    await expect(h.ingress(request(bodyFor(), undefined, id(101)))).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    expect(h.state().issuances).toHaveLength(1); expect(h.pins.active).toHaveBeenCalledTimes(1);
    expect(h.pins.byKid).not.toHaveBeenCalled();
  });
  it('rejects known cross-tenant/job operation rerouting before a second issuer allocation', async () => {
    const h = harness(); await h.ingress(request()); h.f.routeTenant = id(30); h.f.routeJob = id(31);
    const before = h.f.txCount;
    await expect(h.ingress(request(bodyFor(id(31)), undefined, id(101)))).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    expect(h.f.txCount).toBe(before); expect(h.pins.active).toHaveBeenCalledTimes(1); expect(h.state().issuances).toHaveLength(1);
  });
  it('rechecks changed source after a successful routing snapshot and commits only a denial', async () => {
    const h = harness(); h.f.afterResolve = () => { h.f.current = false; };
    await expect(h.ingress(request())).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    expect(h.state().decisions[0]!.decision).toBe('denied'); expect(h.state().issuances).toEqual([]);
    expect(h.pins.active).not.toHaveBeenCalled();
  });
  it('matching durable denial cannot revive after native source restoration', async () => {
    const h = harness(); h.f.current = false;
    await expect(h.ingress(request())).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    h.f.current = true;
    await expect(h.ingress(request(bodyFor(), undefined, id(101)))).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    expect(h.state().decisions).toHaveLength(1); expect(h.state().decisions[0]!.decision).toBe('denied');
    expect(h.state().proofs).toHaveLength(2); expect(h.state().issuances).toEqual([]);
    expect(h.pins.active).not.toHaveBeenCalled();
  });
  it('withholds a privately signed token if current authority changes before delivery release', async () => {
    const h = harness(); h.pins.byKid.mockImplementationOnce(() => { h.f.current = false; return h.signer; });
    await expect(h.ingress(request())).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    expect(h.state().deliveries[0]!.state).toBe('unknown'); expect(h.state().deliveries[0]!.tokenSha256).toBeNull();
    h.f.current = true;
    await expect(h.ingress(request(bodyFor(), undefined, id(101)))).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    expect(h.state().issuances).toHaveLength(1); expect(h.pins.active).toHaveBeenCalledTimes(1);
  });
  it('composes the actual disabled Prisma issuer port without manufacturing a current-source grant', async () => {
    const h = harness(), statements: Array<{ sql: string; values: unknown[] }> = [];
    const native = {
      $queryRaw: async (parts: TemplateStringsArray, ...values: unknown[]) => {
        const sql = parts.join('?'); statements.push({ sql, values });
        return sql.includes('pg_advisory_xact_lock') ? [{ locked: '' }] : [];
      },
      $executeRaw: async (parts: TemplateStringsArray, ...values: unknown[]) => {
        statements.push({ sql: parts.join('?'), values }); return 1;
      },
    };
    const prisma = { withTenant: async (_tenantId: string, run: (tx: typeof native) => Promise<unknown>) => run(native) } as unknown as PrismaService;
    const port = createPrismaObjectiveIssuancePort(prisma, { enabled: false, policyRevision: 'a'.repeat(64) });
    const ingress = createObjectiveAdmissionIngress(h.resolve, port, h.pins, h.options);
    await expect(ingress(request())).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    expect(statements.some(s => s.sql.includes('INSERT INTO client_objective_workload_issue_decisions') && s.values.includes('denied'))).toBe(true);
    expect(statements.some(s => s.sql.includes('INSERT INTO client_objective_workload_issuances'))).toBe(false);
    expect(h.pins.active).not.toHaveBeenCalled();
  });
  it('defaults off before clocks, resolver, native transactions or signer access', async () => {
    const h = harness(), clock = jest.fn(() => NOW);
    const disabled = createObjectiveAdmissionIngress(h.resolve, h.port, h.pins, { nowSeconds: clock });
    await expect(disabled(request())).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    expect(clock).not.toHaveBeenCalled(); expect(h.resolve).not.toHaveBeenCalled(); expect(h.events).toEqual([]);
    expect(h.pins.active).not.toHaveBeenCalled();
  });
  it.each(['wrong method', 'query', 'trailing slash', 'header array', 'header newline', 'corrupt proof', 'reader subject'])
  ('rejects %s before privileged source resolution', async fault => {
    const h = harness(); let raw: any = request();
    if (fault === 'wrong method') raw.method = 'GET';
    if (fault === 'query') raw.originalUrl += '?retry=1';
    if (fault === 'trailing slash') raw.originalUrl += '/';
    if (fault === 'header array') raw.authorization = [raw.authorization];
    if (fault === 'header newline') raw.authorization += '\n';
    if (fault === 'corrupt proof') raw.authorization = raw.authorization.slice(0, -4) + 'AAAA';
    if (fault === 'reader subject') {
      const subject = 'capiro-objective-core-result-reader:v1';
      h.options.callerKeys['worker-test-1'].subject = subject;
      raw = request(bodyFor(), subject);
    }
    await expect(h.ingress(raw)).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    expect(h.resolve).not.toHaveBeenCalled(); expect(h.events).toEqual([]); expect(h.pins.active).not.toHaveBeenCalled();
  });
  it.each(['duplicate', 'whitespace', 'BOM', 'posted tenant', 'accepted phase', 'newline uuid', 'foreign bytes', 'byte getter', 'getter', 'proxy'])
  ('rejects raw ambiguity/input trap %s before any source read', async fault => {
    const h = harness(); let body = bodyFor(), raw: any;
    if (fault === 'duplicate') body = Buffer.from(body.toString().replace('"schemaVersion":1,', '"schemaVersion":1,"schemaVersion":1,'));
    if (fault === 'whitespace') body = Buffer.from(' ' + body.toString());
    if (fault === 'BOM') body = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), body]);
    if (fault === 'posted tenant') body = Buffer.from(body.toString().replace('"phase":"admit"', `"phase":"admit","tenantId":"${TENANT}"`));
    if (fault === 'accepted phase') body = Buffer.from(body.toString().replace('"admit"', '"accept"'));
    if (fault === 'newline uuid') body = Buffer.from(body.toString().replace(`"${OP}"`, JSON.stringify(OP + '\n')));
    raw = request(body); const getter = jest.fn();
    if (fault === 'foreign bytes') raw.rawBody = runInNewContext('new Uint8Array(8)');
    if (fault === 'byte getter') Object.defineProperty(raw.rawBody, 'byteLength', { get: getter });
    if (fault === 'getter') Object.defineProperty(raw, 'rawBody', { enumerable: true, get: getter });
    if (fault === 'proxy') raw = new Proxy(raw, {});
    await expect(h.ingress(raw)).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    expect(h.resolve).not.toHaveBeenCalled(); expect(getter).not.toHaveBeenCalled();
  });
  it('pins raw bytes and request metadata before awaiting authenticated native routing', async () => {
    const h = harness(), raw: any = request(), original = Buffer.from(raw.rawBody);
    let release!: () => void; h.f.deferred = new Promise<void>(done => { release = done; });
    const pending = h.ingress(raw);
    expect(h.resolve).toHaveBeenCalledTimes(1);
    raw.rawBody.fill(0); raw.originalUrl = '/other'; raw.method = 'GET'; raw.authorization = 'changed';
    release(); const result = await pending;
    expect(result.authorizationJti).toBe(h.state().issuances[0]!.authorizationJti);
    expect(h.state().issuances[0]!.issuanceRequestSha256).toBe(sha(original));
  });
  it('unknown native job returns no token, audit or invented permanent denial', async () => {
    const h = harness(); h.f.routeJob = id(99);
    await expect(h.ingress(request())).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    expect(h.state().decisions).toEqual([]); expect(h.audits).toEqual([]); expect(h.pins.active).not.toHaveBeenCalled();
  });
  it('refuses a malformed source target rather than signing an arbitrary endpoint or body', async () => {
    const h = harness(), source: ObjectiveAdmissionSource = { selector: { tenantId: TENANT, delegationRef: id(6),
      consentId: CONSENT, generationJobId: JOB, phase: 'admit' }, binding: {} as ObjectiveWorkloadRequestBinding };
    const invalid = createObjectiveAdmissionIngress(async () => source, h.port, h.pins, h.options);
    await expect(invalid(request())).rejects.toMatchObject({ code: 'UNAVAILABLE' }); expect(h.events).toEqual([]);
  });
});
