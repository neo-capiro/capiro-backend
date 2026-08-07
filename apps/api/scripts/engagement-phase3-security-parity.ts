#!/usr/bin/env tsx
/**
 * Phase 3 auth / tenant / role / ownership / ethical-wall parity.
 *
 * One real dedicated Clerk bearer is enough. The disposable fixture database
 * temporarily rebinds that Clerk identity to deterministic actor rows for the
 * below-role / standard / wall-denied probes, then restores the original value
 * in a finally block. No Clerk configuration or external identity is mutated.
 */
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { buildFixturePlan } from './engagement-phase3-fixture-plan.js';

interface ProbeResult {
  status: number;
  code: string | null;
  service: string | null;
  body: unknown;
}

const EVIDENCE = required('ENGAGEMENT_PHASE3_EVIDENCE_DIR');
const TOKEN_FILE = required('ENGAGEMENT_PHASE3_ADMIN_TOKEN_FILE');
const MAIN_URL = process.env.ENGAGEMENT_PHASE3_MAIN_URL ?? 'http://127.0.0.1:4000';
const SHADOW_URL = process.env.ENGAGEMENT_PHASE3_ENGAGEMENT_URL ?? 'http://127.0.0.1:4500';
const REAL_ADMIN_CLERK_ID = required('ENGAGEMENT_PHASE3_ADMIN_CLERK_USER_ID');

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function errorClass(result: ProbeResult): string {
  if (result.body && typeof result.body === 'object') {
    const row = result.body as Record<string, unknown>;
    if (typeof row.code === 'string') return row.code;
    if (typeof row.error === 'string') return row.error;
    if (typeof row.message === 'string') return row.message.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/gi, '<id>');
  }
  return `http_${result.status}`;
}

async function probe(
  base: string,
  pathname: string,
  token: string | null,
  headers: Record<string, string> = {},
): Promise<ProbeResult> {
  const requestHeaders = new Headers(headers);
  if (token) requestHeaders.set('Authorization', `Bearer ${token}`);
  const response = await fetch(`${base}${pathname}`, { headers: requestHeaders, redirect: 'manual' });
  const text = await response.text();
  let body: unknown = text;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    // retain text
  }
  return {
    status: response.status,
    code:
      body && typeof body === 'object' && typeof (body as Record<string, unknown>).code === 'string'
        ? ((body as Record<string, unknown>).code as string)
        : null,
    service: response.headers.get('x-capiro-service'),
    body,
  };
}

function requireParity(label: string, main: ProbeResult, shadow: ProbeResult, allowed: number[]): void {
  if (!allowed.includes(main.status) || !allowed.includes(shadow.status)) {
    throw new Error(`${label}: unexpected denial status main=${main.status} shadow=${shadow.status}`);
  }
  if (main.status !== shadow.status) {
    throw new Error(`${label}: status mismatch main=${main.status} shadow=${shadow.status}`);
  }
  if (errorClass(main) !== errorClass(shadow)) {
    throw new Error(`${label}: denial class mismatch main=${errorClass(main)} shadow=${errorClass(shadow)}`);
  }
  if (shadow.service !== 'engagement-api') {
    throw new Error(`${label}: shadow response missing X-Capiro-Service: engagement-api`);
  }
}

async function asFixtureActor<T>(
  prisma: PrismaService,
  adminUserId: string,
  actorUserId: string,
  callback: () => Promise<T>,
): Promise<T> {
  if (adminUserId === actorUserId) return callback();
  const original = await prisma.withSystem(async (tx) => {
    const [admin, actor] = await Promise.all([
      tx.user.findUnique({ where: { id: adminUserId }, select: { clerkUserId: true } }),
      tx.user.findUnique({ where: { id: actorUserId }, select: { clerkUserId: true } }),
    ]);
    if (!admin || !actor) throw new Error('Phase 3 security fixture user missing');
    const temporary = `phase3-temp-${process.pid}-${Date.now()}-${actorUserId.slice(-6)}`;
    await tx.user.update({ where: { id: adminUserId }, data: { clerkUserId: temporary } });
    await tx.user.update({ where: { id: actorUserId }, data: { clerkUserId: REAL_ADMIN_CLERK_ID } });
    return { admin: admin.clerkUserId, actor: actor.clerkUserId };
  });

  try {
    return await callback();
  } finally {
    await prisma.withSystem(async (tx) => {
      const temporary = `phase3-restore-${process.pid}-${Date.now()}-${actorUserId.slice(-6)}`;
      // Move the real id off the actor first to satisfy the unique constraint.
      await tx.user.update({ where: { id: actorUserId }, data: { clerkUserId: temporary } });
      await tx.user.update({ where: { id: adminUserId }, data: { clerkUserId: original.admin } });
      await tx.user.update({ where: { id: actorUserId }, data: { clerkUserId: original.actor } });
    });
  }
}

