/**
 * Phase 7 Workstream B — the mapping registry routes already-decided facts and
 * decides nothing itself.
 *
 * Assertions here are exact comparisons against parsed structures. Phase 6's
 * NC11 was a dead control because it asserted `toContain('20')` against a
 * stringified payload and passed on the value "120"; nothing in this file
 * asserts on a substring of serialized JSON.
 */
import {
  CANONICAL_LINEAGE_FIELDS_V1,
  CANONICAL_MONEY_FIELDS_V1,
  CANONICAL_PROJECTION_KIND_V1_VALUES,
  DEFENSE_BUDGET_CANONICAL_MAPPING_REGISTRY_V1,
  DEFENSE_BUDGET_CANONICAL_MAPPING_REGISTRY_VERSION,
  NON_RDTE_PROJECTION_KIND_KEYS_V1,
  PHASE6_PROJECTION_KIND_KEYS_V1,
  RDTE_PROJECTION_KIND_KEYS_V1,
  assertMappingRegistryExhaustiveV1,
  buildMappingReportV1,
  canonicalMappingRegistryHashV1,
  checkMappingRegistryExhaustivenessV1,
  lookupCanonicalMappingV1,
  renderMappingReportMarkdownV1,
  requiredLineageFieldsForV1,
  validateFundingFieldForMappingV1,
  type CanonicalMappingEntryV1,
  type CanonicalProjectionKindV1,
} from './canonical-mapping-registry-v1.js';
import { sha256CanonicalJson, type JsonValue } from '../contracts/canonical-json.js';

function entryFor(kind: CanonicalProjectionKindV1): CanonicalMappingEntryV1 {
  const result = lookupCanonicalMappingV1(kind);
  if (!result.supported) throw new Error(`expected ${kind} to be supported`);
  return result.entry;
}

describe('Phase 7 Workstream B — registry coverage', () => {
  it('maps every projection kind from all three upstream unions', () => {
    const report = checkMappingRegistryExhaustivenessV1();
    expect(report.missing).toEqual([]);
    expect(report.extra).toEqual([]);
    expect(report.exhaustive).toBe(true);
    expect(report.mappedKinds).toBe(report.totalUpstreamKinds);
    expect(() => assertMappingRegistryExhaustiveV1()).not.toThrow();
  });

  it('covers the expected 11 RDT&E, 12 non-RDT&E, and 7 Phase 6 kinds', () => {
    expect(RDTE_PROJECTION_KIND_KEYS_V1).toHaveLength(11);
    expect(NON_RDTE_PROJECTION_KIND_KEYS_V1).toHaveLength(12);
    expect(PHASE6_PROJECTION_KIND_KEYS_V1).toHaveLength(7);
    expect(CANONICAL_PROJECTION_KIND_V1_VALUES).toHaveLength(30);
  });

  it('resolves every supported projection kind to exactly one canonical entity', () => {
    for (const kind of CANONICAL_PROJECTION_KIND_V1_VALUES) {
      const result = lookupCanonicalMappingV1(kind);
      expect(result.supported).toBe(true);
      if (result.supported) {
        expect(result.entry.projectionKind).toBe(kind);
        expect(typeof result.entry.canonicalEntity).toBe('string');
        expect(result.entry.naturalKeyFields.length).toBeGreaterThan(0);
      }
    }
  });

  it('blocks an unknown projection kind instead of dropping it', () => {
    const result = lookupCanonicalMappingV1('rdte:NotARealTarget');
    expect(result.supported).toBe(false);
    if (!result.supported) {
      expect(result.reason).toBe('unsupported_projection_kind');
    }
  });

  it('blocks an un-namespaced kind — the namespace is part of the contract', () => {
    const result = lookupCanonicalMappingV1('ProgramElement');
    expect(result.supported).toBe(false);
    if (!result.supported) expect(result.reason).toBe('unsupported_projection_kind');
  });

  it('never returns undefined for a missing mapping', () => {
    // A caller that forgets to check `supported` still cannot read an entry.
    const result = lookupCanonicalMappingV1('phase6:not_a_kind');
    expect(result).toHaveProperty('supported', false);
    expect(result).not.toHaveProperty('entry');
  });
});

