import type { Client } from '../../../pages/clients/clientTypes.js';
import type {
  OutreachV3ContextSelection,
  OutreachV3ResolvedTargetRef,
  OutreachV3SessionEnvelope,
} from '../../../pages/engagement/outreach/v3/contracts.js';
import type { GoalDraft } from '../../../pages/engagement/outreach/v3/commands.js';

export type OutreachWorkflowTemplateId = 'request_meeting' | 'send_update' | 'custom';
export type ClientProfileContextKey =
  | 'overview'
  | 'relationships'
  | 'files'
  | 'program_elements'
  | 'capabilities'
  | 'locations';
export type OutreachGuidedStep =
  | 'template'
  | 'name'
  | 'sponsor'
  | 'target'
  | 'context'
  | 'review'
  | 'generating';

export interface OutreachWorkflowTemplateDefinition {
  id: OutreachWorkflowTemplateId;
  title: string;
  description: string;
  eyebrow: string;
}

export interface ClientProfileContextOption {
  key: ClientProfileContextKey;
  label: string;
  description: string;
}

export const OUTREACH_WORKFLOW_TEMPLATES: OutreachWorkflowTemplateDefinition[] = [
  {
    id: 'request_meeting',
    title: 'Request a meeting',
    description: 'Create a personalized meeting request for every selected recipient.',
    eyebrow: 'Meeting request',
  },
  {
    id: 'send_update',
    title: 'Send an update',
    description: 'Share one client update, tailored to each recipient and relationship.',
    eyebrow: 'Client update',
  },
  {
    id: 'custom',
    title: 'Custom',
    description: 'Define the purpose and let Meri build the campaign around it.',
    eyebrow: 'Flexible campaign',
  },
];

export const CLIENT_PROFILE_CONTEXT_OPTIONS: ClientProfileContextOption[] = [
  {
    key: 'overview',
    label: 'Overview',
    description: 'Company description, products, identifiers, priorities, and primary contact.',
  },
  {
    key: 'relationships',
    label: 'Relationships',
    description: 'Client people, roles, contact history, and relationship notes.',
  },
  {
    key: 'files',
    label: 'Files',
    description: 'Client file inventory available on the sponsor profile.',
  },
  {
    key: 'program_elements',
    label: 'Program elements',
    description: 'Relevant program elements, scores, and evidence paths.',
  },
  {
    key: 'capabilities',
    label: 'Capabilities',
    description: 'Products, services, technologies, funding asks, and differentiators.',
  },
  {
    key: 'locations',
    label: 'Locations',
    description: 'Facilities, districts, employee footprint, and location notes.',
  },
];

export function inferOutreachWorkflowTemplate(
  session: OutreachV3SessionEnvelope | null,
): OutreachWorkflowTemplateId | null {
  const goal = session?.spec.goal.goal?.trim().toLowerCase() ?? '';
  if (!goal) return null;
  if (goal === 'request a meeting' || goal.includes('meeting')) return 'request_meeting';
  if (goal === 'send a client update' || goal.includes('update')) return 'send_update';
  return 'custom';
}

export function outreachWorkflowDefinition(
  id: OutreachWorkflowTemplateId,
): OutreachWorkflowTemplateDefinition {
  return (
    OUTREACH_WORKFLOW_TEMPLATES.find((template) => template.id === id) ??
    OUTREACH_WORKFLOW_TEMPLATES[2]!
  );
}

export function workflowCampaignDefaults(input: {
  templateId: OutreachWorkflowTemplateId;
  campaignName: string;
  customPurpose?: string;
}): {
  goal: GoalDraft;
  strategy: { campaignAngle: string; tone: string; length: 'short' };
} {
  const campaignName = required(input.campaignName, 'Campaign name');
  const customPurpose = input.customPurpose?.trim() || `Advance ${campaignName}`;

  if (input.templateId === 'request_meeting') {
    return {
      goal: {
        goal: 'Request a meeting',
        objective: `Secure a focused meeting about ${campaignName}`,
        topic: campaignName,
        desiredOutcome: 'The recipient agrees to a meeting or provides availability.',
        askMode: 'explicit',
        askText: 'Reply with availability for a short meeting.',
        whyNow: `The sponsor wants to discuss ${campaignName} now.`,
      },
      strategy: {
        campaignAngle: `Lead with the recipient-specific reason a meeting about ${campaignName} is worth their time.`,
        tone: 'Professional, warm, specific, and respectful of the recipient’s time.',
        length: 'short',
      },
    };
  }

  if (input.templateId === 'send_update') {
    return {
      goal: {
        goal: 'Send a client update',
        objective: `Share the most relevant update about ${campaignName}`,
        topic: campaignName,
        desiredOutcome: 'The recipient understands the update and knows the appropriate next action.',
        askMode: 'explicit',
        askText: 'Reply with any questions or next steps.',
        whyNow: `The update about ${campaignName} is timely for the selected recipients.`,
      },
      strategy: {
        campaignAngle: `Lead with what changed, why ${campaignName} matters to this recipient, and the next action.`,
        tone: 'Professional, clear, useful, and concise.',
        length: 'short',
      },
    };
  }

  return {
    goal: {
      goal: customPurpose,
      objective: customPurpose,
      topic: campaignName,
      desiredOutcome: 'The recipient understands the purpose and responds to the requested next step.',
      askMode: 'explicit',
      askText: 'Reply with the appropriate next step.',
      whyNow: `This outreach about ${campaignName} is timely.`,
    },
    strategy: {
      campaignAngle: customPurpose,
      tone: 'Professional, natural, and specific to the recipient.',
      length: 'short',
    },
  };
}

