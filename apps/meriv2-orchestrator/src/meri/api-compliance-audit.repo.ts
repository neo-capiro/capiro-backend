import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RequestCredentialsStore } from '../request/request-credentials.store.js';

/** One write-gate decision to audit (B2 / SC2.3). */
export interface ComplianceAuditPayload {
  trigger: string;
  decision: 'PASS' | 'WARN' | 'BLOCK';
  reason: string;
  ruleSource?: string;
}

/**
 * Fire-and-forget bridge to apps/api's compliance audit store: posts one
 * `compliance_check` row per write-gate decision (PASS/WARN/BLOCK) via
 * `POST /api/clio/compliance-checks`, forwarding the caller's verified Bearer
 * (same bridge pattern as ApiApprovalRepo, so the row is tenant+user scoped).
 *
 * FAIL-OPEN (opposite of the approval repo): auditing must NEVER block, delay,
 * or crash a Meri turn. `record()` returns void immediately and swallows every
 * error (no bearer, network, non-2xx, timeout). A missed audit row is a
 * degraded-observability event, not a functional failure.
 */
@Injectable()
export class ApiComplianceAuditRepo {
  private readonly logger = new Logger(ApiComplianceAuditRepo.name);
  private readonly apiBaseUrl: string;
  private readonly timeoutMs: number;

  constructor(config: ConfigService) {
    this.apiBaseUrl = (
      config.get<string>('MERIV2_API_BASE_URL') ?? 'http://localhost:3000'
    ).replace(/\/+$/, '');
    this.timeoutMs = Number.parseInt(config.get<string>('MERIV2_TOOL_TIMEOUT_MS') ?? '60000', 10);
  }

  /** Fire-and-forget: schedule the audit write, never await it into the turn. */
  record(payload: ComplianceAuditPayload): void {
    const bearer = RequestCredentialsStore.get()?.bearerToken;
    if (!bearer) return; // no caller identity to scope the row — skip silently
    void this.post(bearer, payload).catch((e) =>
      this.logger.warn(`compliance audit write skipped (${(e as Error).message})`),
    );
  }

  private async post(bearer: string, payload: ComplianceAuditPayload): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(`${this.apiBaseUrl}/api/clio/compliance-checks`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${bearer}`,
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: JSON.stringify({
          trigger: payload.trigger,
          decision: payload.decision,
          reason: payload.reason,
          ...(payload.ruleSource ? { ruleSource: payload.ruleSource } : {}),
          requiredApproval: payload.decision !== 'PASS',
        }),
        signal: controller.signal,
      });
      if (!res.ok) this.logger.warn(`compliance audit write -> ${res.status}`);
    } finally {
      clearTimeout(timer);
    }
  }
}
