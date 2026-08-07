#!/usr/bin/env tsx
/**
 * Phase 3 full UI-inventory read parity.
 *
 * Browser replay proves the exact requests emitted by representative rendered
 * pages. This companion sweep prevents coverage from shrinking to only those
 * observed requests: every unique current UI request classified `read` is
 * materialized from deterministic fixtures and compared across main/shadow.
 *
 * Data-backed routes must return 2xx. A non-2xx can pass only when the fixture
 * contract deliberately declares the row absent; Stage 3.7's required `no job`
 * invariant is the sole current example. Matching accidental 400/404 responses
 * are therefore not accepted as parity evidence.
 */
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  materializePhase3Read,
  uniquePhase3Reads,
  type Phase3FixtureIndex,
  type Phase3ReadInventoryRequest,
} from './engagement-phase3-read-materialization.js';

interface Inventory {
  requests: Phase3ReadInventoryRequest[];
}

const ROOT = path.resolve(__dirname, '../../..');
const INVENTORY_FILE = path.join(
  ROOT,
  'apps/web/src/pages/engagement/__fixtures__/engagement-current-ui-surface-manifest.v1.json',
);
const EVIDENCE = required('ENGAGEMENT_PHASE3_EVIDENCE_DIR');
const FIXTURE_FILE = required('ENGAGEMENT_PHASE3_FIXTURE_FILE');
const TOKEN_FILE = required('ENGAGEMENT_PHASE3_ADMIN_TOKEN_FILE');
const MAIN_URL = process.env.ENGAGEMENT_PHASE3_MAIN_URL ?? 'http://127.0.0.1:4000';
const SHADOW_URL = process.env.ENGAGEMENT_PHASE3_ENGAGEMENT_URL ?? 'http://127.0.0.1:4500';

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

const DROP_KEYS = new Set(['time', 'timestamp', 'requestId', 'traceId']);
const MASK_KEYS =
  /^(createdAt|updatedAt|generatedAt|lastSyncedAt|expiresAt|signedUrl|uploadUrl|downloadUrl)$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

function normalize(value: unknown, key = ''): unknown {
  if (DROP_KEYS.has(key)) return undefined;
  if (MASK_KEYS.test(key)) return `<${key}>`;
  if (typeof value === 'string') {
    if (ISO.test(value) && (key === 'from' || key === 'to')) return `<${key}>`;
    if (/^https?:\/\//i.test(value) && /(?:X-Amz-|Signature=|sig=)/i.test(value)) {
      return '<signed-url>';
    }
    return value;
  }
  if (Array.isArray(value)) return value.map((row) => normalize(row));
  if (value && typeof value === 'object') {
    const output: Record<string, unknown> = {};
    for (const [childKey, child] of Object.entries(value as Record<string, unknown>)) {
      const normalized = normalize(child, childKey);
      if (normalized !== undefined) output[childKey] = normalized;
    }
    return output;
  }
  return value;
}

async function requestOne(base: string, relative: string, token: string, shadow: boolean) {
  const response = await fetch(`${base}${relative}`, {
    headers: { Authorization: `Bearer ${token}` },
    redirect: 'manual',
  });
  const text = await response.text();
  let body: unknown = text;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    // retain text
  }
  const service = response.headers.get('x-capiro-service');
  if (shadow && service !== 'engagement-api') {
    throw new Error(`${relative}: shadow response missing service identity`);
  }
  return { status: response.status, service, body: normalize(body) };
}

async function main(): Promise<void> {
  const [inventoryRaw, fixturesRaw, tokenRaw] = await Promise.all([
    readFile(INVENTORY_FILE, 'utf8'),
    readFile(FIXTURE_FILE, 'utf8'),
    readFile(TOKEN_FILE, 'utf8'),
  ]);
  const inventory = JSON.parse(inventoryRaw) as Inventory;
  const fixtures = JSON.parse(fixturesRaw) as Phase3FixtureIndex;
  const token = tokenRaw.trim();
  if (token.length < 20) throw new Error('Phase 3 bearer token file is empty or invalid');

  const reads = uniquePhase3Reads(inventory.requests);
  if (!reads.length) throw new Error('UI inventory contains no reads');

  const results: Array<Record<string, unknown>> = [];
  for (const request of reads) {
    if (request.method !== 'GET') {
      throw new Error(`Read classification is not GET: ${request.routeManifestKey}`);
    }
    const materialized = materializePhase3Read(request, fixtures);
    const [mainResult, shadowResult] = await Promise.all([
      requestOne(MAIN_URL, materialized.relative, token, false),
      requestOne(SHADOW_URL, materialized.relative, token, true),
    ]);
    const equal =
      mainResult.status === shadowResult.status &&
      JSON.stringify(mainResult.body) === JSON.stringify(shadowResult.body);
    const statusesAccepted =
      materialized.expectation.allowedStatuses.includes(mainResult.status) &&
      materialized.expectation.allowedStatuses.includes(shadowResult.status);

    results.push({
      surface: request.surface,
      routeManifestKey: request.routeManifestKey,
      relative: materialized.relative,
      bindings: materialized.bindings,
      expectation: materialized.expectation,
      mainStatus: mainResult.status,
      shadowStatus: shadowResult.status,
      equal,
    });

    if (!statusesAccepted) {
      throw new Error(
        `${request.routeManifestKey}: expected ${materialized.expectation.kind} status ` +
          `[${materialized.expectation.allowedStatuses.join(', ')}], got ` +
          `main=${mainResult.status} shadow=${shadowResult.status}`,
      );
    }
    if (!equal) throw new Error(`${request.routeManifestKey}: main/shadow body mismatch`);
  }

  const declaredAbsences = results.filter(
    (row) => (row.expectation as { kind?: string } | undefined)?.kind === 'declared_absence',
  );
  const dataReads = results.length - declaredAbsences.length;
  await writeFile(
    path.join(EVIDENCE, 'full-read-parity.json'),
    `${JSON.stringify(
      {
        marker: 'ENGAGEMENT_PHASE3_FULL_READ_PARITY_COMPLETE',
        uniqueReads: results.length,
        dataReads,
        declaredAbsences: declaredAbsences.length,
        syntheticNotFoundAccepted: false,
        results,
      },
      null,
      2,
    )}\n`,
  );
  console.log(
    `ENGAGEMENT_PHASE3_FULL_READ_PARITY_COMPLETE uniqueReads=${results.length} ` +
      `data=${dataReads} declaredAbsence=${declaredAbsences.length}`,
  );
}

if (require.main === module) {
  void main().catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exit(1);
  });
}
