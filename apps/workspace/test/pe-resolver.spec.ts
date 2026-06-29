import { describe, expect, test } from '@jest/globals';
import {
  PeResolverService,
  type AuthoritativePeRecord,
} from '../src/generation/pe-resolver.service.js';
import {
  collectPeStructuralWarnings,
  type PeRecordForValidation,
} from '../src/generation/domain-grounding.helpers.js';

/**
 * PeResolverService pure-logic tests (no DB). The DB read path (`resolve`) is a
 * thin parameterized $queryRaw covered by integration; here we verify the two
 * pure projections that close the retrieve-before-write gap:
 *  - groundingText: turns an authoritative PE record into a factual prompt block
 *    (mission, appropriation type, budget activity, budget figures).
 *  - toValidationRecord: feeds the REAL appropriation type into the structural
 *    validator so an RDT&E line drafted with procurement language is flagged
 *    even when the attached Context Builder PE was thin/wrong.
 */

// A stub Prisma — never called by the pure methods under test.
const stubPrisma = {} as never;
const svc = new PeResolverService(stubPrisma);

// Authoritative record as the DB would return it (real RDT&E fire-control line,
// drawn from the Perseus memo class of errors).
const XM32_RDTE: AuthoritativePeRecord = {
  peCode: '5726K99200',
  title: 'XM32 Fire-Control Computer',
  description: 'Handheld ballistic fire-control computer for dismounted crews.',
  service: 'Army',
  appropriationType: 'RDT&E',
  budgetActivity: '04',
  budgetActivityName: 'Advanced Component Development & Prototypes',
  status: 'active',
  years: [
    { fy: 2027, request: 42.5, enacted: null, hascMark: 50, sascMark: 45 },
    { fy: 2026, request: 38, enacted: 38, hascMark: null, sascMark: null },
  ],
};

describe('PeResolverService.groundingText', () => {
  test('states mission, appropriation type, budget activity, and FY figures', () => {
    const out = svc.groundingText(XM32_RDTE);
    expect(out).toContain('PE 5726K99200 — XM32 Fire-Control Computer');
    expect(out).toContain('RDT&E');
    expect(out).toContain('Budget Activity 04');
    expect(out).toContain('Advanced Component Development');
    expect(out).toContain('Mission:');
    // Real budget figures with their fiscal years.
    expect(out).toMatch(/FY2027: request \$42\.5M/);
    expect(out).toContain('HASC $50M');
  });

  test('omits empty sections gracefully (bare record)', () => {
    const bare: AuthoritativePeRecord = {
      peCode: '0604999Z',
      title: null,
      description: null,
      service: null,
      appropriationType: null,
      budgetActivity: null,
      budgetActivityName: null,
      status: null,
      years: [],
    };
    const out = svc.groundingText(bare);
    expect(out).toContain('PE 0604999Z');
    expect(out).not.toContain('Budget:');
    expect(out).not.toContain('Mission:');
  });
});

describe('PeResolverService.toValidationRecord → structural checks', () => {
  test('authoritative RDT&E record flags procurement language the attached PE would have missed', () => {
    // Simulate the bug: attached Context Builder PE had NO appropriation type, so
    // the old path could not flag the RDT&E/procurement mismatch.
    const attachedThin: PeRecordForValidation = { peCode: '5726K99200', title: null };
    const deliverable =
      'We recommend directed procurement of the XM32 system through PE 5726K99200.';

    const missedByThin = collectPeStructuralWarnings([attachedThin], deliverable);
    expect(missedByThin).toHaveLength(0); // thin record can't catch it

    // With the authoritative record, the real appropriation type drives the check.
    const authRecord = svc.toValidationRecord(XM32_RDTE);
    const caught = collectPeStructuralWarnings([authRecord], deliverable);
    expect(caught.some((w) => w.code === 'rdte_procurement_mismatch')).toBe(true);
  });

  test('toValidationRecord preserves the fields the validator needs', () => {
    const v = svc.toValidationRecord(XM32_RDTE);
    expect(v).toMatchObject({
      peCode: '5726K99200',
      appropriationType: 'RDT&E',
      budgetActivity: '04',
    });
  });
});
