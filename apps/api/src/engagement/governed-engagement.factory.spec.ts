import type { TenantContext } from '@capiro/shared';
import { ContextPacketPersistenceError } from '@capiro/meriv2-core';
import { ContextPersistenceBoundaryService } from '../context/context-persistence-boundary.service.js';
import { createGovernedEngagementService } from './governed-engagement.factory.js';

const ctx = { tenantId: 'tenant-1', userId: 'user-1' } as TenantContext;

function compiler(result: unknown = { rendered: [] }) {
  return { compile: jest.fn().mockResolvedValue(result) };
}

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
      const service = createGovernedEngagementService(
        raw as never,
        boundary,
        compiler() as never,
      ) as unknown as {
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
    const service = createGovernedEngagementService(
      raw as never,
      boundary,
      compiler() as never,
    ) as unknown as {
      generateOutreachDraft: () => Promise<unknown>;
      generateBatchEmails: () => Promise<unknown>;
    };

    await expect(service.generateOutreachDraft()).resolves.toEqual({ ok: 'draft' });
    await expect(service.generateBatchEmails()).resolves.toEqual({ ok: 'batch' });
  });

  it('rethrows a required persistence failure from the context loader before generation', async () => {
    const boundary = new ContextPersistenceBoundaryService();
    const failure = new ContextPacketPersistenceError(
      'context_packet_error',
      'attempt-2',
      'outreach',
    );
    const contextCompiler = compiler();
    contextCompiler.compile.mockRejectedValueOnce(failure);
    const service = createGovernedEngagementService(
      {
        generateOutreachDraft: jest.fn(),
        generateBatchEmails: jest.fn(),
      } as never,
      boundary,
      contextCompiler as never,
    ) as unknown as {
      loadUserVoiceBlock: (value: TenantContext, clientId: string | null) => Promise<string | null>;
    };

    await expect(service.loadUserVoiceBlock(ctx, 'client-1')).rejects.toBe(failure);
  });

  it('retains the historical neutral fallback for an ordinary context outage', async () => {
    const contextCompiler = compiler();
    contextCompiler.compile.mockRejectedValueOnce(new Error('context temporarily unavailable'));
    const service = createGovernedEngagementService(
      {
        generateOutreachDraft: jest.fn(),
        generateBatchEmails: jest.fn(),
      } as never,
      new ContextPersistenceBoundaryService(),
      contextCompiler as never,
    ) as unknown as {
      loadUserVoiceBlock: (value: TenantContext, clientId: string | null) => Promise<string | null>;
    };

    await expect(service.loadUserVoiceBlock(ctx, 'client-1')).resolves.toBeNull();
  });

  it('composes the same voice, firm, strategy, and relationship labels', async () => {
    const contextCompiler = compiler({
      rendered: [
        { layer: 'user-voice', type: 'user-voice', body: 'Direct and concise.' },
        { layer: 'firm-identity', type: 'firm-soul', body: 'Trusted counsel.' },
        { layer: 'client-steering', type: 'client-compass', body: 'Protect the program.' },
        { layer: 'client-people', type: 'client-people', body: 'Commitment to follow up.' },
      ],
    });
    const service = createGovernedEngagementService(
      {
        generateOutreachDraft: jest.fn(),
        generateBatchEmails: jest.fn(),
      } as never,
      new ContextPersistenceBoundaryService(),
      contextCompiler as never,
    ) as unknown as {
      loadUserVoiceBlock: (value: TenantContext, clientId: string | null) => Promise<string | null>;
    };

    const block = await service.loadUserVoiceBlock(ctx, 'client-1');
    expect(block).toContain("WRITE IN THIS AUTHOR'S VOICE");
    expect(block).toContain('Firm identity (Firm Soul)');
    expect(block).toContain('Client strategic memory (client-compass)');
    expect(block).toContain('Client relationships & commitments');
  });
});
