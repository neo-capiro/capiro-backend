import type { PrismaService } from '../../prisma/prisma.service.js';
import { createPrismaObjectiveAdmissionSource, OBJECTIVE_ADMISSION_TARGET_PATH,
  type ObjectiveAdmissionSourceHint } from './objective-workload-admission-source.js';
import { OBJECTIVE_GENERATION_WORKER_SUBJECT, OBJECTIVE_STRATEGY_AUDIENCE } from './objective-workload-jwt.js';

// Actual native resolver/query + audit composition. Only row persistence is
// synthetic; this suite neither executes SQL nor establishes production RLS.
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const hint = (): ObjectiveAdmissionSourceHint => ({ generationJobId: id(1), operationId: id(2),
  callerIssuer: 'urn:capiro:worker:test:v1', callerSubject: OBJECTIVE_GENERATION_WORKER_SUBJECT,
  issuanceRequestSha256: 'a'.repeat(64) });
const row = () => ({ generationJobId: id(1), tenantId: id(3), clientId: id(4), objectiveId: id(5),
  delegationRef: id(6), consentId: id(7), clerkUserId: 'user_original', workAction: 'objective.strategy.draft',
  serviceSubject: OBJECTIVE_GENERATION_WORKER_SUBJECT, audience: OBJECTIVE_STRATEGY_AUDIENCE });
