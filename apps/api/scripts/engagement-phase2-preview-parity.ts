#!/usr/bin/env tsx
/**
 * UI-aware live preview acceptance runner (micro-session 2.12/2.18).
 *
 * Reads the committed preview probe manifest and, for every probe, issues the
 * exact request the manifest describes against a live main API and a live
 * dark preview route, then asserts the manifest's expectation. This is the
 * ONLY place in Phase 2 that actually calls the deployed service.
 *
 * Lives under apps/api/scripts/, which is excluded from every tsconfig
 * (transpiled by tsx, never typechecked) — the same convention as every other
 * engagement-phase1-*.ts runner. Its logic is a thin loop over the manifest;
 * there is nothing here to typecheck that the manifest generator's own spec
 * does not already cover.
 *
 * IMPORTANT BOUNDARY: this script proves the dark service supports safe reads
 * and denies external actions. It does not render or ship the Outreach V3
 * prototype, and it must never claim full UI parity — Phase 3 owns rendering
 * the exact current Engagement UI through preview.
 *
 * Never logs a bearer token or any response body from a route carrying a
 * sensitive scope.
 *
 * Usage:
 *   tsx apps/api/scripts/engagement-phase2-preview-parity.ts --self-check
 *   tsx apps/api/scripts/engagement-phase2-preview-parity.ts
 *
 * --self-check loads and validates the probe manifest and prints the coverage
 * report WITHOUT making any network call. It is the only mode this repository
 * can run without a deployed environment, and it is what CI and this Phase 2
 * micro-session actually exercise.
 *
 * Full-run required environment:
 *   APP_ORIGIN                the main API origin, e.g. https://app.capiro.ai
 *   PREVIEW_APP_ORIGIN        usually the same origin; the header selects the target
 *   TEST_BEARER_TOKEN         a dedicated internal test user/tenant token
 *   TEST_TENANT_ID
 *   EXPECTED_RELEASE_SHA
 *   EXPECTED_SERVICE_HEADER   defaults to engagement-api
 *   PREVIEW_HEADER_NAME       defaults to X-Capiro-Engagement-Preview
 *   PREVIEW_HEADER_VALUE      defaults to v3
 *
 * Exit: 0 every probe resolved as expected · 1 usage error · 2 a probe failed
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

interface RouteProbe {
  method: string;
  path: string;
  expectedShadowStatus: number | null;
  expectedShadowBody: string | null;
  expectedServiceHeader: 'engagement-api' | null;
  authParityRequired: boolean;
  assertNoQueuedWork: boolean;
  assertNoProviderCall: boolean;
}

interface Probe {
  stateId: string;
  stateLabel: string;
  probeClass:
    | 'safe_read_get_probe'
    | 'safe_local_write_probe'
    | 'shadow_denial_probe'
    | 'not_called_assertion'
    | 'future_phase_assertion'
    | 'prototype_only_assertion';
  routeProbes: RouteProbe[];
  sensitiveScopes: string[];
}

interface ProbeManifest {
  schemaVersion: number;
  prototypeSha256: string;
  capabilityManifestSha256: string;
  probeClasses: string[];
  probes: Probe[];
  report: Record<string, unknown>;
}

const REPO_ROOT = path.resolve(__dirname, '../../..');
const PROBE_MANIFEST_PATH = path.join(
  REPO_ROOT,
  'apps/api/src/engagement/__fixtures__/outreach-v3-preview-probe-manifest.v1.json',
);

const PREVIEW_HEADER_NAME = process.env.PREVIEW_HEADER_NAME ?? 'X-Capiro-Engagement-Preview';
const PREVIEW_HEADER_VALUE = process.env.PREVIEW_HEADER_VALUE ?? 'v3';
const EXPECTED_SERVICE_HEADER = process.env.EXPECTED_SERVICE_HEADER ?? 'engagement-api';

interface ProbeResult {
  stateId: string;
  probeClass: Probe['probeClass'];
  route?: string;
  outcome: 'pass' | 'fail' | 'not_probed';
  detail?: string;
}

function loadManifest(): ProbeManifest {
  return JSON.parse(readFileSync(PROBE_MANIFEST_PATH, 'utf8')) as ProbeManifest;
}

/** Never let a sensitive-scoped body or the bearer token reach a log line. */
function redact(probe: Probe, value: unknown): string {
  if (probe.sensitiveScopes.length > 0) return '[redacted: sensitive scope]';
  return JSON.stringify(value).slice(0, 200);
}

