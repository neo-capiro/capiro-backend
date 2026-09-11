import {
  capturedReport,
  makeDocument,
  renderReport,
  settings,
  type ReportBill,
  type ReportAssignment,
} from './report-domain.js';
import { mergeRecipients, normalizeEmail } from './recipients.service.js';
import { capturedRule } from './record-rule.service.js';
import { localOccurrence, localTime, nextOccurrence } from './report-schedule.js';

const now = new Date('2026-06-26T16:00:00Z');
const bill = (id: string, number: string): ReportBill => ({
  id,
  number,
  title: `Synthetic ${number}`,
  sponsor: 'Example sponsor',
  jurisdiction: 'FL',
  sessionKey: '2026',
  status: 'In committee',
  sourceUrl: 'https://example.gov/bill',
  summary: 'Source description',
  sourceCheckedAt: now.toISOString(),
  sourceCheckAttemptedAt: now.toISOString(),
  sourceCheckStatus: 'success',
  coverage: { actions: true, committees: true, relations: true, amendments: true },
  committees: [
    { id: 'c1', name: 'Health', current: true, date: '2026-01-01' },
    { id: 'c2', name: 'Finance', current: false, date: '2026-01-02' },
  ],
  relations: [],
  events: ['2026-06-20', '2026-06-22', '2026-06-25', '2026-06-25', '2026-06-27'].map((date, i) => ({
    key: `${id}:${i}`,
    kind: 'action',
    sourceIdentity: String(i),
    revisionHash: String(i),
    date,
    text: `Action ${i}`,
    order: i,
    observedAt: now.toISOString(),
    url: 'https://example.gov/action',
  })),
});
const assignment = (id: string, folderId = 'f1'): ReportAssignment => ({
  id: `${folderId}:${id}`,
  folderId,
  folderName: folderId,
  folderVersion: 0,
  archived: false,
  billId: id,
  version: 0,
  topPriority: false,
  importance: 'normal',
  position: 'none',
  internalComments: 'PRIVATE SECRET',
  externalComments: 'Approved comment',
});
const document = (
  overrides: unknown = {},
  bills = [bill('b1', 'HB 93')],
  assignments = bills.map((b) => assignment(b.id)),
) =>
  makeDocument({
    report: { id: 'report', name: 'Synthetic report', version: 1, settings: settings(overrides) },
    bills,
    assignments,
    cutoff: '2026-06-26',
    now,
    audience: 'external',
  });

