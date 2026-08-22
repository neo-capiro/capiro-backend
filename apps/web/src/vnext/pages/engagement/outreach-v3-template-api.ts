import type { AxiosInstance } from 'axios';

const ROOT = '/api/engagement/outreach-v3/templates';

export type OutreachTemplateScope = 'private' | 'firm' | 'client';
export type OutreachTemplateSortKey = 'updated' | 'name' | 'usage' | 'last_used';

export const OUTREACH_TEMPLATE_FIELD_RESOLUTION_MODES = [
  'fixed',
  'suggested',
  'ask_each_campaign',
  'meri_determines_user_confirms',
  'required_unresolved',
  'not_applicable',
] as const;
export type OutreachTemplateFieldResolutionMode = (typeof OUTREACH_TEMPLATE_FIELD_RESOLUTION_MODES)[number];

export const OUTREACH_TEMPLATE_DEFAULTS_POLICY_FIELDS = [
  'goal',
  'objective',
  'topic',
  'desiredOutcome',
  'ask',
  'whyNow',
  'sponsorScope',
  'audience',
  'delivery',
  'personalization',
  'contextPolicy',
  'campaignAngle',
  'tone',
  'length',
  'subjectStyle',
  'ctaStyle',
  'senderPolicy',
  'signaturePolicy',
  'schedulingPolicy',
  'attachmentPolicy',
  'followUpPolicy',
] as const;
export type OutreachTemplateDefaultsPolicyField = (typeof OUTREACH_TEMPLATE_DEFAULTS_POLICY_FIELDS)[number];

export type OutreachTemplateDefaultsPolicy = Record<
  OutreachTemplateDefaultsPolicyField,
  OutreachTemplateFieldResolutionMode
>;

export const DEFAULTS_POLICY_FIELD_LABELS: Record<OutreachTemplateDefaultsPolicyField, string> = {
  goal: 'Goal',
  objective: 'Objective',
  topic: 'Topic',
  desiredOutcome: 'Desired outcome',
  ask: 'Ask',
  whyNow: 'Why now',
  sponsorScope: 'Sponsor scope',
  audience: 'Audience rule',
  delivery: 'Delivery pattern',
  personalization: 'Personalization',
  contextPolicy: 'Context policy',
  campaignAngle: 'Campaign angle',
  tone: 'Tone',
  length: 'Length',
  subjectStyle: 'Subject style',
  ctaStyle: 'Call-to-action style',
  senderPolicy: 'Sender policy',
  signaturePolicy: 'Signature policy',
  schedulingPolicy: 'Scheduling policy',
  attachmentPolicy: 'Attachment policy',
  followUpPolicy: 'Follow-up policy',
};

export const RESOLUTION_MODE_LABELS: Record<OutreachTemplateFieldResolutionMode, string> = {
  fixed: 'Fixed default',
  suggested: 'Suggested default',
  ask_each_campaign: 'Ask each campaign',
  meri_determines_user_confirms: 'Meri determines, you confirm',
  required_unresolved: 'Required — left open',
  not_applicable: 'Not applicable',
};

export interface OutreachTemplateGuidance {
  audienceRule: string | null;
  contextPolicy: string | null;
  subjectStyle: string | null;
  ctaStyle: string | null;
  senderPolicy: string | null;
  signaturePolicy: string | null;
  schedulingPolicy: string | null;
  attachmentPolicy: string | null;
  followUpPolicy: string | null;
}

export const BLANK_TEMPLATE_GUIDANCE: OutreachTemplateGuidance = {
  audienceRule: null,
  contextPolicy: null,
  subjectStyle: null,
  ctaStyle: null,
  senderPolicy: null,
  signaturePolicy: null,
  schedulingPolicy: null,
  attachmentPolicy: null,
  followUpPolicy: null,
};

export interface OutreachTemplateGuardrails {
  editAuthority: 'owner_only' | 'managers' | 'firm_admins';
  publishAuthority: 'owner_only' | 'tenant_admin' | 'independent_reviewer';
  sendAuthority: 'owner_only' | 'any_authorized_sender' | 'tenant_admin';
  approvalMode: 'individual' | 'bulk_allowed';
  partialSendAllowed: boolean;
  requiredContextClasses: string[];
  requiredPreflightChecks: string[];
  senderRequirement: 'any_authorized' | 'specific_role_required' | 'not_applicable';
  attachmentRequirement: 'none' | 'optional' | 'required';
  followUpRequired: boolean;
  variablesAutoResolveAllowed: boolean;
  allowSkipValidPlanDecision: boolean;
}

