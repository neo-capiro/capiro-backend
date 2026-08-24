import type { AxiosInstance } from 'axios';

const ROOT = '/api/engagement/outreach-v3/sessions';

export interface OutreachV3GenerationRecipient {
  targetKey: string;
  label: string;
  email: string | null;
  targetType?: string;
}

export interface OutreachV3GenerationSlot {
  generationKey: string;
  audienceKind: 'individual' | 'group';
  recipients: OutreachV3GenerationRecipient[];
  contextClass?: string;
  sendBlocked?: boolean;
  blockers?: string[];
}

export interface OutreachV3GenerationPlan {
  planVersion: string;
  sessionId: string;
  stateVersion: number;
  specHash: string;
  planHash: string;
  deliveryPattern: 'personalized_separate' | 'uniform_separate' | 'shared_thread';
  slots: OutreachV3GenerationSlot[];
  representativeSampleKeys: string[];
  eligible: boolean;
  blockers: string[];
}

export interface OutreachV3SampleVersion {
  generationKey: string;
  artifactId: string;
  versionId: string;
  contentHash: string;
  planHash: string;
  auditStatus: string;
  generationStatus: string;
}

export interface OutreachV3GeneratedSample {
  generationKey: string;
  outcome: string;
  subject: string;
  body: string;
  contextNote: string | null;
  sampleVersion: OutreachV3SampleVersion | null;
  error: string | null;
  sendable: false;
}

export interface OutreachV3SampleGenerationResult {
  sessionId: string;
  stateVersion: number;
  specHash: string;
  planHash: string;
  representativeSampleKeys: string[];
  samples: OutreachV3GeneratedSample[];
  complete: boolean;
  approachApprovalRequired: true;
  fullGenerationStarted: false;
}

export interface OutreachV3ApproachApproval {
  gateVersion: string;
  sessionId: string;
  stateVersion: number;
  specHash: string;
  planHash: string;
  sampleVersions: OutreachV3SampleVersion[];
  approvalHash: string;
}

export interface OutreachV3ApproachApprovalResult {
  approval: OutreachV3ApproachApproval;
  eventId: string;
  eventSequence: string;
  idempotent: boolean;
}

export interface OutreachV3DraftVersion {
  id: string;
  artifactId: string;
  outreachRecordId: string;
  version: number;
  sourceVersionId: string | null;
  generationKey: string;
  recipientKey: string;
  audienceKind: string;
  subject: string;
  body: string;
  contentHash: string;
  generationStatus: string;
  auditStatus: string;
  approvalStatus: string;
  auditDecision: string | null;
  auditChecks: Array<{ check: string; severity: string }>;
  reviewRequestId: string | null;
  provider: string | null;
  model: string | null;
  promptSpecVersion: string | null;
  sendable: boolean;
  createdAt: string;
  contextNote?: string;
}

export interface OutreachV3DraftArtifact {
  id: string;
  outreachRecordId: string;
  generationKey: string;
  recipientKey: string;
  audienceKind: string;
  currentVersion: number;
  current: OutreachV3DraftVersion | null;
  history: Array<{
    id: string;
    version: number;
    generationStatus: string;
    auditStatus: string;
    approvalStatus: string;
    createdAt: string;
  }>;
}

export interface OutreachV3GenerationJobItem {
  id: string;
  generationKey: string;
  status: string;
  result?: Record<string, unknown> | null;
  error?: { code?: string; message?: string } | null;
  attempt: number;
}

export interface OutreachV3GenerationJob {
  id: string;
  sessionId: string;
  status: string;
  totals: Record<string, number> | null;
  requestKey: string | null;
  planHash: string | null;
  approachApprovalHash: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
  items: OutreachV3GenerationJobItem[];
}

export interface OutreachV3SendSettings {
  schemaVersion: string;
  senderConnectionId: string;
  appendSignature: boolean;
  attachmentIds: string[];
  settingsHash: string;
  stateVersion: number;
  updatedAt: string;
}

export type OutreachV3CheckState = 'pass' | 'review' | 'blocked';

export interface OutreachV3NamedPreflightCheck {
  key: string;
  label: string;
  detail: string;
  state: OutreachV3CheckState;
}

export interface OutreachV3PreflightDraftResult {
  generationKey: string;
  versionId: string | null;
  eligible: boolean;
  blockers: string[];
  recipientEmails: string[];
}

export interface OutreachV3ServerPreflight {
  eligible: boolean;
  testMode: boolean;
  blockers: string[];
  checks: OutreachV3NamedPreflightCheck[];
  draftVersionIds: string[];
  excludedGenerationKeys: string[];
  heldOutAcknowledged: boolean;
  plan: OutreachV3GenerationPlan;
  settings: OutreachV3SendSettings | null;
  draftResults: OutreachV3PreflightDraftResult[];
}

