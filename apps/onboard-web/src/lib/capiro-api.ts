/**
 * apps/api client for the setup dashboard (cross-origin — base is
 * useConfig().apiBaseUrl; CORS for the onboarding origin is already allowed).
 * Same authedFetch pattern as lib/setup.ts, but tokens are minted with the
 * `capiro` Clerk JWT template (tenant claims — the same template apps/web uses).
 */
import { useMemo } from 'react';
import { useAuth } from '@clerk/clerk-react';
import { useQuery } from '@tanstack/react-query';
import { useConfig } from '../useConfig';
import { ApiError } from './setup';

// ── Contract types ──────────────────────────────────────────────────────────

export interface RegistrantHit {
  id: number;
  name: string;
  city: string | null;
  state: string | null;
  totalClients: number;
  totalFilings: number;
}

export interface TenantRegistrant {
  ldaRegistrantId: number | null;
  ldaRegistrantName: string | null;
}

export interface ImportCandidate {
  ldaClientId: number;
  name: string;
  filings: number;
  latestFilingYear: number | null;
  totalSpend: number;
  /** Non-null when a Client in this tenant already carries this id. */
  onboardedAs: string | null;
}

export interface ImportCandidatesResult {
  registrantId: number | null;
  registrantName: string | null;
  candidates: ImportCandidate[];
}

export interface ImportResult {
  created: number;
  items: Array<{ id: string; name: string; ldaClientId: number }>;
  skipped: Array<{ ldaClientId: number; reason: string }>;
  /** Set when a chunk hit the client-slot cap (HTTP 402) — remaining ids not sent. */
  capMessage: string | null;
}

export interface MemorySectionDef {
  key: string;
  heading: string;
  prompt: string;
  example: string;
}

export interface MemoryFileDef {
  type: string;
  scope: 'firm' | 'client' | 'user';
  label: string;
  blurb: string;
  sections: MemorySectionDef[];
}

/** GET /api/memory/items/:type/firm/sections — editor read (catalog help joined). */
export interface MemorySectionsFile {
  type: string;
  slug: string;
  title: string;
  visibility: string;
  clientId: string | null;
  updatedAt: string | null;
  exists: boolean;
  sections: Array<{
    key: string;
    heading: string;
    owner: string;
    body: string;
    prompt: string;
    example: string;
  }>;
}

/** GET /api/me — only the field the dashboard needs. */
export interface MeSummary {
  billingAdmin: boolean;
}

export type TeamInviteRole = 'user_admin' | 'standard_user';

// ── Fetch wrapper (absolute base) ───────────────────────────────────────────

type GetToken = (options?: { template?: string }) => Promise<string | null>;

async function authedFetch(
  baseUrl: string,
  getToken: GetToken,
  path: string,
  opts: RequestInit = {},
): Promise<unknown> {
  const token = await getToken({ template: 'capiro' });
  const headers: Record<string, string> = {
    ...(opts.headers as Record<string, string> | undefined),
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (opts.body != null) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${baseUrl.replace(/\/$/, '')}${path}`, { ...opts, headers });
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
    throw new ApiError(message, res.status);
  }
  if (res.status === 204) return undefined;
  return res.json();
}

// ── Typed endpoint helpers ──────────────────────────────────────────────────

/** ImportClientsDto caps each request at 100 ids — chunk larger selections. */
const IMPORT_CHUNK_SIZE = 100;

export function createCapiroApi(baseUrl: string, getToken: GetToken) {
  const get = (path: string) => authedFetch(baseUrl, getToken, path);
  const post = (path: string, body?: unknown) =>
    authedFetch(baseUrl, getToken, path, {
      method: 'POST',
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const put = (path: string, body?: unknown) =>
    authedFetch(baseUrl, getToken, path, {
      method: 'PUT',
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  return {
    me: () => get('/api/me') as Promise<MeSummary>,

    searchLdaRegistrants: (q: string) =>
      get(`/api/firm/lda-registrants?q=${encodeURIComponent(q)}`) as Promise<RegistrantHit[]>,
    getRegistrant: () => get('/api/firm/registrant') as Promise<TenantRegistrant>,
    setRegistrant: (registrantId: number) =>
      put('/api/firm/registrant', { registrantId }) as Promise<TenantRegistrant>,
    getImportCandidates: () =>
      get('/api/firm/import-candidates') as Promise<ImportCandidatesResult>,

    /**
     * Chunked import (100 ids/request). A 402 (client-slot cap) stops the run
     * and surfaces the server's cap message; earlier chunks' results are kept.
     */
    importClients: async (ldaClientIds: number[]): Promise<ImportResult> => {
      const result: ImportResult = { created: 0, items: [], skipped: [], capMessage: null };
      for (let i = 0; i < ldaClientIds.length; i += IMPORT_CHUNK_SIZE) {
        const chunk = ldaClientIds.slice(i, i + IMPORT_CHUNK_SIZE);
        try {
          const res = (await post('/api/firm/import', { ldaClientIds: chunk })) as Omit<
            ImportResult,
            'capMessage'
          >;
          result.created += res.created;
          result.items.push(...res.items);
          result.skipped.push(...res.skipped);
        } catch (err) {
          if (err instanceof ApiError && err.status === 402) {
            result.capMessage = err.message;
            break;
          }
          throw err;
        }
      }
      return result;
    },

    getMemoryCatalog: () => get('/api/memory/catalog') as Promise<MemoryFileDef[]>,
    getFirmMemorySections: (type: string) =>
      get(`/api/memory/items/${type}/firm/sections`) as Promise<MemorySectionsFile>,
    putFirmMemorySections: (type: string, sections: Array<{ key: string; body: string }>) =>
      put(`/api/memory/items/${type}/firm/sections`, { sections }) as Promise<{
        ok: true;
        updatedAt: string;
      }>,

    inviteTeamMember: (body: {
      email: string;
      role: TeamInviteRole;
      firstName?: string;
      lastName?: string;
    }) => post('/api/tenant-admin/team/invite', body),
  };
}

export type CapiroApi = ReturnType<typeof createCapiroApi>;

export function useCapiroApi(): CapiroApi {
  const { getToken } = useAuth();
  const config = useConfig();
  return useMemo(() => createCapiroApi(config.apiBaseUrl, getToken), [config.apiBaseUrl, getToken]);
}

/** billingAdmin drives the trial-cap upgrade CTA (onboarding "Super Admin" bit). */
export function useMe(options?: { enabled?: boolean }) {
  const api = useCapiroApi();
  const { isLoaded, isSignedIn } = useAuth();
  return useQuery({
    queryKey: ['capiro', 'me'],
    queryFn: () => api.me(),
    enabled: isLoaded && !!isSignedIn && (options?.enabled ?? true),
    retry: false,
    staleTime: 30_000,
  });
}
