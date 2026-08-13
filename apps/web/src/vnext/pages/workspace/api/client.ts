/**
 * Workspace Document Agent vNext — API client layer.
 * All routes are under /workspace-api (the existing Workspace prefix).
 * Every mutation that requires expectedRevision reads it from the cached state
 * immediately before the call — never from a component prop captured at mount.
 */

import type {
  AgentState,
  AgentStateResponse,
  AgentMessage,
  SendMessageRequest,
  SendMessageResponse,
  AgentProposal,
  QualityResponse,
  GenerationStatusResponse,
  ContextItem,
  DraftSummary,
  Draft,
  DraftDocument,
  RecommendResponse,
  CatalogResponse,
  BlueprintSummary,
  BlueprintVersion,
  PreflightResponse,
  ShareLinkResponse,
  PublicShareDocument,
  AgentError,
  GenerationMode,
  OutlineSection,
  WorkspaceComment,
  Collaborator,
  DraftVersion,
  EditLock,
} from '../types/agent.js';

const API_BASE = '/workspace-api';

// ── Fetch wrapper ────────────────────────────────────────────────────────────

async function apiFetch<T>(
  path: string,
  options?: RequestInit,
): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: {
      'Content-Type': 'application/json',
      ...options?.headers,
    },
    ...options,
  });

  if (!res.ok) {
    let errorBody: AgentError;
    try {
      errorBody = await res.json();
    } catch {
      errorBody = {
        statusCode: res.status,
        message: res.statusText,
        code: String(res.status),
      };
    }
    throw Object.assign(new Error(errorBody.message || res.statusText), {
      statusCode: res.status,
      code: errorBody.code || String(res.status),
      body: errorBody,
    });
  }

  // 204 No Content
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

function post<T>(path: string, body?: unknown): Promise<T> {
  return apiFetch<T>(path, { method: 'POST', body: body ? JSON.stringify(body) : undefined });
}

function put<T>(path: string, body?: unknown): Promise<T> {
  return apiFetch<T>(path, { method: 'PUT', body: body ? JSON.stringify(body) : undefined });
}

function patch<T>(path: string, body?: unknown): Promise<T> {
  return apiFetch<T>(path, { method: 'PATCH', body: body ? JSON.stringify(body) : undefined });
}

function del<T>(path: string): Promise<T> {
  return apiFetch<T>(path, { method: 'DELETE' });
}

// ── Catalog & Recommendation ────────────────────────────────────────────────

