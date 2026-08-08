/**
 * Neo's decision, 2026-08-08 — settled architecture, do not reopen.
 *
 * `native identity ≠ crosswalk`. These tests pin two things: that RDT&E and
 * procurement identities stay structurally separate in the registry, and that
 * nothing claims a governed PE↔BLIN crosswalk exists while the review triple
 * is still missing.
 */
import {
  CROSSWALK_SUBSTRATE_PRESENT_FIELDS_V1,
  GOVERNED_CROSSWALK_REQUIRED_FIELDS_V1,
  crossFamilyLinkLabelV1,
  crosswalkSubstrateReadinessV1,
} from './cross-family-crosswalk-v1.js';
import { lookupCanonicalMappingV1 } from './canonical-mapping-registry-v1.js';

describe('native identity separation — RDT&E peCode vs procurement BLIN', () => {
  it('no procurement entity is keyed by peCode', () => {
    // The identity conflation this forbids is legacy
    // program_element_procurement_line, which files a BLIN inside RDT&E
    // Program Element identity space. If a procurement mapping ever gains a
    // peCode key field, that defect has come back.
    for (const kind of ['non_rdte:ProcurementBudgetLine', 'non_rdte:ProcurementBudgetLineYear']) {
      const result = lookupCanonicalMappingV1(kind);
      if (!result.supported) continue;
      expect(result.entry.naturalKeyFields).not.toContain('peCode');
    }
  });

  it('the procurement BLIN keeps its full four-part native identity', () => {
    const result = lookupCanonicalMappingV1('non_rdte:ProcurementBudgetLine');
    expect(result.supported).toBe(true);
    if (!result.supported) return;
    // account is required because short line numbers repeat across accounts,
    // and advanceProcurement because base and AP lines must stay distinct.
    expect(result.entry.naturalKeyFields).toEqual(
      expect.arrayContaining(['component', 'account', 'lineCode', 'advanceProcurement']),
    );
  });

  it('no RDT&E entity is keyed by a procurement identity component', () => {
    const result = lookupCanonicalMappingV1('rdte:ProgramElement');
    expect(result.supported).toBe(true);
    if (!result.supported) return;
    for (const blinField of ['lineCode', 'advanceProcurement', 'account']) {
      expect(result.entry.naturalKeyFields).not.toContain(blinField);
    }
  });
});

describe('governed crosswalk readiness', () => {
  it('is NOT ready — the substrate has no review state', () => {
    const readiness = crosswalkSubstrateReadinessV1();
    expect(readiness.ready).toBe(false);
  });

  it('names exactly the review triple as what is missing', () => {
    // If a migration later adds status/reviewedBy/reviewedAt, this test fails
    // and forces someone to update CROSSWALK_SUBSTRATE_PRESENT_FIELDS_V1
    // deliberately, rather than the readiness flag drifting silently true.
    const readiness = crosswalkSubstrateReadinessV1();
    expect([...readiness.missingFields].sort()).toEqual(['reviewedAt', 'reviewedBy', 'status']);
  });

  it('explains why the affected reads stay on the legacy path', () => {
    expect(crosswalkSubstrateReadinessV1().detail).toContain('legacy path');
  });

  it('the present-field list never claims a field the contract does not define', () => {
    const required = new Set<string>(GOVERNED_CROSSWALK_REQUIRED_FIELDS_V1);
    for (const field of CROSSWALK_SUBSTRATE_PRESENT_FIELDS_V1) {
      expect(required.has(field)).toBe(true);
    }
  });
});

describe('user-facing labelling of a cross-family link', () => {
  it('reserves the unhedged label for an accepted relationship', () => {
    expect(crossFamilyLinkLabelV1('accepted')).toBe('Related procurement line');
  });

  it('hedges a candidate rather than presenting it as established', () => {
    expect(crossFamilyLinkLabelV1('candidate')).toBe('Possible related procurement line');
    expect(crossFamilyLinkLabelV1('candidate')).toContain('Possible');
  });

  it('never labels any status as a child PE record', () => {
    for (const status of ['accepted', 'candidate', 'rejected'] as const) {
      expect(crossFamilyLinkLabelV1(status).toLowerCase()).not.toContain('project');
      expect(crossFamilyLinkLabelV1(status).toLowerCase()).not.toContain('child');
    }
  });
});
