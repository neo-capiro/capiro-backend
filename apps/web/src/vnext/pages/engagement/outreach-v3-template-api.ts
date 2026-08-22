import type { AxiosInstance } from 'axios';

const ROOT = '/api/engagement/outreach-v3/templates';

export type OutreachTemplateScope = 'private' | 'firm' | 'client';

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
}

/** Server-computed — never infer these from ownerUserId/scope in the UI. */
export interface OutreachTemplateCapabilities {
  canUse: boolean;
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
  status: 'active' | 'archived';
  currentDraftVersionId: string | null;
  publishedVersionId: string | null;
  draftVersionNumber: number | null;
  publishedVersionNumber: number | null;
  previewSummary: OutreachTemplateCardSummary | null;
  capabilities: OutreachTemplateCapabilities;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
}

export interface OutreachTemplateVersion {
  id: string;
  templateId: string;
  versionNumber: number;
  lifecycle: 'draft' | 'published';
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
    'draftVersionNumber' | 'publishedVersionNumber' | 'previewSummary' | 'capabilities'
  >;
  versions: OutreachTemplateVersion[];
  capabilities: OutreachTemplateCapabilities;
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
}

export interface OutreachTemplateMetadataInput {
  name: string;
  description?: string | null;
  scope: OutreachTemplateScope;
  clientId?: string | null;
}

export async function listOutreachTemplates(
  api: AxiosInstance,
  input: { clientId?: string | null; includeArchived?: boolean } = {},
): Promise<OutreachTemplateSummary[]> {
  const response = await api.get<OutreachTemplateSummary[]>(ROOT, {
    params: {
      ...(input.clientId ? { clientId: input.clientId } : {}),
      ...(input.includeArchived ? { includeArchived: true } : {}),
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
  input: { requestKey: string; title?: string | null; clientId?: string | null },
): Promise<OutreachTemplateUseResult> {
  return (await api.post(`${ROOT}/${encodeURIComponent(templateId)}/use`, input)).data;
}

export async function archiveOutreachTemplate(
  api: AxiosInstance,
  templateId: string,
): Promise<{ id: string; status: 'archived' }> {
  return (await api.post(`${ROOT}/${encodeURIComponent(templateId)}/archive`)).data;
}
