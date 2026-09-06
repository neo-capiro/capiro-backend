import {
  detectGsaChanges,
  detectCpfCdsChange,
  detectEconomicFactChange,
  changeDedupeKey,
} from './priority-intelligence-changes.js';
import { decideChangeSeverity, relativeDelta } from './priority-intelligence-change-policy.js';

const OBSERVED = new Date('2026-09-02T12:00:00.000Z');

describe('detectGsaChanges', () => {
  const prior = [
    {
      rpUid: 'A-1',
      fiscalYear: 2023,
      stateCode: 'AL',
      congressionalDistrict: '02',
      boundaryCongress: null,
      squareFeet: '100000',
      legalInterest: 'Owned',
      assetStatus: 'Active',
      realPropertyUse: 'Office',
    },
    {
      rpUid: 'B-2',
      fiscalYear: 2023,
      stateCode: 'AL',
      congressionalDistrict: '02',
      boundaryCongress: null,
      squareFeet: '50000',
      legalInterest: 'Leased',
      assetStatus: 'Active',
      realPropertyUse: 'Office',
    },
  ];

  it('detects additions, removals, and material square-footage changes', () => {
    const changes = detectGsaChanges({
      currentRows: [
        { ...prior[0]!, squareFeet: '160000' }, // +60% → material
        // B-2 removed
        {
          rpUid: 'C-3',
          fiscalYear: 2024,
          stateCode: 'AL',
          congressionalDistrict: '02',
          boundaryCongress: null,
          squareFeet: '20000',
          legalInterest: 'Owned',
          assetStatus: 'Active',
          realPropertyUse: 'Warehouse',
        }, // added
      ],
      priorRows: prior,
      observedAt: OBSERVED,
      sourceDocumentSha256: 'deadbeef'.repeat(8),
      fiscalYear: 2024,
    });

    const kinds = changes.map((c) => c.changeKind).sort();
    expect(kinds).toEqual([
      'gsa_property_added',
      'gsa_property_material_change',
      'gsa_property_removed',
    ]);

    const material = changes.find((c) => c.changeKind === 'gsa_property_material_change');
    expect(material?.severity).toBe('material');
    expect(material!.oldValue).toMatchObject({ squareFeet: '100000' });
    expect(material!.newValue).toMatchObject({ squareFeet: '160000' });

    // Every change here is detected against a NON-empty prior snapshot (a
    // subsequent publication, not the very first one) — none of these are
    // baseline, including the addition.
    for (const change of changes) expect(change.observationKind).toBe('change');
  });

  it('classifies a from-empty first publication as baseline, not a discrete change', () => {
    // Simulates the real production shape: the very first FY load has NO
    // prior persisted snapshot at all (priorRows: []), so every row detected
    // is the initial observation of the whole source/year, not a later
    // addition a user should see as "recent".
    const changes = detectGsaChanges({
      currentRows: [
        {
          rpUid: 'D-4',
          fiscalYear: 2024,
          stateCode: 'FL',
          congressionalDistrict: '08',
          boundaryCongress: 119,
          squareFeet: '5000',
          legalInterest: 'Owned',
          assetStatus: 'Active',
          realPropertyUse: 'Office',
        },
      ],
      priorRows: [],
      observedAt: OBSERVED,
      sourceDocumentSha256: 'deadbeef'.repeat(8),
      fiscalYear: 2024,
    });
    expect(changes).toHaveLength(1);
    expect(changes[0]!.changeKind).toBe('gsa_property_added');
    expect(changes[0]!.observationKind).toBe('baseline');
  });

  it('a subsequent addition against a non-empty prior snapshot is a change, not baseline', () => {
    const changes = detectGsaChanges({
      currentRows: [
        ...prior,
        {
          rpUid: 'E-5',
          fiscalYear: 2024,
          stateCode: 'AL',
          congressionalDistrict: '02',
          boundaryCongress: null,
          squareFeet: '9000',
          legalInterest: 'Owned',
          assetStatus: 'Active',
          realPropertyUse: 'Office',
        },
      ],
      priorRows: prior,
      observedAt: OBSERVED,
      sourceDocumentSha256: 'deadbeef'.repeat(8),
      fiscalYear: 2024,
    });
    const added = changes.find((c) => c.changeKind === 'gsa_property_added');
    expect(added?.observationKind).toBe('change');
  });

  it('removals and material corrections are always "change", never baseline (they require a prior row to exist)', () => {
    const changes = detectGsaChanges({
      currentRows: [{ ...prior[0]!, squareFeet: '160000' }], // material; B-2 removed
      priorRows: prior,
      observedAt: OBSERVED,
      sourceDocumentSha256: 'deadbeef'.repeat(8),
      fiscalYear: 2024,
    });
    const material = changes.find((c) => c.changeKind === 'gsa_property_material_change');
    const removed = changes.find((c) => c.changeKind === 'gsa_property_removed');
    expect(material?.observationKind).toBe('change');
    expect(removed?.observationKind).toBe('change');
  });

  it('an identical rerun of the SAME first publication still emits nothing (idempotent, not a repeated baseline)', () => {
    const firstRun = detectGsaChanges({
      currentRows: [prior[0]!],
      priorRows: [],
      observedAt: OBSERVED,
      sourceDocumentSha256: 'deadbeef'.repeat(8),
      fiscalYear: 2024,
    });
    expect(firstRun).toHaveLength(1);
    expect(firstRun[0]!.observationKind).toBe('baseline');

    // Re-running detection with the SAME row now present in the prior
    // snapshot (as it would be after the first run's rows actually
    // persisted) detects no further change — replaying an unchanged
    // publication is a no-op, not a second baseline event.
    const rerun = detectGsaChanges({
      currentRows: [prior[0]!],
      priorRows: [prior[0]!],
      observedAt: OBSERVED,
      sourceDocumentSha256: 'deadbeef'.repeat(8),
      fiscalYear: 2024,
    });
    expect(rerun).toEqual([]);
  });

  it('emits NOTHING when only metadata would have changed (no value delta)', () => {
    const changes = detectGsaChanges({
      currentRows: prior.map((r) => ({ ...r, fiscalYear: 2024 })),
      priorRows: prior,
      observedAt: OBSERVED,
      sourceDocumentSha256: 'deadbeef'.repeat(8),
      fiscalYear: 2024,
    });
    expect(changes).toEqual([]);
  });

  it('carries geography vintage and preserves old evidence in oldValue', () => {
    const changes = detectGsaChanges({
      currentRows: [{ ...prior[0]!, squareFeet: '120000' }],
      priorRows: prior.slice(0, 1),
      observedAt: OBSERVED,
      sourceDocumentSha256: 'deadbeef'.repeat(8),
      fiscalYear: 2024,
    });
    expect(changes).toHaveLength(1);
    expect(changes[0]!.geographyVintage).toBe('source_unknown'); // boundary null in source
    expect(changes[0]!.oldValue).toMatchObject({ legalInterest: 'Owned' });
  });
});

