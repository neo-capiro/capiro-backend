import { createHash } from 'node:crypto';

export const ENGAGEMENT_RELEASE_SHA_HEADER = 'x-capiro-release-sha';
export const ENGAGEMENT_SERVICE_HEADER = 'x-capiro-service';
export const ENGAGEMENT_DENIAL_BOUNDARY_HEADER_LOWER =
  'x-capiro-engagement-denial-boundary';
export const ENGAGEMENT_ROUTE_GUARD_BOUNDARY = 'route-guard';

export interface ResponseSnapshot {
  status: number;
  headers: Record<string, string | null | undefined>;
  bodyText: string;
}

export interface RouteProbeContract {
  method: string;
  path: string;
  expectedShadowStatus: number | null;
  expectedShadowBody: string | null;
  expectedServiceHeader: string | null;
  authParityRequired: boolean;
  assertNoQueuedWork: boolean;
  assertNoProviderCall: boolean;
}

export interface ProbeContract {
  stateId: string;
  probeClass: string;
  routeProbes: RouteProbeContract[];
}

export interface ProbeManifestContract {
  schemaVersion: number;
  prototypeSha256: string;
  probeClasses: string[];
  probes: ProbeContract[];
}

export interface SnapshotValidation {
  failures: string[];
  mainBodyHash?: string;
  previewBodyHash?: string;
  tenantAssertionMatched?: boolean;
  noQueuedWorkProven?: boolean;
  noProviderCallProven?: boolean;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonicalize(child)]),
    );
  }
  return value;
}

export function normalizeResponseBody(bodyText: string): string {
  const trimmed = bodyText.trim();
  if (!trimmed) return '';
  try {
    return JSON.stringify(canonicalize(JSON.parse(trimmed) as unknown));
  } catch {
    return trimmed.replace(/\r\n/g, '\n');
  }
}

export function responseBodyHash(bodyText: string): string {
  return createHash('sha256').update(normalizeResponseBody(bodyText)).digest('hex');
}

function header(snapshot: ResponseSnapshot, name: string): string | null {
  const direct = snapshot.headers[name];
  if (direct != null) return String(direct);
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(snapshot.headers)) {
    if (key.toLowerCase() === lower && value != null) return String(value);
  }
  return null;
}

function validatePreviewIdentity(
  preview: ResponseSnapshot,
  expectedServiceHeader: string,
  expectedReleaseSha: string,
): string[] {
  const failures: string[] = [];
  const service = header(preview, ENGAGEMENT_SERVICE_HEADER);
  const releaseSha = header(preview, ENGAGEMENT_RELEASE_SHA_HEADER);
  if (service !== expectedServiceHeader) {
    failures.push(
      `X-Capiro-Service is ${JSON.stringify(service)}, expected ${JSON.stringify(expectedServiceHeader)}`,
    );
  }
  if (releaseSha !== expectedReleaseSha) {
    failures.push(
      `X-Capiro-Release-Sha is ${JSON.stringify(releaseSha)}, expected ${JSON.stringify(expectedReleaseSha)}`,
    );
  }
  return failures;
}

export function validateSafeReadSnapshots(input: {
  main: ResponseSnapshot;
  preview: ResponseSnapshot;
  expectedServiceHeader: string;
  expectedReleaseSha: string;
  tenantAssertionText: string;
}): SnapshotValidation {
  const failures = validatePreviewIdentity(
    input.preview,
    input.expectedServiceHeader,
    input.expectedReleaseSha,
  );

  if (input.main.status < 200 || input.main.status >= 300) {
    failures.push(`authenticated main safe read returned ${input.main.status}, expected 2xx`);
  }
  if (input.preview.status < 200 || input.preview.status >= 300) {
    failures.push(`authenticated preview safe read returned ${input.preview.status}, expected 2xx`);
  }
  if (input.main.status !== input.preview.status) {
    failures.push(
      `authenticated status mismatch: main=${input.main.status} preview=${input.preview.status}`,
    );
  }

  const normalizedMain = normalizeResponseBody(input.main.bodyText);
  const normalizedPreview = normalizeResponseBody(input.preview.bodyText);
  if (normalizedMain !== normalizedPreview) {
    failures.push('normalized authenticated response bodies differ');
  }

  const tenantAssertionMatched =
    input.tenantAssertionText.length > 0 &&
    input.main.bodyText.includes(input.tenantAssertionText) &&
    input.preview.bodyText.includes(input.tenantAssertionText);

  return {
    failures,
    mainBodyHash: responseBodyHash(input.main.bodyText),
    previewBodyHash: responseBodyHash(input.preview.bodyText),
    tenantAssertionMatched,
  };
}

