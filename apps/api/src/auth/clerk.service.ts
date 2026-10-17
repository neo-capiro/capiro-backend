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
import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClerkClient, type ClerkClient, verifyToken } from '@clerk/backend';
import type { AppConfig } from '../config/config.schema.js';

export interface ClerkSessionClaims {
  sub: string; // Clerk user id
  iss: string;
  sid?: string;
  exp?: number;
  email?: string;
  // Clerk Organizations claims (populated when the user has an active org).
  // NOTE: Clerk's *v2* default session token nests these under a compact `o`
  // object (`o.id`, `o.rol`, `o.slg`) and sets `v: 2`, rather than the flat
  // `org_id`/`org_role`/`org_slug` of v1. verifySessionToken() normalizes the
  // v2 shape back into these flat fields so the rest of the codebase has a
  // single contract regardless of which token version Clerk emits.
  org_id?: string;
  org_slug?: string;
  org_role?: string;
  // Capiro custom claims, populated by the `capiro` JWT template configured
  // in the Clerk dashboard:
  //   capiro_tenant_id   = {{org.public_metadata.capiro_tenant_id}}
  //   capiro_tenant_slug = {{org.slug}}
  // Empty strings when the user has no active org. The middleware falls back
  // to header/subdomain resolution in that case. These are OPTIONAL: tenant
  // resolution also works from org_id alone (matched against
  // tenants.clerk_org_id), which is what the v2 default token provides.
  capiro_tenant_id?: string;
  capiro_tenant_slug?: string;
  capiro_org_role?: string;
}

/** Clerk v2 default session token nests org info under a compact `o` object. */
interface ClerkV2OrgClaim {
  id?: string;
  slg?: string;
  rol?: string;
}

export interface ActiveApplicationAuthoritySession {
  id: string;
  userId: string;
  status: 'active';
  createdAt: number;
  expireAt: number;
  abandonAt: number;
  actor: Record<string, unknown> | null;
  expiresAtMs: number;
}

/**
 * Thin wrapper around @clerk/backend. Centralizes JWT verification and
 * Backend API access so the rest of the codebase never imports Clerk
 * directly.
 */
@Injectable()
export class ClerkService {
  private readonly logger = new Logger(ClerkService.name);
  private readonly client: ClerkClient;
  private readonly secretKey: string;
  private readonly issuer: string | undefined;

  constructor(config: ConfigService<AppConfig, true>) {
    this.secretKey = config.get('CLERK_SECRET_KEY', { infer: true });
    this.issuer = config.get('CLERK_JWT_ISSUER', { infer: true });
    this.client = createClerkClient({ secretKey: this.secretKey });
  }

  get backend(): ClerkClient {
    return this.client;
  }

  /**
   * Verify a Clerk session JWT. Returns the claims if valid, throws otherwise.
   * Uses Clerk's JWKS (cached by the SDK).
   */
  async verifySessionToken(token: string): Promise<ClerkSessionClaims> {
    const raw = await verifyToken(token, {
      secretKey: this.secretKey,
    });
    // Issuer pinning must be done HERE, not by passing `issuer` to
    // verifyToken. `issuer` is NOT a VerifyJwtOptions field in
    // @clerk/backend@1.34.0 — the option type is
    // { audience, authorizedParties, clockSkewInMs, key } and the runtime
    // destructures exactly those four, so the value we used to spread in was
    // silently DISCARDED and pinned nothing. Enforce it explicitly.
    //
    // Defence in depth: the JWKS is fetched with our own CLERK_SECRET_KEY, so a
    // foreign-instance token already fails signature verification above.
    this.assertIssuer(raw as Record<string, unknown>);
    return normalizeClaims(raw as Record<string, unknown>);
  }

