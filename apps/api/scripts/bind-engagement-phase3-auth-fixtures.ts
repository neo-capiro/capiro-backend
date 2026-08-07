#!/usr/bin/env tsx
/**
 * Runtime-only auth binding for the deterministic Phase 3 parity fixtures.
 *
 * The committed fixture contract deliberately uses synthetic Clerk identifiers
 * so it stays portable and byte-stable. Browser acceptance, however, must use
 * real dedicated test actors. This script rewires only the Clerk identity
 * columns after the fixture seed has been applied; fixture ids, roles, tenant
 * membership, content, and every parity state remain unchanged.
 *
 * Required:
 *   ENGAGEMENT_PHASE3_ADMIN_CLERK_USER_ID
 *
 * Optional additional actors:
 *   ENGAGEMENT_PHASE3_STANDARD_CLERK_USER_ID
 *   ENGAGEMENT_PHASE3_BELOW_ROLE_CLERK_USER_ID
 *   ENGAGEMENT_PHASE3_PEER_CLERK_USER_ID
 *   ENGAGEMENT_PHASE3_WALL_DENIED_CLERK_USER_ID
 *   ENGAGEMENT_PHASE3_CROSS_TENANT_CLERK_USER_ID
 *   ENGAGEMENT_PHASE3_CAPIRO_ADMIN_CLERK_USER_ID
 *   ENGAGEMENT_PHASE3_PRIMARY_CLERK_ORG_ID
 *   ENGAGEMENT_PHASE3_SECONDARY_CLERK_ORG_ID
 *   ENGAGEMENT_PHASE3_CAPIRO_INTERNAL_CLERK_ORG_ID
 *
 * Refuses a non-loopback database unless the same explicit acknowledgement as
 * the fixture seed is present. No auth token, cookie, or secret is read or
 * printed; only opaque Clerk ids are written to the disposable fixture rows.
 */

import { PrismaService } from '../src/prisma/prisma.service.js';
import { buildFixturePlan } from './engagement-phase3-fixture-plan.js';

const REMOTE_DB_ACK = 'i-understand-this-is-not-a-disposable-database';

const USER_BINDINGS: ReadonlyArray<[string, string]> = [
  ['actor.admin', 'ENGAGEMENT_PHASE3_ADMIN_CLERK_USER_ID'],
  ['actor.standard', 'ENGAGEMENT_PHASE3_STANDARD_CLERK_USER_ID'],
  ['actor.belowRole', 'ENGAGEMENT_PHASE3_BELOW_ROLE_CLERK_USER_ID'],
  ['actor.peer', 'ENGAGEMENT_PHASE3_PEER_CLERK_USER_ID'],
  ['actor.wallDenied', 'ENGAGEMENT_PHASE3_WALL_DENIED_CLERK_USER_ID'],
  ['actor.crossTenant', 'ENGAGEMENT_PHASE3_CROSS_TENANT_CLERK_USER_ID'],
  ['actor.capiroAdmin', 'ENGAGEMENT_PHASE3_CAPIRO_ADMIN_CLERK_USER_ID'],
];

const TENANT_BINDINGS: ReadonlyArray<[string, string]> = [
  ['tenant.primary', 'ENGAGEMENT_PHASE3_PRIMARY_CLERK_ORG_ID'],
  ['tenant.secondary', 'ENGAGEMENT_PHASE3_SECONDARY_CLERK_ORG_ID'],
  ['tenant.capiroInternal', 'ENGAGEMENT_PHASE3_CAPIRO_INTERNAL_CLERK_ORG_ID'],
];

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function optional(name: string): string | null {
  const value = process.env[name]?.trim();
  return value || null;
}

function assertDisposableDatabase(): void {
  const raw = required('DATABASE_URL');
  let host = '';
  try {
    host = new URL(raw).hostname;
  } catch {
    throw new Error('DATABASE_URL is not a parseable URL.');
  }
  const loopback = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(host);
  if (loopback) return;
  if (process.env.ENGAGEMENT_PHASE3_ALLOW_REMOTE_DB?.trim() === REMOTE_DB_ACK) return;
  throw new Error(
    `Refusing to bind Phase 3 fixture auth on non-loopback host "${host}". ` +
      `Set ENGAGEMENT_PHASE3_ALLOW_REMOTE_DB=${REMOTE_DB_ACK} only for a disposable database.`,
  );
}

async function main(): Promise<void> {
  assertDisposableDatabase();
  required('ENGAGEMENT_PHASE3_ADMIN_CLERK_USER_ID');

  const plan = buildFixturePlan();
  const users = new Map(plan.users.map((row) => [row.key, row]));
  const tenants = new Map(plan.tenants.map((row) => [row.key, row]));
  const prisma = new PrismaService();
  await prisma.$connect();

  let userCount = 0;
  let tenantCount = 0;
  try {
    await prisma.withSystem(async (tx) => {
      for (const [key, envName] of USER_BINDINGS) {
        const value = optional(envName);
        if (!value) continue;
        const row = users.get(key);
        if (!row) throw new Error(`Fixture plan is missing ${key}.`);
        const result = await tx.user.updateMany({
          where: { id: row.id },
          data: { clerkUserId: value },
        });
        if (result.count !== 1) throw new Error(`Expected exactly one fixture user for ${key}; got ${result.count}.`);
        userCount += 1;
      }

      for (const [key, envName] of TENANT_BINDINGS) {
        const value = optional(envName);
        if (!value) continue;
        const row = tenants.get(key);
        if (!row) throw new Error(`Fixture plan is missing ${key}.`);
        const result = await tx.tenant.updateMany({
          where: { id: row.id },
          data: { clerkOrgId: value },
        });
        if (result.count !== 1) throw new Error(`Expected exactly one fixture tenant for ${key}; got ${result.count}.`);
        tenantCount += 1;
      }
    });
  } finally {
    await prisma.$disconnect();
  }

  console.log(`ENGAGEMENT_PHASE3_AUTH_FIXTURES_BOUND users=${userCount} tenants=${tenantCount}`);
}

if (require.main === module) {
  void main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
