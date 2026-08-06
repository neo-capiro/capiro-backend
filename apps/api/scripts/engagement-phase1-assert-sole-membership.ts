#!/usr/bin/env tsx
/**
 * Precondition for the orgless Phase 1 browser proof.
 *
 * The orgless path relies on the existing TenantContextMiddleware sole-membership fallback,
 * which fires only when the authenticated user has exactly one active tenant membership and
 * no tenant id, org id, tenant slug, or X-Capiro-Tenant hint was supplied. Assert that shape
 * before the browser runs, so a fixture with zero or several active memberships fails loudly
 * instead of quietly changing which tenant the proof exercises.
 *
 * Reads only. Requires no `tenants.clerk_org_id` value and changes no Clerk configuration.
 */
import { PrismaService } from '../src/prisma/prisma.service.js';
import {
  assertSoleActiveMembership,
  type ActiveMembershipRow,
} from '../src/engagement/runtime/engagement-phase1-sole-membership.js';

function requiredAny(...names: string[]): string {
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (value) return value;
  }
  throw new Error(`One of ${names.join(', ')} is required`);
}

const CLERK_USER_ID = requiredAny(
  'ENGAGEMENT_PHASE1_USER_CLERK_ID',
  'ENGAGEMENT_PHASE0_USER_CLERK_ID',
);

interface MembershipRow {
  tenant_id: string;
  slug: string;
  clerk_org_id: string | null;
  role: string;
}

async function main(): Promise<void> {
  const prisma = new PrismaService();
  await prisma.$connect();
  try {
    const rows = await prisma.$queryRawUnsafe<MembershipRow[]>(
      `SELECT tm.tenant_id, t.slug, t.clerk_org_id, tm.role
         FROM tenant_memberships tm
         JOIN users u ON u.id = tm.user_id
         JOIN tenants t ON t.id = tm.tenant_id
        WHERE u.clerk_user_id = $1
          AND tm.status = 'active'
        ORDER BY t.slug`,
      CLERK_USER_ID,
    );

    const normalized: ActiveMembershipRow[] = rows.map((row) => ({
      tenantId: row.tenant_id,
      slug: row.slug,
      clerkOrgId: row.clerk_org_id,
      role: row.role,
    }));
    // Deliberately does not require clerk_org_id: the fallback is reached without it.
    const result = assertSoleActiveMembership(normalized);
    console.log(
      JSON.stringify({ marker: 'ENGAGEMENT_PHASE1_SOLE_MEMBERSHIP_OK', ...result }),
    );
  } finally {
    await prisma.$disconnect().catch(() => undefined);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exit(1);
});