describe('Phase 7 Workstream B — native identity is never conflated', () => {
  it('routes RDT&E and procurement identity to different canonical entities', () => {
    const rdte = entryFor('rdte:ProgramElement');
    const procurement = entryFor('non_rdte:ProcurementBudgetLine');

    expect(rdte.canonicalEntity).toBe('canonical_rdte_program_element');
    expect(procurement.canonicalEntity).toBe('canonical_procurement_budget_line');
    expect(rdte.canonicalEntity).not.toBe(procurement.canonicalEntity);
    expect(rdte.family).toBe('rdte');
    expect(procurement.family).toBe('procurement');
  });

  it('never routes a non-RDT&E kind into an RDT&E canonical entity', () => {
    for (const kind of NON_RDTE_PROJECTION_KIND_KEYS_V1) {
      const entry = entryFor(kind);
      expect(entry.canonicalEntity.startsWith('canonical_rdte_')).toBe(false);
    }
  });

  it('keys procurement on the account namespace, not on a bare line number', () => {
    const entry = entryFor('non_rdte:ProcurementBudgetLine');
    expect(entry.naturalKeyFields).toEqual([
      'component',
      'account',
      'lineCode',
      'advanceProcurement',
    ]);
  });

  it('separates base from advance procurement in the natural key', () => {
    const identity = entryFor('non_rdte:ProcurementBudgetLine');
    const year = entryFor('non_rdte:ProcurementBudgetLineYear');
    expect(identity.naturalKeyFields).toContain('advanceProcurement');
    expect(year.naturalKeyFields).toContain('advanceProcurement');
  });

  it('scopes an O&M SAG to its account so the same code under two accounts is two lines', () => {
    const entry = entryFor('non_rdte:OmSag');
    expect(entry.naturalKeyFields).toEqual(['component', 'account', 'sagCode']);
    expect(entry.canonicalEntity).toBe('canonical_om_sag');
  });

  it('keys MILCON on project code and location, never on title', () => {
    const entry = entryFor('non_rdte:MilconProject');
    expect(entry.naturalKeyFields).toEqual(['component', 'account', 'projectCode', 'location']);
    expect(entry.naturalKeyFields).not.toContain('title');
  });

  it('never admits a title into any natural key', () => {
    for (const kind of CANONICAL_PROJECTION_KIND_V1_VALUES) {
      const entry = entryFor(kind);
      for (const field of entry.naturalKeyFields) {
        expect(field.toLowerCase()).not.toBe('title');
        expect(field.toLowerCase()).not.toBe('name');
      }
    }
  });

  it('scopes RDT&E project codes to the parent PE', () => {
    const entry = entryFor('rdte:ProgramElementProject');
    expect(entry.naturalKeyFields).toEqual(['peCode', 'projectCode']);
  });

  it('keeps the performer role in the key so a role cannot be silently relabelled', () => {
    const entry = entryFor('rdte:ProgramElementPerformer');
    expect(entry.naturalKeyFields).toContain('performerRole');
  });
});

