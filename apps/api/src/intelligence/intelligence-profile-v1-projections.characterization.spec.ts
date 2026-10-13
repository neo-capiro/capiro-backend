import {
  clientId,
  harness,
  hearing,
  installHooks,
  now,
  profileSpine,
  recommendation,
  tenantId,
  trackedBill,
} from '../../test/fixtures/intelligence-profile-v1.js';

import {
  projection,
  districtRows,
  manualPinFixture,
  stageBills,
  regulatoryFixtureOptions,
  hearingFixtureOptions,
  joinFailureFixtureOptions,
} from '../../test/fixtures/intelligence-profile-v1.projections.js';

installHooks();
const roi = (lobbySpend: number, contractWins: number) => ({
  mappedLdaClientIds: [42],
  lobbySpend,
  contractWins,
  roi: 2,
  gap: 5,
});

it.each([
  { lobbying: 0, obligations: 0, state: 'no_activity' },
  { lobbying: 10, obligations: 0, state: 'zero_obligation' },
  { lobbying: 0, obligations: 10, state: 'normal' },
  { lobbying: 10, obligations: 20, state: 'normal' },
])(
  'projects hero truth state $state for lobbying=$lobbying and obligations=$obligations',
  async ({ lobbying, obligations, state }) => {
    const h = harness({ sourceResults: { getLobbyingRoi: roi(lobbying, obligations) } });
    const payload = projection(await h.profile());
    expect(payload.sections.financialFootprint.hero).toEqual({
      lobbyingTtm: lobbying,
      obligationsTtm: obligations,
      returnRatio: 2,
      gap: 5,
      truthState: state,
    });
  },
);

it('projects canonical fallback trajectory separately from the original source label and preserves series references', async () => {
  const yearlySpend = [{ year: 2025, amount: 100 }];
  const obligations = [{ year: 2025, amount: 300 }];
  const quarters = [{ label: '2025 Q1', lobbying: 100, obligations: 300 }];
  const profile = profileSpine({
    lda: { yearlySpend },
    contracting: { yearlySpend: obligations },
    lobbyIntel: { trajectory: 'declining', growthRate: 0.12, totalSpending: 100 },
  });
  const h = harness({
    sourceResults: {
      getClientProfile: profile,
      buildRoiQuarterSeries: quarters,
      getLobbyingRoi: roi(100, 300),
    },
  });
  const payload = projection(await h.profile());
  expect(payload.sections.snapshot.trajectory).toMatchObject({
    label: 'growing',
    growthRate: 0.12,
    totalSpending: 100,
    model: { label: 'growing', confidence: null, score: null, source: 'fallback' },
    fallback: { label: 'declining' },
  });
  expect(payload.sections.financialFootprint.series.lobbying).toBe(yearlySpend);
  expect(payload.sections.financialFootprint.series.obligations).toBe(obligations);
  expect(payload.sections.financialFootprint.series.quarterSeries).toBe(quarters);
  expect(h.sources.buildRoiQuarterSeries).toHaveBeenCalledWith({
    mappedLdaClientIds: [42],
    lobbyingYearly: yearlySpend,
    obligationsYearly: obligations,
    now,
  });
});

it('projects model trajectory from three spend points without sorting the provider series in place', async () => {
  const yearlySpend = [
    { year: 2025, amount: 400 },
    { year: 2023, amount: 100 },
    { year: 2024, amount: 200 },
  ];
  const h = harness({
    sourceResults: {
      getClientProfile: profileSpine({
        lda: { yearlySpend },
        lobbyIntel: { trajectory: 'declining', growthRate: 0.2, totalSpending: 700 },
      }),
    },
  });
  const payload = projection(await h.profile());
  expect(payload.sections.snapshot.trajectory.model).toMatchObject({
    label: 'exploding',
    source: 'model',
  });
  expect(payload.sections.snapshot.trajectory.model.score).toBeGreaterThan(0.5);
  expect(yearlySpend.map((point) => point.year)).toEqual([2025, 2023, 2024]);
});

