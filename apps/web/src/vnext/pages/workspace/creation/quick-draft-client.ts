import type { AgentStateResponse } from '../types/agent.js';

export type QuickDraftSourcePurpose =
  | 'context'
  | 'client_saved'
  | 'sample'
  | 'system';

export interface QuickDraftSource {
  purpose: QuickDraftSourcePurpose;
  label: string;
  text?: string;
  refId?: string;
  url?: string;
  sourceType?: string;
  metadata?: Record<string, unknown>;
}

export interface QuickDraftResponse {
  state: AgentStateResponse['state'];
  run: {
    runId: string;
    mode: 'max';
    status:
      | 'active'
      | 'complete'
      | 'complete_with_warnings'
      | 'partial'
      | 'failed';
  };
  draft: { id: string; docTitle: string };
  sourceSummary: {
    total: number;
    factual: number;
    samples: number;
    system: number;
  };
}

interface ApiErrorBody {
  message?: string;
  code?: string;
  statusCode?: number;
}

export async function generateFromIntake(
  draftId: string,
  input: {
    expectedRevision: number;
    goal: string;
    sources: QuickDraftSource[];
  },
): Promise<QuickDraftResponse> {
  // WorkspaceVNextRoutes installs the Clerk-aware transport bridge for every
  // authenticated /workspace route. Keeping this request under /workspace-api
  // gives it the same bearer token, impersonation, and 401 behavior as the
  // existing Document Agent client.
  const response = await fetch(
    `/workspace-api/drafts/${encodeURIComponent(draftId)}/agent/generate-from-intake`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    },
  );
  if (!response.ok) {
    let body: ApiErrorBody = {};
    try {
      body = (await response.json()) as ApiErrorBody;
    } catch {
      // Preserve the HTTP status fallback when the response is not JSON.
    }
    throw Object.assign(
      new Error(body.message || response.statusText || 'Could not generate the first draft.'),
      {
        statusCode: response.status,
        code: body.code || String(response.status),
        body,
      },
    );
  }
  return response.json() as Promise<QuickDraftResponse>;
}
