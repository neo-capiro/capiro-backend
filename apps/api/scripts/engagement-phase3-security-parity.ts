#!/usr/bin/env tsx
/**
 * Phase 3 auth / tenant / role / ownership / ethical-wall / impersonation parity.
 *
 * A fresh orgless Clerk bearer is temporarily rebound among deterministic
 * fixture users. Each actor has exactly one membership, so the production
 * TenantContextMiddleware exercises sole-membership resolution without
 * fabricated claims. Main and shadow are probed across every current primary
 * Engagement surface; identity swaps, impersonation expiry, and a temporary
 * attributed write are restored/cleaned in finally blocks.
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

interface ProbeInit {
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
}

const EVIDENCE = required('ENGAGEMENT_PHASE3_EVIDENCE_DIR');
const TOKEN_FILE = required('ENGAGEMENT_PHASE3_ADMIN_TOKEN_FILE');
const MAIN_URL = process.env.ENGAGEMENT_PHASE3_MAIN_URL ?? 'http://127.0.0.1:4000';
const SHADOW_URL = process.env.ENGAGEMENT_PHASE3_ENGAGEMENT_URL ?? 'http://127.0.0.1:4500';
const REAL_ADMIN_CLERK_ID = required('ENGAGEMENT_PHASE3_ADMIN_CLERK_USER_ID');
const IMPERSONATION_HEADER = 'x-capiro-impersonate-tenant';
const SUCCESS_STATUSES = Array.from({ length: 100 }, (_, index) => 200 + index);

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
    if (typeof row.message === 'string') {
      return row.message.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/gi, '<id>');
    }
  }
  return `http_${result.status}`;
}

function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalize);
  if (!value || typeof value !== 'object') return value;
  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (/^(requestId|traceId|time|timestamp)$/i.test(key)) continue;
    if (/^(createdAt|updatedAt|lastSeenAt|expiresAt)$/i.test(key)) {
      output[key] = '<normalized>';
      continue;
    }
    output[key] = normalize(child);
  }
  return output;
}

async function probe(
  base: string,
  pathname: string,
  token: string | null,
  init: ProbeInit = {},
): Promise<ProbeResult> {
  const requestHeaders = new Headers(init.headers);
  if (token) requestHeaders.set('Authorization', `Bearer ${token}`);
  if (init.body !== undefined) requestHeaders.set('Content-Type', 'application/json');
  const response = await fetch(`${base}${pathname}`, {
    method: init.method ?? 'GET',
    headers: requestHeaders,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    redirect: 'manual',
  });
  const text = await response.text();
  let body: unknown = text;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    // Retain the text so malformed-response parity remains diagnosable.
  }
  return {
    status: response.status,
    code:
      body &&
      typeof body === 'object' &&
      typeof (body as Record<string, unknown>).code === 'string'
        ? ((body as Record<string, unknown>).code as string)
        : null,
    service: response.headers.get('x-capiro-service'),
    body: normalize(body),
  };
}

function requireParity(
  label: string,
  main: ProbeResult,
  shadow: ProbeResult,
  allowed: readonly number[],
): void {
  if (!allowed.includes(main.status) || !allowed.includes(shadow.status)) {
    throw new Error(`${label}: unexpected status main=${main.status} shadow=${shadow.status}`);
  }
  if (main.status !== shadow.status) {
    throw new Error(`${label}: status mismatch main=${main.status} shadow=${shadow.status}`);
  }
  if (errorClass(main) !== errorClass(shadow)) {
    throw new Error(
      `${label}: class mismatch main=${errorClass(main)} shadow=${errorClass(shadow)}`,
    );
  }
  if (shadow.service !== 'engagement-api') {
    throw new Error(`${label}: shadow response missing X-Capiro-Service: engagement-api`);
  }
}

function requireSuccessParity(label: string, main: ProbeResult, shadow: ProbeResult): void {
  requireParity(label, main, shadow, SUCCESS_STATUSES);
  if (JSON.stringify(main.body) !== JSON.stringify(shadow.body)) {
    throw new Error(`${label}: successful response body mismatch`);
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
      await tx.user.update({ where: { id: actorUserId }, data: { clerkUserId: temporary } });
      await tx.user.update({ where: { id: adminUserId }, data: { clerkUserId: original.admin } });
      await tx.user.update({ where: { id: actorUserId }, data: { clerkUserId: original.actor } });
    });
  }
}

function fakeExpiredJwt(): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode({ sub: 'expired', exp: 1 })}.invalid`;
}

async function main(): Promise<void> {
  const token = (await readFile(TOKEN_FILE, 'utf8')).trim();
  if (token.length < 20) throw new Error('Phase 3 bearer token file is empty or invalid');

  const plan = buildFixturePlan();
  const users = new Map(plan.users.map((row) => [row.key, row.id]));
  const meetings = new Map(plan.meetings.map((row) => [row.key, row.id]));
  const clients = new Map(plan.clients.map((row) => [row.key, row]));
  const notes = new Map(plan.notes.map((row) => [row.key, row]));
  const impersonations = new Map(plan.impersonations.map((row) => [row.key, row.id]));

  const user = (key: string): string => {
    const value = users.get(key);
    if (!value) throw new Error(`Fixture plan missing ${key}`);
    return value;
  };
  const meeting = (key: string): string => {
    const value = meetings.get(key);
    if (!value) throw new Error(`Fixture plan missing ${key}`);
    return value;
  };
  const client = (key: string) => {
    const value = clients.get(key);
    if (!value) throw new Error(`Fixture plan missing ${key}`);
    return value;
  };
  const impersonation = (key: string): string => {
    const value = impersonations.get(key);
    if (!value) throw new Error(`Fixture plan missing ${key}`);
    return value;
  };

  const primaryTenant = plan.tenants.find((row) => row.key === 'tenant.primary');
  if (!primaryTenant) throw new Error('Fixture plan missing tenant.primary');
  const alpha = client('client.alpha');
  const meetingPast = meeting('meeting.past');
  const surfacePaths = [
    { id: 'meetings', path: `/api/engagement/meetings?clientId=${alpha.id}` },
    { id: 'outreach', path: '/api/engagement/outreach' },
    {
      id: 'reports',
      path: `/api/engagement/reports/overview?period=all&clientId=${alpha.id}`,
    },
    { id: 'integrations', path: '/api/engagement/integrations' },
    { id: 'tasks', path: `/api/engagement/tasks?clientId=${alpha.id}` },
    {
      id: 'attachments',
      path: `/api/engagement/attachments?meetingId=${meetingPast}`,
    },
  ];

  const prisma = new PrismaService();
  await prisma.$connect();
  const results: Array<Record<string, unknown>> = [];
  let impersonationTaskId = '';

  try {
    // Missing, malformed, expired, and wrong-tenant auth must deny consistently
    // on every current primary surface—not only one convenient endpoint.
    for (const authCase of [
      { label: 'missing_bearer', token: null, headers: {}, allowed: [401] },
      { label: 'invalid_bearer', token: 'invalid-token', headers: {}, allowed: [401] },
      { label: 'expired_bearer', token: fakeExpiredJwt(), headers: {}, allowed: [401] },
      {
        label: 'wrong_tenant_header',
        token,
        headers: { 'X-Capiro-Tenant': 'phase3-not-a-real-tenant' },
        allowed: [403],
      },
    ]) {
      for (const surface of surfacePaths) {
        const [mainResult, shadowResult] = await Promise.all([
          probe(MAIN_URL, surface.path, authCase.token, { headers: authCase.headers }),
          probe(SHADOW_URL, surface.path, authCase.token, { headers: authCase.headers }),
        ]);
        requireParity(
          `${authCase.label}:${surface.id}`,
          mainResult,
          shadowResult,
          authCase.allowed,
        );
        results.push({
          label: authCase.label,
          surface: surface.id,
          status: mainResult.status,
          errorClass: errorClass(mainResult),
        });
      }
    }

    const adminUserId = user('actor.admin');

    // Positive admin parity across all primary surfaces.
    for (const surface of surfacePaths) {
      const [mainResult, shadowResult] = await Promise.all([
        probe(MAIN_URL, surface.path, token),
        probe(SHADOW_URL, surface.path, token),
      ]);
      requireSuccessParity(`admin:${surface.id}`, mainResult, shadowResult);
      results.push({ label: 'admin_allowed', surface: surface.id, status: mainResult.status });
    }

    // A normal standard user can reach ordinary tenant data.
    await asFixtureActor(prisma, adminUserId, user('actor.standard'), async () => {
      for (const surface of surfacePaths) {
        const [mainResult, shadowResult] = await Promise.all([
          probe(MAIN_URL, surface.path, token),
          probe(SHADOW_URL, surface.path, token),
        ]);
        requireSuccessParity(`standard:${surface.id}`, mainResult, shadowResult);
        results.push({ label: 'standard_allowed', surface: surface.id, status: mainResult.status });
      }
    });

    // The client-portal actor is below the controller's standard_user floor.
    await asFixtureActor(prisma, adminUserId, user('actor.belowRole'), async () => {
      for (const surface of surfacePaths) {
        const [mainResult, shadowResult] = await Promise.all([
          probe(MAIN_URL, surface.path, token),
          probe(SHADOW_URL, surface.path, token),
        ]);
        requireParity(`below_required_role:${surface.id}`, mainResult, shadowResult, [403]);
        results.push({
          label: 'below_required_role',
          surface: surface.id,
          status: mainResult.status,
          errorClass: errorClass(mainResult),
        });
      }
    });

    // Unknown role values are rejected by the database enum; neither runtime can
    // coerce one into a privileged/default role.
    let unknownRoleRejected = false;
    try {
      await prisma.$executeRawUnsafe(
        `UPDATE tenant_memberships SET role = 'phase3_unrecognized_role' ` +
          `WHERE user_id = '${user('actor.belowRole')}'::uuid`,
      );
    } catch (error) {
      if (!/invalid input value for enum|check constraint/i.test(String(error))) throw error;
      unknownRoleRejected = true;
    }
    if (!unknownRoleRejected) {
      throw new Error('Database accepted an unrecognized tenant role during Phase 3 security');
    }
    results.push({ label: 'unrecognized_role', result: 'database_rejected_unknown_role' });

    // Cross-tenant records must resolve to the same nonleaking denial.
    const crossTenantPath = `/api/engagement/meetings/${meeting('meeting.otherTenant')}`;
    {
      const [mainResult, shadowResult] = await Promise.all([
        probe(MAIN_URL, crossTenantPath, token),
        probe(SHADOW_URL, crossTenantPath, token),
      ]);
      requireParity('cross_tenant_record', mainResult, shadowResult, [403, 404]);
      const serialized = JSON.stringify([mainResult.body, shadowResult.body]);
      if (serialized.includes('Second-tenant meeting')) {
        throw new Error('cross_tenant_record leaked protected content');
      }
      results.push({
        label: 'cross_tenant_record',
        status: mainResult.status,
        errorClass: errorClass(mainResult),
      });
    }

    // The standard user DOES have a wall grant for this client, so the meeting
    // itself remains visible. Only the peer-authored admin/author-only note is a
    // restricted shell with no body. This separates ownership from walling.
    await asFixtureActor(prisma, adminUserId, user('actor.standard'), async () => {
      const notesPath = `/api/engagement/meetings/${meeting(
        'meeting.confidentialDenied',
      )}/notes`;
      const [mainResult, shadowResult] = await Promise.all([
        probe(MAIN_URL, notesPath, token),
        probe(SHADOW_URL, notesPath, token),
      ]);
      requireSuccessParity('cross_user_confidential_note', mainResult, shadowResult);
      const noteFixture = notes.get('note.peerConfidential');
      if (!noteFixture) throw new Error('Fixture plan missing note.peerConfidential');
      const noteRows = Array.isArray(mainResult.body)
        ? (mainResult.body as Record<string, unknown>[])
        : [];
      const peer = noteRows.find((row) => row.id === noteFixture.id);
      if (!peer || peer.restricted !== true || peer.body != null) {
        throw new Error('Peer confidential note was not returned as a restricted shell');
      }
      if (JSON.stringify([mainResult.body, shadowResult.body]).includes(noteFixture.bodyPlaintext)) {
        throw new Error('cross_user_confidential_note leaked the encrypted note body');
      }
      results.push({
        label: 'cross_user_confidential_note',
        status: mainResult.status,
        restricted: true,
      });
    });

    // The wall-denied actor has no grant at all. Use client context so private
    // record ownership cannot be an alternative explanation for the denial.
    await asFixtureActor(prisma, adminUserId, user('actor.wallDenied'), async () => {
      const walled = client('client.walled');
      const wallPath = `/api/engagement/context/${walled.id}`;
      const [mainResult, shadowResult] = await Promise.all([
        probe(MAIN_URL, wallPath, token),
        probe(SHADOW_URL, wallPath, token),
      ]);
      requireParity('ethical_wall_denied', mainResult, shadowResult, [403, 404]);
      const serialized = JSON.stringify([mainResult.body, shadowResult.body]);
      if (serialized.includes(walled.name) || serialized.includes('another user')) {
        throw new Error('ethical_wall_denied leaked walled-client content');
      }
      results.push({
        label: 'ethical_wall_denied',
        status: mainResult.status,
        errorClass: errorClass(mainResult),
      });
    });

    // Real Capiro Admin impersonation. The orgless token resolves the actor's
    // sole internal membership, then the active fixture session and header swap
    // tenant context to the primary fixture tenant.
    await asFixtureActor(prisma, adminUserId, user('actor.capiroAdmin'), async () => {
      const impersonationHeaders = { [IMPERSONATION_HEADER]: primaryTenant.slug };
      const [activeMain, activeShadow] = await Promise.all([
        probe(MAIN_URL, '/api/engagement/meetings', token, { headers: impersonationHeaders }),
        probe(SHADOW_URL, '/api/engagement/meetings', token, { headers: impersonationHeaders }),
      ]);
      requireSuccessParity('impersonation_active', activeMain, activeShadow);
      results.push({ label: 'impersonation_active', status: activeMain.status });

      // A temporary write proves target tenant and real actor attribution. Read
      // it through shadow under the same impersonation context before cleanup.
      const taskTitle = '[PHASE3_PARITY_FIXTURE] impersonation attribution';
      const createdTask = await probe(MAIN_URL, '/api/engagement/tasks', token, {
        method: 'POST',
        headers: impersonationHeaders,
        body: { clientId: alpha.id, title: taskTitle },
      });
      if (!SUCCESS_STATUSES.includes(createdTask.status)) {
        throw new Error(`Impersonated task create failed with ${createdTask.status}`);
      }
      impersonationTaskId =
        createdTask.body &&
        typeof createdTask.body === 'object' &&
        typeof (createdTask.body as Record<string, unknown>).id === 'string'
          ? ((createdTask.body as Record<string, unknown>).id as string)
          : '';
      if (!impersonationTaskId) throw new Error('Impersonated task create returned no id');

      const attribution = await prisma.withSystem((tx) =>
        tx.engagementTask.findUnique({
          where: { id: impersonationTaskId },
          select: { tenantId: true, createdByUserId: true, title: true },
        }),
      );
      if (attribution?.tenantId !== primaryTenant.id) {
        throw new Error('Impersonated task was not written in the target tenant');
      }
      if (attribution.createdByUserId !== user('actor.capiroAdmin')) {
        throw new Error('Impersonated task was not attributed to the Capiro Admin actor');
      }
      if (attribution.title !== taskTitle) {
        throw new Error('Impersonated task attribution probe read the wrong row');
      }

      const [taskMain, taskShadow] = await Promise.all([
        probe(
          MAIN_URL,
          `/api/engagement/tasks?clientId=${encodeURIComponent(alpha.id)}`,
          token,
          { headers: impersonationHeaders },
        ),
        probe(
          SHADOW_URL,
          `/api/engagement/tasks?clientId=${encodeURIComponent(alpha.id)}`,
          token,
          { headers: impersonationHeaders },
        ),
      ]);
      requireSuccessParity('impersonation_write_read', taskMain, taskShadow);
      const taskRows = Array.isArray(taskMain.body)
        ? (taskMain.body as Record<string, unknown>[])
        : [];
      if (!taskRows.some((row) => row.id === impersonationTaskId && row.title === taskTitle)) {
        throw new Error('Impersonated task was not readable consistently through both runtimes');
      }
      results.push({
        label: 'impersonation_write_attribution',
        tenantId: attribution.tenantId,
        actorUserId: attribution.createdByUserId,
      });

      // Expire the same session, require the same 403 and nonleaking class from
      // both runtimes, then restore the exact fixture state.
      const sessionId = impersonation('impersonation.active');
      const sessionBefore = await prisma.withSystem((tx) =>
        tx.impersonationSession.findUnique({
          where: { id: sessionId },
          select: { expiresAt: true, endedAt: true, endedReason: true },
        }),
      );
      if (!sessionBefore) throw new Error('Active impersonation fixture was not found');
      try {
        await prisma.withSystem((tx) =>
          tx.impersonationSession.update({
            where: { id: sessionId },
            data: { expiresAt: new Date(Date.now() - 60_000) },
          }),
        );
        const [expiredMain, expiredShadow] = await Promise.all([
          probe(MAIN_URL, '/api/engagement/meetings', token, { headers: impersonationHeaders }),
          probe(SHADOW_URL, '/api/engagement/meetings', token, { headers: impersonationHeaders }),
        ]);
        requireParity('impersonation_expired', expiredMain, expiredShadow, [403]);
        if (!/No active impersonation session/i.test(JSON.stringify(expiredMain.body))) {
          throw new Error('Expired impersonation returned the wrong nonleaking denial class');
        }
        results.push({
          label: 'impersonation_expired',
          status: expiredMain.status,
          errorClass: errorClass(expiredMain),
        });
      } finally {
        await prisma.withSystem((tx) =>
          tx.impersonationSession.update({
            where: { id: sessionId },
            data: {
              expiresAt: sessionBefore.expiresAt,
              endedAt: sessionBefore.endedAt,
              endedReason: sessionBefore.endedReason,
            },
          }),
        );
      }
    });

    const restored = await prisma.withSystem((tx) =>
      tx.user.findUnique({ where: { id: adminUserId }, select: { clerkUserId: true } }),
    );
    if (restored?.clerkUserId !== REAL_ADMIN_CLERK_ID) {
      throw new Error('Phase 3 security actor swap did not restore the admin Clerk identity');
    }

    if (impersonationTaskId) {
      await prisma.withSystem((tx) =>
        tx.engagementTask.deleteMany({ where: { id: impersonationTaskId } }),
      );
      const residual = await prisma.withSystem((tx) =>
        tx.engagementTask.count({ where: { id: impersonationTaskId } }),
      );
      if (residual !== 0) throw new Error('Impersonation attribution task cleanup failed');
      impersonationTaskId = '';
    }

    await writeFile(
      path.join(EVIDENCE, 'security-parity.json'),
      `${JSON.stringify(
        {
          marker: 'ENGAGEMENT_PHASE3_SECURITY_PARITY_COMPLETE',
          cases: results.length,
          surfaces: surfacePaths.map((row) => row.id),
          realAdminIdentityRestored: true,
          orglessSoleMembershipToken: true,
          activeAndExpiredImpersonation: true,
          impersonationWriteAttribution: true,
          ethicalWallProbe: 'GET /api/engagement/context/:clientId',
          confidentialNoteProbe: 'GET /api/engagement/meetings/:id/notes',
          results,
        },
        null,
        2,
      )}\n`,
    );
    console.log(`ENGAGEMENT_PHASE3_SECURITY_PARITY_COMPLETE cases=${results.length}`);
  } finally {
    if (impersonationTaskId) {
      await prisma
        .withSystem((tx) => tx.engagementTask.deleteMany({ where: { id: impersonationTaskId } }))
        .catch(() => undefined);
    }
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  void main().catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exit(1);
  });
}
