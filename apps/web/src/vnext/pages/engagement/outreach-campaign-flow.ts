/**
 * The Outreach campaign builder's step machine.
 *
 * This is a direct port of the Engagement V2 prototype's live wizard
 * (`wizardVals()` in the prototype's design-canvas script). It replaces the
 * earlier canonical model — `goal · targets · delivery · context · examples ·
 * drafts · send` — which the prototype does not have: that shape lived in
 * `outreachVals()`, a method whose keys the prototype's markup never binds.
 * See docs/engagement-vnext/OUTREACH-PROTOTYPE-PARITY.md.
 *
 * Everything here is pure so the ordering, the Format-step exemption and every
 * button label can be asserted without rendering.
 */

export type OutreachCampaignType = 'request_meeting' | 'send_update' | 'custom';

export type OutreachBuilderStep =
  | 'workflow'
  | 'name'
  | 'update'
  | 'format'
  | 'targets'
  | 'context'
  | 'review'
  | 'drafts'
  | 'send';

export interface OutreachCampaignTypeOption {
  id: OutreachCampaignType;
  label: string;
  description: string;
}

/**
 * The three campaign types, in the prototype's order. `label` is what the
 * "Continue with …" button interpolates, so it is the user-facing name of the
 * type everywhere, not a separate title field.
 */
export const OUTREACH_CAMPAIGN_TYPES: OutreachCampaignTypeOption[] = [
  {
    id: 'request_meeting',
    label: 'Request a meeting',
    description:
      'Ask an office for a focused staff briefing. Its builder adds an explicit ask to every draft and reads meeting history first.',
  },
  {
    id: 'send_update',
    label: 'Send update',
    description:
      'Tell stakeholders what changed and what it means for them. Its builder adds no ask unless you write one.',
  },
  {
    id: 'custom',
    label: 'Custom',
    description:
      'Describe the campaign in prose. Its builder asks for the purpose before anything is written.',
  },
];

export function outreachCampaignTypeLabel(type: OutreachCampaignType): string {
  return OUTREACH_CAMPAIGN_TYPES.find((option) => option.id === type)?.label ?? 'Send update';
}

/**
 * The template step's rail label, which changes with the campaign type. Custom
 * has no fixed template set, so it gets the bare noun.
 */
export function outreachTemplateStepLabel(type: OutreachCampaignType): string {
  if (type === 'request_meeting') return 'Request template';
  if (type === 'send_update') return 'Update template';
  return 'Template';
}

/**
 * Meeting requests always send as standard email, so they have no Format step.
 *
 * Custom keeps it. That is not an oversight in the prototype: a custom campaign
 * still writes a letter that has to be laid out, it just has no template set to
 * pick a structure from — hence the empty Template step with an explainer, and
 * a live Format step after it.
 */
export function outreachSkipsFormatStep(type: OutreachCampaignType): boolean {
  return type === 'request_meeting';
}

export interface OutreachBuilderStepDef {
  key: OutreachBuilderStep;
  label: string;
}

/** The ordered step list for a campaign type: nine steps, or eight without Format. */
export function outreachBuilderSteps(type: OutreachCampaignType): OutreachBuilderStepDef[] {
  return [
    { key: 'workflow', label: 'Campaign type' },
    { key: 'name', label: 'Name' },
    { key: 'update', label: outreachTemplateStepLabel(type) },
    ...(outreachSkipsFormatStep(type)
      ? []
      : [{ key: 'format' as const, label: 'Format' }]),
    { key: 'targets', label: 'Targets' },
    { key: 'context', label: 'Context' },
    { key: 'review', label: 'Review' },
    { key: 'drafts', label: 'Drafts' },
    { key: 'send', label: 'Send' },
  ];
}

/**
 * How many of the steps are "setup" — the numbered chips before the rail's
 * divider. The last three (Review · Drafts · Send) are always un-numbered.
 */
export function outreachBuilderSetupCount(type: OutreachCampaignType): number {
  return outreachBuilderSteps(type).length - 3;
}

/**
 * Repair a step that the current campaign type does not have.
 *
 * Switching to "Request a meeting" while standing on Format must not leave the
 * builder on a step with no rail chip. The prototype resolves it forward to
 * Targets rather than back to the template step, so the user keeps their place
 * in the sequence.
 */
export function resolveOutreachBuilderStep(
  type: OutreachCampaignType,
  requested: OutreachBuilderStep,
): OutreachBuilderStep {
  if (requested === 'format' && outreachSkipsFormatStep(type)) return 'targets';
  return requested;
}

