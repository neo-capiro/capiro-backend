import { describe, expect, it, jest, afterEach } from '@jest/globals';
import {
  AlertPacketClientService,
  renderAlertPacketForOutreach,
  OUTREACH_SUMMARY_MAX,
  type GovernmentAffairsAlertPacket,
} from './alert-packet-client.service.js';

const packet = (
  over: Partial<GovernmentAffairsAlertPacket> = {},
): GovernmentAffairsAlertPacket => ({
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
    clientId: 'c1',
    position: 'support',
    priority: 'high',
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
  actionContext: { recommendedTargets: [], recommendedActions: ['Draft client memo'] },
  confidence: {
    relevance: 0.72,
    procedural: 0,
    evidenceCoverage: 0.86,
    missingFields: ['relationshipContext.targetOffices'],
  },
  ...over,
});

describe('renderAlertPacketForOutreach', () => {
  it('renders the event, stage, client context, and evidence with its url', () => {
    const out = renderAlertPacketForOutreach(packet());
    expect(out).toContain('What changed: H.R. 8800: Reported by committee');
    expect(out).toContain('Canonical status: Reported by committee');
    expect(out).toContain('- [c1] Bill: H.R. 8800 — Hypersonic Capability Acceleration Act');
    expect(out).toContain('https://www.congress.gov/bill/119th-congress/house-bill/8800');
    expect(out).toContain('(official)');
    expect(out).toContain('Recommended actions: Draft client memo');
    expect(out).toContain('Unknowns: relationshipContext.targetOffices');
  });

  it('never throws on a malformed or empty packet', () => {
    expect(() => renderAlertPacketForOutreach({} as GovernmentAffairsAlertPacket)).not.toThrow();
    expect(renderAlertPacketForOutreach({} as GovernmentAffairsAlertPacket)).toContain(
      '(not established)',
    );
  });

  it('HP-05 c-4: a long evidence list stays within the budget, with an omission marker, and never crowds out Unknowns', () => {
    const long = renderAlertPacketForOutreach(
      packet({
        officialEvidence: Array.from({ length: 60 }, (_, i) => ({
          claimId: `c${i}`,
          text: `Evidence line number ${i} with a good deal of explanatory text attached to it.`,
          sourceUrl: 'https://www.congress.gov/bill/119th-congress/house-bill/8800',
          retrievedAt: '2026-07-26',
          verification: 'official' as const,
        })),
      }),
    );
    expect(long.length).toBeLessThanOrEqual(OUTREACH_SUMMARY_MAX);
    expect(long).toContain('Recommended actions: Draft client memo');
    expect(long).toContain('Unknowns: relationshipContext.targetOffices');
    expect(long).toMatch(/\(\d+ evidence line\(s\) omitted\)/);
  });

  it('Unknowns and recommended actions come BEFORE the evidence list (HP-05 c-4 order)', () => {
    const out = renderAlertPacketForOutreach(packet());
    expect(out.indexOf('Unknowns:')).toBeLessThan(out.indexOf('Official evidence:'));
    expect(out.indexOf('Recommended actions:')).toBeLessThan(out.indexOf('Official evidence:'));
  });
});

function configStub(values: Record<string, string | undefined>) {
  return { get: jest.fn((key: string) => values[key]) };
}

describe('AlertPacketClientService.fetchAlertPacket', () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it('returns null without fetching when there is no auth header to forward', async () => {
    const fetchSpy = jest.fn();
    global.fetch = fetchSpy as never;
    const svc = new AlertPacketClientService(
      configStub({ TRACKER_APP_BASE_URL: 'https://app.capiro.ai' }) as never,
    );
    const result = await svc.fetchAlertPacket(undefined, 'client-1', 'alert-1');
    expect(result).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('forwards the caller identity and hits the intel-api packet endpoint under the shared public host', async () => {
    const p = packet();
    const fetchSpy = jest.fn(async () => ({ ok: true, json: async () => p }));
    global.fetch = fetchSpy as never;
    const svc = new AlertPacketClientService(
      configStub({ TRACKER_APP_BASE_URL: 'https://app.capiro.ai' }) as never,
    );
    const result = await svc.fetchAlertPacket('Bearer tok123', 'client-1', 'alert-1');
    expect(result).toEqual(p);
    expect(fetchSpy).toHaveBeenCalledWith(
      'https://app.capiro.ai/intel-api/clients/client-1/alerts/alert-1/packet',
      expect.objectContaining({ headers: { authorization: 'Bearer tok123' } }),
    );
  });

  it('fails open (returns null) on a non-2xx response', async () => {
    global.fetch = jest.fn(async () => ({ ok: false, json: async () => ({}) })) as never;
    const svc = new AlertPacketClientService(configStub({}) as never);
    const result = await svc.fetchAlertPacket('Bearer tok', 'client-1', 'alert-1');
    expect(result).toBeNull();
  });

  it('fails open (returns null) on a network error, never throws', async () => {
    global.fetch = jest.fn(async () => {
      throw new Error('network down');
    }) as never;
    const svc = new AlertPacketClientService(configStub({}) as never);
    await expect(svc.fetchAlertPacket('Bearer tok', 'client-1', 'alert-1')).resolves.toBeNull();
  });

  it('defaults the base URL when TRACKER_APP_BASE_URL is unset', async () => {
    const fetchSpy = jest.fn(async () => ({ ok: true, json: async () => packet() }));
    global.fetch = fetchSpy as never;
    const svc = new AlertPacketClientService(configStub({}) as never);
    await svc.fetchAlertPacket('Bearer tok', 'client-1', 'alert-1');
    expect(fetchSpy).toHaveBeenCalledWith(
      'https://app.capiro.ai/intel-api/clients/client-1/alerts/alert-1/packet',
      expect.anything(),
    );
  });
});