export const DEFAULT_TEMPLATE_GUARDRAILS: OutreachTemplateGuardrails = {
  editAuthority: 'owner_only',
  publishAuthority: 'tenant_admin',
  sendAuthority: 'any_authorized_sender',
  approvalMode: 'individual',
  partialSendAllowed: false,
  requiredContextClasses: [],
  requiredPreflightChecks: [],
  senderRequirement: 'any_authorized',
  attachmentRequirement: 'none',
  followUpRequired: false,
  variablesAutoResolveAllowed: false,
  allowSkipValidPlanDecision: false,
};

export const OUTREACH_TEMPLATE_VARIABLE_TEXT_FIELDS = [
  'goal',
  'objective',
  'topic',
  'desiredOutcome',
  'ask',
  'whyNow',
  'campaignAngle',
] as const;
export type OutreachTemplateVariableTextField = (typeof OUTREACH_TEMPLATE_VARIABLE_TEXT_FIELDS)[number];

export interface OutreachTemplateVariable {
  key: string;
  label: string;
  question: string | null;
  type: 'text' | 'number' | 'date' | 'url' | 'email' | 'choice';
  choices: string[] | null;
  required: boolean;
  defaultValue: string | null;
  resolutionPolicy: 'meri_can_determine' | 'user_must_confirm' | 'always_ask';
  scope: 'public' | 'client_confidential';
  appliesTo: OutreachTemplateVariableTextField[];
}

export const DEFAULT_TEMPLATE_DEFAULTS_POLICY: OutreachTemplateDefaultsPolicy = Object.fromEntries(
  OUTREACH_TEMPLATE_DEFAULTS_POLICY_FIELDS.map((field) => [field, 'fixed' as const]),
) as OutreachTemplateDefaultsPolicy;

export interface OutreachTemplateSpec {
  schemaVersion: 'outreach_v3_template_v1';
  goal: {
    goal: string | null;
    objective: string | null;
    topic: string | null;
    desiredOutcome: string | null;
    ask: { mode: 'undecided' | 'explicit' | 'none'; text: string | null };
    whyNow: string | null;
  };
  sponsor: {
    kind: 'undecided' | 'firm' | 'client' | 'coalition' | 'internal_team' | 'none';
    label: string | null;
  };
  targeting: { criteria: Record<string, unknown> | null };
  delivery: {
    pattern: 'undecided' | 'personalized_separate' | 'uniform_separate' | 'shared_thread';
    personalization: 'undecided' | 'high' | 'light' | 'none';
  };
  strategy: {
    campaignAngle: string | null;
    tone: string | null;
    length: 'undecided' | 'short' | 'medium' | 'long' | 'custom';
    customLengthInstruction: string | null;
  };
  styleSamples: Array<{ label: string | null; subject: string | null; body: string }>;
  variables: OutreachTemplateVariable[];
  defaultsPolicy: OutreachTemplateDefaultsPolicy;
  guidance: OutreachTemplateGuidance;
  guardrails: OutreachTemplateGuardrails;
}

export function blankOutreachTemplateSpec(): OutreachTemplateSpec {
  return {
    schemaVersion: 'outreach_v3_template_v1',
    goal: { goal: null, objective: null, topic: null, desiredOutcome: null, ask: { mode: 'undecided', text: null }, whyNow: null },
    sponsor: { kind: 'undecided', label: null },
    targeting: { criteria: null },
    delivery: { pattern: 'undecided', personalization: 'undecided' },
    strategy: { campaignAngle: null, tone: null, length: 'undecided', customLengthInstruction: null },
    styleSamples: [],
    variables: [],
    defaultsPolicy: DEFAULT_TEMPLATE_DEFAULTS_POLICY,
    guidance: BLANK_TEMPLATE_GUIDANCE,
    guardrails: DEFAULT_TEMPLATE_GUARDRAILS,
  };
}

/** Safe card-list projection only — never style samples or long-form prose. */
export interface OutreachTemplateCardSummary {
  topic: string | null;
  sponsorKind: OutreachTemplateSpec['sponsor']['kind'];
  deliveryPattern: OutreachTemplateSpec['delivery']['pattern'];
  personalization: OutreachTemplateSpec['delivery']['personalization'];
  tone: string | null;
  length: OutreachTemplateSpec['strategy']['length'];
  hasExplicitAsk: boolean;
  styleSampleCount: number;
  variableCount: number;
  requiredVariableCount: number;
}

/** Server-computed — never infer these from ownerUserId/scope in the UI. */
export interface OutreachTemplateCapabilities {
  canUse: boolean;
  canDuplicate: boolean;
  canInspect: boolean;
  canEdit: boolean;
  canCreateVersion: boolean;
  canPublish: boolean;
  canArchive: boolean;
  canRestore: boolean;
}

