export interface MeriActionPreview {
  label: string;
  riskTier: string | null;
  leavesFirm: boolean;
  reversible: boolean;
  client?: { id: string; name?: string };
  fields: Record<string, string | number | boolean>;
  counts: Record<string, number>;
  reason: string;
}

const TOOL_LABELS: Record<string, string> = {
  send_email: 'Send email',
  reply_email: 'Reply to email',
  create_client: 'Create client',
  update_client_profile: 'Update client profile',
  create_task: 'Create task',
  update_task: 'Update task',
  schedule_task: 'Schedule recurring task',
  cancel_scheduled_task: 'Cancel scheduled task',
  confirm_memory: 'Confirm memory',
  correct_memory: 'Correct memory',
  forget_memory: 'Forget memory',
  save_note: 'Save note',
  save_memory: 'Save memory',
  create_word: 'Create Word document',
  create_excel: 'Create spreadsheet',
  create_powerpoint: 'Create presentation',
  create_meeting_brief: 'Create meeting brief',
  draft_policy_memo: 'Draft policy memo',
};

function short(value: unknown, max = 240): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (!normalized) return undefined;
  return normalized.length <= max ? normalized : `${normalized.slice(0, max - 1)}…`;
}

function addField(
  target: Record<string, string | number | boolean>,
  key: string,
  value: unknown,
): void {
  if (typeof value === 'boolean' || typeof value === 'number') {
    target[key] = value;
    return;
  }
  const text = short(value);
  if (text) target[key] = text;
}

/** Display-only informed-consent summary. It is never fed back into execution. */
export function buildMeriActionPreview(args: {
  tool: string;
  input: Record<string, unknown>;
  riskTier?: string | null;
  reason: string;
  clientName?: string | null;
}): MeriActionPreview {
  const { tool, input } = args;
  const fields: Record<string, string | number | boolean> = {};
  const counts: Record<string, number> = {};

  for (const key of [
    'to',
    'cc',
    'bcc',
    'subject',
    'title',
    'name',
    'dueDate',
    'startsAt',
    'endsAt',
    'cadence',
    'destination',
    'intervalMinutes',
    'scope',
    'memoryItemId',
  ]) {
    const value = input[key];
    if (Array.isArray(value)) {
      const visible = value.filter((entry) => typeof entry === 'string').slice(0, 10).join(', ');
      if (visible) fields[key] = short(visible, 320) ?? visible;
    } else {
      addField(fields, key, value);
    }
  }

  for (const key of ['people', 'facilities', 'capabilities', 'recipients', 'attachments']) {
    if (Array.isArray(input[key])) counts[key] = input[key].length;
  }
  if (input.fields && typeof input.fields === 'object' && !Array.isArray(input.fields)) {
    counts.profileFields = Object.keys(input.fields as Record<string, unknown>).length;
  }

  const clientId = typeof input.clientId === 'string' ? input.clientId : undefined;
  const leavesFirm = tool === 'send_email' || tool === 'reply_email';
  const irreversible = leavesFirm || tool === 'forget_memory';

  return {
    label: TOOL_LABELS[tool] ?? `Run ${tool}`,
    riskTier: args.riskTier ?? null,
    leavesFirm,
    reversible: !irreversible,
    ...(clientId
      ? { client: { id: clientId, ...(args.clientName ? { name: args.clientName } : {}) } }
      : {}),
    fields,
    counts,
    reason: short(args.reason, 500) ?? 'This action requires explicit approval.',
  };
}