describe('detectCpfCdsChange', () => {
  it('new request when no prior row exists', () => {
    const changes = detectCpfCdsChange({
      requestId: 'r1',
      chamber: 'house',
      fiscalYear: 2026,
      stateCode: 'AL',
      districtCode: '02',
      requesterName: 'Rep. Smith',
      prior: null,
      current: {
        requestedAmountUsd: '500000',
        finalAmountUsd: null,
        amountStageRaw: 'house_requested',
      },
      observedAt: OBSERVED,
    });
    expect(changes).toHaveLength(1);
    expect(changes[0]!.changeKind).toBe('cpf_cds_request_new');
    expect(changes[0]!.provenance.amountSemantics).toBe('requested_not_awarded');
  });

  it('NO change when only sync metadata changed (same amounts + stage)', () => {
    const changes = detectCpfCdsChange({
      requestId: 'r1',
      chamber: 'house',
      fiscalYear: 2026,
      stateCode: 'AL',
      districtCode: '02',
      requesterName: 'Rep. Smith',
      prior: {
        requestedAmountUsd: '500000',
        finalAmountUsd: null,
        amountStageRaw: 'house_requested',
      },
      current: {
        requestedAmountUsd: '500000',
        finalAmountUsd: null,
        amountStageRaw: 'house_requested',
      },
      observedAt: OBSERVED,
    });
    expect(changes).toEqual([]);
  });

  it('correction detected when the amount or stage actually changes', () => {
    const changes = detectCpfCdsChange({
      requestId: 'r1',
      chamber: 'house',
      fiscalYear: 2026,
      stateCode: 'AL',
      districtCode: '02',
      requesterName: 'Rep. Smith',
      prior: {
        requestedAmountUsd: '500000',
        finalAmountUsd: null,
        amountStageRaw: 'house_requested',
      },
      current: {
        requestedAmountUsd: '300000',
        finalAmountUsd: null,
        amountStageRaw: 'house_requested',
      },
      observedAt: OBSERVED,
    });
    expect(changes).toHaveLength(1);
    expect(changes[0]!.changeKind).toBe('cpf_cds_amount_stage_correction');
    expect(changes[0]!.oldValue).toMatchObject({ requestedAmountUsd: '500000' });
    expect(changes[0]!.newValue).toMatchObject({ requestedAmountUsd: '300000' });
  });

  it('geography vintage is source_unknown for district rows — never a claimed congress vintage', () => {
    // The CPF/CDS source publishes district numbers but no boundary congress;
    // asserting cd119 (or any specific congress) would be an inference.
    const changes = detectCpfCdsChange({
      requestId: 'r1',
      chamber: 'house',
      fiscalYear: 2026,
      stateCode: 'AL',
      districtCode: '02',
      requesterName: 'Rep. Smith',
      prior: null,
      current: {
        requestedAmountUsd: '500000',
        finalAmountUsd: null,
        amountStageRaw: 'house_requested',
      },
      observedAt: OBSERVED,
    });
    expect(changes[0]!.geographyVintage).toBe('source_unknown');
    expect(changes[0]!.boundaryCongress).toBeNull();
  });

  it('Senate statewide rows carry null vintage and null boundary congress', () => {
    const changes = detectCpfCdsChange({
      requestId: 's1',
      chamber: 'senate',
      fiscalYear: 2026,
      stateCode: 'AL',
      districtCode: null,
      requesterName: 'Sen. Jones',
      prior: null,
      current: {
        requestedAmountUsd: '750000',
        finalAmountUsd: null,
        amountStageRaw: 'senate_requested',
      },
      observedAt: OBSERVED,
    });
    expect(changes[0]!.geographyVintage).toBeNull();
    expect(changes[0]!.boundaryCongress).toBeNull();
  });
});

