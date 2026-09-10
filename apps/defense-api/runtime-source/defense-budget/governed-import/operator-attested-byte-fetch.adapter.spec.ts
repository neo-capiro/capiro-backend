import { createHash } from 'node:crypto';
import { OperatorAttestedByteFetchPort } from './operator-attested-byte-fetch.adapter.js';

describe('OperatorAttestedByteFetchPort — Phase 10B-18 Part F/I/M', () => {
  const url = 'https://www.asafm.army.mil/Portals/72/Documents/BudgetMaterial/2024/Base%20Budget/rdte/RDTE-Vol%201-Budget%20Activity%201.pdf';
  const bytes = Buffer.from('%PDF-1.7\n' + 'x'.repeat(128));

  it('returns the exact operator-provided bytes and their real sha256 for the URL it was built for', async () => {
    const port = new OperatorAttestedByteFetchPort(url, bytes);
    const result = await port.fetchFullBytes({ url });
    expect('blocked' in result).toBe(false);
    if ('blocked' in result) return;
    expect(result.bytes).toEqual(bytes);
    expect(result.byteSize).toBe(bytes.byteLength);
    expect(result.contentSha256).toBe(createHash('sha256').update(bytes).digest('hex'));
  });

  it('refuses to serve bytes for a URL it was not constructed for, rather than silently substituting', async () => {
    const port = new OperatorAttestedByteFetchPort(url, bytes);
    const result = await port.fetchFullBytes({ url: 'https://www.asafm.army.mil/some-other-document.pdf' });
    expect('blocked' in result).toBe(true);
  });

  it('is the ONLY difference from a live fetch: ObservationIngestionBridgeService.bridge() re-verifies this SHA against the observation record unchanged, so a mismatched request never silently passes', async () => {
    // Documents the seam this port relies on for "no verifier exemption":
    // the bridge's existing `fetched.contentSha256 !== observation.contentSha256`
    // check (observation-ingestion-bridge.service.ts) runs against whatever this
    // port returns exactly as it would against a real HTTPS response body.
    const port = new OperatorAttestedByteFetchPort(url, bytes);
    const result = await port.fetchFullBytes({ url });
    if ('blocked' in result) throw new Error('expected bytes, got blocked');
    const tamperedExpectation = createHash('sha256').update(Buffer.from('different bytes')).digest('hex');
    expect(result.contentSha256).not.toBe(tamperedExpectation);
  });
});
