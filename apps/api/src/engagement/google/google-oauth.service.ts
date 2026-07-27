// ============================================================================
// ⛔ CHANGE-CONTROL: AUTHENTICATION / EMAIL INTEGRATION — APPROVAL REQUIRED
// ----------------------------------------------------------------------------
// Do NOT modify this file (or anything touching Clerk auth, the tenant-context
// middleware, JWT/session handling, Microsoft Graph / Google OAuth, the Clerk
// webhook, or integration connection/token persistence) without EXPLICIT prior
// approval from Neo. These paths gate every authenticated request and the
// email integration; a subtle change here has repeatedly caused tenant-wide
// 403/500 outages. Investigate read-only and PROPOSE first; wait for go-ahead
// before editing, merging, or deploying.
// ----------------------------------------------------------------------------
// This is the Google Workspace analog of microsoft-oauth.service.ts. It clones
// that file's proven shape (HMAC-signed `state`, connection lifecycle, encrypted
// token persistence via the shared TokenCryptoService) and swaps the provider
// specifics: Google's OAuth 2.0 authorization-code flow, implemented with raw
// fetch against Google's documented endpoints (no new SDK dependency — the
// Graph sync already uses raw fetch, so this matches house style).
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
import { EngagementConnectionStatus, EngagementProvider, Prisma } from '@prisma/client';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { GOOGLE_WORKSPACE_REQUIRED_GRANTS, GOOGLE_WORKSPACE_SCOPES } from '@capiro/shared';
import type { TenantContext } from '@capiro/shared';
import type { AppConfig } from '../../config/config.schema.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { TokenCryptoService } from '../microsoft/token-crypto.service.js';

// Sourced from @capiro/shared (not redeclared here) so this can never drift
// from the onboarding IT-admin verification's scope set or from what's
// registered on the OAuth consent screen — a prior drift here is exactly what
// triggered a Google verification rejection.
export const GOOGLE_SCOPES: string[] = [...GOOGLE_WORKSPACE_SCOPES];

/**
 * The non-identity grants a connection cannot function without. Google supports
 * granular consent: a user can UNCHECK Gmail read or send on the consent screen
 * and still be redirected back with a valid access token. Without this check the
 * callback wrote the CANONICAL scope list to the row and flipped the connection
 * to `connected`, so the UI showed a healthy integration that failed on the
 * first sync or send. The onboarding IT-admin verify already enforces exactly
 * this (apps/onboard-api it-admin.service.ts:379-388); the per-user mailbox
 * connect must enforce it independently. Exported pure so it is testable
 * without a live token exchange.
 */
export function missingGoogleGrants(grantedScope: string | undefined): string[] {
  const granted = new Set((grantedScope ?? '').split(/\s+/).filter(Boolean));
  return GOOGLE_WORKSPACE_REQUIRED_GRANTS.filter((scope) => !granted.has(scope));
}

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const STATE_TTL_SECONDS = 600;

export interface GoogleAuthStartInput {
  connectionId?: string;
  accountEmail?: string;
  displayName?: string;
}

export interface GoogleAuthStartResult {
  authUrl: string;
  connectionId: string;
}

interface StatePayload {
  c: string; // connection id
  t: string; // tenant id
  n: string; // nonce
  e: number; // expires at (unix seconds)
}

interface GoogleTokenResponse {
  access_token?: string;
  expires_in?: number;
  refresh_token?: string;
  scope?: string;
  token_type?: string;
  id_token?: string;
}

interface GoogleIdTokenClaims {
  email?: string;
  name?: string;
  sub?: string;
}

@Injectable()
export class GoogleOAuthService {
  private readonly logger = new Logger(GoogleOAuthService.name);
  private readonly clientId?: string;
  private readonly clientSecret?: string;
  private readonly redirectUri: string;
  private readonly successRedirect: string;
  private readonly stateSecret?: Buffer;

