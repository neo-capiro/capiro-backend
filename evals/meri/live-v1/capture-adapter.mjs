import { frozenFixture } from './fixture.mjs';

export const CAPTURE_ADAPTER_VERSION = 'artifact-offline-v2';

export function createCaptureEnvelope({ contract, runManifest, artifactRoot, ownerSha256, captures = [] }) {
  if (!contract || !runManifest) throw new TypeError('contract and runManifest are required');
  if (typeof artifactRoot !== 'string' || typeof ownerSha256 !== 'string') throw new TypeError('artifactRoot and ownerSha256 are required');
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

export function executeLiveCase() {
  throw new Error('NOT_IMPLEMENTED: this foundation does not implement auth, network, browser, provider, fault, or write execution');
}
