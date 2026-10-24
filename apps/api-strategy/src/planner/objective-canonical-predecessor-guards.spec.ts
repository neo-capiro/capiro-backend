import type { Prisma } from '../../generated/prisma-client/index.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { CanonicalAuthoritySubject } from './objective-canonical-authority.js';
import { ObjectiveCanonicalApplicationService } from './objective-canonical-application.service.js';
import { applicationHash, canonicalApplicationRequestId,
  type CanonicalApplicationGrant, type CanonicalApplicationRequest } from './objective-canonical-application.js';
import type { PlannerService } from './planner.service.js';

// Actual internal method and actual current native read fence. Synthetic local
// SQL returns no predecessor head: positive predecessor custody/materialization
// is qualified separately. These guard cases open no transaction, HTTP or DB.
const id = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
type Check = (subject: CanonicalAuthoritySubject) => Promise<void>;
function fixture() {
  const canonical = { canonicalPlanId: id(1), tenantId: id(2), clientId: id(3), objectiveId: id(4),
    canonicalStrategyId: id(5), canonicalProjectId: id(6), bindingVersion: 2, epoch: 1,
    requestedIntentId: id(7), requestedObjectiveRevisionId: id(8), requestedObjectiveVersion: 2,
    snapshotHash: 'a'.repeat(64) };
  const request: CanonicalApplicationRequest = { schemaVersion: 1, canonical,
    applicationRequestId: canonicalApplicationRequestId(canonical, id(9)), generationJobId: id(10),
    generationRequestId: id(11), strategyId: id(5), strategyVersionId: id(12),
    objectiveReceiptSha256: 'b'.repeat(64), snapshotDigest: 'c'.repeat(64) };
  const grant: CanonicalApplicationGrant = { tenantId: id(2), actorUserId: id(9), clerkUserId: 'user_original',
    consentId: id(13), controlVersion: 2, requestSha256: applicationHash(request), canonicalSha256: applicationHash(canonical),
    tokenExpiresAtMs: 1, delegationExpiresAtMs: 1, claimExpiresAtMs: 1 };
  const f = { request, grant, scopeChecks: 0, revokeNativeOn: 0 };
  const forbidden = jest.fn(() => { throw Error('Predecessor read must not authenticate HTTP, open a transaction or write'); });
  let tx: Prisma.TransactionClient;
  const execute = jest.fn(async function(this: unknown, strings: TemplateStringsArray, ...values: unknown[]) {
    expect(this).toBe(tx);expect(strings.join('?')).toContain('pg_advisory_xact_lock');
    expect(values).toEqual(['planner:' + canonical.tenantId]);return 1;
  });
  const query = jest.fn(async function(this: unknown, strings: TemplateStringsArray, ...values: unknown[]) {
    expect(this).toBe(tx);const sql = strings.join('?').replace(/\s+/g, ' ');
    expect(sql).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b/);
    if (sql.includes('FROM tenants t JOIN tenant_memberships')) {
      f.scopeChecks++;expect(values).toEqual([canonical.tenantId, id(9), 'user_original', canonical.clientId]);
      return f.revokeNativeOn === f.scopeChecks ? [] : [{ userId: id(9), memoryWall: false }];
    }
    if (sql.includes('FROM client_objectives')) {
      expect(values).toEqual([canonical.tenantId, canonical.clientId, canonical.objectiveId]);return [{ id: canonical.objectiveId }];
    }
    if (sql.includes('FROM sp_strategy')) {
      expect(values).toEqual([canonical.tenantId, canonical.clientId, canonical.canonicalStrategyId]);return [{ id: canonical.canonicalStrategyId }];
    }
    throw Error('Unexpected predecessor guard SQL: ' + sql);
  });
  const headRead = jest.fn(async () => null);
  tx = { $executeRaw: execute, $queryRaw: query, spPlannerResource: {
    findFirst: headRead, create: forbidden, update: forbidden, updateMany: forbidden,
  } } as unknown as Prisma.TransactionClient;
  const service = new ObjectiveCanonicalApplicationService({ canonicalStrategyPlanCreationInTransaction: forbidden, canonicalStrategyPlanObservationInTransaction: forbidden,
      prepareCanonicalStrategyPlanInTransaction: forbidden } as unknown as PlannerService);
  const check = jest.fn(async (subject: CanonicalAuthoritySubject) => {
    expect(subject).toEqual({ purpose: 'retained-result-read', applicationRequestId: request.applicationRequestId,
      requestSha256: applicationHash(request) });
  });
  const run = (current?: Check) => service.readPredecessorWithinOwnerTransaction(tx, request, grant, current!);
  return { ...f, flags: f, tx, execute, query, headRead, forbidden, check, run };
}

describe('canonical predecessor internal read guards (actual service/fence; synthetic native SQL)', () => {
  it('requires a native current-read callback before any locking, SQL or fallback authority', async () => {
    const f = fixture();await expect(f.run()).rejects.toMatchObject({ code: 'AUTHORITY_UNAVAILABLE' });
    expect(f.execute).not.toHaveBeenCalled();expect(f.query).not.toHaveBeenCalled();expect(f.headRead).not.toHaveBeenCalled();
    expect(f.forbidden).not.toHaveBeenCalled();
  });

  it.each(['tenantId', 'actorUserId', 'requestSha256', 'canonicalSha256'] as const)
  ('refuses mismatched grant %s before owner observation or current-read callback', async field => {
    const f = fixture();f.grant[field] = field.endsWith('Sha256') ? '9'.repeat(64) : id(99);
    await expect(f.run(f.check)).rejects.toMatchObject({ code: 'REQUEST_CONFLICT' });
    expect(f.check).not.toHaveBeenCalled();expect(f.execute).not.toHaveBeenCalled();expect(f.query).not.toHaveBeenCalled();
    expect(f.headRead).not.toHaveBeenCalled();expect(f.forbidden).not.toHaveBeenCalled();
  });

  it('refuses current callback revocation before reading predecessor or native rows', async () => {
    const f = fixture(), error = Error('Synthetic current read revoked');
    f.check.mockRejectedValueOnce(error);await expect(f.run(f.check)).rejects.toBe(error);
    expect(f.execute).toHaveBeenCalledTimes(1);expect(f.check).toHaveBeenCalledTimes(1);
    expect(f.query).not.toHaveBeenCalled();expect(f.headRead).not.toHaveBeenCalled();expect(f.forbidden).not.toHaveBeenCalled();
  });

  it('refuses release callback revocation after the read and leaves every owner write unreachable', async () => {
    const f = fixture(), error = Error('Synthetic current read revoked at release');
    f.check.mockResolvedValueOnce(undefined).mockRejectedValueOnce(error);
    await expect(f.run(f.check)).rejects.toBe(error);
    expect(f.check).toHaveBeenCalledTimes(2);expect(f.headRead).toHaveBeenCalledTimes(1);
    expect(f.flags.scopeChecks).toBe(1);expect(f.query).toHaveBeenCalledTimes(3);expect(f.forbidden).not.toHaveBeenCalled();
  });

  it.each([1, 2])('refuses actual native read-fence revocation on admission %i without writes', async admission => {
    const f = fixture();f.flags.revokeNativeOn = admission;
    await expect(f.run(f.check)).rejects.toMatchObject({ code: 'AUTHORITY_UNAVAILABLE' });
    expect(f.check).toHaveBeenCalledTimes(admission);expect(f.flags.scopeChecks).toBe(admission);
    expect(f.headRead).toHaveBeenCalledTimes(admission - 1);expect(f.forbidden).not.toHaveBeenCalled();
  });
});
