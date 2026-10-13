import {
  advocacy,
  harness,
  installLifecycleClock,
  matter,
  now,
  outcome,
} from '../../test/fixtures/client-profile-fill-lifecycle-outcomes.js';

function cpf(overrides: Record<string, unknown> = {}) {
  return advocacy({
    externalKey: 'community_funding:request-one',
    recordType: 'cpf_request',
    sourceType: 'community_funding',
    sourceId: 'request-one',
    matterId: 'matter-one',
    metadata: { communityFundingRequestId: 'request-one', fiscalYear: 2026 },
    ...overrides,
  });
}

installLifecycleClock();

it('emits exact request identifier alignment with noncausal review evidence', async () => {
  const evidence = {
    communityFundingRequestId: 'request-one',
    fiscalYear: '2027',
    appropriationsAccountRaw: 'Research, Development',
    stage: 'enacted',
    amountTo: '123.00',
  };
  const event = outcome({ evidence, notes: 'Later enacted funding evidence' });
  const h = harness({ findings: [cpf()], outcomes: [event] });
  await expect(h.gather()).resolves.toBe(1);
  expect(h.findings[0]).toMatchObject({
    kind: 'advocacy_outcome',
    targetKey: 'advocacy-outcome:community_funding:request-one:outcome-one',
    source: 'lifecycle_outcomes',
    factKind: 'recommendation',
    confidence: 0.97,
    status: 'pending',
    proposedValue: {
      matterId: 'matter-one',
      advocacyExternalKey: 'community_funding:request-one',
      outcomeEventId: event.id,
      outcomeKind: event.kind,
      observedAt: event.observedAt.toISOString(),
      notes: event.notes,
      evidence,
      communityFundingRequestId: 'request-one',
      appropriationsAccountKey: 'RESEARCH DEVELOPMENT',
      fiscalYear: 2027,
      relationship: 'strongly_aligned',
      matchedOn: 'community_funding_request_id',
      causationClaimed: false,
      score: 0.97,
    },
  });
  expect(h.findings[0]!.proposedValue.summary).toContain(
    'not proof the recipient secured the funds',
  );
  expect(h.findings[0]!.evidence).toEqual([
    {
      label:
        'Later appropriations/funding evidence cites this exact canonical CPF/CDS request (identifier alignment only — not proof funding was secured)',
      source: 'Capiro Outcome Event',
      metadata: {
        outcomeEventId: event.id,
        observedAt: event.observedAt.toISOString(),
        causationClaimed: false,
        matchedOn: 'community_funding_request_id',
        communityFundingRequestId: 'request-one',
        appropriationsAccountKey: 'RESEARCH DEVELOPMENT',
        fiscalYear: 2027,
      },
    },
  ]);
});

it('uses exact account plus FY with the preserved snake-case/account/fy fallbacks', async () => {
  const evidence = {
    account: ' Research - Development ',
    fy: '2026',
    stage: 'conference',
    amountFrom: '100.00',
    amountTo: 200,
  };
  const h = harness({
    findings: [
      cpf({
        metadata: { appropriations_account_raw: 'Research, Development', fiscalYear: ' 2026 ' },
      }),
    ],
    outcomes: [outcome({ evidence })],
  });
  await expect(h.gather()).resolves.toBe(1);
  expect(h.findings[0]!.proposedValue).toMatchObject({
    evidence,
    relationship: 'strongly_aligned',
    matchedOn: 'appropriations_account_fy',
    communityFundingRequestId: 'request-one',
    appropriationsAccountKey: 'RESEARCH DEVELOPMENT',
    fiscalYear: 2026,
    causationClaimed: false,
    score: 0.93,
  });
  expect(h.findings[0]!.confidence).toBe(0.93);
  expect(h.findings[0]!.proposedValue.summary).toContain(
    'not a claim that the recipient secured funding',
  );
  expect(h.findings[0]!.evidence[0]!.label).toContain('exact account + FY');
});

it('does not fall back to account/FY when canonical request IDs disagree', async () => {
  const h = harness({
    findings: [
      cpf({
        metadata: {
          communityFundingRequestId: 'request-one',
          appropriationsAccountNormalized: 'RESEARCH',
          fiscalYear: 2026,
        },
      }),
    ],
    outcomes: [
      outcome({
        evidence: {
          communityFundingRequestId: 'other-request',
          appropriationsAccountNormalized: 'RESEARCH',
          fiscalYear: 2026,
        },
      }),
    ],
  });
  await expect(h.gather()).resolves.toBe(0);
  expect(h.callsOf('terminal')).toHaveLength(0);
  expect(h.cursors[0]!.watermark.refreshedAt).toBe(now);
});

