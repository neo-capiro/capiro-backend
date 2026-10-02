import { writeControlledCaptureReceipt } from './controlled-capture-receipt.mjs';
import { readFileSync } from 'node:fs';
import { ArtifactCollector, verifyCollectedArtifacts } from './artifact-collector.mjs';
import {
  assertLiveCaptureReadiness,
  CaptureBlockedError,
  collectLiveReadCase,
} from './capture-transport.mjs';
import { frozenFixture } from './fixture.mjs';

const lock = JSON.parse(readFileSync(new URL('./contract-lock.json', import.meta.url), 'utf8'));

export const CAPTURE_ADAPTER_VERSION = 'live-read-capture-v1';

export function createCaptureEnvelope({
  contract,
  runManifest,
  artifactRoot,
  ownerSha256,
  captures = [],
}) {
  if (!contract || !runManifest) throw new TypeError('contract and runManifest are required');
  if (typeof artifactRoot !== 'string' || typeof ownerSha256 !== 'string')
    throw new TypeError('artifactRoot and ownerSha256 are required');
  if (!Array.isArray(captures)) throw new TypeError('captures must be an array');
  return {
    schemaVersion: 1,
    contract: {
      fixtureVersion: frozenFixture.version,
      fixtureSha256: contract.fixtureSha256,
      contractSourceSha256: contract.contractSourceSha256,
    },
    artifactRoot,
    ownerSha256,
    runManifest: {
      ...runManifest,
      captureAdapter: {
        name: 'meri-live-v1-starter-capture-adapter',
        version: CAPTURE_ADAPTER_VERSION,
        writeExecution: 'capture-only-live-adapter',
      },
    },
    captures,
  };
}

export async function executeLiveCase({
  config,
  caseId,
  runRoot,
  env = process.env,
  fetchImpl = fetch,
  controlledReceiptContext = null,
  artifactStorage = null,
}) {
  if (!config || typeof config !== 'object') throw new TypeError('config is required');
  if (typeof caseId !== 'string') throw new TypeError('caseId is required');
  if (typeof runRoot !== 'string') throw new TypeError('runRoot is required');
  if (typeof config.captureRunId !== 'string' || !config.captureRunId)
    throw new TypeError('config.captureRunId is required');

  try {
    assertLiveCaptureReadiness(config);
  } catch (error) {
    if (!(error instanceof CaptureBlockedError)) throw error;
    return {
      status: 'BLOCKED',
      acceptanceStatus: 'BLOCKED',
      acceptanceReason: error.message,
      reason: error.code,
      detail: error.detail,
      caseId,
      gaps: [],
      requestCount: 0,
      conversationId: null,
      synthesisSubmissionCount: 0,
      integrity: null,
    };
  }

  const secretValues = [
    env.MERI_LIVE_BEARER_TOKEN ?? '',
    controlledReceiptContext?.serviceSecret ?? '',
  ];
  const owner = {
    schemaVersion: 1,
    kind: 'meri-live-v1-read-capture',
    provenance: config.provenance ?? 'UNVALIDATED',
    captureRunId: config.captureRunId,
    caseId,
    fixtureVersion: frozenFixture.version,
    fixtureSha256: lock.fixtureSha256,
    contractSourceSha256: lock.contractSourceSha256,
    scopeMappingSha256: config.fixture?.mappingSha256 ?? null,
  };
  const collector = new ArtifactCollector(runRoot, owner, secretValues, {
    storage: artifactStorage,
  });
  await collector.init();
  await collector.writeJson('scope-config-receipt.json', config);
  let result;
  let requestIndex = 0;
  try {
    result = await collectLiveReadCase({
      config,
      caseId,
      env,
      fetchImpl,
      controlledReceiptContext,
      onControlledReceipt: (input) =>
        writeControlledCaptureReceipt({
          collector,
          ref: `cases/${caseId}/server-capture-receipt.json`,
          ...input,
        }),
      onExchange: async (exchange) => {
        requestIndex += 1;
        const prefix = `requests/${String(requestIndex).padStart(3, '0')}`;
        await collector.writeJson(`${prefix}-response.json`, {
          sequence: exchange.sequence,
          purpose: exchange.purpose,
          method: exchange.method,
          path: exchange.path,
          status: exchange.status,
          headers: exchange.headers,
          body: exchange.body,
        });
        await collector.writeJson(`${prefix}-timing.json`, {
          sequence: exchange.sequence,
          startedAt: exchange.startedAt,
          finishedAt: exchange.finishedAt,
          durationMs: exchange.durationMs,
        });
      },
    });
    await collector.writeText(`cases/${caseId}/answer.txt`, result.answer ?? '');
    await collector.writeText(
      `cases/${caseId}/events.ndjson`,
      `${(result.events ?? []).map((event) => JSON.stringify(event)).join('\n')}\n`,
    );
    await collector.writeJson(`cases/${caseId}/capture-links.json`, result.links ?? {});
    await collector.writeJson(`cases/${caseId}/capture-result.json`, {
      ...result,
      events: undefined,
      answer: undefined,
      links: undefined,
    });
  } catch (error) {
    if (!(error instanceof CaptureBlockedError)) throw error;
    result = {
      status: 'BLOCKED',
      acceptanceStatus: 'BLOCKED',
      acceptanceReason: error.message,
      reason: error.code,
      detail: error.detail,
      caseId,
      gaps: [],
      synthesisSubmissionCount: 0,
    };
    await collector.writeJson(`cases/${caseId}/blocked.json`, result);
  }
  const manifest = await collector.finalize({
    status: result.status,
    acceptanceStatus: result.acceptanceStatus,
    acceptanceReason: result.acceptanceReason,
    caseId,
    gaps: result.gaps ?? [],
  });
  const integrity = await verifyCollectedArtifacts(runRoot, { storage: artifactStorage });
  if (!integrity.valid)
    throw new Error(`collector artifact integrity failure: ${integrity.errors.join('; ')}`);
  return { ...result, manifest: manifest.manifest, integrity };
}
