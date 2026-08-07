#!/usr/bin/env tsx
/**
 * UI-aware live preview acceptance runner (micro-session 2.12/2.18).
 *
 * A safe-read pass requires authenticated 2xx responses from BOTH main and
 * preview, exact normalized-body equality, exact preview service identity, and
 * the exact deployed release SHA. Matching 401/404/500 responses can never pass.
 *
 * Shadow-denial probes additionally require the route-guard boundary header.
 * That proves the controller/service/provider was not entered, which makes the
 * manifest's no-queued-work and no-provider-call assertions executable rather
 * than aspirational booleans.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  type ProbeContract,
  type ProbeManifestContract,
  type ResponseSnapshot,
  type RouteProbeContract,
  validateMissingAuthSnapshots,
  validateProbeManifestContract,
  validateSafeReadSnapshots,
  validateShadowDenialSnapshot,
} from '../src/engagement/runtime/engagement-phase2-preview-parity.contract.js';

interface Probe extends ProbeContract {
  stateLabel: string;
  probeClass:
    | 'safe_read_get_probe'
    | 'safe_local_write_probe'
    | 'shadow_denial_probe'
    | 'not_called_assertion'
    | 'future_phase_assertion'
    | 'prototype_only_assertion';
  routeProbes: RouteProbeContract[];
  sensitiveScopes: string[];
}

interface ProbeManifest extends ProbeManifestContract {
  capabilityManifestSha256: string;
  probes: Probe[];
  report: Record<string, unknown>;
}

interface ProbeResult {
  stateId: string;
  probeClass: Probe['probeClass'];
  route?: string;
  outcome: 'pass' | 'fail' | 'not_probed';
  status?: number;
  mainBodyHash?: string;
  previewBodyHash?: string;
  tenantAssertionMatched?: boolean;
  noQueuedWorkProven?: boolean;
  noProviderCallProven?: boolean;
  detail?: string;
}

const REPO_ROOT = path.resolve(__dirname, '../../..');
const PROBE_MANIFEST_PATH = path.join(
  REPO_ROOT,
  'apps/api/src/engagement/__fixtures__/outreach-v3-preview-probe-manifest.v1.json',
);
const PREVIEW_HEADER_NAME = process.env.PREVIEW_HEADER_NAME ?? 'X-Capiro-Engagement-Preview';
const PREVIEW_HEADER_VALUE = process.env.PREVIEW_HEADER_VALUE ?? 'v3';
const EXPECTED_SERVICE_HEADER = process.env.EXPECTED_SERVICE_HEADER ?? 'engagement-api';

function loadManifest(): ProbeManifest {
  return JSON.parse(readFileSync(PROBE_MANIFEST_PATH, 'utf8')) as ProbeManifest;
}

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function normalizeOrigin(value: string): string {
  return value.replace(/\/+$/, '');
}

function tenantIdHash(tenantId: string): string {
  return createHash('sha256').update(tenantId).digest('hex');
}

/** Never let a sensitive-scoped body or the bearer token reach a log line. */
function redact(probe: Probe, value: unknown): string {
  if (probe.sensitiveScopes.length > 0) return '[redacted: sensitive scope]';
  return JSON.stringify(value).slice(0, 200);
}

function substitutePathParams(routePath: string): string {
  return routePath.replace(/:([A-Za-z]+)/g, (_match, name: string) => {
    const value = process.env[`TEST_${name.toUpperCase()}`];
    if (!value) {
      throw new Error(`no TEST_${name.toUpperCase()} fixture ID configured for path ${routePath}`);
    }
    return encodeURIComponent(value);
  });
}

async function snapshot(response: Response): Promise<ResponseSnapshot> {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, name) => {
    headers[name.toLowerCase()] = value;
  });
  return { status: response.status, headers, bodyText: await response.text() };
}

async function requestSnapshot(
  url: string,
  init: RequestInit,
): Promise<ResponseSnapshot> {
  return snapshot(await fetch(url, init));
}

function failureResult(
  probe: Probe,
  route: RouteProbeContract,
  detail: string,
  extra: Partial<ProbeResult> = {},
): ProbeResult {
  return {
    stateId: probe.stateId,
    probeClass: probe.probeClass,
    route: route.path,
    outcome: 'fail',
    detail: redact(probe, detail),
    ...extra,
  };
}

