import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, type ClioMcpServer } from '@prisma/client';
import { isTenantAdmin, type TenantContext } from '@capiro/shared';
import type { AppConfig } from '../config/config.schema.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { decryptSecret, encryptSecret, parseAesKey } from '../common/secret-crypto.js';
import { ToolCircuitBreaker, CircuitOpenError } from './meri-circuit-breaker.js';
import { createMcpClient, type McpServerConnection } from './meri-mcp-transport.js';
import { MeriMcpOAuthService } from './meri-mcp-oauth.service.js';
import {
  catalogTokenHeader,
  getCatalogEntry,
  MCP_CATALOG,
  type McpCatalogEntry,
} from './meri-mcp.catalog.js';
import { isFundingOpportunitiesFeatureEnabled } from '../funding-opportunities/funding-opportunities-flag.guard.js';
import {
  bridgeMcpTool,
  filterAllowedMcpTools,
  parseBridgedToolName,
  wrapMcpResultForPrompt,
  type BridgedTool,
} from './meri-mcp.helpers.js';

interface RegisteredMcpTool {
  serverId: string;
  serverName: string;
  toolName: string;
  bridgedName: string;
  readOnly: boolean;
}

interface UserMcpRegistry {
  fetchedAt: number;
  schemas: BridgedTool[];
  byBridgedName: Map<string, RegisteredMcpTool>;
}

export interface McpServerInput {
  name?: unknown;
  transport?: unknown;
  endpoint?: unknown;
  command?: unknown;
  args?: unknown;
  env?: unknown;
  authToken?: unknown;
  toolAllowlist?: unknown;
  readOnlyTools?: unknown;
  enabled?: unknown;
  scope?: unknown;
  authType?: unknown;
  // Pre-registered OAuth client (for custom oauth connectors that need one).
  oauthClientId?: unknown;
  oauthClientSecret?: unknown;
}

export interface CatalogAddInput {
  catalogId?: unknown;
  scope?: unknown;
  endpoint?: unknown;
  authToken?: unknown;
  // Pre-registered OAuth client (for connectors with oauthClientMode 'manual').
  oauthClientId?: unknown;
  oauthClientSecret?: unknown;
}

const REGISTRY_TTL_MS = 15 * 60 * 1000;

type ServerRow = ClioMcpServer;

/**
 * Tenant- and user-configured MCP connectors for Meri (connector-library v1).
 *
 * Connectors come from a curated catalog (one-click "Connect") or a custom URL.
 * Each connector is scoped either firm-wide ('tenant', admin-managed) or
 * personal ('user', owned by the person who connected it and private to them).
 * OAuth 2.1 connectors authorize per the SDK flow (see MeriMcpOAuthService) and
 * refresh tokens transparently; token/none connectors keep the original bearer
 * behavior. Only allowlisted tools register; every bridged tool is
 * audit-logged + serialized as side-effecting unless explicitly read-only.
 *
 * Registry: bridged tool schemas computed per (tenant, user) — a user sees the
 * firm-wide connectors plus their own personal ones — cached on a 15-minute TTL
 * and merged into the chat tool surface at request time. Calls run behind the
 * shared circuit breaker so a dead connector degrades the turn, not kills it.
 */