export interface OutreachV3DeliveryView {
  id: string;
  generationKey: string;
  recipientKey: string;
  status: string;
  attempt: number;
  provider: string;
  correlationId: string;
  to: Array<{ email: string; name?: string | null }>;
  cc: string[];
  bcc: string[];
  subject: string;
  providerMessageId: string | null;
  providerThreadId: string | null;
  providerDraftId: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  acceptedAt: string | null;
}

export interface OutreachV3SendIntentView {
  id: string;
  outreachRecordId: string;
  status: string;
  testMode: boolean;
  requestKey: string;
  totals: Record<string, number>;
  error: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
  deliveries: OutreachV3DeliveryView[];
  reconciliation?: {
    automaticRetry: false;
    automaticResend: false;
    unknownIsTerminal: true;
    source: string;
  };
}

export interface OutreachAttachment {
  id: string;
  fileName: string;
  contentType: string;
  byteSize: number | null;
  lifecycleStatus?: string;
  scanStatus?: string | null;
}

export interface SavedAudienceMember {
  id: string;
  source: string;
  sourceRefId: string | null;
  name: string | null;
  email: string;
  title: string | null;
  office: string | null;
}

export interface SavedAudience {
  id: string;
  kind: 'list' | 'group';
  name: string;
  members: SavedAudienceMember[];
}

function sessionPath(sessionId: string, suffix: string): string {
  return `${ROOT}/${encodeURIComponent(sessionId)}${suffix}`;
}

export async function getOutreachV3GenerationPlan(api: AxiosInstance, sessionId: string) {
  return (await api.get<OutreachV3GenerationPlan>(sessionPath(sessionId, '/generation/plan'))).data;
}

export async function generateOutreachV3Samples(api: AxiosInstance, sessionId: string) {
  return (
    await api.post<OutreachV3SampleGenerationResult>(sessionPath(sessionId, '/generation/samples'))
  ).data;
}

export async function getOutreachV3ApproachApproval(api: AxiosInstance, sessionId: string) {
  return (
    await api.get<OutreachV3ApproachApproval | null>(
      sessionPath(sessionId, '/generation/approach-approval'),
    )
  ).data;
}

export async function approveOutreachV3Approach(
  api: AxiosInstance,
  sessionId: string,
  versionIds: string[],
) {
  return (
    await api.post<OutreachV3ApproachApprovalResult>(
      sessionPath(sessionId, '/generation/approach-approval'),
      { versionIds },
    )
  ).data;
}

export interface OutreachV3FullGenerationResponse {
  jobId: string | null;
  deduped: boolean;
  complete: boolean;
  remaining: number;
}

export async function startOutreachV3FullGeneration(
  api: AxiosInstance,
  sessionId: string,
  requestKey: string,
) {
  return (
    await api.post<OutreachV3FullGenerationResponse>(
      sessionPath(sessionId, '/generation/full'),
      { requestKey },
    )
  ).data;
}

/**
 * Deterministic logical-attempt key for full generation.
 *
 * Anchored to `sessionId + approvalHash` — the approval hash already binds
 * the exact sessionId/stateVersion/specHash/planHash/sample-or-packet-hash
 * (see `createOutreachV3ApproachApprovalSnapshot` /
 * `createOutreachV3ReviewPacketApprovalSnapshot` server-side), so this key is
 * stable across a double-click or a retry-after-timeout of the SAME approved
 * generation, and changes automatically the moment approval is invalidated by
 * any upstream edit. Never derive this from `crypto.randomUUID()` — a fresh
 * random key on every call defeats the backend's
 * `(tenantId, userId, requestKey)` idempotency lookup and can mint duplicate
 * jobs for what is logically one generation attempt.
 */
export function outreachV3FullGenerationRequestKey(
  sessionId: string,
  approvalHash: string,
): string {
  return `${sessionId}:${approvalHash}`;
}

export type OutreachV3FullGenerationOutcome =
  | { kind: 'job'; jobId: string; deduped: boolean; remaining: number }
  | { kind: 'complete' }
  /**
   * Neither a job id nor a completed result. This must never be treated as a
   * successful start — see VNextOutreachGuidedWorkspace's regression test for
   * `complete=false, jobId=null`.
   */
  | { kind: 'invalid' };

export function classifyOutreachV3FullGenerationResult(
  result: OutreachV3FullGenerationResponse,
): OutreachV3FullGenerationOutcome {
  if (result.jobId) {
    return { kind: 'job', jobId: result.jobId, deduped: result.deduped, remaining: result.remaining };
  }
  if (result.complete) return { kind: 'complete' };
  return { kind: 'invalid' };
}

