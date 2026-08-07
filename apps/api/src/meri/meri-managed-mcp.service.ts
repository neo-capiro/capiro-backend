import { BadRequestException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { TenantContext } from '@capiro/shared';
import { PrismaService } from '../prisma/prisma.service.js';
import { MeriMcpOAuthService } from './meri-mcp-oauth.service.js';
import { MeriMcpService } from './meri-mcp.service.js';
import { bridgedToolName, type BridgedTool } from './meri-mcp.helpers.js';
import {
  AIRTABLE_READ_ONLY_TOOLS,
  MERIV3_AIRTABLE_CATALOG_ID,
  MERIV3_AIRTABLE_ENDPOINT,
  MERIV3_HUBSPOT_CATALOG_ID,
  MERIV3_HUBSPOT_ENDPOINT,
  MERIV3_MANAGED_APP_IDS,
  filterManagedReadOnlyTools,
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

const APP_META: Record<MeriV3ManagedAppId, { name: string; description: string }> = {
  hubspot: {
    name: 'HubSpot',
    description: 'Let Meri search CRM contacts, companies, deals, activities, and account context.',
  },
  airtable: {
    name: 'Airtable',
    description: 'Let Meri search bases, tables, records, interfaces, and tracking data you can access.',
  },
};

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string' && item.length > 0);
}

function sameStrings(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function serverPrefix(name: string): string {
  const probe = bridgedToolName(name, '__managed_probe__');
  return probe.slice(0, probe.lastIndexOf('__') + 2);
}

function globalMcpEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.CLIO_MCP_ENABLED?.trim().toLowerCase();
  return raw === undefined || !['false', '0', 'no', 'off'].includes(raw);
}

@Injectable()
export class MeriManagedMcpService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly mcp: MeriMcpService,
    private readonly oauth: MeriMcpOAuthService,
  ) {}

  async listApps(ctx: TenantContext): Promise<MeriV3ManagedAppStatus[]> {
    const rows = await this.personalRows(ctx);
    const newest = new Map<MeriV3ManagedAppId, (typeof rows)[number]>();
    for (const row of rows) {
      const appId = managedAppIdFromCatalogId(row.catalogId);
      if (appId && !newest.has(appId)) newest.set(appId, row);
    }
    return MERIV3_MANAGED_APP_IDS.map((id) => {
      const row = newest.get(id);
      const status = this.publicStatus(row?.connectionStatus);
      const available = this.available(id);
      const lastError = row?.lastError ? String(row.lastError).slice(0, 300) : null;
      return {
        id,
        ...APP_META[id],
        status,
        // A retained OAuth row can still say `connected` while the platform
        // kill switch or provider setup is unavailable. Do not advertise a live
        // connection that Meri cannot actually use.
        connected: status === 'connected' && available,
        available,
        needsReauth: status === 'needs_reauth',
        lastError,
      };
    });
  }

  async connect(
    ctx: TenantContext,
    appIdRaw: string,
  ): Promise<{
    app: MeriV3ManagedAppStatus;
    authUrl: string | null;
    alreadyConnected: boolean;
  }> {
    const appId = this.parseAppId(appIdRaw);
    if (!globalMcpEnabled()) {
      throw new ServiceUnavailableException('Connected apps are temporarily disabled.');
    }
    if (!this.oauth.isConfigured()) {
      throw new ServiceUnavailableException('Connected apps are temporarily unavailable.');
    }
    if (!this.available(appId)) {
      throw new ServiceUnavailableException(
        appId === 'hubspot'
          ? 'HubSpot sign-in is not configured for Capiro yet.'
          : 'Airtable sign-in is not configured for Capiro yet.',
      );
    }

    const existing = await this.rowsForApp(ctx, appId);
    const connected = existing.find((row) => row.connectionStatus === 'connected' && row.enabled);
    if (connected) {
      await this.hardenServer(ctx.tenantId, connected.id);
      const status = (await this.listApps(ctx)).find((item) => item.id === appId)!;
      return { app: status, authUrl: null, alreadyConnected: true };
    }

    // A failed/abandoned OAuth handshake may leave a PKCE verifier or one-time
    // state behind. Reconnect starts from a fresh personal connector rather than
    // trying to repair opaque provider state in place.
    for (const row of existing) {
      await this.mcp.deleteServer(ctx, row.id);
    }

    const serverId =
      appId === 'hubspot' ? await this.createHubSpot(ctx) : await this.createAirtable(ctx);
    const started = await this.oauth.start(ctx, serverId);
    const status = (await this.listApps(ctx)).find((item) => item.id === appId)!;
    return {
      app: status,
      authUrl: started.authUrl,
      alreadyConnected: Boolean(started.alreadyConnected),
    };
  }

  async disconnect(ctx: TenantContext, appIdRaw: string): Promise<{ disconnected: true }> {
    const appId = this.parseAppId(appIdRaw);
    const rows = await this.rowsForApp(ctx, appId);
    for (const row of rows) {
      if (row.authType === 'oauth') await this.oauth.disconnect(ctx, row.id);
      else await this.mcp.deleteServer(ctx, row.id);
    }
    this.mcp.invalidate(ctx.tenantId);
    return { disconnected: true };
  }

  /**
   * Called after OAuth tool discovery. It is safe to call repeatedly and is
   * deliberately tenant-id based so the unauthenticated signed OAuth callback
   * can harden the connector before returning the browser to Meri.
   */
  async finalizeConnection(tenantId: string, serverId: string): Promise<number> {
    return this.hardenServer(tenantId, serverId);
  }

  /** Identify whether an OAuth callback belongs to the simple MeriV3 app UI. */
  async appForServer(
    tenantId: string,
    serverId: string,
  ): Promise<{ id: MeriV3ManagedAppId; name: string } | null> {
    const row = await this.prisma.withTenant(tenantId, (tx) =>
      tx.clioMcpServer.findFirst({
        where: { id: serverId, tenantId },
        select: { catalogId: true },
      }),
    );
    const id = managedAppIdFromCatalogId(row?.catalogId);
    return id ? { id, name: APP_META[id].name } : null;
  }

  /** Schemas MeriV3 may see. No connection => no schemas. */
  async schemasForMeriV3(ctx: TenantContext): Promise<MeriV3ManagedMcpSchema[]> {
    if (!globalMcpEnabled()) return [];
    const rows = (await this.personalRows(ctx)).filter(
      (row) => row.enabled && row.connectionStatus === 'connected',
    );
    if (!rows.length) return [];

    for (const row of rows) await this.hardenServer(ctx.tenantId, row.id);
    const managedRows = (await this.personalRows(ctx)).filter(
      (row) => row.enabled && row.connectionStatus === 'connected',
    );
    const prefixes = new Map<string, { id: MeriV3ManagedAppId; name: string }>();
    for (const row of managedRows) {
      const id = managedAppIdFromCatalogId(row.catalogId);
      if (!id) continue;
      prefixes.set(serverPrefix(row.name), { id, name: APP_META[id].name });
    }
    if (!prefixes.size) return [];

    const schemas = await this.mcp.bridgedSchemasFor(ctx);
    const out: MeriV3ManagedMcpSchema[] = [];
    for (const schema of schemas) {
      const match = [...prefixes.entries()].find(([prefix]) => schema.name.startsWith(prefix));
      if (!match) continue;
      const [, app] = match;
      if (!this.mcp.isBridgedToolReadOnly(ctx, schema.name)) continue;
      out.push({
        ...schema,
        source: 'managed_mcp',
        appId: app.id,
        appName: app.name,
        readOnly: true,
      });
    }
    return out;
  }

  /** Execute only a schema the server just proved is a connected managed read. */
  async executeRead(
    ctx: TenantContext,
    toolName: string,
    input: Record<string, unknown>,
  ): Promise<unknown> {
    const schemas = await this.schemasForMeriV3(ctx);
    if (!schemas.some((schema) => schema.name === toolName)) {
      throw new BadRequestException('Connected-app tool is unavailable or not read-only.');
    }
    if (!this.mcp.isBridgedToolReadOnly(ctx, toolName)) {
      throw new BadRequestException('Connected-app writes are not enabled in MeriV3.');
    }
    return this.mcp.executeBridged(ctx, toolName, input);
  }

  private async createHubSpot(ctx: TenantContext): Promise<string> {
    const clientId = process.env.MERI_MCP_HUBSPOT_CLIENT_ID?.trim();
    const clientSecret = process.env.MERI_MCP_HUBSPOT_CLIENT_SECRET?.trim();
    if (!clientId || !clientSecret) {
      throw new ServiceUnavailableException('HubSpot sign-in is not configured for Capiro yet.');
    }
    const created = (await this.mcp.createServer(ctx, {
      name: MERIV3_HUBSPOT_CATALOG_ID,
      transport: 'http',
      endpoint: MERIV3_HUBSPOT_ENDPOINT,
      authType: 'oauth',
      scope: 'user',
      toolAllowlist: [],
      readOnlyTools: [],
      enabled: true,
      oauthClientId: clientId,
      oauthClientSecret: clientSecret,
    })) as { id?: unknown };
    const id = typeof created.id === 'string' ? created.id : '';
    if (!id) throw new ServiceUnavailableException('HubSpot connection could not be created.');
    await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.clioMcpServer.update({
        where: { id },
        data: { catalogId: MERIV3_HUBSPOT_CATALOG_ID },
      }),
    );
    this.mcp.invalidate(ctx.tenantId);
    return id;
  }

  private async createAirtable(ctx: TenantContext): Promise<string> {
    const readOnly = [...AIRTABLE_READ_ONLY_TOOLS];
    const created = (await this.mcp.createServer(ctx, {
      name: MERIV3_AIRTABLE_CATALOG_ID,
      transport: 'http',
      endpoint: MERIV3_AIRTABLE_ENDPOINT,
      authType: 'oauth',
      scope: 'user',
      toolAllowlist: readOnly,
      readOnlyTools: readOnly,
      enabled: true,
    })) as { id?: unknown };
    const id = typeof created.id === 'string' ? created.id : '';
    if (!id) throw new ServiceUnavailableException('Airtable connection could not be created.');
    await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.clioMcpServer.update({
        where: { id },
        data: { catalogId: MERIV3_AIRTABLE_CATALOG_ID },
      }),
    );
    this.mcp.invalidate(ctx.tenantId);
    return id;
  }

  private async hardenServer(tenantId: string, serverId: string): Promise<number> {
    const row = await this.prisma.withTenant(tenantId, (tx) =>
      tx.clioMcpServer.findFirst({
        where: { id: serverId, tenantId },
        select: {
          id: true,
          catalogId: true,
          toolAllowlist: true,
          readOnlyTools: true,
          connectionStatus: true,
        },
      }),
    );
    if (!row) return 0;
    const appId = managedAppIdFromCatalogId(row.catalogId);
    if (!appId) return 0;
    const discovered = stringArray(row.toolAllowlist);
    const safe = filterManagedReadOnlyTools(appId, discovered);
    const currentReads = stringArray(row.readOnlyTools);
    if (!sameStrings(discovered, safe) || !sameStrings(currentReads, safe)) {
      await this.prisma.withTenant(tenantId, (tx) =>
        tx.clioMcpServer.update({
          where: { id: row.id },
          data: {
            toolAllowlist: safe as Prisma.InputJsonValue,
            readOnlyTools: safe as Prisma.InputJsonValue,
            lastError:
              safe.length === 0 && row.connectionStatus === 'connected'
                ? 'Connected, but no approved read-only tools are currently available.'
                : null,
          },
        }),
      );
      this.mcp.invalidate(tenantId);
    }
    return safe.length;
  }

  private available(appId: MeriV3ManagedAppId): boolean {
    if (!globalMcpEnabled() || !this.oauth.isConfigured()) return false;
    if (appId === 'airtable') return true;
    return Boolean(
      process.env.MERI_MCP_HUBSPOT_CLIENT_ID?.trim() &&
        process.env.MERI_MCP_HUBSPOT_CLIENT_SECRET?.trim(),
    );
  }

  private parseAppId(value: string): MeriV3ManagedAppId {
    if ((MERIV3_MANAGED_APP_IDS as readonly string[]).includes(value)) {
      return value as MeriV3ManagedAppId;
    }
    throw new BadRequestException('Unknown connected app.');
  }

  private publicStatus(value: string | undefined): MeriV3ManagedAppStatus['status'] {
    if (value === 'connected') return 'connected';
    if (value === 'pending') return 'pending';
    if (value === 'needs_reauth') return 'needs_reauth';
    if (value === 'error') return 'error';
    return 'disconnected';
  }

  private personalRows(ctx: TenantContext) {
    return this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.clioMcpServer.findMany({
        where: {
          tenantId: ctx.tenantId,
          scope: 'user',
          ownerUserId: ctx.userId,
          catalogId: { in: [MERIV3_HUBSPOT_CATALOG_ID, MERIV3_AIRTABLE_CATALOG_ID] },
        },
        orderBy: { createdAt: 'desc' },
      }),
    );
  }

  private rowsForApp(ctx: TenantContext, appId: MeriV3ManagedAppId) {
    return this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.clioMcpServer.findMany({
        where: {
          tenantId: ctx.tenantId,
          scope: 'user',
          ownerUserId: ctx.userId,
          catalogId: managedCatalogId(appId),
        },
        orderBy: { createdAt: 'desc' },
      }),
    );
  }
}
