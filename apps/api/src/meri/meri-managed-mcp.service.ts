import { krispTenantEnabled } from '../common/krisp-notetaker-flags.js';
import { BadRequestException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { TenantContext } from '@capiro/shared';
import { assertMeriToolRequestActive } from './meri-tool-request-control.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { MeriMcpOAuthService } from './meri-mcp-oauth.service.js';
import { MeriMcpService } from './meri-mcp.service.js';
import { bridgedToolName, type BridgedTool } from './meri-mcp.helpers.js';
import {
  MANAGED_MCP_APPS,
  MERIV3_MANAGED_APP_IDS,
  filterManagedReadOnlyTools,
  managedAppAvailable,
  type ManagedMcpPrincipal,
  managedAppIdFromCatalogId,
  managedCatalogId,
  type MeriV3ManagedAppId,
} from './meri-managed-mcp.helpers.js';

export interface MeriV3ManagedAppStatus {
  id: MeriV3ManagedAppId;
  name: string;
  description: string;
  status: 'connected' | 'disconnected' | 'pending' | 'needs_reauth' | 'error';
  connected: boolean;
  available: boolean;
  needsReauth: boolean;
  lastError: string | null;
}

export interface MeriV3ManagedMcpSchema extends BridgedTool {
  source: 'managed_mcp';
  appId: MeriV3ManagedAppId;
  appName: string;
  readOnly: true;
}

/** Bounded, sanitized managed-catalog failure reason codes. Never raw provider
 *  text, error bodies, endpoints, tokens, credentials, or private identifiers. */
export type MeriV3ManagedFailureReason =
  | 'unavailable'
  | 'needs_reauth'
  | 'malformed'
  | 'registry_unavailable';

export interface MeriV3ManagedAvailabilityFailure {
  appId: MeriV3ManagedAppId;
  /** Safe, fixed managed app name (from the admitted definition). */
  name: string;
  reason: MeriV3ManagedFailureReason;
}

/**
 * Sanitized availability of the managed catalog for ONE caller. Additive beside
 * the existing `schemas` array and consumed by the next orchestrator slice to
 * give a truthful limitation instead of implying an empty result was complete.
 *
 * - `no_eligible`: the caller has no eligible managed connection, so no
 *   discovery was attempted. Deliberate, and NOT an outage or a fake success.
 * - `ok`: every eligible app was queried and either returned its tools or
 *   genuinely returned none (successful empty). `complete` is true.
 * - `partial`: some eligible app failed but usable authorized tools from healthy
 *   sources were retained.
 * - `unavailable`: an eligible app failed and no healthy tools were retained, or
 *   the registry snapshot itself could not be read.
 */
export interface MeriV3ManagedCatalogAvailability {
  state: 'ok' | 'partial' | 'unavailable' | 'no_eligible';
  complete: boolean;
  registryUnavailable: boolean;
  failures: MeriV3ManagedAvailabilityFailure[];
}

export interface MeriV3ManagedCatalogResult {
  schemas: MeriV3ManagedMcpSchema[];
  availability: MeriV3ManagedCatalogAvailability;
}

const MANAGED_FAILURE_RANK: Record<MeriV3ManagedFailureReason, number> = {
  needs_reauth: 3,
  malformed: 2,
  unavailable: 1,
  registry_unavailable: 0,
};

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function serverPrefix(name: string): string {
  // Use the namespace itself; a probe containing '__' makes the suffix look
  // like another separator and excludes every real provider tool.
  return bridgedToolName(name, '');
}

function globalMcpEnabled(): boolean {
  const value = process.env.CLIO_MCP_ENABLED?.trim().toLowerCase();
  return value === undefined || !['false', '0', 'no', 'off'].includes(value);
}

@Injectable()
export class MeriManagedMcpService {
  private readonly connecting = new Map<
    string,
    Promise<{
      app: MeriV3ManagedAppStatus;
      authUrl: string | null;
      alreadyConnected: boolean;
    }>
  >();

  constructor(
    private readonly prisma: PrismaService,
    private readonly mcp: MeriMcpService,
    private readonly oauth: MeriMcpOAuthService,
  ) {}

  async listApps(ctx: TenantContext): Promise<MeriV3ManagedAppStatus[]> {
    const rows = await this.personalRows(ctx);
    const krispEnabled = await krispTenantEnabled(this.prisma, ctx.tenantId);
    return MERIV3_MANAGED_APP_IDS.filter((id) => id !== 'krisp' || krispEnabled).map((id) => {
      const app = MANAGED_MCP_APPS[id];
      const row = rows.find((candidate) => candidate.catalogId === app.catalogId);
      let status = this.publicStatus(row?.connectionStatus);
      const available = this.available(id, ctx);
      const usable = Boolean(
        row?.enabled && filterManagedReadOnlyTools(id, strings(row.toolAllowlist)).length,
      );
      if (status === 'connected' && !usable) status = 'error';
      return {
        id,
        name: app.name,
        description: app.description,
        status,
        connected: status === 'connected' && usable && available,
        available,
        needsReauth: status === 'needs_reauth',
        // Provider errors may contain URLs, codes, or internal configuration.
        lastError: !available
          ? app.name + ' is temporarily unavailable. Please try again later.'
          : status === 'needs_reauth'
            ? 'Please reconnect ' + app.name + ' to continue.'
            : status === 'error'
              ? app.name + ' could not finish connecting. Please try again.'
              : null,
      };
    });
  }

  connect(ctx: TenantContext, rawId: string) {
    const appId = this.parseAppId(rawId);
    const key = ctx.tenantId + ':' + ctx.userId + ':' + appId;
    const pending = this.connecting.get(key);
    if (pending) return pending;
    const operation = this.connectApp(ctx, appId).finally(() => this.connecting.delete(key));
    this.connecting.set(key, operation);
    return operation;
  }

  private async connectApp(ctx: TenantContext, appId: MeriV3ManagedAppId) {
    if (appId === 'krisp' && !(await krispTenantEnabled(this.prisma, ctx.tenantId))) {
      throw new ServiceUnavailableException('Krisp Notetaker is not enabled for this organization.');
    }
    if (!globalMcpEnabled()) {
      throw new ServiceUnavailableException('Connected apps are temporarily disabled.');
    }
    if (!this.available(appId, ctx)) {
      throw new ServiceUnavailableException(
        MANAGED_MCP_APPS[appId].name + ' is temporarily unavailable. Please try again later.',
      );
    }

    const existing = await this.rowsForApp(ctx, appId);
    const retained = existing.find(
      (row) => row.enabled && ['connected', 'error'].includes(row.connectionStatus),
    );
    if (retained) {
      // Revalidate valid credentials in place. An upstream outage is not a
      // reason to delete the user's connection or ask them to sign in again.
      const count = await this.mcp.discoverTools(ctx.tenantId, retained.id);
      if (count > 0) {
        await this.finalizeConnection(ctx.tenantId, retained.id);
        return { app: await this.statusFor(ctx, appId), authUrl: null, alreadyConnected: true };
      }
      const [current] = await this.rowsForApp(ctx, appId);
      if (current?.connectionStatus !== 'needs_reauth') {
        throw new ServiceUnavailableException('The app could not be reached. Please try again.');
      }
    }

    // Only abandoned/disconnected/expired authorizations are replaced.
    for (const row of existing) await this.mcp.deleteServer(ctx, row.id);
    const serverId = await this.createApp(ctx, appId);
    const started = await this.oauth.start(ctx, serverId);
    if (started.alreadyConnected) {
      const count = await this.mcp.discoverTools(ctx.tenantId, serverId);
      if (!count)
        throw new ServiceUnavailableException(
          'The app could not finish connecting. Please try again.',
        );
      await this.finalizeConnection(ctx.tenantId, serverId);
    }
    return {
      app: await this.statusFor(ctx, appId),
      authUrl: started.authUrl,
      alreadyConnected: Boolean(started.alreadyConnected),
    };
  }

  async disconnect(ctx: TenantContext, rawId: string): Promise<{ disconnected: true }> {
    const appId = this.parseAppId(rawId);
    const pending = this.connecting.get(ctx.tenantId + ':' + ctx.userId + ':' + appId);
    if (pending) await pending.catch(() => undefined);
    for (const row of await this.rowsForApp(ctx, appId)) {
      await this.oauth.disconnect(ctx, row.id);
    }
    this.mcp.invalidate(ctx.tenantId);
    return { disconnected: true };
  }

  async cancelPending(ctx: TenantContext, rawId: string): Promise<{ cancelled: true }> {
    const appId = this.parseAppId(rawId);
    const pending = this.connecting.get(ctx.tenantId + ':' + ctx.userId + ':' + appId);
    if (pending) await pending.catch(() => undefined);
    for (const row of await this.rowsForApp(ctx, appId)) {
      await this.oauth.cancelPending(ctx, row.id);
    }
    this.mcp.invalidate(ctx.tenantId);
    return { cancelled: true };
  }

  async finalizeConnection(tenantId: string, serverId: string): Promise<number> {
    const count = await this.hardenServer(tenantId, serverId);
    if (!count)
      throw new ServiceUnavailableException(
        'No supported read tools are available. Please try reconnecting.',
      );
    const result = await this.prisma.withTenant(tenantId, (tx) =>
      tx.clioMcpServer.updateMany({
        where: {
          id: serverId,
          tenantId,
          enabled: true,
          connectionStatus: { in: ['pending', 'connected'] },
        },
        data: { connectionStatus: 'connected', lastError: null },
      }),
    );
    if (result.count !== 1) throw new BadRequestException('This connection is no longer active.');
    this.mcp.invalidate(tenantId);
    return count;
  }

  async appForServer(tenantId: string, serverId: string) {
    const row = await this.prisma.withTenant(tenantId, (tx) =>
      tx.clioMcpServer.findFirst({
        where: { id: serverId, tenantId },
        select: { catalogId: true },
      }),
    );
    const id = managedAppIdFromCatalogId(row?.catalogId);
    return id ? { id, name: MANAGED_MCP_APPS[id].name } : null;
  }

  async schemasForMeriV3(ctx: TenantContext): Promise<MeriV3ManagedMcpSchema[]> {
    return (await this.managedCatalogForMeriV3(ctx)).schemas;
  }

  /**
   * The managed catalog PLUS a sanitized availability result, both derived from
   * ONE registry snapshot. `schemas` is exactly what `schemasForMeriV3` has
   * always returned; `availability` is additive and consumed only by the next
   * orchestrator slice.
   *
   * Only discovery failures recorded against the acting owner's CURRENT eligible
   * personal managed rows are ever named, so another owner/tenant or a custom
   * connector can never be disclosed. Reason codes are bounded; no raw provider
   * text/endpoint/token/credential/private id leaves this method.
   *
   * A currently-owned, enabled, available managed row whose connection is
   * error/needs_reauth is a truthful FAILURE source: it is reported (bounded
   * reason) but never grants a schema or transport, so a still-owned outage
   * survives the next request / restart / cache expiry without reconnecting or
   * re-discovering. A deliberate disconnect/disable/unconfigured/feature-off
   * row is never treated as an outage.
   */
  async managedCatalogForMeriV3(ctx: TenantContext): Promise<MeriV3ManagedCatalogResult> {
    const noEligible = (): MeriV3ManagedCatalogResult => ({
      schemas: [],
      availability: {
        state: 'no_eligible',
        complete: true,
        registryUnavailable: false,
        failures: [],
      },
    });
    // Global kill switch / unconfigured OAuth is deliberate, not an outage and
    // not a successful query: nothing was eligible to discover.
    if (!globalMcpEnabled() || !this.oauth.isConfigured()) return noEligible();

    const prefixes = new Map<string, MeriV3ManagedAppId>();
    // serverId -> appId for the acting owner's CURRENTLY-OWNED, enabled,
    // available managed rows that are NOT connected (error/needs_reauth). These
    // are truthful failure sources, never a schema/transport grant; they only
    // gate the zero-provider early return below. Failure NAMING uses the single
    // final current map re-read AFTER discovery, so a late mutation cannot be
    // authorized by this earlier admission snapshot.
    const failedRows = new Map<string, MeriV3ManagedAppId>();
    for (const row of await this.personalRows(ctx)) {
      const id = managedAppIdFromCatalogId(row.catalogId);
      if (id === 'krisp' && !(await krispTenantEnabled(this.prisma, ctx.tenantId))) continue;
      if (!id || !this.available(id, ctx) || !row.enabled) continue;
      if (row.connectionStatus === 'connected') {
        if (await this.hardenServer(ctx.tenantId, row.id, ctx.userId)) {
          prefixes.set(serverPrefix(row.name), id);
        }
      } else if (row.connectionStatus === 'needs_reauth' || row.connectionStatus === 'error') {
        failedRows.set(row.id, id);
      }
      // pending/disconnected are deliberate non-outages: never a failure source.
    }
    // Preserve the existing zero-provider-call property when nothing is either
    // readable or a currently-owned failure.
    if (!prefixes.size && !failedRows.size) return noEligible();

    // With no readable connection left there is nothing to discover: peek the
    // SAME existing snapshot (and fresh visibility) with ZERO provider I/O, so a
    // still-owned outage is reported without a retry storm or a stale schema.
    const cacheOnly = prefixes.size === 0;
    const { schemas, failures, registryUnavailable } = await this.mcp.bridgedSchemasDetailedFor(
      ctx,
      cacheOnly ? { cacheOnly: true } : undefined,
    );
    const out: MeriV3ManagedMcpSchema[] = [];
    for (const schema of schemas) {
      const match = [...prefixes].find(([prefix]) => schema.name.startsWith(prefix));
      if (!match || !this.mcp.isBridgedToolReadOnly(ctx, schema.name)) continue;
      const id = match[1];
      out.push({
        ...schema,
        source: 'managed_mcp',
        appId: id,
        appName: MANAGED_MCP_APPS[id].name,
        readOnly: true,
      });
    }

    // Re-read the acting owner's rows AFTER discovery/status writes. This ONE
    // final map is the single source of truth for BOTH the cached-failure loop
    // and the DB fallback below. A failure may only be named for a row that is
    // STILL currently owned, enabled, available, and classified as a managed app
    // — otherwise a failure that the fresh-visibility filter deliberately
    // dropped (a row transferred/disabled/reclassified/disconnected mid-call)
    // would be reintroduced from the earlier admission snapshot. A deliberate
    // pending/disconnected row is a non-outage and is never admitted here; a
    // still-connected row IS admitted (reason null) so a legitimate connected
    // throttle (e.g. Krisp 429, which leaves connectionStatus unchanged) can
    // still be named from its cached failure rather than masked by an
    // error-only map.
    const currentAdmitted = new Map<
      string,
      { id: MeriV3ManagedAppId; reason: MeriV3ManagedFailureReason | null }
    >();
    for (const row of await this.personalRows(ctx)) {
      const id = managedAppIdFromCatalogId(row.catalogId);
      if (id === 'krisp' && !(await krispTenantEnabled(this.prisma, ctx.tenantId))) continue;
      if (!id || !this.available(id, ctx) || !row.enabled) continue;
      if (row.connectionStatus === 'disconnected' || row.connectionStatus === 'pending') continue;
      currentAdmitted.set(row.id, {
        id,
        reason:
          row.connectionStatus === 'needs_reauth'
            ? 'needs_reauth'
            : row.connectionStatus === 'error'
              ? 'unavailable'
              : null,
      });
    }

    // Collapse raw failures to one bounded, sanitized entry per app. A failure
    // is only named when its server is one of the acting owner's CURRENT admitted
    // rows and — for a managed failure — its PRIVATE admitted managedAppId still
    // matches that row's managed classification. Both the cached-failure loop and
    // the DB fallback read the SAME final map, so a row the newest query dropped
    // can never be named from an earlier admission.
    const byApp = new Map<MeriV3ManagedAppId, MeriV3ManagedFailureReason>();
    for (const failure of failures) {
      const admitted = currentAdmitted.get(failure.serverId);
      if (!admitted) continue;
      if (failure.managedAppId && failure.managedAppId !== admitted.id) continue;
      const existing = byApp.get(admitted.id);
      if (!existing || MANAGED_FAILURE_RANK[failure.reason] > MANAGED_FAILURE_RANK[existing]) {
        byApp.set(admitted.id, failure.reason);
      }
    }
    // DB fallback: a currently-admitted failed row with no cached failure (e.g.
    // the snapshot expired, or discovery skipped the non-connected row) is still
    // reported from its CURRENT stored status. A more authoritative current
    // status (e.g. a newer stored needs_reauth) upgrades an older cached reason
    // instead of being hidden by it; a deliberate pending/disconnected row was
    // never admitted and is never reported.
    for (const { id, reason } of currentAdmitted.values()) {
      if (!reason) continue;
      const existing = byApp.get(id);
      if (!existing || MANAGED_FAILURE_RANK[reason] > MANAGED_FAILURE_RANK[existing]) {
        byApp.set(id, reason);
      }
    }
    const appFailures: MeriV3ManagedAvailabilityFailure[] = [...byApp].map(([appId, reason]) => ({
      appId,
      name: MANAGED_MCP_APPS[appId].name,
      reason,
    }));

    const state: MeriV3ManagedCatalogAvailability['state'] = registryUnavailable
      ? 'unavailable'
      : appFailures.length === 0
        ? 'ok'
        : out.length
          ? 'partial'
          : 'unavailable';
    return {
      schemas: out,
      availability: {
        state,
        complete: state === 'ok',
        registryUnavailable,
        failures: appFailures,
      },
    };
  }

  async executeRead(
    ctx: TenantContext,
    toolName: string,
    input: Record<string, unknown>,
    options?: { structuredRead?: boolean },
  ): Promise<unknown> {
    assertMeriToolRequestActive();
    const schemas = await this.schemasForMeriV3(ctx);
    if (
      !schemas.some((schema) => schema.name === toolName) ||
      !this.mcp.isBridgedToolReadOnly(ctx, toolName)
    ) {
      throw new BadRequestException('Connected-app tool is unavailable or not read-only.');
    }
    assertMeriToolRequestActive();
    // executeBridged rechecks the current row immediately before provider I/O.
    return options
      ? this.mcp.executeBridged(ctx, toolName, input, options)
      : this.mcp.executeBridged(ctx, toolName, input);
  }

  private async createApp(ctx: TenantContext, appId: MeriV3ManagedAppId): Promise<string> {
    const app = MANAGED_MCP_APPS[appId];
    const created = (await this.mcp.createServer(ctx, {
      name: app.catalogId,
      transport: 'http',
      endpoint: app.endpoint,
      authType: 'oauth',
      scope: 'user',
      toolAllowlist: [],
      readOnlyTools: [],
      enabled: true,
      ...(app.clientIdEnv ? { oauthClientId: process.env[app.clientIdEnv]?.trim() } : {}),
      ...(app.clientSecretEnv
        ? { oauthClientSecret: process.env[app.clientSecretEnv]?.trim() }
        : {}),
    })) as { id?: unknown };
    if (typeof created.id !== 'string')
      throw new ServiceUnavailableException('The app could not finish connecting.');
    await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.clioMcpServer.update({
        where: { id: created.id as string },
        data: { catalogId: app.catalogId },
      }),
    );
    this.mcp.invalidate(ctx.tenantId);
    return created.id;
  }

  /**
   * Harden a managed server's allowlist to its supported read tools.
   *
   * `ownerUserId` is threaded ONLY by the personal schemasForMeriV3 read path so
   * both the read predicate and the conditional write CAS are scoped to the
   * acting owner. When it is omitted (undefined) — as finalizeConnection calls
   * it — the predicates keep their existing tenant-only canonical authorization;
   * the explicit `!== undefined` test preserves that path unchanged.
   */
  private async hardenServer(
    tenantId: string,
    serverId: string,
    ownerUserId?: string,
  ): Promise<number> {
    const ownerWhere =
      ownerUserId !== undefined ? { scope: 'user' as const, ownerUserId } : {};
    const row = await this.prisma.withTenant(tenantId, (tx) =>
      tx.clioMcpServer.findFirst({ where: { id: serverId, tenantId, ...ownerWhere } }),
    );
    const id = managedAppIdFromCatalogId(row?.catalogId);
    if (
      !row ||
      !id ||
      !this.available(id, { tenantId, userId: row.ownerUserId }) ||
      !row.enabled ||
      !['pending', 'connected'].includes(row.connectionStatus)
    )
      return 0;
    if (id === 'krisp' && !(await krispTenantEnabled(this.prisma, tenantId))) return 0;
    const safe = filterManagedReadOnlyTools(id, strings(row.toolAllowlist));
    if (
      JSON.stringify(strings(row.toolAllowlist)) !== JSON.stringify(safe) ||
      JSON.stringify(strings(row.readOnlyTools)) !== JSON.stringify(safe) ||
      !safe.length
    ) {
      await this.prisma.withTenant(tenantId, (tx) =>
        tx.clioMcpServer.updateMany({
          where: {
            id: row.id,
            tenantId,
            ...ownerWhere,
            enabled: true,
            connectionStatus: { in: ['pending', 'connected'] },
          },
          data: {
            toolAllowlist: safe as Prisma.InputJsonValue,
            readOnlyTools: safe as Prisma.InputJsonValue,
            ...(!safe.length
              ? { connectionStatus: 'error', lastError: 'No supported read tools are available.' }
              : {}),
          },
        }),
      );
      this.mcp.invalidate(tenantId);
    }
    return safe.length;
  }

  private available(id: MeriV3ManagedAppId, principal: ManagedMcpPrincipal): boolean {
    return globalMcpEnabled() && this.oauth.isConfigured() && managedAppAvailable(id, principal);
  }

  private parseAppId(value: string): MeriV3ManagedAppId {
    if ((MERIV3_MANAGED_APP_IDS as readonly string[]).includes(value))
      return value as MeriV3ManagedAppId;
    throw new BadRequestException('Unknown connected app.');
  }

  private publicStatus(value: string | undefined): MeriV3ManagedAppStatus['status'] {
    if (
      value === 'connected' ||
      value === 'pending' ||
      value === 'needs_reauth' ||
      value === 'error'
    )
      return value;
    return 'disconnected';
  }

  private async statusFor(ctx: TenantContext, id: MeriV3ManagedAppId) {
    return (await this.listApps(ctx)).find((app) => app.id === id)!;
  }

  private personalRows(ctx: TenantContext) {
    return this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.clioMcpServer.findMany({
        where: {
          tenantId: ctx.tenantId,
          scope: 'user',
          ownerUserId: ctx.userId,
          catalogId: { in: MERIV3_MANAGED_APP_IDS.map(managedCatalogId) },
        },
        orderBy: { createdAt: 'desc' },
      }),
    );
  }

  private rowsForApp(ctx: TenantContext, id: MeriV3ManagedAppId) {
    return this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.clioMcpServer.findMany({
        where: {
          tenantId: ctx.tenantId,
          scope: 'user',
          ownerUserId: ctx.userId,
          catalogId: managedCatalogId(id),
        },
        orderBy: { createdAt: 'desc' },
      }),
    );
  }
}
