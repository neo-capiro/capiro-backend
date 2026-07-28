import { describe, it, expect } from '@jest/globals';
import {
  billIdFromItemId,
  peCodeFromItemId,
  intelAlertIdFromItemId,
  fmtM,
  formatBillTruth,
  formatPeTruth,
  renderClientRelationshipSnapshot,
  renderClientPeopleRoster,
  renderClientTargetOffices,
  type BillTruth,
  type PeTruth,
} from './outreach-context-enrichment.js';

describe('outreach-context-enrichment id parsing', () => {
  it('extracts a bill id and pe code from the wizard item ids', () => {
    expect(billIdFromItemId('bill-119-hr-8800')).toBe('119-hr-8800');
    expect(peCodeFromItemId('pe-0603851F')).toBe('0603851F');
    expect(billIdFromItemId('pe-0603851F')).toBeNull();
    expect(peCodeFromItemId('bill-119-hr-8800')).toBeNull();
  });

  it('HP-05 (Gate L): extracts an intel_alert id from the wizard item id', () => {
    expect(intelAlertIdFromItemId('alert-abc123')).toBe('abc123');
    expect(intelAlertIdFromItemId('bill-119-hr-8800')).toBeNull();
    expect(intelAlertIdFromItemId('pe-0603851F')).toBeNull();
  });
});

describe('fmtM (canonical $M)', () => {
  it('formats millions and rolls to billions past 1000M', () => {
    expect(fmtM(72.112)).toBe('$72.1M');
    expect(fmtM(null)).toBe('—');
    expect(fmtM(1250)).toBe('$1.25B');
  });
});

describe('formatBillTruth — the H.R. 8800 "stalled bill read as advancing" fix', () => {
  const bill: BillTruth = {
    id: '119-hr-8800',
    title: 'H.R. 8800 — National Defense Authorization Act for Fiscal Year 2027',
    status: 'rule_failed',
    statusAt: '2026-06-30T00:00:00.000Z',
    latestActionText: 'Rule H.Res.1398 rejected',
    latestActionDate: '2026-06-30T00:00:00.000Z',
    sponsorName: 'Mike Rogers',
    sponsorParty: 'R',
    sponsorState: 'AL',
    cosponsorsCount: 1,
    committees: ['House Armed Services'],
    votes: [],
    governingRules: [
      {
        ruleBillId: '119-hres-1398',
        ruleStatus: 'failed',
        ruleLatestAction: 'Failed of adoption',
        ruleVotes: [
          {
            chamber: 'house',
            rollNumber: 231,
            question: 'On agreeing to the resolution',
            result: 'Failed',
            yeas: 198,
            nays: 224,
            voteDate: '2026-06-30T00:00:00.000Z',
          },
        ],
      },
    ],
  };

  it('states the canonical status and explicitly flags the bill as stalled', () => {
    const out = formatBillTruth(bill);
    expect(out).toContain('AUTHORITATIVE BILL STATUS');
    // billStatusLabel('rule_failed') is the human label; the stalled note is verbatim.
    expect(out).toContain('did NOT advance to the floor');
    expect(out).toContain('stalled, not pending passage');
  });

  it('surfaces the governing rule vote (198–224) and the no-vote-on-the-bill caveat', () => {
    const out = formatBillTruth(bill);
    expect(out).toContain('198–224');
    expect(out).toContain('HRES-1398');
    expect(out).toContain('No recorded roll-call vote on the bill itself');
  });

  it('reports the real sponsor and cosponsor count (not "spans committees")', () => {
    const out = formatBillTruth(bill);
    expect(out).toContain('Mike Rogers (R-AL)');
    expect(out).toContain('cosponsors: 1');
  });
});

