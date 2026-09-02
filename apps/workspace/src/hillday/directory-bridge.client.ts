import { Injectable, Logger } from '@nestjs/common';

/**
 * HTTP bridge to the apps/api Directory (the LegiStorm snapshot lives only in
 * that service's memory/S3 cache, so the workspace cannot read it from the
 * shared database). Calls the backend-only `/api/internal/directory/*` routes
 * with the shared service secret — never a browser-held Clerk JWT, which is
 * too short-lived for an async generation job anyway.
 *
 * Every method degrades instead of throwing: a failed read is reported as
 * `{ ok: false }` with the reason, and the caller renders `unavailable` or
 * `partial` for the Directory source. Nothing here fabricates a match.
 */

export type BridgeResult<T> =
  | { ok: true; data: T }
  | { ok: false; status: 'unavailable'; detail: string };

/** Mirrors apps/api's `MemberContext` (internal-directory.controller.ts). */
export interface BridgeMemberContext {
  id: string;
  bioguideId: string;
  fullName: string;
  memberName: string;
  honorific: string;
  title: string;
  chamber: string;
  state: string;
  district: string;
  party: string;
  partyName: string;
  officeLocation: string;
  phone: string;
  email: string;
  bioNarrative: string;
  committees: string[];
  committeesWithRole: Array<{ name: string; role: string | null }>;
  committeeLeadership: string[];
  leadershipPositions: string[];
  focusAreas: string[];
  topIssues: Array<{ issue: string; stafferCount: number }>;
  staff: Array<{
    id: string;
    fullName: string;
    title: string;
    roles: string[];
    issueAreas: string[];
    email: string;
    isCurrent: boolean;
  }>;
}

export interface BridgeStaffMatch {
  attendeeEmail: string;
  matchKind: 'member' | 'staff';
  directoryContactId: string;
  directoryContactName: string;
  member: BridgeMemberContext;
  staff: {
    id: string;
    fullName: string;
    title: string;
    email: string;
    officeLocation: string;
    issueAreas: string[];
    roles: string[];
    isCurrent: boolean;
  } | null;
}

export interface BridgeCommitteeStaffMatch {
  attendeeEmail: string;
  staff: { id: string; fullName: string; title: string; email: string; isCurrent: boolean };
  committee: { id: string; name: string; chamber: string; kind: string };
}

export interface BridgeMatchEmailsResponse {
  snapshotId: string;
  matches: BridgeStaffMatch[];
  committeeStaff: BridgeCommitteeStaffMatch[];
}

export interface BridgeStaffer {
  id: string;
  fullName: string;
  title: string;
  roles: string[];
  issueAreas: string[];
  email: string;
  officeLocation: string;
  member: BridgeMemberContext | null;
}

const TIMEOUT_MS = 15_000;

@Injectable()
export class DirectoryBridgeClient {
  private readonly logger = new Logger(DirectoryBridgeClient.name);
  private readonly baseUrl = (process.env.API_BASE_URL ?? 'https://app.capiro.ai').replace(
    /\/+$/,
    '',
  );
  private readonly secret = process.env.INTERNAL_SERVICE_SECRET;

  get configured(): boolean {
    return Boolean(this.secret);
  }

  matchEmails(emails: string[]): Promise<BridgeResult<BridgeMatchEmailsResponse>> {
    if (!emails.length) {
      return Promise.resolve({ ok: true, data: { snapshotId: '', matches: [], committeeStaff: [] } });
    }
    return this.request<BridgeMatchEmailsResponse>('POST', '/api/internal/directory/match-emails', {
      emails,
    });
  }

  searchContacts(
    q: string,
    chamber?: string,
  ): Promise<BridgeResult<{ contacts: BridgeMemberContext[] }>> {
    const params = new URLSearchParams({ q, pageSize: '10' });
    if (chamber) params.set('chamber', chamber);
    return this.request<{ contacts: BridgeMemberContext[] }>(
      'GET',
      `/api/internal/directory/contacts?${params.toString()}`,
    );
  }

  memberContext(memberId: string): Promise<BridgeResult<{ context: BridgeMemberContext | null }>> {
    return this.request<{ context: BridgeMemberContext | null }>(
      'GET',
      `/api/internal/directory/members/${encodeURIComponent(memberId)}`,
    );
  }

  searchStaffers(q: string): Promise<BridgeResult<{ staffers: BridgeStaffer[] }>> {
    const params = new URLSearchParams({ q, pageSize: '12' });
    return this.request<{ staffers: BridgeStaffer[] }>(
      'GET',
      `/api/internal/directory/staffers?${params.toString()}`,
    );
  }

  staffer(staffId: string): Promise<BridgeResult<{ staffer: BridgeStaffer | null }>> {
    return this.request<{ staffer: BridgeStaffer | null }>(
      'GET',
      `/api/internal/directory/staffers/${encodeURIComponent(staffId)}`,
    );
  }

  branding(
    tenantId: string,
    clientId: string,
  ): Promise<
    BridgeResult<{
      clientLogoUrl: string | null;
      clientLogoContentType: string | null;
      firmLogoUrl: string | null;
      firmLogoContentType: string | null;
    }>
  > {
    const params = new URLSearchParams({ tenantId });
    return this.request(
      'GET',
      `/api/internal/clients/${encodeURIComponent(clientId)}/branding?${params.toString()}`,
    );
  }

  private async request<T>(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
  ): Promise<BridgeResult<T>> {
    if (!this.secret) {
      return {
        ok: false,
        status: 'unavailable',
        detail: 'Directory bridge is not configured (INTERNAL_SERVICE_SECRET missing)',
      };
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: {
          'x-internal-service-secret': this.secret,
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
      if (!res.ok) {
        this.logger.warn(`Directory bridge ${method} ${path} → HTTP ${res.status}`);
        return {
          ok: false,
          status: 'unavailable',
          detail: `Directory responded HTTP ${res.status}`,
        };
      }
      return { ok: true, data: (await res.json()) as T };
    } catch (err) {
      const message =
        (err as Error).name === 'AbortError'
          ? `Directory timed out after ${TIMEOUT_MS / 1000}s`
          : (err as Error).message;
      this.logger.warn(`Directory bridge ${method} ${path} failed: ${message}`);
      return { ok: false, status: 'unavailable', detail: message };
    } finally {
      clearTimeout(timer);
    }
  }
}