export async function getOutreachV3GenerationJob(
  api: AxiosInstance,
  sessionId: string,
  jobId: string,
) {
  return (
    await api.get<OutreachV3GenerationJob>(
      sessionPath(sessionId, `/generation/jobs/${encodeURIComponent(jobId)}`),
    )
  ).data;
}

/**
 * Server-truth recovery (section 8): the most recent full-generation job for
 * this session, or null when none has ever been created. Call this at
 * Drafts/session mount so recovery never depends on `sessionStorage`
 * surviving a refresh, a browser navigation away-and-back, a lost tab, or a
 * fresh device. `sessionStorage` remains a same-tab cache/optimization only.
 */
export async function getLatestOutreachV3FullGenerationJob(
  api: AxiosInstance,
  sessionId: string,
) {
  return (
    await api.get<{ job: OutreachV3GenerationJob | null }>(
      sessionPath(sessionId, '/generation/jobs/latest'),
    )
  ).data.job;
}

export async function cancelOutreachV3GenerationJob(
  api: AxiosInstance,
  sessionId: string,
  jobId: string,
) {
  return (
    await api.post(sessionPath(sessionId, `/generation/jobs/${encodeURIComponent(jobId)}/cancel`))
  ).data;
}

export async function retryOutreachV3GenerationItem(
  api: AxiosInstance,
  sessionId: string,
  jobId: string,
  itemId: string,
) {
  return (
    await api.post(
      sessionPath(
        sessionId,
        `/generation/jobs/${encodeURIComponent(jobId)}/items/${encodeURIComponent(itemId)}/retry`,
      ),
    )
  ).data;
}

export async function listOutreachV3Drafts(api: AxiosInstance, sessionId: string) {
  return (await api.get<OutreachV3DraftArtifact[]>(sessionPath(sessionId, '/drafts'))).data;
}

export async function reviseOutreachV3Draft(
  api: AxiosInstance,
  sessionId: string,
  artifactId: string,
  input: {
    baseVersionId: string;
    subject: string;
    body: string;
    editKind?: 'manual' | 'improve' | 'revert';
  },
) {
  return (
    await api.post<OutreachV3DraftVersion>(
      sessionPath(sessionId, `/drafts/${encodeURIComponent(artifactId)}/versions`),
      input,
    )
  ).data;
}

/**
 * "Refine with Meri". Returns the new CURRENT version — the server always
 * advances the artifact, so there is no candidate to accept or discard.
 */
export async function refineOutreachV3Draft(
  api: AxiosInstance,
  sessionId: string,
  artifactId: string,
  input: {
    baseVersionId: string;
    instruction: string;
  },
) {
  return (
    await api.post<OutreachV3DraftVersion>(
      sessionPath(sessionId, `/drafts/${encodeURIComponent(artifactId)}/refine`),
      input,
    )
  ).data;
}

export async function approveOutreachV3Draft(
  api: AxiosInstance,
  sessionId: string,
  versionId: string,
) {
  return (
    await api.post(sessionPath(sessionId, `/drafts/${encodeURIComponent(versionId)}/approval`))
  ).data;
}

export async function getOutreachV3SendSettings(api: AxiosInstance, sessionId: string) {
  return (await api.get<OutreachV3SendSettings | null>(sessionPath(sessionId, '/send/settings')))
    .data;
}

export async function saveOutreachV3SendSettings(
  api: AxiosInstance,
  sessionId: string,
  input: { senderConnectionId: string; appendSignature: boolean; attachmentIds: string[] },
) {
  return (
    await api.put<{
      settings: OutreachV3SendSettings;
      idempotent: boolean;
      invalidatedDraftVersionIds: string[];
      invalidationFailures: string[];
    }>(sessionPath(sessionId, '/send/settings'), input)
  ).data;
}

export interface OutreachV3PreflightInput {
  excludedGenerationKeys?: string[];
  testGenerationKey?: string | null;
  acknowledgeHeldOut?: boolean;
}

export async function runOutreachV3Preflight(
  api: AxiosInstance,
  sessionId: string,
  input: OutreachV3PreflightInput,
) {
  return (
    await api.post<OutreachV3ServerPreflight>(sessionPath(sessionId, '/send/preflight'), input)
  ).data;
}

export async function createOutreachV3TestSend(
  api: AxiosInstance,
  sessionId: string,
  input: OutreachV3PreflightInput & { requestKey: string; testGenerationKey: string },
) {
  return (
    await api.post<{
      intentId: string;
      deduped: boolean;
      preflight: OutreachV3ServerPreflight;
    }>(sessionPath(sessionId, '/send/test'), input)
  ).data;
}

