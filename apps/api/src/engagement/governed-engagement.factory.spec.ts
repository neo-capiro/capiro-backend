import { ContextPacketPersistenceError } from '@capiro/meriv2-core';
import { ContextPersistenceBoundaryService } from '../context/context-persistence-boundary.service.js';
import { createGovernedEngagementService } from './governed-engagement.factory.js';

describe('createGovernedEngagementService', () => {
  it.each(['generateOutreachDraft', 'generateBatchEmails'] as const)(
    'blocks %s after a swallowed required persistence failure',
    async (method) => {
      const boundary = new ContextPersistenceBoundaryService();
      const failure = new ContextPacketPersistenceError(
        'context_packet_error',
        'attempt-1',
        'outreach',
      );
      const raw = {
        generateOutreachDraft: jest.fn(async () => {
          boundary.record(failure);
          return { unsafe: true };
        }),
        generateBatchEmails: jest.fn(async () => {
          boundary.record(failure);
          return { unsafe: true };
        }),
      };
      const service = createGovernedEngagementService(raw as never, boundary) as unknown as {
        generateOutreachDraft: (...args: unknown[]) => Promise<unknown>;
        generateBatchEmails: (...args: unknown[]) => Promise<unknown>;
      };

      await expect(service[method]()).rejects.toBe(failure);
    },
  );

  it('returns successful results unchanged', async () => {
    const boundary = new ContextPersistenceBoundaryService();
    const raw = {
      generateOutreachDraft: jest.fn(async () => ({ ok: 'draft' })),
      generateBatchEmails: jest.fn(async () => ({ ok: 'batch' })),
    };
    const service = createGovernedEngagementService(raw as never, boundary) as unknown as {
      generateOutreachDraft: () => Promise<unknown>;
      generateBatchEmails: () => Promise<unknown>;
    };

    await expect(service.generateOutreachDraft()).resolves.toEqual({ ok: 'draft' });
    await expect(service.generateBatchEmails()).resolves.toEqual({ ok: 'batch' });
  });
});
