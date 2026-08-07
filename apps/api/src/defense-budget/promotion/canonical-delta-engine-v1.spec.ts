/**
 * Phase 7 Workstream L — the generic delta engine.
 *
 * The engine is pure, so everything about *what a change is* is decided here.
 * What the database contributes — that the two sides came from immutable
 * snapshots and that a stage-authority violation is refused on insert — is
 * proved in the disposable-PostgreSQL rehearsal.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  canonicalDeltaKindV1,
  changedAxesV1,
  computeCanonicalDeltaV1,
  createCanonicalDeltaHandlerV1,
  materialityStageV1,
  type CanonicalDeltaRecordV1,
  type CanonicalRowValuesV1,
} from './canonical-delta-engine-v1.js';
import type { OutboxRowV1 } from './promotion-outbox-drain-v1.js';

function values(o: Partial<CanonicalRowValuesV1> = {}): CanonicalRowValuesV1 {
  return {
    canonicalRowHash: 'a'.repeat(64),
    family: 'om',
    fiscalYear: 2027,
    fundingField: 'request',
    stage: null,
    moneyOriginalValue: '1000',
    moneyValueMillions: '1',
    quantity: null,
    unitCostDollars: null,
    textValue: null,
    dateValue: null,
    ...o,
  };
}

function outbox(o: Partial<OutboxRowV1> = {}): OutboxRowV1 {
  return {
    id: '11111111-1111-1111-1111-111111111111',
    dedupeKey: 'dedupe-1',
    activationId: '22222222-2222-2222-2222-222222222222',
    oldSnapshotId: '33333333-3333-3333-3333-333333333333',
    newSnapshotId: '44444444-4444-4444-4444-444444444444',
    canonicalEntity: 'canonical_om_sag_year',
    canonicalNaturalKey: 'ARMY|OMA|SAG-111|2027|request',
    family: 'om',
    fiscalYear: 2027,
    fundingField: 'request',
    stage: null,
    oldOriginalValue: null,
    oldValueMillions: null,
    newOriginalValue: null,
    newValueMillions: null,
    changeClassification: 'material_change',
    suppressAlert: false,
    isCorrection: false,
    isRollback: false,
    attempts: 0,
    ...o,
  };
}

describe('Workstream L — which axes moved', () => {
  it('reports money when the normalized amount changes', () => {
    const axes = changedAxesV1(
      values({ moneyValueMillions: '1', moneyOriginalValue: '1000' }),
      values({
        moneyValueMillions: '1.25',
        moneyOriginalValue: '1250',
        canonicalRowHash: 'b'.repeat(64),
      }),
    );
    expect(axes).toEqual(['money']);
  });

  it('treats a scale-padded amount as unchanged', () => {
    // Postgres returns NUMERIC(24,9) padded. The adapter normalizes before the
    // engine sees it; this asserts the engine's own comparison is exact string
    // equality over canonical form, so the normalization is load-bearing rather
    // than cosmetic.
    const axes = changedAxesV1(
      values({ moneyValueMillions: '1.25' }),
      values({ moneyValueMillions: '1.25' }),
    );
    expect(axes).toEqual([]);
  });

  it('separates quantity from unit cost', () => {
    expect(
      changedAxesV1(
        values({ quantity: '4' }),
        values({ quantity: '6', canonicalRowHash: 'c'.repeat(64) }),
      ),
    ).toEqual(['quantity']);
    expect(
      changedAxesV1(
        values({ unitCostDollars: '10' }),
        values({ unitCostDollars: '11', canonicalRowHash: 'c'.repeat(64) }),
      ),
    ).toEqual(['unit_cost']);
  });

  it('falls back to attributes when the row hash moved but no typed axis did', () => {
    const axes = changedAxesV1(values(), values({ canonicalRowHash: 'd'.repeat(64) }));
    expect(axes).toEqual(['attributes']);
  });

  it('reports every axis the present side carries when one side is absent', () => {
    expect(changedAxesV1(null, values({ quantity: '4' }))).toEqual(['money', 'quantity']);
  });

  it('reports attributes for an identity row with no typed value at all', () => {
    const identityOnly = values({ moneyOriginalValue: null, moneyValueMillions: null });
    expect(changedAxesV1(null, identityOnly)).toEqual(['attributes']);
  });
});

describe('Workstream L — what kind of change it is', () => {
  it('calls a value arriving where there was none a new start', () => {
    const next = values({ moneyValueMillions: '5' });
    expect(canonicalDeltaKindV1(null, next, ['money'])).toBe('new_start');
    expect(canonicalDeltaKindV1(values({ moneyValueMillions: '0' }), next, ['money'])).toBe(
      'new_start',
    );
  });

  it('calls a value going to zero a termination', () => {
    expect(
      canonicalDeltaKindV1(
        values({ moneyValueMillions: '5' }),
        values({ moneyValueMillions: '0' }),
        ['money'],
      ),
    ).toBe('termination');
  });

  it('distinguishes increase from decrease by exact subtraction', () => {
    expect(
      canonicalDeltaKindV1(
        values({ moneyValueMillions: '1' }),
        values({ moneyValueMillions: '1.000000001' }),
        ['money'],
      ),
    ).toBe('increase');
    expect(
      canonicalDeltaKindV1(
        values({ moneyValueMillions: '1.000000001' }),
        values({ moneyValueMillions: '1' }),
        ['money'],
      ),
    ).toBe('decrease');
  });

  it('falls through money to quantity and unit cost', () => {
    expect(canonicalDeltaKindV1(values(), values(), ['quantity'])).toBe('quantity_change');
    expect(canonicalDeltaKindV1(values(), values(), ['unit_cost'])).toBe('unit_cost_change');
    expect(canonicalDeltaKindV1(values(), values(), ['attributes'])).toBe('nonfinancial_change');
  });

  it('calls a first appearance with no money an identity change', () => {
    expect(canonicalDeltaKindV1(null, values({ moneyValueMillions: null }), ['attributes'])).toBe(
      'identity_change',
    );
  });
});

describe('Workstream L — the delta record', () => {
  it('stores the exact difference, not a rounded one', () => {
    const record = computeCanonicalDeltaV1({
      outboxRow: outbox(),
      prior: values({ moneyValueMillions: '0.000000001', moneyOriginalValue: '1' }),
      next: values({
        moneyValueMillions: '0.000000003',
        moneyOriginalValue: '3',
        canonicalRowHash: 'e'.repeat(64),
      }),
    });
    expect(record?.moneyDeltaMillions).toBe('0.000000002');
  });

  it('takes stage and funding field from the canonical row, not the outbox row', () => {
    // Workstream E writes stage: null on every outbox row. A delta that copied
    // it would assert a congressional mark with no authority naming it — the
    // exact shape of the P1 the F–J review found.
    const record = computeCanonicalDeltaV1({
      outboxRow: outbox({ stage: null, fundingField: 'request' }),
      prior: null,
      next: values({ fundingField: 'hascMark', stage: 'hasc', moneyValueMillions: '12' }),
    });
    expect(record?.stage).toBe('hasc');
    expect(record?.fundingField).toBe('hascMark');
  });

  it('records nothing when neither side exists', () => {
    expect(computeCanonicalDeltaV1({ outboxRow: outbox(), prior: null, next: null })).toBeNull();
  });

  it('records nothing when the two sides are identical', () => {
    expect(
      computeCanonicalDeltaV1({ outboxRow: outbox(), prior: values(), next: values() }),
    ).toBeNull();
  });

  it('is alert-eligible only for an unsuppressed material change', () => {
    const cases: [string, boolean, boolean][] = [
      ['material_change', false, true],
      ['material_change', true, false],
      ['initial_hydration', true, false],
      ['correction', true, false],
      ['rollback', true, false],
    ];
    for (const [classification, suppressAlert, expected] of cases) {
      const record = computeCanonicalDeltaV1({
        outboxRow: outbox({ changeClassification: classification, suppressAlert }),
        prior: null,
        next: values({ moneyValueMillions: '900' }),
      });
      expect(record?.alertEligible).toBe(expected);
    }
  });

  it('scores a later stage at least as material as the same change at request', () => {
    const score = (fundingField: string, stage: string | null): number => {
      const record = computeCanonicalDeltaV1({
        outboxRow: outbox(),
        prior: values({ moneyValueMillions: '100', fundingField, stage }),
        next: values({
          moneyValueMillions: '200',
          fundingField,
          stage,
          canonicalRowHash: 'f'.repeat(64),
        }),
      });
      return Number(record?.materialityScore);
    };
    expect(score('enacted', 'public_law')).toBeGreaterThanOrEqual(score('request', null));
  });

  it('keeps the score inside the NUMERIC(6,5) the column declares', () => {
    const record = computeCanonicalDeltaV1({
      outboxRow: outbox(),
      prior: values({ moneyValueMillions: '1' }),
      next: values({ moneyValueMillions: '99999', canonicalRowHash: 'b'.repeat(64) }),
    });
    const score = Number(record?.materialityScore);
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(1);
    expect(record?.materialityScore.replace(/^-?\d+\.?/, '').length).toBeLessThanOrEqual(5);
  });

  it('scores a termination on the amount that went away', () => {
    // The dollar magnitude must come from whichever side exists. Reading it
    // from the new side alone would score the loss of a $900M program at zero
    // on the dollar axis and rank it below a rounding change.
    const termination = computeCanonicalDeltaV1({
      outboxRow: outbox(),
      prior: values({ moneyValueMillions: '900', moneyOriginalValue: '900000' }),
      next: null,
    });
    const tiny = computeCanonicalDeltaV1({
      outboxRow: outbox(),
      prior: values({ moneyValueMillions: '0.001', moneyOriginalValue: '1' }),
      next: null,
    });
    expect(termination?.deltaKind).toBe('termination');
    expect(Number(termination?.materialityScore)).toBeGreaterThan(Number(tiny?.materialityScore));
  });

  it('maps funding fields onto the stage ladder', () => {
    expect(materialityStageV1('enacted')).toBe('enacted');
    expect(materialityStageV1('conference')).toBe('conference');
    expect(materialityStageV1('sascMark')).toBe('marks');
    expect(materialityStageV1(null)).toBe('pb');
  });

  it('derives a deterministic delta key', () => {
    const build = (): CanonicalDeltaRecordV1 | null =>
      computeCanonicalDeltaV1({
        outboxRow: outbox(),
        prior: null,
        next: values({ moneyValueMillions: '7' }),
      });
    expect(build()?.deltaKey).toBe(build()?.deltaKey);
  });
});

describe('Workstream L — the handler', () => {
  function harness(rows: Record<string, CanonicalRowValuesV1>) {
    const written: CanonicalDeltaRecordV1[] = [];
    const lookup = {
      async loadValues(snapshotId: string, entity: string, key: string) {
        return rows[`${snapshotId}|${entity}|${key}`] ?? null;
      },
    };
    const writer = {
      async insertIfAbsent(record: CanonicalDeltaRecordV1) {
        written.push(record);
      },
    };
    return { handler: createCanonicalDeltaHandlerV1(lookup, writer), written };
  }

  it('resolves both sides and records one delta', async () => {
    const row = outbox();
    const { handler, written } = harness({
      [`${row.oldSnapshotId}|${row.canonicalEntity}|${row.canonicalNaturalKey}`]: values({
        moneyValueMillions: '1',
      }),
      [`${row.newSnapshotId}|${row.canonicalEntity}|${row.canonicalNaturalKey}`]: values({
        moneyValueMillions: '2',
        canonicalRowHash: 'b'.repeat(64),
      }),
    });
    await handler.publish(row);
    expect(written).toHaveLength(1);
    expect(written[0]?.moneyDeltaMillions).toBe('1');
    expect(written[0]?.deltaKind).toBe('increase');
  });

  it('succeeds without writing when the row names no canonical identity', async () => {
    // The rollback marker Workstream E writes. Publishing it must count as
    // delivered, or the run never leaves SIDE_EFFECTS_PENDING.
    const { handler, written } = harness({});
    await expect(
      handler.publish(outbox({ canonicalNaturalKey: 'rollback:snap-1' })),
    ).resolves.toBeUndefined();
    expect(written).toEqual([]);
  });

  it('emits no alert of its own', async () => {
    // Plan L.13. The legacy path wrote tenant `intelligence_change` rows
    // straight out of outbox processing; the canonical path records a fact and
    // stops. Whether that fact reaches a client is a separately authorized
    // fan-out reading `alert_eligible`.
    //
    // Scanned with `readFileSync` rather than a ripgrep-backed search on
    // purpose: two files in this directory contain literal NUL bytes as
    // composite-map-key delimiters, and every ripgrep-based tool treats them as
    // binary and skips them *silently*. A sweep that missed them would report
    // clean over the two largest files in the module.
    const dir = __dirname;
    const sources = readdirSync(dir).filter(
      (name) => name.endsWith('.ts') && !name.endsWith('.spec.ts'),
    );
    expect(sources.length).toBeGreaterThan(10);
    // Comments are stripped first. This module's own header explains that it
    // does not emit an `intelligence_change`, and a gate that matches its own
    // prose is a false positive — the lesson the Workstream D migration gate
    // already learned, and the open P1-8 finding about regexes over raw text.
    const stripComments = (text: string): string =>
      text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

    const offenders = sources.filter((name) =>
      /intelligenceChange|intelligence_change|programElementChangeOutbox/.test(
        stripComments(readFileSync(join(dir, name), 'utf8')),
      ),
    );
    expect(offenders).toEqual([]);

    // And it still catches a real one, so stripping has not blunted it.
    expect(stripComments('const x = 1;\nawait tx.intelligenceChange.upsert({});')).toMatch(
      /intelligenceChange/,
    );
  });

  it('treats a baseline hydration with no prior snapshot as a new start', async () => {
    const row = outbox({
      oldSnapshotId: null,
      changeClassification: 'initial_hydration',
      suppressAlert: true,
    });
    const { handler, written } = harness({
      [`${row.newSnapshotId}|${row.canonicalEntity}|${row.canonicalNaturalKey}`]: values({
        moneyValueMillions: '42',
      }),
    });
    await handler.publish(row);
    expect(written[0]?.deltaKind).toBe('new_start');
    expect(written[0]?.oldMoneyValueMillions).toBeNull();
    expect(written[0]?.alertEligible).toBe(false);
  });
});
