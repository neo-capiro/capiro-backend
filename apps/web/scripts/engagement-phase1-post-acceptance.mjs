#!/usr/bin/env node
/**
 * Mandatory post-acceptance proof for Phase 1.
 *
 * The primary browser proof records request destinations and the primary API
 * parity proof exercises the entire manifest. This second pass closes two
 * false-green classes:
 *   1. a browser request that returned 401/403/404/5xx;
 *   2. read parity satisfied only because both services returned the same 404.
 *
 * It authenticates with the existing test session, replays every observed
 * browser GET, probes representative real seeded records through both APIs,
 * and classifies every non-2xx manifest read as an explicit not-found contract.
 */
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { connectChrome, createActor } from './phase19-cdp.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const require = createRequire(path.join(ROOT, 'apps/web/package.json'));
const chromeLauncher = require('chrome-launcher');
const args = parse(process.argv.slice(2));
const actualSha = required('ENGAGEMENT_PHASE1_EXPECTED_SHA', args.sha);
const evidence = path.resolve(
  ROOT,
  args.evidenceDir ?? `.artifacts/engagement-phase1-${actualSha}`,
);
const mainUrl = process.env.ENGAGEMENT_PHASE1_MAIN_URL ?? 'http://127.0.0.1:4000';
const shadowUrl =
  process.env.ENGAGEMENT_PHASE1_ENGAGEMENT_URL ?? 'http://127.0.0.1:4500';
const baseUrl = process.env.ENGAGEMENT_PHASE1_BASE_URL ?? 'http://127.0.0.1:5173';
const cookie = requiredAny('ENGAGEMENT_PHASE1_USER_COOKIE', 'ENGAGEMENT_PHASE0_USER_COOKIE');
const orgId = requiredAny('ENGAGEMENT_PHASE1_CLERK_ORG_ID', 'ENGAGEMENT_PHASE0_CLERK_ORG_ID');

const browserEvidence = JSON.parse(
  await readFile(path.join(evidence, 'browser-parity.json'), 'utf8'),
);
const readEvidence = JSON.parse(await readFile(path.join(evidence, 'read-parity.json'), 'utf8'));
const fixtures = JSON.parse(await readFile(path.join(evidence, 'fixtures.json'), 'utf8'));
const summaryPath = path.join(evidence, 'local-runner-summary.json');
const summary = JSON.parse(await readFile(summaryPath, 'utf8'));

if (summary.sha !== actualSha || summary.actualHeadSha !== actualSha) {
  throw new Error('Post-acceptance proof SHA does not match the primary summary');
}

await mkdir(path.join(evidence, 'screenshots'), { recursive: true });
const chrome = await chromeLauncher.launch({
  chromeFlags: ['--headless=new', '--no-sandbox', '--disable-gpu', '--window-size=1280,800'],
  startingUrl: 'about:blank',
});

try {
  const cdp = await connectChrome(chrome.port);
  const page = await createActor({
    cdp,
    label: 'engagement-phase1-post-acceptance',
    cookie,
    orgId,
    baseUrl,
    evidenceDir: path.join(evidence, 'screenshots'),
  });
  const token = await page.evaluate(`(async () => {
    const value = await window.Clerk?.session?.getToken({ template: 'capiro' });
    if (!value) throw new Error('Clerk capiro token unavailable');
    return value;
  })()`);
  if (typeof token !== 'string' || token.length < 20) {
    throw new Error('Post-acceptance browser did not produce an authenticated bearer token');
  }

  const browserReplays = await replayBrowserGets(token);
  const realReads = await proveRealSeededReads(token);
  const manifestClassification = classifyManifestReads();

  const proof = {
    marker: 'ENGAGEMENT_PHASE1_POST_ACCEPTANCE_COMPLETE',
    sha: actualSha,
    browserReplays,
    realReads,
    manifestClassification,
    browserResponsesSuccessful: true,
    realSeededReadParity: true,
    unmatchedManifestReads: 0,
    unclassifiedNon2xxReads: 0,
  };
  await writeFile(
    path.join(evidence, 'post-acceptance-proof.json'),
    `${JSON.stringify(proof, null, 2)}\n`,
  );
  await writeFile(
    summaryPath,
    `${JSON.stringify(
      {
        ...summary,
        browserResponsesVerified: true,
        realSeededReadParity: true,
        postAcceptanceMarker: proof.marker,
      },
      null,
      2,
    )}\n`,
  );
  console.log('ENGAGEMENT_PHASE1_POST_ACCEPTANCE_COMPLETE');
} finally {
  await chrome.kill();
}

