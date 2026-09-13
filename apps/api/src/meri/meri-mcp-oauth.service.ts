import { managedAppDefinition, managedAppAvailable } from './meri-managed-mcp.helpers.js';
/**
 * OAuth 2.1 connect flow for Meri MCP connectors (connector-library v1).
 *
 * A parallel, self-contained implementation of the same signed-state +
 * encrypted-token pattern used by the Microsoft Graph integration — but for
 * arbitrary remote MCP servers, driven by the MCP SDK's `auth()` orchestrator
 * (RFC 9728/8414 discovery, RFC 7591 dynamic client registration, PKCE). It
 * deliberately does NOT touch the Microsoft/Clerk/tenant-middleware auth paths
 * (those are change-controlled); it only reuses the well-worn HMAC-signed-state
 * idea so a provider callback can be tied back to the connection that began it.
 *
 * Two web requests:
 *   start(ctx, serverId)      → returns an authUrl for the browser to visit
 *   handleCallback(code,state) → verifies state, exchanges the code, stores tokens
 *
 * Token refresh at runtime is automatic: the transport attaches the same
 * DB-backed provider, so an expired access token is refreshed transparently.
 */
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { auth } from '@modelcontextprotocol/sdk/client/auth.js';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { TenantContext } from '@capiro/shared';
import type { AppConfig } from '../config/config.schema.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { parseAesKey } from '../common/secret-crypto.js';
import { DbOAuthClientProvider } from './meri-mcp-oauth.provider.js';
import { getCatalogEntry } from './meri-mcp.catalog.js';

const STATE_TTL_SECONDS = 600;

interface OAuthStatePayload {
  t: string; // tenant id
  s: string; // server id
  u: string; // user id that started the flow
  n: string; // nonce
  e: number; // expires at (unix seconds)
}

type OAuthServerRow = {
  id: string;
  name: string;
  endpoint: string | null;
  authType: string;
  catalogId: string | null;
  scope: string;
  ownerUserId: string | null;
  enabled: boolean;
};

@Injectable()
export class MeriMcpOAuthService {
  private readonly logger = new Logger(MeriMcpOAuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<AppConfig, true>,
  ) {}

  // ── configuration ────────────────────────────────────────────────────────

  isConfigured(): boolean {
    return Boolean(this.redirectUri() && this.rawStateSecret() && this.rawEncryptionKey());
  }

  getSuccessRedirect(): string {
    return this.config.get('CLIO_MCP_OAUTH_SUCCESS_REDIRECT', { infer: true });
  }

  /** The absolute OAuth callback URL admins must register in their app. */
  getRedirectUri(): string | undefined {
    return this.redirectUri();
  }

  private redirectUri(): string | undefined {
    return this.config.get('CLIO_MCP_OAUTH_REDIRECT_URI', { infer: true });
  }

  private rawStateSecret(): string | undefined {
    return this.config.get('OAUTH_STATE_SECRET', { infer: true });
  }

  private rawEncryptionKey(): string | undefined {
    return this.config.get('OAUTH_TOKEN_ENCRYPTION_KEY', { infer: true });
  }

  private assertConfigured(): void {
    if (!this.isConfigured()) {
      throw new ServiceUnavailableException(
        'MCP OAuth is not configured. Required: CLIO_MCP_OAUTH_REDIRECT_URI, OAUTH_STATE_SECRET, OAUTH_TOKEN_ENCRYPTION_KEY.',
      );
    }
  }

  /**
   * Build a DB-backed provider for a server. Used both by the connect flow and
   * by the transport (runtime token refresh). `signedState` is only needed when
   * starting an interactive authorization.
   */
  buildProvider(
    server: { id: string; tenantId: string; name: string; catalogId: string | null },
    signedState?: string,
  ): DbOAuthClientProvider {
    const catalog = server.catalogId ? getCatalogEntry(server.catalogId) : undefined;
    return new DbOAuthClientProvider({
      prisma: this.prisma,
      encryptionKey: parseAesKey(this.rawEncryptionKey()!),
      keyVersion: this.config.get('OAUTH_TOKEN_ENCRYPTION_KEY_VERSION', { infer: true }),
      tenantId: server.tenantId,
      serverId: server.id,
      redirectUri: this.redirectUri()!,
      clientName: `Capiro Meri — ${server.name}`,
      signedState,
      requestedScopes: managedAppDefinition(server.catalogId)?.oauthScopes ?? catalog?.oauthScopes,
      managed: Boolean(managedAppDefinition(server.catalogId)),
      offlineAccess: managedAppDefinition(server.catalogId)?.offlineAccess,
    });
  }