it('uses only positive linked district spend, sorts before the top-five cap and preserves provider input order', async () => {
  const districts = districtRows();
  const h = harness({
    sourceResults: {
      getDistrictNexusSpend: { linked: true, districts },
      getDistrictNexus: { capabilities: ['Research'] },
    },
  });
  const payload = projection(await h.profile());
  expect(payload.sections.financialFootprint.districtNexus.topDistricts).toEqual([
    {
      district: 'VA-7',
      jobs: 0,
      spend: 60,
      awardCount: 7,
      capability: 'Federal contract spend',
      dataYear: 2026,
    },
    ...[
      [2, 50],
      [4, 40],
      [6, 30],
      [0, 20],
    ].map(([index, spend]) => ({
      district: `VA-${index}`,
      jobs: 0,
      spend,
      awardCount: index,
      capability: 'Federal contract spend',
      dataYear: 0,
    })),
  ]);
  expect(districts.map((row) => row.totalAmount)).toEqual([20, 0, 50, 10, 40, -1, 30, 60]);
  expect(payload.sections.financialFootprint.districtNexus.capabilities).toEqual(['Research']);
});

it('keeps the district list empty for unlinked spend instead of substituting legacy free-text districts', async () => {
  const h = harness({
    sourceResults: {
      getDistrictNexusSpend: { linked: false, districts: [{ totalAmount: 100, district: 'VA-8' }] },
      getDistrictNexus: { topDistricts: [{ district: 'Legacy', jobs: 999 }], capabilities: [] },
    },
  });
  expect(
    projection(await h.profile()).sections.financialFootprint.districtNexus.topDistricts,
  ).toEqual([]);
});

it('passes the full FEC response through by reference without rewriting its contribution/PAC fields', async () => {
  const fec = {
    mappedEmployer: 'Acme',
    contributionType: 'individual_employer_linked',
    summary: { totalAmount: 20 },
    committees: [{ name: 'Committee' }],
    pacGiving: { tracked: true, committees: ['PAC'], summary: { totalAmount: 10 } },
    disclaimer: 'Evidence disclaimer',
  };
  const h = harness({ sourceResults: { getFecMoneyFlow: fec } });
  expect(projection(await h.profile()).sections.financialFootprint.fecMoneyFlow).toBe(fec);
});

it('uses the manual pin to select the retained twelve bills, then displays those twelve by probability alone', async () => {
  const { manual, autos, bills } = manualPinFixture();
  const h = harness({
    sourceResults: { getTrackedBills: { total: 14, issueCodes: ['DEF'], bills } },
  });
  const payload = projection(await h.profile());
  const introduced = payload.sections.legislativeRegulatory.kanban.columns.find(
    (column) => column.id === 'introduced',
  )!;
  expect(introduced.count).toBe(14);
  expect(introduced.bills.map((bill) => bill.identifier)).toEqual([
    ...autos.slice(0, 11).map((bill) => bill.identifier),
    manual.identifier,
  ]);
  expect(introduced.bills).toHaveLength(12);
  expect(payload.sections.legislativeRegulatory.kanban.total).toBe(14);
  expect(bills.map((bill) => bill.identifier)).toEqual([
    ...autos.map((bill) => bill.identifier),
    manual.identifier,
  ]);
});

it('uses canonical status/history classifiers for all four kanban columns and clones bill dates', async () => {
  const bills = stageBills();
  const h = harness({ sourceResults: { getTrackedBills: { total: 4, issueCodes: [], bills } } });
  const columns = projection(await h.profile()).sections.legislativeRegulatory.kanban.columns;
  expect(columns.map((column) => [column.id, column.count, column.bills[0]!.identifier])).toEqual([
    ['introduced', 1, 'intro'],
    ['committee', 1, 'committee'],
    ['passed', 1, 'passed'],
    ['enacted', 1, 'law'],
  ]);
  expect(columns[0]!.bills[0]!.latestActionDate).toEqual(bills[0]!.latestActionDate);
  expect(columns[0]!.bills[0]!.latestActionDate).not.toBe(bills[0]!.latestActionDate);
});

