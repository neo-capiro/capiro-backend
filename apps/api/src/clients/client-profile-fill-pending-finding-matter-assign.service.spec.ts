import { BadRequestException } from '@nestjs/common';
import { ClientProfileFillCompletionService } from './client-profile-fill-completion.service.js';
import { ClientAdvocacyMatterService } from './client-advocacy-matter.service.js';

/**
 * §22/23 follow-up: "Attach to Matter X" / "Create new Matter" directly on
 * a still-pending advocacy_record finding. Per the user's own product
 * framing — most users already have a populated client profile and are
 * looking to ENRICH it, not stage a batch for later review — the chosen
 * design is immediate-apply: picking either action IS the human
 * review/approval decision and persists right away, reusing the existing
 * `applyAdvocacyRecord` upsert plus the same `markAccepted` accept/audit
 * path every other applied finding goes through. There is no staging
 * queue, no "save for later" state, and no second application workflow.
 *
 * Uses the real `ClientAdvocacyMatterService` (not a stub) wired to a
 * shared raw tx mock, because the atomicity guarantee under test —
 * record upsert + Matter assign/lock committing in the SAME transaction —
 * lives at the boundary between these two services, not inside either one
 * alone. `ClientProfileFillWorkflowService` / `IntelligenceService` /
 * `ClientFacilitiesService` / `HttpAdapterHost` / `ClientProfileFillService`
 * are untouched by this code path, so they are stubbed to `{}` exactly like
 * the existing CLI-guard spec does for the same constructor.
 */