  constructor(
    private readonly prisma: PrismaService,
    private readonly tokenCrypto: TokenCryptoService,
    config: ConfigService<AppConfig, true>,
  ) {
    this.clientId = config.get('GOOGLE_CLIENT_ID', { infer: true });
    this.clientSecret = config.get('GOOGLE_CLIENT_SECRET', { infer: true });
    this.redirectUri = config.get('GOOGLE_REDIRECT_URI', { infer: true });
    this.successRedirect = config.get('GOOGLE_OAUTH_SUCCESS_REDIRECT', { infer: true });
    const stateSecret = config.get('OAUTH_STATE_SECRET', { infer: true });
    this.stateSecret = stateSecret ? Buffer.from(stateSecret, 'utf8') : undefined;
  }

  capabilities() {
    const ready = Boolean(
      this.clientId && this.clientSecret && this.stateSecret && this.tokenCrypto.isConfigured(),
    );
    return {
      configured: ready,
      redirectUri: this.redirectUri,
      scopes: GOOGLE_SCOPES,
    };
  }

  getSuccessRedirect(): string {
    return this.successRedirect;
  }

  async start(ctx: TenantContext, input: GoogleAuthStartInput): Promise<GoogleAuthStartResult> {
    this.assertConfigured();

    const connection = await this.prisma.withTenant(ctx.tenantId, async (tx) => {
      if (input.connectionId) {
        const existing = await tx.integrationConnection.findUnique({
          where: { id: input.connectionId },
        });
        if (!existing) throw new NotFoundException('Integration connection not found');
        if (existing.provider !== EngagementProvider.google_workspace) {
          throw new BadRequestException('Connection is not a Google Workspace integration');
        }
        if (existing.createdByUserId !== ctx.userId) {
          throw new ForbiddenException('You can only connect your own Google account');
        }
        return existing;
      }

      const accountEmail = input.accountEmail?.trim().toLowerCase() || undefined;
      const existing = await tx.integrationConnection.findFirst({
        where: {
          tenantId: ctx.tenantId,
          provider: EngagementProvider.google_workspace,
          createdByUserId: ctx.userId,
          ...(accountEmail ? { accountEmail } : {}),
        },
        orderBy: { updatedAt: 'desc' },
      });
      if (existing) return existing;

      return tx.integrationConnection.create({
        data: {
          tenantId: ctx.tenantId,
          provider: EngagementProvider.google_workspace,
          accountEmail: accountEmail ?? null,
          displayName: input.displayName?.trim() || null,
          status: EngagementConnectionStatus.needs_configuration,
          scopes: GOOGLE_SCOPES,
          syncState: {
            calendar: { syncToken: null, updatedAt: null },
            mail: { historyId: null, updatedAt: null },
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

    const params = new URLSearchParams({
      client_id: this.clientId!,
      redirect_uri: this.redirectUri,
      response_type: 'code',
      scope: GOOGLE_SCOPES.join(' '),
      // offline + consent is REQUIRED to reliably receive a refresh_token: Google
      // only returns one on an explicit consent grant. prompt=consent also forces
      // the account chooser so the user picks THEIR OWN mailbox rather than
      // silently reusing a browser session signed into another Google account
      // (the Microsoft path fixed the same class of bug with select_account).
      access_type: 'offline',
      prompt: 'consent',
      include_granted_scopes: 'true',
      state,
    });

    return { authUrl: `${GOOGLE_AUTH_URL}?${params.toString()}`, connectionId: connection.id };
  }

  async handleCallback(params: { code: string; state: string }): Promise<{
    tenantId: string;
    connectionId: string;
  }> {
    this.assertConfigured();

    const decoded = this.verifyState(params.state);
    const token = await this.exchangeCode(params.code);
    if (!token.access_token) {
      throw new BadRequestException('Google did not return an access token');
    }

    // Validate the ACTUAL grant before persisting anything. `include_granted_scopes`
    // means token.scope can be a superset (previously-granted scopes from other
    // flows), so this is a subset test, not equality.
    const missing = missingGoogleGrants(token.scope);
    if (missing.length > 0) {
      this.logger.warn(
        `Google callback for connection ${decoded.c} granted only [${token.scope ?? ''}]; missing [${missing.join(', ')}]`,
      );
      // Best-effort revoke the token we were just handed — we are refusing it,
      // so leaving a live grant dangling at Google would be wrong.
      await this.revokeGoogleGrant(token.access_token);
      await this.markConnectionInsufficientScope(decoded.t, decoded.c, missing);
      throw new BadRequestException(
        `Google Workspace connection needs all requested permissions. Missing: ${missing.join(', ')}`,
      );
    }
    const expiresAt = new Date(Date.now() + (token.expires_in ?? 3600) * 1000);
    const claims = this.decodeIdToken(token.id_token);

    await this.persistToken(decoded.t, decoded.c, token, expiresAt, claims);

    return { tenantId: decoded.t, connectionId: decoded.c };
  }

  /**
   * Disconnect a Google Workspace connection: best-effort revoke the OAuth grant
   * at Google, then delete the connection record. The stored token row is removed
   * by the FK cascade; ingested meetings/mail keep their data (their connectionId
   * is SetNull, not cascaded), so disconnecting halts future syncing without
   * destroying history. Ownership is enforced — a user may only disconnect a
   * connection they created, matching the per-user scoping of start() and
   * listIntegrations(). Works for any status (connected / error /
   * needs_configuration), so a stale or errored connection can also be cleared.
   */
  async disconnect(
    ctx: TenantContext,
    connectionId: string,
  ): Promise<{ disconnected: true; connectionId: string }> {
    const { id, revokeToken } = await this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const existing = await tx.integrationConnection.findUnique({
        where: { id: connectionId },
        include: { token: true },
      });
      if (!existing) throw new NotFoundException('Integration connection not found');
      if (existing.provider !== EngagementProvider.google_workspace) {
        throw new BadRequestException('Connection is not a Google Workspace integration');
      }
      if (existing.createdByUserId !== ctx.userId) {
        throw new ForbiddenException('You can only disconnect your own Google account');
      }

      // Decrypt while we hold the row under tenant scope; the network revoke call
      // itself runs outside the transaction. Prefer the refresh token — revoking
      // it invalidates every derived access token — and fall back to the access
      // token if no refresh token was ever stored.
      const token = existing.token;
      let revoke: string | undefined;
      if (token?.refreshTokenCiphertext && token.refreshTokenIv && token.refreshTokenAuthTag) {
        revoke = this.tokenCrypto.decrypt({
          ciphertext: token.refreshTokenCiphertext,
          iv: token.refreshTokenIv,
          authTag: token.refreshTokenAuthTag,
        });
      } else if (token) {
        revoke = this.tokenCrypto.decrypt({
          ciphertext: token.accessTokenCiphertext,
          iv: token.accessTokenIv,
          authTag: token.accessTokenAuthTag,
        });
      }
      return { id: existing.id, revokeToken: revoke };
    });

    // Best-effort: if the grant was already revoked (invalid_grant) or Google is
    // unreachable, we still delete the local record — the user's intent is to
    // remove the connection, and a failed revoke must not strand it.
    await this.revokeGoogleGrant(revokeToken);

    await this.prisma.withTenant(ctx.tenantId, async (tx) => {
      // FK cascade removes the IntegrationConnectionToken row; meetings/mail rows
      // reference the connection with onDelete: SetNull, so ingested history stays.
      await tx.integrationConnection.delete({ where: { id } });
    });

    return { disconnected: true, connectionId: id };
  }

  private async revokeGoogleGrant(token: string | undefined): Promise<void> {
    if (!token) return;
    try {
      const response = await fetch(GOOGLE_REVOKE_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token }).toString(),
      });
      if (!response.ok) {
        const text = await response.text().catch(() => '');
        this.logger.warn(
          `Google token revocation returned ${response.status}: ${text.slice(0, 200)}`,
        );
      }
    } catch (err) {
      this.logger.warn(`Google token revocation failed: ${(err as Error).message}`);
    }
  }

  /** Record WHY the connect failed so the integrations page can explain it. */
  private async markConnectionInsufficientScope(
    tenantId: string,
    connectionId: string,
    missing: string[],
  ): Promise<void> {
    await this.prisma.withTenant(tenantId, async (tx) => {
      await tx.integrationConnection
        .update({
          where: { id: connectionId },
          data: {
            status: EngagementConnectionStatus.needs_configuration,
            lastError:
              `Google Workspace was connected without all required permissions. ` +
              `Missing: ${missing.join(', ')}. Reconnect and leave every checkbox ticked.`.slice(
                0,
                1000,
              ),
          },
        })
        .catch(() => undefined);
    });
  }

  private async exchangeCode(code: string): Promise<GoogleTokenResponse> {
    const body = new URLSearchParams({
      code,
      client_id: this.clientId!,
      client_secret: this.clientSecret!,
      redirect_uri: this.redirectUri,
      grant_type: 'authorization_code',
    });
    const response = await fetch(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new BadRequestException(
        `Google token exchange failed (${response.status}): ${text.slice(0, 500)}`,
      );
    }
    return (await response.json()) as GoogleTokenResponse;
  }

  // The id_token is a JWT minted by Google and returned directly to our backend
  // over TLS from the token endpoint (never routed through the browser), so we
  // trust its payload for identity extraction without re-verifying the signature
  // here. We only read email/name — the same trust model as reading
  // result.account off the MSAL token response in the Microsoft path.
  private decodeIdToken(idToken?: string): GoogleIdTokenClaims {
    if (!idToken) return {};
    const payloadSegment = idToken.split('.')[1];
    if (!payloadSegment) return {};
    try {
      const payload = JSON.parse(
        Buffer.from(payloadSegment, 'base64url').toString('utf8'),
      ) as GoogleIdTokenClaims;
      return payload;
    } catch (err) {
      this.logger.warn(`Failed to decode Google id_token payload: ${(err as Error).message}`);
      return {};
    }
  }

  private async persistToken(
    tenantId: string,
    connectionId: string,
    token: GoogleTokenResponse,
    expiresAt: Date,
    claims: GoogleIdTokenClaims,
  ): Promise<void> {
    const accessEnvelope = this.tokenCrypto.encrypt(token.access_token!);
    // Google returns refresh_token only on an explicit consent grant. We force
    // prompt=consent so it should always be present, but if a future flow omits
    // it we keep the previously stored refresh token instead of nulling it.
    const refreshEnvelope = token.refresh_token
      ? this.tokenCrypto.encrypt(token.refresh_token)
      : null;
    const accountEmail = claims.email?.toLowerCase() ?? null;
    const displayName = claims.name ?? null;

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
          scopes: GOOGLE_SCOPES,
          homeAccountId: claims.sub ?? null,
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
          scopes: GOOGLE_SCOPES,
          homeAccountId: claims.sub ?? null,
          expiresAt,
        },
      });

      await tx.integrationConnection.update({
        where: { id: connectionId },
        data: {
          status: EngagementConnectionStatus.connected,
          accountEmail: accountEmail ?? undefined,
          displayName: displayName ?? undefined,
          scopes: GOOGLE_SCOPES,
          lastError: null,
        },
      });
    });
  }

  private assertConfigured(): void {
    if (
      !this.clientId ||
      !this.clientSecret ||
      !this.stateSecret ||
      !this.tokenCrypto.isConfigured()
    ) {
      throw new ServiceUnavailableException(
        'Google OAuth is not fully configured. Required: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, OAUTH_STATE_SECRET, OAUTH_TOKEN_ENCRYPTION_KEY.',
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
