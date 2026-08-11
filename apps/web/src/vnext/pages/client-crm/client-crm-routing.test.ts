import { describe, expect, it } from 'vitest';
import {
  applyCrmRoute,
  CRM_TABS,
  defaultViewFor,
  INTELLIGENCE_VIEWS,
  RELATIONSHIP_VIEWS,
  resolveCrmRoute,
} from './client-crm-routing.js';

const at = (query: string) => resolveCrmRoute(new URLSearchParams(query));

describe('resolveCrmRoute — canonical state', () => {
  it('defaults to Overview when no tab is present', () => {
    const route = at('clientId=abc');
    expect(route).toEqual({ tab: 'overview', view: null, didNormalize: false });
  });

  it('resolves every primary tab', () => {
    for (const tab of CRM_TABS) {
      expect(at(`tab=${tab}`).tab).toBe(tab);
    }
  });

  it('resolves every Relationships view', () => {
    for (const view of RELATIONSHIP_VIEWS) {
      expect(at(`tab=relationships&view=${view}`)).toEqual({
        tab: 'relationships',
        view,
        didNormalize: false,
      });
    }
  });

  it('resolves every Intelligence view', () => {
    for (const view of INTELLIGENCE_VIEWS) {
      expect(at(`tab=intelligence&view=${view}`)).toEqual({
        tab: 'intelligence',
        view,
        didNormalize: false,
      });
    }
  });

  it('supplies the default secondary view when a two-level tab arrives without one', () => {
    expect(at('tab=relationships')).toEqual({
      tab: 'relationships',
      view: 'organization',
      didNormalize: true,
    });
    expect(at('tab=intelligence')).toEqual({
      tab: 'intelligence',
      view: 'overview',
      didNormalize: true,
    });
  });

  it('keeps the capability surface reachable (§13 non-regression)', () => {
    expect(at('tab=capabilities')).toEqual({
      tab: 'capabilities',
      view: null,
      didNormalize: false,
    });
  });
});

describe('resolveCrmRoute — legacy deep links', () => {
  // Each row is a link that exists in the wild today and must keep working.
  const cases: Array<[string, string, string | null]> = [
    ['activity', 'relationships', 'history'],
    ['people', 'relationships', 'organization'],
    ['targets', 'relationships', 'government'],
    ['facilities', 'intelligence', 'district'],
    ['documents', 'files', null],
    ['tracker', 'intelligence', 'legislative'],
    ['radar', 'intelligence', 'legislative'],
    ['legiwatch', 'intelligence', 'legislative'],
  ];

  it.each(cases)('?tab=%s resolves to %s / %s', (legacy, tab, view) => {
    expect(at(`clientId=abc&tab=${legacy}`)).toEqual({ tab, view, didNormalize: true });
  });

  it('lets the legacy mapping win over a stray view parameter', () => {
    // ?tab=targets&view=history is not a combination any real link intended.
    expect(at('tab=targets&view=history').view).toBe('government');
  });
});

describe('resolveCrmRoute — hostile and stale input', () => {
  it('falls back to Overview for an unknown tab rather than rendering nothing', () => {
    expect(at('tab=nonsense')).toEqual({ tab: 'overview', view: null, didNormalize: true });
  });

  it('falls back to the default view for an unknown view', () => {
    expect(at('tab=intelligence&view=nonsense').view).toBe('overview');
    expect(at('tab=relationships&view=nonsense').view).toBe('organization');
  });

  it('is case- and whitespace-insensitive', () => {
    expect(at('tab=%20People%20').tab).toBe('relationships');
    expect(at('tab=INTELLIGENCE&view=Legislative').view).toBe('legislative');
  });

  it('does not report a normalization for a plain client open', () => {
    // A redundant history entry on every client open would break Back.
    expect(at('clientId=abc').didNormalize).toBe(false);
  });

  it('survives absent search params', () => {
    expect(resolveCrmRoute(null).tab).toBe('overview');
    expect(resolveCrmRoute(undefined).tab).toBe('overview');
  });

  it('drops a leftover view from a tab that has none', () => {
    expect(at('tab=files&view=legislative')).toEqual({
      tab: 'files',
      view: null,
      didNormalize: true,
    });
  });
});

describe('applyCrmRoute', () => {
  it('preserves clientId and unrelated parameters across a tab change', () => {
    const next = applyCrmRoute(new URLSearchParams('clientId=abc&highlight=xyz'), { tab: 'work' });
    expect(next.get('clientId')).toBe('abc');
    expect(next.get('highlight')).toBe('xyz');
    expect(next.get('tab')).toBe('work');
    expect(next.get('view')).toBeNull();
  });

  it('writes the default secondary view when entering a two-level tab', () => {
    const next = applyCrmRoute(new URLSearchParams('clientId=abc'), { tab: 'intelligence' });
    expect(next.get('view')).toBe('overview');
  });

  it('keeps an explicit secondary view', () => {
    const next = applyCrmRoute(new URLSearchParams(''), {
      tab: 'intelligence',
      view: 'regulatory',
    });
    expect(next.get('view')).toBe('regulatory');
  });

  it('rejects a view that does not belong to the tab', () => {
    const next = applyCrmRoute(new URLSearchParams(''), {
      tab: 'relationships',
      view: 'legislative',
    });
    expect(next.get('view')).toBe('organization');
  });

  it('clears a stale view when moving to a single-level tab', () => {
    const next = applyCrmRoute(new URLSearchParams('tab=intelligence&view=funding'), {
      tab: 'files',
    });
    expect(next.get('view')).toBeNull();
  });

  it('round-trips through resolveCrmRoute for every tab and view', () => {
    const combos: Array<{ tab: 'relationships' | 'intelligence'; view: string }> = [
      ...RELATIONSHIP_VIEWS.map((view) => ({ tab: 'relationships' as const, view })),
      ...INTELLIGENCE_VIEWS.map((view) => ({ tab: 'intelligence' as const, view })),
    ];
    for (const combo of combos) {
      const params = applyCrmRoute(new URLSearchParams('clientId=abc'), combo as never);
      const resolved = resolveCrmRoute(params);
      expect({ tab: resolved.tab, view: resolved.view }).toEqual(combo);
      expect(resolved.didNormalize).toBe(false);
    }
  });
});

describe('defaultViewFor', () => {
  it('returns the documented default for two-level tabs and null otherwise', () => {
    expect(defaultViewFor('relationships')).toBe('organization');
    expect(defaultViewFor('intelligence')).toBe('overview');
    expect(defaultViewFor('overview')).toBeNull();
    expect(defaultViewFor('work')).toBeNull();
    expect(defaultViewFor('files')).toBeNull();
    expect(defaultViewFor('capabilities')).toBeNull();
  });
});