it('merges regulation documents once, preserves tracked-bill provenance and sorts before the eight-rail cap', async () => {
  const h = harness(regulatoryFixtureOptions());
  const lifecycle = projection(await h.profile()).sections.legislativeRegulatory
    .regulatoryLifecycle;
  expect(lifecycle).toMatchObject({ totalLinkedBills: 2, totalRegulations: 10 });
  expect(lifecycle.rails).toHaveLength(8);
  expect(lifecycle.rails.map((rail) => rail.documentNumber)).toEqual([
    'linked',
    'independent-8',
    'independent-7',
    'independent-6',
    'independent-5',
    'independent-4',
    'independent-3',
    'independent-2',
  ]);
  expect(lifecycle.rails[0]).toMatchObject({
    title: 'Original title',
    linkedBills: ['bill-a', 'bill-b'],
    currentStage: 'effective',
    deadline: null,
    htmlUrl: 'https://example.invalid/linked',
  });
  expect(lifecycle.rails[1]).toMatchObject({
    linkedBills: [],
    currentStage: 'nprm',
    deadline: new Date('2026-10-20T00:00:00.000Z'),
  });
});

it('scopes hearings by title variants, normalized committee names and codes while dropping unrelated global rows', async () => {
  const h = harness(hearingFixtureOptions());
  const rows = projection(await h.profile()).sections.legislativeRegulatory.hearingsAndMarkups;
  expect(rows.map((row) => [row.id, row.linkedBills, row.isTracked, row.date])).toEqual([
    ['code', [], true, '2026-10-13T00:00:00.000Z'],
    ['title', ['119-hr-1234', '119-s-7'], true, '2026-10-14T00:00:00.000Z'],
    ['name', [], true, '2026-10-15T00:00:00.000Z'],
  ]);
  expect(h.callsOf('committeeJoin')[0]!.args[1]).toEqual(['119-hr-1234', '119-s-7']);
});

it('retains title-based hearing matches after committee join failure and reports the failed join', async () => {
  const h = harness(joinFailureFixtureOptions());
  expect(
    projection(await h.profile()).sections.legislativeRegulatory.hearingsAndMarkups.map(
      (row) => row.id,
    ),
  ).toEqual(['hearing-one']);
  expect(h.warnings).toContain(
    `hearings client-scoping committee join failed for client ${clientId}: join unavailable`,
  );
});

it('passes recommender identifiers/subjects/issues in source order and preserves the post-join-before-quarter sequence', async () => {
  const bills = [trackedBill(), trackedBill({ identifier: '', subjectNames: null })];
  const h = harness({
    sourceResults: { getTrackedBills: { total: 2, issueCodes: ['SCI', 'DEF'], bills } },
  });
  await h.profile();
  expect(h.recommender.recommend).toHaveBeenCalledWith({
    clientId,
    tenantId,
    trackedBillIds: ['119-hr-1234'],
    trackedBills: [
      { identifier: '119-hr-1234', subjectNames: ['Research'] },
      { identifier: '', subjectNames: [] },
    ],
    issueCodes: ['SCI', 'DEF'],
  });
  const order = h.events.filter((event) =>
    ['committeeJoin', 'recommend', 'buildRoiQuarterSeries'].includes(event),
  );
  expect(order).toEqual(['committeeJoin', 'recommend', 'buildRoiQuarterSeries']);
});

it('counts the full recommendation set before sorting/capping display and preserves provider ordering', async () => {
  const recommendations = Array.from({ length: 15 }, (_, index) =>
    recommendation({ memberId: String(index), score: index / 20 }),
  );
  const h = harness({
    recommendations,
    sourceResults: {
      getExStaffers: { lobbyists: [{ name: 'Ada Example' }, { name: 'BOB EXAMPLE' }] },
    },
  });
  const relationships = projection(await h.profile()).sections.relationships;
  expect(relationships.scopedGraph.meta).toMatchObject({ memberCount: 15, lobbyistCount: 2 });
  expect(relationships.officeRecommender.map((row) => row.memberId)).toEqual([
    '14',
    '13',
    '12',
    '11',
    '10',
    '9',
    '8',
    '7',
    '6',
    '5',
    '4',
    '3',
  ]);
  expect(relationships.exStafferCount).toBe(2);
  expect(relationships.scopedGraph.hints.exStafferNames).toEqual(['ada example', 'bob example']);
  expect(recommendations.map((row) => row.memberId)).toEqual(
    Array.from({ length: 15 }, (_, index) => String(index)),
  );
});

