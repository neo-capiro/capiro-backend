import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RequestCredentialsStore } from '../../request/request-credentials.store.js';
import { assertToolExecutionActive, type ToolExecutionControl } from '@capiro/meriv2-core';
import { createMeriExecutionControl } from '../meri-execution-control.js';
import { catalogAvailabilityObserverOf } from './meriv3-catalog-availability.js';

@Injectable()
export class ApiVisualAnalysisRepo {
  private readonly logger = new Logger(ApiVisualAnalysisRepo.name);
  private readonly apiBaseUrl: string;
  private readonly timeoutMs: number;
  private readonly serviceSecret?: string;

  constructor(config: ConfigService) {
    this.apiBaseUrl = (
      config.get<string>('MERIV2_API_BASE_URL') ?? 'http://localhost:3000'
    ).replace(/\/+$/, '');
    this.timeoutMs = Number.parseInt(config.get<string>('MERIV2_TOOL_TIMEOUT_MS') ?? '60000', 10);
    this.serviceSecret = config.get<string>('INTERNAL_SERVICE_SECRET') || undefined;
  }

  /**
   * Ask apps/api—the owner of the sandbox env + tenant flag—whether the tool is
   * currently usable. Any auth/network/config failure removes run_analysis from
   * the model surface for that turn instead of advertising a doomed tool.
   */
  async available(control?: ToolExecutionControl): Promise<boolean> {
    // Entry guard on the ORIGINAL parent control: a stopped/expired request must
    // not be probed, and must never be recorded as a benign capability result.
    assertToolExecutionActive(control);
    const observer = catalogAvailabilityObserverOf(control);
    const credentials = RequestCredentialsStore.get();
    if (!credentials?.bearerToken) {
      observer?.noteAnalysis({ outcome: 'missing_credential' });
      return false;
    }
    const execution = createMeriExecutionControl(control, Math.min(this.timeoutMs, 10_000));
    try {
      execution.assertActive();
      const response = await fetch(`${this.apiBaseUrl}/api/clio/v3/capabilities`, {
        headers: {
          authorization: `Bearer ${credentials.bearerToken}`,
          accept: 'application/json',
          ...(credentials.impersonateTenantId
            ? { 'x-capiro-impersonate-tenant': credentials.impersonateTenantId }
            : {}),
        },
        signal: execution.signal,
      });
      // A response that resolves after the parent Stop/expiry is NOT healthy
      // evidence; re-check the optional-probe (child) bound and assert the
      // ORIGINAL parent independently after each await, so neither a resolved
      // response nor a child-only timeout can be recorded as a benign
      // usable/disabled/malformed result for a stopped/expired parent.
      execution.assertActive();
      assertToolExecutionActive(control);
      if (!response.ok) {
        observer?.noteAnalysis({
          outcome:
            response.status === 401 || response.status === 403 ? 'auth_denied' : 'unavailable',
        });
        return false;
      }
      const body = (await response.json()) as { visualAnalysis?: { enabled?: unknown } };
      execution.assertActive();
      assertToolExecutionActive(control);
      const enabled = body.visualAnalysis?.enabled;
      if (enabled === true) {
        observer?.noteAnalysis({ outcome: 'usable' });
        return true;
      }
      if (enabled === false) {
        // Deliberate owner capability disable — not an outage.
        observer?.noteAnalysis({ outcome: 'disabled' });
        return false;
      }
      // Missing field or wrong type is malformed metadata, not a healthy empty.
      observer?.noteAnalysis({ outcome: 'malformed' });
      return false;
    } catch (error) {
      // Distinguish a real parent request Stop/expiry from ONLY the bounded
      // optional probe timing out: a parent stop must propagate so no later
      // read/model work starts, while an optional-probe timeout fails closed and
      // still allows the (non-visual) chat answer.
      if (
        control?.signal?.aborted ||
        (control?.deadlineAt !== undefined && Date.now() >= control.deadlineAt)
      ) {
        throw error;
      }
      observer?.noteAnalysis({ outcome: 'unavailable' });
      this.logger.debug(
        `Visual-analysis availability check failed closed: ${
          error instanceof Error ? error.message.slice(0, 160) : String(error).slice(0, 160)
        }`,
      );
      return false;
    } finally {
      execution.dispose();
    }
  }

  async execute(input: Record<string, unknown>, control?: ToolExecutionControl): Promise<unknown> {
    return this.postInternal('/api/clio/v3/visual-analysis', input, 'Visual analysis', control);
  }

  async discard(artifactIds: string[]): Promise<{ deleted: number }> {
    return (await this.postInternal(
      '/api/clio/v3/visual-analysis/discard',
      { artifactIds },
      'Visual analysis discard',
    )) as { deleted: number };
  }

  private async postInternal(
    path: string,
    input: Record<string, unknown>,
    operation: string,
    control?: ToolExecutionControl,
  ): Promise<unknown> {
    const credentials = RequestCredentialsStore.get();
    if (!credentials?.bearerToken) {
      throw new Error('No forwarded credential available for MeriV3 visual analysis');
    }
    if (!this.serviceSecret) {
      throw new Error('MeriV3 internal service identity is not configured');
    }
    const execution = createMeriExecutionControl(control, this.timeoutMs);
    try {
      execution.assertActive();
      const response = await fetch(`${this.apiBaseUrl}${path}`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${credentials.bearerToken}`,
          'content-type': 'application/json',
          accept: 'application/json',
          ...(execution.deadlineAt ? { 'x-meri-deadline-at': String(execution.deadlineAt) } : {}),
          'x-internal-service-secret': this.serviceSecret,
          ...(credentials.impersonateTenantId
            ? { 'x-capiro-impersonate-tenant': credentials.impersonateTenantId }
            : {}),
        },
        body: JSON.stringify(input),
        signal: execution.signal,
      });
      // Re-check the child bound and the ORIGINAL parent after the owner
      // response so no later provider/read/artifact effect starts for a
      // stopped/expired request. Any settlement already incurred by this call is
      // preserved (never counted as a new effect).
      execution.assertActive();
      assertToolExecutionActive(control);
      if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new Error(
          `${operation} failed: ${response.status} ${response.statusText} ${body.slice(0, 200)}`,
        );
      }
      const ownerResult = (await response.json()) as unknown;
      assertToolExecutionActive(control);
      return ownerResult;
    } finally {
      execution.dispose();
    }
  }
}
