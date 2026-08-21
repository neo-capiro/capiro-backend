/**
 * Versioned expected-source-family templates.
 *
 * These templates are the reason FY28, FY29 and later cycles need no bespoke
 * hand-built manifest: the controller instantiates a cycle for ANY fiscal year
 * from this governed, versioned description of which official source families
 * are expected, on which track, at which stage, and roughly when.
 *
 * The templates deliberately contain NO URLs. Discovery rules live in the
 * adapter registry and may change (a committee reorganises its website, GovInfo
 * changes a package id shape) without changing canonical cycle semantics.
 *
 * They also contain NO amounts. An expected source that never gets filed is
 * `not_filed`, never zero funding.
 */

import type {
  AuthorityTrack,
  BudgetComponent,
  Chamber,
  LifecycleStage,
  SourceFamily,
} from './types.js';

export const DEFENSE_BUDGET_CYCLE_TEMPLATE_VERSION = 'defense_budget_cycle_template_v1';

export interface ExpectedSourceTemplate {
  readonly sourceFamily: SourceFamily;
  readonly authorityTrack: AuthorityTrack;
  readonly stage: LifecycleStage;
  readonly chamber: Chamber;
  readonly committee: string | null;
  readonly component: BudgetComponent;
  /** Stable adapter id in the official-source adapter registry. */
  readonly adapterId: string;
  /** Human label template; `{FY}` is substituted with the fiscal year. */
  readonly label: string;
  /**
   * Expected publication window, in whole months relative to the start of the
   * fiscal year (1 October of `fiscalYear - 1`). Negative is before FY start.
   * Windows are advisory scheduling hints for the watcher, never assertions
   * that a document exists.
   */
  readonly windowFromMonths: number;
  readonly windowToMonths: number;
  /**
   * `true` when the source family only exists in some years (a supplemental, a
   * CR, a rescission). Absence of an optional family is `not_filed`; absence of
   * a required family past its window is a review-worthy gap. Neither is zero.
   */
  readonly optional: boolean;
}

const SERVICE_COMPONENTS: readonly Exclude<BudgetComponent, null>[] = Object.freeze([
  'ARMY',
  'NAVY',
  'AF',
  'SF',
  'DW',
]);

/** DoD exhibit families expected for every service component in a PB release. */
const PB_EXHIBIT_FAMILIES: readonly {
  family: SourceFamily;
  label: string;
  optional: boolean;
}[] = Object.freeze([
  { family: 'pb_r1', label: 'RDT&E R-1 programme element list', optional: false },
  { family: 'pb_r2', label: 'RDT&E R-2 exhibits', optional: false },
  { family: 'pb_r2a', label: 'RDT&E R-2A project exhibits', optional: false },
  { family: 'pb_r3', label: 'RDT&E R-3 cost analysis exhibits', optional: true },
  { family: 'pb_r4', label: 'RDT&E R-4/R-4A schedule exhibits', optional: true },
  { family: 'pb_p1', label: 'Procurement P-1 line list', optional: false },
  { family: 'pb_p_series', label: 'Procurement P-series detail exhibits', optional: false },
  { family: 'pb_o1', label: 'O&M O-1 summary', optional: false },
  { family: 'pb_op5', label: 'O&M OP-5 sub-activity exhibits', optional: false },
  { family: 'pb_milcon_c1', label: 'MILCON C-1 programme list', optional: true },
  { family: 'pb_dd1391', label: 'MILCON DD-1391 project documents', optional: true },
]);

function pbTemplates(): ExpectedSourceTemplate[] {
  const templates: ExpectedSourceTemplate[] = [
    {
      sourceFamily: 'pb_overview',
      authorityTrack: 'request',
      stage: 'president_budget_request',
      chamber: null,
      committee: null,
      component: null,
      adapterId: 'dod-comptroller',
      label: "FY{FY} President's Budget defence budget overview",
      windowFromMonths: -8,
      windowToMonths: -4,
      optional: false,
    },
  ];

  for (const component of SERVICE_COMPONENTS) {
    for (const exhibit of PB_EXHIBIT_FAMILIES) {
      // Defence-Wide MILCON DD-1391 detail is published unevenly; the R/P/O
      // families are the ones we hold every component to.
      templates.push({
        sourceFamily: exhibit.family,
        authorityTrack: 'request',
        stage: 'president_budget_request',
        chamber: null,
        committee: null,
        component,
        adapterId: componentAdapterId(component),
        label: `FY{FY} ${component} ${exhibit.label}`,
        windowFromMonths: -8,
        windowToMonths: -4,
        optional: exhibit.optional,
      });
    }
  }

  return templates;
}