  // ── start ─────────────────────────────────────────────────────────────────

  /** Begin an OAuth connection; returns the authorization URL for the browser,
   *  or { authUrl: null, alreadyConnected: true } if valid tokens already exist. */
  async start(
    ctx: TenantContext,
    serverId: string,
  ): Promise<{ authUrl: string | null; alreadyConnected?: boolean }> {
    this.assertConfigured();
    const server = await this.loadOwnedServer(ctx, serverId);
    this.assertManagedServer(server, ctx.tenantId);
    if (server.authType !== 'oauth') {
      throw new BadRequestException('This connector does not use OAuth');
    }
    if (!server.endpoint) {
      throw new BadRequestException('This connector has no server URL configured');
    }

    const nonce = randomBytes(16).toString('base64url');
    const signedState = this.signState({
      t: ctx.tenantId,
      s: server.id,
      u: ctx.userId,
      n: nonce,
      e: Math.floor(Date.now() / 1000) + STATE_TTL_SECONDS,
    });
    const provider = this.buildProvider(
      { id: server.id, tenantId: ctx.tenantId, name: server.name, catalogId: server.catalogId },
      signedState,
    );

    await this.setStatus(
      ctx.tenantId,
      server.id,
      'pending',
      undefined,
      !managedAppDefinition(server.catalogId),
    );

    let result: string;
    try {
      result = await auth(provider, {
        serverUrl: server.endpoint,
        scope: provider.clientMetadata.scope,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.setStatus(ctx.tenantId, server.id, 'error', message);
      this.logger.warn(`MCP OAuth start failed [${server.name}]: ${message}`);
      throw new ServiceUnavailableException(
        'Sign-in could not start. Please try connecting again.',
      );
    }

    const url = provider.capturedAuthorizationUrl;
    if (result !== 'REDIRECT' || !url) {
      // Valid tokens already on file — not an error; report it so the UI can
      // just refresh the connected state.
      await this.setStatus(
        ctx.tenantId,
        server.id,
        managedAppDefinition(server.catalogId) ? 'pending' : 'connected',
      );
      return { authUrl: null, alreadyConnected: true };
    }
    // Defensive: ensure our signed state rides along even if the SDK didn't add it.
    if (!url.searchParams.get('state')) url.searchParams.set('state', signedState);
    // Persist the nonce so the callback can consume it exactly once (anti-replay
    // beyond the single-use PKCE code). The provider created the credential row
    // during auth(), so it exists by now.
    try {
      const saved = await this.prisma.withTenant(ctx.tenantId, (tx) =>
        tx.clioMcpOAuthCredential.updateMany({
          where: { serverId: server.id },
          data: { stateNonce: nonce },
        }),
      );
      if (saved.count !== 1) throw new Error('Authorization no longer active');
    } catch {
      await this.setStatus(
        ctx.tenantId,
        server.id,
        'error',
        'Sign-in could not start. Please try again.',
      );
      throw new ServiceUnavailableException('Sign-in could not start. Please try again.');
    }
    return { authUrl: url.toString() };
  }

  // ── callback ───────────────────────────────────────────────────────────────

  /** Exchange the authorization code; persist tokens. Verified by signed state. */
  async handleCallback(params: {
    code: string;
    state: string;
  }): Promise<{ tenantId: string; serverId: string; name: string }> {
    this.assertConfigured();
    const decoded = this.verifyState(params.state);

    const server = await this.prisma.withTenant(decoded.t, (tx) =>
      tx.clioMcpServer.findFirst({
        where: { id: decoded.s, tenantId: decoded.t },
        select: {
          id: true,
          name: true,
          endpoint: true,
          authType: true,
          catalogId: true,
          scope: true,
          ownerUserId: true,
          enabled: true,
        },
      }),
    );
    if (!server) throw new NotFoundException('Connector not found');
    this.assertManagedServer(server, decoded.t);
    if (managedAppDefinition(server.catalogId) && server.ownerUserId !== decoded.u) {
      throw new ForbiddenException('This authorization is no longer active.');
    }
    if (server.authType !== 'oauth' || !server.endpoint) {
      throw new BadRequestException('Connector is not an OAuth connector');
    }

    // Single-use: atomically consume the nonce persisted at start(). A replayed
    // (code,state) within the TTL finds the nonce already cleared and is rejected
    // (defense-in-depth on top of the single-use PKCE authorization code).
    const consumed = await this.prisma.withTenant(decoded.t, (tx) =>
      tx.clioMcpOAuthCredential.updateMany({
        where: { serverId: server.id, stateNonce: decoded.n },
        data: { stateNonce: null },
      }),
    );
    if (consumed.count !== 1) {
      throw new BadRequestException('Authorization state already used or invalid');
    }

    const provider = this.buildProvider({
      id: server.id,
      tenantId: decoded.t,
      name: server.name,
      catalogId: server.catalogId,
    });

    try {
      const result = await auth(provider, {
        serverUrl: server.endpoint,
        authorizationCode: params.code,
        scope: provider.clientMetadata.scope,
      });
      if (result !== 'AUTHORIZED') {
        throw new BadRequestException('Authorization did not complete');
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.setStatus(decoded.t, server.id, 'error', message);
      this.logger.warn(`MCP OAuth callback failed [${server.name}]: ${message}`);
      throw new BadRequestException('Sign-in did not complete. Please try connecting again.');
    }
    // Managed app tokens are saved while pending; discovery finalizes readiness.
    await this.audit(decoded.t, decoded.u, 'clio.mcp_oauth.connect', server.id, {
      name: server.name,
    });
    return { tenantId: decoded.t, serverId: server.id, name: server.name };
  }

  async handleFailure(
    state: string,
    cancelled: boolean,
  ): Promise<{ tenantId: string; serverId: string }> {
    const decoded = this.verifyState(state);
    await this.prisma.withTenant(decoded.t, async (tx) => {
      const consumed = await tx.clioMcpOAuthCredential.updateMany({
        where: { serverId: decoded.s, stateNonce: decoded.n },
        data: {
          stateNonce: null,
          codeVerifierCiphertext: null,
          codeVerifierIv: null,
          codeVerifierAuthTag: null,
        },
      });
      if (consumed.count !== 1)
        throw new BadRequestException('Authorization state already used or invalid');
      await tx.clioMcpServer.updateMany({
        where: { id: decoded.s, tenantId: decoded.t, connectionStatus: 'pending' },
        data: {
          connectionStatus: 'error',
          lastError: cancelled
            ? 'Sign-in was cancelled. Please try again.'
            : 'Sign-in did not complete. Please try again.',
        },
      });
    });
    return { tenantId: decoded.t, serverId: decoded.s };
  }

  // ── disconnect ───────────────────────────────────────────────────────────

  /** Cancel only an unfinished authorization; a completed connection is retained. */
  async cancelPending(ctx: TenantContext, serverId: string): Promise<void> {
    const server = await this.loadOwnedServer(ctx, serverId);
    await this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const cancelled = await tx.clioMcpServer.updateMany({
        where: { id: server.id, tenantId: ctx.tenantId, connectionStatus: 'pending' },
        data: { connectionStatus: 'disconnected', lastError: null },
      });
      if (cancelled.count === 1) {
        await tx.clioMcpOAuthCredential.deleteMany({ where: { serverId: server.id } });
      }
    });
  }

  /** Revoke local tokens for a connector (owner / admin only). */
  async disconnect(ctx: TenantContext, serverId: string): Promise<void> {
    const server = await this.loadOwnedServer(ctx, serverId);
    await this.prisma.withTenant(ctx.tenantId, async (tx) => {
      await tx.clioMcpServer.update({
        where: { id: server.id },
        data: { connectionStatus: 'disconnected', lastError: null },
      });
      await tx.clioMcpOAuthCredential.deleteMany({ where: { serverId: server.id } });
    });
    await this.audit(ctx.tenantId, ctx.userId, 'clio.mcp_oauth.disconnect', server.id, {
      name: server.name,
    });
  }

  // ── helpers ────────────────────────────────────────────────────────────────

  /** Load a server the caller is allowed to manage (firm-wide ⇒ admin; personal ⇒ owner). */
  private async loadOwnedServer(ctx: TenantContext, serverId: string): Promise<OAuthServerRow> {
    const server = await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.clioMcpServer.findFirst({
        where: { id: serverId, tenantId: ctx.tenantId },
        select: {
          id: true,
          name: true,
          endpoint: true,
          authType: true,
          catalogId: true,
          scope: true,
          ownerUserId: true,
          enabled: true,
        },
      }),
    );
    if (!server) throw new NotFoundException('Connector not found');
    const isAdmin = ctx.role === 'user_admin' || ctx.role === 'capiro_admin';
    if (server.scope === 'tenant') {
      if (!isAdmin) throw new ForbiddenException('Only admins manage firm-wide connectors');
    } else if (server.ownerUserId !== ctx.userId) {
      throw new ForbiddenException('You can only manage your own connectors');
    }
    return server;
  }

