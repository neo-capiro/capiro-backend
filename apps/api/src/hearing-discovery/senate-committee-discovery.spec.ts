import { discoverSenateCommitteeCalendars } from './senate-committee-discovery.js';
import { CommitteeSourceRepository } from './committee-source.repository.js';
import { HearingReconcilerService } from './hearing-reconciler.service.js';
import { SenateCommitteeCalendarAdapter } from './adapters/senate-committee-calendar.adapter.js';
import * as sourceHttp from './adapters/source-http.js';
import { createHash } from 'node:crypto';

describe('registered Senate committee calendar discovery', () => {
  afterEach(() => jest.restoreAllMocks());
  it('records an unrecognized HTTP200 response as failed without reconciling or fetching twice', async () => {
    jest
      .spyOn(CommitteeSourceRepository.prototype, 'listEnabled')
      .mockResolvedValue([
        { id: 'unrecognized', sourceUrl: 'https://www.judiciary.senate.gov/hearings' },
      ] as never);
    jest.spyOn(CommitteeSourceRepository.prototype, 'markChecked').mockResolvedValue();
    const outcome = jest
      .spyOn(CommitteeSourceRepository.prototype, 'recordOutcome')
      .mockResolvedValue('failing');
    const reconcile = jest.spyOn(HearingReconcilerService.prototype, 'reconcileBatch');
    const fetch = jest.spyOn(sourceHttp, 'fetchText').mockResolvedValue({
      ok: true,
      status: 200,
      body: '<html><h1>Hearings</h1></html>',
      contentHash: createHash('sha256').update('<html><h1>Hearings</h1></html>').digest('hex'),
      etag: null,
      lastModified: null,
      notModified: false,
      error: null,
      durationMs: 1,
    });
    const now = new Date();
    const result = await discoverSenateCommitteeCalendars({} as never, {
      congress: 119,
      now,
      ctx: { since: null, daysAhead: 21, delayMs: 0, log: () => {} },
    });
    expect(result.errors).toBe(1);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(reconcile).not.toHaveBeenCalled();
    expect(outcome).toHaveBeenCalledWith(
      'unrecognized',
      expect.objectContaining({ ok: false, error: expect.stringContaining('no verifiable dated') }),
      now,
      expect.any(String),
    );
  });
  it('reconciles newly announced committee-only events and continues after an independent source failure', async () => {
    const sources = [
      { id: 'failed', adapterKey: 'senate-committee-calendar' },
      { id: 'healthy', adapterKey: 'senate-committee-calendar' },
    ];
    jest
      .spyOn(CommitteeSourceRepository.prototype, 'listEnabled')
      .mockResolvedValue(sources as never);
    jest.spyOn(CommitteeSourceRepository.prototype, 'markChecked').mockResolvedValue();
    const outcomes = jest
      .spyOn(CommitteeSourceRepository.prototype, 'recordOutcome')
      .mockResolvedValue('healthy');
    const event = { externalEventId: '/hearings/new-announcement' };
    jest
      .spyOn(SenateCommitteeCalendarAdapter.prototype, 'discoverEvents')
      .mockRejectedValueOnce(new Error('publisher unavailable'))
      .mockResolvedValueOnce([event] as never);
    const reconcile = jest
      .spyOn(HearingReconcilerService.prototype, 'reconcileBatch')
      .mockResolvedValue({
        totals: {
          events: 1,
          hearingsCreated: 1,
          hearingsUpdated: 0,
          errors: 0,
        },
      } as never);
    const now = new Date();
    expect(
      await discoverSenateCommitteeCalendars({} as never, {
        congress: 119,
        now,
        ctx: { since: null, daysAhead: 21, delayMs: 0, log: () => {} },
      }),
    ).toEqual({ inserted: 1, updated: 0, skipped: 0, errors: 1 });
    expect(reconcile).toHaveBeenCalledWith(sources[1], [event], now, expect.any(Function));
    expect(outcomes).toHaveBeenCalledWith(
      'failed',
      expect.objectContaining({ ok: false }),
      now,
      expect.any(String),
    );
    expect(outcomes).toHaveBeenCalledWith(
      'healthy',
      { ok: true, observedEvents: 1 },
      now,
      expect.any(String),
    );
  });
});
