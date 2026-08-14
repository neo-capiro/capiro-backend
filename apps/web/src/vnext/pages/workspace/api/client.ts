/**
 * Workspace Document Agent vNext — API surface.
 *
 * Authenticated routes are transported through the canonical Clerk-aware
 * client by `transport-bridge.ts`. This file owns endpoint names and typed
 * request/response contracts; it does not invent workflow state.
 */
import type {
  AgentMessage,
  AgentProposal,
  AgentState,
  AgentStateResponse,
  BlueprintSummary,
  BlueprintVersion,
  CatalogResponse,
  Collaborator,
  ContextItem,
  Draft,
  DraftDocument,
  DraftSummary,
  DraftVersion,
  EditLock,
  GenerationMode,
  GenerationStatusResponse,
  OutlineSection,
  PreflightResponse,
  PublicShareDocument,
  QualityResponse,
  RecommendResponse,
  SendMessageRequest,
  SendMessageResponse,
  ShareLinkResponse,
  WorkspaceComment,
  AgentError,
} from '../types/agent.js';

const API_BASE = '/workspace-api';

type PatchAgentData = Partial<
  Pick<AgentState, 'documentType' | 'blueprintPin' | 'theme' | 'goal' | 'phase' | 'status'>
> & {
  generation?: { mode: GenerationMode };
};

async function apiFetch<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    headers: {
      'Content-Type': 'application/json',
      ...options?.headers,
    },
    ...options,
  });

  if (!response.ok) {
    let body: AgentError;
    try {
      body = (await response.json()) as AgentError;
    } catch {
      body = {
        statusCode: response.status,
        message: response.statusText,
        code: String(response.status),
      };
    }
    throw Object.assign(new Error(body.message || response.statusText), {
      statusCode: response.status,
      code: body.code || String(response.status),
      body,
    });
  }

  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

