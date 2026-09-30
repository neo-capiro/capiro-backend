import {
  openDurableResearchResult,
  researchJsonSha256,
  researchToolVersion,
  sealDurableResearchResult,
} from './meri-research-durable-result';

describe('durable research safe-read result envelope', () => {
  const base = {
    executionId: 'execution-1',
    providerCallId: 'provider-call-1',
    runId: 'run-1',
    leaseEpoch: 4,
    tool: 'search_memory',
    toolVersion: 'sha256:tool-version',
    classifier: 'complete' as const,
    input: { query: 'FY27 radar', nested: { clientId: 'client-1' } },
    completedAt: '2026-09-28T00:00:00.000Z',
  };

  it('preserves the complete JSON owner payload and verifies every hash', () => {
    const result = {
      tool: 'search_memory',
      contentStatus: 'complete',
      records: [
        { id: 'a', body: 'full body — αβγ', nested: { values: [1, 2, 3] } },
        { id: 'b', body: 'second full body\nwith newline' },
      ],
      coverage: { complete: true, paginationComplete: true },
      longText: 'x'.repeat(32_000),
    };
    const sealed = sealDurableResearchResult({ ...base, result });
    const opened = openDurableResearchResult(sealed.body, sealed.bodySha256);

    expect(opened.input).toEqual(base.input);
    expect(opened.result).toEqual(result);
    expect(opened.inputSha256).toBe(researchJsonSha256(base.input));
    expect(opened.resultSha256).toBe(researchJsonSha256(result));
    expect(Buffer.byteLength(sealed.body, 'utf8')).toBe(sealed.byteSize);
  });

  it('rejects corruption and payloads above the bounded storage contract', () => {
    const sealed = sealDurableResearchResult({ ...base, result: { ok: true } });
    expect(() => openDurableResearchResult(`${sealed.body} `, sealed.bodySha256)).toThrow(
      'hash mismatch',
    );
    expect(() =>
      sealDurableResearchResult({ ...base, result: { body: 'x'.repeat(1_100_000) } }),
    ).toThrow('durable replay limit');
  });

  it('uses canonical schema content rather than object insertion order for tool version identity', () => {
    expect(researchToolVersion({ type: 'object', properties: { b: {}, a: {} } })).toBe(
      researchToolVersion({ properties: { a: {}, b: {} }, type: 'object' }),
    );
  });
});
