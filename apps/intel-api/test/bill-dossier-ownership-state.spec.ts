import { deferred, harness, installHooks } from './fixtures/bill-dossier-ownership/harness.js';
import { day, now, stateBill, stateId, stateVote } from './fixtures/bill-dossier-ownership/rows.js';

installHooks();

it('starts the three distinct state reads eagerly after identity and never calls a federal or funding source', async () => {
  const gate = deferred<unknown>();
  const h = harness({
    results: {
      getStateBillActionsByIds: gate.promise,
      getStateVotesForBills: gate.promise,
      getMovedCompanions: gate.promise,
    },
  });
  const pending = h.service.getGlobalDossier(` ${stateId} `, { funding: true });
  await h.started('getMovedCompanions');
  expect(h.calls.map((call) => [call.operation, call.args])).toEqual([
    ['getStateBillById', [stateId]],
    ['getStateBillActionsByIds', [[stateId]]],
    ['getStateVotesForBills', [[stateId], true]],
    ['getMovedCompanions', [[stateId]]],
  ]);
  gate.resolve([]);
  const result = await pending;
  expect(result.funding).toMatchObject({
    available: false,
    positions: [],
    reqCompare: null,
    analysisStatus: 'unavailable',
  });
  expect(result.funding.status).toBe(
    'State funding data is not available. No $0 is shown unless a source states zero.',
  );
  expect(result.governingRules).toEqual([]);
  expect(result.bill).toMatchObject({ id: stateId, isState: true, jurisdiction: 'FL' });
});

it.each(['getStateBillActionsByIds', 'getStateVotesForBills', 'getMovedCompanions'] as const)(
  'keeps state %s failure fatal after all three read promises launch',
  async (operation) => {
    const error = new Error('state source failed');
    const h = harness({ errors: { [operation]: error } });
    await expect(h.service.getGlobalDossier(stateId)).rejects.toBe(error);
    expect(h.calls.map((call) => call.operation)).toEqual([
      'getStateBillById',
      'getStateBillActionsByIds',
      'getStateVotesForBills',
      'getMovedCompanions',
    ]);
  },
);

it.each([
  ['success', 0, true],
  ['success', day - 1, true],
  ['success', day, false],
  ['success', -1, false],
  ['failure', 0, false],
  ['unknown', 0, false],
] as const)(
  'preserves state freshness for status %s and check age %s',
  async (status, age, fresh) => {
    const checked = new Date(now.getTime() - age);
    const h = harness({
      results: {
        getStateBillById: stateBill({
          sourceCheckStatus: status,
          sourceCheckedAt: checked,
          sourceCheckAttemptedAt: now,
          syncedAt: new Date('2026-10-10T00:00:00.000Z'),
          textDate: new Date('2026-10-01T00:00:00.000Z'),
        }),
      },
    });
    const { provenance } = await h.service.getGlobalDossier(stateId);
    expect(provenance.sources[0]!.fresh).toBe(fresh);
    expect(provenance.sources[0]!.as).toBe(checked.toISOString());
    expect(provenance.lastSyncedAt).toBe('2026-10-10T00:00:00.000Z');
    expect(provenance.documentDate).toBe('2026-10-01T00:00:00.000Z');
    expect(provenance.sourceCheckAttemptedAt).toBe(now.toISOString());
  },
);

it('uses the second original wall-clock read when the freshness threshold is crossed between reads', async () => {
  const h = harness({
    results: {
      getStateBillById: stateBill({ sourceCheckStatus: 'success', sourceCheckedAt: now }),
    },
  });
  const clock = jest
    .spyOn(Date, 'now')
    .mockReturnValueOnce(now.getTime())
    .mockReturnValueOnce(now.getTime() + day);
  expect((await h.service.getGlobalDossier(stateId)).provenance.sources[0]!.fresh).toBe(false);
  expect(clock).toHaveBeenCalledTimes(2);
});

it('retains explicit failed source-check reasons without replacing them with legislative dates', async () => {
  const h = harness({
    results: {
      getStateBillById: stateBill({
        sourceCheckedAt: null,
        syncedAt: null,
        sourceCheckError: '',
        latestActionDate: now,
        textDate: now,
      }),
    },
  });
  const result = await h.service.getGlobalDossier(stateId);
  expect(result.provenance.sourceCheckReason).toBe('');
  expect(result.provenance.lastSyncedAt).toBeNull();
  expect(result.provenance.sources[0]!.fresh).toBe(false);
});

it.each(['in_committee', 'enacted', 'vetoed', 'veto_overridden'] as const)(
  'applies replacement read repair only when canonical status %s permits it',
  async (status) => {
    const actionAt = new Date('2026-10-12T12:00:00.000Z');
    const h = harness({
      results: {
        getStateBillById: stateBill({
          status,
          statusAt: now,
          latestActionDate: actionAt,
          latestActionText: 'Laid on Table, companion bill(s) passed, see CS/SB 200 (Ch. 2026-42).',
        }),
        getMovedCompanions: [
          {
            billKey: stateId,
            relatedBillKey: 'fl-2026-sb200',
            relatedDisplay: 'SB 200',
            relatedStatus: 'enacted',
            relatedStatusAt: now,
            linkType: 'companion',
          },
        ],
      },
    });
    const result = await h.service.getGlobalDossier(stateId);
    expect(result.bill.stage).toBe(status === 'in_committee' ? 'superseded' : status);
    expect(result.bill.statusAt).toBe(
      status === 'in_committee' ? actionAt.toISOString() : now.toISOString(),
    );
    expect(result.relatedVehicles[0]!.role).toContain('Chapter 2026-42');
  },
);

it('keeps unresolved state vote identities and null outcomes rather than inventing a result', async () => {
  const h = harness({
    results: { getStateVotesForBills: [stateVote({ id: undefined, passed: null, motion: null })] },
  });
  const result = await h.service.getGlobalDossier(stateId);
  expect(result.votes[0]).toMatchObject({
    id: `${stateId}:unresolved-vote-identity`,
    target: 'passage',
    result: null,
    resultSev: 'neutral',
    tally: '70-30',
  });
  expect(result.noVote).toBeNull();
});
