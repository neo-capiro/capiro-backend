// ============================================================================
// ⛔ CHANGE-CONTROL: AUTHENTICATION / EMAIL INTEGRATION — APPROVAL REQUIRED
// ----------------------------------------------------------------------------
// Do NOT modify this file (or anything touching Clerk auth, the tenant-context
// middleware, JWT/session handling, Microsoft Graph OAuth, the Clerk webhook,
// or integration connection/token persistence) without EXPLICIT prior approval
// from Neo. These paths gate every authenticated request and the email/Outlook
// integration; a subtle change here has repeatedly caused tenant-wide 403/500
// outages (see git history 2026-06-07 + skill: capiro-tenant-onboarding-flow).
// Investigate read-only and PROPOSE first; wait for go-ahead before editing,
// merging, or deploying.
// ============================================================================
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ConfidentialClientApplication,
  type AuthenticationResult,
  type Configuration,
} from '@azure/msal-node';
import { EngagementConnectionStatus, EngagementProvider, Prisma } from '@prisma/client';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { TenantContext } from '@capiro/shared';
import type { AppConfig } from '../../config/config.schema.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { TokenCryptoService } from './token-crypto.service.js';
import { MicrosoftGraphSyncService } from './microsoft-graph-sync.service.js';
import { MICROSOFT_SCOPES, normalizePem } from './microsoft-oauth-constants.js';

// Re-exported for existing importers (e.g. microsoft-graph-sync.scopes.spec.ts)
// that read MICROSOFT_SCOPES from this file. The canonical definition now
// lives in microsoft-oauth-constants.ts — see that file's header for why.
export { MICROSOFT_SCOPES };
const STATE_TTL_SECONDS = 600;

export interface MicrosoftAuthStartInput {
  connectionId?: string;
  accountEmail?: string;
  displayName?: string;
}

export interface MicrosoftAuthStartResult {
  authUrl: string;
  connectionId: string;
}

interface StatePayload {
  c: string; // connection id
  t: string; // tenant id
  n: string; // nonce
  e: number; // expires at (unix seconds)
}

/**
 * Select the refresh token bound to `homeAccountId` from a serialized MSAL token
 * cache. Matching on home_account_id is authoritative — it guarantees we never
 * return another account's token even if the cache holds more than one entry
 * (which can happen when a client instance is reused across OAuth exchanges). The
 * fallback to the sole/last entry only applies when there is no account id to
 * match against. Pure and exported so this account-binding is unit-testable
 * without a live MSAL cache.
 */
export function selectRefreshTokenForAccount(
  serializedCache: string,
  homeAccountId: string | null,
): string | undefined {
  const cache = JSON.parse(serializedCache) as {
    RefreshToken?: Record<string, { secret?: string; home_account_id?: string }>;
  };
  const entries = Object.values(cache.RefreshToken ?? {});
  const matched = homeAccountId
    ? entries.find((entry) => entry.home_account_id === homeAccountId)
    : undefined;
  return (matched ?? entries[entries.length - 1])?.secret;
}

@Injectable()
export class MicrosoftOAuthService {
  private readonly logger = new Logger(MicrosoftOAuthService.name);
  private readonly clientId?: string;
  private readonly tenantId?: string;
  private readonly authority: string;
  private readonly thumbprint?: string;
  private readonly privateKey?: string;
  private readonly redirectUri: string;
  private readonly successRedirect: string;
  private readonly stateSecret?: Buffer;
  private msal?: ConfidentialClientApplication;

  constructor(
    private readonly prisma: PrismaService,
    private readonly tokenCrypto: TokenCryptoService,
    private readonly graphSync: MicrosoftGraphSyncService,
    config: ConfigService<AppConfig, true>,
  ) {
    this.clientId = config.get('MICROSOFT_CLIENT_ID', { infer: true });
    this.tenantId = config.get('MICROSOFT_TENANT_ID', { infer: true });
    this.authority = config.get('MICROSOFT_AUTHORITY', { infer: true });
    this.thumbprint = config.get('MICROSOFT_CERT_THUMBPRINT', { infer: true });
    const rawKey = config.get('MICROSOFT_CERT_PRIVATE_KEY', { infer: true });
    this.privateKey = rawKey ? normalizePem(rawKey) : undefined;
    this.redirectUri = config.get('MICROSOFT_REDIRECT_URI', { infer: true });
    this.successRedirect = config.get('MICROSOFT_OAUTH_SUCCESS_REDIRECT', { infer: true });
    const stateSecret = config.get('OAUTH_STATE_SECRET', { infer: true });
    this.stateSecret = stateSecret ? Buffer.from(stateSecret, 'utf8') : undefined;
  }

