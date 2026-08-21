import type { TenantContext } from '@capiro/shared';
import { ContextPacketPersistenceError } from '@capiro/meriv2-core';
import { ContextPersistenceBoundaryService } from '../context/context-persistence-boundary.service.js';
import { createGovernedEngagementService } from './governed-engagement.factory.js';

const ctx = { tenantId: 'tenant-1', userId: 'user-1' } as TenantContext;

function compiler(result: unknown = { rendered: [] }) {
  return { compile: jest.fn().mockResolvedValue(result) };
}

function meetingContext() {
  return {
    resolve: jest.fn().mockRejectedValue(
      new Error('meeting Context Plane should not run in Outreach compatibility tests'),
    ),
  };
}

/**
 * Phase 24 binds the prep/debrief seams inside the factory, so every fake handed
 * to createGovernedEngagementService must expose them. These Outreach-focused
 * tests must never reach them; stubs that throw prove that rather than hiding it.
 */
function withMeetingSeams(raw: Record<string, unknown>): Record<string, unknown> {
  return {
    ...raw,
    generateMeetingPrep: jest.fn(async () => {
      throw new Error('meeting prep must not run in Outreach compatibility tests');
    }),
    generateMeetingDebriefDraft: jest.fn(async () => {
      throw new Error('meeting debrief must not run in Outreach compatibility tests');
    }),
  };
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
        withMeetingSeams(raw) as never,
        boundary,
        meetingContext() as never,
      ) as unknown as {
        generateOutreachDraft: (...args: unknown[]) => Promise<unknown>;
        generateBatchEmails: (...args: unknown[]) => Promise<unknown>;
      };

      await expect(service[method]()).rejects.toBe(failure);
    },
  );

  it('returns successful Outreach results unchanged', async () => {
    const boundary = new ContextPersistenceBoundaryService();
    const raw = {
      generateOutreachDraft: jest.fn(async () => ({ ok: 'draft' })),
      generateBatchEmails: jest.fn(async () => ({ ok: 'batch' })),
    };
    const service = createGovernedEngagementService(
      withMeetingSeams(raw) as never,
      boundary,
      meetingContext() as never,
    ) as unknown as {
      generateOutreachDraft: () => Promise<unknown>;
      generateBatchEmails: () => Promise<unknown>;
    };

    await expect(service.generateOutreachDraft()).resolves.toEqual({ ok: 'draft' });
    await expect(service.generateBatchEmails()).resolves.toEqual({ ok: 'batch' });
  });

  /**
   * Phase 26 retired the legacy Outreach generation path, so this loader is no
   * longer a compile seam. Three tests here used to pin its ContextCompiler
   * behaviour (persistence rethrow, neutral fallback, block labels); that
   * behaviour is intentionally gone. Outreach now resolves its own governed
   * packet inside GenerationGatewayService, and meeting runs get the shared
   * packet from the branch above. Reaching this loader outside a meeting run
   * would mean a provider call without governed context, so it fails closed.
   */
  it('fails closed outside a meeting run instead of compiling ungoverned context', async () => {
    const service = createGovernedEngagementService(
      withMeetingSeams({
        generateOutreachDraft: jest.fn(),
        generateBatchEmails: jest.fn(),
      }) as never,
      new ContextPersistenceBoundaryService(),
      meetingContext() as never,
    ) as unknown as {
      loadUserVoiceBlock: (value: TenantContext, clientId: string | null) => Promise<string | null>;
    };

    await expect(service.loadUserVoiceBlock(ctx, 'client-1')).rejects.toThrow(
      'phase26_engagement_context_plane_required',
    );
  });
});