describe('detectEconomicFactChange', () => {
  it('detects a material year-over-year change with durable old/new values', () => {
    const changes = detectEconomicFactChange({
      source: 'cbp',
      dataset: 'cbp',
      stateCode: 'AL',
      districtCode: '02',
      metricKey: 'employment',
      naicsCode: '3364',
      priorYear: 2022,
      priorValue: '10000',
      currentYear: 2023,
      currentValue: '15000',
      observedAt: OBSERVED,
    });
    expect(changes).toHaveLength(1);
    expect(changes[0]!.changeKind).toBe('economic_fact_material_change');
    expect(changes[0]!.severity).toBe('material');
  });

  it('returns [] below the minimum reportable delta and when sides are missing', () => {
    expect(
      detectEconomicFactChange({
        source: 'cbp',
        dataset: 'cbp',
        stateCode: 'AL',
        districtCode: '02',
        metricKey: 'employment',
        naicsCode: null,
        priorYear: 2022,
        priorValue: '10000',
        currentYear: 2023,
        currentValue: '10100',
        observedAt: OBSERVED,
      }),
    ).toEqual([]);
    expect(
      detectEconomicFactChange({
        source: 'cbp',
        dataset: 'cbp',
        stateCode: 'AL',
        districtCode: '02',
        metricKey: 'employment',
        naicsCode: null,
        priorYear: 2022,
        priorValue: null,
        currentYear: 2023,
        currentValue: '15000',
        observedAt: OBSERVED,
      }),
    ).toEqual([]);
  });
});

describe('changeDedupeKey', () => {
  it('is deterministic and sensitive to identity + observed bucket', () => {
    const base = {
      changeKind: 'gsa_property_added',
      source: 'gsa',
      sourceRecordId: 'A-1',
      stateCode: 'AL',
      districtCode: '02',
      boundaryCongress: null,
      observedBucket: '2026-09-02',
    };
    expect(changeDedupeKey(base)).toBe(changeDedupeKey({ ...base })); // replay idempotent
    expect(changeDedupeKey({ ...base, observedBucket: '2026-09-03' })).not.toBe(
      changeDedupeKey(base),
    );
    expect(changeDedupeKey({ ...base, districtCode: '07' })).not.toBe(changeDedupeKey(base));
  });
});

describe('materiality policy', () => {
  it('structural CPF/CDS additions are notable; GSA structural changes are material', () => {
    expect(
      decideChangeSeverity('cpf_cds', {
        relativeDelta: null,
        absoluteDelta: null,
        structuralChange: true,
      }).severity,
    ).toBe('notable');
    expect(
      decideChangeSeverity('gsa', {
        relativeDelta: null,
        absoluteDelta: null,
        structuralChange: true,
      }).severity,
    ).toBe('material');
  });

  it('never fabricates a ratio from a zero or missing base', () => {
    expect(relativeDelta(0, 10)).toBeNull();
    expect(relativeDelta(null, 10)).toBeNull();
    expect(relativeDelta(10, null)).toBeNull();
  });
});
