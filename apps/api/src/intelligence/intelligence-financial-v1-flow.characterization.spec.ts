import { FEC_DISCLAIMER } from './fec-disclaimer.js';
import {
  clientId,
  deferred,
  flowRow,
  harness,
  installHooks,
  pacRow,
  tenantId,
  type PacGiving,
} from '../../test/fixtures/intelligence-financial.js';

installHooks();

function employer(rows: Record<string, unknown> = {}) {
  return harness({ rows: { employerMappings: [{ externalName: 'Acme' }], ...rows } });
}

const emptySummary = {
  totalContributions: 0,
  totalAmount: 0,
  committeeCount: 0,
  candidateCount: 0,
  memberCount: 0,
  billCount: 0,
};

it('financial flow validates the tenant client before any PAC or employer read', async () => {
  const h = harness({ rows: { client: null } });
  const pac = jest.spyOn(h.subject, 'getPacGiving');
  expect(await h.service.getFecMoneyFlow(clientId, tenantId)).toEqual({
    clientId,
    clientName: null,
    mappedEmployer: null,
    summary: emptySummary,
    contributionType: 'individual_employer_linked',
    committees: [],
    disclaimer: FEC_DISCLAIMER,
    pacGiving: {
      tracked: false,
      committees: [],
      summary: { totalAmount: 0, disbursementCount: 0, recipientCount: 0 },
      coverage: {
        status: 'unmapped',
        cycles: [2022, 2024, 2026],
        lastSyncedAt: null,
        message: 'No FEC committee is mapped to this client.',
      },
    },
  });
  expect(pac).not.toHaveBeenCalled();
  expect(h.calls.map((call) => call.operation)).toEqual(['withTenant', 'client']);
  expect(h.callsOf('client')[0]).toMatchObject({
    scope: 'tenant',
    tenantId,
    transaction: 1,
    args: [{ where: { id: clientId }, select: { id: true, name: true } }],
  });
});

it('financial flow evaluates real PAC giving once before the no-employer early return', async () => {
  const h = harness({
    rows: {
      committeeMappings: [{ externalId: 'C1' }],
      pacRows: [pacRow({ total_amount: 75 })],
      employerMappings: [{ externalName: null }, { externalName: ' ' }, { externalName: '' }],
    },
  });
  const pac = jest.spyOn(h.subject, 'getPacGiving');
  const result = await h.service.getFecMoneyFlow(clientId, tenantId);
  expect(pac).toHaveBeenCalledTimes(1);
  expect(pac).toHaveBeenCalledWith(clientId, tenantId);
  expect(result.pacGiving).toBe(await (pac.mock.results[0]!.value as Promise<PacGiving>));
  expect(result).toMatchObject({
    clientName: 'Acme Research',
    mappedEmployer: null,
    contributionType: 'individual_employer_linked',
    summary: emptySummary,
    committees: [],
    pacGiving: {
      tracked: true,
      summary: { totalAmount: 75, disbursementCount: 2, recipientCount: 1 },
    },
  });
  expect(h.calls.map((call) => call.operation)).toEqual([
    'withTenant',
    'client',
    'withTenant',
    'committeeMappings',
    'committeeCatalog',
    'pacSync',
    'pacRows',
    'withTenant',
    'employerMappings',
  ]);
  expect(h.callsOf('employerMappings')[0]).toMatchObject({
    scope: 'tenant',
    tenantId,
    transaction: 3,
    args: [
      {
        where: { clientId, source: 'fec_employer', confirmed: true },
        orderBy: { confidence: 'desc' },
      },
    ],
  });
});

