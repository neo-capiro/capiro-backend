import {
  appendDurableResearchStepReceipt,
  readDurableResearchStepReceipts,
} from './meri-research-durable-step.js';
import type { ResearchRunState } from './meri-research-run-state.js';

const run: ResearchRunState = {
  id: 'run-a',
  leaseEpoch: 4,
  eventSequence: 6,
  phase: 'research',
  status: 'running',
  stage: 'Gathering evidence',
  startedAt: new Date().toISOString(),
  heartbeatAt: new Date().toISOString(),
};

describe('durable research step receipts', () => {
  it('advances a monotonic event cursor without storing tool input or result bytes', () => {
    const appended = appendDurableResearchStepReceipt(
      { run },
      run,
      {
        receiptId: 'receipt-a',
        toolCallId: 'call-a',
        tool: 'search_congress_bills',
        label: 'Search Congress bills',
        status: 'complete',
        summary: '3 authorized records',
        completedAt: '2026-09-28T00:00:02.000Z',
      },
    );

    expect(appended.run.eventSequence).toBe(7);
    expect(appended.receipt).toMatchObject({
      receiptId: 'receipt-a',
      runId: 'run-a',
      leaseEpoch: 4,
      sequence: 7,
      effectClass: 'safe_read',
      toolCallId: 'call-a',
      status: 'complete',
    });
    expect(JSON.stringify(appended.metadata)).not.toContain('bearer');
    expect(JSON.stringify(appended.metadata)).not.toContain('inputFingerprint');
    expect(JSON.stringify(appended.metadata)).not.toContain('resultRef');
  });

  it('rejects a stale owner and ignores malformed persisted receipts', () => {
    expect(() =>
      appendDurableResearchStepReceipt(
        { run },
        { id: 'run-old', leaseEpoch: 3 },
        {
          receiptId: 'receipt-old',
          toolCallId: 'call-old',
          tool: 'search_congress_bills',
          label: 'Search Congress bills',
          status: 'complete',
          summary: 'stale',
          completedAt: '2026-09-28T00:00:02.000Z',
        },
      ),
    ).toThrow('lease is no longer active');
    expect(
      readDurableResearchStepReceipts({
        durableStepReceipts: [{ version: 1, receiptId: 'malformed' }],
      }),
    ).toEqual([]);
  });
});
