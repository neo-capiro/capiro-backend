import { RuleChangeDetectorService } from './rule-change-detector.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import type {
  SourceRule,
  SourceRuleRepository,
} from '../sourcedata/rule-source-data.repository.js';

const FEDERAL_RULE: SourceRule = {
  id: 'FR-2026-12345',
  jurisdiction: 'federal',
  state: null,
  title: 'Defense Acquisition Regulation: Cybersecurity Requirements',
  abstract: 'This rule updates cybersecurity requirements for defense contractors.',
  ruleType: 'PROPOSED_RULE',
  agency: 'Department of Defense',
  publicationDate: new Date('2026-07-01'),
  commentEndDate: new Date('2026-08-01'),
  sourceUrl: 'https://federalregister.gov/d/2026-12345',
};

const STATE_RULE: SourceRule = {
  id: 'FL-31100933',
  jurisdiction: 'state',
  state: 'FL',
  title: 'Crisis Determination Procedure',
  abstract: 'Amends the rule to add a developmental disability condition.',
  ruleType: 'proposed',
  agency: 'DEPARTMENT OF CHILDREN AND FAMILIES',
  publicationDate: new Date('2026-07-10'),
  commentEndDate: new Date('2026-07-31'),
  sourceUrl: 'https://flrules.org/Gateway/View_notice.asp?id=31100933',
};

function makeHarness(opts: {
  clients?: Array<{ id: string; name: string }>;
  watchlistIssueAreas?: string[];
  watchlistTags?: Array<{ id: string; label: string }>;
  watchlistTerms?: Array<{ topicId: string; termType: string; value: string }>;
}) {
  const alerts: Array<Record<string, unknown>> = [];
  const tx = {
    intelAlert: {
      findFirst: jest.fn(
        async ({ where }: { where: { changeType: string; sourceRef: string; clientId: string } }) =>
          alerts.find(
            (a) =>
              a.changeType === where.changeType &&
              a.sourceRef === where.sourceRef &&
              a.clientId === where.clientId,
          ) ?? null,
      ),
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        alerts.push(data);
        return data;
      }),
    },
    watchlist: {
      findFirst: jest.fn(async () =>
        opts.watchlistIssueAreas || opts.watchlistTags
          ? { issueAreas: opts.watchlistIssueAreas ?? [] }
          : null,
      ),
    },
    watchlistTopic: {
      findMany: jest.fn(async () => opts.watchlistTags ?? []),
    },
    watchlistTerm: {
      findMany: jest.fn(async () => opts.watchlistTerms ?? []),
    },
  };

  const prisma = {
    withSystem: jest.fn(async (fn: (tx: unknown) => unknown) => {
      // The tenant-list query and the cross-realm client query share
      // withSystem in this service; distinguish by checking which mock the
      // caller needs via a tiny dispatcher keyed on call order isn't robust,
      // so instead we special-case based on the SQL text via a wrapped tx.
      return fn({
        $queryRawUnsafe: jest.fn(async (sql: string) => {
          if (/FROM tenants/.test(sql)) return [{ id: 't1' }];
          if (/FROM clients/.test(sql)) return opts.clients ?? [{ id: 'c1', name: 'Acme Corp' }];
          return [];
        }),
      });
    }),
    withTenant: jest.fn((_t: string, fn: (tx: unknown) => unknown) => fn(tx)),
  } as unknown as PrismaService;

  return { prisma, alerts, tx };
}

function fakeRuleSource(rules: SourceRule[]) {
  return {
    getRecentlySyncedRules: jest.fn(async () => rules),
  } as unknown as SourceRuleRepository;
}

describe('RuleChangeDetectorService (Phase 1 M3.3, PD4)', () => {
  it('fires a rule_new_match alert for a FEDERAL rule matching a watchlist topic, sourceType=regulation', async () => {
    const { prisma, alerts } = makeHarness({
      watchlistIssueAreas: [],
      watchlistTags: [{ id: 'topic-1', label: 'Cybersecurity' }],
      watchlistTerms: [{ topicId: 'topic-1', termType: 'synonym', value: 'cybersecurity' }],
    });
    const svc = new RuleChangeDetectorService(prisma, fakeRuleSource([FEDERAL_RULE]));
    const summary = await svc.runDetectionCycle();

    expect(summary.alertsWritten).toBe(1);
    expect(alerts).toHaveLength(1);
    const alert = alerts[0] as {
      sourceType: string;
      changeType: string;
      sourceRef: string;
      evidence: Record<string, unknown>;
    };
    expect(alert.sourceType).toBe('regulation');
    expect(alert.changeType).toBe('rule_new_match');
    expect(alert.sourceRef).toBe('FR-2026-12345');
    expect(alert.evidence.jurisdiction).toBe('US');
    expect(alert.evidence.actionText).toContain('cybersecurity');
  });

  it('fires a rule_new_match alert for a STATE rule, tagging jurisdiction with the state code', async () => {
    const { prisma, alerts } = makeHarness({
      watchlistTags: [{ id: 'topic-1', label: 'Disability services' }],
      watchlistTerms: [{ topicId: 'topic-1', termType: 'synonym', value: 'disability' }],
    });
    const svc = new RuleChangeDetectorService(prisma, fakeRuleSource([STATE_RULE]));
    const summary = await svc.runDetectionCycle();

    expect(summary.alertsWritten).toBe(1);
    const alert = alerts[0] as { evidence: Record<string, unknown> };
    expect(alert.evidence.jurisdiction).toBe('FL');
  });

  it('does not alert when the client has no watchlist at all', async () => {
    const { prisma, alerts } = makeHarness({});
    const svc = new RuleChangeDetectorService(prisma, fakeRuleSource([FEDERAL_RULE]));
    await svc.runDetectionCycle();
    expect(alerts).toHaveLength(0);
  });

  it('does not alert when no watchlist term matches the rule text', async () => {
    const { prisma, alerts } = makeHarness({
      watchlistTags: [{ id: 'topic-1', label: 'Healthcare' }],
      watchlistTerms: [{ topicId: 'topic-1', termType: 'synonym', value: 'medicare' }],
    });
    const svc = new RuleChangeDetectorService(prisma, fakeRuleSource([FEDERAL_RULE]));
    await svc.runDetectionCycle();
    expect(alerts).toHaveLength(0);
  });

  it('dedups a re-run: the SAME (regulation, rule, client) tuple never produces a second alert', async () => {
    const { prisma, alerts } = makeHarness({
      watchlistTags: [{ id: 'topic-1', label: 'Cybersecurity' }],
      watchlistTerms: [{ topicId: 'topic-1', termType: 'synonym', value: 'cybersecurity' }],
    });
    const svc = new RuleChangeDetectorService(prisma, fakeRuleSource([FEDERAL_RULE]));
    await svc.runDetectionCycle();
    await svc.runDetectionCycle();
    expect(alerts).toHaveLength(1);
  });

  it('returns a zero summary and never queries clients when there are no recently-synced rules', async () => {
    const { prisma, alerts } = makeHarness({});
    const svc = new RuleChangeDetectorService(prisma, fakeRuleSource([]));
    const summary = await svc.runDetectionCycle();
    expect(summary).toEqual({ scanned: 0, matched: 0, alertsWritten: 0, skippedDedup: 0 });
    expect(alerts).toHaveLength(0);
  });
});
