import { isReadOnlyResearchPortfolioManagementAction } from '../research-portfolios/research-portfolio-management.js';
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
  update_scheduled_task: 'Pause, resume, or run a scheduled task',
  confirm_memory: 'Confirm memory',
  correct_memory: 'Correct memory',
  forget_memory: 'Forget memory',
  save_note: 'Save note',
  save_chat_attachments: 'Save documents to client',
  save_memory: 'Save memory',
  create_word: 'Create Word document',
  create_excel: 'Create spreadsheet',
  create_powerpoint: 'Create presentation',
  create_meeting_brief: 'Create meeting brief',
  draft_policy_memo: 'Draft policy memo',
  publish_research_portfolio_share_link: 'Publish client share link',
  revoke_research_portfolio_share_link: 'Revoke client share link',
  manage_research_portfolio: 'Run a Research Portfolio management action',
  create_research_portfolio_snapshot: 'Create a Research Portfolio snapshot',
  request_research_portfolio_output: 'Request a Research Portfolio CSV output',
  save_research_portfolio_output_to_client: 'Save a Research Portfolio output to Client Files',
  watch_research_portfolio: 'Watch this Research Portfolio',
  update_research_portfolio_change_state: 'Update a Research Portfolio change state',
  create_research_portfolio_bookmark: 'Bookmark a Research Portfolio item',
  add_research_portfolio_review_note: 'Add a Research Portfolio review note',
  prepare_research_portfolio_brief: 'Prepare a Research Portfolio brief draft',
  prepare_research_portfolio_meeting: 'Prepare a Research Portfolio meeting draft',
};

/** Bounded, display-only facts of the ten MO-05 Research Portfolio actions; keys and body text stay server-side. */
const RESEARCH_PORTFOLIO_ACTION_FIELDS: Record<string, readonly string[]> = {
  manage_research_portfolio: ['action'],
  create_research_portfolio_snapshot: ['name', 'expectedRevision'],
  request_research_portfolio_output: ['snapshotId'],
  save_research_portfolio_output_to_client: ['outputId', 'clientId'],
  watch_research_portfolio: [],
  update_research_portfolio_change_state: ['eventId', 'action', 'expectedRevision'],
  create_research_portfolio_bookmark: ['targetKind', 'targetId', 'label'],
  add_research_portfolio_review_note: ['reviewId', 'expectedRevision'],
  prepare_research_portfolio_brief: [],
  prepare_research_portfolio_meeting: ['meetingId'],
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

  if (tool === 'publish_research_portfolio_share_link') {
    for (const key of [
      'snapshotId',
      'designId',
      'clientId',
      'branding',
      'previewHash',
      'expectedDesignVersion',
    ])
      addField(fields, key, input[key]);
    fields.expiresAfterHours = 168;
    fields.delivery = 'You copy the link and share it yourself. Nothing is sent.';
  } else if (tool === 'revoke_research_portfolio_share_link') {
    addField(fields, 'linkId', input.linkId);
    fields.effect = 'This link will stop working on the next request.';
  } else if (Object.hasOwn(RESEARCH_PORTFOLIO_ACTION_FIELDS, tool)) {
    for (const key of RESEARCH_PORTFOLIO_ACTION_FIELDS[tool] ?? [])
      addField(fields, key, input[key]);
    if (tool === 'prepare_research_portfolio_meeting' && Array.isArray(input.selectedReviewIds))
      counts.selectedReviews = input.selectedReviewIds.length;
    if (
      tool === 'manage_research_portfolio' &&
      input.parameters &&
      typeof input.parameters === 'object'
    )
      counts.parameters = Object.keys(input.parameters as Record<string, unknown>).length;
    fields.effect =
      tool === 'prepare_research_portfolio_brief' || tool === 'prepare_research_portfolio_meeting'
        ? 'An owner-private, unreviewed editable draft is created. Nothing is sent.'
        : tool === 'manage_research_portfolio' &&
            isReadOnlyResearchPortfolioManagementAction(input.action)
          ? 'Read the current Research Portfolio. Nothing is changed.'
          : 'Core applies this action once to the current Research Portfolio after you confirm.';
  }

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
    'localTime',
    'timeZone',
    'weekday',
    'deliverEmailTo',
    'emailBriefing',
    'scope',
    'memoryItemId',
    'action',
  ]) {
    const value = input[key];
    if (Array.isArray(value)) {
      const visible = value
        .filter((entry) => typeof entry === 'string')
        .slice(0, 10)
        .join(', ');
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
  if (tool === 'save_chat_attachments' && Array.isArray(input.attachmentIds)) {
    counts.attachments = new Set(
      input.attachmentIds.filter((id): id is string => typeof id === 'string' && !!id.trim()),
    ).size;
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
    label:
      tool === 'create_word' && input.format === 'pdf'
        ? 'Create PDF document'
        : (TOOL_LABELS[tool] ?? `Run ${tool}`),
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