  private assertManagedServer(server: OAuthServerRow, tenantId: string): void {
    const app = managedAppDefinition(server.catalogId);
    if (
      app &&
      (!this.config.get('CLIO_MCP_ENABLED', { infer: true }) ||
        !managedAppAvailable(app.id, { tenantId, userId: server.ownerUserId }) ||
        !server.enabled ||
        server.scope !== 'user' ||
        server.name !== app.catalogId ||
        server.endpoint !== app.endpoint ||
        server.authType !== 'oauth')
    ) {
      throw new ServiceUnavailableException(
        'This app is temporarily unavailable. Please try again later.',
      );
    }
  }

  private async audit(
    tenantId: string,
    actorUserId: string,
    action: string,
    entityId: string,
    after: Record<string, unknown>,
  ): Promise<void> {
    await this.prisma
      .withTenant(tenantId, (tx) =>
        tx.auditLog.create({
          data: {
            tenantId,
            actorUserId,
            action,
            entityType: 'clio_mcp_server',
            entityId,
            after: after as Prisma.InputJsonValue,
          },
        }),
      )
      .catch((err) =>
        this.logger.warn(`MCP OAuth audit failed [${action}]: ${(err as Error).message}`),
      );
  }

  private async setStatus(
    tenantId: string,
    serverId: string,
    status: string,
    error?: string,
    allowDisconnected = false,
  ): Promise<void> {
    await this.prisma
      .withTenant(tenantId, (tx) =>
        tx.clioMcpServer.updateMany({
          where: {
            id: serverId,
            tenantId,
            ...(allowDisconnected ? {} : { connectionStatus: { not: 'disconnected' } }),
          },
          data: {
            connectionStatus: status,
            ...(error !== undefined ? { lastError: error.slice(0, 500) } : {}),
          },
        }),
      )
      .catch((err) => this.logger.warn(`Failed to set MCP status: ${(err as Error).message}`));
  }

