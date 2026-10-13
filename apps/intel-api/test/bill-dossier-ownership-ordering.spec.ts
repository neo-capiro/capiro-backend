import {
  contextBundle,
  deferred,
  federalBundle,
  fundingBundle,
  harness,
  installHooks,
} from './fixtures/bill-dossier-ownership/harness.js';
import {
  billId,
  clientId,
  identity,
  parentPackage,
  tenantId,
} from './fixtures/bill-dossier-ownership/rows.js';

installHooks();

it('awaits client existence before the bill core and starts all four context reads only after core completion', async () => {
  const client = deferred<unknown>(),
    core = deferred<unknown>(),
    context = deferred<unknown>();
  const h = harness({
    results: {
      getClientProfile: client.promise,
      getBillDossierIdentity: core.promise,
      tracking: context.promise.then(() => null),
      alerts: context.promise,
      match: context.promise.then(() => null),
      clientHearings: context.promise,
    },
  });
  const pending = h.service.getClientDossier(tenantId, clientId, ` ${billId} `);
  expect(h.calls.map((call) => call.operation)).toEqual(['getClientProfile']);
  expect(h.calls[0]!.args).toEqual([tenantId, clientId]);
  client.resolve({ name: 'Acme', sectorTag: null });
  await h.started('getBillDossierIdentity');
  expect(h.calls.map((call) => call.operation)).toEqual([
    'getClientProfile',
    'getBillDossierIdentity',
  ]);
  core.resolve(identity());
  await h.started('clientHearings');
  expect(h.calls.slice(-4).map((call) => call.operation)).toEqual(contextBundle);
  expect(h.transactions.map((tx) => tx.tenantId)).toEqual([tenantId, tenantId, tenantId, tenantId]);
  expect(h.callsOf('tracking')[0]!.args).toEqual([{ where: { tenantId, clientId, billId } }]);
  context.resolve([]);
  expect((await pending).context).toEqual({
    contextType: 'client',
    externalRef: clientId,
    name: 'Acme',
  });
});

it('never reads a core or tenant context after missing client authority', async () => {
  const h = harness({ results: { getClientProfile: null } });
  await expect(h.service.getClientDossier(tenantId, clientId, billId)).rejects.toThrow(
    'CLIENT_NOT_FOUND',
  );
  expect(h.calls.map((call) => call.operation)).toEqual(['getClientProfile']);
  expect(h.transactions).toEqual([]);
});

it.each(['', 'not-a-uuid'])(
  'rejects malformed client %s before any repository read',
  async (client) => {
    const h = harness();
    await expect(h.service.getClientDossier(tenantId, client, billId)).rejects.toThrow(
      'CLIENT_NOT_FOUND',
    );
    expect(h.calls).toEqual([]);
  },
);

it('rejects empty bill identity before attempting client authority', async () => {
  const h = harness();
  await expect(h.service.getClientDossier(tenantId, clientId, '   ')).rejects.toThrow(
    'BILL_NOT_FOUND',
  );
  expect(h.calls).toEqual([]);
});

it('waits for all seven federal reads before starting funding and waits for all five funding reads before tallying', async () => {
  const seven = deferred<unknown>(),
    five = deferred<unknown>();
  const h = harness({
    results: {
      getBillActions: seven.promise,
      getBillVotes: seven.promise,
      getGoverningRules: seven.promise,
      getBillCommittees: seven.promise,
      getBillFiscalNotes: seven.promise,
      getBillSourceFreshness: seven.promise.then(() => null),
      getUpcomingHearingsForBills: seven.promise,
      getBillFundingPositions: five.promise,
      getBillProgramElementImpacts: five.promise,
      getRelatedBudgetVehicles: five.promise,
      getBillFundingProvisions: five.promise,
      getParentBudgetPackage: five.promise.then(() => parentPackage()),
    },
  });
  const pending = h.service.getGlobalDossier(billId, { funding: true });
  await h.started('getUpcomingHearingsForBills');
  expect(h.calls.map((call) => call.operation)).toEqual([
    'getBillDossierIdentity',
    ...federalBundle,
  ]);
  expect(h.callsOf('getBillFundingPositions')).toHaveLength(0);
  seven.resolve([]);
  await h.started('getParentBudgetPackage');
  expect(h.calls.slice(-5).map((call) => call.operation)).toEqual(fundingBundle);
  expect(h.callsOf('getBillMemberVoteSummary')).toHaveLength(0);
  five.resolve([]);
  await pending;
  expect(h.calls.map((call) => call.operation)).toEqual([
    'getBillDossierIdentity',
    ...federalBundle,
    ...fundingBundle,
    'getBillMemberVoteSummary',
  ]);
  expect(h.callsOf('getBillActions')[0]!.args).toEqual([billId, 50]);
  expect(h.callsOf('getBillVotes')[0]!.args).toEqual([billId, 25]);
  expect(h.callsOf('getBillFiscalNotes')[0]!.args).toEqual([billId, 10]);
  expect(h.callsOf('getBillFundingPositions')[0]!.args).toEqual([billId, 50]);
  expect(h.callsOf('getBillProgramElementImpacts')[0]!.args).toEqual([billId, 100]);
  expect(h.callsOf('getRelatedBudgetVehicles')[0]!.args).toEqual([billId, 25]);
  expect(h.callsOf('getBillFundingProvisions')[0]!.args).toEqual([billId, 50]);
});

