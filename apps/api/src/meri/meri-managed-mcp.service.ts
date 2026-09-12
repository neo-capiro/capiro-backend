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
  managedAppConfigured,
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

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function serverPrefix(name: string): string {
  const probe = bridgedToolName(name, '__managed_probe__');
  return probe.slice(0, probe.lastIndexOf('__') + 2);
}

function globalMcpEnabled(): boolean {
  const value = process.env.CLIO_MCP_ENABLED?.trim().toLowerCase();
  return value === undefined || !['false', '0', 'no', 'off'].includes(value);
}

@Injectable()
export class MeriManagedMcpService {
  private readonly connecting = new Map<string, Promise<{
    app: MeriV3ManagedAppStatus;
    authUrl: string | null;
    alreadyConnected: boolean;
  }>>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly mcp: MeriMcpService,
    private readonly oauth: MeriMcpOAuthService,
  ) {}

  async listApps(ctx: TenantContext): Promise<MeriV3ManagedAppStatus[]> {
    const rows = await this.personalRows(ctx);
    return MERIV3_MANAGED_APP_IDS.map((id) => {
      const app = MANAGED_MCP_APPS[id];
      const row = rows.find((candidate) => candidate.catalogId === app.catalogId);
      let status = this.publicStatus(row?.connectionStatus);
      const available = this.available(id);
      const usable = Boolean(row?.enabled && filterManagedReadOnlyTools(id, strings(row.toolAllowlist)).length);
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
    if (!globalMcpEnabled()) {
      throw new ServiceUnavailableException('Connected apps are temporarily disabled.');
    }
    if (!this.available(appId)) {
      throw new ServiceUnavailableException(MANAGED_MCP_APPS[appId].name + ' is temporarily unavailable. Please try again later.');
    }

    const existing = await this.rowsForApp(ctx, appId);
    const retained = existing.find((row) => row.enabled && ['connected', 'error'].includes(row.connectionStatus));
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
      if (!count) throw new ServiceUnavailableException('The app could not finish connecting. Please try again.');
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

  async finalizeConnection(tenantId: string, serverId: string): Promise<number> {
    const count = await this.hardenServer(tenantId, serverId);
    if (!count) throw new ServiceUnavailableException('No supported read tools are available. Please try reconnecting.');
    const result = await this.prisma.withTenant(tenantId, (tx) =>
      tx.clioMcpServer.updateMany({
        where: { id: serverId, tenantId, enabled: true, connectionStatus: { in: ['pending', 'connected'] } },
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
    if (!globalMcpEnabled() || !this.oauth.isConfigured()) return [];
    const prefixes = new Map<string, MeriV3ManagedAppId>();
    for (const row of await this.personalRows(ctx)) {
      const id = managedAppIdFromCatalogId(row.catalogId);
      if (!id || !this.available(id) || !row.enabled || row.connectionStatus !== 'connected') continue;
      if (await this.hardenServer(ctx.tenantId, row.id)) prefixes.set(serverPrefix(row.name), id);
    }
    if (!prefixes.size) return [];
    const schemas = await this.mcp.bridgedSchemasFor(ctx);
    const out: MeriV3ManagedMcpSchema[] = [];
    for (const schema of schemas) {
      const match = [...prefixes].find(([prefix]) => schema.name.startsWith(prefix));
      if (!match || !this.mcp.isBridgedToolReadOnly(ctx, schema.name)) continue;
      const id = match[1];
      out.push({ ...schema, source: 'managed_mcp', appId: id, appName: MANAGED_MCP_APPS[id].name, readOnly: true });
    }
    return out;
  }

  async executeRead(ctx: TenantContext, toolName: string, input: Record<string, unknown>): Promise<unknown> {
    assertMeriToolRequestActive();
    const schemas = await this.schemasForMeriV3(ctx);
    if (!schemas.some((schema) => schema.name === toolName) || !this.mcp.isBridgedToolReadOnly(ctx, toolName)) {
      throw new BadRequestException('Connected-app tool is unavailable or not read-only.');
    }
    assertMeriToolRequestActive();
    // executeBridged rechecks the current row immediately before provider I/O.
    return this.mcp.executeBridged(ctx, toolName, input);
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
      ...(app.clientSecretEnv ? { oauthClientSecret: process.env[app.clientSecretEnv]?.trim() } : {}),
    })) as { id?: unknown };
    if (typeof created.id !== 'string') throw new ServiceUnavailableException('The app could not finish connecting.');
    await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.clioMcpServer.update({ where: { id: created.id as string }, data: { catalogId: app.catalogId } }),
    );
    this.mcp.invalidate(ctx.tenantId);
    return created.id;
  }

  private async hardenServer(tenantId: string, serverId: string): Promise<number> {
    const row = await this.prisma.withTenant(tenantId, (tx) =>
      tx.clioMcpServer.findFirst({ where: { id: serverId, tenantId } }),
    );
    const id = managedAppIdFromCatalogId(row?.catalogId);
    if (!row || !id || !this.available(id) || !row.enabled || !['pending', 'connected'].includes(row.connectionStatus)) return 0;
    const safe = filterManagedReadOnlyTools(id, strings(row.toolAllowlist));
    if (JSON.stringify(strings(row.toolAllowlist)) !== JSON.stringify(safe) ||
        JSON.stringify(strings(row.readOnlyTools)) !== JSON.stringify(safe) || !safe.length) {
      await this.prisma.withTenant(tenantId, (tx) =>
        tx.clioMcpServer.updateMany({
          where: { id: row.id, tenantId, enabled: true, connectionStatus: { in: ['pending', 'connected'] } },
          data: {
            toolAllowlist: safe as Prisma.InputJsonValue,
            readOnlyTools: safe as Prisma.InputJsonValue,
            ...(!safe.length ? { connectionStatus: 'error', lastError: 'No supported read tools are available.' } : {}),
          },
        }),
      );
      this.mcp.invalidate(tenantId);
    }
    return safe.length;
  }

  private available(id: MeriV3ManagedAppId): boolean {
    return globalMcpEnabled() && this.oauth.isConfigured() && managedAppConfigured(id);
  }

  private parseAppId(value: string): MeriV3ManagedAppId {
    if ((MERIV3_MANAGED_APP_IDS as readonly string[]).includes(value)) return value as MeriV3ManagedAppId;
    throw new BadRequestException('Unknown connected app.');
  }

  private publicStatus(value: string | undefined): MeriV3ManagedAppStatus['status'] {
    if (value === 'connected' || value === 'pending' || value === 'needs_reauth' || value === 'error') return value;
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
        where: { tenantId: ctx.tenantId, scope: 'user', ownerUserId: ctx.userId, catalogId: managedCatalogId(id) },
        orderBy: { createdAt: 'desc' },
      }),
    );
  }
}