describe('operational report semantics', () => {
  test.each([
    [
      'Off:',
      'Last 5 Days Actions:',
      'Off:',
      true,
      'Last action date',
      'Only LobbyTools subscribers can view bill links',
      'five_days',
    ],
    [
      'All Committee References:',
      'Last 3 Actions:',
      'Title and last action:',
      false,
      'Bill number',
      'Only LobbyTools subscribers can view bill links',
      'last3',
    ],
    [
      'Current Committee:',
      'Last Action:',
      'Title Only:',
      true,
      'Bill number',
      'Anyone can view bill links',
      'last',
    ],
    [
      'All Committee References:',
      'Last Action:',
      'Off:',
      true,
      'Bill number',
      'Anyone can view bill links',
      'last',
    ],
    [
      'Current Committee:',
      'Last 3 Actions:',
      'Title Only:',
      true,
      'Last action date',
      'Only LobbyTools subscribers can view bill links',
      'last3',
    ],
    [
      'Current Committee:',
      'Last Action:',
      'Title and last action:',
      true,
      'Bill number',
      'Only LobbyTools subscribers can view bill links',
      'last',
    ],
  ])(
    'renders captured controls %s / %s / %s',
    (
      committee_references,
      actions,
      related_bills,
      show_summary,
      order,
      bill_link_access,
      expected,
    ) => {
      const normalized = capturedReport({
        committee_references,
        actions,
        related_bills,
        show_summary,
        order,
        bill_link_access,
        other_checked_flags: [],
      });
      expect(normalized.actions).toBe(expected);
      expect(normalized.internalComments).toBe(false);
      const result = document(normalized);
      expect(result.complete).toBe(true);
      expect(renderReport(result).html).toContain('Synthetic HB 93');
    },
  );
  it('retains an unchanged tracked bill with an empty action display window', () => {
    const old = bill('old', 'SB 122');
    old.events = old.events.slice(0, 1);
    const d = document({ actions: 'five_days' }, [old]);
    expect(d.rows).toHaveLength(1);
    expect(d.rows[0]!.actions).toEqual([]);
    expect(d.rows[0]!.lastActionAt).toBe('2026-06-20');
    expect(
      document({ actions: 'five_days', actionDateFrom: '2026-06-22' }, [old]).rows,
    ).toHaveLength(0);
  });
  it('orders across chambers by number and shows the selected final three chronologically', () => {
    const d = document({ actions: 'last3' }, [
      bill('b1', 'HB 289'),
      bill('b2', 'SB 122'),
      bill('b3', 'HB 93'),
    ]);
    expect(d.rows.map((r) => r.number)).toEqual(['HB 93', 'SB 122', 'HB 289']);
    expect(d.rows[0]!.actions.map((a) => a.text)).toEqual(['Action 1', 'Action 2', 'Action 3']);
  });
  it('preserves folder context and related primary appearances while redacting internal data', () => {
    const b = bill('b1', 'HB 93');
    b.relations = [
      {
        id: b.id,
        number: b.number,
        title: b.title,
        category: 'Identical',
        sourceUrl: b.sourceUrl,
        actions: b.events,
      },
    ];
    const d = document(
      {
        internalComments: true,
        externalComments: true,
        relations: 'title_action',
        committees: 'all',
      },
      [b],
      [assignment('b1'), assignment('b1', 'f2')],
    );
    expect(d.rows).toHaveLength(2);
    expect(d.rows[0]!.relations).toHaveLength(1);
    expect(d.rows[0]!.committees).toHaveLength(2);
    expect(JSON.stringify(d)).not.toContain('PRIVATE SECRET');
    expect(renderReport(d).html).not.toContain('PRIVATE SECRET');
    expect(renderReport(d).html).toContain('Approved comment');
  });
  it('holds failed coverage and separately permits explicitly accepted optional gaps', () => {
    const b = bill('b1', 'HB 93');
    b.sourceCheckStatus = 'failed';
    expect(document({}, [b]).complete).toBe(false);
    b.sourceCheckStatus = 'success';
    b.summary = null;
    expect(document({}, [b]).complete).toBe(false);
    expect(document({ acceptOptionalGaps: true }, [b]).complete).toBe(true);
  });
  it('does not mutate a prior snapshot when live membership changes and escapes untrusted content', () => {
    const b = bill('b1', 'HB 93');
    b.title = '<script>bad()</script>';
    b.sourceUrl = 'javascript:bad()';
    const first = document({}, [b]),
      saved = JSON.stringify(first);
    document({}, [bill('b2', 'SB 100')]);
    expect(JSON.stringify(first)).toBe(saved);
    expect(renderReport(first).html).not.toContain('<script>');
    expect(renderReport(first).html).not.toContain('href="javascript:');
  });
});

describe('recipients and captured rules', () => {
  it('preserves alias identities while deduplicating a normalized destination', () => {
    const base = {
      email: normalizeEmail('TEST@example.com'),
      role: 'bcc' as const,
      name: '',
      lists: [],
      manual: false,
    };
    const result = mergeRecipients([
      { ...base, contacts: [{ id: 'a', version: 0 }] },
      { ...base, contacts: [{ id: 'b', version: 0 }] },
    ]);
    expect(result).toHaveLength(1);
    expect(result[0]!.contacts).toHaveLength(2);
    expect(() => mergeRecipients([result[0]!, { ...result[0]!, role: 'to' }])).toThrow(
      'CONFLICTING_TO_BCC',
    );
  });
  it('uses captured cadence, keeps empty targets, and rejects other alert families', () => {
    expect(
      capturedRule({
        family: 'Bill Action and Amendments Filed Alert',
        name: 'Daily example',
        frequency: ['Real time'],
        selected_targets: [],
      }),
    ).toMatchObject({ cadence: 'realtime', sourceFolderIds: [] });
    expect(() => capturedRule({ family: 'News' })).toThrow('OUTSIDE_PHASE2');
  });
});

describe('durable local schedule policy', () => {
  it('runs the spring-forward missing time at the next valid minute and fall-back once', () => {
    expect(localOccurrence('2026-03-08', 150, 'America/New_York').toISOString()).toBe(
      '2026-03-08T07:00:00.000Z',
    );
    expect(localOccurrence('2026-11-01', 90, 'America/New_York').toISOString()).toBe(
      '2026-11-01T05:30:00.000Z',
    );
    expect(
      nextOccurrence(new Date('2026-11-01T05:31:00Z'), 'America/New_York', 90).toISOString(),
    ).toBe('2026-11-02T06:30:00.000Z');
  });
  it('advances five consecutive local daily windows across a clock change', () => {
    let at = new Date('2026-03-06T00:00:00Z');
    const days: string[] = [];
    for (let i = 0; i < 5; i++) {
      at = nextOccurrence(at, 'America/New_York', 480);
      days.push(localTime(at, 'America/New_York').date);
    }
    expect(days).toEqual(['2026-03-06', '2026-03-07', '2026-03-08', '2026-03-09', '2026-03-10']);
  });
});