function componentAdapterId(component: Exclude<BudgetComponent, null>): string {
  switch (component) {
    case 'ARMY':
      return 'army-budget';
    case 'NAVY':
    case 'USMC':
      return 'navy-budget';
    case 'AF':
    case 'SF':
      return 'saf-fm-budget';
    case 'DW':
      return 'dod-comptroller';
  }
}

const AUTHORIZATION_TEMPLATES: readonly ExpectedSourceTemplate[] = Object.freeze([
  {
    sourceFamily: 'auth_committee_mark',
    authorityTrack: 'authorization',
    stage: 'hasc_mark',
    chamber: 'house',
    committee: 'HASC',
    component: null,
    adapterId: 'hasc',
    label: 'FY{FY} HASC NDAA chairman mark',
    windowFromMonths: -5,
    windowToMonths: -2,
    optional: false,
  },
  {
    sourceFamily: 'auth_committee_report',
    authorityTrack: 'authorization',
    stage: 'hasc_report',
    chamber: 'house',
    committee: 'HASC',
    component: null,
    adapterId: 'govinfo-committee-reports',
    label: 'FY{FY} House Armed Services committee report',
    windowFromMonths: -4,
    windowToMonths: -1,
    optional: false,
  },
  {
    sourceFamily: 'auth_chamber_action',
    authorityTrack: 'authorization',
    stage: 'house_auth_action',
    chamber: 'house',
    committee: null,
    component: null,
    adapterId: 'govinfo-bills',
    label: 'FY{FY} House-passed NDAA text',
    windowFromMonths: -4,
    windowToMonths: 1,
    optional: false,
  },
  {
    sourceFamily: 'auth_committee_mark',
    authorityTrack: 'authorization',
    stage: 'sasc_mark',
    chamber: 'senate',
    committee: 'SASC',
    component: null,
    adapterId: 'sasc',
    label: 'FY{FY} SASC NDAA chairman mark',
    windowFromMonths: -5,
    windowToMonths: -2,
    optional: false,
  },
  {
    sourceFamily: 'auth_committee_report',
    authorityTrack: 'authorization',
    stage: 'sasc_report',
    chamber: 'senate',
    committee: 'SASC',
    component: null,
    adapterId: 'govinfo-committee-reports',
    label: 'FY{FY} Senate Armed Services committee report',
    windowFromMonths: -4,
    windowToMonths: -1,
    optional: false,
  },
  {
    sourceFamily: 'auth_chamber_action',
    authorityTrack: 'authorization',
    stage: 'senate_auth_action',
    chamber: 'senate',
    committee: null,
    component: null,
    adapterId: 'govinfo-bills',
    label: 'FY{FY} Senate-passed NDAA text',
    windowFromMonths: -4,
    windowToMonths: 2,
    optional: false,
  },
  {
    sourceFamily: 'auth_conference_report',
    authorityTrack: 'authorization',
    stage: 'auth_conference',
    chamber: 'joint',
    committee: null,
    component: null,
    adapterId: 'govinfo-committee-reports',
    label: 'FY{FY} NDAA conference report / joint explanatory statement',
    windowFromMonths: -2,
    windowToMonths: 3,
    optional: false,
  },
  {
    sourceFamily: 'auth_public_law',
    authorityTrack: 'authorization',
    stage: 'auth_enacted',
    chamber: null,
    committee: null,
    component: null,
    adapterId: 'govinfo-public-laws',
    label: 'FY{FY} NDAA public law',
    windowFromMonths: -1,
    windowToMonths: 4,
    optional: false,
  },
]);