it('financial flow binds the stable employer union and exact global sponsor-link queries', async () => {
  const h = employer({
    employerMappings: [
      { externalName: ' Acme ' },
      { externalName: 'ACME' },
      { externalName: 'Acme' },
      { externalName: 'Research Labs' },
      { externalName: null },
    ],
    flowRows: [
      flowRow(),
      flowRow({ candidate_name: 'ALICE MEMBER' }),
      flowRow({ candidate_name: ' Bob Member ' }),
    ],
  });
  const pac = jest.spyOn(h.subject, 'getPacGiving');
  const result = await h.service.getFecMoneyFlow(clientId, tenantId);
  expect(pac).toHaveBeenCalledTimes(1);
  expect(result.pacGiving).toBe(await (pac.mock.results[0]!.value as Promise<PacGiving>));
  expect(result.mappedEmployer).toBe('Acme, ACME, Research Labs');
  expect(h.callsOf('flowRows')[0]!.query).toMatchObject({
    sql: 'SELECT fc.committee_id, MAX(fc.committee_name) AS committee_name, fc.candidate_id, fc.candidate_name, COUNT(*)::int AS contribution_count, COALESCE(SUM(fc.amount), 0)::float AS total_amount, MAX(fc.contribution_date) AS latest_contribution_date FROM fec_contribution fc WHERE LOWER(fc.contributor_employer) = ANY($1::text[]) AND fc.contribution_date >= $2 GROUP BY fc.committee_id, fc.candidate_id, fc.candidate_name ORDER BY total_amount DESC LIMIT 250',
    values: [['acme', 'acme', 'research labs'], new Date('2024-10-13T12:00:00.000Z')],
  });
  expect(h.callsOf('members')[0]!.query).toMatchObject({
    sql: 'SELECT x.candidate_name, cb.sponsor_name AS member_name, COUNT(DISTINCT cb.id)::int AS bill_count FROM ( SELECT UNNEST($1::text[]) AS candidate_name ) x JOIN congress_bill cb ON LOWER(cb.sponsor_name) = LOWER(x.candidate_name) GROUP BY x.candidate_name, cb.sponsor_name',
    values: [['Alice Member', 'ALICE MEMBER', ' Bob Member ']],
  });
  expect(h.callsOf('bills')[0]!.query).toMatchObject({
    sql: 'SELECT cb.sponsor_name, cb.id AS bill_id, cb.title AS bill_title FROM congress_bill cb WHERE LOWER(cb.sponsor_name) = ANY($1::text[]) ORDER BY cb.latest_action_date DESC NULLS LAST LIMIT 500',
    values: [['alice member', 'alice member', ' bob member ']],
  });
  expect(h.calls.map((call) => call.operation)).toEqual([
    'withTenant',
    'client',
    'withTenant',
    'committeeMappings',
    'withTenant',
    'employerMappings',
    'flowRows',
    'members',
    'bills',
  ]);
  expect(h.callsOf('flowRows')[0]!.scope).toBe('global');
  expect(h.callsOf('members')[0]!.tenantId).toBeUndefined();
  expect(h.callsOf('bills')[0]!.tenantId).toBeUndefined();
});

it('financial flow reads its 730-day clock after PAC and employer resolution', async () => {
  const held = deferred<unknown>();
  const h = harness({ results: { employerMappings: held.promise } });
  const pending = h.service.getFecMoneyFlow(clientId, tenantId);
  await h.started('employerMappings');
  jest.setSystemTime(new Date('2028-01-01T00:00:00.000Z'));
  held.resolve([{ externalName: 'Acme' }]);
  const result = await pending;
  expect(h.callsOf('flowRows')[0]!.query!.values[1]).toEqual(new Date('2026-01-01T00:00:00.000Z'));
  expect(result.pacGiving.coverage.cycles).toEqual([2022, 2024, 2026]);
  expect(result.summary).toEqual(emptySummary);
});

it('financial flow waits for real PAC completion before resolving employer mappings', async () => {
  const held = deferred<unknown>();
  const h = harness({
    rows: { committeeMappings: [{ externalId: 'C1' }] },
    results: { pacRows: held.promise },
  });
  const pending = h.service.getFecMoneyFlow(clientId, tenantId);
  await h.started('pacRows');
  expect(h.callsOf('employerMappings')).toEqual([]);
  held.resolve([pacRow()]);
  expect((await pending).pacGiving.summary.totalAmount).toBe(100);
  expect(h.events.indexOf('done:pacRows')).toBeLessThan(h.events.indexOf('start:employerMappings'));
});