function harness() {
  const f = { rows: [row()] as any[], decisions: [] as any[], committedAudits: [] as any[], auditFailure: false,
    afterQuery: null as (() => void) | null };
  const query = jest.fn(async (parts: TemplateStringsArray, ...values: unknown[]) => {
    const sql = parts.join('?');
    if (sql.includes('FROM sp_draft_job')) {
      expect(values).toEqual([id(1)]); const rows = f.rows; f.afterQuery?.(); return rows;
    }
    expect(sql).toContain('FROM client_objective_workload_issue_decisions'); expect(values).toEqual([id(2)]);
    return f.decisions;
  });
  const audit = jest.fn(async ({ data }: { data: any }) => {
    if (f.auditFailure) throw Error('Synthetic audit failure'); return data;
  });
  const system = jest.fn(async (run: (tx: any) => Promise<any>, options: unknown) => {
    expect(options).toEqual({ timeoutMs: 3000 });
    const start = audit.mock.calls.length;
    const result = await run({ $queryRaw: query, auditLog: { create: audit } });
    f.committedAudits.push(...audit.mock.calls.slice(start).map(([value]) => value.data)); return result;
  });
  const prisma = { withSystem: system } as unknown as Pick<PrismaService, 'withSystem'>;
  return { f, query, audit, system, read: createPrismaObjectiveAdmissionSource(prisma, { enabled: true }),
    disabled: createPrismaObjectiveAdmissionSource(prisma) };
}
describe('native Objective admission routing source', () => {
  it('defaults off before system lookup or audit', async () => {
    const h = harness(); await expect(h.disabled(hint())).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    expect(h.system).not.toHaveBeenCalled(); expect(h.audit).not.toHaveBeenCalled();
  });
  it('derives exact selector/target from one joined native scope and audits that scope atomically', async () => {
    const h = harness(), source = await h.read(hint());
    expect(source.selector).toEqual({ tenantId: id(3), delegationRef: id(6), consentId: id(7), generationJobId: id(1), phase: 'admit' });
    expect(source.binding).toEqual({ subject: OBJECTIVE_GENERATION_WORKER_SUBJECT, audience: OBJECTIVE_STRATEGY_AUDIENCE,
      method: 'POST', path: OBJECTIVE_ADMISSION_TARGET_PATH, query: '',
      body: Buffer.from(JSON.stringify({ schemaVersion: 1, generationJobId: id(1) })), operation: 'objective.strategy.draft',
      phase: 'admit', tenantId: id(3), generationJobId: id(1), delegationRef: id(6), consentId: id(7),
      attemptId: null, runId: null, acceptedBindingSha256: null, sourceSha256: null });
    expect(h.f.committedAudits).toEqual([{ tenantId: id(3), actorUserId: null, actorRole: OBJECTIVE_GENERATION_WORKER_SUBJECT,
      action: 'objective_workload_admission_scope_resolved', entityType: 'strategy_draft_job', entityId: id(1) }]);
    const sql = h.query.mock.calls[0]![0].join('?');
    expect(sql).toContain('d.generation_job_id=j.id'); expect(sql).toContain('d.tenant_id=j.tenant_id');
    expect(sql).toContain('d.client_id=j.client_id'); expect(sql).toContain('d.clerk_user_id=j.owner_user_id');
    expect(sql).toContain('LIMIT 2'); expect(sql).not.toMatch(/INSERT|UPDATE|FOR SHARE|enabled\s*=/);
  });
  it.each(['unknown', 'ambiguous', 'wrong job', 'wrong subject', 'wrong audience', 'newline uuid', 'getter'])
  ('refuses %s native routing without a successful audit or invented tenant', async fault => {
    const h = harness();
    if (fault === 'unknown') h.f.rows = [];
    if (fault === 'ambiguous') h.f.rows.push(row());
    if (fault === 'wrong job') h.f.rows[0].generationJobId = id(99);
    if (fault === 'wrong subject') h.f.rows[0].serviceSubject = 'capiro-objective-terminal-accountant:v1';
    if (fault === 'wrong audience') h.f.rows[0].audience = 'capiro:other:v1';
    if (fault === 'newline uuid') h.f.rows[0].tenantId += '\n';
    const getter = jest.fn();
    if (fault === 'getter') Object.defineProperty(h.f.rows[0], 'tenantId', { enumerable: true, get: getter });
    await expect(h.read(hint())).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    expect(h.f.committedAudits).toEqual([]); expect(h.audit).not.toHaveBeenCalled(); expect(getter).not.toHaveBeenCalled();
  });
  it('does not return a source when audit persistence fails', async () => {
    const h = harness(); h.f.auditFailure = true;
    await expect(h.read(hint())).rejects.toThrow('Synthetic audit failure'); expect(h.f.committedAudits).toEqual([]);
  });
  it.each(['tenant', 'job', 'caller', 'raw hash', 'phase'])('rejects an existing operation rerouted by %s', async fault => {
    const h = harness(), proof = hint();
    const decision: any = { operationId: proof.operationId, callerIssuer: proof.callerIssuer,
      callerSubject: proof.callerSubject, requestSha256: proof.issuanceRequestSha256,
      decision: 'issued', tenantId: id(3), generationJobId: id(1), phase: 'admit' };
    if (fault === 'tenant') decision.tenantId = id(90);
    if (fault === 'job') decision.generationJobId = id(91);
    if (fault === 'caller') decision.callerIssuer = 'urn:other:v1';
    if (fault === 'raw hash') decision.requestSha256 = 'b'.repeat(64);
    if (fault === 'phase') decision.phase = 'publish';
    h.f.decisions = [decision]; await expect(h.read(proof)).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    expect(h.audit).not.toHaveBeenCalled();
  });
  it.each(['issued', 'denied'])('lets the durable issuer handle a matching %s operation fence', async decision => {
    const h = harness(), proof = hint(); h.f.decisions = [{ operationId: proof.operationId, callerIssuer: proof.callerIssuer,
      callerSubject: proof.callerSubject, requestSha256: proof.issuanceRequestSha256,
      decision, tenantId: id(3), generationJobId: decision === 'issued' ? id(1) : null, phase: decision === 'issued' ? 'admit' : null }];
    expect((await h.read(proof)).selector.tenantId).toBe(id(3)); expect(h.f.committedAudits).toHaveLength(1);
  });
  it('pins the authenticated routing scalars before the first system await', async () => {
    const h = harness(), proof = hint(); h.f.afterQuery = () => {
      (proof as any).operationId = id(99); (proof as any).generationJobId = id(98); (proof as any).callerIssuer = 'changed';
    };
    expect((await h.read(proof)).selector.generationJobId).toBe(id(1));
    expect(h.query.mock.calls[1]![1]).toBe(id(2));
  });
  it.each(['tenantId', 'newline', 'reader', 'proxy'])('rejects invalid verified routing hint %s before system access', async fault => {
    const h = harness(); let proof: any = hint();
    if (fault === 'tenantId') proof.tenantId = id(3);
    if (fault === 'newline') proof.operationId += '\n';
    if (fault === 'reader') proof.callerSubject = 'capiro-objective-core-result-reader:v1';
    if (fault === 'proxy') proof = new Proxy(proof, {});
    await expect(h.read(proof)).rejects.toMatchObject({ code: 'UNAVAILABLE' }); expect(h.system).not.toHaveBeenCalled();
  });
});
