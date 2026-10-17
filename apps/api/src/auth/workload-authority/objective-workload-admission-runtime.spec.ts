import { constants, createHash, generateKeyPairSync, sign } from 'node:crypto';
import type { PrismaService } from '../../prisma/prisma.service.js';
import { objectiveRevisionSnapshotHash as digest } from '../../clients/objectives/objective-work-intent.js';
import { createObjectiveAdmissionRuntime, type ObjectiveAdmissionRuntimeBindings } from './objective-workload-admission-runtime.js';
import type { ObjectiveAdmissionHttpRequest } from './objective-workload-admission-ingress.js';
import { OBJECTIVE_GENERATION_WORKER_SUBJECT, OBJECTIVE_STRATEGY_AUDIENCE,
  verifyObjectiveWorkloadJwt, type ObjectiveWorkloadRequestBinding } from './objective-workload-jwt.js';
import { OBJECTIVE_WORKLOAD_PROOF_AUDIENCE, OBJECTIVE_WORKLOAD_PROOF_PATH,
  OBJECTIVE_WORKLOAD_PROOF_TYPE } from './objective-workload-proof.js';

// Real runtime, resolver, native issuance port, current-facts loader, proof and
// JWT factories. ONLY the native transaction/row adapter and RSA keys below
// are fixtures. enabled=true rows cannot exist under the production migration's
// CHECK(enabled=false); these checks prove source composition, not DB or live authority.
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const NOW = 1_800_000_000, MS = NOW * 1000, POLICY = 'a'.repeat(64), TENANT = id(1), JOB = id(4), OP = id(20);
const caller = generateKeyPairSync('rsa', { modulusLength: 3072 });
const core = generateKeyPairSync('rsa', { modulusLength: 3072 });
const callerIssuer = 'urn:capiro:worker:runtime-test:v1', coreIssuer = 'urn:capiro:core:runtime-test:v1';
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
function request(proofJti = id(21)): ObjectiveAdmissionHttpRequest {
  const rawBody = Buffer.from(JSON.stringify({ schemaVersion: 1, operationId: OP, generationJobId: JOB, phase: 'admit' }));
  const payload = { iss: callerIssuer, sub: OBJECTIVE_GENERATION_WORKER_SUBJECT, aud: OBJECTIVE_WORKLOAD_PROOF_AUDIENCE,
    iat: NOW, nbf: NOW, exp: NOW + 30, jti: proofJti, operationId: OP, method: 'POST',
    path: OBJECTIVE_WORKLOAD_PROOF_PATH, query: '', bodySha256: sha(rawBody) };
  const input = `${Buffer.from(JSON.stringify({ alg: 'RS256', typ: OBJECTIVE_WORKLOAD_PROOF_TYPE, kid: 'worker-test-1' })).toString('base64url')}.` +
    Buffer.from(JSON.stringify(payload)).toString('base64url');
  const token = `${input}.${sign('RSA-SHA256', Buffer.from(input, 'ascii'),
    { key: caller.privateKey, padding: constants.RSA_PKCS1_PADDING }).toString('base64url')}`;
  return { method: 'POST', originalUrl: OBJECTIVE_WORKLOAD_PROOF_PATH, authorization: `Bearer ${token}`, rawBody };
}

