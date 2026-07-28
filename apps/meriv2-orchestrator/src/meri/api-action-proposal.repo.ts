import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RequestCredentialsStore } from '../request/request-credentials.store.js';

export interface CreateActionProposalInput {
  tool: string;
  input: Record<string, unknown>;
  conversationId?: string;
  surface: 'chat';
}

export interface ActionProposalPreview {
  label: string;
  riskTier: string | null;
  leavesFirm: boolean;
  reversible: boolean;
  client?: { id: string; name?: string };
  fields: Record<string, string | number | boolean>;
  counts: Record<string, number>;
  reason: string;
}

/** Mirrors apps/api's PublicMeriActionProposal exactly (meri-action-proposal.service.ts). */
export interface ActionProposalResult {
  proposalId: string;
  status: string;
  tool: string;
  preview: ActionProposalPreview;
  expiresAt: string;
  reason: string;
  ruleId: string | null;
  riskTier: string | null;
  policyCode: string | null;
  attemptCount: number;
  resultSummary: unknown;
  error?: { code: string | null; message: string | null };
  createdAt: string;
  updatedAt: string;
}

/**
 * `POST /api/clio/action-proposals` (Phase 0) — creates the durable,
 * server-authoritative MeriV2 action proposal behind a WARN/BLOCK compliance
 * decision. Same server-identity bridge pattern as ApiToolExecutorRepo:
 * forwards the caller's verified Bearer PLUS the shared
 * INTERNAL_SERVICE_SECRET (apps/api's ToolServiceSecretGuard requires both on
 * this route) and the impersonation header when present.
 *
 * Unlike the audit repo, proposal creation is NOT fire-and-forget: the caller
 * (chat-assistant.service.ts) must await a durable proposalId before it can
 * honestly tell the model/user an action was proposed. A missing bearer, a
 * missing secret in a production-like environment, or any network/HTTP
 * failure THROWS — the caller must never emit a usable approval card when
 * this call did not durably succeed.
 *
 * Replaces the old ApiApprovalRepo (fingerprint "is this approved" check) and
 * ApiPendingActionRepo (fire-and-forget exact-input cache): approval now
 * happens entirely out-of-band, when the browser calls apps/api's
 * `POST /api/clio/action-proposals/:id/approve` directly — the orchestrator is
 * never consulted again for that action, so there is nothing left for either
 * of those two repos to do.
 */
@Injectable()
export class ApiActionProposalRepo {
  private readonly logger = new Logger(ApiActionProposalRepo.name);
  private readonly apiBaseUrl: string;
  private readonly timeoutMs: number;
  private readonly serviceSecret?: string;
  private readonly productionLike: boolean;

  constructor(config: ConfigService) {
    this.apiBaseUrl = (
      config.get<string>('MERIV2_API_BASE_URL') ?? 'http://localhost:3000'
    ).replace(/\/+$/, '');
    this.timeoutMs = Number.parseInt(config.get<string>('MERIV2_TOOL_TIMEOUT_MS') ?? '60000', 10);
    this.serviceSecret = config.get<string>('INTERNAL_SERVICE_SECRET') || undefined;
    const env = config.get<string>('NODE_ENV');
    this.productionLike = env === 'staging' || env === 'production';
  }

  async create(input: CreateActionProposalInput): Promise<ActionProposalResult> {
    const creds = RequestCredentialsStore.get();
    if (!creds?.bearerToken) {
      throw new Error('No forwarded credential available to create an action proposal');
    }
    if (!this.serviceSecret && this.productionLike) {
      throw new Error(
        'INTERNAL_SERVICE_SECRET is not configured; refusing to create an action proposal in a production-like environment',
      );
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(`${this.apiBaseUrl}/api/clio/action-proposals`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${creds.bearerToken}`,
          'content-type': 'application/json',
          accept: 'application/json',
          // Service identity: proves this call came from the orchestrator, so
          // apps/api's ToolServiceSecretGuard can reject a rogue user hitting
          // the proposal-creation route directly (browser-only JWT is not
          // enough to mint a trusted proposal).
          ...(this.serviceSecret ? { 'x-internal-service-secret': this.serviceSecret } : {}),
          // Impersonation passthrough (2.5): re-send the effective-tenant
          // header so apps/api scopes the new proposal to the impersonated
          // tenant (it re-validates the caller's impersonation rights).
          ...(creds.impersonateTenantId
            ? { 'x-capiro-impersonate-tenant': creds.impersonateTenantId }
            : {}),
        },
        body: JSON.stringify(input),
        signal: controller.signal,
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        this.logger.warn(`Action proposal creation -> ${res.status}`);
        throw new Error(
          `Action proposal creation failed: ${res.status} ${res.statusText} ${body.slice(0, 200)}`,
        );
      }
      return (await res.json()) as ActionProposalResult;
    } finally {
      clearTimeout(timer);
    }
  }
}
