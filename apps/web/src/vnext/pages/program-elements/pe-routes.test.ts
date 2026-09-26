import { describe, expect, it } from 'vitest';
import {
  isVNextProgramElementsPath,
  matchPeProfilePath,
  matchPeStaticPath,
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

  it('claims the two native static segments as of Phase 3 — and never as a profile', () => {
    expect(isVNextProgramElementsPath('/program-elements/mark-up-monitor')).toBe(true);
    expect(isVNextProgramElementsPath('/program-elements/contacts')).toBe(true);
    expect(matchPeStaticPath('/program-elements/mark-up-monitor')).toBe('mark-up-monitor');
    expect(matchPeStaticPath('/program-elements/contacts')).toBe('contacts');
    // A static segment must never parse as a :peCode line profile.
    expect(matchPeProfilePath('/program-elements/mark-up-monitor')).toBeNull();
    expect(matchPeProfilePath('/program-elements/contacts')).toBeNull();
  });

  it('does NOT claim deeper paths under a static segment', () => {
    expect(matchPeStaticPath('/program-elements/mark-up-monitor/extra')).toBeNull();
    expect(matchPeStaticPath('/program-elements/contacts/extra')).toBeNull();
  });

  it('does NOT claim the reserved reconciliation segment — it falls through to canonical', () => {
    expect(isVNextProgramElementsPath('/program-elements/reconciliation')).toBe(false);
    expect(matchPeStaticPath('/program-elements/reconciliation')).toBeNull();
    expect(matchPeProfilePath('/program-elements/reconciliation')).toBeNull();
  });

  it('does NOT claim future reserved segments research, compare, coverage — they fall through', () => {
    expect(isVNextProgramElementsPath('/program-elements/research')).toBe(false);
    expect(isVNextProgramElementsPath('/program-elements/compare')).toBe(false);
    expect(isVNextProgramElementsPath('/program-elements/coverage')).toBe(false);
    expect(matchPeStaticPath('/program-elements/research')).toBeNull();
    expect(matchPeStaticPath('/program-elements/compare')).toBeNull();
    expect(matchPeStaticPath('/program-elements/coverage')).toBeNull();
    expect(matchPeProfilePath('/program-elements/research')).toBeNull();
    expect(matchPeProfilePath('/program-elements/compare')).toBeNull();
    expect(matchPeProfilePath('/program-elements/coverage')).toBeNull();
  });

  it('does NOT claim deeper paths under a profile — they fall through', () => {
    expect(isVNextProgramElementsPath('/program-elements/0605053A/extra')).toBe(false);
    expect(matchPeProfilePath('/program-elements/0605053A/extra')).toBeNull();
    expect(isVNextProgramElementsPath('/program-elements/0605053A/sources')).toBe(false);
    expect(matchPeProfilePath('/program-elements/0605053A/sources')).toBeNull();
  });

  it('does NOT claim arbitrary words or malformed identifiers as profiles', () => {
    expect(isVNextProgramElementsPath('/program-elements/whatever')).toBe(false);
    expect(matchPeProfilePath('/program-elements/whatever')).toBeNull();
    expect(matchPeProfilePath('/program-elements/%2Fcoverage')).toBeNull();
    expect(matchPeProfilePath('/program-elements/%E0%A4%A')).toBeNull();
  });

  it('does not claim unrelated paths', () => {
    expect(isVNextProgramElementsPath('/')).toBe(false);
    expect(isVNextProgramElementsPath('/nonexistent-path-xyz')).toBe(false);
    expect(isVNextProgramElementsPath('/program-element')).toBe(false);
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
