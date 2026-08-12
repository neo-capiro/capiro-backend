import { describe, expect, it } from 'vitest';
import {
  applyPortfolioRoute,
  PORTFOLIO_LAYOUTS,
  PORTFOLIO_SORTS,
  PORTFOLIO_STATUSES,
  resolvePortfolioRoute,
} from './portfolio-routing.js';

const at = (query: string) => resolvePortfolioRoute(new URLSearchParams(query));

describe('resolvePortfolioRoute — canonical state', () => {
  it('returns defaults when no params are present', () => {
    expect(at('')).toEqual({
      q: '',
      status: 'all',
      sort: 'attention',
      layout: 'list',
      didNormalize: false,
    });
  });

  it('resolves every status', () => {
    for (const status of PORTFOLIO_STATUSES) {
      expect(at(`status=${status}`).status).toBe(status);
    }
  });

  it('resolves every sort', () => {
    for (const sort of PORTFOLIO_SORTS) {
      expect(at(`sort=${sort}`).sort).toBe(sort);
    }
  });

  it('resolves every layout', () => {
    for (const layout of PORTFOLIO_LAYOUTS) {
      expect(at(`layout=${layout}`).layout).toBe(layout);
    }
  });

  it('trims and keeps the search query', () => {
    expect(at('q=acme').q).toBe('acme');
    expect(at('q=%20acme%20').q).toBe('acme');
  });

  it('falls back to defaults on unrecognised values and flags the normalization', () => {
    const route = at('status=bogus&sort=nope&layout=grid9');
    expect(route.status).toBe('all');
    expect(route.sort).toBe('attention');
    expect(route.layout).toBe('list');
    expect(route.didNormalize).toBe(true);
  });

  it('does not flag normalization for a clean URL', () => {
    expect(at('status=active&sort=name&layout=cards').didNormalize).toBe(false);
  });
});

describe('applyPortfolioRoute — writing state back to the URL', () => {
  it('sets a non-default value and preserves unrelated params', () => {
    const next = applyPortfolioRoute(new URLSearchParams('clientId=abc'), { status: 'at-risk' });
    expect(next.get('clientId')).toBe('abc');
    expect(next.get('status')).toBe('at-risk');
  });

  it('drops default values so the URL stays clean', () => {
    const next = applyPortfolioRoute(new URLSearchParams('status=active'), { status: 'all' });
    expect(next.get('status')).toBeNull();
  });

  it('removes an emptied search', () => {
    const next = applyPortfolioRoute(new URLSearchParams('q=acme'), { q: '  ' });
    expect(next.get('q')).toBeNull();
  });

  it('round-trips through resolve', () => {
    const applied = applyPortfolioRoute(new URLSearchParams(), {
      q: 'overland',
      status: 'prospect',
      sort: 'readiness',
      layout: 'cards',
    });
    const resolved = resolvePortfolioRoute(applied);
    expect(resolved.q).toBe('overland');
    expect(resolved.status).toBe('prospect');
    expect(resolved.sort).toBe('readiness');
    expect(resolved.layout).toBe('cards');
  });
});