  capabilities() {
    const ready = Boolean(
      this.clientId &&
      this.tenantId &&
      this.thumbprint &&
      this.privateKey &&
      this.stateSecret &&
      this.tokenCrypto.isConfigured(),
    );
    return {
      configured: ready,
      redirectUri: this.redirectUri,
      scopes: MICROSOFT_SCOPES,
    };
  }

  getSuccessRedirect(): string {
    return this.successRedirect;
  }

  async start(
    ctx: TenantContext,
    input: MicrosoftAuthStartInput,
  ): Promise<MicrosoftAuthStartResult> {
    this.assertConfigured();

    const connection = await this.prisma.withTenant(ctx.tenantId, async (tx) => {
      if (input.connectionId) {
        const existing = await tx.integrationConnection.findUnique({
          where: { id: input.connectionId },
        });
        if (!existing) throw new NotFoundException('Integration connection not found');
        if (existing.provider !== EngagementProvider.microsoft_365) {
          throw new BadRequestException('Connection is not a Microsoft 365 integration');
        }
        if (existing.createdByUserId !== ctx.userId) {
          throw new ForbiddenException('You can only connect your own Microsoft account');
        }
        return existing;
      }

      const accountEmail = input.accountEmail?.trim().toLowerCase() || undefined;
      const existing = await tx.integrationConnection.findFirst({
        where: {
          tenantId: ctx.tenantId,
          provider: EngagementProvider.microsoft_365,
          createdByUserId: ctx.userId,
          ...(accountEmail ? { accountEmail } : {}),
        },
        orderBy: { updatedAt: 'desc' },
      });
      if (existing) return existing;

      return tx.integrationConnection.create({
        data: {
          tenantId: ctx.tenantId,
          provider: EngagementProvider.microsoft_365,
          accountEmail: accountEmail ?? null,
          displayName: input.displayName?.trim() || null,
          status: EngagementConnectionStatus.needs_configuration,
          scopes: MICROSOFT_SCOPES,
          syncState: {
            calendar: { cursor: null, updatedAt: null },
            mail: { cursor: null, updatedAt: null },
            webhooks: { configured: false },
          },
          createdByUserId: ctx.userId,
        },
      });
    });

    const state = this.signState({
      c: connection.id,
      t: ctx.tenantId,
      n: randomBytes(16).toString('base64url'),
      e: Math.floor(Date.now() / 1000) + STATE_TTL_SECONDS,
    });

    const authUrl = await this.getMsal().getAuthCodeUrl({
      scopes: MICROSOFT_SCOPES,
      redirectUri: this.redirectUri,
      state,
      // select_account (not 'consent') forces Microsoft's account picker every
      // time so the user explicitly chooses THEIR OWN mailbox. With 'consent'
      // and a browser already signed into another MS account (e.g. an org
      // admin), the flow silently reused that account and bound the wrong
      // mailbox. Org-wide app consent is a separate one-time admin action
      // (Entra admin center / adminconsent endpoint), not driven from here.
      prompt: 'select_account',
    });

    return { authUrl, connectionId: connection.id };
  }

  async handleCallback(params: { code: string; state: string }): Promise<{
    tenantId: string;
    connectionId: string;
  }> {
    this.assertConfigured();

    const decoded = this.verifyState(params.state);
    // Fresh per-callback client: its token cache holds ONLY the account exchanged
    // in this request. A shared client would let two tenants' concurrent callbacks
    // populate one cache, and selecting the "last" cache entry could then bind the
    // WRONG tenant's mailbox. No PKCE/code-verifier continuity with the /start
    // client is required — we authenticate with the client certificate and carry
    // our own signed `state`.
    const msal = this.buildMsalClient();
    const result = await msal.acquireTokenByCode({
      code: params.code,
      scopes: MICROSOFT_SCOPES,
      redirectUri: this.redirectUri,
    });

    if (!result?.accessToken) {
      throw new BadRequestException('Microsoft did not return an access token');
    }

    const refreshToken = this.extractRefreshToken(msal, result.account?.homeAccountId ?? null);
    const expiresAt = result.expiresOn ?? new Date(Date.now() + 60 * 60 * 1000);

    await this.persistToken(decoded.t, decoded.c, result, refreshToken, expiresAt);

    return { tenantId: decoded.t, connectionId: decoded.c };
  }

