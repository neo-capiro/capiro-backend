#!/usr/bin/env tsx
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROLE_RANK } from '@capiro/shared';
import { PrismaService } from '../src/prisma/prisma.service.js';
import {
  registryEntries,
  runtimePolicyForHandler,
} from '../src/engagement/runtime/engagement-runtime-route-policy.js';

interface RouteEntry {
  method: string;
  path: string;
  controller: string;
  handler: string;
  classification: string;
}

interface Fixtures {
  tenantId: string;
  userId: string;
  clientIds: string[];
  meetingIds: Record<string, string>;
  outreachIds: Record<string, string>;
  audienceIds: Record<string, string>;
  campaignId: string;
  taskId: string;
}

interface ProbeResult {
  status: number;
  contentType: string;
  serviceHeader: string;
  body: unknown;
}

interface TableDigest {
  count: number;
  digest: string;
}

const MAIN_URL = required('ENGAGEMENT_PHASE1_MAIN_URL');
const ENGAGEMENT_URL = required('ENGAGEMENT_PHASE1_ENGAGEMENT_URL');
const TOKEN = required('ENGAGEMENT_PHASE1_BEARER_TOKEN');
const EVIDENCE_DIR = required('ENGAGEMENT_PHASE1_EVIDENCE_DIR');
const FIXTURE_FILE = required('ENGAGEMENT_PHASE1_FIXTURE_FILE');
const MANIFEST_CANDIDATES = [
  path.resolve(process.cwd(), 'apps/api/src/engagement/__fixtures__/engagement-route-manifest.v1.json'),
  path.resolve(process.cwd(), 'src/engagement/__fixtures__/engagement-route-manifest.v1.json'),
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/engagement/__fixtures__/engagement-route-manifest.v1.json'),
];
const MANIFEST_FILE =
  MANIFEST_CANDIDATES.find((candidate) => existsSync(candidate)) ?? MANIFEST_CANDIDATES[0]!;
