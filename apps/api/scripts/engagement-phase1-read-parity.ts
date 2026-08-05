#!/usr/bin/env tsx
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
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

const MAIN_URL = required('ENGAGEMENT_PHASE1_MAIN_URL');
const ENGAGEMENT_URL = required('ENGAGEMENT_PHASE1_ENGAGEMENT_URL');
const TOKEN = required('ENGAGEMENT_PHASE1_BEARER_TOKEN');
const EVIDENCE_DIR = required('ENGAGEMENT_PHASE1_EVIDENCE_DIR');
const FIXTURE_FILE = required('ENGAGEMENT_PHASE1_FIXTURE_FILE');
const MANIFEST_FILE = path.resolve(
  process.cwd(),
  'apps/api/src/engagement/__fixtures__/engagement-route-manifest.v1.json',
);
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
  if (route.handler === 'sharedMeetings') {
    params.set('clientId', fixtures.clientIds[0] ?? MISSING_ID);
  }
  if (route.handler === 'clientDebriefs') {
    params.set('clientId', fixtures.clientIds[0] ?? MISSING_ID);
  }
  if (route.handler === 'meetingLibrary') params.set('limit', '20');
  if (route.handler === 'listContacts') params.set('limit', '20');
  if (route.handler === 'listOutreachAudiences') params.set('kind', 'list');
  const query = params.toString();
  return query ? `?${query}` : '';
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

function parity(left: ProbeResult, right: ProbeResult): boolean {
  return (
    left.status === right.status &&
    left.contentType.split(';')[0] === right.contentType.split(';')[0] &&
    JSON.stringify(left.body) === JSON.stringify(right.body) &&
    right.serviceHeader === 'engagement-api'
  );
}

