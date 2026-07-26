import { Injectable, Logger } from '@nestjs/common';
import type { OrgTenantResolver, ResolvedTenant } from '@capiro/auth';
import { PrismaService } from '../prisma/prisma.service.js';

/** Revocation-latency budget for hasActiveMembership: a user removed in Capiro
 *  keeps access for at most this long. Deliberately short. */
const MEMBERSHIP_TTL_MS = 30_000;
/** Tenant rows change rarely. */
const TENANT_TTL_MS = 60_000;
/** Hard cap so the cache cannot grow without bound. */
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

/**
 * Canonical org->tenant + active-membership lookup for meriv2-orchestrator.
 *
 * Uses RAW SQL rather than typed Prisma calls: this service's generated client
 * has no `Tenant` or `TenantMembership` model. Those tables live in the same
 * Aurora database but are owned by apps/api, and are deliberately absent from
 * this service's schema. (apps/onboard-api mirrors them and therefore uses the
 * typed client — see its PrismaOrgTenantResolver, the reference implementation.)
 *
 * ⚠️ withSystem is MANDATORY. `tenants` and `tenant_memberships` have FORCE ROW
 * LEVEL SECURITY, which subjects even the table owner to the policy, and at
 * this point in the request no tenant GUC is set — deciding the tenant is the
 * whole point. Without the bypass the query returns ZERO ROWS rather than
 * raising, so every request 403s with "No tenant for the supplied identifiers":
 * a total outage that presents as a data problem. The GUC is `app.bypass_rls`,
 * NOT `app.rls_bypass`.
 *
 * ⚠️ The ::text casts are MANDATORY: tenants.id is uuid and tenants.slug is
 * citext, and Prisma's raw deserializer does not return plain strings for
 * either without them.
 */
@Injectable()
export class PrismaOrgTenantResolver implements OrgTenantResolver {
  private readonly logger = new Logger(PrismaOrgTenantResolver.name);
  private readonly byOrg = new Map<string, Entry<ResolvedTenant | null>>();
  private readonly byId = new Map<string, Entry<ResolvedTenant | null>>();
  private readonly membership = new Map<string, Entry<boolean>>();

  constructor(private readonly prisma: PrismaService) {}

  async resolveByClerkOrgId(clerkOrgId: string): Promise<ResolvedTenant | null> {
    const hit = read(this.byOrg, clerkOrgId, TENANT_TTL_MS);
    if (hit !== undefined) return hit;

    let rows: TenantRow[] = [];
    try {
      rows = await this.prisma.withSystem((tx) =>
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
    const value = row
      ? { tenantId: row.id, slug: row.slug, clerkOrgId: row.clerkOrgId }
      : null;
    write(this.byOrg, clerkOrgId, value);
    return value;
  }

  async resolveByTenantId(tenantId: string): Promise<ResolvedTenant | null> {
    const hit = read(this.byId, tenantId, TENANT_TTL_MS);
    if (hit !== undefined) return hit;

    let rows: TenantRow[] = [];
    try {
      rows = await this.prisma.withSystem((tx) =>
        tx.$queryRaw<TenantRow[]>`
          SELECT id::text AS id, slug::text AS slug, clerk_org_id AS "clerkOrgId"
          FROM tenants
          WHERE id = ${tenantId}::uuid
          LIMIT 1
        `,
      );
    } catch (err) {
      // A non-UUID claim makes Postgres raise 22P02 rather than return no rows.
      // That is "no such tenant", not a 500.
      this.logger.debug(`resolveByTenantId(${tenantId}) failed: ${(err as Error).message}`);
      return null;
    }

    const row = rows[0];
    const value = row
      ? { tenantId: row.id, slug: row.slug, clerkOrgId: row.clerkOrgId }
      : null;
    write(this.byId, tenantId, value);
    return value;
  }

  async hasActiveMembership(tenantId: string, clerkUserId: string): Promise<boolean> {
    const key = `${tenantId}|${clerkUserId}`;
    const hit = read(this.membership, key, MEMBERSHIP_TTL_MS);
    if (hit !== undefined) return hit;

    try {
      const rows = await this.prisma.withSystem((tx) =>
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
      // Fail CLOSED: an infrastructure hiccup must never grant access.
      this.logger.error(`hasActiveMembership failed: ${(err as Error).message}`);
      return false;
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
