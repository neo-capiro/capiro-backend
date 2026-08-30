import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  clearOutreachBuilderProgress,
  outreachBuilderProgressKey,
  readOutreachBuilderProgress,
  writeOutreachBuilderProgress,
} from './outreach-builder-progress.js';

describe('outreach builder progress (resume where you left off)', () => {
  afterEach(() => {
    window.localStorage.clear();
  });

  it('returns null when nothing has been saved for this campaign', () => {
    expect(readOutreachBuilderProgress('session-1')).toBeNull();
  });

  it('remembers the last step written for a campaign and reads it back', () => {
    writeOutreachBuilderProgress('session-1', 'targets');
    expect(readOutreachBuilderProgress('session-1')).toBe('targets');

    writeOutreachBuilderProgress('session-1', 'review');
    expect(readOutreachBuilderProgress('session-1')).toBe('review');
  });

  it('keeps each campaign’s progress independent', () => {
    writeOutreachBuilderProgress('session-1', 'context');
    writeOutreachBuilderProgress('session-2', 'send');

    expect(readOutreachBuilderProgress('session-1')).toBe('context');
    expect(readOutreachBuilderProgress('session-2')).toBe('send');
  });

  it('stores under the documented key so a future migration can find it', () => {
    writeOutreachBuilderProgress('session-1', 'format');
    expect(window.localStorage.getItem(outreachBuilderProgressKey('session-1'))).toBe('format');
  });

  it('ignores a corrupted or unrecognized stored value rather than throwing', () => {
    window.localStorage.setItem(outreachBuilderProgressKey('session-1'), 'not-a-real-step');
    expect(readOutreachBuilderProgress('session-1')).toBeNull();
  });

  it('clears the resume point, e.g. once a campaign is archived', () => {
    writeOutreachBuilderProgress('session-1', 'drafts');
    clearOutreachBuilderProgress('session-1');
    expect(readOutreachBuilderProgress('session-1')).toBeNull();
  });

  it('is a no-op — not a throw — for an empty session id', () => {
    expect(() => writeOutreachBuilderProgress('', 'targets')).not.toThrow();
    expect(readOutreachBuilderProgress('')).toBeNull();
  });

  it('fails closed to null when localStorage.getItem throws (e.g. private browsing)', () => {
    const spy = vi.spyOn(window.localStorage, 'getItem').mockImplementation(() => {
      throw new Error('storage disabled');
    });
    expect(readOutreachBuilderProgress('session-1')).toBeNull();
    spy.mockRestore();
  });

  it('does not throw when localStorage.setItem fails (e.g. quota exceeded)', () => {
    const spy = vi.spyOn(window.localStorage, 'setItem').mockImplementation(() => {
      throw new Error('quota exceeded');
    });
    expect(() => writeOutreachBuilderProgress('session-1', 'send')).not.toThrow();
    spy.mockRestore();
  });
});