@Injectable()
export class MeriMcpService {
  private readonly logger = new Logger(MeriMcpService.name);
  private readonly registry = new Map<string, UserMcpRegistry>();
  private readonly breaker = new ToolCircuitBreaker({ threshold: 3, cooldownMs: 60_000 });

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<AppConfig, true>,
    private readonly oauth: MeriMcpOAuthService,
  ) {}

  private enabled(): boolean {
    return this.config.get('CLIO_MCP_ENABLED', { infer: true });
  }

  private encryptionKey(): Buffer {
    const raw = this.config.get('OAUTH_TOKEN_ENCRYPTION_KEY', { infer: true });
    if (!raw) {
      throw new ServiceUnavailableException(
        'MCP auth secrets need OAUTH_TOKEN_ENCRYPTION_KEY to be configured',
      );
    }
    return parseAesKey(raw);
  }

  private regKey(ctx: TenantContext): string {
    return `${ctx.tenantId}:${ctx.userId}`;
  }

  // ── Catalog ────────────────────────────────────────────────────────────

  /** The curated connector library, annotated with what this caller already has. */
  async catalog(ctx: TenantContext) {
    const rows = await this.visibleServers(ctx);
    const connected = new Set(rows.map((r) => r.catalogId).filter(Boolean) as string[]);
    const visible = await this.visibleCatalogEntries(ctx.tenantId, connected);
    return {
      oauthConfigured: this.oauth.isConfigured(),
      // Shown to admins setting up a manual (pre-registered) OAuth client.
      oauthRedirectUri: this.oauth.getRedirectUri() ?? null,
      connectors: visible.map((entry) => ({ ...entry, connected: connected.has(entry.id) })),
    };
  }

  /**
   * The catalog this tenant may see (P39).
   *
   * A flagged entry is HIDDEN rather than shown-and-disabled: a greyed-out card
   * advertises a capability, and the whole point of a per-tenant flag on a
   * connector is that a workspace which has not enabled provider research
   * should not be told the option exists.
   *
   * An ALREADY-CONNECTED entry stays visible whatever the flag says. Hiding a
   * live connector would leave a tenant with a server they can use and cannot
   * find to disconnect — the flag governs OFFERING one, not orphaning one.
   */
  private async visibleCatalogEntries(
    tenantId: string,
    connected: ReadonlySet<string>,
  ): Promise<McpCatalogEntry[]> {
    const out: McpCatalogEntry[] = [];
    for (const entry of MCP_CATALOG) {
      if (!entry.requiresFeature || connected.has(entry.id)) {
        out.push(entry);
        continue;
      }
      if (await this.featureEnabled(tenantId, entry.requiresFeature)) out.push(entry);
    }
    return out;
  }

  /**
   * One `intel_feature_flag` read, shared with Funding Opportunities.
   *
   * Reuses `isFundingOpportunitiesFeatureEnabled` — a plain function, not a
   * service, so importing it adds no module edge — rather than writing a second
   * copy of the same query. That helper deliberately does not catch (see its
   * own doc); a broken read here must fail CLOSED and quietly, because the
   * consequence is one connector missing from a library rather than a whole
   * endpoint disappearing.
   */
  private async featureEnabled(tenantId: string, feature: string): Promise<boolean> {
    try {
      return await isFundingOpportunitiesFeatureEnabled(this.prisma, tenantId, feature);
    } catch (error) {
      this.logger.error(
        `MCP catalog feature read failed for tenant ${tenantId} (${feature}); failing closed`,
        error instanceof Error ? error.stack : String(error),
      );
      return false;
    }
  }

  // ── CRUD ─────────────────────────────────────────────────────────────────

  /** Firm-wide connectors + the caller's own personal ones (secrets redacted). */
  async listServers(ctx: TenantContext) {
    const rows = await this.visibleServers(ctx);
    return rows.map((row) => this.redact(ctx, row));
  }

  async createServer(ctx: TenantContext, input: McpServerInput) {
    const scope = this.parseScope(input.scope);
    this.assertCanManage(ctx, scope, scope === 'user' ? ctx.userId : null);
    const data = this.validateInput(input, true);
    const ownerUserId = scope === 'user' ? ctx.userId : null;
    await this.assertNameAvailable(ctx, String(data.name), ownerUserId);
    // A custom OAuth connector isn't usable until the user authorizes it.
    if (data.authType === 'oauth') data.connectionStatus = 'pending';
    const row = await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.clioMcpServer.create({
        data: {
          tenantId: ctx.tenantId,
          createdByUserId: ctx.userId,
          scope,
          ownerUserId,
          ...data,
        } as unknown as Prisma.ClioMcpServerUncheckedCreateInput,
      }),
    );
    await this.audit(ctx, 'clio.mcp_server.create', row.id, {
      name: row.name,
      transport: row.transport,
      scope,
    });
    this.invalidate(ctx.tenantId);
    // Non-OAuth connectors are reachable now — discover their real tools so the
    // allowlist matches the server (only when the caller didn't pick tools).
    if (data.authType !== 'oauth' && asStringArray(row.toolAllowlist).length === 0) {
      await this.discoverTools(ctx.tenantId, row.id).catch(() => {});
    }
    // Custom OAuth connector with a pre-registered app: store its client so the
    // handshake skips dynamic registration.
    if (data.authType === 'oauth') {
      const clientId = typeof input.oauthClientId === 'string' ? input.oauthClientId.trim() : '';
      const clientSecret =
        typeof input.oauthClientSecret === 'string' ? input.oauthClientSecret.trim() : '';
      if (clientId && clientSecret) {
        await this.seedOAuthClient(ctx.tenantId, row.id, clientId, clientSecret);
      }
    }
    return this.redact(ctx, row);
  }

  /** One-click add from the curated catalog: pre-fills transport/endpoint/tools. */
  async addFromCatalog(ctx: TenantContext, input: CatalogAddInput) {
    const catalogId = String(input.catalogId ?? '').trim();
    const entry = getCatalogEntry(catalogId);
    if (!entry) throw new BadRequestException('Unknown catalog connector');

    // P39. A flagged entry is refused with the SAME sentence an unknown id gets
    // — a distinguishable refusal would advertise a capability the workspace
    // has not been given, which is the reasoning behind every 404-not-403 flag
    // guard in this repo.
    if (entry.requiresFeature && !(await this.featureEnabled(ctx.tenantId, entry.requiresFeature))) {
      throw new BadRequestException('Unknown catalog connector');
    }

    const scope = input.scope === undefined ? entry.defaultScope : this.parseScope(input.scope);
    this.assertCanManage(ctx, scope, scope === 'user' ? ctx.userId : null);

    // Manual-client connectors (HubSpot, Google, MS, Salesforce) need a
    // pre-registered OAuth app — collect the client credentials up front.
    const manualClient = entry.authType === 'oauth' && entry.oauthClientMode === 'manual';
    const clientId = typeof input.oauthClientId === 'string' ? input.oauthClientId.trim() : '';
    const clientSecret =
      typeof input.oauthClientSecret === 'string' ? input.oauthClientSecret.trim() : '';
    if (manualClient && (!clientId || !clientSecret)) {
      throw new BadRequestException(`${entry.name} needs an OAuth Client ID and Client Secret`);
    }

    // Endpoint: catalog default, or admin-supplied for self-hosted entries.
    let endpoint = entry.endpoint;
    if (entry.transport === 'http') {
      if (entry.requiresEndpointInput || !endpoint) {
        endpoint = this.requireHttpsEndpoint(input.endpoint);
      }
    }

    const ownerUserId = scope === 'user' ? ctx.userId : null;
    // Stable, tool-name-safe connector name from the catalog id (kebab-case),
    // disambiguated if the caller somehow has a custom one already.
    const name = await this.uniqueCatalogName(ctx, entry.id, ownerUserId);

    const data: Prisma.ClioMcpServerUncheckedCreateInput = {
      tenantId: ctx.tenantId,
      createdByUserId: ctx.userId,
      scope,
      ownerUserId,
      catalogId: entry.id,
      name,
      transport: entry.transport,
      endpoint: endpoint ?? null,
      command: entry.command ?? null,
      args: (entry.args ?? []) as Prisma.InputJsonValue,
      authType: entry.authType,
      // OAuth connectors aren't usable until the user authorizes; others are
      // immediately live.
      connectionStatus: entry.authType === 'oauth' ? 'pending' : 'connected',
      toolAllowlist: entry.suggestedTools.map((t) => t.name) as Prisma.InputJsonValue,
      readOnlyTools: entry.suggestedTools
        .filter((t) => t.readOnly)
        .map((t) => t.name) as Prisma.InputJsonValue,
      enabled: true,
    };

    if (entry.authType === 'token') {
      const token = typeof input.authToken === 'string' ? input.authToken.trim() : '';
      if (!token) throw new BadRequestException(`${entry.name} needs an API key`);
      const envelope = encryptSecret(this.encryptionKey(), token);
      data.authTokenCiphertext = envelope.ciphertext;
      data.authTokenIv = envelope.iv;
      data.authTokenAuthTag = envelope.authTag;
      data.authKeyVersion = this.config.get('OAUTH_TOKEN_ENCRYPTION_KEY_VERSION', { infer: true });
    }

    const row = await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.clioMcpServer.create({ data }),
    );
    await this.audit(ctx, 'clio.mcp_server.create', row.id, {
      catalogId: entry.id,
      name: row.name,
      scope,
    });
    this.invalidate(ctx.tenantId);
    // For token/none connectors the server is reachable now — replace the
    // best-effort seeded allowlist with the server's ACTUAL tools. OAuth
    // connectors are discovered after the callback (tokens aren't stored yet).
    if (entry.authType !== 'oauth') {
      await this.discoverTools(ctx.tenantId, row.id).catch(() => {});
    }
    // Seed the pre-registered client so the OAuth handshake skips dynamic
    // registration and uses the admin's app credentials.
    if (manualClient) {
      await this.seedOAuthClient(ctx.tenantId, row.id, clientId, clientSecret);
    }
    return {
      ...this.redact(ctx, row),
      // The UI uses this to immediately kick off the OAuth redirect.
      oauthRequired: entry.authType === 'oauth',
    };
  }

  async updateServer(ctx: TenantContext, id: string, input: McpServerInput) {
    const existing = await this.loadManageable(ctx, id);
    const data = this.validateInput(input, false);
    // scope/ownership are immutable after creation.
    const row = await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.clioMcpServer.update({
        where: { id },
        data: data as unknown as Prisma.ClioMcpServerUncheckedUpdateInput,
      }),
    );
    await this.audit(ctx, 'clio.mcp_server.update', id, { name: row.name, enabled: row.enabled });
    this.invalidate(ctx.tenantId);
    void existing;
    return this.redact(ctx, row);
  }

  async deleteServer(ctx: TenantContext, id: string) {
    const existing = await this.loadManageable(ctx, id);
    await this.prisma.withTenant(ctx.tenantId, (tx) => tx.clioMcpServer.delete({ where: { id } }));
    await this.audit(ctx, 'clio.mcp_server.delete', id, { name: existing.name });
    this.invalidate(ctx.tenantId);
    return { deleted: true };
  }

  /** "Refresh now": rebuild the caller's registry immediately. */
  async refreshNow(ctx: TenantContext) {
    this.registry.delete(this.regKey(ctx));
    const registry = await this.registryFor(ctx);
    return {
      tools: registry.schemas.map((schema) => schema.name),
      refreshedAt: new Date(registry.fetchedAt).toISOString(),
    };
  }

  /**
   * Discover a connector's REAL tools (tools/list) and set its allowlist to
   * them — so connecting just works without anyone guessing tool names (the
   * registry is fail-closed: only allowlisted tools register). Best-effort: on
   * failure it records lastError and leaves the existing allowlist in place.
   * Called right after a non-OAuth connect and after a successful OAuth
   * callback (tokens are stored by then). Takes tenantId — not ctx — so the
   * unauthenticated OAuth callback controller can invoke it.
   */
  async discoverTools(tenantId: string, serverId: string): Promise<number> {
    if (!this.enabled()) return 0;
    const server = await this.prisma.withTenant(tenantId, (tx) =>
      tx.clioMcpServer.findFirst({ where: { id: serverId, tenantId } }),
    );
    if (!server) return 0;
    try {
      const client = this.clientFor(server);
      const names = Array.from(new Set((await client.listTools()).map((t) => t.name))).slice(0, 50);
      const catalog = server.catalogId ? getCatalogEntry(server.catalogId) : undefined;
      // Carry over read-only classification from the catalog where the names
      // match; unknown tools default to write (audited + serialized) — safe.
      const readOnly = (catalog?.suggestedTools ?? [])
        .filter((t) => t.readOnly)
        .map((t) => t.name)
        .filter((n) => names.includes(n));
      await this.prisma.withTenant(tenantId, (tx) =>
        tx.clioMcpServer.update({
          where: { id: serverId },
          data: {
            toolAllowlist: names as Prisma.InputJsonValue,
            readOnlyTools: readOnly as Prisma.InputJsonValue,
            lastSyncAt: new Date(),
            lastError: null,
            connectionStatus: 'connected',
          },
        }),
      );
      this.invalidate(tenantId);
      return names.length;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`MCP tool discovery failed [${server.name}]: ${message}`);
      await this.prisma
        .withTenant(tenantId, (tx) =>
          tx.clioMcpServer.update({
            where: { id: serverId },
            data: {
              lastError: message.slice(0, 500),
              // Non-OAuth: surface the failure. OAuth: tokens are valid, so keep
              // 'connected' and let the registry retry on the next turn.
              ...(server.authType !== 'oauth' ? { connectionStatus: 'error' } : {}),
            },
          }),
        )
        .catch(() => {});
      this.invalidate(tenantId);
      return 0;
    }
  }

  // ── Registry (request-time tool surface) ─────────────────────────────────

  /** Drop every cached registry for a tenant (any user) after a config change. */
  invalidate(tenantId: string): void {
    const prefix = `${tenantId}:`;
    for (const key of this.registry.keys()) {
      if (key.startsWith(prefix)) this.registry.delete(key);
    }
  }

  /** Bridged tool schemas for the caller (firm-wide + own personal connectors),
   *  cached 15 min. Tools whose server's breaker is open are filtered out so the
   *  model is never offered a tool that would immediately error. */
  async bridgedSchemasFor(ctx: TenantContext): Promise<BridgedTool[]> {
    if (!this.enabled()) return [];
    try {
      const registry = await this.registryFor(ctx);
      return registry.schemas.filter((schema) => {
        const entry = registry.byBridgedName.get(schema.name);
        return !entry || !this.breaker.isOpen(`${ctx.tenantId}:mcp:${entry.serverId}`);
      });
    } catch (err) {
      this.logger.warn(
        `MCP registry unavailable [tenant ${ctx.tenantId} user ${ctx.userId}]: ${(err as Error).message}`,
      );
      return [];
    }
  }

  /** Whether a bridged tool may run concurrently (explicitly read-only). */
  isBridgedToolReadOnly(ctx: TenantContext, bridgedName: string): boolean {
    const entry = this.registry.get(this.regKey(ctx))?.byBridgedName.get(bridgedName);
    return entry?.readOnly ?? false;
  }

  private async registryFor(ctx: TenantContext): Promise<UserMcpRegistry> {
    const key = this.regKey(ctx);
    const cached = this.registry.get(key);
    if (cached && Date.now() - cached.fetchedAt < REGISTRY_TTL_MS) return cached;

    const servers = await this.visibleServers(ctx, { where: { enabled: true } });
    const schemas: BridgedTool[] = [];
    const byBridgedName = new Map<string, RegisteredMcpTool>();
    for (const server of servers) {
      const allowlist = asStringArray(server.toolAllowlist);
      if (!allowlist.length) continue; // empty allowlist registers nothing (fail-closed)
      // Skip OAuth connectors that aren't connected yet — listing tools would
      // trigger a reauth redirect and just record noise.
      if (server.authType === 'oauth' && server.connectionStatus !== 'connected') continue;
      try {
        const client = this.clientFor(server);
        const tools = filterAllowedMcpTools(await client.listTools(), allowlist);
        const readOnly = new Set(asStringArray(server.readOnlyTools));
        for (const tool of tools) {
          const bridged = bridgeMcpTool(server.name, tool);
          if (byBridgedName.has(bridged.name)) continue;
          schemas.push(bridged);
          byBridgedName.set(bridged.name, {
            serverId: server.id,
            serverName: server.name,
            toolName: tool.name,
            bridgedName: bridged.name,
            readOnly: readOnly.has(tool.name),
          });
        }
        await this.prisma
          .withTenant(ctx.tenantId, (tx) =>
            tx.clioMcpServer.update({
              where: { id: server.id },
              data: { lastSyncAt: new Date(), lastError: null },
            }),
          )
          .catch(() => {});
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.warn(`MCP listTools failed [${server.name}]: ${message}`);
        // An OAuth connector that can no longer authorize (refresh token gone /
        // expired) surfaces as UnauthorizedError — flag it for reconnection.
        const needsReauth =
          server.authType === 'oauth' && err instanceof Error && err.name === 'UnauthorizedError';
        await this.prisma
          .withTenant(ctx.tenantId, (tx) =>
            tx.clioMcpServer.update({
              where: { id: server.id },
              data: {
                lastError: message.slice(0, 500),
                ...(needsReauth ? { connectionStatus: 'needs_reauth' } : {}),
              },
            }),
          )
          .catch(() => {});
      }
    }
    const registry: UserMcpRegistry = { fetchedAt: Date.now(), schemas, byBridgedName };
    this.registry.set(key, registry);
    return registry;
  }

  // ── Execution (routed from the agentic loop) ─────────────────────────────

  async executeBridged(
    ctx: TenantContext,
    bridgedName: string,
    input: Record<string, unknown>,
  ): Promise<{ tool: string; server: string; untrusted: true; content: string }> {
    if (!this.enabled()) throw new BadRequestException('MCP tools are disabled');
    const parsed = parseBridgedToolName(bridgedName);
    if (!parsed) throw new BadRequestException(`Not a bridged MCP tool: ${bridgedName}`);
    const registry = await this.registryFor(ctx);
    const entry = registry.byBridgedName.get(bridgedName);
    if (!entry) throw new NotFoundException(`MCP tool not registered: ${bridgedName}`);
    const breakerKey = `${ctx.tenantId}:mcp:${entry.serverId}`;
    if (this.breaker.isOpen(breakerKey)) throw new CircuitOpenError(bridgedName);

    // Re-load through the visibility filter so a user can only ever execute a
    // tool from a connector they can see (firm-wide or their own).
    const [server] = await this.visibleServers(ctx, {
      where: { id: entry.serverId, enabled: true },
    });
    if (!server) throw new NotFoundException('MCP server not found or disabled');

    if (!entry.readOnly) {
      await this.audit(ctx, 'clio.mcp_tool.call', server.id, {
        server: server.name,
        tool: entry.toolName,
        argKeys: Object.keys(input ?? {}),
      });
    }

    try {
      const client = this.clientFor(server);
      const result = await client.callTool(entry.toolName, input);
      this.breaker.recordSuccess(breakerKey);
      return {
        tool: bridgedName,
        server: server.name,
        untrusted: true,
        content: wrapMcpResultForPrompt(server.name, result),
      };
    } catch (err) {
      this.breaker.recordFailure(breakerKey);
      throw err;
    }
  }

  // ── Internals ────────────────────────────────────────────────────────────

  /** Servers visible to the caller: firm-wide ∪ own personal. RLS scopes to tenant. */
  private visibleServers(
    ctx: TenantContext,
    opts?: { where?: Prisma.ClioMcpServerWhereInput },
  ): Promise<ServerRow[]> {
    return this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.clioMcpServer.findMany({
        where: {
          tenantId: ctx.tenantId,
          OR: [{ scope: 'tenant' }, { scope: 'user', ownerUserId: ctx.userId }],
          ...(opts?.where ?? {}),
        },
        orderBy: { createdAt: 'asc' },
      }),
    );
  }

  /** Load a server the caller may manage, or throw 404/403. */
  private async loadManageable(ctx: TenantContext, id: string): Promise<ServerRow> {
    const row = await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.clioMcpServer.findFirst({ where: { id, tenantId: ctx.tenantId } }),
    );
    if (!row) throw new NotFoundException('MCP server not found');
    this.assertCanManage(ctx, row.scope, row.ownerUserId);
    return row;
  }

  /** Firm-wide ⇒ tenant admin; personal ⇒ the owner. */
  private assertCanManage(ctx: TenantContext, scope: string, ownerUserId: string | null): void {
    if (scope === 'tenant') {
      if (!isTenantAdmin(ctx.role)) {
        throw new ForbiddenException('Only admins manage firm-wide connectors');
      }
    } else if (ownerUserId !== ctx.userId) {
      throw new ForbiddenException('You can only manage your own connectors');
    }
  }

  private clientFor(server: ServerRow) {
    let authToken: string | null = null;
    let authProvider: McpServerConnection['authProvider'];
    if (server.authType === 'oauth') {
      authProvider = this.oauth.buildProvider({
        id: server.id,
        tenantId: server.tenantId,
        name: server.name,
        catalogId: server.catalogId,
      });
    } else if (server.authTokenCiphertext && server.authTokenIv && server.authTokenAuthTag) {
      authToken = decryptSecret(this.encryptionKey(), {
        ciphertext: server.authTokenCiphertext,
        iv: server.authTokenIv,
        authTag: server.authTokenAuthTag,
      });
    }
    const conn: McpServerConnection = {
      transport: server.transport === 'stdio' ? 'stdio' : 'http',
      endpoint: server.endpoint,
      command: server.command,
      args: asStringArray(server.args),
      env: asStringRecord(server.envJson),
      authToken,
      // P39. Read from the CATALOG by the row's catalogId — never from a field
      // on the row. A tenant-editable header name would let anyone who can add
      // a connector aim a decrypted secret at an arbitrary header on an
      // arbitrary endpoint. A custom (catalog-less) connector gets null here
      // and keeps the bearer default.
      tokenHeader: catalogTokenHeader(server.catalogId),
      authProvider,
    };
    return createMcpClient(
      conn,
      this.config.get('CLIO_MCP_STDIO_ALLOWED_COMMANDS', { infer: true }),
    );
  }

  /**
   * Pre-seed a manually-registered OAuth client (admin-supplied client_id +
   * client_secret) into the credential row, so the SDK auth() flow finds it via
   * clientInformation() and uses it (client_secret_post) instead of attempting
   * dynamic client registration — for providers that don't support RFC 7591
   * (HubSpot, Google, Microsoft, Salesforce). Secret encrypted at rest.
   */
  private async seedOAuthClient(
    tenantId: string,
    serverId: string,
    clientId: string,
    clientSecret: string,
  ): Promise<void> {
    const envelope = encryptSecret(this.encryptionKey(), clientSecret);
    const keyVersion = this.config.get('OAUTH_TOKEN_ENCRYPTION_KEY_VERSION', { infer: true });
    await this.prisma.withTenant(tenantId, (tx) =>
      tx.clioMcpOAuthCredential.upsert({
        where: { serverId },
        update: {
          clientId,
          clientSecretCiphertext: envelope.ciphertext,
          clientSecretIv: envelope.iv,
          clientSecretAuthTag: envelope.authTag,
          keyVersion,
        },
        create: {
          tenantId,
          serverId,
          clientId,
          clientSecretCiphertext: envelope.ciphertext,
          clientSecretIv: envelope.iv,
          clientSecretAuthTag: envelope.authTag,
          keyVersion,
        },
      }),
    );
  }

  private parseScope(value: unknown): 'tenant' | 'user' {
    if (value === undefined || value === null) return 'tenant';
    const scope = String(value);
    if (scope !== 'tenant' && scope !== 'user') {
      throw new BadRequestException('scope must be "tenant" or "user"');
    }
    return scope;
  }

  private requireHttpsEndpoint(value: unknown): string {
    const endpoint = String(value ?? '').trim();
    if (!endpoint) throw new BadRequestException('This connector needs a server URL');
    this.assertEndpointAllowed(endpoint);
    return endpoint;
  }

  /**
   * SSRF guard for user-supplied connector endpoints. Requires https and
   * rejects private / loopback / link-local hosts so a tenant can't point the
   * API host at internal services (the cloud metadata endpoint, RFC1918 ranges,
   * loopback ports). Loopback/plaintext is permitted only under the dev-only
   * CLIO_MCP_ALLOW_INSECURE_LOCAL flag. (Literal-host check; DNS-rebinding to an
   * internal IP is a residual closed at the network-egress layer.)
   */
  private assertEndpointAllowed(endpoint: string): void {
    let url: URL;
    try {
      url = new URL(endpoint);
    } catch {
      throw new BadRequestException('endpoint must be a valid URL');
    }
    const allowInsecureLocal = this.config.get('CLIO_MCP_ALLOW_INSECURE_LOCAL', { infer: true });
    const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    if (url.protocol !== 'https:') {
      if (!(allowInsecureLocal && isLoopbackHost(host))) {
        throw new BadRequestException('endpoint must use https');
      }
    }
    if (!allowInsecureLocal && isPrivateHost(host)) {
      throw new BadRequestException(
        'endpoint may not target a private, loopback, or link-local address',
      );
    }
  }

  private async assertNameAvailable(
    ctx: TenantContext,
    name: string,
    ownerUserId: string | null,
  ): Promise<void> {
    const clash = await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.clioMcpServer.findFirst({
        where: { tenantId: ctx.tenantId, ownerUserId, name },
        select: { id: true },
      }),
    );
    if (clash) throw new ConflictException(`A connector named "${name}" already exists`);
  }

  private async uniqueCatalogName(
    ctx: TenantContext,
    base: string,
    ownerUserId: string | null,
  ): Promise<string> {
    for (let suffix = 0; suffix < 50; suffix += 1) {
      const candidate = suffix === 0 ? base : `${base}-${suffix + 1}`.slice(0, 64);
      const clash = await this.prisma.withTenant(ctx.tenantId, (tx) =>
        tx.clioMcpServer.findFirst({
          where: { tenantId: ctx.tenantId, ownerUserId, name: candidate },
          select: { id: true },
        }),
      );
      if (!clash) return candidate;
    }
    throw new ConflictException('Too many connectors with this name');
  }

  private validateInput(input: McpServerInput, isCreate: boolean): Record<string, unknown> {
    const data: Record<string, unknown> = {};
    if (isCreate || input.name !== undefined) {
      const name = String(input.name ?? '').trim();
      if (!/^[a-z0-9][a-z0-9-_]{1,63}$/i.test(name)) {
        throw new BadRequestException('name must be 2-64 chars of [a-zA-Z0-9-_]');
      }
      data.name = name;
    }
    if (isCreate || input.transport !== undefined) {
      const transport = String(input.transport ?? '');
      if (!['http', 'stdio'].includes(transport)) {
        throw new BadRequestException('transport must be http or stdio');
      }
      data.transport = transport;
    }
    if (input.endpoint !== undefined) {
      const endpoint = input.endpoint === null ? null : String(input.endpoint).trim();
      if (endpoint) this.assertEndpointAllowed(endpoint);
      data.endpoint = endpoint;
    }
    if (input.command !== undefined) {
      data.command = input.command === null ? null : String(input.command).trim().slice(0, 500);
    }
    if (input.args !== undefined) {
      data.args = asStringArray(input.args).slice(0, 20);
    }
    if (input.env !== undefined) {
      data.envJson = asStringRecord(input.env);
    }
    if (input.toolAllowlist !== undefined) {
      data.toolAllowlist = asStringArray(input.toolAllowlist).slice(0, 50);
    }
    if (input.readOnlyTools !== undefined) {
      data.readOnlyTools = asStringArray(input.readOnlyTools).slice(0, 50);
    }
    if (input.enabled !== undefined) {
      data.enabled = Boolean(input.enabled);
    }
    if (typeof input.authToken === 'string' && input.authToken.trim()) {
      const envelope = encryptSecret(this.encryptionKey(), input.authToken.trim());
      data.authTokenCiphertext = envelope.ciphertext;
      data.authTokenIv = envelope.iv;
      data.authTokenAuthTag = envelope.authTag;
      data.authKeyVersion = this.config.get('OAUTH_TOKEN_ENCRYPTION_KEY_VERSION', { infer: true });
      data.authType = 'token';
    } else if (input.authToken === null) {
      data.authTokenCiphertext = null;
      data.authTokenIv = null;
      data.authTokenAuthTag = null;
      data.authKeyVersion = null;
    }
    // Explicit authType wins over the token-presence inference above.
    if (input.authType !== undefined) {
      const authType = String(input.authType);
      if (!['none', 'token', 'oauth'].includes(authType)) {
        throw new BadRequestException('authType must be none, token, or oauth');
      }
      data.authType = authType;
    }
    if (isCreate) {
      if (data.transport === 'http' && !data.endpoint) {
        throw new BadRequestException('http transport requires an endpoint');
      }
      if (data.transport === 'stdio' && !data.command) {
        throw new BadRequestException('stdio transport requires a command');
      }
      if (data.authType === undefined) data.authType = data.authTokenCiphertext ? 'token' : 'none';
    }
    return data;
  }

  /** Never return secret material — only whether a token / OAuth link is set. */
  private redact(ctx: TenantContext, row: ServerRow) {
    return {
      id: row.id,
      name: row.name,
      transport: row.transport,
      endpoint: row.endpoint,
      command: row.command,
      args: asStringArray(row.args),
      toolAllowlist: asStringArray(row.toolAllowlist),
      readOnlyTools: asStringArray(row.readOnlyTools),
      enabled: row.enabled,
      scope: row.scope,
      catalogId: row.catalogId,
      authType: row.authType,
      connectionStatus: row.connectionStatus,
      isOwner: row.scope === 'user' ? row.ownerUserId === ctx.userId : true,
      canManage: row.scope === 'tenant' ? isTenantAdmin(ctx.role) : row.ownerUserId === ctx.userId,
      lastSyncAt: row.lastSyncAt,
      lastError: row.lastError,
      hasAuthToken: Boolean(row.authTokenCiphertext),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  private async audit(
    ctx: TenantContext,
    action: string,
    entityId: string,
    after: Record<string, unknown>,
  ): Promise<void> {
    await this.prisma
      .withTenant(ctx.tenantId, (tx) =>
        tx.auditLog.create({
          data: {
            tenantId: ctx.tenantId,
            actorUserId: ctx.userId,
            actorRole: ctx.role,
            action,
            entityType: 'clio_mcp_server',
            entityId,
            after: after as Prisma.InputJsonValue,
          },
        }),
      )
      .catch((err) => {
        this.logger.warn(`MCP audit write failed [${action}]: ${(err as Error).message}`);
      });
  }
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

function asStringRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === 'string') out[k] = v;
  }
  return out;
}

