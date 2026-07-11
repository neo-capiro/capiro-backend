import { IntelligenceService } from './intelligence.service.js';
import { commentDeadlineDedupeKey } from './comment-deadline.util.js';

/**
 * getCommentPeriodAlerts dedup regression (Phase 1 M4.2). Prior to this fix,
 * this on-demand dashboard-chip read wrote `IntelligenceChange` rows via a
 * plain `create()` with no `dedupeKey` — every page load produced a fresh
 * duplicate row for the same (document, client) pair. `check-comment-
 * periods.ts` (the scheduled verb) was fixed in M3.4; this caller shares the
 * same `commentDeadlineDedupeKey` helper but had NOT actually been switched
 * to `upsert` — this spec pins that it now is.
 */
describe('IntelligenceService.getCommentPeriodAlerts — dedup (Phase 1 M4.2)', () => {
  const tenantId = '00000000-0000-0000-0000-000000000001';
  const clientId = '00000000-0000-0000-0000-000000000010';
  const documentId = 'fr-doc-1';

  function makeService() {
    const upsert = jest.fn(
      async (args: { where: { dedupeKey: string }; create: unknown; update: unknown }) =>
        args.create,
    );
    const create = jest.fn(async () => {
      throw new Error('getCommentPeriodAlerts must upsert on dedupeKey, not create');
    });
    const tenantTx = {
      client: {
        findMany: jest.fn(async () => [
          {
            id: clientId,
            name: 'Acme Defense',
            sectorTag: null,
            // A capability keyword overlapping the document's topic is the
            // relevance signal getCommentPeriodAlerts requires to emit an
            // alert at all (sectorTag/agency-sector match is the other path;
            // neither is exercised here — this fixture is deliberately the
            // keyword-overlap path).
            capabilities: [{ sector: null, name: 'PFAS Remediation Services', tags: [] }],
          },
        ]),
      },
    };
    const prisma: any = {
      withTenant: jest.fn(async (_t: string, run: (tx: any) => Promise<any>) => run(tenantTx)),
      federalRegisterDocument: {
        findMany: jest.fn(async () => [
          {
            id: documentId,
            title: 'PFAS Reporting Rule',
            type: 'PROPOSED_RULE',
            commentEndDate: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000),
            agencyNames: ['Environmental Protection Agency'],
            topics: ['pfas'],
          },
        ]),
      },
      // W4.5: getCommentPeriodAlerts now also scans state_rule (global table).
      // Empty here keeps this fixture on the federal-only path it pins.
      stateRule: { findMany: jest.fn(async () => []) },
      intelligenceChange: { upsert, create },
    };
    return { service: new IntelligenceService(prisma), upsert, create };
  }

  it('PINNED: upserts on commentDeadlineDedupeKey, never calls create directly', async () => {
    const { service, upsert, create } = makeService();
    const result = await service.getCommentPeriodAlerts(tenantId);

    expect(result.alerts.length).toBeGreaterThan(0);
    expect(create).not.toHaveBeenCalled();
    expect(upsert).toHaveBeenCalledTimes(1);

    const expectedKey = commentDeadlineDedupeKey('federal_register', documentId, clientId);
    const call = upsert.mock.calls[0]![0] as {
      where: { dedupeKey: string };
      create: { dedupeKey: string };
      update: { dedupeKey: string };
    };
    expect(call.where.dedupeKey).toBe(expectedKey);
    expect(call.create.dedupeKey).toBe(expectedKey);
    expect(call.update.dedupeKey).toBe(expectedKey);
  });

  it('two separate invocations for the same (document, client) pair produce the SAME dedupeKey (a real upsert collapses them to one row)', async () => {
    const { service: first, upsert: upsertFirst } = makeService();
    const { service: second, upsert: upsertSecond } = makeService();
    await first.getCommentPeriodAlerts(tenantId);
    await second.getCommentPeriodAlerts(tenantId);

    const keyFirst = (upsertFirst.mock.calls[0]![0] as { where: { dedupeKey: string } }).where
      .dedupeKey;
    const keySecond = (upsertSecond.mock.calls[0]![0] as { where: { dedupeKey: string } }).where
      .dedupeKey;
    expect(keyFirst).toBe(keySecond);
  });
});

/**
 * W4.5 (M3-D): the on-demand reader now also scans state_rule (global table),
 * mirroring check-comment-periods.ts — capability-keyword overlap against the
 * rule's title AND abstract, emitted as a `state_register` comment_deadline
 * change so criticalDeadlines + the Top-alerts card include state rows.
 */
describe('IntelligenceService.getCommentPeriodAlerts — state rules (W4.5 / M3-D)', () => {
  const tenantId = '00000000-0000-0000-0000-000000000001';
  const clientId = '00000000-0000-0000-0000-000000000010';
  const ruleId = 'FL-9999';

  function makeService(capabilityName: string) {
    const upsert = jest.fn(
      async (args: { where: { dedupeKey: string }; create: any; update: unknown }) => args.create,
    );
    const tenantTx = {
      client: {
        findMany: jest.fn(async () => [
          {
            id: clientId,
            name: 'Acme Defense',
            sectorTag: null,
            capabilities: [{ sector: null, name: capabilityName, tags: [] }],
          },
        ]),
      },
    };
    const prisma: any = {
      withTenant: jest.fn(async (_t: string, run: (tx: any) => Promise<any>) => run(tenantTx)),
      federalRegisterDocument: { findMany: jest.fn(async () => []) },
      stateRule: {
        findMany: jest.fn(async () => [
          {
            id: ruleId,
            state: 'FL',
            agency: 'Department of Environmental Protection',
            title: 'Water quality rule',
            // keyword lives ONLY in the abstract — proves abstract is in the haystack.
            abstract: 'Revised permitting standards for stormwater discharge.',
            ruleType: 'proposed',
            commentEndDate: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000),
            commentStartDate: null,
          },
        ]),
      },
      intelligenceChange: { upsert, create: jest.fn() },
    };
    return { service: new IntelligenceService(prisma), upsert };
  }

  it('surfaces a state rule whose ABSTRACT matches a client capability keyword, as a state_register change with the state dedupeKey', async () => {
    const { service, upsert } = makeService('Stormwater Management');
    const result = await service.getCommentPeriodAlerts(tenantId);

    const stateAlert = result.alerts.find((a) => a.documentId === ruleId);
    expect(stateAlert).toBeDefined();
    expect(upsert).toHaveBeenCalledTimes(1);
    const call = upsert.mock.calls[0]![0] as { where: { dedupeKey: string }; create: { source: string } };
    expect(call.create.source).toBe('state_register');
    expect(call.where.dedupeKey).toBe(commentDeadlineDedupeKey('state_register', ruleId, clientId));
  });

  it('does NOT surface a state rule with zero keyword overlap (mirrors the scheduled verb — no relevance, no chip)', async () => {
    const { service, upsert } = makeService('Aerospace Manufacturing');
    const result = await service.getCommentPeriodAlerts(tenantId);
    expect(result.alerts.find((a) => a.documentId === ruleId)).toBeUndefined();
    expect(upsert).not.toHaveBeenCalled();
  });
});