async function probeSafeRead(input: {
  probe: Probe;
  route: RouteProbeContract;
  origin: string;
  previewOrigin: string;
  bearer: string;
  expectedReleaseSha: string;
  tenantAssertionText: string;
}): Promise<ProbeResult> {
  const resolvedPath = substitutePathParams(input.route.path);
  const authHeaders = { Authorization: `Bearer ${input.bearer}` };
  const main = await requestSnapshot(`${input.origin}${resolvedPath}`, {
    method: input.route.method,
    headers: authHeaders,
  });
  const preview = await requestSnapshot(`${input.previewOrigin}${resolvedPath}`, {
    method: input.route.method,
    headers: {
      ...authHeaders,
      [PREVIEW_HEADER_NAME]: PREVIEW_HEADER_VALUE,
    },
  });

  const validation = validateSafeReadSnapshots({
    main,
    preview,
    expectedServiceHeader: EXPECTED_SERVICE_HEADER,
    expectedReleaseSha: input.expectedReleaseSha,
    tenantAssertionText: input.tenantAssertionText,
  });
  if (validation.failures.length > 0) {
    return failureResult(input.probe, input.route, validation.failures.join('; '), {
      status: preview.status,
      mainBodyHash: validation.mainBodyHash,
      previewBodyHash: validation.previewBodyHash,
      tenantAssertionMatched: validation.tenantAssertionMatched,
    });
  }

  if (input.route.authParityRequired) {
    const mainNoAuth = await requestSnapshot(`${input.origin}${resolvedPath}`, {
      method: input.route.method,
    });
    const previewNoAuth = await requestSnapshot(`${input.previewOrigin}${resolvedPath}`, {
      method: input.route.method,
      headers: { [PREVIEW_HEADER_NAME]: PREVIEW_HEADER_VALUE },
    });
    const authValidation = validateMissingAuthSnapshots({
      main: mainNoAuth,
      preview: previewNoAuth,
      expectedServiceHeader: EXPECTED_SERVICE_HEADER,
      expectedReleaseSha: input.expectedReleaseSha,
    });
    if (authValidation.failures.length > 0) {
      return failureResult(input.probe, input.route, authValidation.failures.join('; '), {
        status: preview.status,
        mainBodyHash: validation.mainBodyHash,
        previewBodyHash: validation.previewBodyHash,
        tenantAssertionMatched: validation.tenantAssertionMatched,
      });
    }
  }

  return {
    stateId: input.probe.stateId,
    probeClass: input.probe.probeClass,
    route: input.route.path,
    outcome: 'pass',
    status: preview.status,
    mainBodyHash: validation.mainBodyHash,
    previewBodyHash: validation.previewBodyHash,
    tenantAssertionMatched: validation.tenantAssertionMatched,
  };
}

async function probeShadowDenial(input: {
  probe: Probe;
  route: RouteProbeContract;
  previewOrigin: string;
  bearer: string;
  expectedReleaseSha: string;
}): Promise<ProbeResult> {
  const resolvedPath = substitutePathParams(input.route.path);
  const headers: Record<string, string> = {
    Authorization: `Bearer ${input.bearer}`,
    [PREVIEW_HEADER_NAME]: PREVIEW_HEADER_VALUE,
    'Content-Type': 'application/json',
  };
  const init: RequestInit = { method: input.route.method, headers };
  if (!['GET', 'HEAD'].includes(input.route.method)) init.body = '{}';

  const preview = await requestSnapshot(`${input.previewOrigin}${resolvedPath}`, init);
  const validation = validateShadowDenialSnapshot({
    preview,
    route: input.route,
    expectedServiceHeader: EXPECTED_SERVICE_HEADER,
    expectedReleaseSha: input.expectedReleaseSha,
  });
  if (validation.failures.length > 0) {
    return failureResult(input.probe, input.route, validation.failures.join('; '), {
      status: preview.status,
      previewBodyHash: validation.previewBodyHash,
      noQueuedWorkProven: validation.noQueuedWorkProven,
      noProviderCallProven: validation.noProviderCallProven,
    });
  }
  return {
    stateId: input.probe.stateId,
    probeClass: input.probe.probeClass,
    route: input.route.path,
    outcome: 'pass',
    status: preview.status,
    previewBodyHash: validation.previewBodyHash,
    noQueuedWorkProven: validation.noQueuedWorkProven,
    noProviderCallProven: validation.noProviderCallProven,
  };
}

