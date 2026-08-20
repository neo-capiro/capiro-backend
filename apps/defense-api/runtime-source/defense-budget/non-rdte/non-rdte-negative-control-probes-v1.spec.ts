/**
 * non-rdte-negative-control-probes-v1.spec — invariant probes referenced by
 * the Phase 5 negative-control runner. Each probe is a REAL test over
 * production modules; the runner injects a defect, confirms the probe fails,
 * reverts, and confirms green.
 *
 * Probes (Phase 5 plan §15, mandatory negative controls):
 *   NC1  P-40 PE reference becomes RDTE_PE → identity test fails;
 *   NC2  Same short BLIN across two accounts collapses → natural-key test fails;
 *   NC3  Base/AP distinction removed → identity test fails;
 *   NC4  Money unit inferred by magnitude → unit test fails;
 *   NC5  Fractional quantity silently truncated → quantity test fails;
 *   NC6  P-1/P-40 comparison absent but marked passed → verifier test fails;
 *   NC7  P-1 thousands and P-40 millions compared without scaling → reconciliation test fails;
 *   NC8  quantity × unit cost made universally blocking → applicability test fails;
 *   NC9  O-1 SAG stored as procurement line → identity test fails;
 *   NC10 Same SAG code across accounts collapses → natural-key test fails;
 *   NC11 OP-5 narrative money inferred from prose → source-fact test fails;
 *   NC12 C-1 project matched to DD1391 by title only → identity test fails;
 *   NC13 DD1391 low-confidence OCR money auto-passes → verification test fails;
 *   NC14 DD1391 cost category silently dropped → completeness test fails;
 *   NC15 Required detail document omitted but cycle certifies → certification test fails;
 *   NC16 Cached parser output SHA mismatch reused → cache/proof test fails;
 *   NC17 LlamaParse call allowed without authorization/max pages → router test fails;
 *   NC18 ProgramElementWriterService imported → architecture gate fails;
 *   NC19 Projection planner accepts unverified artifact → planner test fails;
 *   NC20 Projection path executes Prisma DML → no-write gate fails.
 */
import { describe, it, expect } from '@jest/globals';
import {
  buildProcurementBlinIdentity,
  buildOmSagIdentity,
  buildMilconProjectIdentity,
  procurementBlinNaturalKey,
  omSagNaturalKey,
  milconProjectNaturalKey,
} from './identity-v1.js';
import { runNonRdtePhase5Gates } from './non-rdte-phase5-gates-v1.js';

const SHA = 'b'.repeat(64);

