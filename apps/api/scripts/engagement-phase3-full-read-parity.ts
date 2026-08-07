#!/usr/bin/env tsx
/**
 * Phase 3 full UI-inventory read parity.
 *
 * Browser replay proves the exact requests emitted by representative rendered
 * pages. This companion sweep prevents coverage from shrinking to only those
 * observed requests: every unique current UI request classified `read` is
 * materialized from deterministic fixture ids and must return real 2xx data
 * with normalized main/shadow equality. Matching synthetic 404s are rejected.
 */
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

interface InventoryRequest {
  method: string;
  requestPath: string;
  routeManifestKey: string;
  classification: 'read' | 'safe_local_write' | 'external_action';
  surface: string;
}

interface Inventory {
  requests: InventoryRequest[];
}

interface FixtureIndex {
  ids: Record<string, string>;
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

const SEGMENT_FIXTURES: Record<string, string[]> = {
  meetings: ['meeting.past', 'meeting'],
  tasks: ['task.todo', 'task'],
  outreach: ['outreach.draft', 'outreach'],
  attachments: ['attachment.meetingReady', 'attachment'],
  audiences: ['audience', 'outreachAudience'],
  microsoft: ['integration.microsoft', 'connection.microsoft', 'integration'],
  google: ['integration.google', 'connection.google', 'integration'],
  context: ['client.alpha', 'client'],
  clients: ['client.alpha', 'client'],
  notes: ['note.adminApproved', 'note'],
  debriefs: ['debrief.approved', 'debrief'],
  preps: ['prep.approved', 'prep'],
  artifacts: ['draftArtifact', 'outreachArtifact', 'artifact'],
  versions: ['draftVersion', 'outreachVersion', 'version'],
  'send-intents': ['sendIntent', 'outreachSendIntent'],
  deliveries: ['delivery', 'outreachDelivery'],
  'mail-threads': ['mailThread', 'mail.thread'],
  'mail-messages': ['mailMessage', 'mail.message'],
  templates: ['template', 'outreachTemplate'],
  contacts: ['contact', 'engagementContact'],
  outcomes: ['outcome'],
  campaigns: ['campaign'],
  recipients: ['recipient', 'outreachRecipient'],
};

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function firstFixture(ids: Record<string, string>, prefixes: string[]): string {
  for (const prefix of prefixes) {
    const match = Object.entries(ids).find(([key]) => key === prefix || key.startsWith(`${prefix}.`));
    if (match) return match[1];
  }
  throw new Error(`Fixture index has no id matching ${prefixes.join(' | ')}`);
}

/**
 * Materialize each `:param` from the segment immediately before it. Doing this
 * segment-by-segment matters for nested routes such as
 * `/campaigns/:param/recipients/:param`; a one-at-a-time string replacement can
 * accidentally reuse the first entity class for the second parameter and turn
 * the parity sweep into matching 404s.
 */
function materializePath(pathname: string, ids: Record<string, string>): string {
  const segments = pathname.split('/');
  return segments
    .map((segment, index) => {
      if (segment !== ':param') return segment;
      const ownerSegment = segments[index - 1] ?? '';
      const prefixes = SEGMENT_FIXTURES[ownerSegment];
      if (!prefixes) {
        throw new Error(`No deterministic fixture mapping for ${ownerSegment} in ${pathname}`);
      }
      return encodeURIComponent(firstFixture(ids, prefixes));
    })
    .join('/');
}

const DROP_KEYS = new Set(['time', 'timestamp', 'requestId', 'traceId']);
const MASK_KEYS = /^(createdAt|updatedAt|generatedAt|lastSyncedAt|expiresAt|signedUrl|uploadUrl|downloadUrl)$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

function normalize(value: unknown, key = ''): unknown {
  if (DROP_KEYS.has(key)) return undefined;
  if (MASK_KEYS.test(key)) return `<${key}>`;
  if (typeof value === 'string') {
    if (ISO.test(value) && (key === 'from' || key === 'to')) return `<${key}>`;
    if (/^https?:\/\//i.test(value) && /(?:X-Amz-|Signature=|sig=)/i.test(value)) return '<signed-url>';
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
  const fixtures = JSON.parse(fixturesRaw) as FixtureIndex;
  const token = tokenRaw.trim();
  if (token.length < 20) throw new Error('Phase 3 bearer token file is empty or invalid');

  const unique = new Map<string, InventoryRequest>();
  for (const request of inventory.requests.filter((row) => row.classification === 'read')) {
    unique.set(`${request.method} ${request.requestPath}`, request);
  }
  if (!unique.size) throw new Error('UI inventory contains no reads');

  const results: Array<Record<string, unknown>> = [];
  for (const request of unique.values()) {
    if (request.method !== 'GET') throw new Error(`Read classification is not GET: ${request.routeManifestKey}`);
    const relative = materializePath(request.requestPath, fixtures.ids);
    const [mainResult, shadowResult] = await Promise.all([
      requestOne(MAIN_URL, relative, token, false),
      requestOne(SHADOW_URL, relative, token, true),
    ]);
    const equal =
      mainResult.status === shadowResult.status &&
      JSON.stringify(mainResult.body) === JSON.stringify(shadowResult.body);
    results.push({
      surface: request.surface,
      routeManifestKey: request.routeManifestKey,
      relative,
      status: mainResult.status,
      equal,
    });
    if (
      mainResult.status < 200 ||
      mainResult.status >= 300 ||
      shadowResult.status < 200 ||
      shadowResult.status >= 300
    ) {
      throw new Error(
        `${request.routeManifestKey}: UI read must exercise real data, got main=${mainResult.status} shadow=${shadowResult.status}`,
      );
    }
    if (!equal) throw new Error(`${request.routeManifestKey}: main/shadow body mismatch`);
  }

  await writeFile(
    path.join(EVIDENCE, 'full-read-parity.json'),
    `${JSON.stringify(
      {
        marker: 'ENGAGEMENT_PHASE3_FULL_READ_PARITY_COMPLETE',
        uniqueReads: results.length,
        syntheticNotFoundAccepted: false,
        results,
      },
      null,
      2,
    )}\n`,
  );
  console.log(`ENGAGEMENT_PHASE3_FULL_READ_PARITY_COMPLETE uniqueReads=${results.length}`);
}

if (require.main === module) {
  void main().catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exit(1);
  });
}