async function main(): Promise<void> {
  const manifest = loadManifest();
  const args = process.argv.slice(2);

  if (args.includes('--self-check')) {
    const { failures, summary } = validateProbeManifestContract(manifest);
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

  const origin = normalizeOrigin(requireEnv('APP_ORIGIN'));
  const previewOrigin = normalizeOrigin(process.env.PREVIEW_APP_ORIGIN?.trim() || origin);
  const bearer = requireEnv('TEST_BEARER_TOKEN');
  const tenantId = requireEnv('TEST_TENANT_ID');
  const tenantAssertionText = requireEnv('TEST_TENANT_ASSERTION_TEXT');
  const expectedReleaseSha = requireEnv('EXPECTED_RELEASE_SHA');
  if (!/^[0-9a-f]{40}$/i.test(expectedReleaseSha)) {
    throw new Error('EXPECTED_RELEASE_SHA must be an exact 40-character Git SHA');
  }

  const results: ProbeResult[] = [];
  for (const probe of manifest.probes) {
    if (probe.routeProbes.length === 0) {
      results.push({
        stateId: probe.stateId,
        probeClass: probe.probeClass,
        outcome: 'not_probed',
      });
      continue;
    }
    for (const route of probe.routeProbes) {
      try {
        if (
          probe.probeClass === 'safe_read_get_probe' ||
          probe.probeClass === 'safe_local_write_probe'
        ) {
          results.push(
            await probeSafeRead({
              probe,
              route,
              origin,
              previewOrigin,
              bearer,
              expectedReleaseSha,
              tenantAssertionText,
            }),
          );
        } else if (probe.probeClass === 'shadow_denial_probe') {
          results.push(
            await probeShadowDenial({
              probe,
              route,
              previewOrigin,
              bearer,
              expectedReleaseSha,
            }),
          );
        }
      } catch (error) {
        results.push(
          failureResult(probe, route, error instanceof Error ? error.message : String(error)),
        );
      }
    }
  }

  const safeResults = results.filter(
    (result) =>
      result.probeClass === 'safe_read_get_probe' ||
      result.probeClass === 'safe_local_write_probe',
  );
  if (!safeResults.some((result) => result.tenantAssertionMatched === true)) {
    results.push({
      stateId: 'tenant-assertion',
      probeClass: 'safe_read_get_probe',
      outcome: 'fail',
      detail:
        'No authenticated safe-read response contained TEST_TENANT_ASSERTION_TEXT in both main and preview; tenant fixture binding was not proven.',
    });
  }

  const evidenceDir = path.join(REPO_ROOT, '.artifacts/engagement-phase2/preview-parity');
  mkdirSync(evidenceDir, { recursive: true });
  writeFileSync(
    path.join(evidenceDir, 'preview-parity-results.json'),
    `${JSON.stringify(
      {
        prototypeSha256: manifest.prototypeSha256,
        capabilityManifestSha256: manifest.capabilityManifestSha256,
        expectedReleaseSha,
        tenantIdSha256: tenantIdHash(tenantId),
        tenantAssertionProven: results.some((result) => result.tenantAssertionMatched === true),
        results,
      },
      null,
      2,
    )}\n`,
  );

  const failed = results.filter((result) => result.outcome === 'fail');
  const notProbed = results.filter((result) => result.outcome === 'not_probed');
  console.log(
    `Probed: ${results.length - notProbed.length}  Not probed (documented gap): ${notProbed.length}`,
  );
  console.log(
    `Passed: ${results.filter((result) => result.outcome === 'pass').length}  Failed: ${failed.length}`,
  );
  for (const failure of failed) {
    console.error(`FAIL  ${failure.stateId} ${failure.route ?? ''}: ${failure.detail}`);
  }

  if (failed.length > 0) {
    console.error(`\nENGAGEMENT_PREVIEW_PARITY_FAILED (${failed.length})`);
    process.exit(2);
  }
  console.log('\nENGAGEMENT_PREVIEW_PARITY_PASSED');
}

void main().catch((error) => {
  console.error(`ERROR ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
