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
import { verifiedScopeState } from '../integration-health.js';
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { mailboxProviderRequest } from '../mailbox-provider-transport.js';
import { mailboxState } from '../mailbox-sync-claim.js';
import { ConfigService } from '@nestjs/config';
import {
  admitMailboxOAuthAttempt,
  assertActiveMailboxActor,
  assertMailboxOAuthState,
  assertUnboundMailboxIsFresh,
  findFreshMailboxForAdd,
  assertReturnedMailboxIdentity,
  completedMailboxOAuthState,
  lockMailboxConnection,
  saveMailboxOAuthAttempt,
  tokenFingerprint,
  type MailboxOAuthState,
} from '../mailbox-oauth-authority.js';

import { EngagementConnectionStatus, EngagementProvider, Prisma } from '@prisma/client';
import { oauthCallbackFailureReason, oauthFailureMessage } from '../oauth-callback-failure.js';
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
// `userinfo_endpoint` in Google's OpenID Connect Discovery document
// (https://accounts.google.com/.well-known/openid-configuration), hard-coded
// here like the three endpoints above.
export const GOOGLE_USERINFO_URL = 'https://openidconnect.googleapis.com/v1/userinfo';
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

type StatePayload = MailboxOAuthState;

interface GoogleTokenResponse {
  access_token?: string;
  expires_in?: number;
  refresh_token?: string;
  scope?: string;
  token_type?: string;
}

/**
 * Google's OpenID Connect UserInfo claims (the `claims_supported` list in the
 * Discovery document). `sub` is the stable Google account identifier and
 * `email_verified` is the provider's own statement about the address.
 */
interface GoogleUserInfo {
  sub?: string;
  email?: string;
  email_verified?: boolean;
  name?: string;
}

interface GoogleVerifiedIdentity {
  sub: string;
  email: string;
  name: string | null;
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

    const { connection, payload } = await this.prisma.withTenant(ctx.tenantId, async (tx) => {
      await assertActiveMailboxActor(tx, ctx.tenantId, ctx.userId);
      // Only an explicit connectionId can reconnect an established mailbox.
      const connection = input.connectionId
        ? await lockMailboxConnection(tx, ctx.tenantId, input.connectionId)
        : ((await findFreshMailboxForAdd(
            tx,
            ctx.tenantId,
            ctx.userId,
            EngagementProvider.google_workspace,
          )) ??
          (await tx.integrationConnection.create({
            data: {
              tenantId: ctx.tenantId,
              provider: EngagementProvider.google_workspace,
              accountEmail: null,
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
            include: { token: true },
          })));
      if (
        connection.provider !== EngagementProvider.google_workspace ||
        connection.createdByUserId !== ctx.userId
      ) {
        throw new ForbiddenException('Integration connection is not available');
      }
      if (connection.token && !connection.token.homeAccountId) {
        throw new BadRequestException(
          'Mailbox identity is unavailable; disconnect and add the mailbox again',
        );
      }
      if (input.connectionId && !connection.token)
        await assertUnboundMailboxIsFresh(tx, connection);
      const payload: StatePayload = {
        c: connection.id,
        t: ctx.tenantId,
        u: ctx.userId,
        p: EngagementProvider.google_workspace,
        i: connection.token ? 'reconnect' : 'add',
        h: connection.token?.homeAccountId ?? null,
        q: tokenFingerprint(connection.token),
        a: connection.token
          ? null
          : (input.accountEmail ?? connection.accountEmail)?.trim().toLowerCase() || null,
        n: randomBytes(16).toString('base64url'),
        e: Math.floor(Date.now() / 1000) + STATE_TTL_SECONDS,
      };
      await saveMailboxOAuthAttempt(tx, payload);
      return { connection, payload };
    });
    const state = this.signState(payload);

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
    await this.prisma.withTenant(decoded.t, (tx) =>
      admitMailboxOAuthAttempt(tx, decoded, EngagementProvider.google_workspace, 'pending'),
    );
    try {
      return await this.finishCallback(decoded, params.code);
    } catch (error) {
      await this.recordCallbackFailure(decoded, error);
      throw error;
    }
  }

