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
import { ApplicationAuthorityUnavailableException, isClerkUnanswered } from './application-authority-unavailable.js';

export interface ClerkSessionClaims {
  sub: string; // Clerk user id
  iss: string;
  sid?: string;
  exp?: number;
  /** Dedicated Meri preview control template marker, never a native session. */
  meri_control_credential?: boolean;
  iat?: number;
  jti?: string;
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

/** Pure admission shape check so a malformed marked token is refused before
 * the ordinary tenant middleware can perform any local self-heal or audit. */
export function isWellFormedMeriControlCredentialClaims(
  claims: ClerkSessionClaims,
  nowMs = Date.now(),
): boolean {
  const { iat, jti, exp } = claims;
  return claims.meri_control_credential === true && claims.sid === undefined &&
    typeof claims.sub === 'string' && /^[A-Za-z0-9_-]{1,256}$/.test(claims.sub) &&
    typeof jti === 'string' && /^[A-Za-z0-9_-]{1,256}$/.test(jti) &&
    Number.isSafeInteger(iat) && Number.isSafeInteger(exp) &&
    Number.isSafeInteger((iat ?? 0) * 1000) && Number.isSafeInteger((exp ?? 0) * 1000) &&
    (iat ?? 0) <= (exp ?? 0) && (exp ?? 0) - (iat ?? 0) <= 604800 &&
    (iat ?? 0) * 1000 <= nowMs + 5000 && (exp ?? 0) * 1000 > nowMs;
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
   * The SDK has no per-getSession AbortSignal. This deadline bounds the caller;
   * late SDK settlement is consumed and cannot produce a receipt. A deadline, a
   * transport failure or Clerk 429/5xx is ApplicationAuthorityUnavailableException
   * (503, did not answer); an invalid, inactive or mismatched session is 401. */
  async assertActiveApplicationAuthoritySession(
    claims: ClerkSessionClaims,
  ): Promise<ActiveApplicationAuthoritySession> {
    const denied = () => new UnauthorizedException('Application authority unavailable');
    if (claims.meri_control_credential === true ||
        typeof claims.sid !== 'string' || !/^[A-Za-z0-9_-]{1,256}$/.test(claims.sid) ||
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
        Promise.resolve().then(() => this.client.sessions.getSession(sessionId)).catch((error: unknown) => {
          throw isClerkUnanswered(error) ? new ApplicationAuthorityUnavailableException() : denied();
        }),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new ApplicationAuthorityUnavailableException()), 2000);
        }),
      ]);
      const now = Date.now();
      if (now >= deadlineMs) throw new ApplicationAuthorityUnavailableException();
      if (!session || session.id !== sessionId || session.userId !== userId ||
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
    } catch (error) {
      // Clerk did not answer: retryable 503. Every other failure stays a refusal.
      throw error instanceof ApplicationAuthorityUnavailableException ? error : denied();
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  /** Only the three named application-authority POSTs may call this method.
   * A verified marked template token has no sid, so a fresh active session
   * list checks current user presence without pretending the token is a native
   * session. No positive proof is cached across calls or requests. */
  async assertActiveMeriControlCredentialSession(
    claims: ClerkSessionClaims,
  ): Promise<ActiveApplicationAuthoritySession> {
    const denied = () => new UnauthorizedException('Application authority unavailable');
    const { iat, jti, exp } = claims;
    const now0 = Date.now();
    if (!isWellFormedMeriControlCredentialClaims(claims, now0)) throw denied();
    const userId = claims.sub;
    const deadlineMs = now0 + 2000;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const listed = await Promise.race([
        Promise.resolve().then(() => this.client.sessions.getSessionList({ userId, status: 'active' })).catch((error: unknown) => {
          throw isClerkUnanswered(error) ? new ApplicationAuthorityUnavailableException() : denied();
        }),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new ApplicationAuthorityUnavailableException()), 2000);
        }),
      ]);
      const now = Date.now();
      if (now >= deadlineMs) throw new ApplicationAuthorityUnavailableException();
      const sessions = (Array.isArray(listed) ? listed : (listed as { data?: unknown }).data) as
        Array<{ userId?: unknown; status?: unknown; expireAt?: unknown; abandonAt?: unknown }> | undefined;
      if (!Array.isArray(sessions)) throw denied();
      const live = sessions.filter((s) => s && s.userId === userId && s.status === 'active' &&
        Number.isSafeInteger(s.expireAt) && Number.isSafeInteger(s.abandonAt) &&
        Math.min(s.expireAt as number, s.abandonAt as number) > now);
      if (live.length === 0) throw denied();
      const sessionUntil = Math.max(...live.map((s) => Math.min(s.expireAt as number, s.abandonAt as number)));
      const expiresAtMs = Math.min((exp ?? 0) * 1000, sessionUntil);
      if (expiresAtMs <= now) throw denied();
      return {
        id: `meri-template:${jti}`, userId, status: 'active',
        createdAt: (iat ?? 0) * 1000, expireAt: sessionUntil, abandonAt: sessionUntil,
        actor: null, expiresAtMs,
      };
    } catch (error) {
      // Clerk did not answer: retryable 503. Every other failure stays a refusal.
      throw error instanceof ApplicationAuthorityUnavailableException ? error : denied();
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  /** Reuse the native namespace pin for a verified Core-only retained frame. */
  assertRetainedApplicationAuthorityIssuer(issuer: string): void {
    try { this.assertIssuer({ iss: issuer }); }
    catch { throw new UnauthorizedException('Application authority unavailable'); }
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
