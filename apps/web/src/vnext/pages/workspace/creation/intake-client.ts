/**
 * Two-step Max draft flow — API client for the aggregate intake endpoint.
 *
 * The browser sends only identifiers — never server-backed source bodies.
 * The backend re-fetches and authorizes every selected ID.
 */

export interface IntakeRequest {
  goal: string;
  clientId?: string;
  blueprintVersionId: string;
  factualAttachmentIds: string[];
  sampleAttachmentIds: string[];
  priorWorkspaceDraftIds: string[];
  selectedContextItemIds?: string[];
  selectedContextDomains?: string[];
  pastedContext?: string;
  pastedSample?: string;
  title?: string;
  audience?: string;
  tone?: string;
  deadline?: string;
  lengthInstruction?: string;
}

export interface IntakeResponse {
  draftId: string;
  runId: string;
  status: 'queued' | 'active';
  agentRevision: number;
}

export interface RunStatusResponse {
  runId: string;
  status: string;
  stage: string;
  stages: Array<{
    name: string;
    status: string;
    startedAt?: string;
    completedAt?: string;
    detail?: string;
  }>;
  sectionStates: Record<
    string,
    {
      status: string;
      error?: string;
      contentHash?: string;
      citations?: Array<{
        n: number;
        token: string;
        kind: string;
        refId: string;
        label: string;
      }>;
    }
  >;
  provider?: string;
  model?: string;
  reasoningLevel?: string;
  errorMessage?: string;
  startedAt?: string;
  completedAt?: string;
}

export interface TwoStepDraftCapability {
  enabled: boolean;
}

interface ApiErrorBody {
  message?: string;
  code?: string;
  statusCode?: number;
}

/**
 * Submit the aggregate intake. Returns 202 with draftId + runId after the
 * draft, source selections, run, and durable job are persisted.
 */
export async function submitIntake(
  input: IntakeRequest,
  idempotencyKey: string,
): Promise<IntakeResponse> {
  const response = await fetch(
    '/workspace-api/document-agent/intakes',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': idempotencyKey,
      },
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
      new Error(body.message || response.statusText || 'Could not start the draft.'),
      {
        statusCode: response.status,
        code: body.code || String(response.status),
        body,
      },
    );
  }
  return response.json() as Promise<IntakeResponse>;
}

/**
 * Poll the durable run status. Used by the editor to hydrate real stages
 * and per-section state from the server.
 */
export async function getRunStatus(
  runId: string,
): Promise<RunStatusResponse> {
  const response = await fetch(
    `/workspace-api/document-agent/runs/${encodeURIComponent(runId)}/status`,
  );
  if (!response.ok) {
    throw Object.assign(
      new Error(response.statusText || 'Could not fetch run status.'),
      { statusCode: response.status },
    );
  }
  return response.json() as Promise<RunStatusResponse>;
}

/**
 * Check if the two-step Max draft flow is enabled for the current tenant.
 */
export async function getTwoStepDraftCapability(): Promise<TwoStepDraftCapability> {
  const response = await fetch(
    '/workspace-api/document-agent/two-step-draft-capability',
  );
  if (!response.ok) {
    return { enabled: false };
  }
  return response.json() as Promise<TwoStepDraftCapability>;
}