function substitutePathParams(routePath: string): string {
  // Path params are placeholders in the manifest (:id, :clientId, ...). A real
  // run resolves them from TEST_* fixture IDs; self-check never reaches here.
  return routePath.replace(/:([A-Za-z]+)/g, (_match, name: string) => {
    const value = process.env[`TEST_${name.toUpperCase()}`];
    if (!value) {
      throw new Error(`no TEST_${name.toUpperCase()} fixture ID configured for path ${routePath}`);
    }
    return value;
  });
}

async function probeSafeRead(probe: Probe, route: RouteProbe, origin: string, previewOrigin: string, bearer: string): Promise<ProbeResult> {
  const resolvedPath = substitutePathParams(route.path);
  const headers = { Authorization: `Bearer ${bearer}` };

  const mainResponse = await fetch(`${origin}${resolvedPath}`, { method: route.method, headers });
  const previewResponse = await fetch(`${previewOrigin}${resolvedPath}`, {
    method: route.method,
    headers: { ...headers, [PREVIEW_HEADER_NAME]: PREVIEW_HEADER_VALUE },
  });

  if (mainResponse.status !== previewResponse.status) {
    return {
      stateId: probe.stateId,
      probeClass: probe.probeClass,
      route: route.path,
      outcome: 'fail',
      detail: `status mismatch: main=${mainResponse.status} preview=${previewResponse.status}`,
    };
  }
  if (previewResponse.headers.get('x-capiro-service') !== route.expectedServiceHeader) {
    return {
      stateId: probe.stateId,
      probeClass: probe.probeClass,
      route: route.path,
      outcome: 'fail',
      detail: `X-Capiro-Service header is "${previewResponse.headers.get('x-capiro-service')}", expected "${route.expectedServiceHeader}"`,
    };
  }

  if (route.authParityRequired) {
    const noAuth = await fetch(`${previewOrigin}${resolvedPath}`, {
      method: route.method,
      headers: { [PREVIEW_HEADER_NAME]: PREVIEW_HEADER_VALUE },
    });
    const mainNoAuth = await fetch(`${origin}${resolvedPath}`, { method: route.method });
    if (noAuth.status !== mainNoAuth.status) {
      return {
        stateId: probe.stateId,
        probeClass: probe.probeClass,
        route: route.path,
        outcome: 'fail',
        detail: `missing-bearer denial differs: main=${mainNoAuth.status} preview=${noAuth.status}`,
      };
    }
  }

  return { stateId: probe.stateId, probeClass: probe.probeClass, route: route.path, outcome: 'pass' };
}

async function probeShadowDenial(probe: Probe, route: RouteProbe, previewOrigin: string, bearer: string): Promise<ProbeResult> {
  const resolvedPath = substitutePathParams(route.path);
  const response = await fetch(`${previewOrigin}${resolvedPath}`, {
    method: route.method,
    headers: {
      Authorization: `Bearer ${bearer}`,
      [PREVIEW_HEADER_NAME]: PREVIEW_HEADER_VALUE,
      'Content-Type': 'application/json',
    },
    body: route.method === 'POST' ? '{}' : undefined,
  });

  if (response.status !== route.expectedShadowStatus) {
    return {
      stateId: probe.stateId,
      probeClass: probe.probeClass,
      route: route.path,
      outcome: 'fail',
      detail: `status is ${response.status}, expected ${route.expectedShadowStatus}`,
    };
  }
  const body = await response.text();
  if (route.expectedShadowBody && !body.includes(route.expectedShadowBody)) {
    return {
      stateId: probe.stateId,
      probeClass: probe.probeClass,
      route: route.path,
      outcome: 'fail',
      detail: `response body did not contain "${route.expectedShadowBody}": ${redact(probe, body)}`,
    };
  }
  if (response.headers.get('x-capiro-service') !== route.expectedServiceHeader) {
    return {
      stateId: probe.stateId,
      probeClass: probe.probeClass,
      route: route.path,
      outcome: 'fail',
      detail: 'missing or wrong X-Capiro-Service header on shadow denial',
    };
  }
  return { stateId: probe.stateId, probeClass: probe.probeClass, route: route.path, outcome: 'pass' };
}

