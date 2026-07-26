import { Injectable, Logger } from '@nestjs/common';
import type { OrgTenantResolver, ResolvedTenant } from '@capiro/auth';
import { PrismaService } from '../prisma/prisma.service.js';

/** Short TTL. This is the revocation-latency budget for
 *  hasActiveMembership — a user removed in Capiro keeps access for at most
 *  this long — so it is deliberately much shorter than the tenant cache. */
const MEMBERSHIP_TTL_MS = 30_000;
/** Tenant rows change rarely; 60s is ample and keeps a re-pointed Clerk org
 *  from being stale for long. */
const TENANT_TTL_MS = 60_000;
/** Hard cap so the cache cannot grow without bound. */
const MAX_ENTRIES = 500;

interface Entry<T> {
  value: T;
  at: number;
}

/**
 * onboard-api's OrgTenantResolver.
 *
 * This is the REFERENCE implementation: onboard-api is the only consumer whose
 * generated Prisma client actually has a typed `Tenant` model (its schema
 * mirrors Tenant/User/TenantMembership from apps/api), so the other services
 * use raw SQL instead.
 *
 * ⚠️ withSystem is MANDATORY, not stylistic. `tenants` has FORCE ROW LEVEL
 * SECURITY with the policy `USING (rls_bypass() OR id = current_tenant_id())`,
 * and at this point in the request there is no tenant GUC set — the whole
 * point is that we are still deciding which tenant this is. A bare
 * `this.prisma.tenant.findUnique(...)` returns NULL rather than raising, so
 * every request would 403 with "No tenant for the supplied identifiers": a
 * total outage that looks like a data problem. withSystem sets `app.bypass_rls`
 * (note: that GUC, NOT `app.rls_bypass`).
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

    const row = await this.prisma.withSystem((tx) =>
      tx.tenant.findUnique({
        where: { clerkOrgId },
        select: { id: true, slug: true, clerkOrgId: true },
      }),
    );
    const value = row ? { tenantId: row.id, slug: row.slug, clerkOrgId: row.clerkOrgId } : null;
    write(this.byOrg, clerkOrgId, value);
    return value;
  }

  async resolveByTenantId(tenantId: string): Promise<ResolvedTenant | null> {
    const hit = read(this.byId, tenantId, TENANT_TTL_MS);
    if (hit !== undefined) return hit;

    // A malformed (non-UUID) claim makes Postgres raise 22P02 rather than
    // return no rows. Treat that as "no such tenant", not a 500.
    let row: { id: string; slug: string; clerkOrgId: string | null } | null = null;
    try {
      row = await this.prisma.withSystem((tx) =>
        tx.tenant.findUnique({
          where: { id: tenantId },
          select: { id: true, slug: true, clerkOrgId: true },
        }),
      );
    } catch (err) {
      this.logger.debug(`resolveByTenantId(${tenantId}) failed: ${(err as Error).message}`);
      return null;
    }
    const value = row ? { tenantId: row.id, slug: row.slug, clerkOrgId: row.clerkOrgId } : null;
    write(this.byId, tenantId, value);
    return value;
  }

  async hasActiveMembership(tenantId: string, clerkUserId: string): Promise<boolean> {
    const key = `${tenantId}|${clerkUserId}`;
    const hit = read(this.membership, key, MEMBERSHIP_TTL_MS);
    if (hit !== undefined) return hit;

    try {
      // Two-step, not a relation filter: onboard-api's TenantMembership is a
      // FLAT read-only mirror of the apps/api table and declares no `user`
      // relation. Mirrors the lookup in billing-actor.guard.ts.
      const value = await this.prisma.withSystem(async (tx) => {
        const user = await tx.user.findUnique({
          where: { clerkUserId },
          select: { id: true },
        });
        if (!user) return false;
        const row = await tx.tenantMembership.findUnique({
          where: { tenantId_userId: { tenantId, userId: user.id } },
          select: { status: true },
        });
        return row?.status === 'active';
      });
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
  // Bounded, unlike the pre-existing TenantResolverService cache which grows
  // forever and never invalidates.
  if (map.size >= MAX_ENTRIES) map.clear();
  map.set(key, { value, at: Date.now() });
}