describe('formatPeTruth — the reversed-direction + omitted-HASC-cut fix', () => {
  it('ICBM Dem/Val: HAC-D plus-up reads as ABOVE the request, never a cut', () => {
    const pe: PeTruth = {
      peCode: '0603851F',
      title: 'ICBM Dem/Val',
      service: 'Air Force',
      budgetActivityName: null,
      years: [
        {
          fy: 2027,
          request: 72.112,
          hascMark: 72.112,
          sascMark: 72.112,
          hacDMark: 112.912,
          sacDMark: null,
          conference: null,
          enacted: null,
        },
      ],
    };
    const out = formatPeTruth(pe);
    expect(out).toContain('request $72.1M');
    expect(out).toContain('HAC-D mark $112.9M (appropriations; $40.8M above the request)');
    expect(out).not.toContain('below the request');
    // current authoritative = the HAC-D mark, tagged appropriations, NOT enacted
    expect(out).toContain('Current authoritative figure: $112.9M (HAC-D');
    expect(out).toContain('NOT enacted');
  });

  it('CCA / Autonomous Collaborative Platforms: the HASC cut is visible, tagged authorization', () => {
    const pe: PeTruth = {
      peCode: '0207179F',
      title: 'Autonomous Collaborative Platforms',
      service: 'Air Force',
      budgetActivityName: null,
      years: [
        {
          fy: 2027,
          request: 57.217,
          hascMark: 51.496,
          sascMark: 57.217,
          hacDMark: 57.217,
          sacDMark: null,
          conference: null,
          enacted: null,
        },
      ],
    };
    const out = formatPeTruth(pe);
    expect(out).toContain('HASC mark $51.5M (authorization; $5.7M below the request)');
  });

  it('NDAA conference report is a distinct AUTHORIZATION figure, never the appropriations trend', () => {
    const pe: PeTruth = {
      peCode: '1507N2280',
      title: 'Aerial Targets',
      service: 'Navy',
      budgetActivityName: null,
      years: [
        {
          fy: 2026,
          request: 164.0,
          hascMark: null,
          sascMark: null,
          hacDMark: null,
          sacDMark: null,
          conference: null,
          ndaaConference: 164.504,
          enacted: 182.704,
        },
      ],
    };
    const out = formatPeTruth(pe);
    expect(out).toContain('NDAA conference report $164.5M (authorization');
    expect(out).toContain('Enacted $182.7M (appropriations');
    // the current authoritative appropriations figure is the enacted level, NOT the NDAA conf.
    expect(out).toContain('Current authoritative figure: $182.7M (Enacted');
  });

  it('labels outyears as FYDP projections and the mark-bearing year as the current cycle', () => {
    const pe: PeTruth = {
      peCode: '0605602A',
      title: 'Army Test Instrumentation',
      service: 'Army',
      budgetActivityName: null,
      years: [
        {
          fy: 2027,
          request: 100,
          hascMark: 110,
          sascMark: null,
          hacDMark: null,
          sacDMark: null,
          conference: null,
          enacted: null,
        },
        {
          fy: 2031,
          request: 120,
          hascMark: null,
          sascMark: null,
          hacDMark: null,
          sacDMark: null,
          conference: null,
          enacted: null,
        },
      ],
    };
    const out = formatPeTruth(pe);
    expect(out).toContain('FY27 [current budget cycle]');
    expect(out).toContain('FY31 [OUTYEAR');
    // a request-only outyear does not restate itself as a "current authoritative figure"
    expect(out).not.toContain('(Request — request');
  });

  it('emits an honest gap when the PE has no funding rows (no invented figure)', () => {
    const pe: PeTruth = {
      peCode: '0000000X',
      title: 'Unknown',
      service: null,
      budgetActivityName: null,
      years: [],
    };
    const out = formatPeTruth(pe);
    expect(out).toContain('No structured funding rows are on record');
    expect(out).not.toMatch(/\$\d/); // no dollar figure anywhere
  });
});

