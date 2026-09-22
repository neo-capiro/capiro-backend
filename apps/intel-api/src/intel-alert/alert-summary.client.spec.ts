import {
  AlertSummaryClient,
  buildDeterministicAlertNarrative,
  type AlertSummaryInput,
} from './alert-summary.client.js';

const input: AlertSummaryInput = {
  tenantId: 'tenant-1',
  displayNum: 'H.R. 8800',
  billTitle: 'National Defense Authorization Act for Fiscal Year 2027',
  label: 'Passed a chamber',
  actionText: 'On passage Passed by the Yeas and Nays: 216 - 212.',
  jurisdiction: 'US',
  chamber: 'House',
  actionDate: '2026-07-22',
  why: 'Matches the defense authorization watchlist.',
  matchedTags: ['defense', 'authorization'],
  allowedNextSteps: ['Referral in the other chamber'],
  blockedBy: [],
};

describe('buildDeterministicAlertNarrative', () => {
  it('combines source facts, local relevance, and verified chamber procedure', () => {
    expect(buildDeterministicAlertNarrative(input)).toBe(
      'H.R. 8800 — Passed a chamber (2026-07-22): On passage Passed by the Yeas and Nays: 216 - 212. Why it matters: Matches the defense authorization watchlist. Expected next step: Senate action.',
    );
  });

  it('keeps the deterministic procedure visible within the output bound', () => {
    const result = buildDeterministicAlertNarrative({
      ...input,
      actionText: 'Long source action. '.repeat(100),
    });
    expect(result.length).toBeLessThanOrEqual(640);
    expect(result).toContain('Expected next step: Senate action.');
  });
});

describe('AlertSummaryClient', () => {
  const oldSecret = process.env.INTERNAL_SERVICE_SECRET;
  const oldBaseUrl = process.env.API_BASE_URL;

  afterEach(() => {
    if (oldSecret === undefined) delete process.env.INTERNAL_SERVICE_SECRET;
    else process.env.INTERNAL_SERVICE_SECRET = oldSecret;
    if (oldBaseUrl === undefined) delete process.env.API_BASE_URL;
    else process.env.API_BASE_URL = oldBaseUrl;
    jest.restoreAllMocks();
  });

  it('returns deterministic copy without making a request when not configured', async () => {
    delete process.env.INTERNAL_SERVICE_SECRET;
    const fetchSpy = jest.spyOn(global, 'fetch');
    const client = new AlertSummaryClient();

    await expect(client.summarize(input)).resolves.toBe(
      buildDeterministicAlertNarrative(input),
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('posts all sourced and local fields to the internal API', async () => {
    process.env.INTERNAL_SERVICE_SECRET = 'shared-secret';
    process.env.API_BASE_URL = 'https://internal.example.test/';
    const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ summary: 'Grounded narrative.' }),
    } as Response);
    const client = new AlertSummaryClient();

    await expect(client.summarize(input)).resolves.toBe('Grounded narrative.');
    expect(fetchSpy).toHaveBeenCalledWith(
      'https://internal.example.test/api/internal/tracker/summarize',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'x-internal-service-secret': 'shared-secret',
        }),
        body: JSON.stringify(input),
      }),
    );
  });

  it('returns deterministic copy when the internal API fails', async () => {
    process.env.INTERNAL_SERVICE_SECRET = 'shared-secret';
    jest.spyOn(global, 'fetch').mockResolvedValue({ ok: false, status: 503 } as Response);
    const client = new AlertSummaryClient();

    await expect(client.summarize(input)).resolves.toBe(
      buildDeterministicAlertNarrative(input),
    );
  });
});
