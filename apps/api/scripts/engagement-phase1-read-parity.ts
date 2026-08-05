/**
 * Engagement API Phase 1 — read parity checker.
 *
 * Sends the same authenticated read requests to both the main API (:4000)
 * and the engagement-api (:4500) and compares the responses.
 *
 * Environment variables:
 *   ENGAGEMENT_PHASE1_MAIN_URL       — main API base URL (default http://127.0.0.1:4000)
 *   ENGAGEMENT_PHASE1_ENGAGEMENT_URL — engagement-api base URL (default http://127.0.0.1:4500)
 *   ENGAGEMENT_PHASE1_USER_COOKIE    — authenticated session cookie
 *   ENGAGEMENT_PHASE1_EVIDENCE_DIR   — directory for evidence output
 *
 * This script is intentionally simple: it probes a set of safe read endpoints
 * and records the status codes + response shapes. A full parity suite would
 * use the Phase 0 route manifest to enumerate every read route.
 */
const MAIN_URL = process.env.ENGAGEMENT_PHASE1_MAIN_URL ?? 'http://127.0.0.1:4000';
const ENGAGEMENT_URL = process.env.ENGAGEMENT_PHASE1_ENGAGEMENT_URL ?? 'http://127.0.0.1:4500';
const EVIDENCE_DIR = process.env.ENGAGEMENT_PHASE1_EVIDENCE_DIR ?? '.artifacts/engagement-phase1';
const COOKIE = process.env.ENGAGEMENT_PHASE1_USER_COOKIE ?? '';

import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

const READ_ROUTES = [
  '/api/engagement/capabilities',
  '/api/engagement/meetings',
  '/api/engagement/reports',
  '/api/engagement/tasks',
  '/api/engagement/outreach',
  '/api/engagement/context',
  '/api/engagement/saved-audiences',
  '/api/engagement/attachments',
];

const AUTH_PROBES = [
  { label: 'missing-bearer', headers: {} },
  { label: 'invalid-bearer', headers: { Authorization: 'Bearer invalid-token' } },
  { label: 'wrong-tenant', headers: { Authorization: 'Bearer invalid-token', 'x-capiro-tenant': 'wrong' } },
];

async function main() {
  await mkdir(EVIDENCE_DIR, { recursive: true });
  const results = [];

  // Read parity
  for (const route of READ_ROUTES) {
    const mainRes = await probe(MAIN_URL, route, { Cookie: COOKIE });
    const engRes = await probe(ENGAGEMENT_URL, route, { Cookie: COOKIE });
    results.push({
      route,
      main: mainRes,
      engagement: engRes,
      parity: mainRes.status === engRes.status,
    });
  }

  // Auth/tenant parity
  const authResults = [];
  for (const probeData of AUTH_PROBES) {
    for (const route of ['/api/engagement/meetings']) {
      const mainRes = await probe(MAIN_URL, route, probeData.headers);
      const engRes = await probe(ENGAGEMENT_URL, route, probeData.headers);
      authResults.push({
        label: probeData.label,
        route,
        main: mainRes,
        engagement: engRes,
        parity: mainRes.status === engRes.status,
      });
    }
  }

  // External action denial matrix
  const denialResults = [];
  const externalRoutes = [
    { method: 'POST', route: '/api/engagement/integrations/microsoft/start', label: 'microsoft-oauth-start' },
    { method: 'POST', route: '/api/engagement/integrations/google/start', label: 'google-oauth-start' },
    { method: 'POST', route: '/api/engagement/meetings/test-id/prep', label: 'meeting-prep-generate' },
    { method: 'POST', route: '/api/engagement/outreach/generate', label: 'outreach-generate' },
    { method: 'POST', route: '/api/engagement/outreach/send', label: 'outreach-send' },
  ];
  for (const { method, route, label } of externalRoutes) {
    const engRes = await probe(ENGAGEMENT_URL, route, { Cookie: COOKIE }, method);
    denialResults.push({
      label,
      route,
      method,
      engagement: engRes,
      denied: engRes.status === 503,
    });
  }

  const output = {
    timestamp: new Date().toISOString(),
    mainUrl: MAIN_URL,
    engagementUrl: ENGAGEMENT_URL,
    readParity: results,
    authParity: authResults,
    externalActionDenials: denialResults,
  };

  await writeFile(
    path.join(EVIDENCE_DIR, 'read-parity.json'),
    JSON.stringify(output, null, 2) + '\n',
  );

  // Summary
  const allReadOk = results.every((r) => r.parity);
  const allAuthOk = authResults.every((r) => r.parity);
  const allDenialsOk = denialResults.every((r) => r.denied);

  console.log(`Read parity: ${results.filter((r) => r.parity).length}/${results.length} matched`);
  console.log(`Auth parity: ${authResults.filter((r) => r.parity).length}/${authResults.length} matched`);
  console.log(`External denials: ${denialResults.filter((r) => r.denied).length}/${denialResults.length} denied`);

  if (!allReadOk || !allAuthOk || !allDenialsOk) {
    console.error('Phase 1 read parity FAILED');
    process.exit(1);
  }
  console.log('Phase 1 read parity PASSED');
}

async function probe(baseUrl, route, headers, method = 'GET') {
  try {
    const res = await fetch(`${baseUrl}${route}`, { method, headers, redirect: 'manual' });
    const contentType = res.headers.get('content-type') ?? '';
    const serviceHeader = res.headers.get('x-capiro-service') ?? '';
    return {
      status: res.status,
      contentType,
      serviceHeader,
      ok: res.ok,
    };
  } catch (err) {
    return { status: 0, error: String(err) };
  }
}

main().catch((err) => {
  console.error('Read parity script failed:', err);
  process.exit(1);
});
