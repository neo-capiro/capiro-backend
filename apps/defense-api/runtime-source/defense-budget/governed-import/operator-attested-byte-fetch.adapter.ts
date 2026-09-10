/**
 * Phase 10B-18 Part F/I — operator-attested byte source for the EXISTING
 * `ObservationIngestionBridgeService`.
 *
 * The bridge's first-time ("changed" -> "ingested") path always calls
 * `ObservationByteFetchPort.fetchFullBytes({ url })` to acquire the exact
 * bytes it will archive, register and hand to the parser. For a live-fetch
 * observation that means an HTTP GET; for a governed import the bytes were
 * already obtained by an operator (because the live fetch is blocked — see
 * the Phase 10B-17/10B-18 Akamai findings) and already passed every check in
 * `governed-source-import.validation.ts`.
 *
 * This adapter satisfies the exact same port with those pre-validated bytes
 * instead of a network call, so `ObservationIngestionBridgeService.bridge()`
 * runs COMPLETELY UNMODIFIED for a governed import: same SHA re-verification
 * (`fetched.contentSha256 !== observation.contentSha256`), same
 * `RawArchiveService`, same `DocumentRegistrar`, same parser/verifier
 * handoff. Nothing downstream of observation creation can tell the
 * difference — which is the whole point (Part I: "no verifier exemption, no
 * promotion exemption").
 *
 * Deliberately single-use and single-URL: constructed fresh for the one
 * observation a governed import is processing, and refuses (rather than
 * silently serving stale bytes) if the bridge ever asks for a different URL
 * than the one it was built for — that would mean the observation row and
 * this adapter disagree about what is being imported, a bug this must
 * surface loudly rather than paper over.
 */
import { createHash } from 'node:crypto';

import type {
  FetchedObservationBytes,
  ObservationByteFetchFailure,
  ObservationByteFetchPort,
} from '../observation-ingestion-bridge.ports.js';

export class OperatorAttestedByteFetchPort implements ObservationByteFetchPort {
  constructor(
    private readonly expectedUrl: string,
    private readonly bytes: Buffer,
  ) {}

  async fetchFullBytes(input: { url: string }): Promise<FetchedObservationBytes | ObservationByteFetchFailure> {
    if (input.url !== this.expectedUrl) {
      return {
        blocked: true,
        reason:
          `OperatorAttestedByteFetchPort was constructed for ${this.expectedUrl} but the bridge ` +
          `requested ${input.url}; refusing to serve the wrong observation's bytes`,
      };
    }
    return {
      bytes: this.bytes,
      contentSha256: createHash('sha256').update(this.bytes).digest('hex'),
      byteSize: this.bytes.byteLength,
    };
  }
}