describe('renderClientRelationshipSnapshot — the v2 clientContext drop fix', () => {
  it('renders a compact, bounded, labeled snapshot from the aggregate', () => {
    const out = renderClientRelationshipSnapshot({
      keyStakeholders: [
        {
          fullName: 'Jane Doe',
          title: 'Chief of Staff',
          organization: 'Rep. Reed',
          source: 'Contact + Meeting',
        },
        { fullName: 'John Smith', title: 'LD', organization: null, source: 'Email' },
      ],
      recentActivity: [
        { type: 'meeting', title: 'FY27 markup prep', date: '2026-07-01T00:00:00.000Z' },
        {
          type: 'mail_thread',
          title: 'Follow-up on directed energy',
          date: '2026-06-28T00:00:00.000Z',
        },
      ],
      openTasks: [{ title: 'Send one-pager', dueDate: null }],
    });
    expect(out).toContain('CLIENT RELATIONSHIP SNAPSHOT');
    expect(out).toContain('Jane Doe (Chief of Staff, Rep. Reed) [Contact + Meeting]');
    expect(out).toContain('meeting "FY27 markup prep" (2026-07-01)');
    expect(out).toContain('email "Follow-up on directed energy"'); // mail_thread → "email"
    expect(out).toContain('Open tasks (1): "Send one-pager"');
  });

  it('caps contacts at 12 and activity at 6', () => {
    const many = (n: number, f: (i: number) => unknown) =>
      Array.from({ length: n }, (_, i) => f(i));
    const out = renderClientRelationshipSnapshot({
      keyStakeholders: many(30, (i) => ({
        fullName: `Person ${i}`,
        title: 't',
        organization: 'o',
        source: 'Contact',
      })) as never,
      recentActivity: many(30, (i) => ({ type: 'meeting', title: `M${i}`, date: null })) as never,
      openTasks: [],
    })!;
    expect(out).toContain('Person 11');
    expect(out).not.toContain('Person 12'); // 0..11 = 12 contacts
    expect(out).toContain('M5');
    expect(out).not.toContain('M6'); // 0..5 = 6 activities
  });

  it('returns null when there is nothing worth rendering', () => {
    expect(renderClientRelationshipSnapshot(null)).toBeNull();
    expect(
      renderClientRelationshipSnapshot({ keyStakeholders: [], recentActivity: [], openTasks: [] }),
    ).toBeNull();
    // entries with no name/org and no title are dropped → still null
    expect(
      renderClientRelationshipSnapshot({
        keyStakeholders: [{ title: 'x' }],
        recentActivity: [{ type: 'meeting' }],
      }),
    ).toBeNull();
  });
});

describe('renderClientPeopleRoster (OUTREACH_CLIENT_PROFILE)', () => {
  it('renders a bounded roster with warm-intro framing', () => {
    const out = renderClientPeopleRoster([
      {
        name: 'Alex Rivera',
        title: 'VP Gov Affairs',
        role: 'Primary contact',
        notes: 'Met at AUSA',
        lastContact: '2026-06-15T00:00:00.000Z',
      },
      { name: 'Sam Cole', title: null, role: null, notes: null, lastContact: null },
    ])!;
    expect(out).toContain('PEOPLE THIS CLIENT WORKS WITH');
    expect(out).toContain(
      'Alex Rivera (VP Gov Affairs, Primary contact) — last contact 2026-06-15; Met at AUSA',
    );
    expect(out).toContain('- Sam Cole');
    expect(out).toContain('do NOT claim a relationship the recipient has not confirmed');
  });
  it('caps at 15 and returns null when empty', () => {
    const many = Array.from({ length: 25 }, (_, i) => ({ name: `P${i}` }));
    const out = renderClientPeopleRoster(many)!;
    expect(out).toContain('P14');
    expect(out).not.toContain('P15');
    expect(renderClientPeopleRoster([])).toBeNull();
    expect(renderClientPeopleRoster([{ title: 'x' }])).toBeNull(); // no name → dropped
  });
});

describe('renderClientTargetOffices (OUTREACH_CLIENT_PROFILE)', () => {
  it('renders explicit team targets and suggestions with committee/billCount', () => {
    const out = renderClientTargetOffices([
      {
        office: 'Rep. Dana Reed',
        party: 'D',
        state: 'CA-12',
        committee: 'Armed Services',
        billCount: 3,
        explicit: true,
      },
      {
        office: 'Sen. John Cornyn',
        party: 'R',
        state: 'TX',
        committee: 'Appropriations',
        billCount: 0,
        explicit: false,
      },
    ])!;
    expect(out).toContain('CLIENT TARGET OFFICES');
    expect(out).toContain(
      'Rep. Dana Reed (D-CA-12) — Armed Services; 3 tracked bills; team target',
    );
    expect(out).toContain('Sen. John Cornyn (R-TX) — Appropriations; suggested');
  });
  it('caps at 12 and returns null when empty', () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ office: `Office ${i}`, explicit: false }));
    const out = renderClientTargetOffices(many)!;
    expect(out).toContain('Office 11');
    expect(out).not.toContain('Office 12');
    expect(renderClientTargetOffices([])).toBeNull();
  });
});
