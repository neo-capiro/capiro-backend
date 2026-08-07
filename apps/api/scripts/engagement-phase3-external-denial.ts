#!/usr/bin/env tsx
/**
 * Phase 3 external-action containment acceptance.
 *
 * Drives every current UI consumer classified `external_action` through the
 * localhost preview proxy, requires the exact shadow denial and service header,
 * and compares a before/after digest of every relevant tenant-scoped business,
 * draft, provider, AI-usage, and audit table. This proves refusal rather than
 * relying on a provider/S3 failure or on a narrow hand-picked projection.
 */
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { PrismaService } from '../src/prisma/prisma.service.js';
import {
  PHASE3_REQUIRED_CONTAINMENT_TABLES,
  isPhase3ProtectedSideEffectTable,
} from './engagement-phase3-containment-tables.js';

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

interface TableDigest {
  count: number;
  digest: string;
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
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SAFE_IDENTIFIER = /^[a-z0-9_]+$/;

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function sha(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

async function discoverProtectedTables(prisma: PrismaService): Promise<string[]> {
  const rows = await prisma.$queryRawUnsafe<Array<{ table_name: string }>>(`
    SELECT DISTINCT t.table_name
    FROM information_schema.tables AS t
    JOIN information_schema.columns AS c
      ON c.table_schema = t.table_schema
     AND c.table_name = t.table_name
     AND c.column_name = 'tenant_id'
    WHERE t.table_schema = 'public'
      AND t.table_type = 'BASE TABLE'
    ORDER BY t.table_name
  `);
  const tables = rows
    .map((row) => row.table_name)
    .filter((table) => isPhase3ProtectedSideEffectTable(table));

  for (const table of tables) {
    if (!SAFE_IDENTIFIER.test(table)) {
      throw new Error(`PostgreSQL returned an unsafe table identifier: ${table}`);
    }
  }
  const missing = PHASE3_REQUIRED_CONTAINMENT_TABLES.filter(
    (requiredTable) => !tables.includes(requiredTable),
  );
  if (missing.length) {
    throw new Error(
      `Phase 3 containment discovery is missing required table(s): ${missing.join(', ')}`,
    );
  }
  return tables;
}

/**
 * Hash complete rows for every protected table. Ordering by the JSON text avoids
 * assuming each table has an `id` column and catches inserts, deletes, and any
 * field update, including a generated-success audit/usage row.
 */
async function sideEffectState(
  prisma: PrismaService,
  tenantIds: string[],
): Promise<Record<string, TableDigest>> {
  for (const id of tenantIds) {
    if (!UUID.test(id)) throw new Error(`Unsafe Phase 3 tenant id: ${id}`);
  }
  const tenantSql = tenantIds.map((id) => `'${id}'::uuid`).join(', ');
  const tables = await discoverProtectedTables(prisma);
  const state: Record<string, TableDigest> = {};

  for (const table of tables) {
    const result = await prisma.$queryRawUnsafe<Array<{ count: bigint; digest: string }>>(`
      SELECT
        COUNT(*)::bigint AS count,
        COALESCE(
          md5(string_agg(to_jsonb(t)::text, '|' ORDER BY to_jsonb(t)::text)),
          md5('')
        ) AS digest
      FROM "${table}" AS t
      WHERE t.tenant_id IN (${tenantSql})
    `);
    state[table] = {
      count: Number(result[0]?.count ?? 0n),
      digest: result[0]?.digest ?? '',
    };
  }
  return state;
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
  const fallbackId =
    fixtures.ids['absent.meeting'] ??
    Object.values(fixtures.ids).find((id) => UUID.test(id));
  if (!fallbackId) throw new Error('Fixture index has no well-formed fallback UUID');

  const unique = new Map<string, InventoryRequest>();
  for (const request of inventory.requests.filter(
    (row) => row.classification === 'external_action',
  )) {
    unique.set(`${request.method} ${request.requestPath}`, request);
  }
  if (!unique.size) throw new Error('UI inventory contains no external-action requests');

  const prisma = new PrismaService();
  await prisma.$connect();
  try {
    const before = await sideEffectState(prisma, tenantIds);
    const protectedTables = Object.keys(before);
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
      const changed = protectedTables.filter(
        (table) => JSON.stringify(before[table]) !== JSON.stringify(after[table]),
      );
      throw new Error(
        `External-action denial sweep mutated protected Engagement state: ${changed.join(', ')}`,
      );
    }

    await writeFile(
      path.join(EVIDENCE, 'external-action-denials.json'),
      `${JSON.stringify(
        {
          marker: 'ENGAGEMENT_PHASE3_EXTERNAL_ACTION_DENIALS_COMPLETE',
          routes: results.length,
          protectedTables,
          protectedTableCount: protectedTables.length,
          beforeHash,
          afterHash,
          unchanged: true,
          results,
        },
        null,
        2,
      )}\n`,
    );
    console.log(
      `ENGAGEMENT_PHASE3_EXTERNAL_ACTION_DENIALS_COMPLETE routes=${results.length} ` +
        `tables=${protectedTables.length}`,
    );
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