const APPROPRIATIONS_TEMPLATES: readonly ExpectedSourceTemplate[] = Object.freeze([
  {
    sourceFamily: 'appr_committee_mark',
    authorityTrack: 'appropriations',
    stage: 'hac_d_mark',
    chamber: 'house',
    committee: 'HAC-D',
    component: null,
    adapterId: 'house-appropriations',
    label: 'FY{FY} HAC-Defense subcommittee mark',
    windowFromMonths: -5,
    windowToMonths: -1,
    optional: false,
  },
  {
    sourceFamily: 'appr_committee_report',
    authorityTrack: 'appropriations',
    stage: 'hac_d_report',
    chamber: 'house',
    committee: 'HAC-D',
    component: null,
    adapterId: 'govinfo-committee-reports',
    label: 'FY{FY} House Defense appropriations committee report',
    windowFromMonths: -4,
    windowToMonths: 0,
    optional: false,
  },
  {
    sourceFamily: 'appr_chamber_action',
    authorityTrack: 'appropriations',
    stage: 'house_appr_action',
    chamber: 'house',
    committee: null,
    component: null,
    adapterId: 'govinfo-bills',
    label: 'FY{FY} House-passed Defense appropriations text',
    windowFromMonths: -4,
    windowToMonths: 2,
    optional: false,
  },
  {
    sourceFamily: 'appr_committee_mark',
    authorityTrack: 'appropriations',
    stage: 'sac_d_mark',
    chamber: 'senate',
    committee: 'SAC-D',
    component: null,
    adapterId: 'senate-appropriations',
    label: 'FY{FY} SAC-Defense subcommittee mark',
    windowFromMonths: -5,
    windowToMonths: -1,
    optional: false,
  },
  {
    sourceFamily: 'appr_committee_report',
    authorityTrack: 'appropriations',
    stage: 'sac_d_report',
    chamber: 'senate',
    committee: 'SAC-D',
    component: null,
    adapterId: 'govinfo-committee-reports',
    label: 'FY{FY} Senate Defense appropriations committee report',
    windowFromMonths: -4,
    windowToMonths: 0,
    optional: false,
  },
  {
    sourceFamily: 'appr_chamber_action',
    authorityTrack: 'appropriations',
    stage: 'senate_appr_action',
    chamber: 'senate',
    committee: null,
    component: null,
    adapterId: 'govinfo-bills',
    label: 'FY{FY} Senate-passed Defense appropriations text',
    windowFromMonths: -4,
    windowToMonths: 3,
    optional: true,
  },
  {
    sourceFamily: 'appr_conference_jes',
    authorityTrack: 'appropriations',
    stage: 'appr_conference_or_jes',
    chamber: 'joint',
    committee: null,
    component: null,
    adapterId: 'govinfo-committee-reports',
    label: 'FY{FY} Defense appropriations conference report / JES',
    windowFromMonths: -1,
    windowToMonths: 6,
    optional: false,
  },
  {
    sourceFamily: 'appr_public_law',
    authorityTrack: 'appropriations',
    stage: 'appr_enacted',
    chamber: null,
    committee: null,
    component: null,
    adapterId: 'govinfo-public-laws',
    label: 'FY{FY} enacted Defense appropriations public law',
    windowFromMonths: 0,
    windowToMonths: 6,
    optional: false,
  },
]);

/**
 * Alternative funding never has a scheduled window: a supplemental or rescission
 * appears when it appears. Every entry is optional, and absence is `not_filed`.
 * These are NOT annual PE stages and are held on their own track.
 */
const ALTERNATIVE_FUNDING_TEMPLATES: readonly ExpectedSourceTemplate[] = Object.freeze([
  {
    sourceFamily: 'alt_continuing_resolution',
    authorityTrack: 'alternative_funding',
    stage: 'continuing_resolution',
    chamber: null,
    committee: null,
    component: null,
    adapterId: 'govinfo-public-laws',
    label: 'FY{FY} continuing resolution',
    windowFromMonths: -1,
    windowToMonths: 12,
    optional: true,
  },
  {
    sourceFamily: 'alt_supplemental',
    authorityTrack: 'alternative_funding',
    stage: 'supplemental',
    chamber: null,
    committee: null,
    component: null,
    adapterId: 'govinfo-public-laws',
    label: 'FY{FY} defence supplemental appropriation',
    windowFromMonths: -6,
    windowToMonths: 18,
    optional: true,
  },
  {
    sourceFamily: 'alt_supplemental',
    authorityTrack: 'alternative_funding',
    stage: 'emergency_supplemental',
    chamber: null,
    committee: null,
    component: null,
    adapterId: 'govinfo-public-laws',
    label: 'FY{FY} emergency defence supplemental appropriation',
    windowFromMonths: -6,
    windowToMonths: 18,
    optional: true,
  },
  {
    sourceFamily: 'alt_reconciliation',
    authorityTrack: 'alternative_funding',
    stage: 'reconciliation',
    chamber: null,
    committee: null,
    component: null,
    adapterId: 'govinfo-public-laws',
    label: 'FY{FY} reconciliation defence title',
    windowFromMonths: -12,
    windowToMonths: 18,
    optional: true,
  },
  {
    sourceFamily: 'alt_rescission',
    authorityTrack: 'alternative_funding',
    stage: 'rescission',
    chamber: null,
    committee: null,
    component: null,
    adapterId: 'govinfo-public-laws',
    label: 'FY{FY} defence rescission',
    windowFromMonths: 0,
    windowToMonths: 24,
    optional: true,
  },
  {
    sourceFamily: 'alt_transfer',
    authorityTrack: 'alternative_funding',
    stage: 'transfer',
    chamber: null,
    committee: null,
    component: null,
    adapterId: 'dod-comptroller-reprogramming',
    label: 'FY{FY} DoD transfer action',
    windowFromMonths: 0,
    windowToMonths: 24,
    optional: true,
  },
  {
    sourceFamily: 'alt_reprogramming',
    authorityTrack: 'alternative_funding',
    stage: 'reprogramming',
    chamber: null,
    committee: null,
    component: null,
    adapterId: 'dod-comptroller-reprogramming',
    label: 'FY{FY} DoD reprogramming action (DD-1415)',
    windowFromMonths: 0,
    windowToMonths: 24,
    optional: true,
  },
]);