it.each<[Record<string, unknown>, Record<string, unknown>]>([
  [{ fiscalYear: 2026 }, { fiscalYear: 2026 }],
  [{ appropriationsAccountRaw: 'Research' }, { appropriationsAccountRaw: 'Research' }],
  [
    { appropriationsAccountRaw: 'Research', fiscalYear: 2026 },
    { account: 'Research', fy: '2027' },
  ],
  [
    { appropriationsAccountRaw: 'Research', fiscalYear: '2026.5' },
    { account: 'Research', fy: '2026' },
  ],
])(
  'never uses semantic/source/Matter matching for incomplete CPF keys %p',
  async (metadata, evidence) => {
    const h = harness({
      findings: [cpf({ title: 'alpha bravo charlie delta', metadata })],
      outcomes: [
        outcome({
          sourceType: 'community_funding',
          sourceId: 'request-one',
          notes: 'alpha bravo charlie delta',
          evidence: { ...evidence, peCode: '0601234' },
        }),
      ],
      matters: [matter({ primaryPeCode: '0601234' })],
    });
    await expect(h.gather()).resolves.toBe(0);
    expect(h.findings).toEqual([]);
  },
);

it.each([
  [-1, 0],
  [0, 0],
  [1, 1],
])('requires CPF evidence strictly later than activity at offset %s', async (offset, count) => {
  const h = harness({
    findings: [cpf({ activityDate: '2026-02-01T00:00:00.000Z' })],
    outcomes: [
      outcome({
        observedAt: new Date(Date.UTC(2026, 1, 1) + offset),
        evidence: { communityFundingRequestId: 'request-one' },
      }),
    ],
  });
  await expect(h.gather()).resolves.toBe(count);
  expect(h.findings).toHaveLength(count);
});

it.each(['cds_request', 'cpf_request'])(
  'routes %s through deterministic matching',
  async (recordType) => {
    const h = harness({
      findings: [cpf({ recordType })],
      outcomes: [outcome({ evidence: { communityFundingRequestId: 'request-one' } })],
    });
    await expect(h.gather()).resolves.toBe(1);
    expect(h.findings[0]!.proposedValue.matchedOn).toBe('community_funding_request_id');
  },
);

it.each<[string, string, string]>([
  ['other', 'community_funding', 'unrelated:key'],
  ['other', 'other-source', 'community_funding:request-one'],
])(
  'retains source/key CPF classification %s / %s / %s',
  async (recordType, sourceType, externalKey) => {
    const h = harness({
      findings: [cpf({ recordType, sourceType, externalKey, metadata: {} })],
      outcomes: [outcome({ sourceType, sourceId: 'request-one' })],
    });
    await expect(h.gather()).resolves.toBe(0);
    expect(h.callsOf('terminal')).toHaveLength(0);
  },
);

it('keeps request matching without a valid attributable date or FY', async () => {
  const h = harness({
    findings: [
      cpf({
        activityDate: 'invalid',
        metadata: { communityFundingRequestId: 'request-one', fiscalYear: 'invalid' },
      }),
    ],
    outcomes: [
      outcome({ evidence: { communityFundingRequestId: 'request-one', fiscalYear: 'invalid' } }),
    ],
  });
  await expect(h.gather()).resolves.toBe(1);
  expect(h.findings[0]!.proposedValue).toMatchObject({
    matchedOn: 'community_funding_request_id',
    fiscalYear: null,
    score: 0.97,
  });
});

it('preserves per-finding commits and omits the cursor on a later CPF insert failure', async () => {
  const h = harness({
    findings: [cpf()],
    outcomes: [
      outcome({ id: 'first', evidence: { communityFundingRequestId: 'request-one' } }),
      outcome({ id: 'second', evidence: { communityFundingRequestId: 'request-one' } }),
    ],
    failInsertAt: 2,
  });
  await expect(h.gather()).rejects.toThrow('insert failed');
  expect(h.findings.map((finding) => finding.proposedValue.outcomeEventId)).toEqual(['first']);
  expect(h.transactions.map((tx) => tx.status)).toEqual(['commit', 'commit', 'rollback']);
  expect(h.cursorAttempts).toEqual([]);
});
