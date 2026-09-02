import { Injectable, Logger } from '@nestjs/common';
import type { OrgTenantResolver, ResolvedTenant } from '@capiro/auth';
import { Prisma } from '../../generated/prisma-client/index.js';
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
 * Canonical org->tenant + active-membership lookup for workspace.
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

    let rows: TenantRow[];
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
      // clerk_org_id is a plain text compare — there is no expected-input
      // error case here (unlike resolveByTenantId's ::uuid cast below). Any
      // failure is a genuine infrastructure problem (e.g. a saturated
      // connection pool) and must surface as a 500, never be reported as
      // "tenant not found": silently returning null here previously let a
      // transient DB outage masquerade as every tenant being unresolvable.
      this.logger.error(`resolveByClerkOrgId failed: ${(err as Error).message}`);
      throw err;
    }

    const row = rows[0];
    const value = row ? { tenantId: row.id, slug: row.slug, clerkOrgId: row.clerkOrgId } : null;
    write(this.byOrg, clerkOrgId, value);
    return value;
  }

  async resolveByTenantId(tenantId: string): Promise<ResolvedTenant | null> {
    const hit = read(this.byId, tenantId, TENANT_TTL_MS);
    if (hit !== undefined) return hit;

    let rows: TenantRow[];
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
      // A non-UUID claim makes Postgres raise 22P02 (invalid_text_representation)
      // on the ::uuid cast rather than return no rows — that specific case
      // really is "no such tenant". Everything else (a connection-pool timeout
      // under load, most notably) is an infrastructure failure, not a
      // resolution result, and must be rethrown rather than reported as a
      // false 403: a saturated Aurora Serverless connection pool once made
      // this look like a permanently broken tenant mapping when it was
      // actually transient load.
      if (isInvalidUuidLiteral(err)) {
        this.logger.debug(`resolveByTenantId(${tenantId}): not a valid tenant id`);
        return null;
      }
      this.logger.error(`resolveByTenantId(${tenantId}) failed: ${(err as Error).message}`);
      throw err;
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

/**
 * True only for the specific, expected "not a UUID" failure of the
 * `id = $1::uuid` cast (Postgres SQLSTATE 22P02). Prisma wraps a raw-query DB
 * error as PrismaClientKnownRequestError code 'P2010' with the underlying
 * Postgres SQLSTATE at `.meta.code` (same convention documented in
 * apps/intel-api's source-data.repository.ts) — check both the code and the
 * message, since a driver/version difference could put the SQLSTATE in only
 * one place.
 */
function isInvalidUuidLiteral(err: unknown): boolean {
  if (!(err instanceof Prisma.PrismaClientKnownRequestError) || err.code !== 'P2010') {
    return false;
  }
  const meta = err.meta as { code?: unknown; message?: unknown } | undefined;
  if (meta?.code === '22P02') return true;
  const message = typeof meta?.message === 'string' ? meta.message : err.message;
  return /invalid input syntax for type uuid/i.test(message);
}
