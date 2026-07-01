// ============================================================================
// ⛔ CHANGE-CONTROL: AUTHENTICATION — APPROVAL REQUIRED
// ----------------------------------------------------------------------------
// Do NOT modify this file (or anything touching Clerk auth, the tenant guard,
// or JWT/session handling) without EXPLICIT prior approval from Neo. These
// paths gate every authenticated request; a subtle change here has repeatedly
// caused tenant-wide 403/500 outages in the sibling apps/api service.
// Investigate read-only and PROPOSE first; wait for go-ahead before editing.
//
// This file is a deliberate VERBATIM port of apps/api/src/auth/clerk.service.ts
// (Clerk verifyToken + v1/v2 claims normalization). The two services are
// deployed independently so they each own a private copy of the verification
// primitive; never reach across the boundary.
// ============================================================================
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClerkClient, type ClerkClient, verifyToken } from '@clerk/backend';

export interface ClerkSessionClaims {
  sub: string; // Clerk user id
  iss: string;
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
  // Empty strings when the user has no active org. The tenant guard falls back
  // to org_id resolution in that case. These are OPTIONAL: tenant resolution
  // also works from org_id alone (matched against the shared tenants table by
  // apps/api; the workspace service trusts the verified claim in Phase 1 and
  // defers the membership cross-check to Phase 3).
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

  constructor(config: ConfigService) {
    const secretKey = config.get<string>('CLERK_SECRET_KEY');
    if (!secretKey) {
      throw new Error('CLERK_SECRET_KEY is required');
    }
    this.secretKey = secretKey;
    this.issuer = config.get<string>('CLERK_JWT_ISSUER');
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
      ...(this.issuer ? { issuer: this.issuer } : {}),
    });
    return normalizeClaims(raw as Record<string, unknown>);
  }
}

/**
 * Normalize Clerk session-token claims into our flat ClerkSessionClaims
 * contract. Clerk's v2 default session token nests the active-org claims under
 * a compact `o` object ({ id, slg, rol }) instead of the v1 flat
 * `org_id`/`org_slug`/`org_role`. Without this, the tenant guard (which reads
 * `org_id`) sees `undefined` for every request and 403s every authenticated
 * user. We map v2 -> flat, preferring any explicit flat claim (e.g. from a
 * custom JWT template) when present.
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
