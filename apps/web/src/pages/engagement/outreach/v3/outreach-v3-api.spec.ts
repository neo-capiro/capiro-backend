import type { AxiosInstance } from 'axios';
import { describe, expect, it, vi } from 'vitest';
import {
  applyOutreachV3Proposal,
  getOutreachV3Strategy,
  listOutreachV3Proposals,
} from './outreach-v3-api.js';

function apiMock(input: {
  get?: unknown;
  post?: unknown;
}): AxiosInstance {
  return {
    get: vi.fn().mockResolvedValue({ data: input.get }),
    post: vi.fn().mockResolvedValue({ data: input.post }),
  } as unknown as AxiosInstance;
}

describe('Outreach V3 browser wire normalization', () => {
  it('maps stored commandsJsonb into visible proposal commands', async () => {
    const api = apiMock({
      get: [
        {
          id: 'proposal-1',
          sessionId: 'session-1',
          status: 'pending',
          expectedStateVersion: 6,
          commandsJsonb: [
            {
              type: 'SET_TONE',
              schemaVersion: 1,
              payload: { value: 'direct' },
            },
          ],
        },
      ],
    });
    const proposals = await listOutreachV3Proposals(api, 'session-1');
    expect(proposals).toHaveLength(1);
    expect(proposals[0]?.commands).toEqual([
      { type: 'SET_TONE', schemaVersion: 1, payload: { value: 'direct' } },
    ]);
  });

  it('unwraps the command result returned by proposal Apply', async () => {
    const result = {
      status: 'applied' as const,
      batchId: 'batch-1',
      stateVersion: 7,
      specHash: 'hash',
      changed: true,
      commandCount: 1,
      replayed: false,
    };
    const api = apiMock({ post: { proposalId: 'proposal-1', result } });
    await expect(applyOutreachV3Proposal(api, 'session-1', 'proposal-1')).resolves.toEqual(result);
  });

  it('normalizes the deterministic strategy capability for the UI', async () => {
    const api = apiMock({
      get: {
        capability: 'recommend_outreach_strategy',
        schemaVersion: 1,
        data: {
          recommendedPattern: 'uniform_separate',
          recommendedPersonalization: 'light',
          recommendedTone: 'direct',
          recommendedLength: 'short',
          rationale: ['Several targets should receive separately reviewable messages.'],
          unresolvedDecisions: ['Confirm the final ask.'],
          safetyNotes: ['Recommendations do not mutate campaign state.'],
        },
        provenance: [],
      },
    });
    const strategy = await getOutreachV3Strategy(api, 'session-1');
    expect(strategy.data).toMatchObject({
      tone: 'Direct',
      length: 'short',
      recommendedPattern: 'uniform_separate',
      recommendedPersonalization: 'light',
      rationale: ['Several targets should receive separately reviewable messages.'],
      warnings: ['Confirm the final ask.', 'Recommendations do not mutate campaign state.'],
    });
    expect(strategy.data.recommendation).toMatchObject({
      tone: 'Direct',
      length: 'short',
      recommendedPattern: 'uniform_separate',
      recommendedPersonalization: 'light',
    });
  });
});