export function validateMissingAuthSnapshots(input: {
  main: ResponseSnapshot;
  preview: ResponseSnapshot;
  expectedServiceHeader: string;
  expectedReleaseSha: string;
}): SnapshotValidation {
  const failures = validatePreviewIdentity(
    input.preview,
    input.expectedServiceHeader,
    input.expectedReleaseSha,
  );
  if (input.main.status !== input.preview.status) {
    failures.push(
      `missing-auth status mismatch: main=${input.main.status} preview=${input.preview.status}`,
    );
  }
  if (![401, 403].includes(input.main.status)) {
    failures.push(
      `missing-auth main response is ${input.main.status}, expected an authentication denial`,
    );
  }
  if (![401, 403].includes(input.preview.status)) {
    failures.push(
      `missing-auth preview response is ${input.preview.status}, expected an authentication denial`,
    );
  }
  return {
    failures,
    mainBodyHash: responseBodyHash(input.main.bodyText),
    previewBodyHash: responseBodyHash(input.preview.bodyText),
  };
}

export function validateShadowDenialSnapshot(input: {
  preview: ResponseSnapshot;
  route: RouteProbeContract;
  expectedServiceHeader: string;
  expectedReleaseSha: string;
}): SnapshotValidation {
  const failures = validatePreviewIdentity(
    input.preview,
    input.expectedServiceHeader,
    input.expectedReleaseSha,
  );
  if (input.preview.status !== input.route.expectedShadowStatus) {
    failures.push(
      `shadow status is ${input.preview.status}, expected ${String(input.route.expectedShadowStatus)}`,
    );
  }
  if (
    input.route.expectedShadowBody &&
    !input.preview.bodyText.includes(input.route.expectedShadowBody)
  ) {
    failures.push(`shadow body does not contain ${input.route.expectedShadowBody}`);
  }

  const boundary = header(input.preview, ENGAGEMENT_DENIAL_BOUNDARY_HEADER_LOWER);
  const boundaryProven = boundary === ENGAGEMENT_ROUTE_GUARD_BOUNDARY;
  if (!boundaryProven) {
    failures.push(
      `denial boundary is ${JSON.stringify(boundary)}, expected ${ENGAGEMENT_ROUTE_GUARD_BOUNDARY}`,
    );
  }

  const noQueuedWorkProven = !input.route.assertNoQueuedWork || boundaryProven;
  const noProviderCallProven = !input.route.assertNoProviderCall || boundaryProven;
  if (!noQueuedWorkProven) failures.push('no-queued-work assertion was not proven');
  if (!noProviderCallProven) failures.push('no-provider-call assertion was not proven');

  return {
    failures,
    previewBodyHash: responseBodyHash(input.preview.bodyText),
    noQueuedWorkProven,
    noProviderCallProven,
  };
}

export function validateProbeManifestContract(
  manifest: ProbeManifestContract,
): { failures: string[]; summary: Record<string, number> } {
  const failures: string[] = [];
  if (!/^[0-9a-f]{64}$/.test(manifest.prototypeSha256)) {
    failures.push('prototypeSha256 is malformed');
  }
  if (manifest.probes.length !== 62) {
    failures.push(`expected 62 probes, found ${manifest.probes.length}`);
  }

  const summary: Record<string, number> = {};
  for (const probe of manifest.probes) {
    summary[probe.probeClass] = (summary[probe.probeClass] ?? 0) + 1;
    if (!manifest.probeClasses.includes(probe.probeClass)) {
      failures.push(`${probe.stateId} has an unknown probe class ${probe.probeClass}`);
    }
    for (const route of probe.routeProbes) {
      if (probe.probeClass !== 'shadow_denial_probe') continue;
      if (route.expectedShadowStatus !== 503) {
        failures.push(`${probe.stateId} shadow route ${route.path} does not expect 503`);
      }
      if (route.expectedShadowBody !== 'ENGAGEMENT_EXTERNAL_ACTION_DISABLED') {
        failures.push(
          `${probe.stateId} shadow route ${route.path} does not require the exact denial code`,
        );
      }
      if (!route.assertNoQueuedWork) {
        failures.push(`${probe.stateId} shadow route ${route.path} does not assert no queued work`);
      }
      if (!route.assertNoProviderCall) {
        failures.push(`${probe.stateId} shadow route ${route.path} does not assert no provider call`);
      }
    }
  }
  return { failures, summary };
}