export const api = {
  // Catalog
  getCatalog: (): Promise<CatalogResponse> =>
    apiFetch<CatalogResponse>('/document-agent/catalog'),

  recommend: (goal: string, client?: string): Promise<RecommendResponse> =>
    post<RecommendResponse>('/document-agent/recommend', { goal, client }),

  // Agent state
  getAgentState: (draftId: string): Promise<AgentStateResponse> =>
    apiFetch<AgentStateResponse>(`/drafts/${draftId}/agent`),

  initializeAgent: (
    draftId: string,
    data: {
      documentType?: { id: string; label: string; product: string };
      blueprintPin?: { blueprintId: string; versionId: string; version: number; definitionHash: string };
      theme?: { id: string; name: string; settings: Record<string, unknown> };
      goal?: string;
    },
  ): Promise<AgentStateResponse> =>
    post<AgentStateResponse>(`/drafts/${draftId}/agent/initialize`, data),

  patchAgent: (
    draftId: string,
    expectedRevision: number,
    data: Record<string, unknown>,
  ): Promise<AgentStateResponse> =>
    patch<AgentStateResponse>(`/drafts/${draftId}/agent`, { expectedRevision, ...data }),

  // Messages
  getMessages: (draftId: string): Promise<{ messages: AgentMessage[] }> =>
    apiFetch<{ messages: AgentMessage[] }>(`/drafts/${draftId}/agent/messages`),

  sendMessage: (draftId: string, data: SendMessageRequest): Promise<SendMessageResponse> =>
    post<SendMessageResponse>(`/drafts/${draftId}/agent/messages`, data),

  // Brief
  updateBrief: (
    draftId: string,
    expectedRevision: number,
    fields: Record<string, unknown>,
  ): Promise<AgentStateResponse> =>
    put<AgentStateResponse>(`/drafts/${draftId}/agent/brief`, { expectedRevision, ...fields }),

  synthesizeBrief: (draftId: string, expectedRevision: number): Promise<AgentStateResponse> =>
    post<AgentStateResponse>(`/drafts/${draftId}/agent/brief/synthesize`, { expectedRevision }),

  approveBrief: (draftId: string, expectedRevision: number): Promise<AgentStateResponse> =>
    post<AgentStateResponse>(`/drafts/${draftId}/agent/brief/approve`, { expectedRevision }),

  reopenBrief: (draftId: string, expectedRevision: number): Promise<AgentStateResponse> =>
    post<AgentStateResponse>(`/drafts/${draftId}/agent/brief/reopen`, { expectedRevision }),

  // Context
  recommendContext: (draftId: string, expectedRevision: number): Promise<AgentStateResponse> =>
    post<AgentStateResponse>(`/drafts/${draftId}/agent/context/recommend`, { expectedRevision }),

  analyzeContext: (draftId: string, expectedRevision: number): Promise<AgentStateResponse> =>
    post<AgentStateResponse>(`/drafts/${draftId}/agent/context/analyze`, { expectedRevision }),

  approveContext: (draftId: string, expectedRevision: number): Promise<AgentStateResponse> =>
    post<AgentStateResponse>(`/drafts/${draftId}/agent/context/approve`, { expectedRevision }),

  patchContextItem: (
    draftId: string,
    itemId: string,
    payload: Record<string, unknown>,
  ): Promise<unknown> =>
    patch<unknown>(`/drafts/${draftId}/context/${itemId}`, { payload }),

  getContext: (draftId: string): Promise<{ items: ContextItem[] }> =>
    apiFetch<{ items: ContextItem[] }>(`/drafts/${draftId}/context`),

  getContextUsed: (draftId: string): Promise<unknown> =>
    apiFetch<unknown>(`/drafts/${draftId}/context-used`),

  addContextItem: (draftId: string, data: Record<string, unknown>): Promise<unknown> =>
    post<unknown>(`/drafts/${draftId}/context`, data),

  removeContextItem: (draftId: string, itemId: string): Promise<unknown> =>
    del<unknown>(`/drafts/${draftId}/context/${itemId}`),

  // Outline
  generateOutline: (draftId: string, expectedRevision: number): Promise<AgentStateResponse> =>
    post<AgentStateResponse>(`/drafts/${draftId}/agent/outline/generate`, { expectedRevision }),

  updateOutline: (
    draftId: string,
    expectedRevision: number,
    sections: OutlineSection[],
  ): Promise<AgentStateResponse> =>
    put<AgentStateResponse>(`/drafts/${draftId}/agent/outline`, { expectedRevision, sections }),

  reviseOutline: (
    draftId: string,
    expectedRevision: number,
    instruction: string,
  ): Promise<{ proposalId: string; type: string }> =>
    post<{ proposalId: string; type: string }>(`/drafts/${draftId}/agent/outline/revise`, {
      expectedRevision,
      instruction,
    }),

  approveOutline: (draftId: string, expectedRevision: number): Promise<AgentStateResponse> =>
    post<AgentStateResponse>(`/drafts/${draftId}/agent/outline/approve`, { expectedRevision }),

  // Proposals
  getProposals: (draftId: string): Promise<{ proposals: AgentProposal[] }> =>
    apiFetch<{ proposals: AgentProposal[] }>(`/drafts/${draftId}/agent/proposals`),

  acceptProposal: (draftId: string, proposalId: string, expectedRevision: number): Promise<AgentStateResponse> =>
    post<AgentStateResponse>(`/drafts/${draftId}/agent/proposals/${proposalId}/accept`, { expectedRevision }),

  rejectProposal: (
    draftId: string,
    proposalId: string,
    expectedRevision: number,
    note?: string,
  ): Promise<AgentStateResponse> =>
    post<AgentStateResponse>(`/drafts/${draftId}/agent/proposals/${proposalId}/reject`, {
      expectedRevision,
      note,
    }),

  // Generation
  generate: (
    draftId: string,
    expectedRevision: number,
    mode: GenerationMode,
    idempotencyKey?: string,
  ): Promise<AgentStateResponse> =>
    post<AgentStateResponse>(`/drafts/${draftId}/agent/generate`, {
      expectedRevision,
      mode,
      idempotencyKey,
    }),

  getGeneration: (draftId: string): Promise<GenerationStatusResponse> =>
    apiFetch<GenerationStatusResponse>(`/drafts/${draftId}/agent/generation`),

  retryGeneration: (
    draftId: string,
    expectedRevision: number,
    sectionIds?: string[],
  ): Promise<AgentStateResponse> =>
    post<AgentStateResponse>(`/drafts/${draftId}/agent/generation/retry`, {
      expectedRevision,
      sectionIds,
    }),

  cancelGeneration: (draftId: string, expectedRevision: number): Promise<AgentStateResponse> =>
    post<AgentStateResponse>(`/drafts/${draftId}/agent/generation/cancel`, { expectedRevision }),

  // Quality
  getQuality: (draftId: string): Promise<QualityResponse> =>
    apiFetch<QualityResponse>(`/drafts/${draftId}/agent/quality`),

  fixIssue: (
    draftId: string,
    issueId: string,
    expectedRevision: number,
    instruction?: string,
  ): Promise<{ proposalId: string }> =>
    post<{ proposalId: string }>(`/drafts/${draftId}/agent/quality/issues/${issueId}/fix`, {
      expectedRevision,
      instruction,
    }),

  // Delivery
  preflight: (draftId: string): Promise<PreflightResponse> =>
    post<PreflightResponse>(`/drafts/${draftId}/delivery/preflight`),

  createApprovalRequest: (
    draftId: string,
    params: { idempotencyKey?: string; notes?: string; versionId?: string },
  ): Promise<unknown> =>
    post<unknown>(`/drafts/${draftId}/delivery/approval-requests`, params),

  decideApproval: (
    draftId: string,
    requestId: string,
    decision: 'approved' | 'rejected',
    note?: string,
  ): Promise<unknown> =>
    post<unknown>(`/drafts/${draftId}/delivery/approval-requests/${requestId}/decision`, {
      decision,
      note,
    }),

  createShareLink: (
    draftId: string,
    params: { idempotencyKey?: string; expiresInDays?: number; label?: string; versionId?: string },
  ): Promise<ShareLinkResponse> =>
    post<ShareLinkResponse>(`/drafts/${draftId}/delivery/share-links`, params),

  revokeShareLink: (draftId: string, shareLinkId: string): Promise<unknown> =>
    del<unknown>(`/drafts/${draftId}/delivery/share-links/${shareLinkId}`),

  // Public share (no auth)
  getPublicShare: (token: string): Promise<PublicShareDocument> =>
    apiFetch<PublicShareDocument>(`/public/workspace-share/${token}`),

  addGuestComment: (token: string, text: string): Promise<unknown> =>
    post<unknown>(`/public/workspace-share/${token}/comments`, { text }),

  // Drafts
  listDrafts: (params?: { scope?: string; sector?: string }): Promise<{ drafts: DraftSummary[] }> => {
    const qs = new URLSearchParams();
    if (params?.scope) qs.set('scope', params.scope);
    if (params?.sector) qs.set('sector', params.sector);
    const q = qs.toString();
    return apiFetch<{ drafts: DraftSummary[] }>(`/drafts${q ? `?${q}` : ''}`);
  },

  getDraft: (draftId: string): Promise<Draft> =>
    apiFetch<Draft>(`/drafts/${draftId}`),

  createDraft: (data: { docTitle?: string; sector?: string }): Promise<{ id: string }> =>
    post<{ id: string }>('/drafts', data),

  deleteDraft: (draftId: string): Promise<unknown> =>
    del<unknown>(`/drafts/${draftId}`),

  // Documents
  getDocuments: (draftId: string): Promise<{ documents: DraftDocument[] }> =>
    apiFetch<{ documents: DraftDocument[] }>(`/drafts/${draftId}/documents`),

  createDocument: (draftId: string, data: { title: string }): Promise<DraftDocument> =>
    post<DraftDocument>(`/drafts/${draftId}/documents`, data),

  patchDocument: (
    draftId: string,
    docId: string,
    data: { title?: string; body?: string },
  ): Promise<DraftDocument> =>
    patch<DraftDocument>(`/drafts/${draftId}/documents/${docId}`, data),

  deleteDocument: (draftId: string, docId: string): Promise<unknown> =>
    del<unknown>(`/drafts/${draftId}/documents/${docId}`),

  // Comments
  getComments: (documentId: string): Promise<{ comments: WorkspaceComment[] }> =>
    apiFetch<{ comments: WorkspaceComment[] }>(`/documents/${documentId}/comments`),

  addComment: (
    documentId: string,
    data: { text: string; parentId?: string },
  ): Promise<WorkspaceComment> =>
    post<WorkspaceComment>(`/documents/${documentId}/comments`, data),

  patchComment: (
    documentId: string,
    commentId: string,
    data: { resolved?: boolean; text?: string },
  ): Promise<WorkspaceComment> =>
    patch<WorkspaceComment>(`/documents/${documentId}/comments/${commentId}`, data),

  deleteComment: (documentId: string, commentId: string): Promise<unknown> =>
    del<unknown>(`/documents/${documentId}/comments/${commentId}`),

  suggestEdit: (
    documentId: string,
    commentId: string,
  ): Promise<unknown> =>
    post<unknown>(`/documents/${documentId}/comments/${commentId}/suggest`),

  // Collaborators
  getCollaborators: (draftId: string): Promise<{ collaborators: Collaborator[] }> =>
    apiFetch<{ collaborators: Collaborator[] }>(`/drafts/${draftId}/collaborators`),

  addCollaborator: (
    draftId: string,
    data: { email: string; role: string },
  ): Promise<Collaborator> =>
    post<Collaborator>(`/drafts/${draftId}/collaborators`, data),

  updateCollaborator: (
    draftId: string,
    collaboratorId: string,
    data: { role?: string },
  ): Promise<Collaborator> =>
    patch<Collaborator>(`/drafts/${draftId}/collaborators/${collaboratorId}`, data),

  removeCollaborator: (draftId: string, collaboratorId: string): Promise<unknown> =>
    del<unknown>(`/drafts/${draftId}/collaborators/${collaboratorId}`),

  // Versions
  getVersions: (draftId: string): Promise<{ versions: DraftVersion[] }> =>
    apiFetch<{ versions: DraftVersion[] }>(`/drafts/${draftId}/versions`),

  createVersion: (draftId: string, data: { label?: string }): Promise<DraftVersion> =>
    post<DraftVersion>(`/drafts/${draftId}/versions`, data),

  restoreVersion: (draftId: string, versionId: string): Promise<unknown> =>
    post<unknown>(`/drafts/${draftId}/versions/${versionId}/restore`),

  // Edit Lock
  getLock: (draftId: string): Promise<EditLock> =>
    apiFetch<EditLock>(`/drafts/${draftId}/lock`),

  acquireLock: (draftId: string): Promise<EditLock> =>
    post<EditLock>(`/drafts/${draftId}/lock/acquire`),

  heartbeat: (draftId: string): Promise<unknown> =>
    post<unknown>(`/drafts/${draftId}/lock/heartbeat`),

  releaseLock: (draftId: string): Promise<unknown> =>
    post<unknown>(`/drafts/${draftId}/lock/release`),

  requestLock: (draftId: string): Promise<unknown> =>
    post<unknown>(`/drafts/${draftId}/lock/request`),

  takeOverLock: (draftId: string): Promise<EditLock> =>
    post<EditLock>(`/drafts/${draftId}/lock/take-over`),

  // Export
  exportDocx: (draftId: string, part?: string): string =>
    `${API_BASE}/drafts/${draftId}/export/docx${part ? `?part=${part}` : ''}`,

  exportPdf: (draftId: string, part?: string): string =>
    `${API_BASE}/drafts/${draftId}/export/pdf${part ? `?part=${part}` : ''}`,

  // Template Studio — Blueprints
  listBlueprints: (): Promise<{ blueprints: BlueprintSummary[] }> =>
    apiFetch<{ blueprints: BlueprintSummary[] }>('/template-studio/blueprints'),

  getBlueprint: (blueprintId: string): Promise<BlueprintSummary & { versions: BlueprintVersion[] }> =>
    apiFetch<BlueprintSummary & { versions: BlueprintVersion[] }>(`/template-studio/blueprints/${blueprintId}`),

  createBlueprint: (data: Record<string, unknown>): Promise<BlueprintSummary> =>
    post<BlueprintSummary>('/template-studio/blueprints', data),

  cloneBlueprint: (blueprintId: string, data?: Record<string, unknown>): Promise<BlueprintVersion> =>
    post<BlueprintVersion>(`/template-studio/blueprints/${blueprintId}/clone`, data),

  createBlueprintVersion: (blueprintId: string, data?: Record<string, unknown>): Promise<BlueprintVersion> =>
    post<BlueprintVersion>(`/template-studio/blueprints/${blueprintId}/versions`, data),

  getVersion: (blueprintId: string, versionId: string): Promise<BlueprintVersion> =>
    apiFetch<BlueprintVersion>(`/template-studio/blueprints/${blueprintId}/versions/${versionId}`),

  updateVersion: (
    blueprintId: string,
    versionId: string,
    data: Record<string, unknown>,
  ): Promise<BlueprintVersion> =>
    patch<BlueprintVersion>(`/template-studio/blueprints/${blueprintId}/versions/${versionId}`, data),

  testVersion: (blueprintId: string, versionId: string): Promise<unknown> =>
    post<unknown>(`/template-studio/blueprints/${blueprintId}/versions/${versionId}/test`),

  publishVersion: (blueprintId: string, versionId: string): Promise<BlueprintVersion> =>
    post<BlueprintVersion>(`/template-studio/blueprints/${blueprintId}/versions/${versionId}/publish`),

  retireVersion: (blueprintId: string, versionId: string): Promise<BlueprintVersion> =>
    post<BlueprintVersion>(`/template-studio/blueprints/${blueprintId}/versions/${versionId}/retire`),

  compareVersions: (blueprintId: string): Promise<unknown> =>
    apiFetch<unknown>(`/template-studio/blueprints/${blueprintId}/compare`),

  // Anonymize
  detectAnonymize: (draftId: string): Promise<unknown> =>
    post<unknown>(`/drafts/${draftId}/anonymize/detect`),

  // Promote to memory
  promoteToMemory: (draftId: string): Promise<unknown> =>
    post<unknown>(`/drafts/${draftId}/promote-memory`),
};