async function replayBrowserGets(token) {
  const requests = (browserEvidence.states ?? [])
    .flatMap((state) => state.engagementRequests ?? [])
    .filter((request) => String(request.method ?? 'GET').toUpperCase() === 'GET');
  const unique = [...new Set(requests.map((request) => String(request.url)))];
  if (unique.length === 0) throw new Error('No browser GET requests were available to replay');
  const expectedHost = new URL(mainUrl).host;
  const results = [];
  for (const url of unique) {
    const parsed = new URL(url);
    if (parsed.host !== expectedHost || !parsed.pathname.startsWith('/api/engagement')) {
      throw new Error(`Observed browser request is outside the main Engagement API: ${url}`);
    }
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
      redirect: 'manual',
    });
    results.push({ url, status: response.status, contentType: mediaType(response) });
    if (response.status < 200 || response.status >= 400) {
      throw new Error(`Observed browser GET did not succeed: ${response.status} ${url}`);
    }
  }
  return { count: results.length, results };
}

async function proveRealSeededReads(token) {
  const meetingId = requiredFixture(fixtures.meetingIds?.current, 'meetingIds.current');
  const outreachId = requiredFixture(fixtures.outreachIds?.draft, 'outreachIds.draft');
  const campaignId = requiredFixture(fixtures.campaignId, 'campaignId');
  const clientId = requiredFixture(fixtures.clientIds?.[0], 'clientIds[0]');
  const contactId = requiredFixture(fixtures.contactIds?.[0], 'contactIds[0]');
  const taskId = requiredFixture(fixtures.taskId, 'taskId');
  const audienceId = requiredFixture(fixtures.audienceIds?.list, 'audienceIds.list');

  const probes = [
    { label: 'capabilities', path: '/api/engagement/capabilities' },
    { label: 'meetings-list-real', path: '/api/engagement/meetings', marker: meetingId },
    { label: 'meeting-detail-real', path: `/api/engagement/meetings/${meetingId}`, marker: meetingId },
    { label: 'meeting-library', path: '/api/engagement/meetings/library?limit=20' },
    { label: 'meeting-notes', path: `/api/engagement/meetings/${meetingId}/notes` },
    { label: 'meeting-debriefs', path: `/api/engagement/meetings/${meetingId}/debriefs` },
    { label: 'meeting-notetaker', path: `/api/engagement/meetings/${meetingId}/notetaker` },
    { label: 'contacts-real', path: '/api/engagement/contacts?limit=20', marker: contactId },
    { label: 'integrations', path: '/api/engagement/integrations' },
    { label: 'outreach-list-real', path: '/api/engagement/outreach', marker: outreachId },
    { label: 'outreach-detail-real', path: `/api/engagement/outreach/${outreachId}`, marker: outreachId },
    { label: 'outreach-templates', path: '/api/engagement/outreach/templates' },
    { label: 'outreach-ai-templates', path: '/api/engagement/outreach/ai-templates' },
    { label: 'outreach-context-library', path: '/api/engagement/outreach/context-library' },
    {
      label: 'outreach-audiences-real',
      path: '/api/engagement/outreach/audiences?kind=list',
      marker: audienceId,
    },
    {
      label: 'outreach-contact-data',
      path: `/api/engagement/outreach/outbound/contact-data?clientId=${clientId}`,
    },
    {
      label: 'outreach-insights',
      path: `/api/engagement/outreach/insights?clientId=${clientId}`,
    },
    { label: 'campaign-list-real', path: '/api/engagement/campaigns', marker: campaignId },
    { label: 'campaign-detail-real', path: `/api/engagement/campaigns/${campaignId}`, marker: campaignId },
    { label: 'tasks-real', path: '/api/engagement/tasks', marker: taskId },
    { label: 'reports-overview', path: '/api/engagement/reports/overview' },
    { label: 'client-context-real', path: `/api/engagement/context/${clientId}`, marker: clientId },
    { label: 'client-debriefs', path: `/api/engagement/debriefs?clientId=${clientId}` },
    { label: 'shared-meetings', path: `/api/engagement/shared-meetings?clientId=${clientId}` },
    { label: 'mail-threads', path: `/api/engagement/mail-threads?clientId=${clientId}` },
    { label: 'meeting-attachments', path: `/api/engagement/attachments?meetingId=${meetingId}` },
  ];

  const results = [];
  for (const definition of probes) {
    const [main, shadow] = await Promise.all([
      probe(mainUrl, definition.path, token),
      probe(shadowUrl, definition.path, token),
    ]);
    if (main.status < 200 || main.status >= 300) {
      throw new Error(`${definition.label} main API returned ${main.status}`);
    }
    if (shadow.status < 200 || shadow.status >= 300) {
      throw new Error(`${definition.label} shadow API returned ${shadow.status}`);
    }
    if (shadow.serviceHeader !== 'engagement-api') {
      throw new Error(`${definition.label} shadow response lacks service identity`);
    }
    if (
      main.contentType !== shadow.contentType ||
      JSON.stringify(main.body) !== JSON.stringify(shadow.body)
    ) {
      throw new Error(`${definition.label} real-record parity mismatch`);
    }
    const serialized = JSON.stringify(main.body);
    if (definition.marker && !serialized.includes(definition.marker)) {
      throw new Error(`${definition.label} did not contain seeded identity ${definition.marker}`);
    }
    results.push({
      label: definition.label,
      path: definition.path,
      status: main.status,
      contentType: main.contentType,
      markerVerified: Boolean(definition.marker),
      bodySha256: createHash('sha256').update(serialized).digest('hex'),
    });
  }
  return { count: results.length, results };
}