function isLoopbackHost(host: string): boolean {
  return host === 'localhost' || host === '::1' || /^127\./.test(host);
}

/** Literal private / loopback / link-local host (IPv4, IPv6, or *.local). */
function isPrivateHost(host: string): boolean {
  if (host === 'localhost' || host.endsWith('.local')) return true;
  // IPv6 unique-local (fc00::/7), link-local (fe80::/10), loopback, unspecified.
  if (host.includes(':')) {
    if (host === '::1' || host === '::') return true;
    if (
      /^f[cd]/.test(host) ||
      host.startsWith('fe8') ||
      host.startsWith('fe9') ||
      host.startsWith('fea') ||
      host.startsWith('feb')
    ) {
      return true;
    }
    const mapped = host.match(/::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i);
    return mapped ? isPrivateIpv4(mapped[1]!) : false;
  }
  return /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host) ? isPrivateIpv4(host) : false;
}

function isPrivateIpv4(ip: string): boolean {
  const parts = ip.split('.').map((n) => Number(n));
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return true; // malformed → treat as unsafe
  }
  const [a, b] = parts as [number, number, number, number];
  if (a === 0 || a === 127 || a === 10) return true; // unspecified, loopback, private
  if (a === 169 && b === 254) return true; // link-local incl. 169.254.169.254 metadata
  if (a === 192 && b === 168) return true; // private
  if (a === 172 && b >= 16 && b <= 31) return true; // private
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  return false;
}

// Re-export the catalog entry type for controllers/consumers.
export type { McpCatalogEntry };
