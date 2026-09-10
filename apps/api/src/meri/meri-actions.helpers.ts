/**
 * Action classification + audit for Meri's workflow-native tools (P2-5).
 *
 * Meri can take real actions (send/reply email, save note, save memory, draft
 * memo, create meeting brief). The user's write-mode toggle is the up-front
 * confirmation; this module classifies which tool calls are side-effecting so
 * the service can AUDIT every action it takes (persisted on the message +
 * structured log) — accountability for "Meri that does things". Pure, so it
 * unit-tests under `src/**.spec.ts`.
 */

export type ToolActionKind = 'read' | 'write' | 'send';

const SEND_TOOLS = new Set(['send_email', 'reply_email']);
const WRITE_TOOLS = new Set([
  'save_note',
  'save_chat_attachments',
  'save_memory',
  'draft_policy_memo',
  'create_meeting_brief',
  'create_word',
  'create_excel',
  'create_powerpoint',
  'schedule_task',
  'cancel_scheduled_task',
  'create_task',
  'update_task',
]);

export function classifyToolAction(tool: string): ToolActionKind {
  if (SEND_TOOLS.has(tool)) return 'send';
  if (WRITE_TOOLS.has(tool)) return 'write';
  return 'read';
}

/** True for any tool that changes state or sends something (non read-only). */
export function isSideEffectingTool(tool: string): boolean {
  return classifyToolAction(tool) !== 'read';
}

const VERBS: Record<string, string> = {
  send_email: 'sent an email',
  reply_email: 'replied to an email',
  save_note: 'saved a note',
  save_chat_attachments: 'filed documents under a client',
  save_memory: 'updated memory',
  draft_policy_memo: 'drafted a policy memo',
  create_meeting_brief: 'created a meeting brief',
  create_word: 'generated a document',
  create_excel: 'generated an Excel workbook',
  create_powerpoint: 'generated a PowerPoint deck',
  schedule_task: 'scheduled a recurring task',
  cancel_scheduled_task: 'canceled a scheduled task',
  create_task: 'created an engagement task',
  update_task: 'updated an engagement task',
};

/** Human-readable past-tense description of an action, for surfacing/audit. */
export function actionVerb(tool: string): string {
  return VERBS[tool] ?? `ran ${tool}`;
}