  /**
   * Disconnect a Microsoft 365 connection: tear down its Graph subscriptions,
   * then delete the connection record (the encrypted token row goes with it via
   * FK cascade; ingested meetings/mail keep their data because their
   * connectionId is SetNull, not cascaded). Ownership is enforced — a user may
   * only disconnect a connection they created, matching start() and
   * listIntegrations(). Works at ANY status so a stale/errored connection can be
   * cleared too.
   *
   * NOTE — deliberately NOT symmetric with the Google path: Microsoft exposes no
   * per-app delegated-grant revoke reachable with our scopes
   * (/me/oauth2PermissionGrants needs DelegatedPermissionGrant.ReadWrite.All;
   * /me/revokeSignInSessions is app-wide). This removes Capiro's stored tokens
   * and stops all syncing; revoking the app grant itself is a user action at
   * https://myapplications.microsoft.com.
   */
  async disconnect(
    ctx: TenantContext,
    connectionId: string,
  ): Promise<{ disconnected: true; connectionId: string; subscriptionsDeleted: number }> {
    const existing = await this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const found = await tx.integrationConnection.findUnique({ where: { id: connectionId } });
      if (!found) throw new NotFoundException('Integration connection not found');
      if (found.provider !== EngagementProvider.microsoft_365) {
        throw new BadRequestException('Connection is not a Microsoft 365 integration');
      }
      if (found.createdByUserId !== ctx.userId) {
        throw new ForbiddenException('You can only disconnect your own Microsoft account');
      }
      return found;
    });

    // Outside the transaction: this makes network calls to Graph.
    // deleteSubscriptionsByTenant already swallows its own errors and always
    // resolves; this catch is defense in depth so the disconnect intent is
    // NEVER stranded on a remote failure even if that guarantee ever slips.
    let subscriptionsDeleted = 0;
    try {
      subscriptionsDeleted = await this.graphSync.deleteSubscriptionsByTenant(
        ctx.tenantId,
        existing.id,
      );
    } catch (err) {
      this.logger.warn(
        `Graph subscription teardown failed for connection ${existing.id}, deleting anyway: ${(err as Error).message}`,
      );
    }

    await this.prisma.withTenant(ctx.tenantId, async (tx) => {
      await tx.integrationConnection.delete({ where: { id: existing.id } });
    });

    return { disconnected: true, connectionId: existing.id, subscriptionsDeleted };
  }

  private async persistToken(
    tenantId: string,
    connectionId: string,
    result: AuthenticationResult,
    refreshToken: string | undefined,
    expiresAt: Date,
  ): Promise<void> {
    const accessEnvelope = this.tokenCrypto.encrypt(result.accessToken);
    const refreshEnvelope = refreshToken ? this.tokenCrypto.encrypt(refreshToken) : null;
    const homeAccountId = result.account?.homeAccountId ?? null;
    const accountEmail = result.account?.username?.toLowerCase() ?? null;
    const displayName = result.account?.name ?? null;

    await this.prisma.withTenant(tenantId, async (tx) => {
      await tx.integrationConnectionToken.upsert({
        where: { connectionId },
        update: {
          accessTokenCiphertext: accessEnvelope.ciphertext,
          accessTokenIv: accessEnvelope.iv,
          accessTokenAuthTag: accessEnvelope.authTag,
          ...(refreshEnvelope
            ? {
                refreshTokenCiphertext: refreshEnvelope.ciphertext,
                refreshTokenIv: refreshEnvelope.iv,
                refreshTokenAuthTag: refreshEnvelope.authTag,
              }
            : {}),
          keyVersion: this.tokenCrypto.getKeyVersion(),
          scopes: MICROSOFT_SCOPES,
          homeAccountId,
          expiresAt,
        },
        create: {
          tenantId,
          connectionId,
          accessTokenCiphertext: accessEnvelope.ciphertext,
          accessTokenIv: accessEnvelope.iv,
          accessTokenAuthTag: accessEnvelope.authTag,
          refreshTokenCiphertext: refreshEnvelope?.ciphertext ?? null,
          refreshTokenIv: refreshEnvelope?.iv ?? null,
          refreshTokenAuthTag: refreshEnvelope?.authTag ?? null,
          keyVersion: this.tokenCrypto.getKeyVersion(),
          scopes: MICROSOFT_SCOPES,
          homeAccountId,
          expiresAt,
        },
      });

      await tx.integrationConnection.update({
        where: { id: connectionId },
        data: {
          status: EngagementConnectionStatus.connected,
          accountEmail: accountEmail ?? undefined,
          displayName: displayName ?? undefined,
          scopes: MICROSOFT_SCOPES,
          lastError: null,
          syncState: {
            calendar: { cursor: null, updatedAt: null },
            mail: { cursor: null, updatedAt: null },
            webhooks: { configured: false },
          } as Prisma.InputJsonValue,
        },
      });
    });
  }

  /**
   * Pull the refresh token issued for THIS account out of the per-callback MSAL
   * cache. Selection is bound to home_account_id so we can never return another
   * account's token even if the cache holds more than one entry; see
   * selectRefreshTokenForAccount for the fallback rules.
   */
  private extractRefreshToken(
    msal: ConfidentialClientApplication,
    homeAccountId: string | null,
  ): string | undefined {
    try {
      return selectRefreshTokenForAccount(msal.getTokenCache().serialize(), homeAccountId);
    } catch (err) {
      this.logger.warn(
        `Failed to extract refresh token from MSAL cache: ${(err as Error).message}`,
      );
      return undefined;
    }
  }

  /** Build a NEW confidential-client instance with its own isolated token cache. */
  private buildMsalClient(): ConfidentialClientApplication {
    const config: Configuration = {
      auth: {
        clientId: this.clientId!,
        // Multi-tenant authority (default /organizations) so customers on any
        // Azure AD org can connect, not just the capiro.ai tenant.
        authority: this.authority,
        clientCertificate: {
          thumbprint: this.thumbprint!,
          privateKey: this.privateKey!,
        },
      },
    };
    return new ConfidentialClientApplication(config);
  }

  /**
   * Shared client used ONLY to build auth-code URLs (the /start step). It never
   * performs a token exchange, so its cache stays empty and is safe to reuse
   * across tenants. The callback token exchange uses a fresh per-request client
   * (see handleCallback), so one tenant's refresh token can never land in — or be
   * read from — another tenant's cache.
   */
  private getMsal(): ConfidentialClientApplication {
    if (this.msal) return this.msal;
    this.msal = this.buildMsalClient();
    return this.msal;
  }

  private assertConfigured(): void {
    if (
      !this.clientId ||
      !this.tenantId ||
      !this.thumbprint ||
      !this.privateKey ||
      !this.stateSecret ||
      !this.tokenCrypto.isConfigured()
    ) {
      throw new ServiceUnavailableException(
        'Microsoft OAuth is not fully configured. Required: MICROSOFT_CLIENT_ID, MICROSOFT_TENANT_ID, MICROSOFT_CERT_THUMBPRINT, MICROSOFT_CERT_PRIVATE_KEY, OAUTH_STATE_SECRET, OAUTH_TOKEN_ENCRYPTION_KEY.',
      );
    }
  }

  private signState(payload: StatePayload): string {
    const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
    const sig = createHmac('sha256', this.stateSecret!).update(body).digest('base64url');
    return `${body}.${sig}`;
  }

  private verifyState(state: string): StatePayload {
    if (!this.stateSecret) throw new ServiceUnavailableException('OAUTH_STATE_SECRET is not set');
    const [body, sig] = state.split('.');
    if (!body || !sig) throw new BadRequestException('Malformed state');
    const expected = createHmac('sha256', this.stateSecret).update(body).digest('base64url');
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      throw new BadRequestException('Invalid state signature');
    }
    let payload: StatePayload;
    try {
      payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as StatePayload;
    } catch {
      throw new BadRequestException('Malformed state payload');
    }
    if (payload.e < Math.floor(Date.now() / 1000)) {
      throw new BadRequestException('State has expired; restart the flow');
    }
    return payload;
  }
}

