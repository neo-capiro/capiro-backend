/**
 * Canonical context-pack template vocabulary and deterministic report metadata.
 * Parser, validation, audience policy, heading precedence and rendering remain
 * with their existing owners. These values intentionally retain plain mutable
 * runtime containers; `as const` and Readonly describe the TypeScript contract.
 */
import type { ReportNarrativeSectionKey } from '../reports/report.types.js';

/** The 17 known document types, in template-pack order (00..16). */
export const DOCUMENT_TYPES = [
  'context_manifest',
  'strategy_brief',
  'client_constraints',
  'ask_and_options',
  'stakeholder_map',
  'calendar_and_deadlines',
  'decision_rules',
  'current_plan',
  'evidence_register',
  'meeting_intelligence',
  'decision_log',
  'agent_mission',
  'execution_playbook',
  'agent_permissions',
  'target_budget_line',
  'vendor_reference_pull',
  'route_and_vehicle_status',
] as const;
export type DocumentTypeValue = (typeof DOCUMENT_TYPES)[number];

/** document_type -> SpContextDocument.templateKey (the NN_name file stem). */
export const TEMPLATE_KEY_BY_TYPE: Readonly<Record<DocumentTypeValue, string>> = {
  context_manifest: '00_context_manifest',
  strategy_brief: '01_strategy_brief',
  client_constraints: '02_client_constraints',
  ask_and_options: '03_ask_and_options',
  stakeholder_map: '04_stakeholder_map',
  calendar_and_deadlines: '05_calendar_and_deadlines',
  decision_rules: '06_decision_rules',
  current_plan: '07_current_plan',
  evidence_register: '08_evidence_register',
  meeting_intelligence: '09_meeting_intelligence',
  decision_log: '10_decision_log',
  agent_mission: '11_agent_mission',
  execution_playbook: '12_execution_playbook',
  agent_permissions: '13_agent_permissions',
  target_budget_line: '14_target_budget_line',
  vendor_reference_pull: '15_vendor_reference_pull',
  route_and_vehicle_status: '16_route_and_vehicle_status',
};

export const OPERATIONAL_REPORT_TEMPLATE_KEYS = new Set([
  '00_context_manifest',
  '07_current_plan',
  '11_agent_mission',
  '12_execution_playbook',
  '13_agent_permissions',
]);

export const REPORT_SECTION_TITLES: Record<ReportNarrativeSectionKey, string> = {
  situation: 'Situation and stakes',
  outcomes: 'Objectives and definition of success',
  ask: 'Strategic ask and options',
  stakeholders: 'Stakeholder landscape',
  constraints: 'Constraints and decision rules',
  timing: 'Timing and external windows',
  evidence: 'Evidence and assumptions',
  decisions: 'Decisions and commitments',
  intelligence: 'Recent intelligence',
  governance: 'Internal operating guidance',
};

export const REPORT_SECTION_ORDER: ReportNarrativeSectionKey[] = [
  'situation',
  'outcomes',
  'ask',
  'stakeholders',
  'constraints',
  'timing',
  'decisions',
  'intelligence',
  'evidence',
  'governance',
];

/** Prefix order matches the existing report fallback, including 02 before 06. */
export const REPORT_PREFIX_FALLBACKS = [
  { prefix: '01_', section: 'situation' },
  { prefix: '02_', section: 'constraints' },
  { prefix: '06_', section: 'constraints' },
  { prefix: '03_', section: 'ask' },
  { prefix: '04_', section: 'stakeholders' },
  { prefix: '05_', section: 'timing' },
  { prefix: '08_', section: 'evidence' },
  { prefix: '09_', section: 'intelligence' },
  { prefix: '10_', section: 'decisions' },
] as const;

/** Exact membership: no prefix matching, coercion or normalization. */
export function isOperationalReportTemplate(templateKey: string): boolean {
  return OPERATIONAL_REPORT_TEMPLATE_KEYS.has(templateKey);
}

/** Existing prefix fallback; heading precedence belongs to report-context. */
export function reportFallbackSection(templateKey: string): ReportNarrativeSectionKey {
  for (const { prefix, section } of REPORT_PREFIX_FALLBACKS) {
    if (templateKey.startsWith(prefix)) return section;
  }
  return 'governance';
}