  /** Everything after the state fence; a refusal is explained on the row by the caller. */
  private async finishCallback(
    decoded: StatePayload,
    code: string,
  ): Promise<{ tenantId: string; connectionId: string }> {
    const token = await this.exchangeCode(code);
    if (!token.access_token) {
      throw new BadRequestException('Google did not return an access token');
    }

    // Identity is the provider's verified statement about this access token,
    // resolved before anything is persisted. The response's `id_token` payload is
    // unsigned text and is never used for binding.
    const identity = await this.lookupVerifiedGoogleIdentity(token.access_token);
    await this.prisma.withTenant(decoded.t, async (tx) => {
      await admitMailboxOAuthAttempt(
        tx,
        decoded,
        EngagementProvider.google_workspace,
        'exchanging',
      );
      await assertReturnedMailboxIdentity(tx, decoded, identity.sub, identity.email);
    });

    // Validate the ACTUAL grant before persisting anything. `include_granted_scopes`
    // means token.scope can be a superset (previously-granted scopes from other
    // flows), so this is a subset test, not equality.
    const missing = missingGoogleGrants(token.scope);
    if (missing.length > 0) {
      this.logger.warn(
        `Google callback for connection ${decoded.c} granted only [${token.scope ?? ''}]; missing [${missing.join(', ')}]`,
      );
      // Refuse this token without revoking a provider grant: the returned
      // account has not passed identity admission and may belong to a different
      // existing mailbox. Dropping the token has no cross-mailbox side effect.
      await this.markConnectionInsufficientScope(decoded, missing);
      throw new BadRequestException(
        `Google Workspace connection needs all requested permissions. Missing: ${missing.join(', ')}`,
      );
    }
    const expiresAt = new Date(Date.now() + (token.expires_in ?? 3600) * 1000);
    await this.persistToken(decoded, token, expiresAt, identity);

    return { tenantId: decoded.t, connectionId: decoded.c };
  }

