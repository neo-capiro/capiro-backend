import {
  createManualTargetLocator,
  createResolvedTargetRefV1,
} from './outreach-target.contract.js';
import { AnalyzeTargetCoverageCapability } from './analyze-target-coverage.capability.js';
import { FindSimilarTargetsCapability } from './find-similar-targets.capability.js';

const ctx = {
  actorUserId: '00000000-0000-4000-8000-000000000001',
  clerkUserId: 'user_test',
  tenantId: '00000000-0000-4000-8000-000000000002',
  tenantSlug: 'test',
  role: 'standard_user',
  clientScope: null,
  impersonation: null,
  requestId: 'request-1',
  surface: 'outreach' as const,
};

function target(id: string, input: { chamber?: string; state?: string; committees?: string[] } = {}) {
  const locator = createManualTargetLocator({
    id,
    name: `Person ${id}`,
    email: `${id.slice(-4)}@example.test`,
    title: 'Representative',
  });
  return createResolvedTargetRefV1({
    locator,
    displayName: locator.name,
    email: locator.email,
    phone: null,
    title: locator.title,
    organization: 'Example Office',
    clientId: null,
    jurisdiction: {
      governmentLevel: 'federal',
      chamber: input.chamber ?? 'House',
      state: input.state ?? 'VA',
      district: '7',
      committees: input.committees ?? ['Armed Services'],
      issueAreas: ['Defense'],
    },
    roleStatus: 'current',
    emailStatus: 'available',
    profileStatus: 'complete',
    sourceSnapshot: {
      system: 'user_supplied',
      version: 'v1',
      lastVerifiedAt: '2026-08-08T00:00:00.000Z',
    },
  });
}

describe('shared target intelligence capabilities', () => {
  it('reauthorizes every target before deterministic coverage analysis', async () => {
    const first = target('00000000-0000-4000-8000-000000000010');
    const resolver = { resolveMany: jest.fn(async () => [first]) };
    const capability = new AnalyzeTargetCoverageCapability(resolver as never);
    const result = await capability.execute(ctx, {
      criteria: {
        chambers: ['house'],
        committees: ['Armed Services'],
        states: ['VA'],
        relationshipPreference: 'any',
        includeStaff: false,
        includePrincipals: true,
      },
      targetRefs: [first.locator],
    });
    expect(resolver.resolveMany).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: ctx.tenantId, userId: ctx.actorUserId }),
      [first.locator],
    );
    expect(result.data.coverage).toMatchObject({
      status: 'complete',
      selectedCount: 1,
      sendReadyCount: 1,
    });
  });

  it('ranks explainable similar targets without adding them', async () => {
    const source = target('00000000-0000-4000-8000-000000000020');
    const resolver = { resolveOne: jest.fn(async () => source) };
    const search = {
      execute: jest.fn(async () => ({
        capability: 'search_targets',
        schemaVersion: 1,
        data: {
          candidates: [
            {
              recommendationRef: `orec_${'a'.repeat(64)}`,
              targetKey: 'directory_member:member-2',
              locator: { source: 'directory_member', id: 'member-2' },
              displayName: 'Representative Similar',
              title: 'Representative',
              organization: 'U.S. House',
              email: null,
              clientId: null,
              score: 0.7,
              signals: [],
              roleStatus: 'current',
              emailStatus: 'missing',
              jurisdiction: {
                governmentLevel: 'federal',
                chamber: 'House',
                state: 'VA',
                district: '8',
                committees: ['Armed Services'],
                issueAreas: ['Defense'],
              },
            },
          ],
          totalConsidered: 1,
          unsupportedCriteria: [],
        },
        provenance: [],
        exclusions: [],
        scope: { tenantId: ctx.tenantId, clientId: null },
        freshness: { asOf: '2026-08-08T00:00:00.000Z', degraded: false, reasons: [] },
        authorization: { filtered: false, restrictedCount: 0 },
      })),
    };
    const capability = new FindSimilarTargetsCapability(resolver as never, search as never);
    const result = await capability.execute(ctx, {
      targetRef: source.locator,
      clientId: null,
      limit: 10,
    });
    expect(result.data.candidates[0]).toMatchObject({
      targetKey: 'directory_member:member-2',
      similarityScore: 0.8,
      similarityReasons: expect.arrayContaining([
        'Same government level.',
        'Same chamber.',
        'Same state.',
      ]),
    });
    expect(result.data.candidates).toHaveLength(1);
  });
});
