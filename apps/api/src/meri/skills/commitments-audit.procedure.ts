import type { MeriProcedureCapability, MeriProcedureManifest, MeriSkill } from './skill.types.js';

/**
 * H5 adaptation provenance:
 * - NousResearch/hermes-agent@516535b54275e963a82b4c28f866338fb768e7bc
 * - skills/productivity/meeting-action-items/SKILL.md
 * - skills/productivity/document-to-action-items/SKILL.md
 *
 * The procedure below adapts evidence classification, cited commitments,
 * unresolved owner/date handling, and modality preservation. It does not copy
 * scripts or an execution engine. Upstream is MIT (Copyright 2025 Nous
 * Research); the per-slice notice/test disposition is recorded in the P1B
 * evidence report.
 */

export const COMMITMENTS_AUDIT_STATUSES = [
  'completed',
  'in progress',
  'no record of action',
] as const;

export const COMMITMENTS_AUDIT_COVERAGE_STATES = [
  'checked',
  'disconnected',
  'unavailable',
  'not mapped',
] as const;

export const COMMITMENTS_AUDIT_CAPABILITIES = [
  'client.read',
  'mail.read',
  'meetings.read',
  'debriefs.read',
  'tasks.read',
  'action_items.read',
  'documents.read',
  'monday.read',
] as const satisfies readonly MeriProcedureCapability[];

export const commitmentsAuditManifest: MeriProcedureManifest = {
  purpose:
    'Audit client commitments and deliverables from authorized evidence without creating tasks, messages, or memory.',
  scopes: ['general', 'client'],
  evidencePrerequisites: [
    'A selected and authorized client before execution',
    'The requested audit window and any explicitly supplied Monday board ID or link',
    'Authorized mail, meetings or transcripts, debriefs, native tasks, action items, relevant documents, and mapped or explicitly supplied Monday boards',
    'Source locators, source versions, pagination, access outcomes, and coverage limits',
  ],
  allowedCapabilities: [...COMMITMENTS_AUDIT_CAPABILITIES],
  output: {
    fields: [
      'source',
      'sourceVersion',
      'locator',
      'observedAt',
      'promise',
      'madeAt',
      'madeWhere',
      'owner',
      'dueDate',
      'dependency',
      'acceptance',
      'linkedRecordId',
      'nativeStatus',
      'proposedFollowUp',
      'auditStatus',
      'citations',
    ],
    statuses: [...COMMITMENTS_AUDIT_STATUSES],
    coverageStates: [...COMMITMENTS_AUDIT_COVERAGE_STATES],
    unknownValue: 'unknown',
    preserveModality: true,
    honorRequestedWindow: true,
    defaultRecentWindowDays: null,
    reportPartialCoverage: true,
  },
  completion: [
    'Separate evidenced promises from decisions, proposals, questions, blockers, and suggestions',
    'Deduplicate repeated promises while retaining citations and any existing record ID',
    'Require delivery or acceptance evidence for completed; task existence or an unverified done comment is insufficient',
    'Flag mail or meeting promises without a corresponding tracked task or action item',
    'Report every source coverage state, partial page, authorization failure, and budget-limited continuation',
    'Exclude unrelated personal, other-client, and unauthorized board content',
    'Return no task, message, memory, or other external effect',
  ],
  effectPolicy: {
    mode: 'read_only',
    prohibitedEffects: ['create or update a task', 'send a message', 'write memory'],
  },
  examples: [
    'A suggestion using may is not a confirmed obligation; preserve the original modality.',
    'When no source evidences an owner or due date, return owner: unknown and dueDate: unknown.',
    'An active task without delivery evidence is in progress, not completed.',
  ],
  caseIds: ['CD-01', 'CD-02', 'CD-03', 'CD-04', 'CD-05', 'CD-06', 'CD-07'],
};

/**
 * Canonical seed/update payload for the existing versioned firm-skill service.
 * It is intentionally not appended to CLIO_SKILLS: the six built-ins and their
 * precedence remain unchanged, and served Quick Action hookup is a separate
 * owner-controlled integration.
 */
export const commitmentsAuditProcedureSkill: MeriSkill = {
  id: 'commitments_audit',
  name: 'Commitments & Deliverables',
  triggers: ['commitments_audit'],
  systemAddendum:
    'Audit every evidenced commitment for the selected client across authorized mail, meetings/transcripts, debriefs, native tasks, action items, relevant documents, and mapped or explicitly supplied authorized Monday boards. Distinguish promises from proposals, suggestions, questions, and blockers; preserve may/should/must modality. Deduplicate repeated promises and retain citations and an existing record ID. Report what was promised, when and where, evidenced owner and due date or unknown, dependency, acceptance evidence, native status, follow-up, and exactly one audit status: completed, in progress, or no record of action. Completion requires delivery or acceptance evidence. Honor the requested window without a recent-only default; report pagination and all coverage limits. Monday coverage is checked, disconnected, unavailable, or not mapped. Exclude personal, other-client, and unauthorized content. This audit is read-only and creates no task, message, memory, or other effect.',
  requiredTools: [
    'get_client_context',
    'list_emails',
    'search_emails',
    'get_email_thread',
    'query_tasks',
    'query_action_items',
    'query_debriefs',
    'read_client_documents',
    'search_capiro_data',
  ],
  template: {
    heading: 'Commitments & Deliverables',
    sections: ['Audit Window', 'Source Coverage', 'Commitments', 'Untracked Promises', 'Follow-Up'],
  },
  procedure: commitmentsAuditManifest,
};
