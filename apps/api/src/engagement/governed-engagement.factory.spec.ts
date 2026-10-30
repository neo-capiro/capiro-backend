import type { TenantContext } from '@capiro/shared';
import { ContextPersistenceBoundaryService } from '../context/context-persistence-boundary.service.js';
import { createGovernedEngagementService } from './governed-engagement.factory.js';

const ctx = { tenantId: 'tenant-1', userId: 'user-1' } as TenantContext;

function meetingContext() {
  return {
    resolve: jest
      .fn()
      .mockRejectedValue(
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
      withMeetingSeams({}) as never,
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
