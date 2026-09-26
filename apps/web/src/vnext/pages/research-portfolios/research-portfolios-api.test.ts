import { describe, expect, it, vi } from 'vitest';
import type { AxiosInstance } from 'axios';
import {
  createResearchPortfolio,
  decideResearchPortfolioMember,
  removeResearchPortfolioGrant,
  updateResearchPortfolio,
  actOnResearchPortfolioImport,
  decideResearchPortfolioReview,
  actOnResearchPortfolioOutput,
  createResearchPortfolioOutput,
  createResearchPortfolioSnapshot,
  listResearchPortfolioChanges,
  saveResearchPortfolioOutputToClient,
  updateResearchPortfolioChangeState,
} from './research-portfolios-api.js';

const receipt = {
  portfolioId: '12345678-1234-4234-9234-123456789abc',
  eventId: 'event-1',
  actorUserId: 'user-1',
  occurredAt: '2026-09-26T00:00:00.000Z',
  resultingRevision: 2,
  replayed: false,
  outcomes: [],
};

function mockApi() {
  return {
    post: vi.fn().mockResolvedValue({ data: receipt }),
    patch: vi.fn().mockResolvedValue({ data: receipt }),
    put: vi.fn().mockResolvedValue({ data: receipt }),
    delete: vi.fn().mockResolvedValue({ data: receipt }),
    get: vi.fn().mockResolvedValue({ data: receipt }),
  } as unknown as AxiosInstance;
}

describe('research portfolio API mutation contract', () => {
  it('creates a manual collection with a generated idempotency key', async () => {
    const api = mockApi();
    await createResearchPortfolio(api, { name: 'Autonomy', purpose: 'Track autonomy', mode: 'manual' });
    expect(api.post).toHaveBeenCalledWith('/api/research-portfolios', expect.objectContaining({
      name: 'Autonomy',
      mode: 'manual',
      idempotencyKey: expect.stringMatching(/^research-portfolios:create:/),
    }));
  });

  it('preserves optimistic revision control for edits', async () => {
    const api = mockApi();
    await updateResearchPortfolio(api, receipt.portfolioId, { expectedRevision: 7, name: 'Updated' });
    expect(api.patch).toHaveBeenCalledWith(`/api/research-portfolios/${receipt.portfolioId}`, expect.objectContaining({
      expectedRevision: 7,
      idempotencyKey: expect.stringMatching(/^research-portfolios:update:/),
    }));
  });

  it('sends delete metadata in the Axios request body', async () => {
    const api = mockApi();
    await removeResearchPortfolioGrant(api, receipt.portfolioId, 'user-2', 8);
    expect(api.delete).toHaveBeenCalledWith(
      `/api/research-portfolios/${receipt.portfolioId}/grants/user-2`,
      { data: expect.objectContaining({ expectedRevision: 8, idempotencyKey: expect.any(String) }) },
    );
  });

  it('records auditable include/exclude decisions against one expected revision', async () => {
    const api = mockApi();
    await decideResearchPortfolioMember(api, receipt.portfolioId, {
      expectedRevision: 9,
      decisions: [{ memberId: 'member-1', disposition: 'excluded', reason: 'Outside scope' }],
    });
    expect(api.post).toHaveBeenCalledWith(
      `/api/research-portfolios/${receipt.portfolioId}/members/decisions`,
      expect.objectContaining({
        expectedRevision: 9,
        decisions: [{ memberId: 'member-1', disposition: 'excluded', reason: 'Outside scope' }],
        idempotencyKey: expect.stringMatching(/^research-portfolios:member-decision:/),
      }),
    );
  });

  it('keeps review and portfolio revisions separate for governed decisions', async () => {
    const api = mockApi();
    await decideResearchPortfolioReview(api, receipt.portfolioId, 'review-1', {
      expectedRevision: 3,
      expectedPortfolioRevision: 9,
      decisionType: 'dispute',
      reason: 'Conflicting evidence',
      evidenceAgainst: [{ sourceRevisionId: 'source-1', locator: { page: 2 }, quote: 'Conflict', stance: 'against' }],
    });
    expect(api.post).toHaveBeenCalledWith(
      `/api/research-portfolios/${receipt.portfolioId}/reviews/review-1/decision`,
      expect.objectContaining({ expectedRevision: 3, expectedPortfolioRevision: 9, idempotencyKey: expect.stringMatching(/review-decision/) }),
    );
  });

  it('uses a new durable operation key for every import action', async () => {
    const api = mockApi();
    await actOnResearchPortfolioImport(api, receipt.portfolioId, 'job-1', 'apply', { expectedRevision: 9 });
    expect(api.post).toHaveBeenCalledWith(
      `/api/research-portfolios/${receipt.portfolioId}/imports/job-1/apply`,
      expect.objectContaining({ expectedRevision: 9, operationKey: expect.stringMatching(/import-apply/) }),
    );
  });

  it('loads changes with a bounded cursor and keeps personal state revisions explicit', async () => {
    const api = mockApi();
    await listResearchPortfolioChanges(api, receipt.portfolioId, 'cursor-1', 25);
    expect(api.get).toHaveBeenCalledWith(
      `/api/research-portfolios/${receipt.portfolioId}/changes`,
      { params: { cursor: 'cursor-1', limit: 25 } },
    );
    await updateResearchPortfolioChangeState(api, receipt.portfolioId, 'event/1', {
      action: 'dismissed',
      expectedRevision: 3,
    });
    expect(api.patch).toHaveBeenCalledWith(
      `/api/research-portfolios/${receipt.portfolioId}/changes/event%2F1/state`,
      { action: 'dismissed', expectedRevision: 3 },
    );
  });

  it('creates an immutable snapshot with a fresh operation identity', async () => {
    const api = mockApi();
    await createResearchPortfolioSnapshot(api, receipt.portfolioId, {
      name: 'Committee mark',
      expectedRevision: 11,
    });
    expect(api.post).toHaveBeenCalledWith(
      `/api/research-portfolios/${receipt.portfolioId}/snapshots`,
      expect.objectContaining({
        name: 'Committee mark',
        expectedRevision: 11,
        operationKey: expect.stringMatching(/^research-portfolios:snapshot-create:/),
      }),
    );
  });

  it('uses durable output actions and an independently idempotent client-file write', async () => {
    const api = mockApi();
    await createResearchPortfolioOutput(api, receipt.portfolioId, {
      snapshotId: 'snapshot-1',
      selectedSections: ['analytics', 'sources'],
      includeSourceAppendix: true,
      format: 'csv',
    });
    expect(api.post).toHaveBeenCalledWith(
      `/api/research-portfolios/${receipt.portfolioId}/outputs`,
      expect.objectContaining({ operationKey: expect.stringMatching(/^research-portfolios:output-create:/) }),
    );
    await actOnResearchPortfolioOutput(api, receipt.portfolioId, 'job/1', 'reconcile');
    expect(api.post).toHaveBeenCalledWith(
      `/api/research-portfolios/${receipt.portfolioId}/output-jobs/job%2F1/reconcile`,
    );
    await saveResearchPortfolioOutputToClient(api, receipt.portfolioId, 'artifact/1', { clientId: 'client-1' });
    expect(api.post).toHaveBeenCalledWith(
      `/api/research-portfolios/${receipt.portfolioId}/outputs/artifact%2F1/client-files`,
      expect.objectContaining({
        clientId: 'client-1',
        operationKey: expect.stringMatching(/^research-portfolios:output-client-file:/),
      }),
    );
  });
});
