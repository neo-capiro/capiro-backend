// HP-05 (Gate L): an 'intel' (LegiWatch alert) context item used to reach the
// outreach prompt as the literal string "- [intel] undefined" — the wizard's
// Generate request sends id-only (no body), and enrichOutreachContextItems had
// no case for 'intel' at all, so nothing ever filled it back in. This proves
// the new case rewrites the body from a real fetched packet, that an
// unverifiable alert produces an honest gap (never a literal "undefined"), and
// (HP-04, Gate L phase b) that the fetched packet's client-relationship gaps
// get overlaid with apps/api's own governed data when OUTREACH_CLIENT_PROFILE
// is on for the tenant.
//
// Prototype-stub pattern (see engagement-batch-group.spec.ts): a real
// EngagementService prototype over stubbed collaborators, calling the private
// enrichOutreachContextItems directly.

import { describe, expect, test, jest } from '@jest/globals';
import type { TenantContext } from '@capiro/shared';
import { EngagementService, type OutreachSelectedContextItemInput } from './engagement.service.js';
import type { GovernmentAffairsAlertPacket } from './generation/alert-packet-client.service.js';

const CTX: TenantContext = {
  tenantId: 'tenant-1',
  tenantSlug: 'capiro',
  userId: 'user-1',
  clerkUserId: 'clerk-1',
  role: 'standard_user',
} as TenantContext;

const PACKET: GovernmentAffairsAlertPacket = {
  event: {
    sourceType: 'bill',
    whatChanged: 'H.R. 8800: Reported by committee',
    canonicalStatus: 'Reported by committee',
    occurredAt: '2026-07-18',
    effectiveAt: null,
  },
  officialEvidence: [
    {
      claimId: 'c1',
      text: 'Bill: H.R. 8800 — Hypersonic Capability Acceleration Act',
      sourceUrl: 'https://www.congress.gov/bill/119th-congress/house-bill/8800',
      retrievedAt: '2026-07-26',
      verification: 'official',
    },
  ],
  proceduralMeaning: { currentStage: 'Reported by committee', nextPossibleSteps: [], uncertainty: [] },
  clientContext: {
    clientId: 'client-1',
    matchedTopics: ['Hypersonics'],
    capabilities: [],
    activeStrategies: [],
    redLines: [],
    facilities: [],
  },
  relationshipContext: {
    targetOffices: [],
    existingRelationships: [],
    recentMeetings: [],
    openCommitments: [],
  },
  actionContext: { recommendedTargets: [], recommendedActions: [] },
  confidence: {
    relevance: 0.7,
    procedural: 0.8,
    evidenceCoverage: 0.6,
    missingFields: [
      'relationshipContext.existingRelationships',
      'relationshipContext.targetOffices',
      'relationshipContext.recentMeetings',
      'clientContext.redLines',
      'clientContext.activeStrategies',
    ],
  },
};

function serviceWithPacketClient(opts: {
  fetchAlertPacket: jest.Mock;
  /** undefined = OUTREACH_CLIENT_PROFILE off (tenant settings absent). */
  clientProfileSettings?: unknown;
  peopleBlock?: string | null;
  targetOfficesBlock?: string | null;
  recentMeetings?: Array<{ subject: string | null; startsAt: Date | null }>;
}) {
  const service = Object.create(EngagementService.prototype) as EngagementService;
  const patch = service as unknown as Record<string, unknown>;
  patch.alertPacketClient = { fetchAlertPacket: opts.fetchAlertPacket };
  patch.logger = { warn: jest.fn() };
  patch.prisma = {
    withTenant: async (_tenantId: string, fn: (tx: unknown) => unknown) =>
      fn({
        tenant: {
          findFirst: async () => ({ settings: opts.clientProfileSettings ?? null }),
        },
      }),
  };
  // Isolate the unit under test from its own collaborators' DB-querying
  // internals — these three are exercised by their own tests elsewhere.
  patch.outreachClientPeopleBlock = jest.fn(async () => opts.peopleBlock ?? null);
  patch.outreachClientTargetOfficesBlock = jest.fn(async () => opts.targetOfficesBlock ?? null);
  patch.recentClientMeetingsForOutreach = jest.fn(async () => opts.recentMeetings ?? []);
  return service as unknown as {
    enrichOutreachContextItems: (
      items: OutreachSelectedContextItemInput[],
      ctx: TenantContext,
      clientId: string | null,
      authHeader?: string,
    ) => Promise<{ items: OutreachSelectedContextItemInput[]; truthByItemId: Map<string, unknown> }>;
  };
}

const PROFILE_ON = { clioFeatureFlags: { 'outreachClientProfile.enabled': true } };