it('financial flow groups signed dollars and dates while retaining the first committee name', async () => {
  const later = new Date('2026-10-10T00:00:00.000Z');
  const h = employer({
    flowRows: [
      flowRow({ committee_name: null, total_amount: 20, latest_contribution_date: null }),
      flowRow({
        committee_name: 'Later name',
        candidate_name: 'Bob Member',
        total_amount: 50,
        contribution_count: 3,
        latest_contribution_date: later,
      }),
      flowRow({ candidate_name: 'Carol Member', total_amount: -5, contribution_count: -1 }),
      flowRow({ committee_id: 'C2', total_amount: 100 }),
    ],
  });
  const result = await h.service.getFecMoneyFlow(clientId, tenantId);
  expect(
    result.committees.map((committee) => ({
      id: committee.committeeId,
      name: committee.committeeName,
      amount: committee.totalAmount,
      count: committee.contributionCount,
      date: committee.latestContributionDate,
    })),
  ).toEqual([
    {
      id: 'C2',
      name: 'Committee One',
      amount: 100,
      count: 2,
      date: new Date('2026-10-01T00:00:00.000Z'),
    },
    { id: 'C1', name: 'C1', amount: 65, count: 4, date: later },
  ]);
  expect(
    result.committees[1]!.candidates.map((candidate) => [
      candidate.candidateName,
      candidate.totalAmount,
    ]),
  ).toEqual([
    ['Bob Member', 50],
    ['Alice Member', 20],
    ['Carol Member', -5],
  ]);
  expect(result.summary).toEqual({
    totalContributions: 6,
    totalAmount: 165,
    committeeCount: 2,
    candidateCount: 3,
    memberCount: 0,
    billCount: 0,
  });
  expect(result.disclaimer).toBe(FEC_DISCLAIMER);
});

it('financial flow links members and sponsored bills by case-insensitive candidate names', async () => {
  const h = employer({
    flowRows: [flowRow(), flowRow({ committee_id: 'C2', candidate_name: 'ALICE MEMBER' })],
    members: [
      { candidate_name: 'alice member', member_name: 'Alice Member', bill_count: 4 },
      { candidate_name: 'ALICE MEMBER', member_name: 'ALICE MEMBER', bill_count: 2 },
    ],
    bills: [
      { sponsor_name: 'aLiCe MeMbEr', bill_id: 'bill-1', bill_title: 'Linked bill' },
      { sponsor_name: 'Other Member', bill_id: 'bill-2', bill_title: 'Foreign bill' },
      { sponsor_name: null, bill_id: 'bill-3', bill_title: 'Missing sponsor' },
    ],
  });
  const result = await h.service.getFecMoneyFlow(clientId, tenantId);
  expect(result.committees[0]!.candidates[0]!.linkedMembers).toEqual([
    { memberName: 'Alice Member', billCount: 4 },
    { memberName: 'ALICE MEMBER', billCount: 2 },
  ]);
  expect(result.committees[1]!.bills).toEqual([
    { billId: 'bill-1', billTitle: 'Linked bill', sponsorName: 'aLiCe MeMbEr' },
  ]);
  expect(result.summary).toEqual({
    totalContributions: 4,
    totalAmount: 200,
    committeeCount: 2,
    candidateCount: 1,
    memberCount: 1,
    billCount: 1,
  });
});

it('financial flow preserves null and empty candidate distinctions without querying unnamed sponsors', async () => {
  const h = employer({
    flowRows: [
      flowRow({ candidate_name: null, candidate_id: null }),
      flowRow({ candidate_name: '', candidate_id: null }),
    ],
  });
  const result = await h.service.getFecMoneyFlow(clientId, tenantId);
  expect(result.committees[0]!.candidates.map((candidate) => candidate.candidateName)).toEqual([
    'Unknown candidate',
    '',
  ]);
  expect(result.summary.candidateCount).toBe(2);
  expect(h.callsOf('members')).toEqual([]);
  expect(h.callsOf('bills')).toEqual([]);
});

it('financial flow deduplicates bill IDs with last payload and first insertion position before its cap', async () => {
  const bills = Array.from({ length: 16 }, (_, index) => ({
    sponsor_name: 'Alice Member',
    bill_id: `bill-${index}`,
    bill_title: `Title ${index}`,
  }));
  const h = employer({
    flowRows: [
      flowRow({ total_amount: 1 }),
      flowRow({ candidate_name: 'Bob Member', total_amount: 9 }),
    ],
    bills: [
      ...bills,
      { sponsor_name: 'Bob Member', bill_id: 'bill-0', bill_title: 'Updated title' },
      { sponsor_name: 'Bob Member', bill_id: 'bob-bill', bill_title: 'Bob bill' },
    ],
  });
  const result = await h.service.getFecMoneyFlow(clientId, tenantId);
  expect(result.committees[0]!.candidates[0]!.candidateName).toBe('Bob Member');
  expect(result.committees[0]!.bills.map((bill) => bill.billId)).toEqual([
    'bill-0',
    'bill-1',
    'bill-2',
    'bill-3',
    'bill-4',
    'bill-5',
    'bill-6',
    'bill-7',
    'bill-8',
    'bill-9',
    'bill-10',
    'bill-11',
    'bill-12',
    'bill-13',
    'bill-14',
  ]);
  expect(result.committees[0]!.bills[0]).toEqual({
    billId: 'bill-0',
    billTitle: 'Updated title',
    sponsorName: 'Bob Member',
  });
  expect(result.summary.billCount).toBe(15);
});