export function outreachBuilderStepIndex(
  type: OutreachCampaignType,
  step: OutreachBuilderStep,
): number {
  const index = outreachBuilderSteps(type).findIndex((def) => def.key === step);
  return index < 0 ? 0 : index;
}

/** The step the primary button advances to, or `null` on the last step. */
export function outreachBuilderNextStep(
  type: OutreachCampaignType,
  step: OutreachBuilderStep,
): OutreachBuilderStep | null {
  const steps = outreachBuilderSteps(type);
  const index = steps.findIndex((def) => def.key === step);
  if (index < 0) return null;
  return steps[index + 1]?.key ?? null;
}

export const OUTREACH_BUILDER_STEP_TITLES: Record<OutreachBuilderStep, string> = {
  workflow: 'What kind of campaign is this?',
  name: 'Name the campaign',
  update: 'Choose a template',
  format: 'Choose the email format',
  targets: 'Choose the people and offices to contact',
  context: 'Choose the context Capiro may use',
  review: 'Review the packet before anything is written',
  drafts: 'Review one draft per recipient',
  send: 'Before this goes out',
};

export const OUTREACH_BUILDER_STEP_SUBLINES: Record<OutreachBuilderStep, string> = {
  workflow:
    'Each campaign type has its own builder workflow — it decides the shape of every draft and which context Capiro reads.',
  name: 'The campaign name is the subject line recipients see, not an internal label.',
  update:
    'Pick the structure Meri should follow. Preview a sample before choosing — the sample is a reference for structure and tone only, never data that gets copied into your draft.',
  format:
    'Presentation only. The words come from the template you picked — format changes how they are laid out.',
  targets:
    'Browsing the Directory is a read. Adding a target stores a locator; Capiro re-resolves the person server-side before any draft or send.',
  context:
    'Only what you switch on can reach a draft. Recipient-specific context reaches that person and no one else.',
  review:
    'Nothing is generated until you accept this packet. Add a personal note for anyone who needs one.',
  drafts:
    'Each draft is an immutable version. Editing creates a new version; approval is pinned to the exact version you read.',
  send:
    'Read what will happen, test it on yourself, then run fresh checks. Capiro creates one durable send record.',
};

/**
 * The prototype names Untitled UI icons; this module names the lucide-react
 * equivalents the rest of vNext Engagement already imports. Kept as a string
 * key rather than a component so this file stays free of React imports and the
 * step machine can be unit-tested in isolation.
 */
export type OutreachBuilderStepIcon =
  | 'flag'
  | 'bookmark'
  | 'file'
  | 'grid'
  | 'users'
  | 'filter'
  | 'check-square'
  | 'mail'
  | 'target';

export const OUTREACH_BUILDER_STEP_ICONS: Record<OutreachBuilderStep, OutreachBuilderStepIcon> = {
  workflow: 'flag',
  name: 'bookmark',
  update: 'file',
  format: 'grid',
  targets: 'users',
  context: 'filter',
  review: 'check-square',
  drafts: 'mail',
  send: 'target',
};

/**
 * The primary button's label for a step. Several are computed from state the
 * step itself owns, which is why this takes the campaign type and a recipient
 * count rather than being a constant table.
 */
export function outreachBuilderPrimaryLabel(
  step: OutreachBuilderStep,
  type: OutreachCampaignType,
  readyRecipientCount = 0,
): string {
  switch (step) {
    case 'workflow':
      return `Continue with ${outreachCampaignTypeLabel(type)}`;
    case 'name':
      return `Continue to ${outreachTemplateStepLabel(type).toLowerCase()}`;
    case 'update':
      return outreachSkipsFormatStep(type) ? 'Continue to targets' : 'Continue to format';
    case 'format':
      return 'Continue to targets';
    case 'targets':
      return 'Continue to context';
    case 'context':
      return 'Continue to review packet';
    case 'review':
      return 'Accept packet and generate drafts';
    case 'drafts':
      return 'Continue to send';
    case 'send':
      return `Send ${readyRecipientCount} ${readyRecipientCount === 1 ? 'email' : 'emails'}`;
  }
}

/**
 * The four sponsor choices from the Name step, with the exact copy that states
 * what each one does to later context reads.
 */
export interface OutreachSponsorOption {
  id: 'firm' | 'client' | 'undecided';
  label: string;
  description: string;
}

export const OUTREACH_SPONSOR_FIRM: OutreachSponsorOption = {
  id: 'firm',
  label: 'Capiro · firm',
  description: 'No client is named. Nothing client-scoped reaches a draft.',
};

export const OUTREACH_SPONSOR_UNDECIDED: OutreachSponsorOption = {
  id: 'undecided',
  label: 'No sponsor yet',
  description: 'Decide later. Client-scoped context stays unavailable until you do.',
};