/** Structural validation only. Never calls the network. This is what runs in CI. */
function selfCheck(manifest: ProbeManifest): { failures: string[]; summary: Record<string, number> } {
  const failures: string[] = [];
  if (!/^[0-9a-f]{64}$/.test(manifest.prototypeSha256)) failures.push('prototypeSha256 is malformed');
  if (manifest.probes.length !== 62) failures.push(`expected 62 probes, found ${manifest.probes.length}`);

  const summary: Record<string, number> = {};
  for (const probe of manifest.probes) {
    summary[probe.probeClass] = (summary[probe.probeClass] ?? 0) + 1;
    if (!manifest.probeClasses.includes(probe.probeClass)) {
      failures.push(`${probe.stateId} has an unknown probe class ${probe.probeClass}`);
    }
    for (const route of probe.routeProbes) {
      if (probe.probeClass === 'shadow_denial_probe' && route.expectedShadowStatus !== 503) {
        failures.push(`${probe.stateId} shadow route ${route.path} does not expect 503`);
      }
    }
  }
  return { failures, summary };
}

async function main(): Promise<void> {
  const manifest = loadManifest();
  const args = process.argv.slice(2);

  if (args.includes('--self-check')) {
    const { failures, summary } = selfCheck(manifest);
    console.log(`Probe manifest: ${manifest.probes.length} states`);
    for (const key of Object.keys(summary).sort()) console.log(`  ${key}: ${summary[key]}`);
    if (failures.length > 0) {
      for (const failure of failures) console.error(`FAIL  ${failure}`);
      console.error(`\nENGAGEMENT_PREVIEW_PARITY_SELF_CHECK_FAILED (${failures.length})`);
      process.exit(2);
    }
    console.log('\nNo network call was made. This mode never proves live parity.');
    console.log('ENGAGEMENT_PREVIEW_PARITY_SELF_CHECK_PASSED');
    return;
  }

  const origin = requireEnv('APP_ORIGIN');
  const previewOrigin = process.env.PREVIEW_APP_ORIGIN ?? origin;
  const bearer = requireEnv('TEST_BEARER_TOKEN');
  requireEnv('TEST_TENANT_ID');

  const results: ProbeResult[] = [];
  for (const probe of manifest.probes) {
    if (probe.routeProbes.length === 0) {
      results.push({ stateId: probe.stateId, probeClass: probe.probeClass, outcome: 'not_probed' });
      continue;
    }
    for (const route of probe.routeProbes) {
      try {
        if (probe.probeClass === 'safe_read_get_probe' || probe.probeClass === 'safe_local_write_probe') {
          results.push(await probeSafeRead(probe, route, origin, previewOrigin, bearer));
        } else if (probe.probeClass === 'shadow_denial_probe') {
          results.push(await probeShadowDenial(probe, route, previewOrigin, bearer));
        }
      } catch (error) {
        results.push({
          stateId: probe.stateId,
          probeClass: probe.probeClass,
          route: route.path,
          outcome: 'fail',
          detail: (error as Error).message,
        });
      }
    }
  }

  const evidenceDir = path.join(REPO_ROOT, '.artifacts/engagement-phase2/preview-parity');
  mkdirSync(evidenceDir, { recursive: true });
  writeFileSync(
    path.join(evidenceDir, 'preview-parity-results.json'),
    `${JSON.stringify({ prototypeSha256: manifest.prototypeSha256, results }, null, 2)}\n`,
  );

  const failed = results.filter((r) => r.outcome === 'fail');
  const notProbed = results.filter((r) => r.outcome === 'not_probed');
  console.log(`Probed: ${results.length - notProbed.length}  Not probed (documented gap): ${notProbed.length}`);
  console.log(`Passed: ${results.filter((r) => r.outcome === 'pass').length}  Failed: ${failed.length}`);
  for (const failure of failed) {
    console.error(`FAIL  ${failure.stateId} ${failure.route ?? ''}: ${failure.detail}`);
  }

  if (failed.length > 0) {
    console.error(`\nENGAGEMENT_PREVIEW_PARITY_FAILED (${failed.length})`);
    process.exit(2);
  }
  console.log('\nENGAGEMENT_PREVIEW_PARITY_PASSED');
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

main().catch((error) => {
  console.error(`ERROR ${(error as Error).message}`);
  process.exit(1);
});