function post<T>(path: string, body?: unknown): Promise<T> {
  return apiFetch<T>(path, {
    method: 'POST',
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function put<T>(path: string, body?: unknown): Promise<T> {
  return apiFetch<T>(path, {
    method: 'PUT',
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function patch<T>(path: string, body?: unknown): Promise<T> {
  return apiFetch<T>(path, {
    method: 'PATCH',
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function del<T>(path: string): Promise<T> {
  return apiFetch<T>(path, { method: 'DELETE' });
}

export const api = {
  getCatalog: (): Promise<CatalogResponse> =>
    apiFetch<CatalogResponse>('/document-agent/catalog'),

  recommend: (goal: string, client?: string): Promise<RecommendResponse> =>
    post<RecommendResponse>('/document-agent/recommend', { goal, client }),

  getAgentState: (draftId: string): Promise<AgentStateResponse> =>
    apiFetch<AgentStateResponse>(`/drafts/${draftId}/agent`),

  initializeAgent: (
    draftId: string,
    data: {
      documentType?: { id: string; label: string; product: string };
      blueprintPin?: {
        blueprintId: string;
        versionId: string;
        version: number;
        definitionHash: string;
      };
      theme?: {
        id: string;
        name: string;
        settings: Record<string, unknown>;
      };
      goal?: string;
    },
  ): Promise<AgentStateResponse> =>
    post<AgentStateResponse>(`/drafts/${draftId}/agent/initialize`, data),

  patchAgent: (
    draftId: string,
    expectedRevision: number,
    data: PatchAgentData,
  ): Promise<AgentStateResponse> =>
    patch<AgentStateResponse>(`/drafts/${draftId}/agent`, {
      expectedRevision,
      ...data,
    }),

  getMessages: (draftId: string): Promise<{ messages: AgentMessage[] }> =>
    apiFetch<{ messages: AgentMessage[] }>(
      `/drafts/${draftId}/agent/messages`,
    ),

  sendMessage: (
    draftId: string,
    data: SendMessageRequest,
  ): Promise<SendMessageResponse> =>
    post<SendMessageResponse>(`/drafts/${draftId}/agent/messages`, data),

  updateBrief: (
    draftId: string,
    expectedRevision: number,
    fields: Record<string, unknown>,
  ): Promise<AgentStateResponse> =>
    put<AgentStateResponse>(`/drafts/${draftId}/agent/brief`, {
      expectedRevision,
      ...fields,
    }),

  synthesizeBrief: (
    draftId: string,
    expectedRevision: number,
  ): Promise<AgentStateResponse> =>
    post<AgentStateResponse>(`/drafts/${draftId}/agent/brief/synthesize`, {
      expectedRevision,
    }),

  approveBrief: (
    draftId: string,
    expectedRevision: number,
  ): Promise<AgentStateResponse> =>
    post<AgentStateResponse>(`/drafts/${draftId}/agent/brief/approve`, {
      expectedRevision,
    }),

  reopenBrief: (
    draftId: string,
    expectedRevision: number,
  ): Promise<AgentStateResponse> =>
    post<AgentStateResponse>(`/drafts/${draftId}/agent/brief/reopen`, {
      expectedRevision,
    }),

  recommendContext: (
    draftId: string,
    expectedRevision: number,
  ): Promise<AgentStateResponse> =>
    post<AgentStateResponse>(`/drafts/${draftId}/agent/context/recommend`, {
      expectedRevision,
    }),

  analyzeContext: (
    draftId: string,
    expectedRevision: number,
  ): Promise<AgentStateResponse> =>
    post<AgentStateResponse>(`/drafts/${draftId}/agent/context/analyze`, {
      expectedRevision,
    }),

  approveContext: (
    draftId: string,
    expectedRevision: number,
  ): Promise<AgentStateResponse> =>
    post<AgentStateResponse>(`/drafts/${draftId}/agent/context/approve`, {
      expectedRevision,
    }),

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

  addContextItem: (
    draftId: string,
    data: Record<string, unknown>,
  ): Promise<unknown> => post<unknown>(`/drafts/${draftId}/context`, data),

  removeContextItem: (draftId: string, itemId: string): Promise<unknown> =>
    del<unknown>(`/drafts/${draftId}/context/${itemId}`),

  generateOutline: (
    draftId: string,
    expectedRevision: number,
  ): Promise<AgentStateResponse> =>
    post<AgentStateResponse>(`/drafts/${draftId}/agent/outline/generate`, {
      expectedRevision,
    }),

  updateOutline: (
    draftId: string,
    expectedRevision: number,
    sections: OutlineSection[],
  ): Promise<AgentStateResponse> =>
    put<AgentStateResponse>(`/drafts/${draftId}/agent/outline`, {
      expectedRevision,
      sections,
    }),

  reviseOutline: (
    draftId: string,
    expectedRevision: number,
    instruction: string,
  ): Promise<{ proposalId: string; type: string }> =>
    post<{ proposalId: string; type: string }>(
      `/drafts/${draftId}/agent/outline/revise`,
      { expectedRevision, instruction },
    ),

  approveOutline: (
    draftId: string,
    expectedRevision: number,
  ): Promise<AgentStateResponse> =>
    post<AgentStateResponse>(`/drafts/${draftId}/agent/outline/approve`, {
      expectedRevision,
    }),

  getProposals: (draftId: string): Promise<{ proposals: AgentProposal[] }> =>
    apiFetch<{ proposals: AgentProposal[] }>(
      `/drafts/${draftId}/agent/proposals`,
    ),

  acceptProposal: (
    draftId: string,
    proposalId: string,
    expectedRevision: number,
  ): Promise<AgentStateResponse> =>
    post<AgentStateResponse>(
      `/drafts/${draftId}/agent/proposals/${proposalId}/accept`,
      { expectedRevision },
    ),

  rejectProposal: (
    draftId: string,
    proposalId: string,
    expectedRevision: number,
    note?: string,
  ): Promise<AgentStateResponse> =>
    post<AgentStateResponse>(
      `/drafts/${draftId}/agent/proposals/${proposalId}/reject`,
      { expectedRevision, note },
    ),

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
    apiFetch<GenerationStatusResponse>(
      `/drafts/${draftId}/agent/generation`,
    ),

  retryGeneration: (
    draftId: string,
    expectedRevision: number,
    sectionIds?: string[],
  ): Promise<AgentStateResponse> =>
    post<AgentStateResponse>(
      `/drafts/${draftId}/agent/generation/retry`,
      { expectedRevision, sectionIds },
    ),

  cancelGeneration: (
    draftId: string,
    expectedRevision: number,
  ): Promise<AgentStateResponse> =>
    post<AgentStateResponse>(
      `/drafts/${draftId}/agent/generation/cancel`,
      { expectedRevision },
    ),

  getQuality: (draftId: string): Promise<QualityResponse> =>
    apiFetch<QualityResponse>(`/drafts/${draftId}/agent/quality`),

  fixIssue: (
    draftId: string,
    issueId: string,
    expectedRevision: number,
    instruction?: string,
  ): Promise<{ proposalId: string }> =>
    post<{ proposalId: string }>(
      `/drafts/${draftId}/agent/quality/issues/${issueId}/fix`,
      { expectedRevision, instruction },
    ),

  preflight: (draftId: string): Promise<PreflightResponse> =>
    post<PreflightResponse>(`/drafts/${draftId}/delivery/preflight`),

  createApprovalRequest: (
    draftId: string,
    params: {
      idempotencyKey?: string;
      notes?: string;
      versionId?: string;
    },
  ): Promise<unknown> =>
    post<unknown>(`/drafts/${draftId}/delivery/approval-requests`, params),

  decideApproval: (
    draftId: string,
    requestId: string,
    decision: 'approved' | 'rejected',
    note?: string,
  ): Promise<unknown> =>
    post<unknown>(
      `/drafts/${draftId}/delivery/approval-requests/${requestId}/decision`,
      { decision, note },
    ),

  createShareLink: (
    draftId: string,
    params: {
      idempotencyKey?: string;
      expiresInDays?: number;
      label?: string;
      versionId?: string;
    },
  ): Promise<ShareLinkResponse> =>
    post<ShareLinkResponse>(`/drafts/${draftId}/delivery/share-links`, params),

  revokeShareLink: (
    draftId: string,
    shareLinkId: string,
  ): Promise<unknown> =>
    del<unknown>(`/drafts/${draftId}/delivery/share-links/${shareLinkId}`),

  getPublicShare: (token: string): Promise<PublicShareDocument> =>
    apiFetch<PublicShareDocument>(
      `/public/workspace-share/${encodeURIComponent(token)}`,
    ),

  addGuestComment: (token: string, text: string): Promise<unknown> =>
    post<unknown>(
      `/public/workspace-share/${encodeURIComponent(token)}/comments`,
      { text },
    ),

  listDrafts: (params?: {
    scope?: 'all' | 'mine' | 'shared' | string;
    sector?: string;
  }): Promise<{ drafts: DraftSummary[] }> => {
    const query = new URLSearchParams();
    if (params?.scope) query.set('scope', params.scope);
    if (params?.sector) query.set('sector', params.sector);
    const suffix = query.toString();
    return apiFetch<{ drafts: DraftSummary[] }>(
      `/drafts${suffix ? `?${suffix}` : ''}`,
    );
  },

  getDraft: (draftId: string): Promise<Draft> =>
    apiFetch<Draft>(`/drafts/${draftId}`),

  createDraft: (data: {
    docTitle?: string;
    industry?: string | null;
    product?: string | null;
    client?: string | null;
    sector?: string;
  }): Promise<{ id: string }> => post<{ id: string }>('/drafts', data),

  deleteDraft: (draftId: string): Promise<unknown> =>
    del<unknown>(`/drafts/${draftId}`),

  getDocuments: (
    draftId: string,
  ): Promise<{ documents: DraftDocument[] }> =>
    apiFetch<{ documents: DraftDocument[] }>(
      `/drafts/${draftId}/documents`,
    ),

  createDocument: (
    draftId: string,
    data: { title?: string; name?: string; ordinal?: number },
  ): Promise<DraftDocument> =>
    post<DraftDocument>(`/drafts/${draftId}/documents`, data),

  patchDocument: (
    draftId: string,
    docId: string,
    data: {
      title?: string;
      name?: string;
      ordinal?: number;
      body?: string | Record<string, unknown>;
    },
  ): Promise<DraftDocument> =>
    patch<DraftDocument>(`/drafts/${draftId}/documents/${docId}`, data),

  deleteDocument: (draftId: string, docId: string): Promise<unknown> =>
    del<unknown>(`/drafts/${draftId}/documents/${docId}`),

  getComments: (
    documentId: string,
  ): Promise<{ comments: WorkspaceComment[] }> =>
    apiFetch<{ comments: WorkspaceComment[] }>(
      `/documents/${documentId}/comments`,
    ),

  addComment: (
    documentId: string,
    data: {
      text?: string;
      body?: string;
      parentId?: string;
      quote?: string;
      anchor?: Record<string, unknown>;
    },
  ): Promise<WorkspaceComment> =>
    post<WorkspaceComment>(`/documents/${documentId}/comments`, data),

  patchComment: (
    documentId: string,
    commentId: string,
    data: { resolved?: boolean; text?: string; body?: string },
  ): Promise<WorkspaceComment> =>
    patch<WorkspaceComment>(
      `/documents/${documentId}/comments/${commentId}`,
      data,
    ),

  deleteComment: (
    documentId: string,
    commentId: string,
  ): Promise<unknown> =>
    del<unknown>(`/documents/${documentId}/comments/${commentId}`),

  suggestEdit: (documentId: string, commentId: string): Promise<unknown> =>
    post<unknown>(
      `/documents/${documentId}/comments/${commentId}/suggest`,
    ),

  getCollaborators: (
    draftId: string,
  ): Promise<{ collaborators: Collaborator[] }> =>
    apiFetch<{ collaborators: Collaborator[] }>(
      `/drafts/${draftId}/collaborators`,
    ),

  addCollaborator: (
    draftId: string,
    data: {
      subjectId?: string;
      email?: string;
      name?: string;
      role: string;
    },
  ): Promise<Collaborator> =>
    post<Collaborator>(`/drafts/${draftId}/collaborators`, data),

  updateCollaborator: (
    draftId: string,
    collaboratorId: string,
    data: { role?: string },
  ): Promise<Collaborator> =>
    patch<Collaborator>(
      `/drafts/${draftId}/collaborators/${collaboratorId}`,
      data,
    ),

  removeCollaborator: (
    draftId: string,
    collaboratorId: string,
  ): Promise<unknown> =>
    del<unknown>(
      `/drafts/${draftId}/collaborators/${collaboratorId}`,
    ),

  getVersions: (draftId: string): Promise<{ versions: DraftVersion[] }> =>
    apiFetch<{ versions: DraftVersion[] }>(`/drafts/${draftId}/versions`),

  createVersion: (
    draftId: string,
    data: { label?: string; authorKind?: 'meri' | 'person' },
  ): Promise<DraftVersion> =>
    post<DraftVersion>(`/drafts/${draftId}/versions`, data),

  restoreVersion: (draftId: string, versionId: string): Promise<unknown> =>
    post<unknown>(`/drafts/${draftId}/versions/${versionId}/restore`),

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

  exportDocx: (draftId: string, part?: string): string =>
    `${API_BASE}/drafts/${draftId}/export/docx${
      part ? `?part=${encodeURIComponent(part)}` : ''
    }`,

  exportPdf: (draftId: string, part?: string): string =>
    `${API_BASE}/drafts/${draftId}/export/pdf${
      part ? `?part=${encodeURIComponent(part)}` : ''
    }`,

  listBlueprints: (): Promise<{ blueprints: BlueprintSummary[] }> =>
    apiFetch<{ blueprints: BlueprintSummary[] }>(
      '/template-studio/blueprints',
    ),

  getBlueprint: (
    blueprintId: string,
  ): Promise<BlueprintSummary & { versions: BlueprintVersion[] }> =>
    apiFetch<BlueprintSummary & { versions: BlueprintVersion[] }>(
      `/template-studio/blueprints/${blueprintId}`,
    ),

  createBlueprint: (
    data: Record<string, unknown>,
  ): Promise<BlueprintSummary> =>
    post<BlueprintSummary>('/template-studio/blueprints', data),

  cloneBlueprint: (
    blueprintId: string,
    data?: Record<string, unknown>,
  ): Promise<BlueprintVersion> =>
    post<BlueprintVersion>(
      `/template-studio/blueprints/${blueprintId}/clone`,
      data,
    ),

  createBlueprintVersion: (
    blueprintId: string,
    data?: Record<string, unknown>,
  ): Promise<BlueprintVersion> =>
    post<BlueprintVersion>(
      `/template-studio/blueprints/${blueprintId}/versions`,
      data,
    ),

  getVersion: (
    blueprintId: string,
    versionId: string,
  ): Promise<BlueprintVersion> =>
    apiFetch<BlueprintVersion>(
      `/template-studio/blueprints/${blueprintId}/versions/${versionId}`,
    ),

  updateVersion: (
    blueprintId: string,
    versionId: string,
    data: Record<string, unknown>,
  ): Promise<BlueprintVersion> =>
    patch<BlueprintVersion>(
      `/template-studio/blueprints/${blueprintId}/versions/${versionId}`,
      data,
    ),

  testVersion: (blueprintId: string, versionId: string): Promise<unknown> =>
    post<unknown>(
      `/template-studio/blueprints/${blueprintId}/versions/${versionId}/test`,
    ),

  publishVersion: (
    blueprintId: string,
    versionId: string,
  ): Promise<BlueprintVersion> =>
    post<BlueprintVersion>(
      `/template-studio/blueprints/${blueprintId}/versions/${versionId}/publish`,
    ),

  retireVersion: (
    blueprintId: string,
    versionId: string,
  ): Promise<BlueprintVersion> =>
    post<BlueprintVersion>(
      `/template-studio/blueprints/${blueprintId}/versions/${versionId}/retire`,
    ),

  compareVersions: (blueprintId: string): Promise<unknown> =>
    apiFetch<unknown>(
      `/template-studio/blueprints/${blueprintId}/compare`,
    ),

  detectAnonymize: (draftId: string): Promise<unknown> =>
    post<unknown>(`/drafts/${draftId}/anonymize/detect`),

  promoteToMemory: (draftId: string): Promise<unknown> =>
    post<unknown>(`/drafts/${draftId}/promote-memory`),
};