function fixture() {
  const client = id(2), objective = id(3), requestId = id(5), actor = id(6), member = id(7), consentId = id(8),
    delegationRef = id(9), clerk = 'user_runtime_fixture';
  const typed = { requestId, clientId: client, objective: { objectiveId: objective, objectiveVersion: 1 }, type: 'appropriations' };
  const snapshot = { id: objective, clientId: client, version: 1, status: 'ready', deletedAt: null };
  const fingerprint = digest(typed), snapshotHash = digest(snapshot), requestKey = `objective-v1:${digest([TENANT, clerk, requestId])}`;
  const current: Record<string, Record<string, unknown>> = {
    job: { id: JOB, clientId: client, clerkUserId: clerk, status: 'queued', attempt: 1, claimedBy: null,
      claimedAt: null, strategyId: null, requestKey, input: { objectiveGeneration: { request: typed, fingerprint } }, deadlineAtMs: String(MS + 80_000) },
    hint: { actorUserId: actor, membershipId: member, objectiveVersion: 1 },
    member: { actorUserId: actor, membershipId: member, memoryWall: false },
    objective: { version: 1, status: 'ready', revisionId: id(10) },
    canonical: { id: id(11), strategyId: id(12), projectId: id(13), epoch: 1, bindingVersion: 1,
      intentId: id(14), revisionId: id(10), objectiveVersion: 1, snapshotHash },
    root: { actorUserId: actor, revisionActorUserId: actor, revisionId: id(10), objectiveVersion: 1, snapshotHash,
      purpose: 'objective_strategy_plan', state: 'pending', blockedReason: 'runtime_authority_unconnected', operation: 'confirm_ready', snapshot },
    consent: { controlId: id(15), controlVersion: 1, consentId, actorUserId: actor, membershipId: member,
      rootActorUserId: actor, canonicalPlanId: id(11), canonicalEpoch: 1, strategyId: id(12), projectId: id(13),
      bindingVersion: 1, intentId: id(14), revisionId: id(10), objectiveVersion: 1, snapshotHash,
      policyId: 'capiro.objective-generation-consent', policyRevision: 1, confirmedAtMs: String(MS - 1000),
      expiresAtMs: String(MS + 100_000), configuredMs: '180000', effectiveMs: '180000', expiryValid: true },
    delegation: { ref: delegationRef, clientId: client, objectiveId: objective, action: 'objective.strategy.draft',
      controlId: id(15), consentId, controlVersion: 1, jobId: JOB, requestId, fingerprint, requestKey, clerkUserId: clerk,
      serviceSubject: OBJECTIVE_GENERATION_WORKER_SUBJECT, audience: OBJECTIVE_STRATEGY_AUDIENCE, policyRevision: POLICY,
      issuedAtMs: String(MS - 500), expiresAtMs: String(MS + 90_000), authorityVersion: 1, enabled: true, cancelledAt: null },
    clock: { nowMs: String(MS) },
  };
  type Row = Record<string, unknown>;
  type State = { decisions: Row[]; issuances: Row[]; deliveries: Row[]; proofs: Row[] };
  let state: State = { decisions: [], issuances: [], deliveries: [], proofs: [] };
  const trace: Array<{ scope: string; sql: string; values: unknown[] }> = [], events: string[] = [], audits: unknown[] = [];
  const tables = ['client_objective_workload_issue_decisions', 'client_objective_workload_issuances',
    'client_objective_workload_deliveries', 'client_objective_workload_proof_uses'];
  const fields: Record<string, string[]> = {
    decisions: ['operationId', 'callerIssuer', 'callerSubject', 'issuanceRequestSha256', 'decision', 'tenantId', 'generationJobId', 'phase'],
    issuances: ['operationId', 'tenantId', 'clientId', 'objectiveId', 'workAction', 'controlId', 'consentId', 'generationJobId',
      'delegationRef', 'callerIssuer', 'callerSubject', 'issuanceRequestSha256', 'authorizationJti', 'tokenIssuer', 'tokenSubject',
      'tokenAudience', 'signerKeyId', 'phase', 'targetMethod', 'targetPath', 'targetQuery', 'targetBodySha256', 'attemptId', 'runId',
      'acceptedBindingSha256', 'sourceSha256', 'iatSeconds', 'nbfSeconds', 'expSeconds'],
    proofs: ['tenantId', 'callerIssuer', 'callerSubject', 'callerKeyId', 'proofJti', 'operationId', 'operationDecision', 'proofOutcome',
      'proofRequestSha256', 'proofIatSeconds', 'proofNbfSeconds', 'proofExpSeconds'],
  };
  const names = ['decisions', 'issuances', 'deliveries', 'proofs'] as const;
  const native = (draft: State) => ({
    $queryRaw: async (parts: TemplateStringsArray, ...values: unknown[]) => {
      const sql = parts.join('?'); trace.push({ scope: 'tenant', sql, values });
      if (sql.includes('pg_advisory_xact_lock')) return [{ locked: '' }];
      const tableIndex = tables.findIndex(table => sql.includes(`FROM ${table}`));
      if (tableIndex >= 0) return structuredClone(draft[names[tableIndex]!].filter(row => row.tenantId === values[0] &&
        (tableIndex === 3 ? row.callerIssuer === values[1] && row.proofJti === values[2] : row.operationId === values[1])));
      const key = sql.includes('FROM sp_draft_job') ? 'job' :
        sql.includes('FROM client_objective_work_consents WHERE') ? 'hint' : sql.includes('FROM tenants t JOIN') ? 'member' :
        sql.includes('FROM client_memory_access') ? 'wall' : sql.includes('FROM client_objectives o JOIN') ? 'objective' :
        sql.includes('FROM client_objective_canonical_plans') ? 'canonical' : sql.includes('FROM client_objective_work_intents') ? 'root' :
        sql.includes('FROM client_objective_work_controls') ? 'consent' : sql.includes('FROM client_objective_workload_delegations') ? 'delegation' :
        sql.includes('clock_timestamp()') ? 'clock' : null;
      if (!key) throw Error(`Unexpected fixture SQL: ${sql}`);
      return current[key] ? [structuredClone(current[key])] : [];
    },
    $executeRaw: async (parts: TemplateStringsArray, ...values: unknown[]) => {
      const sql = parts.join('?'); trace.push({ scope: 'tenant', sql, values });
      if (sql.includes('UPDATE client_objective_workload_deliveries')) {
        const row = draft.deliveries.find(saved => saved.tenantId === values[2] && saved.operationId === values[3] && saved.state === 'claimed');
        if (!row) return 0; Object.assign(row, { state: values[0], tokenSha256: values[1] }); return 1;
      }
      const tableIndex = tables.findIndex(table => sql.includes(`INSERT INTO ${table}`));
      if (tableIndex < 0) throw Error(`Unexpected fixture write: ${sql}`);
      const name = names[tableIndex]!;
      draft[name].push(name === 'deliveries' ? { operationId: values[0], tenantId: values[1], authorizationJti: values[2], state: 'claimed', tokenSha256: null } :
        Object.fromEntries(fields[name]!.map((key, index) => [key, values[index]])));
      return 1;
    },
  });
  const prisma = {
    withSystem: async (run: (tx: unknown) => Promise<unknown>) => {
      events.push('routing');
      return run({
        $queryRaw: async (parts: TemplateStringsArray, ...values: unknown[]) => {
          const sql = parts.join('?'); trace.push({ scope: 'system', sql, values });
          if (sql.includes('FROM sp_draft_job')) return [{ generationJobId: JOB, tenantId: TENANT, clientId: client,
            objectiveId: objective, delegationRef, consentId, clerkUserId: clerk, workAction: 'objective.strategy.draft',
            serviceSubject: OBJECTIVE_GENERATION_WORKER_SUBJECT, audience: OBJECTIVE_STRATEGY_AUDIENCE }];
          return state.decisions.filter(row => row.operationId === values[0]).map(row => ({ ...row, requestSha256: row.issuanceRequestSha256 }));
        },
        auditLog: { create: async ({ data }: { data: unknown }) => { audits.push(data); } },
      });
    },
    withTenant: async (tenantId: string, run: (tx: unknown) => Promise<unknown>) => {
      expect(tenantId).toBe(TENANT); events.push('tenant'); const draft = structuredClone(state);
      const result = await run(native(draft)); state = draft; return result;
    },
  } as unknown as PrismaService;
  const signer = { issuer: coreIssuer, kid: 'core-test-1', privateKey: core.privateKey };
  const signerPins = { active: jest.fn(() => signer), byKid: jest.fn(() => signer) };
  const bindings: ObjectiveAdmissionRuntimeBindings = { prisma, signerPins, policyRevision: POLICY, nowSeconds: () => NOW,
    callerKeys: { 'worker-test-1': { issuer: callerIssuer, subject: OBJECTIVE_GENERATION_WORKER_SUBJECT, publicKey: caller.publicKey } } };
  const runtime = createObjectiveAdmissionRuntime({ enabled: true, bindings });
  const target: ObjectiveWorkloadRequestBinding = { subject: OBJECTIVE_GENERATION_WORKER_SUBJECT, audience: OBJECTIVE_STRATEGY_AUDIENCE,
    method: 'POST', path: '/strategy-api/internal/objective-canonical/generation-admissions', query: '',
    body: Buffer.from(JSON.stringify({ schemaVersion: 1, generationJobId: JOB })), operation: 'objective.strategy.draft', phase: 'admit',
    tenantId: TENANT, generationJobId: JOB, delegationRef, consentId, attemptId: null, runId: null, acceptedBindingSha256: null, sourceSha256: null };
  return { runtime, bindings, trace, events, audits, current, signerPins, target, state: () => state };
}

