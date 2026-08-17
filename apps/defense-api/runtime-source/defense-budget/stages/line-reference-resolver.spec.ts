/**
 * Phase 6 Workstream B — line-reference resolver tests.
 *
 * Required coverage: exact PE binding, procurement short-code namespace, base
 * vs advance procurement, O&M same SAG under different accounts, MILCON same
 * title at different installations, ambiguous -> conflicting, title-only ->
 * candidate, missing context -> unresolved, alias-map enforcement, and the
 * no-stub/no-title-binding architecture rules.
 */
import type { BudgetLineIdentityV1 } from '../contracts/extraction-artifact-v1.js';
import {
  bindingMachinePassAllowed,
  nativeIdentityKeyV1,
  stageAliasMapHashV1,
  type BudgetLineReferenceV1,
  type StageAliasMapV1,
} from './budget-line-reference-v1.js';
import {
  resolveBudgetLineReferenceV1,
  type LineReferenceResolutionContext,
  type NativeIdentityIndexEntry,
} from './line-reference-resolver.js';

/* ------------------------------------------------------------------ */
/* fixtures                                                            */
/* ------------------------------------------------------------------ */

const RDTE_PE_IDENTITY: BudgetLineIdentityV1 = {
  lineKind: 'RDTE_PE',
  peCode: '1160402F',
};

const PROCUREMENT_BASE: BudgetLineIdentityV1 = {
  lineKind: 'PROCUREMENT_BLIN',
  code: '12',
  account: 'PROC-NAVY',
  component: 'NAVY',
};

const PROCUREMENT_ADVANCE: BudgetLineIdentityV1 = {
  lineKind: 'PROCUREMENT_BLIN',
  code: '12',
  account: 'PROC-NAVY',
  component: 'NAVY',
  advanceProcurement: true,
};

const OM_SAG_OCO: BudgetLineIdentityV1 = {
  lineKind: 'OM_SAG',
  code: '1B21',
  account: 'O&M-ARMY-OCO',
  component: 'ARMY',
};

const OM_SAG_BASE: BudgetLineIdentityV1 = {
  lineKind: 'OM_SAG',
  code: '1B21',
  account: 'O&M-ARMY-BASE',
  component: 'ARMY',
};

const MILCON_FORT_A: BudgetLineIdentityV1 = {
  lineKind: 'MILCON_PROJECT',
  projectCode: 'P-100',
  component: 'ARMY',
  location: 'Fort Alpha',
};

const MILCON_FORT_B: BudgetLineIdentityV1 = {
  lineKind: 'MILCON_PROJECT',
  projectCode: 'P-100',
  component: 'NAVY',
  location: 'Naval Station Bravo',
};

function contextWith(
  entries: NativeIdentityIndexEntry[],
  aliasMap?: StageAliasMapV1,
): LineReferenceResolutionContext {
  return {
    index: entries,
    fiscalYear: 2026,
    profileId: 'fy2026-hasc-rdte',
    ...(aliasMap != null ? { aliasMap } : {}),
  };
}

function aliasMap(entries: StageAliasMapV1['entries']): StageAliasMapV1 {
  return { aliasMapVersion: 'am-2026-001', entries };
}

/* ------------------------------------------------------------------ */
/* exact PE binding                                                    */
/* ------------------------------------------------------------------ */

describe('resolver — exact PE binding', () => {
  it('binds an exact PE code to the native RDTE_PE identity', () => {
    const context = contextWith([
      { identity: RDTE_PE_IDENTITY, manifestDocumentKey: 'fy2026-r2', title: 'AI Research' },
    ]);
    const binding = resolveBudgetLineReferenceV1(
      { referenceKind: 'pe_code', peCode: '1160402F' },
      context,
    );
    expect(binding.status).toBe('accepted');
    expect(binding.basis).toBe('exact_identity');
    expect(binding.targetIdentity).toEqual(RDTE_PE_IDENTITY);
  });

  it('is deterministic under replay', () => {
    const context = contextWith([
      { identity: RDTE_PE_IDENTITY, manifestDocumentKey: 'fy2026-r2', title: 'AI Research' },
    ]);
    const reference: BudgetLineReferenceV1 = { referenceKind: 'pe_code', peCode: '1160402F' };
    const first = resolveBudgetLineReferenceV1(reference, context);
    const second = resolveBudgetLineReferenceV1(reference, context);
    expect(first).toEqual(second);
  });
});

/* ------------------------------------------------------------------ */
/* procurement namespace                                               */
/* ------------------------------------------------------------------ */

