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

const PROFILE_FIELD_KEYS = [
  'name',
  'website',
  'description',
  'productDescription',
  'primaryContactName',
  'primaryContactEmail',
  'primaryContactPhone',
  'sectorTag',
  'issueCodes',
  'uei',
  'cageCode',
  'naicsCodes',
  'pscCodes',
] as const;

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

function profileFieldNames(input: Record<string, unknown>): string[] {
  return PROFILE_FIELD_KEYS.filter((key) => {
    const value = input[key];
    if (value === null || value === undefined) return false;
    if (typeof value === 'string') return value.trim().length > 0;
    if (Array.isArray(value)) return value.length > 0;
    return true;
  });
}

/**
 * Display-only informed-consent summary. It is never fed back into execution.
 * The preview is deliberately allowlisted and bounded: no raw input JSON,
 * credentials, attachment bodies, or full outbound message bodies reach the UI.
 */
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
    'dailyAtUtc',
    'deliverEmailTo',
    'emailBriefing',
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

  // Outbound content is sensitive. Show a bounded, whitespace-normalized preview
  // only after the user explicitly expands it; never ship the full body in the
  // preview contract. The immutable encrypted/persisted proposal remains the
  // execution authority on the server.
  if (tool === 'send_email' || tool === 'reply_email') {
    const body = typeof input.body === 'string' ? input.body : '';
    const bodyPreview = short(body, 500);
    if (bodyPreview) fields.bodyPreview = bodyPreview;
    fields.bodyCharacters = body.length;
  }

  for (const key of ['people', 'facilities', 'capabilities', 'recipients', 'attachments']) {
    if (Array.isArray(input[key])) counts[key] = input[key].length;
  }

  if (tool === 'update_client_profile') {
    const changed = profileFieldNames(input);
    if (changed.length) {
      fields.changedFields = short(changed.join(', '), 500) ?? changed.join(', ');
      counts.profileFields = changed.length;
    }
  } else if (input.fields && typeof input.fields === 'object' && !Array.isArray(input.fields)) {
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
