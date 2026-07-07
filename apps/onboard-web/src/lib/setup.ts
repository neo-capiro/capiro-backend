/**
 * Flow-2A setup dashboard API client: onboard-api /setup/* (Clerk bearer,
 * same-origin — same authedFetch pattern as lib/funnel.ts) plus the
 * unauthenticated /it/* invite endpoints (the emailed token IS the credential).
 */
import { useMemo } from 'react';
import { useAuth } from '@clerk/clerk-react';
import { useQuery } from '@tanstack/react-query';

// ── Contract types ──────────────────────────────────────────────────────────

export type SetupTaskKey = 'it_email' | 'import' | 'firm_ai' | 'invites';
export type SetupTaskStatus = 'none' | 'waiting' | 'verifying' | 'done';

export interface SetupItInvite {
  id: string;
  email: string;
  status: string;
  provider: string | null;
  expiresAt: string;
}

export interface SetupState {
  complete: boolean;
  tasks: Record<SetupTaskKey, SetupTaskStatus>;
  orgName: string;
  slug: string;
  plan: 'trial' | 'paid';
  imported: number;
  cap: number;
  trialEndsAt: string | null;
  itInvites: SetupItInvite[];
}

export interface ItInviteView {
  orgName: string;
  email: string;
  status: string;
  provider: string | null;
}

// ── Fetch wrapper ───────────────────────────────────────────────────────────

/** Error carrying the HTTP status (409 = CAS race, 402 = slot cap, 400 = blockers). */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function toApiError(res: Response): Promise<ApiError> {
  let message = `Request failed (${res.status})`;
  try {
    const text = await res.text();
    if (text) {
      try {
        const parsed = JSON.parse(text) as { error?: string; message?: string };
        message = parsed.error || parsed.message || text;
      } catch {
        message = text;
      }
    }
  } catch {
    /* keep the default message */
  }
  return new ApiError(message, res.status);
}

type GetToken = (options?: { template?: string }) => Promise<string | null>;

async function authedFetch(
  getToken: GetToken,
  path: string,
  opts: RequestInit = {},
): Promise<unknown> {
  const token = await getToken();
  const headers: Record<string, string> = {
    ...(opts.headers as Record<string, string> | undefined),
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (opts.body != null) headers['Content-Type'] = 'application/json';
  const res = await fetch(`/onboard-api${path}`, { ...opts, headers });
  if (!res.ok) throw await toApiError(res);
  if (res.status === 204) return undefined;
  return res.json();
}

// ── Typed endpoint helpers ──────────────────────────────────────────────────

export function createSetupApi(getToken: GetToken) {
  const get = (path: string) => authedFetch(getToken, path);
  const post = (path: string, body?: unknown) =>
    authedFetch(getToken, path, {
      method: 'POST',
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  return {
    getState: () => get('/setup/state') as Promise<SetupState>,
    /** Compare-and-set — a 409 means another admin moved it (refetch + reconcile). */
    transitionTask: (task: SetupTaskKey, from: SetupTaskStatus, to: SetupTaskStatus) =>
      post(`/setup/tasks/${task}/transition`, { from, to }) as Promise<{
        task: SetupTaskKey;
        status: SetupTaskStatus;
      }>,
    createItInvite: (email: string) =>
      post('/setup/it-invites', { email }) as Promise<SetupItInvite[]>,
    resendItInvite: (inviteId: string) =>
      post(`/setup/it-invites/${inviteId}/resend`) as Promise<{ ok: true }>,
    completeSetup: () => post('/setup/complete') as Promise<SetupState>,
  };
}

export type SetupApi = ReturnType<typeof createSetupApi>;

export function useSetupApi(): SetupApi {
  const { getToken } = useAuth();
  return useMemo(() => createSetupApi(getToken), [getToken]);
}

// ── State hook ──────────────────────────────────────────────────────────────

export const SETUP_STATE_KEY = ['setup', 'state'] as const;

/**
 * The dashboard's source of truth. Polls every 5s while the IT-email task is
 * 'waiting' — the org-wide grant lands from the IT admin's browser, not ours.
 */
export function useSetupState(options?: { enabled?: boolean }) {
  const api = useSetupApi();
  const { isLoaded, isSignedIn } = useAuth();
  return useQuery({
    queryKey: SETUP_STATE_KEY,
    queryFn: () => api.getState(),
    enabled: isLoaded && !!isSignedIn && (options?.enabled ?? true),
    retry: false,
    refetchInterval: (query) => (query.state.data?.tasks.it_email === 'waiting' ? 5_000 : false),
  });
}

// ── IT-admin path (unauthenticated — the token in the URL is the credential) ─

export async function fetchItInvite(token: string): Promise<ItInviteView> {
  const res = await fetch(`/onboard-api/it/invite/${encodeURIComponent(token)}`);
  if (!res.ok) throw await toApiError(res);
  return (await res.json()) as ItInviteView;
}

export async function fetchItConsentUrl(
  token: string,
  provider: 'microsoft',
): Promise<{ url: string }> {
  const res = await fetch(`/onboard-api/it/invite/${encodeURIComponent(token)}/consent-url`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider }),
  });
  if (!res.ok) throw await toApiError(res);
  return (await res.json()) as { url: string };
}
