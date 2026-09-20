import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';

/** Revocation-latency budget for hasActiveMembership. */
const MEMBERSHIP_TTL_MS = 30_000;
const TENANT_TTL_MS = 60_000;
const MAX_ENTRIES = 500;

interface Entry<T> {
  value: T;
  at: number;
}

interface TenantRow {
  id: string;
  slug: string;
  clerkOrgId: string | null;
}

export interface ResolvedTenant {
  tenantId: string;
  slug: string;
  clerkOrgId: string | null;
}

/**
 * Canonical org->tenant + active-membership lookup for intel-api.
 *
 * Declared LOCALLY rather than imported from @capiro/auth: intel-api is not a
 * consumer of that package (its only @capiro dependency is @capiro/shared) —
 * it carries an independent FORK of the guard and ClerkService. Adding the
 * dependency purely for an interface would pull the shared AuthModule into a
 * service that deliberately does not use it. The behaviour here MUST be kept in
 * step with packages/auth/src/org-tenant-resolver.ts by hand.
 *
 * ⚠️ withSystem is MANDATORY. `tenants` and `tenant_memberships` are owned by
 * apps/api and carry FORCE ROW LEVEL SECURITY, which subjects even the table
 * owner to the policy. At this point in the request no tenant GUC is set —
 * deciding the tenant is the point — so without the bypass these queries return
 * ZERO ROWS rather than raising, and every request 403s. The GUC is
 * `app.bypass_rls`, NOT `app.rls_bypass`.
 *
 * ⚠️ The ::uuid casts matter in the opposite direction from intel-api's own
 * tables: every intel_* tenant_id column is TEXT, but tenants.id and
 * tenant_memberships.tenant_id are real uuid columns.
 */
@Injectable()
export class OrgTenantResolverService {
  private readonly logger = new Logger(OrgTenantResolverService.name);
  private readonly byOrg = new Map<string, Entry<ResolvedTenant | null>>();
  private readonly byId = new Map<string, Entry<ResolvedTenant | null>>();
  private readonly membership = new Map<string, Entry<boolean>>();

  constructor(private readonly prisma: PrismaService) {}

  async resolveByClerkOrgId(clerkOrgId: string): Promise<ResolvedTenant | null> {
    const hit = read(this.byOrg, clerkOrgId, TENANT_TTL_MS);
    if (hit !== undefined) return hit;

    let rows: TenantRow[] = [];
    try {
      rows = await this.prisma.withSystem(
        (tx) =>
          tx.$queryRaw<TenantRow[]>`
          SELECT id::text AS id, slug::text AS slug, clerk_org_id AS "clerkOrgId"
          FROM tenants
          WHERE clerk_org_id = ${clerkOrgId}
          LIMIT 1
        `,
      );
    } catch (err) {
      this.logger.error(`resolveByClerkOrgId failed: ${(err as Error).message}`);
      return null;
    }

    const row = rows[0];
    const value = row ? { tenantId: row.id, slug: row.slug, clerkOrgId: row.clerkOrgId } : null;
    write(this.byOrg, clerkOrgId, value);
    return value;
  }

  async resolveByTenantId(tenantId: string): Promise<ResolvedTenant | null> {
    const hit = read(this.byId, tenantId, TENANT_TTL_MS);
    if (hit !== undefined) return hit;

    let rows: TenantRow[] = [];
    try {
      rows = await this.prisma.withSystem(
        (tx) =>
          tx.$queryRaw<TenantRow[]>`
          SELECT id::text AS id, slug::text AS slug, clerk_org_id AS "clerkOrgId"
          FROM tenants
          WHERE id = ${tenantId}::uuid
          LIMIT 1
        `,
      );
    } catch (err) {
      // A non-UUID claim raises 22P02 rather than returning no rows.
      this.logger.debug(`resolveByTenantId(${tenantId}) failed: ${(err as Error).message}`);
      return null;
    }

    const row = rows[0];
    const value = row ? { tenantId: row.id, slug: row.slug, clerkOrgId: row.clerkOrgId } : null;
    write(this.byId, tenantId, value);
    return value;
  }

