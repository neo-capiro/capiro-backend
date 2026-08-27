import { BadRequestException } from '@nestjs/common';
import { ClientProfileFillCompletionService } from './client-profile-fill-completion.service.js';
import { ClientAdvocacyMatterService } from './client-advocacy-matter.service.js';

/**
 * Deterministic regulatory outcome correlation — the "Government Movement
 * -> Outcome" step `suggestFederalRegisterCorrelations` (PR #1310)
 * deliberately left as separately-confirmed follow-on work.
 *
 * `emitRegulatoryOutcomeFindings` has no reachable public entry point in
 * this codebase without simulating the full task-queue worker loop
 * (start run -> sweep -> runTask -> executeTask -> gatherAdvocacyHistory ->
 * gatherFederalRegisterBackfill) — none of that machinery's gather* methods
 * have direct unit coverage anywhere in this file's existing test suite
 * either (see client-profile-fill-completion.service.spec.ts, which only
 * covers this service's pure exported functions). Reached directly here
 * via `(service as any)` instead, the one place in this spec file that
 * departs from the established public-entry-point convention, specifically
 * because "duplicate rerun idempotency" and "tenant/client isolation" are
 * required, direct-test-worthy properties of the new wiring itself, not
 * just of the pure functions it calls.
 *
 * `applyRegulatoryOutcome` IS reachable publicly via `applyFindings`
 * (mirroring `client-profile-fill-pending-finding-matter-assign.service.spec.ts`'s
 * own convention exactly), so it is tested that way — including through the
 * real `ClientAdvocacyMatterService` wired to the same tx mock, same reason
 * that spec file gives: the Matter-link half of this feature lives at the
 * boundary between the two services.
 */
