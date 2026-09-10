/** LW-07 — watch-management tab aliases must resolve to the settings tab (the
 *  real watchlist / preset management view), never fall through to Hearings. */
import { describe, expect, it } from 'vitest';

import { LEGIWATCH_TABS, REMOVED_TABS, TAB_ALIASES } from './types.js';

describe('LW-07 — watch-management tab aliases', () => {
  it('maps every legacy watch-management tab name to settings', () => {
    for (const name of ['watchlist', 'watchlists', 'watches', 'presets']) {
      expect(TAB_ALIASES[name], name).toBe('settings');
    }
  });

  it('no longer treats watchlist names as removed fall-through tabs', () => {
    expect(REMOVED_TABS.has('watchlist')).toBe(false);
    expect(REMOVED_TABS.has('watchlists')).toBe(false);
  });

  it('alias targets are real, URL-addressable tabs', () => {
    for (const target of Object.values(TAB_ALIASES)) {
      expect(LEGIWATCH_TABS).toContain(target);
    }
  });
});