it.each([undefined, false])(
  'skips every funding I/O operation for funding option %s',
  async (funding) => {
    const h = harness();
    const result = await h.service.getGlobalDossier(billId, { funding });
    expect(h.calls.map((call) => call.operation)).toEqual([
      'getBillDossierIdentity',
      ...federalBundle,
      'getBillMemberVoteSummary',
    ]);
    expect(result.funding).toMatchObject({ available: false, positions: [], reqCompare: null });
    expect(result.context).toBeNull();
    expect(h.transactions).toHaveLength(0);
  },
);

it('reads the caller funding option lazily after the federal bundle and observes a replacement across that await', async () => {
  const gate = deferred<unknown>();
  let funding = false;
  const reads: boolean[] = [];
  const options = {
    get funding() {
      reads.push(funding);
      return funding;
    },
  };
  const h = harness({ results: { getBillActions: gate.promise } });
  const pending = h.service.getGlobalDossier(billId, options);
  await h.started('getUpcomingHearingsForBills');
  expect(reads).toEqual([]);
  funding = true;
  gate.resolve([]);
  await pending;
  expect(reads).toEqual([true]);
  expect(h.callsOf('getBillFundingPositions')).toHaveLength(1);
});

it.each(federalBundle)(
  'keeps federal %s rejection fatal and never starts funding or client context',
  async (operation) => {
    const error = new Error(`${operation} unavailable`);
    const h = harness({ errors: { [operation]: error } });
    await expect(
      h.service.getClientDossier(tenantId, clientId, billId, { funding: true }),
    ).rejects.toBe(error);
    expect(h.calls.slice(2).map((call) => call.operation)).toEqual(federalBundle);
    for (const source of fundingBundle) expect(h.callsOf(source)).toHaveLength(0);
    expect(h.transactions).toHaveLength(0);
  },
);

it.each(fundingBundle)(
  'keeps funding %s rejection fatal after launching all five reads and before tally/context',
  async (operation) => {
    const error = new Error(`${operation} unavailable`);
    const h = harness({ errors: { [operation]: error } });
    await expect(
      h.service.getClientDossier(tenantId, clientId, billId, { funding: true }),
    ).rejects.toBe(error);
    expect(h.calls.slice(-5).map((call) => call.operation)).toEqual(fundingBundle);
    expect(h.callsOf('getBillMemberVoteSummary')).toHaveLength(0);
    expect(h.transactions).toHaveLength(0);
  },
);

it.each(contextBundle)(
  'keeps client %s rejection fatal after eagerly starting all four tenant reads',
  async (operation) => {
    const error = new Error(`${operation} unavailable`);
    const h = harness({ errors: { [operation]: error } });
    await expect(h.service.getClientDossier(tenantId, clientId, billId)).rejects.toBe(error);
    expect(h.calls.slice(-4).map((call) => call.operation)).toEqual(contextBundle);
    expect(h.transactions).toHaveLength(4);
    expect(h.transactions[h.callsOf(operation)[0]!.transaction! - 1]!.outcome).toBe('rollback');
  },
);
