import { describe, expect, it, vi } from 'vitest';
import type { AxiosInstance } from 'axios';
import { listReviewedPartialPeTotals } from './reviewed-partial-pe-totals-api.js';

describe('reviewed-partial-pe-totals-api', () => {
  it('requests the real API route (/api/...), not the bare app path', async () => {
    // Regression: BASE was missing the leading /api segment that every sibling
    // API client (defense-budget-lifecycle-api.ts, legiwatch wave*-api.ts,
    // strategies-api.ts) includes. Without it, this call never reaches the
    // NestJS controller at all -- it falls through to the web app's own SPA
    // static-file fallback, which answers any unmatched path with a 200 and
    // index.html. ReviewedPartialPeTotalsPage then crashes on
    // `query.data.items.length` because `query.data` is that HTML string, not
    // the { items: [...] } shape the controller actually returns. Confirmed
    // live on os.capiro.ai (2026-09-16): every load of
    // /defense-budget-lifecycle/reviewed-partial threw
    // "Cannot read properties of undefined (reading 'length')", and the
    // captured XHR response body for this exact path started with
    // "<!doctype html>", not "{".
    const get = vi.fn().mockResolvedValue({
      data: { fiscalYear: 2024, coverage: 'partial', coverageNote: '', count: 0, items: [] },
    });
    const api = { get } as unknown as AxiosInstance;

    await listReviewedPartialPeTotals(api, 2024);

    expect(get).toHaveBeenCalledTimes(1);
    const [path] = get.mock.calls[0]!;
    expect(path).toBe('/api/defense-budget/reviewed-partial-pe-totals');
  });

  it('passes fiscalYear and an optional component as query params', async () => {
    const get = vi.fn().mockResolvedValue({
      data: { fiscalYear: 2024, component: 'ARMY', coverage: 'partial', coverageNote: '', count: 0, items: [] },
    });
    const api = { get } as unknown as AxiosInstance;

    await listReviewedPartialPeTotals(api, 2024, 'ARMY');

    expect(get.mock.calls[0]![1]).toEqual({ params: { fiscalYear: 2024, component: 'ARMY' } });
  });
});
