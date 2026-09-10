/**
 * Phase 10B-1 — maps a governed lifecycle `SourceFamily` (the Session 7
 * discovery/classification vocabulary in `@capiro/defense-domain`) onto the
 * routing metadata the EXISTING Phase 3 parser router
 * (`ParserRouterV1Service`) needs: which `ExhibitV1`/`BudgetFamilyV1` it is,
 * and which `ParserPolicyV1` should seed the initial parse plan.
 *
 * This is DETECTION METADATA ONLY, same posture as
 * `document-classifier.ts`'s local-corpus classifier: it decides ROUTING, and
 * never produces or asserts a funding amount. Every value in
 * `packages/defense-domain/src/budget-lifecycle/types.ts`'s `SourceFamily`
 * union is covered explicitly (no catch-all fallback) so that a future
 * SourceFamily added there without a matching entry here fails to compile —
 * exactly the same "explicit exhaustive mapping over an enum" discipline
 * `STAGE_TRACK` in `types.ts` itself uses.
 */
import type { SourceFamily } from '@capiro/defense-domain';
import type { BudgetAuthorityV1, BudgetFamilyV1, ExhibitV1 } from '../contracts/extraction-artifact-v1.js';
import type { ParserPolicyV1 } from '../contracts/budget-cycle-manifest-v1.js';

export interface SourceFamilyRouting {
  readonly family: BudgetFamilyV1;
  readonly exhibit: ExhibitV1;
  readonly parserPolicy: ParserPolicyV1;
  /** budget_cycle string for SourceDocument (pb | hasc | sasc | hac_d | sac_d | conference | enacted | ...). */
  readonly budgetCycle: string;
  readonly documentType: string;
  readonly authority: BudgetAuthorityV1;
}