describe('Objective admission production-factory composition', () => {
  it('defaults closed without inspecting bindings or performing any I/O', async () => {
    const getter = jest.fn(() => { throw Error('Disabled bindings were read'); });
    const options = Object.defineProperty({}, 'bindings', { enumerable: true, get: getter });
    await expect(createObjectiveAdmissionRuntime(options)(request())).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    await expect(createObjectiveAdmissionRuntime()(request())).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    expect(getter).not.toHaveBeenCalled();
  });
  it.each(['missing', 'policy', 'clock', 'caller', 'extra', 'accessor'])('closes invalid %s bindings before native or signer access', async fault => {
    const f = fixture(); let bindings: any = { ...f.bindings };
    if (fault === 'missing') bindings = undefined;
    if (fault === 'policy') bindings.policyRevision = 'not-a-policy';
    if (fault === 'clock') bindings.nowSeconds = 1;
    if (fault === 'caller') bindings.callerKeys = {};
    if (fault === 'extra') bindings.tenantId = TENANT;
    if (fault === 'accessor') Object.defineProperty(bindings, 'policyRevision', { enumerable: true, get: () => { throw Error('Accessor'); } });
    await expect(createObjectiveAdmissionRuntime({ enabled: true, bindings })(request())).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    expect(f.trace).toEqual([]); expect(f.signerPins.active).not.toHaveBeenCalled();
  });
  it('calls all actual production factories and current loader before releasing a verifiable fixed-target token', async () => {
    const f = fixture(), result = await f.runtime(request());
    const claims = verifyObjectiveWorkloadJwt(result.token, f.target, { issuer: coreIssuer, audience: OBJECTIVE_STRATEGY_AUDIENCE,
      publicKeys: { 'core-test-1': core.publicKey }, nowSeconds: NOW });
    expect(claims.tenantId).toBe(TENANT); expect(claims.jti).toBe(result.authorizationJti);
    expect(claims.bodySha256).toBe(sha(f.target.body)); expect(claims.exp).toBe(NOW + 60);
    expect(f.events).toEqual(['routing', 'tenant', 'tenant']); expect(f.audits).toHaveLength(1);
    expect(f.state().issuances).toHaveLength(1); expect(f.state().deliveries[0]!.state).toBe('issued');
    expect(f.trace.filter(s => s.sql.includes('FROM client_objective_workload_delegations'))).toHaveLength(4);
    expect(f.trace.some(s => s.sql.includes('FOR UPDATE OF ctl'))).toBe(true);
    expect(f.trace.some(s => s.sql.includes('INSERT INTO client_objective_workload_proof_uses'))).toBe(true);
  });
  it('retains the durable issuer operation/JTI on an exact retry with a fresh named proof', async () => {
    const f = fixture(), first = await f.runtime(request()), replay = await f.runtime(request(id(22)));
    expect(replay).toEqual(first); expect(f.state().issuances).toHaveLength(1); expect(f.state().proofs).toHaveLength(2);
    expect(f.signerPins.active).toHaveBeenCalledTimes(1);
  });
  it('a fixture with a disabled delegation follows the existing denial path and cannot sign', async () => {
    const f = fixture(); f.current.delegation!.enabled = false;
    await expect(f.runtime(request())).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    expect(f.state().decisions[0]!.decision).toBe('denied'); expect(f.state().issuances).toEqual([]);
    expect(f.signerPins.active).not.toHaveBeenCalled();
  });
  it.each(['duplicate-header', 'raw-mutation', 'query'])('rejects %s through the actual ingress before native routing', async fault => {
    const f = fixture(), raw = request();
    const changed = fault === 'duplicate-header' ? { ...raw, authorization: [raw.authorization as string, raw.authorization as string] } :
      fault === 'raw-mutation' ? { ...raw, rawBody: Buffer.concat([raw.rawBody, Buffer.from(' ')]) } : { ...raw, originalUrl: raw.originalUrl + '?x=1' };
    await expect(f.runtime(changed)).rejects.toMatchObject({ code: 'UNAVAILABLE' }); expect(f.trace).toEqual([]);
  });
});
