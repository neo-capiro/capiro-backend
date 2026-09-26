import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import type { MeriContext, ToolExecutor, ToolExecutionControl } from '@capiro/meriv2-core';
import { createMeriExecutionControl } from './meri-execution-control.js';
import { RequestCredentialsStore } from '../request/request-credentials.store.js';

const RETRYABLE_MAIL_READS = new Set(['list_emails', 'search_emails', 'get_email_thread']);
const MAX_MAIL_RETRY_DELAY_MS = 5_000;

/** Only the API's explicit database-capacity response is safe to retry here. */
function mailCapacityRetryDelay(toolName: string, response: Response, body: string): number | null {
  if (!RETRYABLE_MAIL_READS.has(toolName) || response.status !== 503) return null;
  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    return null;
  }
  if (
    !payload ||
    typeof payload !== 'object' ||
    (payload as Record<string, unknown>).statusCode !== 503 ||
    (payload as Record<string, unknown>).message !==
      'The database is temporarily busy. Please retry.'
  ) {
    return null;
  }
  const retryAfter = response.headers?.get('retry-after')?.trim();
  if (!retryAfter) return null;
  const delay = /^\d+$/.test(retryAfter)
    ? Number(retryAfter) * 1_000
    : Date.parse(retryAfter) - Date.now();
  // Honor the server's delay; do not shorten a long Retry-After and hammer it.
  return Number.isFinite(delay) && delay >= 0 && delay <= MAX_MAIL_RETRY_DELAY_MS
    ? Math.max(100, delay)
    : null;
}

function waitForMailRetry(delayMs: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, delayMs);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * `ToolExecutor` that delegates a named tool to apps/api's existing
 * authenticated executor: `POST /api/clio/tools/:name`, backed by
 * MeriToolsService.executeFromAuthenticatedUser (the ONE tenant-scoped
 * implementation + BYOK path). Forwards the caller's verified Bearer token, so
 * apps/api re-derives the full TenantContext and applies its own field
 * validation + scoping — no SQL duplicated, no behavior drift. Same bridge
 * pattern as ApiClientContextRepo, generalized to any tool.
 *
 * This runs INSIDE a real user request (the registry invoke path), so the
 * forwarded user Bearer is always present; non-user callers (hearing backfill)
 * are out of scope here and require the separate service-auth path.
 */
@Injectable()
export class ApiToolExecutorRepo implements ToolExecutor {
  private readonly logger = new Logger(ApiToolExecutorRepo.name);
  private readonly apiBaseUrl: string;
  private readonly timeoutMs: number;
  // Shared backend secret (same one apps/api's /internal/* routes use). Sent as
  // x-internal-service-secret so apps/api's ToolServiceSecretGuard can prove THIS
  // tool call came from the orchestrator (post compliance-gate), not a rogue user
  // bearer hitting /api/clio/tools/:name directly. Inert until wired on the
  // orchestrator task def; harmless to send when apps/api isn't yet enforcing.
  private readonly serviceSecret?: string;

  constructor(config: ConfigService) {
    const privateToolApiBaseUrl = config.get<string>('MERIV2_TOOL_API_BASE_URL');
    this.serviceSecret = config.get<string>('INTERNAL_SERVICE_SECRET') || undefined;
    if (privateToolApiBaseUrl && !this.serviceSecret) {
      throw new Error('Private delegated tool API requires INTERNAL_SERVICE_SECRET');
    }
    if (privateToolApiBaseUrl) {
      const endpoint = new URL(privateToolApiBaseUrl);
      if (
        endpoint.protocol !== 'http:' ||
        endpoint.port !== '4000' ||
        !endpoint.hostname.endsWith('.local') ||
        endpoint.username || endpoint.password || endpoint.pathname !== '/' || endpoint.search || endpoint.hash
      ) {
        throw new Error('Private delegated tool API must be an internal .local HTTP endpoint on port 4000');
      }
    }
    this.apiBaseUrl = (
      privateToolApiBaseUrl ??
      config.get<string>('MERIV2_API_BASE_URL') ??
      'http://localhost:3000'
    ).replace(/\/+$/, '');
    this.timeoutMs = Number.parseInt(config.get<string>('MERIV2_TOOL_TIMEOUT_MS') ?? '60000', 10);
  }

  async execute(
    _ctx: MeriContext,
    toolName: string,
    input: Record<string, unknown>,
    control?: ToolExecutionControl,
  ): Promise<unknown> {
    const creds = RequestCredentialsStore.get();
    if (!creds?.bearerToken) {
      throw new Error(`No forwarded credential available for delegated tool "${toolName}"`);
    }
    const execution = createMeriExecutionControl(control, this.timeoutMs);
    const delegatedRequestId = randomUUID();
    try {
      execution.assertActive();
      const url = `${this.apiBaseUrl}/api/clio/tools/${encodeURIComponent(toolName)}`;
      const request = {
        method: 'POST',
        headers: {
          authorization: `Bearer ${creds.bearerToken}`,
          'content-type': 'application/json',
          accept: 'application/json',
          // Correlates bridge and API/guard logs without exposing credentials.
          'x-meri-delegated-request-id': delegatedRequestId,
          ...(execution.deadlineAt ? { 'x-meri-deadline-at': String(execution.deadlineAt) } : {}),
          // Service identity: proves this call came from the orchestrator (after
          // its compliance gate), so apps/api can reject a rogue user hitting the
          // raw tool endpoint directly. See ToolServiceSecretGuard.
          ...(this.serviceSecret ? { 'x-internal-service-secret': this.serviceSecret } : {}),
          // Impersonation passthrough (2.5): re-send the effective-tenant header
          // so apps/api scopes THIS delegated tool call to the impersonated
          // tenant (it re-validates the caller's impersonation rights).
          ...(creds.impersonateTenantId
            ? { 'x-capiro-impersonate-tenant': creds.impersonateTenantId }
            : {}),
        },
        body: JSON.stringify(input),
        signal: execution.signal,
      } satisfies RequestInit;
      // One retry only, inside the original deadline and cancellation signal.
      // Failed writes and business/authorization refusals always retain the
      // existing single-attempt path; a 503 alone is not transient evidence.
      for (let attempt = 0; ; attempt += 1) {
        execution.assertActive();
        const res = await fetch(url, request);
        if (res.ok) return (await res.json()) as unknown;
        const body = await res.text().catch(() => '');
        this.logger.warn(`Delegated tool "${toolName}" -> ${res.status} requestId=${delegatedRequestId}`);
        const retryDelay = attempt === 0 ? mailCapacityRetryDelay(toolName, res, body) : null;
        if (
          retryDelay !== null &&
          (execution.deadlineAt === undefined || Date.now() + retryDelay < execution.deadlineAt)
        ) {
          await waitForMailRetry(retryDelay, execution.signal);
          continue;
        }
        throw new Error(
          `Delegated tool "${toolName}" failed: ${res.status} ${res.statusText} ${body.slice(0, 200)}`,
        );
      }
    } finally {
      execution.dispose();
    }
  }
}