describe('Phase 7 Workstream B — field authority', () => {
  it('derives a stage position field from the stage authority, not the projection', () => {
    const entry = entryFor('phase6:stage_position');
    expect(entry.fieldAuthority.mode).toBe('stage_authority');
  });

  it('refuses an NDAA conference authority claiming the appropriations conference field', () => {
    const entry = entryFor('phase6:stage_position');
    const result = validateFundingFieldForMappingV1(
      entry,
      'conference',
      'ndaa_conference_authorization',
    );
    expect(result.supported).toBe(false);
    if (!result.supported) {
      expect(result.reason).toBe('stage_authority_field_mismatch');
      expect(result.detail).toBe(
        'authority ndaa_conference_authorization owns "ndaaConference", not "conference"',
      );
    }
  });

  it('accepts each authority against exactly the field it owns', () => {
    const entry = entryFor('phase6:stage_position');
    const pairs = [
      ['hasc_authorization', 'hascMark'],
      ['sasc_authorization', 'sascMark'],
      ['ndaa_conference_authorization', 'ndaaConference'],
      ['hacd_appropriations', 'hacDMark'],
      ['sacd_appropriations', 'sacDMark'],
      ['appropriations_conference', 'conference'],
      ['enacted_public_law', 'enacted'],
    ] as const;
    for (const [authority, field] of pairs) {
      const ok = validateFundingFieldForMappingV1(entry, field, authority);
      expect(ok.supported).toBe(true);
    }
  });

  it('refuses an appropriations authority claiming an authorization field', () => {
    const entry = entryFor('phase6:stage_position');
    const result = validateFundingFieldForMappingV1(entry, 'hascMark', 'hacd_appropriations');
    expect(result.supported).toBe(false);
    if (!result.supported) expect(result.reason).toBe('stage_authority_field_mismatch');
  });

  it('refuses a funding field on an entity that owns none', () => {
    const entry = entryFor('rdte:ProgramElement');
    expect(entry.fieldAuthority.mode).toBe('not_applicable');
    const result = validateFundingFieldForMappingV1(entry, 'enacted');
    expect(result.supported).toBe(false);
    if (!result.supported) expect(result.reason).toBe('field_not_permitted_for_entity');
  });

  it('restricts RDT&E budget positions to the request side', () => {
    const entry = entryFor('rdte:ProgramElementBudgetPosition');
    expect(entry.fieldAuthority.allowedFields).toEqual(['request']);
    const refused = validateFundingFieldForMappingV1(entry, 'enacted');
    expect(refused.supported).toBe(false);
  });
});

describe('Phase 7 Workstream B — actions are not positions', () => {
  it('gives a stage action no funding field at all', () => {
    const action = entryFor('phase6:stage_action');
    expect(action.fieldAuthority.mode).toBe('not_applicable');
    expect(action.fieldAuthority.allowedFields).toEqual([]);
  });

  it('routes actions and positions to different canonical entities', () => {
    expect(entryFor('phase6:stage_action').canonicalEntity).toBe('canonical_stage_action');
    expect(entryFor('phase6:stage_position').canonicalEntity).toBe('canonical_stage_position');
  });

  it('refuses to let an action amount be written as an absolute position field', () => {
    const action = entryFor('phase6:stage_action');
    for (const field of ['request', 'enacted', 'conference', 'hascMark'] as const) {
      const result = validateFundingFieldForMappingV1(action, field);
      expect(result.supported).toBe(false);
      if (!result.supported) expect(result.reason).toBe('field_not_permitted_for_entity');
    }
  });
});

describe('Phase 7 Workstream B — enactment proof', () => {
  it('requires enactment proof on stage positions', () => {
    expect(entryFor('phase6:stage_position').requiresEnactmentProof).toBe(true);
  });

  it('routes the proof itself to its own append-only entity', () => {
    const proof = entryFor('phase6:enactment_proof');
    expect(proof.canonicalEntity).toBe('canonical_enactment_proof');
    expect(proof.supersession).toBe('append_only_observation');
    expect(proof.requiresEnactmentProof).toBe(false);
  });
});