describe('ClientProfileFillCompletionService — deterministic regulatory outcome correlation', () => {
  const tenantId = '11111111-1111-1111-1111-111111111111';
  const userId = 'user-1';
  const ctx = { tenantId, userId } as never;
  const clientId = '22222222-2222-2222-2222-222222222222';
  const runId = '33333333-3333-3333-3333-333333333333';
  const matterId = '55555555-5555-5555-5555-555555555555';
  const findingId = '66666666-6666-6666-6666-666666666666';
  const otherClientId = '77777777-7777-7777-7777-777777777777';

  function suggestion(overrides: Partial<Record<string, unknown>> = {}) {
    return {
      documentNumber: '2026-00002',
      title: 'Proposed Rule on Defense Acquisition',
      documentType: 'PROPOSED_RULE',
      agencyNames: ['Department of Defense'],
      publicationDate: '2026-03-01T00:00:00.000Z',
      matchedDocketIds: ['DOD-2026-OS-0001'],
      sourceUrl: 'https://www.federalregister.gov/d/2026-00002',
      stage: 'government_movement' as const,
      matchedOn: 'docket_id' as const,
      causationClaimed: false as const,
      ...overrides,
    };
  }

  function makeHarness() {
    const tx = {
      $queryRawUnsafe: jest.fn(async (_query: string, ..._args: unknown[]) => [] as unknown[]),
      $executeRawUnsafe: jest.fn(async (_query: string, ..._args: unknown[]) => 1),
      auditLog: { create: jest.fn(async () => ({})) },
      client: { findFirst: jest.fn(async () => ({ id: clientId })) },
      outcomeEvent: {
        create: jest.fn(async (args: { data: Record<string, unknown> }) => ({
          id: 'outcome-event-1',
          ...args.data,
        })),
      },
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
      // applyFindings ends with getRun(), which falls through to
      // workflow.getRun() whenever hasCompletionTasks() is false (the tx
      // mock's default empty-array response) — stubbed so that fallthrough
      // doesn't throw; its return value is not what these tests assert on.
      { getRun: jest.fn(async () => ({ id: runId, status: 'running' })) } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      advocacyMatters,
    );
    return { service, tx, prisma };
  }

  describe('emitRegulatoryOutcomeFindings', () => {
    test('deterministic docket match published after the attributable comment emits a pending regulatory_outcome finding', async () => {
      const { service, tx } = makeHarness();
      tx.$queryRawUnsafe
        .mockResolvedValueOnce([{ earliestActivityDate: new Date('2026-01-15T00:00:00.000Z') }]) // earliest attributable comment date
        .mockResolvedValueOnce([]); // addFinding's terminal-status check: nothing terminal yet

      await (service as unknown as {
        emitRegulatoryOutcomeFindings: (...args: unknown[]) => Promise<void>;
      }).emitRegulatoryOutcomeFindings(ctx, clientId, runId, matterId, [suggestion()]);

      const insertCall = tx.$executeRawUnsafe.mock.calls.find((call) =>
        String(call[0]).includes('INSERT INTO client_profile_fill_finding'),
      );
      expect(insertCall).toBeDefined();
      expect(insertCall).toContain('regulatory_outcome');
      const proposedValueJson = String(insertCall![9]);
      expect(proposedValueJson).toContain('"causationClaimed":false');
      expect(proposedValueJson).toContain('"relationship":"strongly_aligned"');
      expect(proposedValueJson).toContain('"matchedOn":"docket_id"');
    });

    test('a candidate published before the attributable comment reaches the finding pipeline but is filtered before any insert', async () => {
      const { service, tx } = makeHarness();
      tx.$queryRawUnsafe.mockResolvedValueOnce([
        { earliestActivityDate: new Date('2026-04-01T00:00:00.000Z') }, // comment is AFTER the FR document
      ]);

      await (service as unknown as {
        emitRegulatoryOutcomeFindings: (...args: unknown[]) => Promise<void>;
      }).emitRegulatoryOutcomeFindings(ctx, clientId, runId, matterId, [suggestion()]);

      const insertCall = tx.$executeRawUnsafe.mock.calls.find((call) =>
        String(call[0]).includes('INSERT INTO client_profile_fill_finding'),
      );
      expect(insertCall).toBeUndefined();
      // Never even reaches addFinding's own terminal-status check — only
      // the one earliest-date query should have run.
      expect(tx.$queryRawUnsafe).toHaveBeenCalledTimes(1);
    });

    test('no deterministic suggestions on this Matter never touches client_advocacy_record at all', async () => {
      const { service, tx } = makeHarness();

      await (service as unknown as {
        emitRegulatoryOutcomeFindings: (...args: unknown[]) => Promise<void>;
      }).emitRegulatoryOutcomeFindings(ctx, clientId, runId, matterId, [
        suggestion({ matchedDocketIds: [] }),
      ]);

      expect(tx.$queryRawUnsafe).not.toHaveBeenCalled();
      expect(tx.$executeRawUnsafe).not.toHaveBeenCalled();
    });

    test('duplicate rerun idempotency: a finding already accepted/rejected for this content hash is never re-inserted', async () => {
      const { service, tx } = makeHarness();
      tx.$queryRawUnsafe
        .mockResolvedValueOnce([{ earliestActivityDate: new Date('2026-01-15T00:00:00.000Z') }])
        .mockResolvedValueOnce([{ id: 'already-terminal-finding' }]); // addFinding's terminal-status check hits

      await (service as unknown as {
        emitRegulatoryOutcomeFindings: (...args: unknown[]) => Promise<void>;
      }).emitRegulatoryOutcomeFindings(ctx, clientId, runId, matterId, [suggestion()]);

      // addFinding returns false before ever calling $executeRawUnsafe.
      expect(tx.$executeRawUnsafe).not.toHaveBeenCalled();
    });

    test('tenant/client isolation: the earliest-comment-date lookup is scoped to this exact tenant, client, and Matter', async () => {
      const { service, tx } = makeHarness();
      tx.$queryRawUnsafe
        .mockResolvedValueOnce([{ earliestActivityDate: new Date('2026-01-15T00:00:00.000Z') }])
        .mockResolvedValueOnce([]);

      await (service as unknown as {
        emitRegulatoryOutcomeFindings: (...args: unknown[]) => Promise<void>;
      }).emitRegulatoryOutcomeFindings(ctx, clientId, runId, matterId, [suggestion()]);

      const [query, ...args] = tx.$queryRawUnsafe.mock.calls[0]!;
      expect(String(query)).toContain('tenant_id = $1::uuid AND client_id = $2::uuid AND matter_id = $3::uuid');
      expect(args).toEqual([tenantId, clientId, matterId]);
      // A different client's data can never leak into this Matter's lookup —
      // the query is parameterized, never string-concatenated.
      expect(args).not.toContain(otherClientId);
    });
  });

  describe('applyRegulatoryOutcome (via the public applyFindings entry point)', () => {
    function pendingRegulatoryOutcomeFinding(overrides: Partial<Record<string, unknown>> = {}) {
      return {
        id: findingId,
        kind: 'regulatory_outcome',
        targetKey: `regulatory-outcome:${matterId}:2026-00002`,
        source: 'federal_register',
        factKind: 'recommendation',
        currentValue: null,
        proposedValue: {
          matterId,
          documentNumber: '2026-00002',
          docketId: 'DOD-2026-OS-0001',
          matchedDocketIds: ['DOD-2026-OS-0001'],
          documentType: 'PROPOSED_RULE',
          agencyNames: ['Department of Defense'],
          publicationDate: '2026-03-01T00:00:00.000Z',
          sourceUrl: 'https://www.federalregister.gov/d/2026-00002',
          attributableActivityDate: '2026-01-15T00:00:00.000Z',
          relationship: 'strongly_aligned',
          matchedOn: 'docket_id',
          causationClaimed: false,
        },
        evidence: [],
        confidence: 0.95,
        status: 'pending',
        contentHash: 'hash-regulatory-outcome-1',
        ...overrides,
      };
    }

    test('accepting the finding creates a causation-free OutcomeEvent and links it into the Matter', async () => {
      const { service, tx } = makeHarness();
      // loadFindings is the only $queryRawUnsafe call this path strictly
      // needs (linkToMatter is a plain INSERT, no read first); getRun's own
      // follow-up queries at the end of applyFindings fall back to the tx
      // mock's default `[]` return and are not what this test asserts on.
      tx.$queryRawUnsafe.mockResolvedValueOnce([pendingRegulatoryOutcomeFinding()]);

      const result = await service.applyFindings(ctx, clientId, runId, [findingId]);

      expect(result).toBeDefined();
      expect(tx.outcomeEvent.create).toHaveBeenCalledTimes(1);
      const createArgs = (tx.outcomeEvent.create as jest.Mock).mock.calls[0][0];
      expect(createArgs.data).toMatchObject({
        tenantId,
        clientId,
        kind: 'regulatory_action_published',
        sourceType: 'regulatory_document',
        sourceId: '2026-00002',
        recordedBy: userId,
      });
      expect(createArgs.data.evidence).toMatchObject({
        docketId: 'DOD-2026-OS-0001',
        documentNumber: '2026-00002',
        matchedOn: 'docket_id',
        causationClaimed: false,
      });

      const matterLinkInsert = tx.$executeRawUnsafe.mock.calls.find((call) =>
        String(call[0]).includes('INSERT INTO client_advocacy_matter_link'),
      );
      expect(matterLinkInsert).toBeDefined();
      expect(matterLinkInsert).toContain('outcome_event');
      expect(matterLinkInsert).toContain('outcome-event-1');

      const acceptUpdate = tx.$executeRawUnsafe.mock.calls.find((call) =>
        String(call[0]).includes('client_profile_fill_finding') && String(call[0]).includes("'accepted'"),
      );
      expect(acceptUpdate).toBeDefined();
    });

    test('review state preserved: a finding that is no longer pending cannot be applied a second time', async () => {
      const { service, tx } = makeHarness();
      tx.$queryRawUnsafe.mockResolvedValueOnce([
        pendingRegulatoryOutcomeFinding({ status: 'accepted' }),
      ]);

      await expect(service.applyFindings(ctx, clientId, runId, [findingId])).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(tx.outcomeEvent.create).not.toHaveBeenCalled();
    });

    test('a rejected finding also cannot be re-applied — rejection is a terminal state, not a retryable one', async () => {
      const { service, tx } = makeHarness();
      tx.$queryRawUnsafe.mockResolvedValueOnce([
        pendingRegulatoryOutcomeFinding({ status: 'rejected' }),
      ]);

      await expect(service.applyFindings(ctx, clientId, runId, [findingId])).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(tx.outcomeEvent.create).not.toHaveBeenCalled();
    });
  });
});
