import type { AxiosInstance } from 'axios';
import { describe, expect, it, vi } from 'vitest';
import {
  applyOutreachV3Proposal,
  getOutreachV3Strategy,
  getOutreachV3TargetRelationships,
  listOutreachV3Proposals,
  listOutreachV3Sessions,
  outreachV3CampaignBucket,
  safeOutreachV3Error,
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

  it('uses the session-scoped governed relationship endpoint without browser inference', async () => {
    const response = {
      capability: 'analyze_relationships',
      schemaVersion: 1,
      data: {
        targetKey: 'directory_staff:staff-1',
        clientId: '11111111-1111-4111-8111-111111111111',
        status: 'active',
        interactionCount: 3,
        meetingCount: 2,
        emailCount: 1,
        lastInteractionAt: '2026-08-01T12:00:00.000Z',
        recentInteractions: [],
        openCommitments: [],
        limitations: [],
      },
      provenance: [],
    };
    const api = apiMock({ post: response });
    const locator = { source: 'directory_staff', id: 'staff-1' };

    await expect(
      getOutreachV3TargetRelationships(
        api,
        'session-1',
        locator,
        '11111111-1111-4111-8111-111111111111',
      ),
    ).resolves.toEqual(response);

    expect(api.post).toHaveBeenCalledWith(
      '/api/engagement/outreach-v3/sessions/session-1/targets/relationships',
      {
        targetRef: locator,
        clientId: '11111111-1111-4111-8111-111111111111',
      },
    );
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

  it('lists owned sessions from GET /sessions with the home-screen fields', async () => {
    const api = apiMock({
      get: [
        {
          id: 'session-1',
          status: 'active',
          currentStateVersion: 3,
          title: 'New outreach campaign',
          updatedAt: '2026-08-17T12:00:00.000Z',
          topic: 'Ground Robotics',
          goal: 'Brief the subcommittee',
          targetCount: 12,
          recordStatus: 'sent',
          sentAt: '2026-08-17T13:00:00.000Z',
        },
      ],
    });
    const sessions = await listOutreachV3Sessions(api, { limit: 25 });
    expect(sessions).toEqual([
      {
        id: 'session-1',
        status: 'active',
        currentStateVersion: 3,
        title: 'New outreach campaign',
        updatedAt: '2026-08-17T12:00:00.000Z',
        topic: 'Ground Robotics',
        goal: 'Brief the subcommittee',
        targetCount: 12,
        recordStatus: 'sent',
        sentAt: '2026-08-17T13:00:00.000Z',
      },
    ]);
    expect(api.get).toHaveBeenCalledWith('/api/engagement/outreach-v3/sessions?limit=25');
  });

  it('never fabricates a target count or a send when the API omits those fields', async () => {
    // An older API build predating the enriched list must read as "0 targets,
    // no recorded send", not as a claimed send or an invented count.
    const api = apiMock({
      get: [
        {
          id: 'session-1',
          status: 'active',
          currentStateVersion: 1,
          title: 'New outreach campaign',
        },
      ],
    });
    const [session] = await listOutreachV3Sessions(api);
    expect(session).toMatchObject({
      topic: null,
      goal: null,
      targetCount: 0,
      recordStatus: null,
      sentAt: null,
    });
    expect(outreachV3CampaignBucket(session!)).toBe('draft');
  });

  describe('outreachV3CampaignBucket', () => {
    const row = (over: Record<string, unknown>) =>
      ({
        id: 's',
        status: 'active',
        currentStateVersion: 1,
        title: null,
        ...over,
      }) as Parameters<typeof outreachV3CampaignBucket>[0];

    it('reads Sent from the artifact-root record status, not the session status', () => {
      // No code path ever writes 'completed' to outreach_sessions.status, so
      // the session status can never be the send signal.
      expect(outreachV3CampaignBucket(row({ recordStatus: 'sent' }))).toBe('sent');
      expect(outreachV3CampaignBucket(row({ recordStatus: 'partial' }))).toBe('sent');
      expect(outreachV3CampaignBucket(row({ recordStatus: 'failed' }))).toBe('sent');
      expect(outreachV3CampaignBucket(row({ status: 'completed' }))).toBe('draft');
    });

    it('keeps a campaign that only reached the Send step a draft', () => {
      expect(outreachV3CampaignBucket(row({ recordStatus: 'draft' }))).toBe('draft');
      expect(outreachV3CampaignBucket(row({ recordStatus: null }))).toBe('draft');
    });

    it('buckets archived ahead of everything else', () => {
      expect(outreachV3CampaignBucket(row({ status: 'archived', recordStatus: 'sent' }))).toBe(
        'archived',
      );
    });
  });

  it('prefers server code/message over generic 503 wrap for OpenAI and shadow denials', () => {
    expect(
      safeOutreachV3Error({
        response: {
          status: 503,
          data: {
            code: 'OUTREACH_REASONING_PROVIDER_UNAVAILABLE',
            message: 'OpenAI reasoning is not available for this Capiro environment.',
          },
        },
      }),
    ).toMatch(/OpenAI reasoning is not available/i);

    expect(
      safeOutreachV3Error({
        response: {
          status: 503,
          data: {
            code: 'ENGAGEMENT_EXTERNAL_ACTION_DISABLED',
            message: 'This action is disabled in the engagement-api shadow runtime.',
          },
        },
      }),
    ).toMatch(/shadow runtime/i);

    // Bare 503 with no body still gets a diagnosable fallback.
    expect(
      safeOutreachV3Error({
        response: { status: 503, data: {} },
      }),
    ).toMatch(/OpenAI on engagement-api/i);
  });
});