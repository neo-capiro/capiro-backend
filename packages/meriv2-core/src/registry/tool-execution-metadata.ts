import type { RiskTier } from '@capiro/shared';

export type ToolExecutionMode = 'read' | 'immediate_internal' | 'approval_required' | 'blocked';

export type ToolExternalEffect =
  | 'none'
  | 'internal_artifact'
  | 'memory_mutation'
  | 'crm_mutation'
  | 'external_send'
  | 'standing_automation';

export interface ToolExecutionMetadata {
  name: string;
  readOnly: boolean;
  executionMode: ToolExecutionMode;
  externalEffect: ToolExternalEffect;
  reversible: boolean;
  riskTier: RiskTier;
  displayVerb: string;
}

const IMMEDIATE_INTERNAL = new Set([
  'save_note',
  'save_memory',
  'create_word',
  'create_excel',
  'create_powerpoint',
  'create_meeting_brief',
  'draft_policy_memo',
]);

const EXTERNAL_SEND = new Set(['send_email', 'reply_email']);
const CRM_MUTATION = new Set([
  'create_client',
  'update_client_profile',
  'create_task',
  'update_task',
]);
const STANDING_AUTOMATION = new Set(['schedule_task', 'cancel_scheduled_task']);
const MEMORY_MUTATION = new Set([
  'save_memory',
  'confirm_memory',
  'correct_memory',
  'forget_memory',
]);

const DISPLAY_VERBS: Readonly<Record<string, string>> = {
  send_email: 'Send email',
  reply_email: 'Reply to email',
  create_client: 'Create client',
  update_client_profile: 'Update client profile',
  create_task: 'Create task',
  update_task: 'Update task',
  schedule_task: 'Schedule automation',
  cancel_scheduled_task: 'Cancel automation',
  save_note: 'Save note',
  save_memory: 'Remember',
  confirm_memory: 'Confirm memory',
  correct_memory: 'Correct memory',
  forget_memory: 'Forget memory',
  create_word: 'Create Word document',
  create_excel: 'Create workbook',
  create_powerpoint: 'Create presentation',
  create_meeting_brief: 'Create meeting brief',
  draft_policy_memo: 'Draft policy memo',
};

/**
 * The single execution-semantics source consumed by registry, compliance,
 * prompts, approval labels, scheduling, and audit classification.
 * Unknown writes fail safe to approval_required/high risk.
 */
export function toolExecutionMetadataFor(name: string, readOnly: boolean): ToolExecutionMetadata {
  if (readOnly) {
    return {
      name,
      readOnly: true,
      executionMode: 'read',
      externalEffect: 'none',
      reversible: true,
      riskTier: 'low',
      displayVerb: DISPLAY_VERBS[name] ?? humanizeToolName(name),
    };
  }

  const externalEffect: ToolExternalEffect = EXTERNAL_SEND.has(name)
    ? 'external_send'
    : CRM_MUTATION.has(name)
      ? 'crm_mutation'
      : STANDING_AUTOMATION.has(name)
        ? 'standing_automation'
        : MEMORY_MUTATION.has(name)
          ? 'memory_mutation'
          : 'internal_artifact';
  const executionMode: ToolExecutionMode = IMMEDIATE_INTERNAL.has(name)
    ? 'immediate_internal'
    : 'approval_required';
  const riskTier: RiskTier = EXTERNAL_SEND.has(name)
    ? 'restricted'
    : executionMode === 'approval_required'
      ? 'high'
      : 'low';
  const reversible = !EXTERNAL_SEND.has(name) && !STANDING_AUTOMATION.has(name);

  return {
    name,
    readOnly: false,
    executionMode,
    externalEffect,
    reversible,
    riskTier,
    displayVerb: DISPLAY_VERBS[name] ?? humanizeToolName(name),
  };
}

export function actionBehaviorPrompt(
  tools: readonly Pick<ToolExecutionMetadata, 'name' | 'executionMode' | 'displayVerb'>[],
): string {
  const writes = tools.filter((tool) => tool.executionMode !== 'read');
  if (!writes.length) return 'Every available tool is read-only and cannot change Capiro data.';
  const immediate = writes.filter((tool) => tool.executionMode === 'immediate_internal');
  const approval = writes.filter((tool) => tool.executionMode === 'approval_required');
  const blocked = writes.filter((tool) => tool.executionMode === 'blocked');
  const lines = [
    'Tool action behavior is defined by runtime policy:',
    immediate.length
      ? `- Runs immediately as an internal reversible action: ${immediate.map(formatTool).join(', ')}.`
      : '',
    approval.length
      ? `- Creates a proposal and waits for explicit approval before execution: ${approval.map(formatTool).join(', ')}.`
      : '',
    blocked.length ? `- Blocked by policy: ${blocked.map(formatTool).join(', ')}.` : '',
    '- Never tell the user an approval-required action already ran. Report the proposal state and exact next step.',
  ];
  return lines.filter(Boolean).join('\n');
}

function formatTool(tool: Pick<ToolExecutionMetadata, 'name' | 'displayVerb'>): string {
  return `${tool.displayVerb} (${tool.name})`;
}

function humanizeToolName(name: string): string {
  return name
    .split('_')
    .filter(Boolean)
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join(' ');
}