it('financial flow counts only displayed bills across independently capped committees', async () => {
  const h = employer({
    flowRows: [flowRow(), flowRow({ committee_id: 'C2', candidate_name: 'Bob Member' })],
    bills: [
      ...Array.from({ length: 16 }, (_, index) => ({
        sponsor_name: 'Alice Member',
        bill_id: `bill-${index}`,
        bill_title: `Title ${index}`,
      })),
      { sponsor_name: 'Bob Member', bill_id: 'bill-15', bill_title: 'Visible in second committee' },
    ],
  });
  const result = await h.service.getFecMoneyFlow(clientId, tenantId);
  expect(result.committees.map((committee) => committee.bills.length)).toEqual([15, 1]);
  expect(result.summary.billCount).toBe(16);
});

it('financial flow preserves raw numeric-string accumulation unlike PAC numeric coercion', async () => {
  const h = employer({ flowRows: [flowRow({ total_amount: '12', contribution_count: '2' })] });
  const result = await h.service.getFecMoneyFlow(clientId, tenantId);
  expect(result.committees[0]).toMatchObject({
    totalAmount: '012',
    contributionCount: '02',
    candidates: [{ totalAmount: '12', contributionCount: '2' }],
  });
  expect(result.summary).toMatchObject({ totalAmount: '0012', totalContributions: '002' });
});

it('financial flow preserves equal-value source order and leaves raw inputs unchanged', async () => {
  const rows = [
    flowRow({ committee_id: 'C2', candidate_name: 'Bob Member', total_amount: 200 }),
    flowRow(),
    flowRow({ candidate_name: 'Carol Member' }),
  ];
  const original = structuredClone(rows);
  const h = employer({ flowRows: rows });
  const result = await h.service.getFecMoneyFlow(clientId, tenantId);
  expect(result.committees.map((committee) => committee.committeeId)).toEqual(['C2', 'C1']);
  expect(result.committees[1]!.candidates.map((candidate) => candidate.candidateName)).toEqual([
    'Alice Member',
    'Carol Member',
  ]);
  expect(result.committees[1]!.latestContributionDate).toBe(rows[1]!.latest_contribution_date);
  expect(rows).toEqual(original);
});

it('financial flow waits for member lookup before launching the sponsored bill query', async () => {
  const held = deferred<unknown>();
  const h = harness({
    rows: { employerMappings: [{ externalName: 'Acme' }], flowRows: [flowRow()] },
    results: { members: held.promise },
  });
  const pending = h.service.getFecMoneyFlow(clientId, tenantId);
  await h.started('members');
  expect(h.callsOf('bills')).toEqual([]);
  held.resolve([]);
  expect((await pending).summary.totalAmount).toBe(100);
  expect(h.events.indexOf('done:members')).toBeLessThan(h.events.indexOf('start:bills'));
});

it.each([
  { operation: 'client', later: 'committeeMappings' },
  { operation: 'committeeMappings', later: 'employerMappings' },
  { operation: 'employerMappings', later: 'flowRows' },
  { operation: 'flowRows', later: 'members' },
  { operation: 'members', later: 'bills' },
  { operation: 'bills', later: 'never' },
])('financial flow propagates $operation failure and stops subsequent I/O', async (example) => {
  const failure = new Error(`failure:${example.operation}`);
  const h = harness({
    rows: { employerMappings: [{ externalName: 'Acme' }], flowRows: [flowRow()] },
    errors: { [example.operation]: failure },
  });
  await expect(h.service.getFecMoneyFlow(clientId, tenantId)).rejects.toBe(failure);
  expect(h.callsOf(example.operation)).toHaveLength(1);
  expect(h.callsOf(example.later)).toEqual([]);
});