describe('ClientProfileFillCompletionService.applyAdvocacyFindingToMatter (§22/23 follow-up)', () => {
  const tenantId = '11111111-1111-1111-1111-111111111111';
  const userId = 'user-1';
  const ctx = { tenantId, userId } as never;
  const clientId = '22222222-2222-2222-2222-222222222222';
  const runId = '33333333-3333-3333-3333-333333333333';
  const findingId = '44444444-4444-4444-4444-444444444444';
  const matterId = '55555555-5555-5555-5555-555555555555';
  const otherClientId = '66666666-6666-6666-6666-666666666666';
  const otherTenantId = '77777777-7777-7777-7777-777777777777';

  const externalKey = 'lda:2027-q1-1234';

  function pendingFindingRow(overrides: Partial<Record<string, unknown>> = {}) {
    return {
      id: findingId,
      kind: 'advocacy_record',
      targetKey: 'advocacy_record',
      source: 'lda',
      factKind: 'advocacy',
      currentValue: null,
      proposedValue: {
        externalKey,
        title: 'FY27 autonomous systems funding request',
        recordType: 'federal_lobbying',
        sourceType: 'lda',
        sourceId: 'lda-filing-1',
        activityDate: '2027-01-15',
        status: 'reported',
        summary: 'LDA filing referencing FY27 funding.',
        metadata: {},
      },
      evidence: [],
      confidence: 0.9,
      status: 'pending',
      contentHash: 'hash-1',
      ...overrides,
    };
  }

  function makeHarness() {
    const tx = {
      $queryRawUnsafe: jest.fn(async (_query: string, ..._args: unknown[]) => [] as unknown[]),
      $executeRawUnsafe: jest.fn(async (_query: string, ..._args: unknown[]) => 1),
      auditLog: { create: jest.fn(async () => ({})) },
      client: { findFirst: jest.fn(async () => ({ id: clientId })) },
    };
    const prisma = {
      withTenant: jest.fn(async (_tenantId: string, run: (tenantTx: typeof tx) => Promise<unknown>) => run(tx)),
    };
    const advocacyMatters = new ClientAdvocacyMatterService(prisma as never, {
      listMailThreads: jest.fn(async () => []),
      getOutreachRecord: jest.fn(async () => ({})),
    } as never);
    const service = new ClientProfileFillCompletionService(
      prisma as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      advocacyMatters,
    );
    return { service, tx, prisma };
  }

  describe('attach to an existing Matter', () => {
    test('applies the record, assigns the chosen Matter, locks it, and marks the finding accepted', async () => {
      const { service, tx } = makeHarness();
      tx.$queryRawUnsafe
        .mockResolvedValueOnce(pendingFindingRowsFixture()) // loadFindings
        .mockResolvedValueOnce([{ matterId: null, locked: false }]) // lock check inside assignSpecificMatterForRecord
        .mockResolvedValueOnce([{ id: matterId }]); // target Matter exists

      const result = await service.applyAdvocacyFindingToMatter(ctx, clientId, runId, findingId, { matterId });

      expect(result).toEqual({ findingId, matterId, alreadyApplied: false });

      const recordUpsert = tx.$executeRawUnsafe.mock.calls.find((call) =>
        String(call[0]).includes('INSERT INTO client_advocacy_record'),
      );
      expect(recordUpsert).toBeDefined();
      const matterAssign = tx.$executeRawUnsafe.mock.calls.find((call) =>
        String(call[0]).includes('UPDATE client_advocacy_record') && String(call[0]).includes('matter_locked'),
      );
      expect(matterAssign).toBeDefined();
      expect(matterAssign).toContain(matterId);
      const acceptUpdate = tx.$executeRawUnsafe.mock.calls.find((call) =>
        String(call[0]).includes('client_profile_fill_finding') && String(call[0]).includes("'accepted'"),
      );
      expect(acceptUpdate).toBeDefined();
      expect(acceptUpdate).toContain(findingId);
    });

    function pendingFindingRowsFixture() {
      return [pendingFindingRow()];
    }
  });

  describe('create a new Matter', () => {
    test('creates the Matter, applies/upserts the record into it, locks it, marks accepted, and returns the new Matter id', async () => {
      const { service, tx } = makeHarness();
      tx.$queryRawUnsafe
        .mockResolvedValueOnce([pendingFindingRow()]) // loadFindings
        .mockResolvedValueOnce([{ matterId: null, locked: false }]) // lock check
        .mockResolvedValueOnce([{ id: matterId }]); // the new Matter's INSERT ... RETURNING id

      const result = await service.applyAdvocacyFindingToMatter(ctx, clientId, runId, findingId, {
        newMatter: { title: 'FY27 autonomous systems funding request' },
      });

      expect(result).toEqual({ findingId, matterId, alreadyApplied: false });
      const matterInsert = tx.$queryRawUnsafe.mock.calls[2]!;
      expect(String(matterInsert[0])).toContain('INSERT INTO client_advocacy_matter');
      expect(String(matterInsert[0])).toContain("'planning'");
      // auto_generated is a literal `false` baked into the SQL text (same
      // convention as ClientAdvocacyMatterService.createMatter), not a
      // bound parameter — assert against the query text, not the params.
      expect(matterInsert).toContain('FY27 autonomous systems funding request');
      expect(String(matterInsert[0])).toMatch(/\$6,\s*false,\s*now\(\)/);
    });
  });

  describe('exactly-one-of validation', () => {
    test('rejects when both matterId and newMatter are supplied', async () => {
      const { service } = makeHarness();

      await expect(
        service.applyAdvocacyFindingToMatter(ctx, clientId, runId, findingId, {
          matterId,
          newMatter: { title: 'x' },
        } as never),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('idempotency', () => {
    test('duplicate invocation on an already-accepted finding makes no writes and returns the existing Matter', async () => {
      const { service, tx } = makeHarness();
      tx.$queryRawUnsafe
        .mockResolvedValueOnce([pendingFindingRow({ status: 'accepted' })]) // loadFindings — already accepted
        .mockResolvedValueOnce([{ matterId }]); // lookupAppliedAdvocacyMatterId read

      const result = await service.applyAdvocacyFindingToMatter(ctx, clientId, runId, findingId, { matterId });

      expect(result).toEqual({ findingId, matterId, alreadyApplied: true });
      expect(tx.$executeRawUnsafe).not.toHaveBeenCalled();
    });

    test('a genuine duplicate click race (still pending, but the underlying record is already locked to a Matter) does not create a second Matter or duplicate the record', async () => {
      // Models the retry-after-partial-success case: the first call's
      // record-upsert + Matter-assign transaction committed, but a crash
      // or lost response meant markAccepted never ran, so the finding is
      // still `pending` when the client retries the whole action.
      const { service, tx } = makeHarness();
      tx.$queryRawUnsafe
        .mockResolvedValueOnce([pendingFindingRow()]) // loadFindings — still pending
        .mockResolvedValueOnce([{ matterId, locked: true }]); // lock check — ALREADY locked from the first attempt

      const result = await service.applyAdvocacyFindingToMatter(ctx, clientId, runId, findingId, {
        newMatter: { title: 'FY27 autonomous systems funding request' },
      });

      expect(result).toEqual({ findingId, matterId, alreadyApplied: false });
      // The record upsert itself is safe to re-run (ON CONFLICT), so it
      // still executes — but there must be no SECOND Matter INSERT and no
      // second matter-assign UPDATE beyond the lock-check SELECT.
      const matterInsertCalls = tx.$queryRawUnsafe.mock.calls.filter((call) =>
        String(call[0]).includes('INSERT INTO client_advocacy_matter'),
      );
      expect(matterInsertCalls).toHaveLength(0);
      const matterAssignUpdates = tx.$executeRawUnsafe.mock.calls.filter(
        (call) => String(call[0]).includes('UPDATE client_advocacy_record') && String(call[0]).includes('matter_locked'),
      );
      expect(matterAssignUpdates).toHaveLength(0);
      // markAccepted still runs — the finding transitions to accepted even
      // though the Matter side was already settled by the earlier attempt.
      const acceptUpdate = tx.$executeRawUnsafe.mock.calls.find((call) =>
        String(call[0]).includes('client_profile_fill_finding') && String(call[0]).includes("'accepted'"),
      );
      expect(acceptUpdate).toBeDefined();
    });
  });

  describe('finding-state guards', () => {
    test('rejects a finding that is neither pending nor accepted (e.g. already rejected)', async () => {
      const { service, tx } = makeHarness();
      tx.$queryRawUnsafe.mockResolvedValueOnce([pendingFindingRow({ status: 'rejected' })]);

      await expect(
        service.applyAdvocacyFindingToMatter(ctx, clientId, runId, findingId, { matterId }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(tx.$executeRawUnsafe).not.toHaveBeenCalled();
    });

    test('rejects a non-advocacy finding kind', async () => {
      const { service, tx } = makeHarness();
      tx.$queryRawUnsafe.mockResolvedValueOnce([pendingFindingRow({ kind: 'website' })]);

      await expect(
        service.applyAdvocacyFindingToMatter(ctx, clientId, runId, findingId, { matterId }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(tx.$executeRawUnsafe).not.toHaveBeenCalled();
    });

    test('rejects when the finding is not found for this run/client (also covers cross-tenant/cross-client isolation: loadFindings scopes tenant_id + client_id + run_id)', async () => {
      const { service, tx } = makeHarness();
      tx.$queryRawUnsafe.mockResolvedValueOnce([]); // loadFindings returns nothing — wrong tenant/client/run

      await expect(
        service.applyAdvocacyFindingToMatter(ctx, clientId, runId, findingId, { matterId }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(tx.$executeRawUnsafe).not.toHaveBeenCalled();
    });

    test('loadFindings is scoped by this exact tenantId/clientId/runId — never a cross-tenant or cross-client id', async () => {
      const { service, tx, prisma } = makeHarness();
      tx.$queryRawUnsafe.mockResolvedValueOnce([pendingFindingRow()]).mockResolvedValueOnce([{ matterId: null, locked: false }]).mockResolvedValueOnce([{ id: matterId }]);

      await service.applyAdvocacyFindingToMatter(ctx, clientId, runId, findingId, { matterId });

      // withTenant's first argument is always THIS ctx's tenantId, never a
      // different tenant, and the loadFindings SELECT itself is bound with
      // this exact clientId/runId, not otherClientId/otherTenantId.
      expect(prisma.withTenant).toHaveBeenCalledWith(tenantId, expect.any(Function));
      expect(prisma.withTenant).not.toHaveBeenCalledWith(otherTenantId, expect.any(Function));
      const loadFindingsCall = tx.$queryRawUnsafe.mock.calls[0]!;
      expect(loadFindingsCall).toContain(clientId);
      expect(loadFindingsCall).toContain(runId);
      expect(loadFindingsCall).not.toContain(otherClientId);
    });
  });

  describe('API failure leaves the finding pending, no partial state', () => {
    test('when the Matter-assign step throws inside the transaction, the whole write rolls back and markAccepted is never called', async () => {
      const { service, tx, prisma } = makeHarness();
      tx.$queryRawUnsafe
        .mockResolvedValueOnce([pendingFindingRow()]) // loadFindings
        .mockResolvedValueOnce([{ matterId: null, locked: false }]) // lock check
        .mockResolvedValueOnce([]); // target Matter does not exist -> NotFoundException inside the tx callback

      // withTenant here is the REAL implementation shape (invokes the
      // callback and propagates its rejection) — Prisma's actual
      // interactive-transaction semantics roll back on a thrown error, so
      // asserting the callback's rejection propagates is the correct proxy
      // for "the transaction rolled back" at this mock's boundary.
      await expect(
        service.applyAdvocacyFindingToMatter(ctx, clientId, runId, findingId, { matterId: otherClientId }),
      ).rejects.toThrow();

      // markAccepted issues its OWN separate withTenant call — assert it
      // never happened by checking the finding-accept UPDATE never ran.
      const acceptUpdate = tx.$executeRawUnsafe.mock.calls.find((call) =>
        String(call[0]).includes('client_profile_fill_finding') && String(call[0]).includes("'accepted'"),
      );
      expect(acceptUpdate).toBeUndefined();
      // Exactly two withTenant calls happened — one for loadFindings (its
      // own read-only transaction) and one for the record-upsert +
      // Matter-assign attempt that threw. There must be NO third call,
      // which is what markAccepted's own withTenant would add if the
      // caller had incorrectly proceeded past the failure.
      expect(prisma.withTenant).toHaveBeenCalledTimes(2);
    });
  });

  describe('preserves existing correction paths after an immediate assignment', () => {
    test('reassignRecord still works on a record this flow just locked', async () => {
      const { service, tx } = makeHarness();
      // First: the immediate-assign flow locks the record to `matterId`.
      tx.$queryRawUnsafe
        .mockResolvedValueOnce([pendingFindingRow()])
        .mockResolvedValueOnce([{ matterId: null, locked: false }])
        .mockResolvedValueOnce([{ id: matterId }]);
      await service.applyAdvocacyFindingToMatter(ctx, clientId, runId, findingId, { matterId });

      // Then: the existing reassign correction path must still be usable —
      // matter_locked being true does not disable the human correction UX,
      // it only disables the AUTOMATIC re-clustering path.
      const advocacyMatters = (service as unknown as { advocacyMatters: ClientAdvocacyMatterService }).advocacyMatters;
      const newTargetMatterId = '88888888-8888-8888-8888-888888888888';
      tx.$queryRawUnsafe.mockResolvedValueOnce([{ id: newTargetMatterId }]).mockResolvedValueOnce([{ matterId }]);
      await advocacyMatters.reassignRecord(ctx, clientId, 'some-record-id', newTargetMatterId);

      const reassignUpdate = tx.$executeRawUnsafe.mock.calls.find(
        (call) =>
          String(call[0]).includes('UPDATE client_advocacy_record') &&
          String(call[0]).includes('matter_locked = true') &&
          call.includes(newTargetMatterId),
      );
      expect(reassignUpdate).toBeDefined();
    });

    test('detachRecord still works on a record this flow just locked', async () => {
      const { service, tx } = makeHarness();
      tx.$queryRawUnsafe
        .mockResolvedValueOnce([pendingFindingRow()])
        .mockResolvedValueOnce([{ matterId: null, locked: false }])
        .mockResolvedValueOnce([{ id: matterId }]);
      await service.applyAdvocacyFindingToMatter(ctx, clientId, runId, findingId, { matterId });

      const advocacyMatters = (service as unknown as { advocacyMatters: ClientAdvocacyMatterService }).advocacyMatters;
      await advocacyMatters.detachRecord(ctx, clientId, 'some-record-id');

      const detachUpdate = tx.$executeRawUnsafe.mock.calls.find(
        (call) => String(call[0]).includes('matter_id = NULL') && String(call[0]).includes('matter_locked = true'),
      );
      expect(detachUpdate).toBeDefined();
    });
  });
});