export async function createOutreachV3SendIntent(
  api: AxiosInstance,
  sessionId: string,
  input: OutreachV3PreflightInput & { requestKey: string },
) {
  return (
    await api.post<{
      intentId: string;
      deduped: boolean;
      preflight: OutreachV3ServerPreflight;
    }>(sessionPath(sessionId, '/send/intent'), input)
  ).data;
}

export async function getOutreachV3SendIntent(
  api: AxiosInstance,
  sessionId: string,
  intentId: string,
) {
  return (
    await api.get<OutreachV3SendIntentView>(
      sessionPath(sessionId, `/send/intents/${encodeURIComponent(intentId)}`),
    )
  ).data;
}

export async function refreshOutreachV3SendIntent(
  api: AxiosInstance,
  sessionId: string,
  intentId: string,
) {
  return (
    await api.post<OutreachV3SendIntentView>(
      sessionPath(sessionId, `/send/intents/${encodeURIComponent(intentId)}/refresh`),
    )
  ).data;
}

export async function cancelOutreachV3SendIntent(
  api: AxiosInstance,
  sessionId: string,
  intentId: string,
) {
  return (
    await api.post(sessionPath(sessionId, `/send/intents/${encodeURIComponent(intentId)}/cancel`))
  ).data;
}

export async function listSavedOutreachAudiences(api: AxiosInstance) {
  return (await api.get<SavedAudience[]>('/api/engagement/outreach/audiences')).data;
}

export interface CreateSavedOutreachAudienceMemberInput {
  source: 'congress' | 'client_contact' | 'manual';
  sourceRefId?: string;
  name?: string;
  email: string;
  title?: string;
  office?: string;
}

/**
 * The API validates every member with `@IsEmail()` — callers must pre-filter
 * to members with a usable email before calling this, the same way Outreach
 * 2.0's `StepRecipientsSelect` does, or the whole save 400s on one bad row.
 */
export async function createSavedOutreachAudience(
  api: AxiosInstance,
  input: { kind: 'list' | 'group'; name: string; members: CreateSavedOutreachAudienceMemberInput[] },
) {
  return (await api.post<SavedAudience>('/api/engagement/outreach/audiences', input)).data;
}

export async function listOutreachAttachments(
  api: AxiosInstance,
  clientId?: string | null,
): Promise<OutreachAttachment[]> {
  return (
    await api.get<OutreachAttachment[]>('/api/engagement/attachments', {
      params: clientId ? { clientId } : { unlinked: true },
    })
  ).data;
}

export async function uploadOutreachAttachment(
  api: AxiosInstance,
  file: File,
  clientId?: string | null,
): Promise<OutreachAttachment> {
  const contentType = file.type || 'application/octet-stream';
  const upload = (
    await api.post<{ url: string; fields: Record<string, string>; s3Key: string }>(
      '/api/engagement/attachments/upload-url',
      {
        ...(clientId ? { clientId } : {}),
        fileName: file.name,
        contentType,
        contentLength: file.size,
      },
    )
  ).data;
  const form = new FormData();
  Object.entries(upload.fields).forEach(([key, value]) => form.append(key, value));
  form.append('file', file);
  const response = await fetch(upload.url, { method: 'POST', body: form });
  if (!response.ok) throw new Error('Attachment upload failed.');
  return (
    await api.post<OutreachAttachment>('/api/engagement/attachments/confirm', {
      ...(clientId ? { clientId } : {}),
      fileName: file.name,
      contentType,
      s3Key: upload.s3Key,
    })
  ).data;
}

export interface OutreachReplyCandidate {
  id: string;
  fromEmail: string;
  fromName: string | null;
  subject: string | null;
  receivedAt: string;
  excerpt: string;
  clientId: string | null;
  clientName: string | null;
}

export interface OutreachReplyLearningProposalResult {
  candidateId: string;
  status: 'pending_review';
  scope: 'client' | 'firm';
  clientId: string | null;
}

export async function listOutreachReplyCandidates(
  api: AxiosInstance,
  sendIntentId: string,
): Promise<OutreachReplyCandidate[]> {
  return (
    await api.get<OutreachReplyCandidate[]>(
      `/api/memory/proposals/outreach-reply-candidates/${encodeURIComponent(sendIntentId)}`,
    )
  ).data;
}

export async function proposeOutreachReplyLearning(
  api: AxiosInstance,
  input: { sendIntentId: string; mailMessageId: string; learning: string },
): Promise<OutreachReplyLearningProposalResult> {
  return (
    await api.post<OutreachReplyLearningProposalResult>(
      '/api/memory/proposals/outreach-reply',
      input,
    )
  ).data;
}