  private signState(payload: OAuthStatePayload): string {
    const secret = Buffer.from(this.rawStateSecret()!, 'utf8');
    const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
    const sig = createHmac('sha256', secret).update(body).digest('base64url');
    return `${body}.${sig}`;
  }

  private verifyState(state: string): OAuthStatePayload {
    const secret = this.rawStateSecret();
    if (!secret) throw new ServiceUnavailableException('OAUTH_STATE_SECRET is not set');
    const [body, sig, extra] = state.split('.');
    if (!body || !sig || extra !== undefined) throw new BadRequestException('Malformed state');
    const expected = createHmac('sha256', Buffer.from(secret, 'utf8'))
      .update(body)
      .digest('base64url');
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      throw new BadRequestException('Invalid state signature');
    }
    let payload: OAuthStatePayload;
    try {
      payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as OAuthStatePayload;
    } catch {
      throw new BadRequestException('Malformed state payload');
    }
    if (
      !payload ||
      ![payload.t, payload.s, payload.u, payload.n].every(
        (value) => typeof value === 'string' && value.length > 0,
      ) ||
      !Number.isFinite(payload.e)
    ) {
      throw new BadRequestException('Malformed state payload');
    }
    if (payload.e < Math.floor(Date.now() / 1000)) {
      throw new BadRequestException('State has expired; restart the connection');
    }
    return payload;
  }
}
