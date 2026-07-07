/**
 * Flow-1 funnel API client. Tiny authed fetch wrapper (Clerk bearer token) +
 * typed helpers per onboard-api endpoint + the react-query session hook.
 * Base path is same-origin /onboard-api (Vite dev proxy → localhost:4400).
 */
import { useMemo } from 'react';
import { useAuth } from '@clerk/clerk-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';

// ── Contract types ──────────────────────────────────────────────────────────

export type FunnelState =
  | 'registered'
  | 'verified'
  | 'plan_selected'
  | 'legal_accepted'
  | 'payment_on_file'
  | 'roles_designated'
  | 'import_pref'
  | 'org_setup'
  | 'provisioning'
  | 'provisioned'
  | 'failed';

export type PlanChoice = 'trial' | 'paid';
export type PayMethod = 'card' | 'ach' | 'wire';
export type RoleMode = 'self' | 'invite';
export type ImportMode = 'self' | 'managed';

export interface RoleDesignation {
  email: string;
  role: 'super' | 'admin';
}

export interface OrgAddress {
  street: string;
  city: string;
  state: string;
  zip: string;
}

export interface OrgProfile {
  legalName: string;
  vertical: string;
  teamSize: string;
  timezone: string;
  locale: string;
  address: OrgAddress;
}

export interface FunnelSession {
  state: FunnelState;
  plan: PlanChoice | null;
  payMethod: PayMethod | null;
  profiles: number | null;
  roleMode: RoleMode | null;
  roleDesignations: RoleDesignation[] | null;
  importMode: ImportMode | null;
  itAdminEmails: string[] | null;
  orgProfile: OrgProfile | null;
  slugFinal: string | null;
  tenantId: string | null;
  email: string;
  firstName: string;
  lastName: string;
  orgName: string;
}

export interface LegalDoc {
  docType: 'tos' | 'sa';
  version: string;
  html: string;
}

export interface SubscribeResult {
  subscriptionId: string;
  clientSecret?: string;
  status: string;
  hostedInvoiceUrl?: string;
}

export interface PaidStatusResult {
  status: string;
  advanced: boolean;
}

export interface ProvisionResult {
  state: FunnelState;
  tenantId: string | null;
  slug: string | null;
}

export interface FunnelStatus {
  state: FunnelState;
  tenantId: string | null;
  slug: string | null;
  failureReason: string | null;
}

// ── Fetch wrapper ───────────────────────────────────────────────────────────

type GetToken = () => Promise<string | null>;

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
  if (!res.ok) {
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
    throw new Error(message);
  }
  if (res.status === 204) return undefined;
  return res.json();
}

// ── Typed endpoint helpers ──────────────────────────────────────────────────

export function createFunnelApi(getToken: GetToken) {
  const get = (path: string) => authedFetch(getToken, path);
  const post = (path: string, body?: unknown) =>
    authedFetch(getToken, path, {
      method: 'POST',
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  return {
    register: (body: { firstName: string; lastName: string; orgName: string }) =>
      post('/funnel/register', body) as Promise<FunnelSession>,
    getSession: () => get('/funnel/session') as Promise<FunnelSession>,
    verifyCheck: () => post('/funnel/verify-check') as Promise<{ verified: boolean }>,
    setPlan: (plan: PlanChoice) => post('/funnel/plan', { plan }),
    getLegal: () => get('/funnel/legal') as Promise<LegalDoc[]>,
    acceptLegal: (body: { tosVersion: string; saVersion: string }) =>
      post('/funnel/legal-accept', body),
    createSetupIntent: (method: 'card' | 'ach') =>
      post('/funnel/payment/setup-intent', { method }) as Promise<{ clientSecret: string }>,
    trialComplete: (method: PayMethod) => post('/funnel/payment/trial-complete', { method }),
    subscribe: (body: { profiles: number; method: PayMethod }) =>
      post('/funnel/payment/subscribe', body) as Promise<SubscribeResult>,
    paidStatus: () => post('/funnel/payment/paid-status') as Promise<PaidStatusResult>,
    setRoles: (body: { roleMode: RoleMode; designations: RoleDesignation[] }) =>
      post('/funnel/roles', body),
    setImportPref: (importMode: ImportMode) => post('/funnel/import-pref', { importMode }),
    setOrg: (body: { orgProfile: OrgProfile; itAdminEmail?: string }) => post('/funnel/org', body),
    provision: () => post('/funnel/provision') as Promise<ProvisionResult>,
    getStatus: () => get('/funnel/status') as Promise<FunnelStatus>,
  };
}

export type FunnelApi = ReturnType<typeof createFunnelApi>;

export function useFunnelApi(): FunnelApi {
  const { getToken } = useAuth();
  return useMemo(() => createFunnelApi(getToken), [getToken]);
}

// ── Session hook + cache helpers ────────────────────────────────────────────

export const FUNNEL_SESSION_KEY = ['funnel', 'session'] as const;

export function useFunnelSession(options?: { enabled?: boolean }) {
  const api = useFunnelApi();
  const { isLoaded, isSignedIn } = useAuth();
  return useQuery({
    queryKey: FUNNEL_SESSION_KEY,
    queryFn: () => api.getSession(),
    enabled: isLoaded && !!isSignedIn && (options?.enabled ?? true),
    retry: false,
    staleTime: 5_000,
  });
}

/**
 * Optimistically merge a patch into the cached session (so the step guard
 * lets the navigation through immediately), then refetch the server truth.
 */
export function useAdvanceSession() {
  const queryClient = useQueryClient();
  return (patch: Partial<FunnelSession>) => {
    queryClient.setQueryData<FunnelSession | undefined>(FUNNEL_SESSION_KEY, (old) =>
      old ? { ...old, ...patch } : old,
    );
    void queryClient.invalidateQueries({ queryKey: FUNNEL_SESSION_KEY });
  };
}

// ── Registration form carry-over (survives the /register → /verify hop) ────

const REGISTRATION_STORAGE_KEY = 'capiro-funnel-registration';

export interface RegistrationDraft {
  firstName: string;
  lastName: string;
  orgName: string;
}

export function storeRegistrationDraft(draft: RegistrationDraft): void {
  try {
    sessionStorage.setItem(REGISTRATION_STORAGE_KEY, JSON.stringify(draft));
  } catch {
    /* storage unavailable — the verify page falls back to Clerk profile data */
  }
}

export function readRegistrationDraft(): RegistrationDraft | null {
  try {
    const raw = sessionStorage.getItem(REGISTRATION_STORAGE_KEY);
    return raw ? (JSON.parse(raw) as RegistrationDraft) : null;
  } catch {
    return null;
  }
}

// ── Formatting ──────────────────────────────────────────────────────────────

/** 'MMMM d, yyyy' (e.g. "July 6, 2026") via plain Intl. */
export function formatLongDate(date: Date): string {
  return new Intl.DateTimeFormat('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  }).format(date);
}

/** The dynamic day-31 trial charge date (prototype hardcoded 'August 1, 2026'). */
export function trialChargeDateLabel(now: Date = new Date()): string {
  const day31 = new Date(now);
  day31.setDate(day31.getDate() + 31);
  return formatLongDate(day31);
}