export interface OutreachTemplateSummary {
  id: string;
  ownerUserId: string;
  clientId: string | null;
  scope: OutreachTemplateScope;
  name: string;
  description: string | null;
  campaignType: string | null;
  status: 'active' | 'archived';
  currentDraftVersionId: string | null;
  publishedVersionId: string | null;
  duplicatedFromTemplateId: string | null;
  duplicatedFromVersionId: string | null;
  draftVersionNumber: number | null;
  publishedVersionNumber: number | null;
  previewSummary: OutreachTemplateCardSummary | null;
  capabilities: OutreachTemplateCapabilities;
  usageCount: number;
  lastUsedAt: string | null;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
}

export interface OutreachTemplateVersion {
  id: string;
  templateId: string;
  versionNumber: number;
  lifecycle: 'draft' | 'published' | 'superseded';
  contentHash: string;
  sourceSessionId: string | null;
  sourceStateVersion: number | null;
  createdByUserId: string;
  createdAt: string;
  publishedAt: string | null;
  spec: OutreachTemplateSpec;
}

export interface OutreachTemplateDetail {
  template: Omit<
    OutreachTemplateSummary,
    'draftVersionNumber' | 'publishedVersionNumber' | 'previewSummary' | 'capabilities' | 'usageCount' | 'lastUsedAt'
  >;
  versions: OutreachTemplateVersion[];
  capabilities: OutreachTemplateCapabilities;
}

export interface OutreachTemplateApplicationReceiptItem {
  field: string;
  label: string;
  detail: string | null;
}

export interface OutreachTemplateApplicationReceipt {
  templateId: string;
  templateName: string;
  templateVersionId: string;
  templateVersionNumber: number;
  templateContentHash: string;
  inherited: OutreachTemplateApplicationReceiptItem[];
  refreshed: OutreachTemplateApplicationReceiptItem[];
  unresolved: OutreachTemplateApplicationReceiptItem[];
  unavailable: OutreachTemplateApplicationReceiptItem[];
  nextRequiredStep: string | null;
  requiresLiveTargets: boolean;
  requiresLiveContext: boolean;
}

export interface OutreachTemplateUseResult {
  sessionId: string;
  stateVersion: number;
  templateId: string;
  templateVersionId: string;
  applicationId?: string;
  replayed: boolean;
  requiresLiveTargets?: boolean;
  requiresLiveContext?: boolean;
  receipt: OutreachTemplateApplicationReceipt;
}

export interface OutreachTemplateProvenance {
  sessionId: string;
  templateId: string;
  templateName: string;
  templateVersionId: string;
  versionNumber: number;
  contentHash: string;
  applicationId: string;
  appliedByUserId: string;
  appliedAt: string;
  receiptJsonb: OutreachTemplateApplicationReceipt;
}

export interface OutreachTemplateMetadataInput {
  name: string;
  description?: string | null;
  campaignType?: string | null;
  scope: OutreachTemplateScope;
  clientId?: string | null;
}

export async function listOutreachTemplates(
  api: AxiosInstance,
  input: {
    clientId?: string | null;
    includeArchived?: boolean;
    search?: string | null;
    campaignType?: string | null;
    mineOnly?: boolean;
    sort?: OutreachTemplateSortKey;
  } = {},
): Promise<OutreachTemplateSummary[]> {
  const response = await api.get<OutreachTemplateSummary[]>(ROOT, {
    params: {
      ...(input.clientId ? { clientId: input.clientId } : {}),
      ...(input.includeArchived ? { includeArchived: true } : {}),
      ...(input.search?.trim() ? { search: input.search.trim() } : {}),
      ...(input.campaignType ? { campaignType: input.campaignType } : {}),
      ...(input.mineOnly ? { mineOnly: true } : {}),
      ...(input.sort ? { sort: input.sort } : {}),
    },
  });
  return response.data;
}

export async function getOutreachTemplate(
  api: AxiosInstance,
  templateId: string,
  clientId?: string | null,
): Promise<OutreachTemplateDetail> {
  const response = await api.get<OutreachTemplateDetail>(
    `${ROOT}/${encodeURIComponent(templateId)}`,
    { params: clientId ? { clientId } : undefined },
  );
  return response.data;
}

export async function createOutreachTemplateFromSession(
  api: AxiosInstance,
  input: OutreachTemplateMetadataInput & { sessionId: string },
): Promise<{ template: OutreachTemplateSummary; version: OutreachTemplateVersion; published: false }> {
  return (await api.post(`${ROOT}/from-session`, input)).data;
}

export async function createOutreachTemplateFromScratch(
  api: AxiosInstance,
  input: { name: string; description?: string | null; campaignType?: string | null; spec: OutreachTemplateSpec },
): Promise<{ template: OutreachTemplateSummary; version: OutreachTemplateVersion; published: false }> {
  return (await api.post(`${ROOT}/from-scratch`, input)).data;
}