function classifyManifestReads() {
  const routes = readEvidence.routes ?? [];
  if (routes.length === 0) throw new Error('Primary read parity evidence is empty');
  const explicitNotFoundContracts = [
    /\/outreach\/jobs\//,
    /\/outreach\/send-intents\//,
    /\/outreach\/draft-versions\//,
    /\/outreach\/draft-artifacts\//,
    /\/meeting-preps\//,
  ];
  const successful = [];
  const notFoundContracts = [];
  const failures = [];

  for (const entry of routes) {
    if (entry.matched !== true) {
      failures.push({ route: entry.route, reason: 'primary parity mismatch' });
      continue;
    }
    const left = Number(entry.mainResult?.status);
    const right = Number(entry.engagementResult?.status);
    if (left >= 200 && left < 300 && right >= 200 && right < 300) {
      successful.push(entry.route);
      continue;
    }
    if (
      left === 404 &&
      right === 404 &&
      explicitNotFoundContracts.some((pattern) => pattern.test(String(entry.route)))
    ) {
      notFoundContracts.push(entry.route);
      continue;
    }
    failures.push({ route: entry.route, mainStatus: left, shadowStatus: right });
  }

  if (failures.length > 0) {
    throw new Error(`Unclassified non-2xx manifest reads: ${JSON.stringify(failures)}`);
  }
  return {
    total: routes.length,
    successful: successful.length,
    explicitNotFoundContracts: notFoundContracts.length,
    successfulRoutes: successful,
    notFoundContractRoutes: notFoundContracts,
  };
}

async function probe(base, pathname, token) {
  const response = await fetch(`${base}${pathname}`, {
    headers: { Authorization: `Bearer ${token}` },
    redirect: 'manual',
  });
  const contentType = mediaType(response);
  const text = await response.text();
  let body = text;
  if (contentType === 'application/json' && text) {
    body = JSON.parse(text);
  }
  return {
    status: response.status,
    contentType,
    serviceHeader: response.headers.get('x-capiro-service') ?? '',
    body: normalize(body),
  };
}

function normalize(value) {
  if (Array.isArray(value)) return value.map(normalize);
  if (!value || typeof value !== 'object') return value;
  const output = {};
  for (const [key, raw] of Object.entries(value)) {
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

function mediaType(response) {
  return (response.headers.get('content-type') ?? '').split(';')[0];
}

function requiredFixture(value, name) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Required fixture is missing: ${name}`);
  }
  return value;
}

function required(name, fallback) {
  const value = process.env[name]?.trim() || String(fallback ?? '').trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function requiredAny(...names) {
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (value) return value;
  }
  throw new Error(`One of ${names.join(', ')} is required`);
}

function parse(values) {
  const output = {};
  for (let index = 0; index < values.length; index += 1) {
    const arg = values[index];
    if (!arg.startsWith('--')) throw new Error(`Unexpected argument: ${arg}`);
    const [raw, inline] = arg.slice(2).split('=', 2);
    const key = raw.replace(/-([a-z])/g, (_match, character) => character.toUpperCase());
    const value = inline ?? values[++index];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for --${raw}`);
    output[key] = value;
  }
  return output;
}