describe('EngagementService.enrichOutreachContextItems — HP-05 (Gate L) intel rehydration', () => {
  test('rewrites an intel item body from the fetched packet, forwarding clientId/authHeader/alertId', async () => {
    const fetchAlertPacket = jest.fn(async () => PACKET);
    const svc = serviceWithPacketClient({ fetchAlertPacket });
    const { items } = await svc.enrichOutreachContextItems(
      [{ id: 'alert-a1', kind: 'intel', scope: 'all' }],
      CTX,
      'client-1',
      'Bearer tok123',
    );
    expect(fetchAlertPacket).toHaveBeenCalledWith('Bearer tok123', 'client-1', 'a1');
    expect(items[0]!.body).toContain('What changed: H.R. 8800: Reported by committee');
    expect(items[0]!.body).toContain('Hypersonic Capability Acceleration Act');
  });

  test('an unverifiable alert gets an honest gap body — never the literal "undefined"', async () => {
    const fetchAlertPacket = jest.fn(async () => null);
    const svc = serviceWithPacketClient({ fetchAlertPacket });
    const { items } = await svc.enrichOutreachContextItems(
      [{ id: 'alert-a1', kind: 'intel', scope: 'all', title: 'Some alert' }],
      CTX,
      'client-1',
    );
    expect(items[0]!.body).toBeDefined();
    expect(items[0]!.body).toContain('could not be verified');
    // The exact pre-fix bug this closes: formatItems renders `- [${kind}] ${title}${body}`,
    // so a literal JS "undefined" string must never appear in the rewritten body.
    expect(items[0]!.body).not.toMatch(/\bundefined\b/);
  });

  test('a null clientId never calls the packet client and gets an honest gap', async () => {
    const fetchAlertPacket = jest.fn();
    const svc = serviceWithPacketClient({ fetchAlertPacket });
    const { items } = await svc.enrichOutreachContextItems(
      [{ id: 'alert-a1', kind: 'intel', scope: 'all' }],
      CTX,
      null,
    );
    expect(fetchAlertPacket).not.toHaveBeenCalled();
    expect(items[0]!.body).not.toMatch(/\bundefined\b/);
  });

  test('other kinds are unaffected', async () => {
    const fetchAlertPacket = jest.fn();
    const svc = serviceWithPacketClient({ fetchAlertPacket });
    const { items } = await svc.enrichOutreachContextItems(
      [{ id: 'note-1', kind: 'note', scope: 'all', body: 'unchanged' }],
      CTX,
      'client-1',
    );
    expect(fetchAlertPacket).not.toHaveBeenCalled();
    expect(items[0]!.body).toBe('unchanged');
  });
});

describe('EngagementService.enrichOutreachContextItems — HP-04 (Gate L phase b) client-relationship overlay', () => {
  test('OUTREACH_CLIENT_PROFILE off: the packet is rendered as-is, still honestly missing the relationship fields', async () => {
    const fetchAlertPacket = jest.fn(async () => PACKET);
    const svc = serviceWithPacketClient({
      fetchAlertPacket,
      clientProfileSettings: null, // flag off (default)
      peopleBlock: 'PEOPLE THIS CLIENT WORKS WITH: Jane Roe',
    });
    const { items } = await svc.enrichOutreachContextItems(
      [{ id: 'alert-a1', kind: 'intel', scope: 'all' }],
      CTX,
      'client-1',
    );
    expect(items[0]!.body).not.toContain('Jane Roe');
    expect(items[0]!.body).toContain('Unknowns:');
    expect(items[0]!.body).toContain('relationshipContext.existingRelationships');
  });

  test('OUTREACH_CLIENT_PROFILE on: fills people/target-offices/recent-meetings and drops exactly those three from Unknowns', async () => {
    const fetchAlertPacket = jest.fn(async () => PACKET);
    const svc = serviceWithPacketClient({
      fetchAlertPacket,
      clientProfileSettings: PROFILE_ON,
      peopleBlock: 'PEOPLE THIS CLIENT WORKS WITH: Jane Roe (Chief of Staff)',
      targetOfficesBlock: 'CLIENT TARGET OFFICES: Rep. Jane Doe (D-CA)',
      recentMeetings: [{ subject: 'Hill visit', startsAt: new Date('2026-07-01T00:00:00.000Z') }],
    });
    const { items } = await svc.enrichOutreachContextItems(
      [{ id: 'alert-a1', kind: 'intel', scope: 'all' }],
      CTX,
      'client-1',
    );
    const body = items[0]!.body!;
    expect(body).toContain('Jane Roe (Chief of Staff)');
    expect(body).toContain('Rep. Jane Doe (D-CA)');
    expect(body).toContain('Hill visit (2026-07-01)');
    // b-2: the three filled fields drop out of Unknowns...
    expect(body).not.toContain('relationshipContext.existingRelationships');
    expect(body).not.toContain('relationshipContext.targetOffices');
    expect(body).not.toContain('relationshipContext.recentMeetings');
    // ...b-3: redLines/activeStrategies are untouched (no apps/api data backs them).
    expect(body).toContain('clientContext.redLines');
    expect(body).toContain('clientContext.activeStrategies');
  });

  test('never fetches client-relationship data when no item is intel-kind', async () => {
    const peopleBlockFn = jest.fn(async () => 'should not be called');
    const svc = serviceWithPacketClient({
      fetchAlertPacket: jest.fn(),
      clientProfileSettings: PROFILE_ON,
    });
    (svc as unknown as Record<string, unknown>).outreachClientPeopleBlock = peopleBlockFn;
    await svc.enrichOutreachContextItems(
      [{ id: 'bill-hr1', kind: 'bill', scope: 'all' }],
      CTX,
      'client-1',
    );
    expect(peopleBlockFn).not.toHaveBeenCalled();
  });
});