const MISSING_ID = 'ea000000-0000-4000-8000-000000000099';
const CROSS_USER_ID = 'ea000000-0000-4000-8000-000000000012';
const CROSS_TENANT_ID = 'ea000000-0000-4000-8000-000000000002';
const CROSS_TENANT_USER_ID = 'ea000000-0000-4000-8000-000000000013';
const CROSS_USER_MEETING_ID = 'ea000000-0000-4000-8000-000000000044';
const CROSS_TENANT_MEETING_ID = 'ea000000-0000-4000-8000-000000000045';

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required; Phase 1 parity may not skip authenticated proof`);
  }
  return value;
}

function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return {
    Authorization: `Bearer ${TOKEN}`,
    'Content-Type': 'application/json',
    ...extra,
  };
}

function routePath(route: RouteEntry, fixtures: Fixtures): string {
  const values: Record<string, string> = {
    clientId: fixtures.clientIds[0] ?? MISSING_ID,
    meetingId: fixtures.meetingIds.current ?? MISSING_ID,
    outreachRecordId: fixtures.outreachIds.draft ?? MISSING_ID,
    campaignId: fixtures.campaignId ?? MISSING_ID,
    taskId: fixtures.taskId ?? MISSING_ID,
    audienceId: fixtures.audienceIds.list ?? MISSING_ID,
    connectionId: MISSING_ID,
    versionId: MISSING_ID,
    artifactId: MISSING_ID,
    candidateVersionId: MISSING_ID,
    debriefId: MISSING_ID,
    noteId: MISSING_ID,
    prepId: MISSING_ID,
    itemId: MISSING_ID,
    attachmentId: MISSING_ID,
    recipientId: MISSING_ID,
    id: idForRoute(route, fixtures),
  };
  return route.path.replace(/:([A-Za-z0-9_]+)/g, (_match, name: string) => {
    const value = values[name];
    if (!value) {
      throw new Error(
        `No Phase 1 fixture mapping for ${route.method} ${route.path} parameter :${name}`,
      );
    }
    return encodeURIComponent(value);
  });
}

function idForRoute(route: RouteEntry, fixtures: Fixtures): string {
  if (route.handler === 'getOutreachJob' || route.handler === 'getSendIntent') {
    return MISSING_ID;
  }
  if (route.path.includes('/meetings/')) return fixtures.meetingIds.current ?? MISSING_ID;
  if (route.path.includes('/outreach/')) return fixtures.outreachIds.draft ?? MISSING_ID;
  if (route.path.includes('/campaigns/')) return fixtures.campaignId ?? MISSING_ID;
  if (route.path.includes('/tasks/')) return fixtures.taskId ?? MISSING_ID;
  return MISSING_ID;
}

function queryForRoute(route: RouteEntry, fixtures: Fixtures): string {
  const params = new URLSearchParams();
  if (route.handler === 'sharedMeetings' || route.handler === 'clientDebriefs') {
    params.set('clientId', fixtures.clientIds[0] ?? MISSING_ID);
  }
  if (route.handler === 'meetingLibrary') params.set('limit', '20');
  if (route.handler === 'listContacts') params.set('limit', '20');
  if (route.handler === 'listOutreachAudiences') params.set('kind', 'list');
  // listAttachments requires an attachment parent (or unlinked=true), so an unqualified
  // probe is a legitimate 400. Scope it to the seeded meeting — matching the
  // post-acceptance verifier — so the route is exercised against real rows instead of
  // comparing two identical BadRequest bodies.
  if (route.handler === 'attachments') {
    params.set('meetingId', fixtures.meetingIds.current ?? MISSING_ID);
  }
  if (route.handler === 'callback') {
    params.set('code', 'phase1-local');
    params.set('state', 'phase1-local');
  }
  if (route.handler === 'validateGet') params.set('validationToken', 'phase1-local');
  const query = params.toString();
  return query ? `?${query}` : '';
}

function isIsoInstant(value: unknown): boolean {
  return (
    typeof value === 'string' &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(value)
  );
}

function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalize);
  if (!value || typeof value !== 'object') return value;
  const output: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (/^(time|timestamp|requestId|traceId)$/i.test(key)) continue;
    if (
      /^(createdAt|updatedAt|generatedAt|lastSyncedAt|expiresAt|signedUrl|uploadUrl|downloadUrl)$/i.test(
        key,
      )
    ) {
      output[key] = '<normalized>';
      continue;
    }
    // Request-time window bounds (outreach/outbound/contact-data derives from/to from
    // `new Date()` per request) cannot match across two sequential probes. Mask them only
    // when the value is an ISO instant, so mail-shaped `from`/`to` addresses keep
    // participating in parity.
    if (/^(from|to)$/i.test(key) && isIsoInstant(raw)) {
      output[key] = '<normalized>';
      continue;
    }
    output[key] = normalize(raw);
  }
  return output;
}

async function probe(
  base: string,
  route: string,
  init: RequestInit = {},
): Promise<ProbeResult> {
  const response = await fetch(`${base}${route}`, { redirect: 'manual', ...init });
  const contentType = response.headers.get('content-type') ?? '';
  const serviceHeader = response.headers.get('x-capiro-service') ?? '';
  const text = await response.text();
  let body: unknown = text;
  if (contentType.includes('json') && text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  return { status: response.status, contentType, serviceHeader, body: normalize(body) };
}

function truncateBody(value: string, max = 1500): string {
  return value.length > max ? `${value.slice(0, max)}…(${value.length} bytes total)` : value;
}

function describeMismatch(left: ProbeResult, right: ProbeResult): string {
  const reasons: string[] = [];
  if (left.status !== right.status) {
    reasons.push(`  status: main=${left.status} engagement=${right.status}`);
  }
  if (left.contentType.split(';')[0] !== right.contentType.split(';')[0]) {
    reasons.push(`  content-type: main=${left.contentType} engagement=${right.contentType}`);
  }
  if (right.serviceHeader !== 'engagement-api') {
    reasons.push(`  x-capiro-service on engagement response: "${right.serviceHeader}"`);
  }
  const leftBody = JSON.stringify(left.body);
  const rightBody = JSON.stringify(right.body);
  if (leftBody !== rightBody) {
    reasons.push(
      `  body differs:\n    main:       ${truncateBody(leftBody)}\n    engagement: ${truncateBody(rightBody)}`,
    );
  }
  return reasons.length ? reasons.join('\n') : '  (no facet diverged; parity predicate changed?)';
}

function parity(left: ProbeResult, right: ProbeResult): boolean {
  return (
    left.status === right.status &&
    left.contentType.split(';')[0] === right.contentType.split(';')[0] &&
    JSON.stringify(left.body) === JSON.stringify(right.body) &&
    right.serviceHeader === 'engagement-api'
  );
}

function errorClass(result: ProbeResult): string {
  if (!result.body || typeof result.body !== 'object') return `http_${result.status}`;
  const body = result.body as Record<string, unknown>;
  return String(body.code ?? body.error ?? body.statusCode ?? `http_${result.status}`);
}

function requireDeniedPair(
  label: string,
  mainResult: ProbeResult,
  engagementResult: ProbeResult,
  allowedStatuses: readonly number[],
): void {
  if (!parity(mainResult, engagementResult)) {
    throw new Error(`${label} did not return parity-equivalent denials`);
  }
  if (!allowedStatuses.includes(mainResult.status)) {
    throw new Error(
      `${label} returned ${mainResult.status}; expected one of ${allowedStatuses.join(', ')}`,
    );
  }
  if (errorClass(mainResult) !== errorClass(engagementResult)) {
    throw new Error(`${label} returned different nonleaking error classes`);
  }
}

function assertNonleakingRecordDenial(
  label: string,
  marker: string,
  mainResult: ProbeResult,
  engagementResult: ProbeResult,
): void {
  requireDeniedPair(label, mainResult, engagementResult, [403, 404]);
  const serialized = JSON.stringify([mainResult.body, engagementResult.body]);
  if (serialized.includes(marker)) {
    throw new Error(`${label} leaked the protected record body`);
  }
}

async function protectedTableDigests(
  prisma: PrismaService,
): Promise<Record<string, TableDigest>> {
  const tables = await prisma.$queryRawUnsafe<Array<{ table_name: string }>>(`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_type = 'BASE TABLE'
      AND (
        table_name LIKE 'engagement_%'
        OR table_name LIKE 'outreach_%'
        OR table_name LIKE 'meeting_%'
        OR table_name LIKE 'mail_%'
        OR table_name = 'meetings'
      )
    ORDER BY table_name
  `);
  const output: Record<string, TableDigest> = {};
  for (const row of tables) {
    if (!/^[a-z0-9_]+$/.test(row.table_name)) {
      throw new Error(`Unsafe table name returned by PostgreSQL: ${row.table_name}`);
    }
    const result = await prisma.$queryRawUnsafe<Array<{ count: bigint; digest: string }>>(`
      SELECT
        COUNT(*)::bigint AS count,
        COALESCE(
          md5(string_agg(to_jsonb(t)::text, '|' ORDER BY to_jsonb(t)::text)),
          md5('')
        ) AS digest
      FROM "${row.table_name}" AS t
    `);
    output[row.table_name] = {
      count: Number(result[0]?.count ?? 0n),
      digest: result[0]?.digest ?? '',
    };
  }
  return output;
}

function expectedConstraintError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /invalid input value for enum|violates check constraint|check constraint/i.test(message);
}

async function main(): Promise<void> {
  await mkdir(EVIDENCE_DIR, { recursive: true });
  const fixtures = JSON.parse(await readFile(FIXTURE_FILE, 'utf8')) as Fixtures;
  const manifest = JSON.parse(await readFile(MANIFEST_FILE, 'utf8')) as {
    routes: RouteEntry[];
  };
  const prisma = new PrismaService();
  await prisma.$connect();

  const readResults: unknown[] = [];
  const authResults: unknown[] = [];
  const denialResults: unknown[] = [];
  let interoperability: Record<string, unknown> = {};

  try {
    const reads = manifest.routes.filter(
      (route) =>
        route.method === 'GET' &&
        route.path.startsWith('/api/engagement') &&
        !runtimePolicyForHandler(route.controller, route.handler),
    );
    if (reads.length === 0) {
      throw new Error('Phase 0 manifest produced no safe Engagement reads');
    }

    for (const route of reads) {
      const pathname = `${routePath(route, fixtures)}${queryForRoute(route, fixtures)}`;
      const mainResult = await probe(MAIN_URL, pathname, { headers: authHeaders() });
      const engagementResult = await probe(ENGAGEMENT_URL, pathname, {
        headers: authHeaders(),
      });
      // An authenticated read must never be 401. A 401 means the bearer token itself was
      // rejected, and because both services reject identically, every read would then "match"
      // and the whole stage would pass while proving nothing. Fail loudly instead.
      if (mainResult.status === 401 || engagementResult.status === 401) {
        throw new Error(
          `Authenticated read returned 401 for ${route.method} ${pathname} ` +
            `(main=${mainResult.status}, engagement=${engagementResult.status}). The bearer ` +
            'token was rejected, so read parity here would be vacuous: two matching 401s ' +
            'satisfy the comparator. Clerk session tokens live ~60s, so mint one immediately ' +
            'before this stage.',
        );
      }
      const matched = parity(mainResult, engagementResult);
      readResults.push({
        route: `${route.method} ${pathname}`,
        controller: route.controller,
        handler: route.handler,
        mainResult,
        engagementResult,
        matched,
      });
      if (!matched) {
        // Persist the failing pair before throwing; the success-path evidence write below is
        // never reached on failure, which is what makes these mismatches hard to diagnose.
        await writeFile(
          path.join(EVIDENCE_DIR, 'read-parity-mismatch.json'),
          JSON.stringify(
            {
              route: `${route.method} ${pathname}`,
              controller: route.controller,
              handler: route.handler,
              mainResult,
              engagementResult,
            },
            null,
            2,
          ),
        );
        throw new Error(
          `Read parity mismatch: ${route.method} ${pathname}\n${describeMismatch(
            mainResult,
            engagementResult,
          )}`,
        );
      }
    }

    for (const authCase of [
      { label: 'missing_bearer', headers: {}, allowed: [401] as const },
      {
        label: 'invalid_bearer',
        headers: { Authorization: 'Bearer invalid-token' },
        allowed: [401] as const,
      },
      {
        label: 'wrong_tenant_header',
        headers: authHeaders({ 'X-Capiro-Tenant': 'not-a-real-tenant' }),
        allowed: [403] as const,
      },
    ]) {
      const pathname = '/api/engagement/meetings';
      const mainResult = await probe(MAIN_URL, pathname, { headers: authCase.headers });
      const engagementResult = await probe(ENGAGEMENT_URL, pathname, {
        headers: authCase.headers,
      });
      requireDeniedPair(authCase.label, mainResult, engagementResult, authCase.allowed);
      authResults.push({
        label: authCase.label,
        expectedStatuses: authCase.allowed,
        mainResult,
        engagementResult,
        errorClass: errorClass(mainResult),
        matched: true,
      });
    }

    const originalMembership = await prisma.$queryRawUnsafe<Array<{ role: string }>>(
      `SELECT role::text AS role FROM tenant_memberships WHERE tenant_id = '${fixtures.tenantId}'::uuid AND user_id = '${fixtures.userId}'::uuid`,
    );
    const originalRole = originalMembership[0]?.role;
    if (!originalRole) throw new Error('Fixture membership role was not found');
    const standardRank = ROLE_RANK.standard_user;
    const belowRole = Object.entries(ROLE_RANK).find(([, rank]) => rank < standardRank)?.[0];
    if (!belowRole) throw new Error('ROLE_RANK has no role below standard_user');

    try {
      await prisma.$executeRawUnsafe(
        `UPDATE tenant_memberships SET role = '${belowRole}' WHERE tenant_id = '${fixtures.tenantId}'::uuid AND user_id = '${fixtures.userId}'::uuid`,
      );
      const pathname = '/api/engagement/meetings';
      const mainResult = await probe(MAIN_URL, pathname, { headers: authHeaders() });
      const engagementResult = await probe(ENGAGEMENT_URL, pathname, {
        headers: authHeaders(),
      });
      requireDeniedPair('below_required_role', mainResult, engagementResult, [403]);
      authResults.push({
        label: 'below_required_role',
        role: belowRole,
        expectedStatuses: [403],
        mainResult,
        engagementResult,
        matched: true,
      });
    } finally {
      await prisma.$executeRawUnsafe(
        `UPDATE tenant_memberships SET role = '${originalRole}' WHERE tenant_id = '${fixtures.tenantId}'::uuid AND user_id = '${fixtures.userId}'::uuid`,
      );
    }

    let unknownRoleWasWritten = false;
    try {
      await prisma.$executeRawUnsafe(
        `UPDATE tenant_memberships SET role = 'phase1_unrecognized_role' WHERE tenant_id = '${fixtures.tenantId}'::uuid AND user_id = '${fixtures.userId}'::uuid`,
      );
      unknownRoleWasWritten = true;
    } catch (error) {
      if (!expectedConstraintError(error)) throw error;
      authResults.push({
        label: 'unrecognized_role',
        result: 'database_rejected_unknown_role',
        databaseConstraint: true,
        matched: true,
      });
    }
    if (unknownRoleWasWritten) {
      try {
        const pathname = '/api/engagement/meetings';
        const mainResult = await probe(MAIN_URL, pathname, { headers: authHeaders() });
        const engagementResult = await probe(ENGAGEMENT_URL, pathname, {
          headers: authHeaders(),
        });
        requireDeniedPair('unrecognized_role', mainResult, engagementResult, [403]);
        authResults.push({
          label: 'unrecognized_role',
          expectedStatuses: [403],
          mainResult,
          engagementResult,
          matched: true,
        });
      } finally {
        await prisma.$executeRawUnsafe(
          `UPDATE tenant_memberships SET role = '${originalRole}' WHERE tenant_id = '${fixtures.tenantId}'::uuid AND user_id = '${fixtures.userId}'::uuid`,
        );
      }
    }

    await prisma.$executeRawUnsafe(`
      INSERT INTO users (id, email, clerk_user_id, created_at, updated_at)
      VALUES ('${CROSS_USER_ID}'::uuid, 'phase1-cross-user@example.invalid', 'phase1-cross-user', now(), now())
      ON CONFLICT (id) DO NOTHING
    `);
    await prisma.$executeRawUnsafe(`
      INSERT INTO tenants (id, slug, name, clerk_org_id, created_at, updated_at)
      VALUES ('${CROSS_TENANT_ID}'::uuid, 'phase1-cross-tenant', 'Phase 1 Cross Tenant', 'phase1-cross-tenant', now(), now())
      ON CONFLICT (id) DO NOTHING
    `);
    await prisma.$executeRawUnsafe(`
      INSERT INTO users (id, email, clerk_user_id, created_at, updated_at)
      VALUES ('${CROSS_TENANT_USER_ID}'::uuid, 'phase1-cross-tenant@example.invalid', 'phase1-cross-tenant-user', now(), now())
      ON CONFLICT (id) DO NOTHING
    `);
    await prisma.$executeRawUnsafe(`
      INSERT INTO meetings (id, tenant_id, subject, starts_at, ends_at, status, visibility, created_by_user_id, created_at, updated_at)
      VALUES
        ('${CROSS_USER_MEETING_ID}'::uuid, '${fixtures.tenantId}'::uuid, 'Phase 1 Cross User', now(), now() + interval '1 hour', 'scheduled', 'private', '${CROSS_USER_ID}'::uuid, now(), now()),
        ('${CROSS_TENANT_MEETING_ID}'::uuid, '${CROSS_TENANT_ID}'::uuid, 'Phase 1 Cross Tenant', now(), now() + interval '1 hour', 'scheduled', 'private', '${CROSS_TENANT_USER_ID}'::uuid, now(), now())
      ON CONFLICT (id) DO NOTHING
    `);

    for (const [label, id, marker] of [
      ['cross_user_owned_record', CROSS_USER_MEETING_ID, 'Phase 1 Cross User'],
      ['cross_tenant_record', CROSS_TENANT_MEETING_ID, 'Phase 1 Cross Tenant'],
    ] as const) {
      const pathname = `/api/engagement/meetings/${id}`;
      const mainResult = await probe(MAIN_URL, pathname, { headers: authHeaders() });
      const engagementResult = await probe(ENGAGEMENT_URL, pathname, {
        headers: authHeaders(),
      });
      assertNonleakingRecordDenial(label, marker, mainResult, engagementResult);
      authResults.push({
        label,
        expectedStatuses: [403, 404],
        mainResult,
        engagementResult,
        leakedMarker: false,
        matched: true,
      });
    }

    const marker = `Phase 1 Interop ${Date.now()}`;
    const create = await probe(ENGAGEMENT_URL, '/api/engagement/meetings', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        subject: marker,
        startsAt: new Date(Date.now() + 3_600_000).toISOString(),
        endsAt: new Date(Date.now() + 7_200_000).toISOString(),
      }),
    });
    if (
      create.status < 200 ||
      create.status >= 300 ||
      !create.body ||
      typeof create.body !== 'object'
    ) {
      throw new Error(`Safe local create through engagement-api failed: ${JSON.stringify(create)}`);
    }
    const createdId = String((create.body as Record<string, unknown>).id ?? '');
    if (!/^[0-9a-f-]{36}$/i.test(createdId)) {
      throw new Error('Create response did not include a meeting id');
    }

    const readFromMain = await probe(MAIN_URL, `/api/engagement/meetings/${createdId}`, {
      headers: authHeaders(),
    });
    const updatedSubject = `${marker} Updated`;
    const update = await probe(MAIN_URL, `/api/engagement/meetings/${createdId}`, {
      method: 'PUT',
      headers: authHeaders(),
      body: JSON.stringify({ subject: updatedSubject }),
    });
    const readFromEngagement = await probe(
      ENGAGEMENT_URL,
      `/api/engagement/meetings/${createdId}`,
      { headers: authHeaders() },
    );
    const roundTrip =
      readFromMain.status === 200 &&
      update.status >= 200 &&
      update.status < 300 &&
      readFromEngagement.status === 200 &&
      JSON.stringify(readFromEngagement.body).includes(updatedSubject);
    interoperability = {
      createdId,
      marker,
      readFromMain,
      update,
      readFromEngagement,
      roundTrip,
    };
    if (!roundTrip) throw new Error('Shared-database local write interoperability failed');
    await prisma.$executeRawUnsafe(`DELETE FROM meetings WHERE id = '${createdId}'::uuid`);

    const beforeDigests = await protectedTableDigests(prisma);
    const registry = registryEntries();
    let routeProbeCount = 0;
    for (const entry of registry) {
      const matchingRoutes = manifest.routes.filter(
        (route) => route.controller === entry.controller && route.handler === entry.handler,
      );
      if (matchingRoutes.length === 0) {
        throw new Error(`Runtime registry entry has no manifest route: ${entry.controller}.${entry.handler}`);
      }
      for (const route of matchingRoutes) {
        const pathname = `${routePath(route, fixtures)}${queryForRoute(route, fixtures)}`;
        const result = await probe(ENGAGEMENT_URL, pathname, {
          method: route.method,
          headers: authHeaders(),
          body: ['GET', 'DELETE'].includes(route.method) ? undefined : '{}',
        });
        const body = result.body as Record<string, unknown> | undefined;
        const denied =
          result.status === 503 &&
          result.serviceHeader === 'engagement-api' &&
          body?.code === 'ENGAGEMENT_EXTERNAL_ACTION_DISABLED' &&
          body?.action === entry.metadata.action;
        denialResults.push({
          controller: entry.controller,
          handler: entry.handler,
          action: entry.metadata.action,
          method: route.method,
          pathname,
          result,
          denied,
        });
        routeProbeCount += 1;
        if (!denied) {
          throw new Error(
            `External route was not denied correctly: ${route.method} ${pathname} ` +
              `(${entry.controller}.${entry.handler}, action=${entry.metadata.action})`,
          );
        }
      }
    }
    if (routeProbeCount < registry.length) {
      throw new Error(
        `External route probe coverage was incomplete: routes=${routeProbeCount} registry=${registry.length}`,
      );
    }
    const afterDigests = await protectedTableDigests(prisma);
    if (JSON.stringify(beforeDigests) !== JSON.stringify(afterDigests)) {
      throw new Error(
        `External denial probes mutated protected data: ${JSON.stringify({
          beforeDigests,
          afterDigests,
        })}`,
      );
    }

    await writeFile(
      path.join(EVIDENCE_DIR, 'read-parity.json'),
      JSON.stringify({ routes: readResults, total: readResults.length, passed: readResults.length }, null, 2),
    );
    await writeFile(
      path.join(EVIDENCE_DIR, 'auth-parity.json'),
      JSON.stringify({ cases: authResults, total: authResults.length, passed: authResults.length }, null, 2),
    );
    await writeFile(
      path.join(EVIDENCE_DIR, 'local-write-interoperability.json'),
      JSON.stringify(interoperability, null, 2),
    );
    await writeFile(
      path.join(EVIDENCE_DIR, 'external-action-denials.json'),
      JSON.stringify(
        {
          denials: denialResults,
          runtimeRegistryEntries: registry.length,
          routeProbes: routeProbeCount,
          protectedData: { before: beforeDigests, after: afterDigests, unchanged: true },
          passed: true,
        },
        null,
        2,
      ),
    );
    console.log(`Read parity: ${readResults.length}/${readResults.length}`);
    console.log(`Auth/ownership parity: ${authResults.length}/${authResults.length}`);
    console.log(`External routes denied: ${routeProbeCount}/${routeProbeCount}`);
    console.log('ENGAGEMENT_PHASE1_API_PARITY_COMPLETE');
  } finally {
    await prisma
      .$executeRawUnsafe(
        `DELETE FROM meetings WHERE id IN ('${CROSS_USER_MEETING_ID}'::uuid, '${CROSS_TENANT_MEETING_ID}'::uuid)`,
      )
      .catch(() => undefined);
    await prisma
      .$executeRawUnsafe(
        `DELETE FROM users WHERE id IN ('${CROSS_USER_ID}'::uuid, '${CROSS_TENANT_USER_ID}'::uuid)`,
      )
      .catch(() => undefined);
    await prisma
      .$executeRawUnsafe(`DELETE FROM tenants WHERE id = '${CROSS_TENANT_ID}'::uuid`)
      .catch(() => undefined);
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
