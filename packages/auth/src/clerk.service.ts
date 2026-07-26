// ============================================================================
// ⛔ CHANGE-CONTROL: AUTHENTICATION — APPROVAL REQUIRED
// ----------------------------------------------------------------------------
// Do NOT modify this file (or the sibling tenant.guard.ts) without EXPLICIT
// prior approval from Neo. This is THE shared "Clerk-verify → narrow tenant
// context" primitive for apps/meriv2-orchestrator and apps/workspace
// (auth-extraction Option N, DECISIONS D8 — approved by Neo 2026-07-06). It is
// a byte-for-byte-behavioral port of the two services' previously-identical
// clones (themselves verbatim ports of apps/api/src/auth/clerk.service.ts:
// Clerk verifyToken + v1/v2 claims normalization). apps/api keeps its own
// richer membership-backed auth — do NOT fold it into this package (that is
// Option F, explicitly not approved).
// ============================================================================
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClerkClient, type ClerkClient, verifyToken } from '@clerk/backend';

export interface ClerkSessionClaims {
  sub: string; // Clerk user id
  iss: string;
  email?: string;
  // Clerk Organizations claims. Clerk's *v2* default session token nests these
  // under a compact `o` object (`o.id`, `o.rol`, `o.slg`) and sets `v: 2`,
  // rather than the flat `org_id`/`org_role`/`org_slug` of v1.
  // verifySessionToken() normalizes the v2 shape back into these flat fields so
  // the rest of the codebase has a single contract regardless of token version.
  org_id?: string;
  org_slug?: string;
  org_role?: string;
  // Capiro custom claims, populated by the `capiro` JWT template:
  //   capiro_tenant_id   = {{org.public_metadata.capiro_tenant_id}}
  //   capiro_tenant_slug = {{org.slug}}
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

/**
 * Thin wrapper around @clerk/backend. Centralizes JWT verification and Backend
 * API access so the rest of the codebase never imports Clerk directly.
 */
@Injectable()
export class ClerkService {
  private readonly logger = new Logger(ClerkService.name);
  private readonly client: ClerkClient;
  private readonly secretKey: string;
  private readonly issuer: string | undefined;
  private readonly logAzp: boolean;

  constructor(config: ConfigService) {
    const secretKey = config.get<string>('CLERK_SECRET_KEY');
    if (!secretKey) {
      throw new Error('CLERK_SECRET_KEY is required');
    }
    this.secretKey = secretKey;
    this.issuer = config.get<string>('CLERK_JWT_ISSUER');
    // Opt-in `azp` telemetry. See logObservedAzp().
    this.logAzp = config.get<string>('CLERK_LOG_AZP') === 'true';
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
    // Note this is defence in depth rather than the primary control: the JWKS
    // is fetched using our own CLERK_SECRET_KEY, so a token minted by a
    // different Clerk instance already fails signature verification above.
    this.assertIssuer(raw as Record<string, unknown>);
    this.logObservedAzp(raw as Record<string, unknown>);
    return normalizeClaims(raw as Record<string, unknown>);
  }

  /**
   * Emit the observed `azp` claim so the authorized-parties allowlist can be
   * derived from EVIDENCE rather than guessed.
   *
   * Why this exists: Clerk's assertAuthorizedPartiesClaim returns early when a
   * token carries no `azp`, and matches by exact string with no wildcard
   * support. Most Capiro requests use the custom `capiro` JWT template, and
   * whether that template emits `azp` is a Clerk-dashboard fact that cannot be
   * determined from this repo. Setting an allowlist blind therefore either
   * protects nothing (no azp) or 401s every user across six services (wrong
   * list). Turn this on, collect the distinct values, then set the list.
   *
   * OPT-IN (CLERK_LOG_AZP=true) and off by default: this sits on the hottest
   * path in the platform, so an always-on line would add a log record to every
   * authenticated request indefinitely. `azp` is an origin string, not a
   * credential.
   */
  private logObservedAzp(raw: Record<string, unknown>): void {
    if (!this.logAzp) return;
    this.logger.log(`clerk-azp azp=${String(raw.azp ?? 'ABSENT')}`);
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
 * `org_id`/`org_slug`/`org_role`. Without this, the tenant guard (which reads
 * `org_id`) sees `undefined` for every request and 403s every authenticated
 * user. Map v2 -> flat, preferring any explicit flat claim when present.
 */
export function normalizeClaims(raw: Record<string, unknown>): ClerkSessionClaims {
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
 * prefixed form ("org:admin"/"org:member"). Normalize to the prefixed form for
 * consistency with the webhook path.
 */
function normalizeOrgRole(rol: string | undefined): string | undefined {
  if (!rol) return undefined;
  return rol.startsWith('org:') ? rol : `org:${rol}`;
}