/**
 * Execution coverage is deliberately thin: Session 7 only claims the families
 * for which an official public source exists. Award/obligation detail beyond a
 * reference is a later session's problem.
 */
const EXECUTION_TEMPLATES: readonly ExpectedSourceTemplate[] = Object.freeze([
  {
    sourceFamily: 'exec_allocation',
    authorityTrack: 'execution',
    stage: 'allocation',
    chamber: null,
    committee: null,
    component: null,
    adapterId: 'dod-comptroller',
    label: 'FY{FY} DoD allocation / spend plan release',
    windowFromMonths: 0,
    windowToMonths: 12,
    optional: true,
  },
  {
    sourceFamily: 'exec_obligation',
    authorityTrack: 'execution',
    stage: 'obligation',
    chamber: null,
    committee: null,
    component: null,
    adapterId: 'dod-comptroller',
    label: 'FY{FY} obligation status report',
    windowFromMonths: 3,
    windowToMonths: 24,
    optional: true,
  },
  {
    sourceFamily: 'exec_award',
    authorityTrack: 'execution',
    stage: 'award',
    chamber: null,
    committee: null,
    component: null,
    adapterId: 'dod-contract-announcements',
    label: 'FY{FY} award signal / reference',
    windowFromMonths: 0,
    windowToMonths: 24,
    optional: true,
  },
]);

export interface DefenseBudgetCycleTemplate {
  readonly templateVersion: string;
  readonly entries: readonly ExpectedSourceTemplate[];
}

export const DEFENSE_BUDGET_CYCLE_TEMPLATE_V1: DefenseBudgetCycleTemplate = Object.freeze({
  templateVersion: DEFENSE_BUDGET_CYCLE_TEMPLATE_VERSION,
  entries: Object.freeze([
    ...pbTemplates(),
    ...AUTHORIZATION_TEMPLATES,
    ...APPROPRIATIONS_TEMPLATES,
    ...ALTERNATIVE_FUNDING_TEMPLATES,
    ...EXECUTION_TEMPLATES,
  ]),
});

const TEMPLATE_REGISTRY: Readonly<Record<string, DefenseBudgetCycleTemplate>> = Object.freeze({
  [DEFENSE_BUDGET_CYCLE_TEMPLATE_VERSION]: DEFENSE_BUDGET_CYCLE_TEMPLATE_V1,
});

export class UnknownCycleTemplateVersionError extends Error {
  constructor(readonly templateVersion: string) {
    super(`Unknown defense budget cycle template version: ${templateVersion}`);
    this.name = 'UnknownCycleTemplateVersionError';
  }
}

export function resolveCycleTemplate(
  templateVersion: string = DEFENSE_BUDGET_CYCLE_TEMPLATE_VERSION,
): DefenseBudgetCycleTemplate {
  const template = TEMPLATE_REGISTRY[templateVersion];
  if (!template) throw new UnknownCycleTemplateVersionError(templateVersion);
  return template;
}

export function cycleTemplateVersions(): readonly string[] {
  return Object.freeze(Object.keys(TEMPLATE_REGISTRY));
}
