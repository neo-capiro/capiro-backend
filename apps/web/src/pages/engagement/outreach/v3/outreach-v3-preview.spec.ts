import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  OUTREACH_V3_PREVIEW_STORAGE_KEY,
  activateOutreachV3Preview,
  clearOutreachV3Preview,
  consumeOutreachV3PreviewActivation,
  isOutreachV3PreviewActive,
  readOutreachV3PreviewMode,
} from './outreach-v3-preview.js';

beforeEach(() => {
  window.sessionStorage.clear();
});

describe('Outreach V3 preview mode', () => {
  it('is off by default', () => {
    expect(readOutreachV3PreviewMode()).toBe('off');
    expect(isOutreachV3PreviewActive()).toBe(false);
  });

  it('activates and clears only the exact v3 value', () => {
    activateOutreachV3Preview();
    expect(readOutreachV3PreviewMode()).toBe('v3');
    expect(window.sessionStorage.getItem(OUTREACH_V3_PREVIEW_STORAGE_KEY)).toBe('v3');
    clearOutreachV3Preview();
    expect(readOutreachV3PreviewMode()).toBe('off');
  });

  it.each(['V3', 'v3 ', 'true', '1', 'on', ''])('fails closed for stored value %o', (value) => {
    window.sessionStorage.setItem(OUTREACH_V3_PREVIEW_STORAGE_KEY, value);
    expect(readOutreachV3PreviewMode()).toBe('off');
  });
});

describe('consumeOutreachV3PreviewActivation', () => {
  it('activates and preserves unrelated parameters in order', () => {
    const result = consumeOutreachV3PreviewActivation(
      '?client=c-1&outreach-v3-preview=v3&engagement-api-preview=v3&tab=outreach',
    );
    expect(result).toEqual({
      mode: 'v3',
      changed: true,
      nextSearch: '?client=c-1&engagement-api-preview=v3&tab=outreach',
    });
  });

  it('deactivates with off', () => {
    activateOutreachV3Preview();
    const result = consumeOutreachV3PreviewActivation('?outreach-v3-preview=off');
    expect(result.mode).toBe('off');
    expect(result.nextSearch).toBe('');
  });

  it('consumes unknown values without changing the current mode', () => {
    activateOutreachV3Preview();
    const result = consumeOutreachV3PreviewActivation('?outreach-v3-preview=v4');
    expect(result.mode).toBe('v3');
    expect(result.nextSearch).toBe('');
  });

  it('is inert when the parameter is absent', () => {
    expect(consumeOutreachV3PreviewActivation('?tab=outreach')).toEqual({
      mode: 'off',
      changed: false,
      nextSearch: '?tab=outreach',
    });
  });

  it('fails closed when sessionStorage is unreadable', () => {
    const spy = vi.spyOn(window.sessionStorage, 'getItem').mockImplementation(() => {
      throw new Error('denied');
    });
    expect(readOutreachV3PreviewMode()).toBe('off');
    expect(() => consumeOutreachV3PreviewActivation('?tab=outreach')).not.toThrow();
    spy.mockRestore();
  });
});
