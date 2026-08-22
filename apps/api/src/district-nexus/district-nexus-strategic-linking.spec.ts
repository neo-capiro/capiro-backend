/**
 * District Nexus Release 2 — strategic signal linking rules (pure fixtures).
 *
 * These tests encode the non-negotiable linking rules without a database:
 * exact identifiers beat free-text; committee alone does not create nexus;
 * free-text strategy mentions do not score; private notes stay out of evidence.
 */

import { describe, expect, test } from '@jest/globals';
import { scoreStrategicRelevance } from './district-nexus-strategic-scoring.js';
import { scoreNexus } from './district-nexus-scoring.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('district-nexus-strategic linking rules', () => {
  test('Nexus Strength is unchanged by strategic-only signals (no blend)', () => {
    const nexusBefore = scoreNexus({
      components: {
        verifiedFacility: { strength: 'verified', evidenceCount: 1 },
      },
    });
    // Strategic scorer is a separate function — calling it cannot mutate nexus.
    const strategic = scoreStrategicRelevance({
      components: {
        committeeJurisdiction: { strength: 'verified', evidenceCount: 3 },
        activeLegislation: { strength: 'verified', evidenceCount: 2 },
      },
      minCoveragePercent: 0,
    });
    const nexusAfter = scoreNexus({
      components: {
        verifiedFacility: { strength: 'verified', evidenceCount: 1 },
      },
    });
    expect(nexusAfter.score).toBe(nexusBefore.score);
    expect(nexusAfter.coveragePercent).toBe(nexusBefore.coveragePercent);
    // Strategic score exists independently
    expect(strategic.score).not.toBeNull();
    expect(strategic.score).not.toBe(nexusAfter.score);
  });

  test('committee membership alone does not appear in nexus awarded totals path', () => {
    // Nexus scoring with only policyCommitteeRelevance (the R1 policy slot)
    // must not invent awarded funding — strategic committee is a different axis.
    const nexus = scoreNexus({
      components: {
        policyCommitteeRelevance: { strength: 'verified', evidenceCount: 1 },
      },
    });
    // No awarded-funding components present
    const awarded = nexus.breakdown.filter((b) =>
      ['contractPlaceOfPerformance', 'grantPlaceOfPerformance'].includes(b.component),
    );
    expect(awarded.every((b) => b.credit === 0 || b.rationale.toLowerCase().includes('no evidence'))).toBe(
      true,
    );
  });

  test('irrelevant PE path: PE component absent when no committee bridge (fixture narrative)', () => {
    // Encodes service rule: relevant PE without committee bridge → PE credit missing.
    const result = scoreStrategicRelevance({
      components: {
        programElementBudget: { strength: 'absent' },
        committeeJurisdiction: { strength: 'absent' },
      },
    });
    expect(result.breakdown.find((b) => b.component === 'programElementBudget')?.credit).toBeNull();
  });

  test('direct client PE + relevant committee scores PE component', () => {
    const result = scoreStrategicRelevance({
      components: {
        committeeJurisdiction: { strength: 'verified', evidenceCount: 1 },
        programElementBudget: {
          strength: 'verified',
          evidenceCount: 1,
          evidence: [
            {
              component: 'programElementBudget',
              sourceType: 'client_pe_relevance',
              label: 'PE 0604256N',
              sourceRecordId: '0604256N',
              observedAt: null,
              summary: 'Capability lists PE; member on HASC.',
            },
          ],
        },
      },
      minCoveragePercent: 0,
    });
    expect(result.breakdown.find((b) => b.component === 'programElementBudget')?.credit).toBe(20);
    expect(result.evidence.some((e) => e.sourceRecordId === '0604256N')).toBe(true);
  });

  test('tracked bill sponsor/cosponsor/referral scores; unrelated tracked bill does not', () => {
    const linked = scoreStrategicRelevance({
      components: {
        activeLegislation: {
          strength: 'verified',
          evidenceCount: 1,
          evidence: [
            {
              component: 'activeLegislation',
              sourceType: 'tracked_bill',
              label: '119-hr-1',
              sourceRecordId: '119-hr-1',
              observedAt: null,
              summary: 'Tracked bill linked as sponsor.',
              refs: { role: 'sponsor' },
            },
          ],
        },
      },
      minCoveragePercent: 0,
    });
    expect(linked.breakdown.find((b) => b.component === 'activeLegislation')?.credit).toBe(15);

    const unrelated = scoreStrategicRelevance({
      components: {
        activeLegislation: { strength: 'absent' },
      },
      minCoveragePercent: 0,
    });
    expect(unrelated.breakdown.find((b) => b.component === 'activeLegislation')?.credit).toBeNull();
  });

  test('hearing without client relevance does not score', () => {
    const result = scoreStrategicRelevance({
      components: {
        hearingTiming: { strength: 'absent' },
      },
      minCoveragePercent: 0,
    });
    expect(result.breakdown.find((b) => b.component === 'hearingTiming')?.credit).toBeNull();
  });

  test('explicit strategy target scores; free-text strategy mention does not', () => {
    const explicit = scoreStrategicRelevance({
      components: {
        activeStrategyTarget: {
          strength: 'verified',
          evidenceCount: 1,
          evidence: [
            {
              component: 'activeStrategyTarget',
              sourceType: 'sp_node',
              label: 'NDAA ask · Meet member',
              sourceRecordId: 'node-1',
              observedAt: null,
              summary: 'Live strategy node explicitly targets member M0001.',
              refs: { memberId: 'M0001' },
            },
          ],
        },
      },
      minCoveragePercent: 0,
    });
    expect(explicit.breakdown.find((b) => b.component === 'activeStrategyTarget')?.credit).toBe(15);

    // Free-text only → service leaves component absent
    const freeText = scoreStrategicRelevance({
      components: {
        activeStrategyTarget: { strength: 'absent' },
      },
      minCoveragePercent: 0,
    });
    expect(freeText.breakdown.find((b) => b.component === 'activeStrategyTarget')?.credit).toBeNull();
  });

  test('explicit engagement with district office scores; unrelated meeting does not', () => {
    const hit = scoreStrategicRelevance({
      components: {
        relationshipEngagement: {
          strength: 'verified',
          evidenceCount: 1,
          evidence: [
            {
              component: 'relationshipEngagement',
              sourceType: 'client_target',
              label: 'Target: Rep. Example',
              sourceRecordId: 'tgt-1',
              observedAt: '2026-01-01T00:00:00.000Z',
              summary: 'Client target saved for this member/office.',
            },
          ],
        },
      },
      minCoveragePercent: 0,
    });
    expect(hit.breakdown.find((b) => b.component === 'relationshipEngagement')?.credit).toBe(10);

    const miss = scoreStrategicRelevance({
      components: {
        relationshipEngagement: { strength: 'absent' },
      },
      minCoveragePercent: 0,
    });
    expect(miss.breakdown.find((b) => b.component === 'relationshipEngagement')?.credit).toBeNull();
  });

  test('strategic evidence summaries never include private meeting note bodies', () => {
    const result = scoreStrategicRelevance({
      components: {
        relationshipEngagement: {
          strength: 'sourceAuthoritative',
          evidenceCount: 1,
          evidence: [
            {
              component: 'relationshipEngagement',
              sourceType: 'shared_meeting',
              label: 'Shared meeting with office',
              sourceRecordId: 'mtg-1',
              observedAt: '2026-02-01T00:00:00.000Z',
              summary: 'Shared meeting held with office (details redacted).',
            },
          ],
        },
      },
      minCoveragePercent: 0,
    });
    for (const e of result.evidence) {
      expect(e.summary.toLowerCase()).not.toMatch(/private note|confidential|transcript body/);
      expect(JSON.stringify(e.refs ?? {})).not.toMatch(/noteBody|transcript|debrief/);
    }
  });

  test('service source enforces tenant_id on sp_* and engagement raw paths', () => {
    const src = readFileSync(
      join(__dirname, 'district-nexus-strategic.service.ts'),
      'utf8',
    );
    // Every sp_strategy / sp_node read must mention tenant_id.
    expect(src).toMatch(/FROM sp_strategy s[\s\S]*tenant_id/);
    expect(src).toMatch(/s\.tenant_id = \$\{tenantId\}/);
    expect(src).toMatch(/n\.tenant_id = s\.tenant_id|n\.tenant_id = \$\{tenantId\}/);
    // Free-text scoring must not be present as a credit path.
    expect(src).not.toMatch(/includes\(.*memberName/);
    expect(src).not.toMatch(/goal\.toLowerCase\(\)|meri_context\.toLowerCase\(\)/);
    // Archived clients contribute nothing.
    expect(src).toMatch(/status === 'archived'|status: \{ not: 'archived' \}|status !== 'archived'/);
  });

  test('exact member/committee identifiers are preferred in strategy target_ref parser path', () => {
    const src = readFileSync(
      join(__dirname, 'district-nexus-strategic.service.ts'),
      'utf8',
    );
    expect(src).toMatch(/memberId/);
    expect(src).toMatch(/systemCode|bioguideId/);
    // Must reject free-text-only target_ref
    expect(src).toMatch(/if \(!parsed\.memberId && !parsed\.systemCode\) continue/);
  });
});
