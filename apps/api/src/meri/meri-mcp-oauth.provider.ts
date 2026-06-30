/**
 * DB-backed OAuthClientProvider for Meri MCP connectors (connector-library v1).
 *
 * The MCP SDK's `auth()` orchestrator drives the OAuth 2.1 flow (RFC 9728/8414
 * discovery, RFC 7591 dynamic client registration, PKCE, code exchange, refresh)
 * and persists state through an OAuthClientProvider. This implementation backs
 * that provider with the clio_mcp_oauth_credentials table so the flow survives
 * across the two web requests (start → provider redirect, then callback → code
 * exchange) and so the transport can silently refresh tokens later.
 *
 * Every secret (client_secret, access/refresh tokens, PKCE verifier) is stored
 * as an AES-256-GCM envelope — never in plaintext. All reads/writes are
 * tenant-scoped via PrismaService.withTenant (RLS-enforced).
 *
 * `redirectToAuthorization` does NOT redirect — server-side there is no user
 * agent here. It captures the authorization URL so the caller can hand it to
 * the browser. The signed `state` (carrying tenant + server + nonce) is
 * supplied via `state()` and embedded in that URL by the SDK.
 */
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import type {
  OAuthClientInformationFull,
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import { Prisma } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service.js';
import { decryptSecret, encryptSecret, type SecretEnvelope } from '../common/secret-crypto.js';

export interface DbOAuthProviderOptions {
  prisma: PrismaService;
  encryptionKey: Buffer;
  keyVersion: string;
  tenantId: string;
  serverId: string;
  /** Absolute callback URL registered as the OAuth redirect_uri. */
  redirectUri: string;
  /** client_name advertised during dynamic client registration. */
  clientName: string;
  /** Signed state to embed in the authorization URL (verified on callback). */
  signedState?: string;
  /** Space-or-array scopes to request (from the catalog entry). */
  requestedScopes?: readonly string[];
}

export class DbOAuthClientProvider implements OAuthClientProvider {
  private capturedUrl?: URL;

  constructor(private readonly opts: DbOAuthProviderOptions) {}

  /** The authorization URL captured from `redirectToAuthorization`, if any. */
  get capturedAuthorizationUrl(): URL | undefined {
    return this.capturedUrl;
  }

  get redirectUrl(): string {
    return this.opts.redirectUri;
  }

  get clientMetadata(): OAuthClientMetadata {
    const scope = this.opts.requestedScopes?.length
      ? this.opts.requestedScopes.join(' ')
      : undefined;
    return {
      client_name: this.opts.clientName,
      redirect_uris: [this.opts.redirectUri],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      // Prefer a public (PKCE) client; if the server forces a secret on
      // registration we persist it and the SDK negotiates the method.
      token_endpoint_auth_method: 'none',
      ...(scope ? { scope } : {}),
    };
  }

  state(): string {
    // Only consulted on the interactive (start) flow, where signedState is set.
    // At runtime (refresh) the captured URL is discarded, so '' is harmless.
    return this.opts.signedState ?? '';
  }

  async clientInformation(): Promise<OAuthClientInformationMixed | undefined> {
    const row = await this.read();
    if (!row?.clientId) return undefined;
    const base = (row.registrationJson as Record<string, unknown> | null) ?? {};
    const clientSecret = this.decrypt(
      row.clientSecretCiphertext,
      row.clientSecretIv,
      row.clientSecretAuthTag,
    );
    return {
      ...base,
      client_id: row.clientId,
      ...(clientSecret ? { client_secret: clientSecret } : {}),
    } as OAuthClientInformationMixed;
  }

  async saveClientInformation(info: OAuthClientInformationMixed): Promise<void> {
    const full = info as OAuthClientInformationFull & { client_secret?: string };
    const secretEnvelope = full.client_secret ? this.enc(full.client_secret) : null;
    // Strip the secret out of the stored registration metadata.
    const { client_secret: _omit, ...registration } = full as Record<string, unknown> & {
      client_secret?: string;
    };
    await this.upsert({
      clientId: full.client_id,
      registrationJson: registration as Prisma.InputJsonValue,
      clientSecretCiphertext: secretEnvelope?.ciphertext ?? null,
      clientSecretIv: secretEnvelope?.iv ?? null,
      clientSecretAuthTag: secretEnvelope?.authTag ?? null,
      keyVersion: this.opts.keyVersion,
    });
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    const row = await this.read();
    const accessToken = this.decrypt(
      row?.accessTokenCiphertext,
      row?.accessTokenIv,
      row?.accessTokenAuthTag,
    );
    if (!row || !accessToken) return undefined;
    const refreshToken = this.decrypt(
      row.refreshTokenCiphertext,
      row.refreshTokenIv,
      row.refreshTokenAuthTag,
    );
    const scopes = Array.isArray(row.scopes) ? (row.scopes as string[]) : [];
    const expiresIn = row.tokenExpiresAt
      ? Math.max(0, Math.floor((row.tokenExpiresAt.getTime() - Date.now()) / 1000))
      : undefined;
    return {
      access_token: accessToken,
      token_type: row.tokenType ?? 'Bearer',
      ...(refreshToken ? { refresh_token: refreshToken } : {}),
      ...(scopes.length ? { scope: scopes.join(' ') } : {}),
      ...(expiresIn !== undefined ? { expires_in: expiresIn } : {}),
    };
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    const accessEnvelope = this.enc(tokens.access_token);
    // refreshAuthorization preserves the prior refresh token, so it's normally
    // present; only overwrite when one is returned.
    const refreshEnvelope = tokens.refresh_token ? this.enc(tokens.refresh_token) : null;
    const tokenExpiresAt = tokens.expires_in
      ? new Date(Date.now() + tokens.expires_in * 1000)
      : null;
    const scopes = tokens.scope ? tokens.scope.split(/\s+/).filter(Boolean) : undefined;

    await this.opts.prisma.withTenant(this.opts.tenantId, async (tx) => {
      await tx.clioMcpOAuthCredential.upsert({
        where: { serverId: this.opts.serverId },
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
          tokenType: tokens.token_type,
          ...(scopes ? { scopes } : {}),
          tokenExpiresAt,
          // The PKCE verifier is single-use; clear it once tokens are minted.
          codeVerifierCiphertext: null,
          codeVerifierIv: null,
          codeVerifierAuthTag: null,
          keyVersion: this.opts.keyVersion,
        },
        create: {
          tenantId: this.opts.tenantId,
          serverId: this.opts.serverId,
          accessTokenCiphertext: accessEnvelope.ciphertext,
          accessTokenIv: accessEnvelope.iv,
          accessTokenAuthTag: accessEnvelope.authTag,
          refreshTokenCiphertext: refreshEnvelope?.ciphertext ?? null,
          refreshTokenIv: refreshEnvelope?.iv ?? null,
          refreshTokenAuthTag: refreshEnvelope?.authTag ?? null,
          tokenType: tokens.token_type,
          scopes: scopes ?? [],
          tokenExpiresAt,
          keyVersion: this.opts.keyVersion,
        },
      });
      // Tokens minted/refreshed → the connector is live again.
      await tx.clioMcpServer.update({
        where: { id: this.opts.serverId },
        data: { connectionStatus: 'connected', lastError: null },
      });
    });
  }

  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    this.capturedUrl = authorizationUrl;
  }

  async saveCodeVerifier(codeVerifier: string): Promise<void> {
    const envelope = this.enc(codeVerifier);
    await this.upsert({
      codeVerifierCiphertext: envelope.ciphertext,
      codeVerifierIv: envelope.iv,
      codeVerifierAuthTag: envelope.authTag,
      keyVersion: this.opts.keyVersion,
    });
  }

  async codeVerifier(): Promise<string> {
    const row = await this.read();
    const verifier = this.decrypt(
      row?.codeVerifierCiphertext,
      row?.codeVerifierIv,
      row?.codeVerifierAuthTag,
    );
    if (!verifier) {
      throw new Error('Missing PKCE code verifier — restart the connection flow');
    }
    return verifier;
  }

  async invalidateCredentials(
    scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery',
  ): Promise<void> {
    if (scope === 'discovery') return; // discovery is not cached
    const data: Prisma.ClioMcpOAuthCredentialUpdateInput = {};
    if (scope === 'all' || scope === 'tokens') {
      Object.assign(data, {
        accessTokenCiphertext: null,
        accessTokenIv: null,
        accessTokenAuthTag: null,
        refreshTokenCiphertext: null,
        refreshTokenIv: null,
        refreshTokenAuthTag: null,
        tokenExpiresAt: null,
      });
    }
    if (scope === 'all' || scope === 'client') {
      Object.assign(data, {
        clientId: null,
        clientSecretCiphertext: null,
        clientSecretIv: null,
        clientSecretAuthTag: null,
        registrationJson: Prisma.DbNull,
      });
    }
    if (scope === 'all' || scope === 'verifier') {
      Object.assign(data, {
        codeVerifierCiphertext: null,
        codeVerifierIv: null,
        codeVerifierAuthTag: null,
      });
    }
    await this.opts.prisma.withTenant(this.opts.tenantId, async (tx) => {
      await tx.clioMcpOAuthCredential.updateMany({
        where: { serverId: this.opts.serverId },
        data,
      });
      if (scope === 'all' || scope === 'tokens') {
        await tx.clioMcpServer.update({
          where: { id: this.opts.serverId },
          data: { connectionStatus: 'needs_reauth' },
        });
      }
    });
  }

  // ── persistence helpers ────────────────────────────────────────────────
  private read() {
    return this.opts.prisma.withTenant(this.opts.tenantId, (tx) =>
      tx.clioMcpOAuthCredential.findUnique({ where: { serverId: this.opts.serverId } }),
    );
  }

  private async upsert(
    fields: Prisma.ClioMcpOAuthCredentialUncheckedUpdateInput &
      Partial<Prisma.ClioMcpOAuthCredentialUncheckedCreateInput>,
  ): Promise<void> {
    await this.opts.prisma.withTenant(this.opts.tenantId, (tx) =>
      tx.clioMcpOAuthCredential.upsert({
        where: { serverId: this.opts.serverId },
        update: fields,
        create: {
          tenantId: this.opts.tenantId,
          serverId: this.opts.serverId,
          ...fields,
        } as Prisma.ClioMcpOAuthCredentialUncheckedCreateInput,
      }),
    );
  }

  private enc(plain: string): SecretEnvelope {
    return encryptSecret(this.opts.encryptionKey, plain);
  }

  private decrypt(
    ciphertext: string | null | undefined,
    iv: string | null | undefined,
    authTag: string | null | undefined,
  ): string | null {
    if (!ciphertext || !iv || !authTag) return null;
    return decryptSecret(this.opts.encryptionKey, { ciphertext, iv, authTag });
  }
}
