/**
 * Unit contract for the module's pathname parsing (Phase 3 briefing lesson 2:
 * VNextRouter mounts above the canonical param <Route>s, so params must come
 * from location.pathname — matchDirectoryProfilePath precedent).
 */
import { describe, expect, it } from 'vitest';
import {
  isVNextIntelligencePath,
  matchIssueLeaderboardPath,
} from './VNextIntelligenceRoutes.js';

describe('matchIssueLeaderboardPath', () => {
  it('parses a single-segment issue code, decoded exactly as react-router would', () => {
    expect(matchIssueLeaderboardPath('/intelligence/issues/DEF')).toBe('DEF');
    expect(matchIssueLeaderboardPath('/intelligence/issues/tax-policy')).toBe('tax-policy');
    expect(matchIssueLeaderboardPath('/intelligence/issues/TAX%20POLICY')).toBe('TAX POLICY');
    expect(matchIssueLeaderboardPath('/intelligence/issues/DEF/')).toBe('DEF');
  });

  it('rejects everything that is not exactly one code segment', () => {
    expect(matchIssueLeaderboardPath('/intelligence/issues')).toBeNull();
    expect(matchIssueLeaderboardPath('/intelligence/issues/')).toBeNull();
    expect(matchIssueLeaderboardPath('/intelligence/issues/DEF/extra')).toBeNull();
    expect(matchIssueLeaderboardPath('/intelligence/issuesX/DEF')).toBeNull();
    // A malformed escape sequence falls through to canonical, not a crash.
    expect(matchIssueLeaderboardPath('/intelligence/issues/%E0%A4%A')).toBeNull();
  });
});

describe('isVNextIntelligencePath', () => {
  it('claims exactly the five deep-link routes (trailing slashes tolerated)', () => {
    for (const path of [
      '/intelligence/federal-spending',
      '/intelligence/federal-spending/',
      '/intelligence/issues/DEF',
      '/intelligence/graph',
      '/intelligence/changes',
      '/intelligence-center',
    ]) {
      expect(isVNextIntelligencePath(path), path).toBe(true);
    }
  });

  it('leaves every other intelligence path to canonical or its owning module', () => {
    for (const path of [
      '/intelligence',
      '/intelligence/',
      '/intelligence/hearing-watch',
      '/intelligence/hearing-watch/session-1', // vNext LegiWatch's claim, not ours
      '/intelligence/opportunities', // vNext Funding Opportunities' claim
      '/intelligence/district-nexus', // vNext District Nexus' claim
      '/intelligence/bills/119-hr-8800',
      '/intelligence/client/client-1',
      '/intelligence/client/client-1/graph',
      '/intelligence/graphs',
      '/intelligence/changes-feed',
      '/intelligence/federal-spending-v2',
      '/intelligence-centerx',
      '/explorer',
    ]) {
      expect(isVNextIntelligencePath(path), path).toBe(false);
    }
  });
});