  /**
   * Explain a refused callback on the row itself. Best-effort and never masks the
   * original error; it only fills a blank, so the missing-permission sentence the
   * flow already wrote is never replaced.
   */
  private async recordCallbackFailure(decoded: StatePayload, error: unknown): Promise<void> {
    const reason = oauthCallbackFailureReason(error);
    if (reason === 'state_invalid_or_expired') return;
    await this.prisma
      .withTenant(decoded.t, (tx) =>
        tx.integrationConnection.updateMany({
          where: {
            id: decoded.c,
            status: EngagementConnectionStatus.needs_configuration,
            lastError: null,
          },
          data: { lastError: oauthFailureMessage('Google Workspace', reason) },
        }),
      )
      .catch(() => undefined);
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
  ): Promise<{
    disconnected: true;
    connectionId: string;
    providerRevocation: 'confirmed' | 'unconfirmed' | 'not_attempted';
  }> {
    const { id, revokeToken, hadToken } = await this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const found = await tx.integrationConnection.findUnique({ where: { id: connectionId } });
      if (!found) return { id: connectionId, revokeToken: undefined, hadToken: false };
      const existing = await lockMailboxConnection(tx, ctx.tenantId, connectionId);
      if (existing.provider !== EngagementProvider.google_workspace) {
        throw new BadRequestException('Connection is not a Google Workspace integration');
      }
      if (existing.createdByUserId !== ctx.userId) {
        throw new ForbiddenException('You can only disconnect your own Google account');
      }
      const {
        syncClaim: _claim,
        oauthAttempt: _attempt,
        ...state
      } = mailboxState(existing.syncState);
      await tx.integrationConnection.update({
        where: { id: connectionId },
        data: {
          status: EngagementConnectionStatus.disabled,
          nextSyncAt: null,
          syncState: state as Prisma.InputJsonValue,
        },
      });

      // Decrypt while we hold the row under tenant scope; the network revoke call
      // itself runs outside the transaction. Prefer the refresh token — revoking
      // it invalidates every derived access token — and fall back to the access
      // token if no refresh token was ever stored.
      const token = existing.token;
      let revoke: string | undefined;
      try {
        if (token?.refreshTokenCiphertext && token.refreshTokenIv && token.refreshTokenAuthTag) {
          revoke = this.tokenCrypto.decrypt(
            {
              ciphertext: token.refreshTokenCiphertext,
              iv: token.refreshTokenIv,
              authTag: token.refreshTokenAuthTag,
            },
            token.keyVersion,
          );
        } else if (token) {
          revoke = this.tokenCrypto.decrypt(
            {
              ciphertext: token.accessTokenCiphertext,
              iv: token.accessTokenIv,
              authTag: token.accessTokenAuthTag,
            },
            token.keyVersion,
          );
        }
      } catch {
        this.logger.warn(
          'Google grant revocation could not be attempted; local disconnect continues.',
        );
      }
      return { id: existing.id, revokeToken: revoke, hadToken: Boolean(token) };
    });

    // Best-effort: if the grant was already revoked (invalid_grant) or Google is
    // unreachable, we still delete the local record — the user's intent is to
    // remove the connection, and a failed revoke must not strand it.
    const providerRevocation =
      !revokeToken && hadToken ? 'unconfirmed' : await this.revokeGoogleGrant(revokeToken);

    await this.prisma.withTenant(ctx.tenantId, async (tx) => {
      // FK cascade removes the IntegrationConnectionToken row; meetings/mail rows
      // reference the connection with onDelete: SetNull, so ingested history stays.
      await tx.integrationConnection.deleteMany({ where: { id } });
    });

    return { disconnected: true, connectionId: id, providerRevocation };
  }

  private async revokeGoogleGrant(
    token: string | undefined,
  ): Promise<'confirmed' | 'unconfirmed' | 'not_attempted'> {
    if (!token) return 'not_attempted';
    try {
      return await mailboxProviderRequest(async (signal) => {
        const response = await fetch(GOOGLE_REVOKE_URL, {
          signal,
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ token }).toString(),
        });
        if (!response.ok) {
          this.logger.warn(
            'Google grant revocation was not confirmed; local disconnect continues.',
          );
          return 'unconfirmed' as const;
        }
        return 'confirmed' as const;
      });
    } catch {
      this.logger.warn('Google grant revocation was not confirmed; local disconnect continues.');
      return 'unconfirmed';
    }
  }

  /** Record WHY the connect failed so the integrations page can explain it. */
  private async markConnectionInsufficientScope(
    state: StatePayload,
    missing: string[],
  ): Promise<void> {
    const { t: tenantId, c: connectionId } = state;
    await this.prisma.withTenant(tenantId, async (tx) => {
      await admitMailboxOAuthAttempt(tx, state, EngagementProvider.google_workspace, 'exchanging');
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
    return mailboxProviderRequest(async (signal) => {
      const body = new URLSearchParams({
        code,
        client_id: this.clientId!,
        client_secret: this.clientSecret!,
        redirect_uri: this.redirectUri,
        grant_type: 'authorization_code',
      });
      const response = await fetch(GOOGLE_TOKEN_URL, {
        signal,
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
    });
  }

  /**
   * Resolve the mailbox identity from Google's OpenID Connect UserInfo endpoint
   * with the access token this backend just received from the token endpoint.
   * Google's OIDC guide documents exactly this call ("Obtaining user profile
   * information"): the access token goes in the Authorization header and the
   * response carries the standard claims, including the stable `sub` and the
   * account `email`. An `id_token` payload is unsigned text until its signature,
   * issuer and audience are verified, so it is never used for binding here.
   *
   * A withheld or malformed claim, or an address Google itself has not verified,
   * refuses before any token is stored — an unidentified mailbox must never be
   * marked connected. Provider failure text is not echoed; only the status.
   */
  private async lookupVerifiedGoogleIdentity(accessToken: string): Promise<GoogleVerifiedIdentity> {
    const profile = await mailboxProviderRequest(async (signal) => {
      const response = await fetch(GOOGLE_USERINFO_URL, {
        signal,
        method: 'GET',
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!response.ok) {
        throw new ServiceUnavailableException(
          `Google account identity lookup failed (${response.status})`,
        );
      }
      // A 200 whose body is not JSON is a provider contract violation rather than an
      // identity, so it is refused as a provider failure and the body is not echoed.
      try {
        return JSON.parse(await response.text()) as GoogleUserInfo | null;
      } catch {
        throw new ServiceUnavailableException(
          'Google account identity lookup returned an unreadable response',
        );
      }
    });
    const sub = profile?.sub?.trim();
    const email = profile?.email?.trim().toLowerCase();
    if (!sub || !email || profile?.email_verified !== true) {
      throw new BadRequestException(
        'Google did not return a verified account identity; add the mailbox again',
      );
    }
    return { sub, email, name: profile?.name?.trim() || null };
  }

  private async persistToken(
    state: StatePayload,
    token: GoogleTokenResponse,
    expiresAt: Date,
    identity: GoogleVerifiedIdentity,
  ): Promise<void> {
    const { t: tenantId, c: connectionId } = state;
    const accessEnvelope = this.tokenCrypto.encrypt(token.access_token!);
    // Google returns refresh_token only on an explicit consent grant. We force
    // prompt=consent so it should always be present, but if a future flow omits
    // it we keep the previously stored refresh token instead of nulling it.
    const refreshEnvelope = token.refresh_token
      ? this.tokenCrypto.encrypt(token.refresh_token)
      : null;
    const accountEmail = identity.email;
    const displayName = identity.name;

    await this.prisma.withTenant(tenantId, async (tx) => {
      const current = await admitMailboxOAuthAttempt(
        tx,
        state,
        EngagementProvider.google_workspace,
        'exchanging',
      );
      await assertReturnedMailboxIdentity(tx, state, identity.sub, accountEmail);
      if (!token.refresh_token && !current.token?.refreshTokenCiphertext) {
        throw new BadRequestException(
          'Provider did not return a refresh token; restart mailbox connection',
        );
      }
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
          scopes: (token.scope ?? '').split(/\s+/).filter(Boolean),
          homeAccountId: identity.sub,
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
          scopes: (token.scope ?? '').split(/\s+/).filter(Boolean),
          homeAccountId: identity.sub,
          expiresAt,
        },
      });

      await tx.integrationConnection.update({
        where: { id: connectionId },
        data: {
          status: EngagementConnectionStatus.connected,
          accountEmail: accountEmail ?? undefined,
          displayName: displayName ?? undefined,
          scopes: (token.scope ?? '').split(/\s+/).filter(Boolean),
          lastError: null,
          syncState: verifiedScopeState(
            completedMailboxOAuthState(current.syncState),
            (token.scope ?? '').split(/\s+/).filter(Boolean),
          ),
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
    const [body, sig, extra] = state.split('.');
    if (!body || !sig || extra !== undefined) throw new BadRequestException('Malformed state');
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
    assertMailboxOAuthState(payload, EngagementProvider.google_workspace);
    return payload;
  }
}