  async hasActiveMembership(tenantId: string, clerkUserId: string): Promise<boolean> {
    const key = `${tenantId}|${clerkUserId}`;
    const hit = read(this.membership, key, MEMBERSHIP_TTL_MS);
    if (hit !== undefined) return hit;

    try {
      const rows = await this.prisma.withSystem(
        (tx) =>
          tx.$queryRaw<Array<{ ok: number }>>`
          SELECT 1 AS ok
          FROM tenant_memberships tm
          JOIN users u ON u.id = tm.user_id
          WHERE tm.tenant_id = ${tenantId}::uuid
            AND u.clerk_user_id = ${clerkUserId}
            AND tm.status::text = 'active'
          LIMIT 1
        `,
      );
      const value = rows.length > 0;
      write(this.membership, key, value);
      return value;
    } catch (err) {
      // Fail CLOSED.
      this.logger.error(`hasActiveMembership failed: ${(err as Error).message}`);
      return false;
    }
  }

  /**
   * Resolve a missing JWT role from the same canonical membership used by
   * apps/api. This is deliberately uncached: an old positive membership cache
   * entry must not grant an administrator role after removal or demotion.
   */
  async activeMembershipRole(
    tenantId: string,
    clerkUserId: string,
  ): Promise<{ role: string | null } | null> {
    try {
      const rows = await this.prisma.withSystem(
        (tx) =>
          tx.$queryRaw<Array<{ role: string | null }>>`
          SELECT tm.role::text AS role
          FROM tenant_memberships tm
          JOIN users u ON u.id = tm.user_id
          WHERE tm.tenant_id = ${tenantId}::uuid
            AND u.clerk_user_id = ${clerkUserId}
            AND tm.status::text = 'active'
          LIMIT 1
        `,
      );
      return rows[0] ?? null;
    } catch (err) {
      this.logger.error(`activeMembershipRole failed: ${(err as Error).message}`);
      return null;
    }
  }

  /**
   * Resolve the caller's current, unexpired Capiro Admin impersonation target.
   *
   * This lookup is intentionally uncached: ending/replacing a session must take
   * effect on the very next request. `impersonation_sessions` is owned by
   * apps/api and is bypass-only under FORCE RLS, so resolution happens through
   * the same trusted system scope used by the pre-tenant membership checks.
   * The guard remains responsible for proving the caller is a `capiro_admin`
   * and for comparing the returned slug with the request header.
   */
  async resolveActiveImpersonation(clerkUserId: string): Promise<ResolvedTenant | null> {
    try {
      const rows = await this.prisma.withSystem(
        (tx) =>
          tx.$queryRaw<TenantRow[]>`
          SELECT t.id::text AS id,
                 t.slug::text AS slug,
                 t.clerk_org_id AS "clerkOrgId"
          FROM impersonation_sessions s
          JOIN users u ON u.id = s.actor_user_id
          JOIN tenants t ON t.id = s.tenant_id
          WHERE u.clerk_user_id = ${clerkUserId}
            AND s.ended_at IS NULL
            AND s.expires_at > NOW()
          ORDER BY s.started_at DESC
          LIMIT 1
        `,
      );
      const row = rows[0];
      return row ? { tenantId: row.id, slug: row.slug, clerkOrgId: row.clerkOrgId } : null;
    } catch (err) {
      // Fail CLOSED. A broken session lookup must never leave the header trusted.
      this.logger.error(`resolveActiveImpersonation failed: ${(err as Error).message}`);
      return null;
    }
  }
}

function read<T>(map: Map<string, Entry<T>>, key: string, ttlMs: number): T | undefined {
  const hit = map.get(key);
  if (!hit) return undefined;
  if (Date.now() - hit.at > ttlMs) {
    map.delete(key);
    return undefined;
  }
  return hit.value;
}

function write<T>(map: Map<string, Entry<T>>, key: string, value: T): void {
  if (map.size >= MAX_ENTRIES) map.clear();
  map.set(key, { value, at: Date.now() });
}
