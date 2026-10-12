import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RequestCredentialsStore } from '../../request/request-credentials.store.js';
import { assertToolExecutionActive, type ToolExecutionControl } from '@capiro/meriv2-core';
import { createMeriExecutionControl } from '../meri-execution-control.js';
import {
  catalogAvailabilityObserverOf,
  managedCatalogOutcomeFor,
  parseManagedCatalogAvailability,
} from './meriv3-catalog-availability.js';

export interface ManagedMcpToolSchema {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  source: 'managed_mcp';
  appId: 'hubspot' | 'airtable' | 'monday' | 'google-drive' | 'krisp';
  appName: string;
  readOnly: true;
}

@Injectable()
export class ApiManagedMcpRepo {
  private readonly logger = new Logger(ApiManagedMcpRepo.name);
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

  async schemas(control?: ToolExecutionControl): Promise<ManagedMcpToolSchema[]> {
    // Entry guard on the ORIGINAL parent control: a stopped/expired request must
    // never start managed discovery.
    assertToolExecutionActive(control);
    const observer = catalogAvailabilityObserverOf(control);
    const creds = RequestCredentialsStore.get();
    if (!creds?.bearerToken) {
      observer?.noteManaged({ outcome: 'missing_credential' });
      return [];
    }
    try {
      const response = await fetch(`${this.apiBaseUrl}/api/clio/v3/mcp-tool-schemas`, {
        signal: control?.signal,
        headers: this.headers(creds.bearerToken, creds.impersonateTenantId, false),
      });
      // A response that resolves after the parent Stop/expiry is NOT healthy
      // evidence, and a non-OK return must not mask the stopped/expired parent.
      assertToolExecutionActive(control);
      if (!response.ok) {
        observer?.noteManaged({
          outcome:
            response.status === 401 || response.status === 403 ? 'auth_denied' : 'unavailable',
        });
        this.logger.warn(`Managed MCP schemas -> ${response.status}`);
        return [];
      }
      const body = (await response.json()) as {
        schemas?: ManagedMcpToolSchema[];
        availability?: unknown;
      };
      // Re-assert after the JSON await before any benign status is recorded, so
      // a missing/malformed array return cannot swallow a stopped/expired parent.
      assertToolExecutionActive(control);
      if (!Array.isArray(body.schemas)) {
        // A malformed/absent array is a failure, not a genuine empty catalog.
        observer?.noteManaged({ outcome: 'malformed' });
        return [];
      }
      const availability = parseManagedCatalogAvailability(body.availability);
      observer?.noteManagedAvailability(availability);
      if (availability) {
        // A valid envelope: an ok+[] catalog is a genuine successful empty and a
        // no_eligible catalog is a deliberate nothing-eligible (NOT an outage);
        // an unavailable catalog is a real failure. Never a claim of a grant.
        observer?.noteManaged({
          outcome: managedCatalogOutcomeFor(availability, body.schemas.length),
          count: body.schemas.length,
        });
      } else if (body.availability === undefined) {
        // Rolling-release: the envelope is GENUINELY ABSENT from the JSON (the
        // API predates the additive availability field). Retain the
        // already-authorized schemas with UNKNOWN completeness (never a claim of
        // ok/no_eligible). An explicitly PRESENT null is NOT this case — the
        // actual producer always emits a well-formed envelope, so a present-but-
        // invalid value (including null) is malformed below.
        observer?.noteManaged({ outcome: 'metadata_unknown', count: body.schemas.length });
      } else {
        // Present but malformed/contradictory availability (including an
        // explicit null) is DISTINCT from a missing envelope: retain the admitted
        // schemas under the existing authority, but never claim
        // complete/ok/no_eligible — record the malformed status.
        observer?.noteManaged({ outcome: 'malformed', count: body.schemas.length });
      }
      return body.schemas;
    } catch (error) {
      // Never swallow transport cancellation. A cancelled/stopped turn must
      // surface as an abort, not as a silent empty catalog that merely blocks.
      if (control?.signal?.aborted) throw error;
      // An expired deadline with an un-aborted signal is still a stopped turn.
      assertToolExecutionActive(control);
      observer?.noteManaged({
        outcome: error instanceof SyntaxError ? 'malformed' : 'unavailable',
      });
      this.logger.warn(
        `Managed MCP schemas unavailable: ${error instanceof Error ? error.message : String(error)}`,
      );
      return [];
    }
  }

  async executeRead(
    toolName: string,
    input: Record<string, unknown>,
    control?: ToolExecutionControl,
  ): Promise<unknown> {
    const creds = RequestCredentialsStore.get();
    if (!creds?.bearerToken) {
      throw new Error(`No forwarded credential available for managed app tool "${toolName}"`);
    }
    const execution = createMeriExecutionControl(control, this.timeoutMs);
    try {
      execution.assertActive();
      const response = await fetch(
        `${this.apiBaseUrl}/api/clio/v3/mcp-tools/${encodeURIComponent(toolName)}`,
        {
          method: 'POST',
          headers: {
            ...this.headers(creds.bearerToken, creds.impersonateTenantId, true),
            'content-type': 'application/json',
            ...(execution.deadlineAt ? { 'x-meri-deadline-at': String(execution.deadlineAt) } : {}),
          },
          body: JSON.stringify(input ?? {}),
          signal: execution.signal,
        },
      );
      // A response that resolves after the parent Stop/expiry is not healthy
      // evidence; re-check the child bound and the ORIGINAL parent after the
      // response, before returning, so no later provider/read/artifact effect
      // starts for a stopped/expired request. Any owner settlement already
      // incurred by this call is preserved (never counted as a new effect).
      execution.assertActive();
      assertToolExecutionActive(control);
      if (!response.ok) {
        const detail = await response.text().catch(() => '');
        throw new Error(
          `Managed app tool "${toolName}" failed: ${response.status} ${detail.slice(0, 200)}`,
        );
      }
      const ownerResult = (await response.json()) as unknown;
      assertToolExecutionActive(control);
      return ownerResult;
    } finally {
      execution.dispose();
    }
  }

  private headers(
    bearerToken: string,
    impersonateTenantId: string | undefined,
    includeServiceIdentity: boolean,
  ): Record<string, string> {
    return {
      authorization: `Bearer ${bearerToken}`,
      accept: 'application/json',
      ...(includeServiceIdentity && this.serviceSecret
        ? { 'x-internal-service-secret': this.serviceSecret }
        : {}),
      ...(impersonateTenantId ? { 'x-capiro-impersonate-tenant': impersonateTenantId } : {}),
    };
  }
}