async function main(): Promise<void> {
  const token = (await readFile(TOKEN_FILE, 'utf8')).trim();
  if (token.length < 20) throw new Error('Phase 3 bearer token file is empty or invalid');
  const plan = buildFixturePlan();
  const users = new Map(plan.users.map((row) => [row.key, row.id]));
  const meetings = new Map(plan.meetings.map((row) => [row.key, row.id]));
  const notes = new Map(plan.notes.map((row) => [row.key, row]));
  const user = (key: string) => {
    const value = users.get(key);
    if (!value) throw new Error(`Fixture plan missing ${key}`);
    return value;
  };
  const meeting = (key: string) => {
    const value = meetings.get(key);
    if (!value) throw new Error(`Fixture plan missing ${key}`);
    return value;
  };

  const prisma = new PrismaService();
  await prisma.$connect();
  const results: Array<Record<string, unknown>> = [];
  try {
    const basePath = '/api/engagement/meetings';
    for (const authCase of [
      { label: 'missing_bearer', token: null, headers: {}, allowed: [401] },
      { label: 'invalid_bearer', token: 'invalid-token', headers: {}, allowed: [401] },
      {
        label: 'wrong_tenant_header',
        token,
        headers: { 'X-Capiro-Tenant': 'phase3-not-a-real-tenant' },
        allowed: [403],
      },
    ]) {
      const mainResult = await probe(MAIN_URL, basePath, authCase.token, authCase.headers);
      const shadowResult = await probe(SHADOW_URL, basePath, authCase.token, authCase.headers);
      requireParity(authCase.label, mainResult, shadowResult, authCase.allowed);
      results.push({ label: authCase.label, status: mainResult.status, errorClass: errorClass(mainResult) });
    }

    const adminUserId = user('actor.admin');

    await asFixtureActor(prisma, adminUserId, user('actor.belowRole'), async () => {
      const mainResult = await probe(MAIN_URL, basePath, token);
      const shadowResult = await probe(SHADOW_URL, basePath, token);
      requireParity('below_required_role', mainResult, shadowResult, [403]);
      results.push({ label: 'below_required_role', status: mainResult.status, errorClass: errorClass(mainResult) });
    });

    const crossTenantPath = `/api/engagement/meetings/${meeting('meeting.otherTenant')}`;
    {
      const mainResult = await probe(MAIN_URL, crossTenantPath, token);
      const shadowResult = await probe(SHADOW_URL, crossTenantPath, token);
      requireParity('cross_tenant_record', mainResult, shadowResult, [403, 404]);
      const serialized = JSON.stringify([mainResult.body, shadowResult.body]);
      if (serialized.includes('Second-tenant meeting')) throw new Error('cross_tenant_record leaked protected content');
      results.push({ label: 'cross_tenant_record', status: mainResult.status, errorClass: errorClass(mainResult) });
    }

    await asFixtureActor(prisma, adminUserId, user('actor.standard'), async () => {
      const privatePath = `/api/engagement/meetings/${meeting('meeting.confidentialDenied')}`;
      const mainResult = await probe(MAIN_URL, privatePath, token);
      const shadowResult = await probe(SHADOW_URL, privatePath, token);
      requireParity('cross_user_private_record', mainResult, shadowResult, [403, 404]);
      const marker = notes.get('note.peerConfidential')?.bodyPlaintext ?? 'another user';
      if (JSON.stringify([mainResult.body, shadowResult.body]).includes(marker)) {
        throw new Error('cross_user_private_record leaked confidential note body');
      }
      results.push({ label: 'cross_user_private_record', status: mainResult.status, errorClass: errorClass(mainResult) });
    });

    await asFixtureActor(prisma, adminUserId, user('actor.wallDenied'), async () => {
      const wallPath = `/api/engagement/meetings/${meeting('meeting.confidentialDenied')}`;
      const mainResult = await probe(MAIN_URL, wallPath, token);
      const shadowResult = await probe(SHADOW_URL, wallPath, token);
      requireParity('ethical_wall_denied', mainResult, shadowResult, [403, 404]);
      const marker = notes.get('note.peerConfidential')?.bodyPlaintext ?? 'another user';
      if (JSON.stringify([mainResult.body, shadowResult.body]).includes(marker)) {
        throw new Error('ethical_wall_denied leaked confidential note body');
      }
      results.push({ label: 'ethical_wall_denied', status: mainResult.status, errorClass: errorClass(mainResult) });
    });

    // The real admin identity must have been restored after every temporary actor probe.
    const restored = await prisma.withSystem((tx) =>
      tx.user.findUnique({ where: { id: adminUserId }, select: { clerkUserId: true } }),
    );
    if (restored?.clerkUserId !== REAL_ADMIN_CLERK_ID) {
      throw new Error('Phase 3 security actor swap did not restore the admin Clerk identity');
    }

    await writeFile(
      path.join(EVIDENCE, 'security-parity.json'),
      `${JSON.stringify(
        {
          marker: 'ENGAGEMENT_PHASE3_SECURITY_PARITY_COMPLETE',
          cases: results.length,
          realAdminIdentityRestored: true,
          results,
        },
        null,
        2,
      )}\n`,
    );
    console.log(`ENGAGEMENT_PHASE3_SECURITY_PARITY_COMPLETE cases=${results.length}`);
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  void main().catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exit(1);
  });
}