export const OUTREACH_SPONSOR_CLIENT_DESCRIPTION =
  'Client-sponsored. Scopes every later context read to this client.';

/**
 * The Format step's four layouts. `suitsAll` marks the plain-text option, which
 * is labelled "Safest" rather than "Recommended" — it is the only one no
 * mailbox can strip.
 *
 * `bands` are the three coloured bars in the option tile's mini preview;
 * `null` means the tile shows only the grey body lines (the standard-email
 * option has no coloured chrome to preview).
 */
export type OutreachEmailFormatId = 'standard' | 'briefing_card' | 'status_table' | 'timeline';

export interface OutreachEmailFormatOption {
  id: OutreachEmailFormatId;
  name: string;
  description: string;
  suitsAll: boolean;
  bands: [string, string, string] | null;
}

/**
 * Named separately so `outreachEmailFormatById` has a real fallback rather
 * than an array index the compiler cannot prove exists. Plain text is also the
 * right thing to fall back to: it is the one format no mailbox can strip.
 */
export const OUTREACH_STANDARD_EMAIL_FORMAT: OutreachEmailFormatOption = {
  id: 'standard',
  name: 'Standard email',
  description:
    'Plain text in the recipient’s mailbox font. Nothing to strip, nothing to render — the safest option for Hill offices.',
  suitsAll: true,
  bands: null,
};

export const OUTREACH_EMAIL_FORMATS: OutreachEmailFormatOption[] = [
  OUTREACH_STANDARD_EMAIL_FORMAT,
  {
    id: 'briefing_card',
    name: 'Briefing card',
    description:
      'One HTML column with a ruled header, the update in body text, and a three-fact strip underneath.',
    suitsAll: false,
    bands: ['#294E68', '#E4E7EC', '#F2F4F7'],
  },
  {
    id: 'status_table',
    name: 'Status table',
    description:
      'HTML table of the rows that moved — request, mark, delta, award — above the written update.',
    suitsAll: false,
    bands: ['#E4E7EC', '#294E68', '#E4E7EC'],
  },
  {
    id: 'timeline',
    name: 'Timeline update',
    description:
      'HTML vertical timeline of what happened and when, with the narrative as the closing paragraph.',
    suitsAll: false,
    bands: ['#F2F4F7', '#294E68', '#294E68'],
  },
];

export function outreachEmailFormatById(id: string | null | undefined): OutreachEmailFormatOption {
  return (
    OUTREACH_EMAIL_FORMATS.find((format) => format.id === id) ?? OUTREACH_STANDARD_EMAIL_FORMAT
  );
}

export const OUTREACH_FORMAT_NOTE =
  'HTML formats render inline in Outlook and Gmail. Anything a mailbox strips falls back to the plain-text version of the same words.';

export const OUTREACH_FORMAT_SKIP_NOTE =
  'Meeting requests always send as standard email, so there is no format step.';

/**
 * The send step's gate. `preflightRan` is the only hard prerequisite; `holdsAll`
 * is the user's own "wait for everyone" choice rather than a safety gate.
 *
 * There is deliberately no held-out acknowledgement arm. That gate asked the
 * user to tick a box confirming they knew some recipients were excluded, but
 * held-out recipients are dropped from the envelope server-side regardless, so
 * the box could never change who received mail — it only added a click and a
 * second preflight round-trip. The held-out set is still disclosed twice: in
 * the send step's held list and again in the confirmation dialog.
 */
export interface OutreachSendGateInput {
  preflightRan: boolean;
  blockedCount: number;
  partialChoice: 'ready' | 'all';
}

export interface OutreachSendGate {
  canSend: boolean;
  /** The whole campaign is blocked because the user chose to wait for everyone. */
  holdsAll: boolean;
  reason: string;
}

export function outreachSendGate(input: OutreachSendGateInput): OutreachSendGate {
  const holdsAll = input.partialChoice === 'all' && input.blockedCount > 0;
  const canSend = input.preflightRan && !holdsAll;
  const reason = !input.preflightRan
    ? 'Run preflight first.'
    : holdsAll
      ? 'With this choice one blocked recipient keeps the whole campaign from sending.'
      : 'The confirmation dialog is the only real-send trigger.';
  return { canSend, holdsAll, reason };
}

export function outreachReadyRecipientCount(
  selectedCount: number,
  blockedCount: number,
  partialChoice: 'ready' | 'all',
): number {
  if (partialChoice === 'all' && blockedCount > 0) return selectedCount;
  return selectedCount - blockedCount;
}
