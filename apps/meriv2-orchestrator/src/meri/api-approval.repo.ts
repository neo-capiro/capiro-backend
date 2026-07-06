import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { ApprovalRepo, MeriContext } from '@capiro/meriv2-core';
import { RequestCredentialsStore } from '../request/request-credentials.store.js';

/**
 * `ApprovalRepo` (B4) backed by apps/api's approval store: given an action
 * fingerprint, ask `POST /api/clio/approvals/check` (forwarding the caller's
 * verified Bearer, same bridge pattern as ApiToolExecutorRepo) whether a human
 * has approved THIS exact action. Wired into the registry's PolicyApprovalGate
 * via RepoBackedApprovalStore: a WARN write only proceeds when this returns
 * true.
 *
 * FAIL-CLOSED: any error (no bearer, network, non-2xx, timeout) resolves to
 * `false` — the gate then holds the write as ApprovalPendingError. A transient
 * apps/api blip can never let an unapproved write through.
 */
@Injectable()
export class ApiApprovalRepo implements ApprovalRepo {
  private readonly logger = new Logger(ApiApprovalRepo.name);
  private readonly apiBaseUrl: string;
  private readonly timeoutMs: number;

  constructor(config: ConfigService) {
    this.apiBaseUrl = (
      config.get<string>('MERIV2_API_BASE_URL') ?? 'http://localhost:3000'
    ).replace(/\/+$/, '');
    this.timeoutMs = Number.parseInt(config.get<string>('MERIV2_TOOL_TIMEOUT_MS') ?? '60000', 10);
  }

  async isApproved(fingerprint: string, _ctx: MeriContext): Promise<boolean> {
    const creds = RequestCredentialsStore.get();
    if (!creds?.bearerToken) {
      this.logger.warn('approval check has no forwarded bearer; treating as NOT approved');
      return false;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(`${this.apiBaseUrl}/api/clio/approvals/check`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${creds.bearerToken}`,
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: JSON.stringify({ fingerprint }),
        signal: controller.signal,
      });
      if (!res.ok) {
        this.logger.warn(`approval check -> ${res.status}; treating as NOT approved`);
        return false;
      }
      const body = (await res.json()) as { approved?: boolean };
      return body.approved === true;
    } catch (e) {
      this.logger.warn(`approval check failed (${(e as Error).message}); treating as NOT approved`);
      return false;
    } finally {
      clearTimeout(timer);
    }
  }
}
