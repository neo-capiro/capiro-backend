#!/usr/bin/env tsx
/**
 * Phase 3 external-action containment acceptance.
 *
 * Drives every current UI consumer classified `external_action` through the
 * localhost preview proxy, requires the exact shadow denial and service header,
 * and compares a before/after digest of every side-effect-bearing Engagement
 * table. This proves refusal rather than relying on a provider/S3 failure.
 */
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { PrismaService } from '../src/prisma/prisma.service.js';

interface InventoryRequest {
  method: string;
  requestPath: string;
  routeManifestKey: string;
  classification: string;
  surface: string;
  runtimeAction: string | null;
}

interface Inventory {
  requests: InventoryRequest[];
}

interface FixtureIndex {
  ids: Record<string, string>;
}

const ROOT = path.resolve(__dirname, '../../..');
const INVENTORY = path.join(
  ROOT,
  'apps/web/src/pages/engagement/__fixtures__/engagement-current-ui-surface-manifest.v1.json',
);
const EVIDENCE = required('ENGAGEMENT_PHASE3_EVIDENCE_DIR');
const FIXTURE_FILE = required('ENGAGEMENT_PHASE3_FIXTURE_FILE');
const TOKEN_FILE = required('ENGAGEMENT_PHASE3_ADMIN_TOKEN_FILE');
const PROXY_URL = process.env.ENGAGEMENT_PHASE3_PROXY_URL ?? 'http://127.0.0.1:4600';
const EXPECTED_CODE = 'ENGAGEMENT_EXTERNAL_ACTION_DISABLED';

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function sha(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

async function sideEffectState(prisma: PrismaService, tenantIds: string[]) {
  return prisma.withSystem(async (tx) => ({
    outreachJobs: await tx.outreachJob.findMany({
      where: { tenantId: { in: tenantIds } },
      orderBy: { id: 'asc' },
      select: { id: true, status: true, type: true, result: true, error: true },
    }),
    sendIntents: await tx.outreachSendIntent.findMany({
      where: { tenantId: { in: tenantIds } },
      orderBy: { id: 'asc' },
      select: { id: true, status: true, totals: true, startedAt: true, finishedAt: true },
    }),
    deliveries: await tx.outreachDelivery.findMany({
      where: { tenantId: { in: tenantIds } },
      orderBy: { id: 'asc' },
      select: { id: true, status: true, attempt: true, providerMessageId: true },
    }),
    outreachRecords: await tx.outreachRecord.findMany({
      where: { tenantId: { in: tenantIds } },
      orderBy: { id: 'asc' },
      select: { id: true, status: true, sentAt: true, openedInEmailAt: true, updatedAt: true },
    }),
    botSessions: await tx.meetingBotSession.findMany({
      where: { tenantId: { in: tenantIds } },
      orderBy: { id: 'asc' },
      select: { id: true, status: true, providerBotId: true, error: true, updatedAt: true },
    }),
    connections: await tx.integrationConnection.findMany({
      where: { tenantId: { in: tenantIds } },
      orderBy: { id: 'asc' },
      select: { id: true, status: true, lastSyncAt: true, lastError: true, syncState: true, updatedAt: true },
    }),
    connectionTokens: await tx.integrationConnectionToken.findMany({
      where: { tenantId: { in: tenantIds } },
      orderBy: { id: 'asc' },
      select: { id: true, updatedAt: true },
    }),
    attachments: await tx.engagementAttachment.findMany({
      where: { tenantId: { in: tenantIds } },
      orderBy: { id: 'asc' },
      select: { id: true, lifecycleStatus: true, scanStatus: true, updatedAt: true },
    }),
    preps: await tx.meetingPrep.findMany({
      where: { tenantId: { in: tenantIds } },
      orderBy: { id: 'asc' },
      select: { id: true, status: true, updatedAt: true },
    }),
    debriefs: await tx.meetingDebrief.findMany({
      where: { tenantId: { in: tenantIds } },
      orderBy: { id: 'asc' },
      select: { id: true, status: true, updatedAt: true },
    }),
  }));
}

function materializePath(pathname: string, fallbackId: string): string {
  return pathname.replace(/:param\b/g, encodeURIComponent(fallbackId));
}

async function main(): Promise<void> {
  const inventory = JSON.parse(await readFile(INVENTORY, 'utf8')) as Inventory;
  const fixtures = JSON.parse(await readFile(FIXTURE_FILE, 'utf8')) as FixtureIndex;
  const token = (await readFile(TOKEN_FILE, 'utf8')).trim();
  if (token.length < 20) throw new Error('Phase 3 bearer token file is empty or invalid');

  const tenantIds = ['tenant.primary', 'tenant.secondary', 'tenant.capiroInternal'].map((key) => {
    const id = fixtures.ids[key];
    if (!id) throw new Error(`Fixture index missing ${key}`);
    return id;
  });
  const fallbackId = fixtures.ids['absent.meeting'] ?? Object.values(fixtures.ids).find((id) => /^[0-9a-f-]{36}$/i.test(id));
  if (!fallbackId) throw new Error('Fixture index has no well-formed fallback UUID');

  const unique = new Map<string, InventoryRequest>();
  for (const request of inventory.requests.filter((row) => row.classification === 'external_action')) {
    unique.set(`${request.method} ${request.requestPath}`, request);
  }
  if (!unique.size) throw new Error('UI inventory contains no external-action requests');

  const prisma = new PrismaService();
  await prisma.$connect();
  try {
    const before = await sideEffectState(prisma, tenantIds);
    const beforeHash = sha(before);
    const results: Array<Record<string, unknown>> = [];

    for (const request of unique.values()) {
      const relative = materializePath(request.requestPath, fallbackId);
      const headers: Record<string, string> = {
        Authorization: `Bearer ${token}`,
        'X-Capiro-Engagement-Preview': 'v3',
      };
      const init: RequestInit = { method: request.method, headers, redirect: 'manual' };
      if (!['GET', 'HEAD'].includes(request.method)) {
        headers['Content-Type'] = 'application/json';
        init.body = '{}';
      }
      const response = await fetch(`${PROXY_URL}${relative}`, init);
      const service = response.headers.get('x-capiro-service');
      const text = await response.text();
      let body: Record<string, unknown> = {};
      try {
        body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
      } catch {
        body = {};
      }
      const code = typeof body.code === 'string' ? body.code : null;
      results.push({
        surface: request.surface,
        method: request.method,
        routeManifestKey: request.routeManifestKey,
        runtimeAction: request.runtimeAction,
        status: response.status,
        service,
        code,
      });
      if (response.status !== 503 || code !== EXPECTED_CODE || service !== 'engagement-api') {
        throw new Error(
          `${request.method} ${request.routeManifestKey} did not fail at the shadow policy boundary ` +
            `(status=${response.status}, code=${String(code)}, service=${String(service)})`,
        );
      }
    }

    const after = await sideEffectState(prisma, tenantIds);
    const afterHash = sha(after);
    if (afterHash !== beforeHash) {
      throw new Error('External-action denial sweep mutated protected Engagement state');
    }

    await writeFile(
      path.join(EVIDENCE, 'external-action-denials.json'),
      `${JSON.stringify(
        {
          marker: 'ENGAGEMENT_PHASE3_EXTERNAL_ACTION_DENIALS_COMPLETE',
          routes: results.length,
          beforeHash,
          afterHash,
          unchanged: true,
          results,
        },
        null,
        2,
      )}\n`,
    );
    console.log(`ENGAGEMENT_PHASE3_EXTERNAL_ACTION_DENIALS_COMPLETE routes=${results.length}`);
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