it('returns empty recommendations when the optional recommender is absent', async () => {
  const h = harness({ recommender: false });
  const relationships = projection(await h.profile()).sections.relationships;
  expect(relationships.officeRecommender).toEqual([]);
  expect(relationships.scopedGraph.meta.memberCount).toBe(0);
  expect(h.recommender.recommend).not.toHaveBeenCalled();
});

it('keeps the graph slot static and never calls the Knowledge Graph source', async () => {
  const h = harness({
    sourceResults: { getKnowledgeGraph: new Error('graph must remain unused') },
  });
  const graph = projection(await h.profile()).sections.relationships.scopedGraph;
  expect(graph.nodes).toEqual([]);
  expect(graph.edges).toEqual([]);
  expect(graph.resolutionQuality).toEqual({
    avgConfidence: 0,
    confirmedCount: 0,
    unconfirmedCount: 0,
  });
  expect(h.sources.getKnowledgeGraph).not.toHaveBeenCalled();
});

it('normalizes invalid hearing dates and nonfinite recommendation scores without mutating source rows', async () => {
  const hearings = [
    hearing({ id: 'invalid', date: new Date('invalid') }),
    hearing({ id: 'valid' }),
  ];
  const recommendations = [
    recommendation({ memberId: 'nan', score: NaN }),
    recommendation({ memberId: 'finite', score: 0.2 }),
    recommendation({ memberId: 'infinity', score: Infinity }),
  ];
  const h = harness({
    recommendations,
    rows: { hearings },
    sourceResults: { getTrackedBills: { total: 1, issueCodes: [], bills: [trackedBill()] } },
  });
  const payload = projection(await h.profile());
  expect(
    payload.sections.legislativeRegulatory.hearingsAndMarkups.map((row) => [row.id, row.date]),
  ).toEqual([
    ['invalid', null],
    ['valid', '2026-10-14T00:00:00.000Z'],
  ]);
  expect(payload.sections.relationships.officeRecommender.map((row) => row.memberId)).toEqual([
    'finite',
    'nan',
    'infinity',
  ]);
  expect(hearings[0]!.date.getTime()).toBeNaN();
  expect(recommendations[0]!.score).toBeNaN();
});

it('preserves the public meta, encoded hrefs, legacy action routes and moved-out flags', async () => {
  const id = 'client /?#';
  const h = harness({
    client: { id, name: 'Odd client' },
    sourceResults: {
      getTrackedBills: { total: 0, bills: [], issueCodes: [' ', ' SCI / ', 'DEF'] },
    },
  });
  const payload = await h.service.getClientProfileV1(id, tenantId);
  expect(payload.meta).toEqual({
    schema: 'client-profile-v1',
    sectionOrder: ['snapshot', 'financialFootprint', 'legislativeRegulatory', 'relationships'],
    hasSnapshot: true,
    hasFinancialFootprint: true,
    hasLegislativeRegulatory: true,
    hasRelationships: true,
    generatedAt: now.toISOString(),
    sourceCount: 0,
    unresolvedMappings: 0,
  });
  expect(payload.links).toEqual({
    changesInbox: '/intelligence/changes?clientId=client%20%2F%3F%23',
    mappingsAdmin: '/settings/intelligence-mappings',
    competitorIssuePage: '/intelligence/issues/SCI%20%2F',
    billDetailBase: '/explorer',
    entityResolutionQueue: '/settings/intelligence-mappings',
  });
  expect(payload.actionTargets.snapshot.seeAllChanges).toEqual({
    route: '/intelligence/changes',
    params: { clientId: id },
    href: payload.links.changesInbox,
  });
  expect(payload.actionTargets.legislative.billDrill).toEqual({
    route: '/explorer',
    params: { billIdentifierParam: ':bill' },
    hrefTemplate: '/explorer?bill=:bill',
  });
  expect(payload.actionTargets.relationships.officeDrill).toEqual({
    route: '/intelligence/issues',
    params: { officeParam: ':office' },
    hrefTemplate: '/intelligence/issues?office=:office',
  });
  expect(payload.movedOut).toEqual({
    changesInbox: true,
    entityResolutionQueue: true,
    competitorLeaderboard: true,
    billEnrichment: true,
  });
});