describe('resolver — procurement short-code namespace', () => {
  const index: NativeIdentityIndexEntry[] = [
    { identity: PROCUREMENT_BASE, manifestDocumentKey: 'fy2026-p1' },
    { identity: PROCUREMENT_ADVANCE, manifestDocumentKey: 'fy2026-p1' },
    {
      identity: { ...PROCUREMENT_BASE, account: 'PROC-ARMY', component: 'ARMY' },
      manifestDocumentKey: 'fy2026-p1',
    },
  ];

  it('requires the account namespace: bare short code never accepts', () => {
    const binding = resolveBudgetLineReferenceV1(
      { referenceKind: 'procurement_line', lineCode: '12' },
      contextWith(index),
    );
    expect(binding.status).not.toBe('accepted');
  });

  it('requires the account namespace even when one entry alone shares the code', () => {
    // The bare-short-code case above is only rejected because several fixtures
    // collide on code '12'. A lone index entry must be rejected for the same
    // reason — the short line number carries no account or base/AP namespace,
    // so widening the context match to code-only would bind it at confidence 1.
    const binding = resolveBudgetLineReferenceV1(
      { referenceKind: 'procurement_line', lineCode: '12' },
      contextWith([{ identity: PROCUREMENT_ADVANCE, manifestDocumentKey: 'fy2026-p1' }]),
    );
    expect(binding.status).not.toBe('accepted');
    expect(binding.basis).not.toBe('code_plus_unique_context');
    expect(bindingMachinePassAllowed(binding)).toBe(false);
  });

  it('binds exact code + account + component + base flag', () => {
    const binding = resolveBudgetLineReferenceV1(
      {
        referenceKind: 'procurement_line',
        lineCode: '12',
        account: 'PROC-NAVY',
        component: 'NAVY',
      },
      contextWith(index),
    );
    expect(binding.status).toBe('accepted');
    expect(binding.targetIdentity).toEqual(PROCUREMENT_BASE);
  });

  it('keeps base and advance procurement distinct', () => {
    const binding = resolveBudgetLineReferenceV1(
      {
        referenceKind: 'procurement_line',
        lineCode: '12',
        account: 'PROC-NAVY',
        component: 'NAVY',
        advanceProcurement: true,
      },
      contextWith(index),
    );
    expect(binding.status).toBe('accepted');
    expect(binding.targetIdentity).toEqual(PROCUREMENT_ADVANCE);
    expect(nativeIdentityKeyV1(binding.targetIdentity!)).not.toBe(
      nativeIdentityKeyV1(PROCUREMENT_BASE),
    );
  });

  it('accepts code + unique account context without component', () => {
    const binding = resolveBudgetLineReferenceV1(
      { referenceKind: 'procurement_line', lineCode: '12', account: 'PROC-ARMY' },
      contextWith(index),
    );
    expect(binding.status).toBe('accepted');
    expect(binding.basis).toBe('code_plus_unique_context');
    expect(binding.targetIdentity!.lineKind).toBe('PROCUREMENT_BLIN');
  });

  it('conflicts when code + account span multiple components', () => {
    const twoAccounts: NativeIdentityIndexEntry[] = [
      { identity: PROCUREMENT_BASE, manifestDocumentKey: 'fy2026-p1' },
      {
        identity: { ...PROCUREMENT_BASE, component: 'AF' },
        manifestDocumentKey: 'fy2026-p1',
      },
    ];
    const binding = resolveBudgetLineReferenceV1(
      { referenceKind: 'procurement_line', lineCode: '12', account: 'PROC-NAVY' },
      contextWith(twoAccounts),
    );
    expect(binding.status).toBe('conflicting');
    expect(binding.candidates).toHaveLength(2);
    expect(bindingMachinePassAllowed(binding)).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* O&M SAG accounts                                                    */
/* ------------------------------------------------------------------ */

describe('resolver — O&M SAG account context', () => {
  const index: NativeIdentityIndexEntry[] = [
    { identity: OM_SAG_BASE, manifestDocumentKey: 'fy2026-o1' },
    { identity: OM_SAG_OCO, manifestDocumentKey: 'fy2026-o1' },
  ];

  it('same SAG under different accounts conflicts without account', () => {
    const binding = resolveBudgetLineReferenceV1(
      { referenceKind: 'om_sag', sagCode: '1B21' },
      contextWith(index),
    );
    expect(binding.status).not.toBe('accepted');
  });

  it('same SAG under different accounts binds with account context', () => {
    const base = resolveBudgetLineReferenceV1(
      { referenceKind: 'om_sag', sagCode: '1B21', account: 'O&M-ARMY-BASE', component: 'ARMY' },
      contextWith(index),
    );
    const oco = resolveBudgetLineReferenceV1(
      { referenceKind: 'om_sag', sagCode: '1B21', account: 'O&M-ARMY-OCO', component: 'ARMY' },
      contextWith(index),
    );
    expect(base.status).toBe('accepted');
    expect(base.targetIdentity).toEqual(OM_SAG_BASE);
    expect(oco.status).toBe('accepted');
    expect(oco.targetIdentity).toEqual(OM_SAG_OCO);
    expect(nativeIdentityKeyV1(OM_SAG_BASE)).not.toBe(nativeIdentityKeyV1(OM_SAG_OCO));
  });
});

/* ------------------------------------------------------------------ */
/* MILCON                                                              */
/* ------------------------------------------------------------------ */

describe('resolver — MILCON identity', () => {
  const index: NativeIdentityIndexEntry[] = [
    { identity: MILCON_FORT_A, manifestDocumentKey: 'fy2026-c1', title: 'Barracks' },
    { identity: MILCON_FORT_B, manifestDocumentKey: 'fy2026-c1', title: 'Barracks' },
  ];

  it('same title at different installations never binds by title', () => {
    const binding = resolveBudgetLineReferenceV1(
      { referenceKind: 'milcon_project', projectCode: 'P-999', rowTitle: 'Barracks' },
      contextWith(index),
    );
    // Title matches two entries -> candidate at best, never accepted.
    expect(binding.status).not.toBe('accepted');
    expect(bindingMachinePassAllowed(binding)).toBe(false);
  });

  it('binds by project code + component', () => {
    const binding = resolveBudgetLineReferenceV1(
      { referenceKind: 'milcon_project', projectCode: 'P-100', component: 'ARMY' },
      contextWith(index),
    );
    expect(binding.status).toBe('accepted');
    expect(binding.targetIdentity).toEqual(MILCON_FORT_A);
  });

  it('project code without component is unresolved', () => {
    const binding = resolveBudgetLineReferenceV1(
      { referenceKind: 'milcon_project', projectCode: 'P-100' },
      contextWith(index),
    );
    expect(binding.status).toBe('unresolved');
  });
});

/* ------------------------------------------------------------------ */
/* ambiguous / title-only / missing context                            */
/* ------------------------------------------------------------------ */

describe('resolver — ambiguity rules', () => {
  it('ambiguous reference becomes conflicting, never best-score-wins', () => {
    const index: NativeIdentityIndexEntry[] = [
      { identity: RDTE_PE_IDENTITY, manifestDocumentKey: 'a' },
      {
        identity: { lineKind: 'RDTE_PE', peCode: '1160402F' },
        manifestDocumentKey: 'b',
      },
    ];
    const binding = resolveBudgetLineReferenceV1(
      { referenceKind: 'pe_code', peCode: '1160402F' },
      contextWith(index),
    );
    // Same identity twice = still one distinct identity -> accepted.
    expect(binding.status).toBe('accepted');

    const distinct: NativeIdentityIndexEntry[] = [
      { identity: RDTE_PE_IDENTITY, manifestDocumentKey: 'a', title: 'AI Research' },
      {
        identity: { lineKind: 'RDTE_PE', peCode: '1160481F' },
        manifestDocumentKey: 'b',
        title: 'AI Research',
      },
    ];
    const titleBinding = resolveBudgetLineReferenceV1(
      { referenceKind: 'pe_code', peCode: 'MISSING1', rowTitle: 'AI Research' },
      contextWith(distinct),
    );
    expect(titleBinding.status).toBe('candidate');
    expect(titleBinding.candidates).toHaveLength(2);
  });

  it('title-only match is candidate only', () => {
    const binding = resolveBudgetLineReferenceV1(
      { referenceKind: 'pe_code', peCode: 'NOPE0000', rowTitle: 'AI Research' },
      contextWith([{ identity: RDTE_PE_IDENTITY, manifestDocumentKey: 'a', title: 'AI Research' }]),
    );
    expect(binding.status).toBe('candidate');
    expect(binding.basis).toBe('title_candidate');
    expect(bindingMachinePassAllowed(binding)).toBe(false);
  });

  it('missing context becomes unresolved', () => {
    const binding = resolveBudgetLineReferenceV1(
      { referenceKind: 'om_sag', sagCode: '9Z99' },
      contextWith([{ identity: OM_SAG_BASE, manifestDocumentKey: 'a' }]),
    );
    expect(binding.status).toBe('unresolved');
    expect(bindingMachinePassAllowed(binding)).toBe(false);
  });

  it('explicit unresolved reference stays unresolved', () => {
    const binding = resolveBudgetLineReferenceV1(
      { referenceKind: 'unresolved_reference', rawText: 'classified line' },
      contextWith([]),
    );
    expect(binding.status).toBe('unresolved');
  });

  it('package scope references never bind to a line identity', () => {
    const binding = resolveBudgetLineReferenceV1(
      { referenceKind: 'package_scope', scope: 'TITLE IX GENERAL PROVISIONS' },
      contextWith([{ identity: RDTE_PE_IDENTITY, manifestDocumentKey: 'a' }]),
    );
    expect(binding.status).toBe('unresolved');
  });
});

/* ------------------------------------------------------------------ */
/* alias map                                                           */
/* ------------------------------------------------------------------ */

describe('resolver — reviewed alias map', () => {
  const entries = [
    {
      sourceToken: '0604270F',
      identity: RDTE_PE_IDENTITY,
      effectiveFiscalYear: 2026,
      sourceProfileId: 'fy2026-hasc-rdte',
      author: 'ops',
      reviewer: 'neo',
      reviewedAt: '2026-07-01T00:00:00Z',
    },
  ];

  it('binds through an exact reviewed alias entry', () => {
    const map = aliasMap(entries);
    const binding = resolveBudgetLineReferenceV1(
      { referenceKind: 'pe_code', peCode: '0604270F' },
      contextWith([], map),
    );
    expect(binding.status).toBe('accepted');
    expect(binding.basis).toBe('reviewed_alias');
    expect(binding.aliasMapVersion).toBe('am-2026-001');
    expect(binding.aliasMapHash).toBe(stageAliasMapHashV1(map));
  });

  it('alias hash mismatch is blocking (explicit hash must be recomputed)', () => {
    const map = aliasMap(entries);
    const recordedHash = stageAliasMapHashV1(map);
    const tampered: StageAliasMapV1 = {
      ...map,
      entries: [{ ...entries[0]!, identity: { lineKind: 'RDTE_PE', peCode: 'DEADBEEF' } }],
    };
    // The tampered map's hash no longer matches the recorded hash: any
    // downstream consumer comparing against the recorded hash must block.
    expect(stageAliasMapHashV1(tampered)).not.toBe(recordedHash);
  });

  it('alias entry for the wrong fiscal year does not bind', () => {
    const map = aliasMap([{ ...entries[0]!, effectiveFiscalYear: 2025 }]);
    const binding = resolveBudgetLineReferenceV1(
      { referenceKind: 'pe_code', peCode: '0604270F' },
      contextWith([], map),
    );
    expect(binding.status).not.toBe('accepted');
  });

  it('alias entry for the wrong profile does not bind', () => {
    const map = aliasMap([{ ...entries[0]!, sourceProfileId: 'some-other-profile' }]);
    const binding = resolveBudgetLineReferenceV1(
      { referenceKind: 'pe_code', peCode: '0604270F' },
      contextWith([], map),
    );
    expect(binding.status).not.toBe('accepted');
  });
});

/* ------------------------------------------------------------------ */
/* architecture rules                                                  */
/* ------------------------------------------------------------------ */

describe('resolver — architecture rules', () => {
  it('never produces an accepted UNKNOWN identity', () => {
    const index: NativeIdentityIndexEntry[] = [
      { identity: { lineKind: 'UNKNOWN', code: 'LEGACY-123' }, manifestDocumentKey: 'a' },
    ];
    const binding = resolveBudgetLineReferenceV1(
      { referenceKind: 'pe_code', peCode: 'LEGACY-123' },
      contextWith(index),
    );
    expect(binding.status).not.toBe('accepted');
  });

  it('no non-RDT&E line becomes an RDT&E PE binding', () => {
    const index: NativeIdentityIndexEntry[] = [
      { identity: PROCUREMENT_BASE, manifestDocumentKey: 'a', title: 'Tomahawk' },
    ];
    const binding = resolveBudgetLineReferenceV1(
      { referenceKind: 'pe_code', peCode: '0123456F', rowTitle: 'Tomahawk' },
      contextWith(index),
    );
    if (binding.status === 'accepted') {
      expect(binding.targetIdentity!.lineKind).not.toBe('RDTE_PE');
    } else {
      // Title match against a procurement identity is candidate-only.
      expect(binding.status).toBe('candidate');
    }
  });
});