describe('Phase 7 Workstream B — money is never a float', () => {
  it('declares the preservation rule on exactly the money-bearing entities', () => {
    for (const kind of CANONICAL_PROJECTION_KIND_V1_VALUES) {
      const entry = entryFor(kind);
      const carriesMoney = entry.valueAxes.includes('money');
      expect(entry.moneyRule).toBe(carriesMoney ? 'preserve_original_and_millions' : 'none');
    }
  });

  it('requires the exact money triple on money-bearing entities and withholds it elsewhere', () => {
    const withMoney = entryFor('non_rdte:ProcurementBudgetLineYear');
    const withoutMoney = entryFor('non_rdte:ProcurementBudgetLine');

    for (const field of CANONICAL_MONEY_FIELDS_V1) {
      expect(requiredLineageFieldsForV1(withMoney)).toContain(field);
      expect(requiredLineageFieldsForV1(withoutMoney)).not.toContain(field);
    }
  });

  it('requires full lineage on every entity regardless of money', () => {
    for (const kind of CANONICAL_PROJECTION_KIND_V1_VALUES) {
      const fields = requiredLineageFieldsForV1(entryFor(kind));
      for (const required of CANONICAL_LINEAGE_FIELDS_V1) {
        expect(fields).toContain(required);
      }
    }
  });

  it('preserves direct-versus-derived status on every entity', () => {
    for (const kind of CANONICAL_PROJECTION_KIND_V1_VALUES) {
      expect(requiredLineageFieldsForV1(entryFor(kind))).toContain('directOrDerived');
    }
  });

  it('contains no numeric value anywhere in the registry', () => {
    // A number in a mapping entry would be the first step toward float money.
    // Walk the parsed structure rather than the source text.
    const seen: string[] = [];
    const walk = (value: unknown, path: string): void => {
      if (typeof value === 'number') {
        seen.push(`${path}=${value}`);
        return;
      }
      if (Array.isArray(value)) {
        value.forEach((item, index) => walk(item, `${path}[${index}]`));
        return;
      }
      if (value !== null && typeof value === 'object') {
        for (const [key, item] of Object.entries(value)) walk(item, `${path}.${key}`);
      }
    };
    walk(DEFENSE_BUDGET_CANONICAL_MAPPING_REGISTRY_V1, 'registry');
    expect(seen).toEqual([]);
  });

  it('keeps quantity and unit cost on axes distinct from money', () => {
    const distribution = entryFor('non_rdte:ProcurementDistributionLine');
    expect(distribution.valueAxes).toContain('money');
    expect(distribution.valueAxes).toContain('quantity');
    expect(distribution.valueAxes).toContain('unit_cost');

    const omYear = entryFor('non_rdte:OmSagYear');
    expect(omYear.valueAxes).toEqual(['money']);
    expect(omYear.valueAxes).not.toContain('quantity');
  });
});

describe('Phase 7 Workstream B — alerting and supersession', () => {
  it('never marks provenance or proof rows alert-eligible', () => {
    for (const kind of CANONICAL_PROJECTION_KIND_V1_VALUES) {
      const entry = entryFor(kind);
      if (entry.alertClass === 'provenance' || entry.alertClass === 'proof') {
        expect(entry.alertEligible).toBe(false);
        expect(entry.deltaEligible).toBe(false);
      }
    }
  });

  it('only marks money-bearing entities alert-eligible', () => {
    for (const kind of CANONICAL_PROJECTION_KIND_V1_VALUES) {
      const entry = entryFor(kind);
      if (entry.alertEligible) {
        expect(entry.valueAxes).toContain('money');
        expect(entry.deltaEligible).toBe(true);
      }
    }
  });

  it('keeps source observations append-only', () => {
    for (const kind of [
      'rdte:ProgramElementSource',
      'non_rdte:BudgetLineSourceObservation',
    ] as const) {
      const entry = entryFor(kind);
      expect(entry.supersession).toBe('append_only_observation');
      expect(entry.canonicalEntity).toBe('canonical_budget_line_source_observation');
    }
  });

  it('marks every entry snapshot-scoped', () => {
    for (const kind of CANONICAL_PROJECTION_KIND_V1_VALUES) {
      expect(entryFor(kind).snapshotScoped).toBe(true);
    }
  });
});