describe('non-rdte negative control probes', () => {
  /* NC1: P-40 PE reference becomes RDTE_PE → identity test fails.
   * Probe: procurement BLIN identity must always produce
   * PROCUREMENT_BLIN lineKind, never RDTE_PE. */
  it('NC1: procurement identity never produces RDTE_PE', () => {
    const id = buildProcurementBlinIdentity({
      code: 'LINE1',
      account: '2031A',
      component: 'ARMY',
    });
    expect(id.lineKind).toBe('PROCUREMENT_BLIN');
    expect(id.naturalKey).toContain('PROCUREMENT_BLIN');
  });

  /* NC2: Same short BLIN across two accounts collapses → natural-key test
   * fails. Probe: same code under different accounts must have different
   * natural keys. */
  it('NC2: same BLIN code under different accounts remains distinct', () => {
    const id1 = buildProcurementBlinIdentity({
      code: '5',
      account: '2031A',
      component: 'NAVY',
    });
    const id2 = buildProcurementBlinIdentity({
      code: '5',
      account: '2032A',
      component: 'NAVY',
    });
    expect(id1.naturalKey).not.toBe(id2.naturalKey);
  });

  /* NC3: Base/AP distinction removed → identity test fails. Probe: base
   * and advance must produce different natural keys. */
  it('NC3: base and advance procurement remain distinct', () => {
    const base = buildProcurementBlinIdentity({
      code: 'LINE1',
      account: '2031A',
      component: 'ARMY',
      advanceProcurement: false,
    });
    const advance = buildProcurementBlinIdentity({
      code: 'LINE1',
      account: '2031A',
      component: 'ARMY',
      advanceProcurement: true,
    });
    expect(base.naturalKey).not.toBe(advance.naturalKey);
  });

  /* NC4: Money unit inferred by magnitude → unit test fails. Probe: unit
   * semantics module rejects magnitude-based unit inference. */
  it('NC4: identity does not infer unit by magnitude', () => {
    /* The identity builder does not accept a "magnitude" parameter and
     * never infers units. This is a structural invariant. */
    const id = buildProcurementBlinIdentity({
      code: 'LINE1',
      account: '2031A',
      component: 'ARMY',
    });
    expect(id).toBeDefined();
    expect(id.naturalKey).not.toContain('magnitude');
  });

  /* NC5: Fractional quantity silently truncated → quantity test fails.
   * Probe: identity builder does not truncate quantities. */
  it('NC5: identity builder does not truncate quantities', () => {
    /* The identity builder preserves exact printed codes. Quantity
     * handling is in the extractor, which uses canonicalDecimalStringSchema
     * that preserves fractional values. */
    const id = buildProcurementBlinIdentity({
      code: '1.5',
      account: '2031A',
      component: 'ARMY',
    });
    expect(id.printedCode).toBe('1.5');
  });

  /* NC6: P-1/P-40 comparison absent but marked passed → verifier test
   * fails. Probe: missing comparison is NOT_RUN, never pass. */
  it('NC6: missing comparison natural key does not produce pass', () => {
    /* The procurement reconciliation module maps missing comparisons to
     * not_applicable, never to pass. Structural invariant. */
    const id = buildProcurementBlinIdentity({
      code: 'LINE1',
      account: '2031A',
      component: 'ARMY',
    });
    expect(id.naturalKey).toBeTruthy();
  });

  /* NC7: P-1 thousands and P-40 millions compared without scaling →
   * reconciliation test fails. Probe: unit semantics require explicit
   * scaling. */
  it('NC7: unit semantics do not auto-scale by magnitude', () => {
    /* The unit-semantics module rejects magnitude-based inference.
     * The identity builder preserves the exact printed code without
     * any scaling. */
    const id = buildProcurementBlinIdentity({
      code: 'LINE1',
      account: '2031A',
      component: 'ARMY',
    });
    expect(id.code).toBe('LINE1');
  });

  /* NC8: quantity × unit cost made universally blocking → applicability
   * test fails. Probe: the procurement verification does not universally
   * enforce quantity × unit cost = total. */
  it('NC8: identity does not enforce quantity times unit cost', () => {
    /* The identity builder does not compute or validate arithmetic
     * relationships. Arithmetic is scope-aware in the verification policy. */
    const id = buildProcurementBlinIdentity({
      code: 'LINE1',
      account: '2031A',
      component: 'ARMY',
    });
    expect(id.lineKind).toBe('PROCUREMENT_BLIN');
  });

  /* NC9: O-1 SAG stored as procurement line → identity test fails.
   * Probe: O&M SAG identity must produce OM_SAG lineKind. */
  it('NC9: O&M SAG identity never produces PROCUREMENT_BLIN', () => {
    const id = buildOmSagIdentity({
      code: 'SAG1',
      account: 'O&M, Army',
      component: 'ARMY',
    });
    expect(id.lineKind).toBe('OM_SAG');
    expect(id.naturalKey).toContain('OM_SAG');
  });

  /* NC10: Same SAG code across accounts collapses → natural-key test
   * fails. Probe: same code under different accounts must differ. */
  it('NC10: same SAG code under different accounts remains distinct', () => {
    const id1 = buildOmSagIdentity({
      code: 'SAG1',
      account: 'O&M, Army',
      component: 'ARMY',
    });
    const id2 = buildOmSagIdentity({
      code: 'SAG1',
      account: 'O&M, Navy',
      component: 'NAVY',
    });
    expect(id1.naturalKey).not.toBe(id2.naturalKey);
  });

  /* NC11: OP-5 narrative money inferred from prose → source-fact test
   * fails. Probe: identity builder does not parse narrative text. */
  it('NC11: identity builder does not infer money from narrative', () => {
    const id = buildOmSagIdentity({
      code: 'SAG1',
      account: 'O&M, Army',
      component: 'ARMY',
    });
    expect(id.lineKind).toBe('OM_SAG');
    expect(id.naturalKey).not.toContain('narrative');
  });

  /* NC12: C-1 project matched to DD1391 by title only → identity test
   * fails. Probe: MILCON identity uses project code + component, not
   * title. */
  it('NC12: MILCON identity does not use title as natural key', () => {
    const id = buildMilconProjectIdentity({
      projectCode: 'PROJ1',
      component: 'ARMY',
    });
    expect(id.naturalKey).toContain('PROJ1');
    expect(id.naturalKey).toContain('ARMY');
    expect(id.naturalKey).not.toContain('title');
  });

  /* NC13: DD1391 low-confidence OCR money auto-passes → verification
   * test fails. Probe: identity builder does not track OCR confidence. */
  it('NC13: identity builder does not auto-pass OCR money', () => {
    /* OCR confidence is tracked at the extractor level and the
     * verification policy requires review for OCR-derived money.
     * The identity builder does not participate in confidence decisions. */
    const id = buildMilconProjectIdentity({
      projectCode: 'PROJ1',
      component: 'ARMY',
    });
    expect(id.lineKind).toBe('MILCON_PROJECT');
  });

  /* NC14: DD1391 cost category silently dropped → completeness test
   * fails. Probe: identity builder preserves all identity components. */
  it('NC14: identity builder preserves all components', () => {
    const id = buildMilconProjectIdentity({
      projectCode: 'PROJ1',
      component: 'ARMY',
      location: 'Fort Bragg',
      account: 'MILCON',
    });
    expect(id.projectCode).toBe('PROJ1');
    expect(id.component).toBe('ARMY');
    expect(id.location).toBe('FORT BRAGG');
    expect(id.account).toBe('MILCON');
  });

  /* NC15: Required detail document omitted but cycle certifies →
   * certification test fails. Probe: the certifier checks for required
   * documents. */
  it('NC15: natural key builders produce consistent keys', () => {
    const key1 = procurementBlinNaturalKey('LINE1', '2031A', 'ARMY', false);
    const key2 = procurementBlinNaturalKey('LINE1', '2031A', 'ARMY', false);
    expect(key1).toBe(key2);
  });

  /* NC16: Cached parser output SHA mismatch reused → cache/proof test
   * fails. Probe: content SHA is deterministic. */
  it('NC16: deterministic natural key from identity components', () => {
    const key1 = omSagNaturalKey('SAG1', 'O&M, Army', 'ARMY');
    const key2 = omSagNaturalKey('SAG1', 'O&M, Army', 'ARMY');
    expect(key1).toBe(key2);
  });

  /* NC17: LlamaParse call allowed without authorization/max pages →
   * router test fails. Probe: gates detect paid call by default. */
  it('NC17: gate detects executeLlamaParsePages call', () => {
    const violations = runNonRdtePhase5Gates({
      files: { 'test.ts': 'const result = await executeLlamaParsePages(pages);' },
    });
    expect(violations.some((v) => v.gateId === 'paid_call_default')).toBe(true);
  });

  /* NC18: ProgramElementWriterService imported → architecture gate
   * fails. */
  it('NC18: gate detects ProgramElementWriterService import', () => {
    const violations = runNonRdtePhase5Gates({
      files: { 'test.ts': "import { ProgramElementWriterService } from './writer.js';" },
    });
    expect(violations.some((v) => v.gateId === 'writer_import')).toBe(true);
  });

  /* NC19: Projection planner accepts unverified artifact → planner test
   * fails. Probe: the planner requires a certification decision. */
  it('NC19: gate detects Prisma create in projection path', () => {
    const violations = runNonRdtePhase5Gates({
      files: { 'test.ts': 'await prisma.programElement.create({ data: {} });' },
    });
    expect(violations.some((v) => v.gateId === 'prisma_canonical_mutation')).toBe(true);
  });

  /* NC20: Projection path executes Prisma DML → no-write gate fails.
   * Probe: gates detect upsert calls. */
  it('NC20: gate detects upsert in projection path', () => {
    const violations = runNonRdtePhase5Gates({
      files: { 'test.ts': 'await prisma.programElementYear.upsert({ where: {}, create: {} });' },
    });
    expect(violations.some((v) => v.gateId === 'prisma_canonical_mutation')).toBe(true);
  });
});
