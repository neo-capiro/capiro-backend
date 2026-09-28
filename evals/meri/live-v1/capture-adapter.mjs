import { frozenFixture } from './fixture.mjs';

export const CAPTURE_ADAPTER_VERSION = 'starter-schema-only-v1';

export function createCaptureEnvelope({ contract, runManifest, captures = [] }) {
  if (!contract || !runManifest) throw new TypeError('contract and runManifest are required');
  if (!Array.isArray(captures)) throw new TypeError('captures must be an array');
  return {
    schemaVersion: 1,
    contract: {
      fixtureVersion: frozenFixture.version,
      fixtureSha256: contract.fixtureSha256,
      contractSourceSha256: contract.contractSourceSha256,
    },
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