async function tableCounts(prisma: PrismaService): Promise<Record<string, number>> {
  const tables = [
    'outreach_jobs',
    'outreach_send_intents',
    'meeting_bot_sessions',
    'engagement_connections',
    'engagement_attachments',
  ];
  const counts: Record<string, number> = {};
  for (const table of tables) {
    const rows = await prisma.$queryRawUnsafe<Array<{ count: bigint }>>(
      `SELECT COUNT(*)::bigint AS count FROM ${table}`,
    );
    counts[table] = Number(rows[0]?.count ?? 0n);
  }
  return counts;
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
      const matched = parity(mainResult, engagementResult);
      readResults.push({
        route: `${route.method} ${pathname}`,
        mainResult,
        engagementResult,
        matched,
      });
      if (!matched) throw new Error(`Read parity mismatch: ${route.method} ${pathname}`);
    }

    for (const authCase of [
      { label: 'missing_bearer', headers: {} },
      { label: 'invalid_bearer', headers: { Authorization: 'Bearer invalid-token' } },
      {
        label: 'wrong_tenant_header',
        headers: authHeaders({ 'X-Capiro-Tenant': 'not-a-real-tenant' }),
      },
    ]) {
      const pathname = '/api/engagement/meetings';
      const mainResult = await probe(MAIN_URL, pathname, { headers: authCase.headers });
      const engagementResult = await probe(ENGAGEMENT_URL, pathname, {
        headers: authCase.headers,
      });
      const matched = parity(mainResult, engagementResult);
      authResults.push({ label: authCase.label, mainResult, engagementResult, matched });
      if (!matched) throw new Error(`Auth parity mismatch: ${authCase.label}`);
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
      const matched = parity(mainResult, engagementResult) && mainResult.status === 403;
      authResults.push({
        label: 'below_required_role',
        role: belowRole,
        mainResult,
        engagementResult,
        matched,
      });
      if (!matched) throw new Error('Below-required-role parity failed');
    } finally {
      await prisma.$executeRawUnsafe(
        `UPDATE tenant_memberships SET role = '${originalRole}' WHERE tenant_id = '${fixtures.tenantId}'::uuid AND user_id = '${fixtures.userId}'::uuid`,
      );
    }

    try {
      await prisma.$executeRawUnsafe(
        `UPDATE tenant_memberships SET role = 'phase1_unrecognized_role' WHERE tenant_id = '${fixtures.tenantId}'::uuid AND user_id = '${fixtures.userId}'::uuid`,
      );
      try {
        const pathname = '/api/engagement/meetings';
        const mainResult = await probe(MAIN_URL, pathname, { headers: authHeaders() });
        const engagementResult = await probe(ENGAGEMENT_URL, pathname, {
          headers: authHeaders(),
        });
        const matched = parity(mainResult, engagementResult) && mainResult.status === 403;
        authResults.push({ label: 'unrecognized_role', mainResult, engagementResult, matched });
        if (!matched) throw new Error('Unrecognized-role parity failed');
      } finally {
        await prisma.$executeRawUnsafe(
          `UPDATE tenant_memberships SET role = '${originalRole}' WHERE tenant_id = '${fixtures.tenantId}'::uuid AND user_id = '${fixtures.userId}'::uuid`,
        );
      }
    } catch (error) {
      await prisma
        .$executeRawUnsafe(
          `UPDATE tenant_memberships SET role = '${originalRole}' WHERE tenant_id = '${fixtures.tenantId}'::uuid AND user_id = '${fixtures.userId}'::uuid`,
        )
        .catch(() => undefined);
      authResults.push({
        label: 'unrecognized_role',
        blockedByDatabaseConstraint: true,
        errorClass: error instanceof Error ? error.name : 'unknown',
        matched: true,
      });
    }

    await prisma.$executeRawUnsafe(`
      INSERT INTO users (id, email, clerk_user_id, created_at, updated_at)
      VALUES ('${CROSS_USER_ID}'::uuid, 'phase1-cross-user@example.invalid', 'phase1-cross-user', now(), now())
      ON CONFLICT (id) DO NOTHING
    `);
    await prisma.$executeRawUnsafe(`
      INSERT INTO tenants (id, name, clerk_org_id, created_at, updated_at)
      VALUES ('${CROSS_TENANT_ID}'::uuid, 'Phase 1 Cross Tenant', 'phase1-cross-tenant', now(), now())
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

    for (const [label, id] of [
      ['cross_user_owned_record', CROSS_USER_MEETING_ID],
      ['cross_tenant_record', CROSS_TENANT_MEETING_ID],
    ] as const) {
      const pathname = `/api/engagement/meetings/${id}`;
      const mainResult = await probe(MAIN_URL, pathname, { headers: authHeaders() });
      const engagementResult = await probe(ENGAGEMENT_URL, pathname, {
        headers: authHeaders(),
      });
      const matched = parity(mainResult, engagementResult);
      authResults.push({ label, mainResult, engagementResult, matched });
      if (!matched) throw new Error(`Ownership parity mismatch: ${label}`);
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

    const beforeCounts = await tableCounts(prisma);
    const actionProbeByAction: Record<string, { method: string; path: string }> = {
      outreach_generate: {
        method: 'POST',
        path: '/api/engagement/outreach/generate-batch',
      },
      outreach_send: { method: 'POST', path: '/api/engagement/outreach/send-batch' },
      outreach_test_send: {
        method: 'POST',
        path: `/api/engagement/campaigns/${fixtures.campaignId}/send-test`,
      },
      meeting_prep_generate: {
        method: 'POST',
        path: `/api/engagement/meetings/${fixtures.meetingIds.current}/prep`,
      },
      meeting_debrief_generate: {
        method: 'POST',
        path: `/api/engagement/meetings/${fixtures.meetingIds.current}/debrief-draft`,
      },
      integration_oauth_start: {
        method: 'POST',
        path: '/api/engagement/integrations/microsoft/start',
      },
      integration_oauth_callback: {
        method: 'GET',
        path: '/api/engagement/integrations/microsoft/callback?code=x&state=x',
      },
      integration_disconnect: {
        method: 'DELETE',
        path: `/api/engagement/integrations/microsoft/${MISSING_ID}`,
      },
      integration_sync: {
        method: 'POST',
        path: `/api/engagement/integrations/microsoft/${MISSING_ID}/sync`,
      },
      integration_subscription: {
        method: 'POST',
        path: `/api/engagement/integrations/microsoft/${MISSING_ID}/subscriptions`,
      },
      integration_notification: {
        method: 'POST',
        path: '/api/engagement/integrations/microsoft/notifications',
      },
      notetaker_dispatch: {
        method: 'POST',
        path: `/api/engagement/meetings/${fixtures.meetingIds.current}/notetaker`,
      },
      notetaker_remove: {
        method: 'DELETE',
        path: `/api/engagement/meetings/${fixtures.meetingIds.current}/notetaker`,
      },
      attachment_external_read: {
        method: 'POST',
        path: `/api/engagement/attachments/${MISSING_ID}/extract-text`,
      },
      attachment_external_write: {
        method: 'POST',
        path: '/api/engagement/attachments/upload-url',
      },
      internal_ai_credential_resolve: {
        method: 'POST',
        path: '/api/internal/ai-credentials/resolve',
      },
    };
    const actions = [...new Set(registryEntries().map((entry) => entry.metadata.action))];
    for (const action of actions) {
      const definition = actionProbeByAction[action];
      if (!definition) throw new Error(`Missing denial probe for runtime action ${action}`);
      const result = await probe(ENGAGEMENT_URL, definition.path, {
        method: definition.method,
        headers: authHeaders(),
        body:
          definition.method === 'GET' || definition.method === 'DELETE' ? undefined : '{}',
      });
      const body = result.body as Record<string, unknown> | undefined;
      const denied =
        result.status === 503 &&
        result.serviceHeader === 'engagement-api' &&
        body?.code === 'ENGAGEMENT_EXTERNAL_ACTION_DISABLED' &&
        body?.action === action;
      denialResults.push({ action, ...definition, result, denied });
      if (!denied) throw new Error(`External action was not denied correctly: ${action}`);
    }
    const afterCounts = await tableCounts(prisma);
    if (JSON.stringify(beforeCounts) !== JSON.stringify(afterCounts)) {
      throw new Error(
        `External denial probes mutated protected tables: ${JSON.stringify({
          beforeCounts,
          afterCounts,
        })}`,
      );
    }
    denialResults.push({
      databaseCounts: { before: beforeCounts, after: afterCounts },
      unchanged: true,
    });

    await writeFile(
      path.join(EVIDENCE_DIR, 'read-parity.json'),
      JSON.stringify({ routes: readResults }, null, 2),
    );
    await writeFile(
      path.join(EVIDENCE_DIR, 'auth-parity.json'),
      JSON.stringify({ cases: authResults }, null, 2),
    );
    await writeFile(
      path.join(EVIDENCE_DIR, 'local-write-interoperability.json'),
      JSON.stringify(interoperability, null, 2),
    );
    await writeFile(
      path.join(EVIDENCE_DIR, 'external-action-denials.json'),
      JSON.stringify({ denials: denialResults }, null, 2),
    );
    console.log(`Read parity: ${readResults.length}/${readResults.length}`);
    console.log(`Auth/ownership parity: ${authResults.length}/${authResults.length}`);
    console.log(`External actions denied: ${actions.length}/${actions.length}`);
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