describe('Phase 7 Workstream B — registry identity invalidates plans', () => {
  it('produces a stable hash across repeated derivation', () => {
    expect(canonicalMappingRegistryHashV1()).toBe(canonicalMappingRegistryHashV1());
  });

  it('produces a lowercase 64-character hex hash', () => {
    expect(canonicalMappingRegistryHashV1()).toMatch(/^[0-9a-f]{64}$/);
  });

  it('hashes independently of entry declaration order', () => {
    // Re-derive the hash from a key set shuffled into reverse order. The
    // registry sorts before hashing, so the result must be byte-identical.
    const forward = [...CANONICAL_PROJECTION_KIND_V1_VALUES].map((key) => ({
      key,
      entry: DEFENSE_BUDGET_CANONICAL_MAPPING_REGISTRY_V1[key],
    }));
    const reversed = [...forward].reverse();
    const hashOf = (entries: typeof forward) =>
      sha256CanonicalJson({
        schemaVersion: 'defense_budget_canonical_mapping_registry_v1',
        version: DEFENSE_BUDGET_CANONICAL_MAPPING_REGISTRY_VERSION,
        entries: [...entries].sort((a, b) => a.key.localeCompare(b.key)),
      } as unknown as JsonValue);
    expect(hashOf(reversed)).toBe(hashOf(forward));
    expect(hashOf(forward)).toBe(canonicalMappingRegistryHashV1());
  });

  it('changes the hash when any mapping changes — an altered registry invalidates plans', () => {
    const baseline = canonicalMappingRegistryHashV1();
    const mutated = {
      schemaVersion: 'defense_budget_canonical_mapping_registry_v1',
      version: DEFENSE_BUDGET_CANONICAL_MAPPING_REGISTRY_VERSION,
      entries: [...CANONICAL_PROJECTION_KIND_V1_VALUES]
        .map((key) => ({
          key,
          entry:
            key === 'non_rdte:OmSagYear'
              ? { ...DEFENSE_BUDGET_CANONICAL_MAPPING_REGISTRY_V1[key], alertEligible: false }
              : DEFENSE_BUDGET_CANONICAL_MAPPING_REGISTRY_V1[key],
        }))
        .sort((a, b) => a.key.localeCompare(b.key)),
    };
    expect(sha256CanonicalJson(mutated as unknown as JsonValue)).not.toBe(baseline);
  });

  it('changes the hash when the registry version changes', () => {
    const bumped = {
      schemaVersion: 'defense_budget_canonical_mapping_registry_v1',
      version: '1.0.1',
      entries: [...CANONICAL_PROJECTION_KIND_V1_VALUES]
        .map((key) => ({ key, entry: DEFENSE_BUDGET_CANONICAL_MAPPING_REGISTRY_V1[key] }))
        .sort((a, b) => a.key.localeCompare(b.key)),
    };
    expect(sha256CanonicalJson(bumped as unknown as JsonValue)).not.toBe(
      canonicalMappingRegistryHashV1(),
    );
  });

  it('freezes the registry against mutation at run time', () => {
    expect(Object.isFrozen(DEFENSE_BUDGET_CANONICAL_MAPPING_REGISTRY_V1)).toBe(true);
  });
});

describe('Phase 7 Workstream B — mapping report', () => {
  it('emits one deterministic row per mapped kind', () => {
    const rows = buildMappingReportV1();
    expect(rows).toHaveLength(CANONICAL_PROJECTION_KIND_V1_VALUES.length);
    expect(rows.map((row) => row.projectionKind)).toEqual([...CANONICAL_PROJECTION_KIND_V1_VALUES]);
    expect(buildMappingReportV1()).toEqual(rows);
  });

  it('renders markdown carrying the registry hash and every kind', () => {
    const markdown = renderMappingReportMarkdownV1();
    expect(markdown).toContain(canonicalMappingRegistryHashV1());
    for (const kind of CANONICAL_PROJECTION_KIND_V1_VALUES) {
      expect(markdown).toContain(`\`${kind}\``);
    }
  });
});
