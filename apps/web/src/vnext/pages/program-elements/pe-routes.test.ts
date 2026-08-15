import { describe, expect, it } from 'vitest';
import {
  isVNextProgramElementsPath,
  matchPeProfilePath,
  resolvePeDestination,
  resolvePeProfileTab,
} from './pe-routes.js';

describe('program-elements vNext route contract', () => {
  it('claims the workspace root', () => {
    expect(isVNextProgramElementsPath('/program-elements')).toBe(true);
  });

  it('claims line profiles and extracts the PE code', () => {
    expect(isVNextProgramElementsPath('/program-elements/0605053A')).toBe(true);
    expect(matchPeProfilePath('/program-elements/0605053A')).toBe('0605053A');
  });

  it('decodes a URL-encoded PE code', () => {
    expect(matchPeProfilePath('/program-elements/4868W12002')).toBe('4868W12002');
  });

  it('does NOT claim static PE segments — they fall through to canonical', () => {
    expect(isVNextProgramElementsPath('/program-elements/mark-up-monitor')).toBe(false);
    expect(isVNextProgramElementsPath('/program-elements/contacts')).toBe(false);
    expect(matchPeProfilePath('/program-elements/mark-up-monitor')).toBeNull();
    expect(matchPeProfilePath('/program-elements/contacts')).toBeNull();
  });

  it('does not claim unrelated paths', () => {
    expect(isVNextProgramElementsPath('/')).toBe(false);
    expect(isVNextProgramElementsPath('/clients')).toBe(false);
    expect(isVNextProgramElementsPath('/strategies')).toBe(false);
    expect(isVNextProgramElementsPath('/actions')).toBe(false);
  });

  it('resolves destinations with Explore as the default', () => {
    expect(resolvePeDestination(null)).toBe('explore');
    expect(resolvePeDestination(undefined)).toBe('explore');
    expect(resolvePeDestination('')).toBe('explore');
    expect(resolvePeDestination('nonsense')).toBe('explore');
    expect(resolvePeDestination('movement')).toBe('movement');
    expect(resolvePeDestination('congressional')).toBe('congressional');
    expect(resolvePeDestination('actions')).toBe('actions');
    expect(resolvePeDestination('portfolio')).toBe('portfolio');
  });

  it('resolves profile tabs with Overview as the default', () => {
    expect(resolvePeProfileTab(null)).toBe('overview');
    expect(resolvePeProfileTab('bogus')).toBe('overview');
    expect(resolvePeProfileTab('funding')).toBe('funding');
    expect(resolvePeProfileTab('legislative')).toBe('legislative');
    expect(resolvePeProfileTab('structure')).toBe('structure');
    expect(resolvePeProfileTab('sources')).toBe('sources');
  });
});