  /** Read-only online session check for application receipts. Never mints tokens.
   * The SDK has no per-getSession AbortSignal. This deadline bounds caller
   * refusal; late SDK settlement is consumed and cannot produce a receipt. */
  async assertActiveApplicationAuthoritySession(
    claims: ClerkSessionClaims,
  ): Promise<ActiveApplicationAuthoritySession> {
    const denied = () => new UnauthorizedException('Application authority unavailable');
    if (claims.sid === undefined && (claims as unknown as Record<string, unknown>).meri_control_credential === true) {
      return this.assertMeriControlCredentialSession(claims);
    }
    if (typeof claims.sid !== 'string' || !/^[A-Za-z0-9_-]{1,256}$/.test(claims.sid) ||
        typeof claims.sub !== 'string' || !/^[A-Za-z0-9_-]{1,256}$/.test(claims.sub) ||
        !Number.isSafeInteger(claims.exp) || !Number.isSafeInteger((claims.exp ?? 0) * 1000) ||
        (claims.exp ?? 0) * 1000 <= Date.now()) throw denied();
    const sessionId = claims.sid;
    const userId = claims.sub;
    const jwtExpiresAtMs = claims.exp! * 1000;
    const deadlineMs = Date.now() + 2000;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const session = await Promise.race([
        Promise.resolve().then(() => this.client.sessions.getSession(sessionId)),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(denied()), 2000);
        }),
      ]);
      const now = Date.now();
      if (now >= deadlineMs || !session || session.id !== sessionId || session.userId !== userId ||
          session.status !== 'active' ||
          ![session.createdAt, session.expireAt, session.abandonAt].every(
            (value) => Number.isSafeInteger(value) && value >= 0,
          ) || session.createdAt > now) throw denied();
      const expiresAtMs = Math.min(jwtExpiresAtMs, session.expireAt, session.abandonAt);
      if (expiresAtMs <= now) throw denied();
      return {
        id: session.id, userId: session.userId, status: 'active',
        createdAt: session.createdAt, expireAt: session.expireAt, abandonAt: session.abandonAt,
        actor: session.actor, expiresAtMs,
      };
    } catch {
      throw denied();
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  /** Meri preview control credential: a token from the dedicated `meri-preview-control` JWT template,
   * marked by the constant claim `meri_control_credential: true`. Clerk reserves `sid` in templates and
   * has no session shortcode, so the token cannot name a session. Its signature and issuer are already
   * verified by verifySessionToken. Here the user must currently hold at least one active Clerk session
   * (signing out everywhere revokes it), lifetime is bounded to 7 days, and the result is a stable
   * pseudo-session bound to this token's `jti` so identity evidence does not drift between calls. */
  private async assertMeriControlCredentialSession(
    claims: ClerkSessionClaims,
  ): Promise<ActiveApplicationAuthoritySession> {
    const denied = () => new UnauthorizedException('Application authority unavailable');
    const raw = claims as unknown as Record<string, unknown>;
    const iat = raw.iat, jti = raw.jti, exp = claims.exp;
    const now0 = Date.now();
    if (typeof claims.sub !== 'string' || !/^[A-Za-z0-9_-]{1,256}$/.test(claims.sub) ||
        typeof jti !== 'string' || !/^[A-Za-z0-9_-]{1,256}$/.test(jti) ||
        !Number.isSafeInteger(iat) || !Number.isSafeInteger(exp) || !Number.isSafeInteger((exp as number) * 1000) ||
        (iat as number) > (exp as number) || (exp as number) - (iat as number) > 604800 ||
        (iat as number) * 1000 > now0 + 5000 || (exp as number) * 1000 <= now0) throw denied();
    const userId = claims.sub;
    const deadlineMs = now0 + 2000;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const listed = await Promise.race([
        Promise.resolve().then(() => this.client.sessions.getSessionList({ userId, status: 'active' })),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(denied()), 2000);
        }),
      ]);
      const now = Date.now();
      const sessions = (Array.isArray(listed) ? listed : (listed as { data?: unknown }).data) as
        Array<{ userId?: unknown; status?: unknown; expireAt?: unknown; abandonAt?: unknown }> | undefined;
      if (now >= deadlineMs || !Array.isArray(sessions)) throw denied();
      const live = sessions.filter((s) => s && s.userId === userId && s.status === 'active' &&
        Number.isSafeInteger(s.expireAt) && Number.isSafeInteger(s.abandonAt) &&
        Math.min(s.expireAt as number, s.abandonAt as number) > now);
      if (live.length === 0) throw denied();
      const sessionUntil = Math.max(...live.map((s) => Math.min(s.expireAt as number, s.abandonAt as number)));
      const expiresAtMs = Math.min((exp as number) * 1000, sessionUntil);
      if (expiresAtMs <= now) throw denied();
      return {
        id: `meri-template:${jti}`, userId, status: 'active',
        createdAt: (iat as number) * 1000, expireAt: sessionUntil, abandonAt: sessionUntil,
        actor: null, expiresAtMs,
      };
    } catch {
      throw denied();
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  private assertIssuer(raw: Record<string, unknown>): void {
    if (!this.issuer) return;
    if (raw.iss !== this.issuer) {
      throw new Error(`Token issuer mismatch: expected ${this.issuer}, got ${String(raw.iss)}`);
    }
  }
}

/**
 * Normalize Clerk session-token claims into our flat ClerkSessionClaims
 * contract. Clerk's v2 default session token nests the active-org claims under
 * a compact `o` object ({ id, slg, rol }) instead of the v1 flat
 * `org_id`/`org_slug`/`org_role`. Without this, the tenant-context middleware
 * (which reads `org_id`) sees `undefined` for every request and 403s every
 * authenticated user. We map v2 -> flat, preferring any explicit flat claim
 * (e.g. from a custom JWT template) when present.
 */
function normalizeClaims(raw: Record<string, unknown>): ClerkSessionClaims {
  const o = (raw.o ?? undefined) as ClerkV2OrgClaim | undefined;
  const orgId = (raw.org_id as string | undefined) ?? o?.id;
  const orgSlug = (raw.org_slug as string | undefined) ?? o?.slg;
  const orgRole = (raw.org_role as string | undefined) ?? normalizeOrgRole(o?.rol);

  return {
    ...(raw as unknown as ClerkSessionClaims),
    org_id: orgId,
    org_slug: orgSlug,
    org_role: orgRole,
  };
}

/**
 * v2 `o.rol` is the short role ("admin"/"member"); v1 `org_role` is the
 * prefixed form ("org:admin"/"org:member"). mapClerkRoleToCapiro accepts both,
 * but normalize to the prefixed form for consistency with the webhook path.
 */
function normalizeOrgRole(rol: string | undefined): string | undefined {
  if (!rol) return undefined;
  return rol.startsWith('org:') ? rol : `org:${rol}`;
}