export function clientRecordContextSelection(clientId: string): OutreachV3ContextSelection {
  return {
    locator: {
      source: 'capiro_record',
      recordType: 'client',
      id: clientId,
      clientId,
    },
    contextClass: 'campaign_fact',
    scope: { kind: 'campaign' },
  };
}

export function manualProfileContextSelection(input: {
  sectionLabel: string;
  text: string;
}): OutreachV3ContextSelection {
  const text = clipContext(
    [
      `CLIENT PROFILE SECTION: ${input.sectionLabel}`,
      'This snapshot was read from Capiro’s sponsor-client profile when the user approved the review packet.',
      'Use only the facts present here. Do not infer missing facts or treat empty fields as proof of absence.',
      input.text,
    ].join('\n\n'),
  );
  return {
    locator: {
      source: 'manual',
      id: crypto.randomUUID(),
      title: `${input.sectionLabel} — client profile`,
      text,
      sourceLabel: 'capiro_client_profile',
    },
    contextClass: 'writing_guidance',
    scope: { kind: 'campaign' },
  };
}

export function programElementContextSelection(peCode: string): OutreachV3ContextSelection {
  return {
    locator: {
      source: 'government_record',
      category: 'program_element',
      id: peCode,
    },
    contextClass: 'campaign_fact',
    scope: { kind: 'campaign' },
  };
}

export function subjectLineContextSelection(campaignName: string): OutreachV3ContextSelection {
  const subject = required(campaignName, 'Campaign name');
  return {
    locator: {
      source: 'manual',
      id: crypto.randomUUID(),
      title: 'Campaign subject line',
      text: `Use this exact subject line for every destination in this campaign: ${subject}`,
      sourceLabel: 'outreach_review_packet',
    },
    contextClass: 'writing_guidance',
    scope: { kind: 'campaign' },
  };
}

export function targetNoteContextSelection(input: {
  target: OutreachV3ResolvedTargetRef;
  note: string;
}): OutreachV3ContextSelection | null {
  const note = input.note.trim();
  if (!note) return null;
  return {
    locator: {
      source: 'manual',
      id: crypto.randomUUID(),
      title: `Personal note — ${targetDisplayName(input.target)}`,
      text: clipContext(
        `Personal note for ${targetDisplayName(input.target)}. Apply this note only to this recipient’s draft: ${note}`,
      ),
      sourceLabel: 'outreach_review_packet',
    },
    contextClass: 'target_specific',
    scope: { kind: 'target', targetKey: input.target.targetKey },
  };
}

export function targetDisplayName(target: OutreachV3ResolvedTargetRef): string {
  return target.displayName || target.email || 'Selected recipient';
}

export function targetSubtitle(target: OutreachV3ResolvedTargetRef): string {
  return [target.title, target.organization, target.email].filter(Boolean).join(' · ');
}

export function acceptedContextCount(session: OutreachV3SessionEnvelope | null): number {
  if (!session) return 0;
  const context = session.spec.context;
  return (
    context.requiredPolicyRefs.length +
    context.writingGuidanceRefs.length +
    context.campaignFactRefs.length +
    context.targetSpecificRefs.length +
    context.groupSafeRefs.length
  );
}

export function inferOutreachGuidedStep(
  session: OutreachV3SessionEnvelope | null,
): OutreachGuidedStep {
  if (!session?.spec.goal.goal || !session.spec.goal.topic) return 'template';
  if (session.spec.sponsor.kind === 'undecided') return 'sponsor';
  if (!session.spec.targeting.selectedTargetRefs.length) return 'target';
  if (!acceptedContextCount(session)) return 'context';
  return 'review';
}

export function clientOverviewText(client: Client): string {
  const intake = client.intakeData ?? {};
  const identifiers = [
    client.uei ? `UEI ${client.uei}` : null,
    client.cageCode ? `CAGE ${client.cageCode}` : null,
    client.naicsCodes?.length ? `NAICS ${client.naicsCodes.join(', ')}` : null,
    client.pscCodes?.length ? `PSC ${client.pscCodes.join(', ')}` : null,
  ].filter(Boolean);
  const address = [
    intake.address1,
    intake.address2,
    intake.city,
    intake.state,
    intake.zip,
    intake.country,
  ]
    .filter(Boolean)
    .join(', ');
  const classifications = Object.entries(intake.sbClassification ?? {})
    .filter(([, enabled]) => enabled)
    .map(([key]) => key)
    .join(', ');

  return compactLines([
    `Client: ${client.name}`,
    client.description ? `Overview: ${client.description}` : null,
    client.productDescription ? `Products and services: ${client.productDescription}` : null,
    client.website ? `Website: ${client.website}` : null,
    client.sectorTag ? `Sector: ${client.sectorTag}` : null,
    client.profileType ? `Profile type: ${client.profileType}` : null,
    client.profileStatus ? `Profile status: ${client.profileStatus}` : null,
    client.submissionTracks?.length
      ? `Submission tracks: ${client.submissionTracks.join(', ')}`
      : null,
    identifiers.length ? `Government identifiers: ${identifiers.join(' · ')}` : null,
    address ? `Primary location: ${address}` : null,
    classifications ? `Business classifications: ${classifications}` : null,
    client.primaryContactName
      ? `Primary contact: ${[
          client.primaryContactName,
          client.primaryContactEmail,
          client.primaryContactPhone,
        ]
          .filter(Boolean)
          .join(' · ')}`
      : null,
    intake.internalNotes ? `Internal profile notes: ${String(intake.internalNotes)}` : null,
  ]);
}

export function compactLines(lines: Array<string | null | undefined>): string {
  return lines.filter((line): line is string => Boolean(line?.trim())).join('\n');
}

export function clipContext(value: string, max = 11_800): string {
  const normalized = value.trim();
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, max - 28).trimEnd()}\n[Snapshot truncated]`;
}

function required(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} is required.`);
  return normalized;
}
