// ============================================================================
// ⛔ CHANGE-CONTROL: AUTHENTICATION / EMAIL INTEGRATION — APPROVAL REQUIRED
// ----------------------------------------------------------------------------
// Shared Google Workspace OAuth token machinery, extracted verbatim from
// google-sync.service.ts so BOTH the read path (GoogleSyncService) and the
// send path (GmailSendService) resolve tokens through one code path — a single
// refresh/persist/reconnect flow, no duplicated logic. The behaviour here is
// unchanged from the original sync implementation; it was lifted, not rewritten.
// Do NOT modify (refresh flow, connection/token persistence, invalid_grant
// reconnect handling) without EXPLICIT prior approval from Neo — these paths
// gate the email integration and a subtle change has repeatedly caused
// tenant-wide 403/500 outages.
// ============================================================================
import {
  BadRequestException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { admitMailboxRefresh } from '../mailbox-oauth-authority.js';
import { assertMailboxSyncCurrent } from '../mailbox-sync-claim.js';
import { mailboxProviderRequest } from '../mailbox-provider-transport.js';
import {
  EngagementConnectionStatus,
  EngagementProvider,
  type IntegrationConnectionToken,
} from '@prisma/client';
import type { AppConfig } from '../../config/config.schema.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { missingGoogleGrants } from './google-oauth.service.js';
import { verifiedScopeState } from '../integration-health.js';
import { TokenCryptoService } from '../microsoft/token-crypto.service.js';
import { MailboxReconnectRequiredError, mailSyncFailureData } from '../mail-sync-failure.js';

const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const TOKEN_REFRESH_SKEW_MS = 5 * 60 * 1000;

interface GoogleRefreshResponse {
  access_token?: string;
  expires_in?: number;
  scope?: string;
  token_type?: string;
}

@Injectable()
export class GoogleTokenService {
  private readonly clientId?: string;
  private readonly clientSecret?: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly tokenCrypto: TokenCryptoService,
    config: ConfigService<AppConfig, true>,
  ) {
    this.clientId = config.get('GOOGLE_CLIENT_ID', { infer: true });
    this.clientSecret = config.get('GOOGLE_CLIENT_SECRET', { infer: true });
  }

  /**
   * Load a Google Workspace connection and its stored OAuth token. Runs under
   * the tenant RLS scope. Throws if the connection is missing, is not a Google
   * integration, or has no token row. The returned `connection` is the full
   * row (so callers can enforce per-user ownership before sending).
   */
  async loadConnection(tenantId: string, connectionId: string) {
    const loaded = await this.prisma.withTenant(tenantId, async (tx) => {
      const connection = await tx.integrationConnection.findUnique({
        where: { id: connectionId },
        include: { token: true },
      });
      if (!connection) throw new NotFoundException('Google connection not found');
      if (connection.provider !== EngagementProvider.google_workspace) {
        throw new BadRequestException('Connection is not a Google Workspace integration');
      }
      if (!connection.token) {
        throw new BadRequestException('Google connection has no stored OAuth token');
      }
      return { connection, token: connection.token };
    });
    return loaded;
  }

  /**
   * Return a currently-valid access token for the connection, refreshing via
   * the stored refresh token when the cached access token is within the skew
   * window of expiry. On invalid_grant (revoked / 7-day Testing-mode expiry) the
   * connection is flagged needs_configuration and a reconnect error is thrown.
   */
  async getValidAccessToken(
    tenantId: string,
    connectionId: string,
    token: IntegrationConnectionToken,
  ): Promise<string> {
    await this.prisma.withTenant(tenantId, async (tx) => {
      await assertMailboxSyncCurrent(tx, tenantId, connectionId);
      return admitMailboxRefresh(
        tx,
        tenantId,
        connectionId,
        EngagementProvider.google_workspace,
        token,
      );
    });
    if (token.expiresAt.getTime() > Date.now() + TOKEN_REFRESH_SKEW_MS) {
      return this.tokenCrypto.decrypt(
        {
          ciphertext: token.accessTokenCiphertext,
          iv: token.accessTokenIv,
          authTag: token.accessTokenAuthTag,
        },
        token.keyVersion,
      );
    }

    this.assertConfigured();
    if (!token.refreshTokenCiphertext || !token.refreshTokenIv || !token.refreshTokenAuthTag) {
      await this.markConnectionNeedsReconnect(tenantId, connectionId, token);
      throw new MailboxReconnectRequiredError(
        'Google refresh token is missing; reconnect Google Workspace',
      );
    }
    const refreshToken = this.tokenCrypto.decrypt(
      {
        ciphertext: token.refreshTokenCiphertext,
        iv: token.refreshTokenIv,
        authTag: token.refreshTokenAuthTag,
      },
      token.keyVersion,
    );

    const body = new URLSearchParams({
      client_id: this.clientId!,
      client_secret: this.clientSecret!,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    });
    const { response, text, refreshed } = await mailboxProviderRequest(async (signal) => {
      const response = await fetch(GOOGLE_TOKEN_URL, {
        signal,
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
      });
      return {
        response,
        text: response.ok ? '' : await response.text(),
        refreshed: response.ok ? ((await response.json()) as GoogleRefreshResponse) : null,
      };
    });
    if (!response.ok) {
      // invalid_grant => the user revoked access or the refresh token expired
      // (e.g. app still in Testing publishing status, 7-day expiry). Mark the
      // connection for reconnect rather than looping.
      if (response.status === 400 && /invalid_grant/i.test(text)) {
        await this.markConnectionNeedsReconnect(tenantId, connectionId, token);
        throw new MailboxReconnectRequiredError(
          'Reconnect Google Workspace in Settings to continue syncing',
        );
      }
      throw new ServiceUnavailableException(
        `Google token refresh failed (${response.status}): ${text.slice(0, 300)}`,
      );
    }
    if (!refreshed?.access_token) {
      throw new ServiceUnavailableException('Google token refresh returned no access token');
    }
    if (refreshed.scope !== undefined && missingGoogleGrants(refreshed.scope).length) {
      await this.markConnectionNeedsReconnect(tenantId, connectionId, token);
      throw new MailboxReconnectRequiredError(
        'Reconnect Google Workspace to grant the required permissions',
      );
    }
    const grantedScopes =
      refreshed.scope === undefined ? undefined : refreshed.scope.split(/\s+/).filter(Boolean);
    const expiresAt = new Date(Date.now() + (refreshed.expires_in ?? 3600) * 1000);
    // Google does NOT rotate refresh tokens on redemption (unlike Azure), so the
    // plaintext redeemed above is the one to keep. It is re-encrypted under the
    // ACTIVE key and written together with the new access envelope, because one row
    // carries a single keyVersion for all of its envelopes: leaving the stored
    // refresh envelope under the previous key while the label advances would make
    // the row unreadable at its next refresh (it would be decrypted with the active
    // key). Both envelopes therefore move together in this update.
    const encrypted = this.tokenCrypto.encrypt(refreshed.access_token);
    const encryptedRefresh = this.tokenCrypto.encrypt(refreshToken);
    await this.prisma.withTenant(tenantId, async (tx) => {
      await assertMailboxSyncCurrent(tx, tenantId, connectionId);
      const current = await admitMailboxRefresh(
        tx,
        tenantId,
        connectionId,
        EngagementProvider.google_workspace,
        token,
      );
      await tx.integrationConnectionToken.update({
        where: { connectionId },
        data: {
          accessTokenCiphertext: encrypted.ciphertext,
          accessTokenIv: encrypted.iv,
          accessTokenAuthTag: encrypted.authTag,
          refreshTokenCiphertext: encryptedRefresh.ciphertext,
          refreshTokenIv: encryptedRefresh.iv,
          refreshTokenAuthTag: encryptedRefresh.authTag,
          keyVersion: this.tokenCrypto.getKeyVersion(),
          scopes: grantedScopes ?? token.scopes,
          expiresAt,
        },
      });
      await tx.integrationConnection.update({
        where: { id: connectionId },
        data: {
          status: EngagementConnectionStatus.connected,
          scopes: grantedScopes ?? token.scopes,
          ...(grantedScopes
            ? { syncState: verifiedScopeState(current.syncState, grantedScopes) }
            : {}),
          lastError: null,
        },
      });
    });
    return refreshed.access_token;
  }

  private async markConnectionNeedsReconnect(
    tenantId: string,
    connectionId: string,
    snapshot: IntegrationConnectionToken,
  ) {
    await this.prisma.withTenant(tenantId, async (tx) => {
      await assertMailboxSyncCurrent(tx, tenantId, connectionId);
      await admitMailboxRefresh(
        tx,
        tenantId,
        connectionId,
        EngagementProvider.google_workspace,
        snapshot,
      );
      await tx.integrationConnection.update({
        where: { id: connectionId },
        data: mailSyncFailureData('needs_reconnect', 'Google Workspace'),
      });
    });
  }

  private assertConfigured() {
    if (!this.clientId || !this.clientSecret || !this.tokenCrypto.isConfigured()) {
      throw new ServiceUnavailableException(
        'Google integration is not fully configured. Required: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, OAUTH_TOKEN_ENCRYPTION_KEY.',
      );
    }
  }
}