const ROUTING: Readonly<Record<SourceFamily, SourceFamilyRouting>> = Object.freeze({
  // President's Budget / DoD exhibits — deterministic tabular J-books.
  pb_overview: {
    family: 'overview',
    exhibit: 'unknown',
    parserPolicy: 'mixed_layout',
    budgetCycle: 'pb',
    documentType: 'overview',
    authority: 'dod-comptroller',
  },
  pb_r1: {
    family: 'rdte',
    exhibit: 'R-1',
    parserPolicy: 'deterministic_table',
    budgetCycle: 'pb',
    documentType: 'r1',
    authority: 'dod-comptroller',
  },
  pb_r2: {
    family: 'rdte',
    exhibit: 'R-2',
    parserPolicy: 'deterministic_table',
    budgetCycle: 'pb',
    documentType: 'r2',
    authority: 'dod-comptroller',
  },
  pb_r2a: {
    family: 'rdte',
    exhibit: 'R-2A',
    parserPolicy: 'deterministic_table',
    budgetCycle: 'pb',
    documentType: 'r2a',
    authority: 'dod-comptroller',
  },
  pb_r3: {
    family: 'rdte',
    exhibit: 'R-3',
    parserPolicy: 'deterministic_table',
    budgetCycle: 'pb',
    documentType: 'r3',
    authority: 'dod-comptroller',
  },
  pb_r4: {
    family: 'rdte',
    exhibit: 'R-4',
    parserPolicy: 'deterministic_table',
    budgetCycle: 'pb',
    documentType: 'r4',
    authority: 'dod-comptroller',
  },
  pb_p1: {
    family: 'procurement',
    exhibit: 'P-1',
    parserPolicy: 'deterministic_table',
    budgetCycle: 'pb',
    documentType: 'p1',
    authority: 'dod-comptroller',
  },
  pb_p_series: {
    family: 'procurement',
    exhibit: 'P-40',
    parserPolicy: 'deterministic_table',
    budgetCycle: 'pb',
    documentType: 'p_series',
    authority: 'dod-comptroller',
  },
  pb_o1: {
    family: 'om',
    exhibit: 'O-1',
    parserPolicy: 'deterministic_table',
    budgetCycle: 'pb',
    documentType: 'o1',
    authority: 'dod-comptroller',
  },
  pb_op5: {
    family: 'om',
    exhibit: 'OP-5',
    parserPolicy: 'deterministic_table',
    budgetCycle: 'pb',
    documentType: 'op5',
    authority: 'dod-comptroller',
  },
  pb_milcon_c1: {
    family: 'milcon',
    exhibit: 'C-1',
    parserPolicy: 'deterministic_table',
    budgetCycle: 'pb',
    documentType: 'c1',
    authority: 'dod-comptroller',
  },
  pb_dd1391: {
    family: 'milcon',
    exhibit: 'DD1391',
    parserPolicy: 'mixed_layout',
    budgetCycle: 'pb',
    documentType: 'dd1391',
    authority: 'dod-comptroller',
  },

  // Authorization track.
  auth_committee_mark: {
    family: 'committee',
    exhibit: 'committee_report',
    parserPolicy: 'mixed_layout',
    budgetCycle: 'hasc',
    documentType: 'committee_mark',
    authority: 'hasc',
  },
  auth_committee_report: {
    family: 'committee',
    exhibit: 'committee_report',
    parserPolicy: 'mixed_layout',
    budgetCycle: 'hasc',
    documentType: 'committee_report',
    authority: 'hasc',
  },
  auth_chamber_action: {
    family: 'committee',
    exhibit: 'committee_report',
    parserPolicy: 'mixed_layout',
    budgetCycle: 'hasc',
    documentType: 'chamber_action',
    authority: 'hasc',
  },
  auth_conference_report: {
    family: 'committee',
    exhibit: 'conference_report',
    parserPolicy: 'mixed_layout',
    budgetCycle: 'conference',
    documentType: 'conference_report',
    authority: 'ndaa_conference',
  },
  auth_public_law: {
    family: 'public_law',
    exhibit: 'public_law',
    parserPolicy: 'mixed_layout',
    budgetCycle: 'enacted',
    documentType: 'public_law',
    authority: 'public_law',
  },

  // Appropriations track.
  appr_committee_mark: {
    family: 'committee',
    exhibit: 'committee_report',
    parserPolicy: 'mixed_layout',
    budgetCycle: 'hac_d',
    documentType: 'committee_mark',
    authority: 'hac_d',
  },
  appr_committee_report: {
    family: 'committee',
    exhibit: 'committee_report',
    parserPolicy: 'mixed_layout',
    budgetCycle: 'hac_d',
    documentType: 'committee_report',
    authority: 'hac_d',
  },
  appr_chamber_action: {
    family: 'committee',
    exhibit: 'committee_report',
    parserPolicy: 'mixed_layout',
    budgetCycle: 'hac_d',
    documentType: 'chamber_action',
    authority: 'hac_d',
  },
  appr_conference_jes: {
    family: 'committee',
    exhibit: 'conference_report',
    parserPolicy: 'mixed_layout',
    budgetCycle: 'conference',
    documentType: 'conference_jes',
    authority: 'appropriations_conference',
  },
  appr_public_law: {
    family: 'public_law',
    exhibit: 'public_law',
    parserPolicy: 'mixed_layout',
    budgetCycle: 'enacted',
    documentType: 'public_law',
    authority: 'public_law',
  },

  // Alternative funding. Authority-track separation is carried by the caller
  // (the observation's own `authorityTrack`, threaded through unchanged) —
  // never inferred or overwritten here.
  alt_supplemental: {
    family: 'public_law',
    exhibit: 'public_law',
    parserPolicy: 'mixed_layout',
    budgetCycle: 'supplemental',
    documentType: 'supplemental',
    authority: 'public_law',
  },
  alt_reconciliation: {
    family: 'public_law',
    exhibit: 'public_law',
    parserPolicy: 'mixed_layout',
    budgetCycle: 'supplemental',
    documentType: 'reconciliation',
    authority: 'public_law',
  },
  alt_continuing_resolution: {
    family: 'public_law',
    exhibit: 'public_law',
    parserPolicy: 'mixed_layout',
    budgetCycle: 'supplemental',
    documentType: 'continuing_resolution',
    authority: 'public_law',
  },
  alt_rescission: {
    family: 'public_law',
    exhibit: 'public_law',
    parserPolicy: 'mixed_layout',
    budgetCycle: 'supplemental',
    documentType: 'rescission',
    authority: 'public_law',
  },
  alt_transfer: {
    family: 'committee',
    exhibit: 'committee_report',
    parserPolicy: 'mixed_layout',
    budgetCycle: 'supplemental',
    documentType: 'transfer',
    authority: 'reprogramming',
  },
  alt_reprogramming: {
    family: 'committee',
    exhibit: 'committee_report',
    parserPolicy: 'mixed_layout',
    budgetCycle: 'supplemental',
    documentType: 'reprogramming',
    authority: 'reprogramming',
  },

  // Execution. Not discoverable by any registered watcher adapter today, but
  // covered so the mapping stays exhaustive over the full SourceFamily union.
  exec_allocation: {
    family: 'unknown',
    exhibit: 'unknown',
    parserPolicy: 'complex',
    budgetCycle: 'execution',
    documentType: 'allocation',
    authority: 'execution',
  },
  exec_obligation: {
    family: 'unknown',
    exhibit: 'unknown',
    parserPolicy: 'complex',
    budgetCycle: 'execution',
    documentType: 'obligation',
    authority: 'execution',
  },
  exec_award: {
    family: 'unknown',
    exhibit: 'unknown',
    parserPolicy: 'complex',
    budgetCycle: 'execution',
    documentType: 'award',
    authority: 'execution',
  },
});

export function routingForSourceFamily(sourceFamily: SourceFamily): SourceFamilyRouting {
  return ROUTING[sourceFamily];
}