export async function replaceOutreachTemplateDraft(
  api: AxiosInstance,
  templateId: string,
  spec: OutreachTemplateSpec,
): Promise<{ templateId: string; version: OutreachTemplateVersion; published: false }> {
  return (await api.patch(`${ROOT}/${encodeURIComponent(templateId)}/draft`, { spec })).data;
}

export async function updateOutreachTemplateMetadata(
  api: AxiosInstance,
  templateId: string,
  input: OutreachTemplateMetadataInput,
): Promise<OutreachTemplateSummary> {
  return (await api.patch(`${ROOT}/${encodeURIComponent(templateId)}`, input)).data;
}

export async function createOutreachTemplateVersionFromSession(
  api: AxiosInstance,
  templateId: string,
  sessionId: string,
): Promise<{ templateId: string; version: OutreachTemplateVersion; published: false }> {
  return (
    await api.post(`${ROOT}/${encodeURIComponent(templateId)}/versions/from-session`, {
      sessionId,
    })
  ).data;
}

export async function publishOutreachTemplate(
  api: AxiosInstance,
  templateId: string,
): Promise<{ templateId: string; version: OutreachTemplateVersion; published: true }> {
  return (await api.post(`${ROOT}/${encodeURIComponent(templateId)}/publish`)).data;
}

export async function useOutreachTemplate(
  api: AxiosInstance,
  templateId: string,
  input: { requestKey: string; title?: string | null; clientId?: string | null; variableValues?: Record<string, string> },
): Promise<OutreachTemplateUseResult> {
  return (await api.post(`${ROOT}/${encodeURIComponent(templateId)}/use`, input)).data;
}

export async function duplicateOutreachTemplate(
  api: AxiosInstance,
  templateId: string,
  input: { clientId?: string | null } = {},
): Promise<{ template: OutreachTemplateSummary; version: OutreachTemplateVersion; published: false }> {
  return (await api.post(`${ROOT}/${encodeURIComponent(templateId)}/duplicate`, input)).data;
}

export async function archiveOutreachTemplate(
  api: AxiosInstance,
  templateId: string,
): Promise<{ id: string; status: 'archived' }> {
  return (await api.post(`${ROOT}/${encodeURIComponent(templateId)}/archive`)).data;
}

/** null when the session has no template origin — the normal case, not an error. */
export async function getOutreachTemplateProvenance(
  api: AxiosInstance,
  sessionId: string,
): Promise<OutreachTemplateProvenance | null> {
  const response = await api.get<OutreachTemplateProvenance | null>(
    `${ROOT}/provenance/${encodeURIComponent(sessionId)}`,
  );
  return response.data ?? null;
}

export interface OutreachTemplateSpecFieldDiff {
  field: string;
  before: string;
  after: string;
}

function stringifyDiffValue(value: unknown): string {
  if (value === null || value === undefined || value === '') return '(none)';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  return String(value);
}

function describeDiffField(label: string, before: unknown, after: unknown): OutreachTemplateSpecFieldDiff | null {
  const b = stringifyDiffValue(before);
  const a = stringifyDiffValue(after);
  return b === a ? null : { field: label, before: b, after: a };
}

/** Mirrors the backend's diffOutreachTemplateSpecs() for the update-review UI — computed
 * client-side over two already-authorized spec reads, not a new privileged read path. */
export function diffOutreachTemplateSpecs(
  before: OutreachTemplateSpec,
  after: OutreachTemplateSpec,
): OutreachTemplateSpecFieldDiff[] {
  return [
    describeDiffField('Goal', before.goal.goal, after.goal.goal),
    describeDiffField('Objective', before.goal.objective, after.goal.objective),
    describeDiffField('Topic', before.goal.topic, after.goal.topic),
    describeDiffField('Desired outcome', before.goal.desiredOutcome, after.goal.desiredOutcome),
    describeDiffField('Ask', before.goal.ask.text, after.goal.ask.text),
    describeDiffField('Why now', before.goal.whyNow, after.goal.whyNow),
    describeDiffField('Sponsor', before.sponsor.kind, after.sponsor.kind),
    describeDiffField('Delivery pattern', before.delivery.pattern, after.delivery.pattern),
    describeDiffField('Personalization', before.delivery.personalization, after.delivery.personalization),
    describeDiffField('Campaign angle', before.strategy.campaignAngle, after.strategy.campaignAngle),
    describeDiffField('Tone', before.strategy.tone, after.strategy.tone),
    describeDiffField('Length', before.strategy.length, after.strategy.length),
    describeDiffField('Style samples', before.styleSamples.length, after.styleSamples.length),
    describeDiffField('Variables', before.variables.length, after.variables.length),
    describeDiffField('Send authority', before.guardrails.sendAuthority, after.guardrails.sendAuthority),
    describeDiffField('Approval mode', before.guardrails.approvalMode, after.guardrails.approvalMode),
  ].filter((diff): diff is OutreachTemplateSpecFieldDiff => diff !== null);
}
