import {
  CAPIRO_APPROVED_GENERIC_POLICY_PACK,
  DISABLED_LEGAL_POLICY_EXAMPLES,
  buildAssuredClaimLedger,
  defaultReleaseGateThresholds,
  evaluatePolicyPack,
  evaluateReleaseGate,
  planGovernmentAffairsEvidence,
  resolveGovernmentAffairsOperatingFrame,
  runGovernmentAffairsChecks,
  shouldBufferRequestBeforeRelease,
} from '../../../src/assurance/index';
import type { EvalCase } from '../types';
import {
  GOVERNMENT_AFFAIRS_GOLDENS,
  GOVERNMENT_AFFAIRS_GOLDEN_VERSION,
  REQUIRED_GOLDEN_DOMAINS,
} from './golden-fixtures';

export const governmentAffairsAssuranceCase: EvalCase = {
  id: `government-affairs-assurance-${GOVERNMENT_AFFAIRS_GOLDEN_VERSION}`,
  category: 'assurance',
  description:
    'Operating-frame resolution, deterministic GA checks, high-risk buffering, policy-pack safety, and golden coverage.',
  async run() {
    const failures: string[] = [];
    const ids = new Set<string>();
    for (const fixture of GOVERNMENT_AFFAIRS_GOLDENS) {
      if (ids.has(fixture.id)) failures.push(`duplicate fixture id ${fixture.id}`);
      ids.add(fixture.id);
    }
    const domains = new Set(GOVERNMENT_AFFAIRS_GOLDENS.map((fixture) => fixture.domain));
    for (const required of REQUIRED_GOLDEN_DOMAINS) {
      if (!domains.has(required)) failures.push(`missing golden domain ${required}`);
    }

    const mixed = resolveGovernmentAffairsOperatingFrame({
      request: 'Compare H.R. 100 with the Florida state bill.',
      asOf: '2026-07-28T00:00:00.000Z',
    });
    if (mixed.jurisdictions.join(',') !== 'federal,state') {
      failures.push(`mixed jurisdiction resolved as ${mixed.jurisdictions.join(',')}`);
    }
    const ambiguous = resolveGovernmentAffairsOperatingFrame({
      request: 'What happened to the zoning ordinance?',
      asOf: '2026-07-28T00:00:00.000Z',
    });
    // "zoning" is a genuine local cue, so resolving jurisdiction='local' is correct
    // here. What is actually unknown is WHICH local body, which the resolver reports
    // as the more precise 'localInstitution' gap. The invariant this guards is that
    // an ambiguous local request never proceeds on a frame it considers complete.
    if (!ambiguous.missingRequired.includes('localInstitution')) {
      failures.push('ambiguous local request silently received a complete frame');
    }

    const plan = planGovernmentAffairsEvidence({
      request: 'Did H.R. 100 become law and what is the FY27 enacted amount?',
      frame: resolveGovernmentAffairsOperatingFrame({
        request: 'Did H.R. 100 become law and what is the FY27 enacted amount?',
        asOf: '2026-07-28T00:00:00.000Z',
      }),
      surface: 'chat',
    });
    if (!plan.requiredRequirementIds.includes('enactment.public-law')) {
      failures.push('enactment plan omitted public-law proof');
    }
    if (!plan.requiredRequirementIds.includes('budget-amount.official')) {
      failures.push('budget plan omitted official position proof');
    }

    const ledger = buildAssuredClaimLedger(
      [
        {
          id: 'claim',
          text: 'H.R. 100 became public law.',
          type: 'fact',
          category: 'enactment',
          sourceIds: ['bill'],
        },
      ],
      [
        {
          id: 'bill',
          sourceType: 'get_bill_status',
          sourceId: '119-hr-100',
          evidenceClass: 'official_action_vote_status',
          primary: true,
          authoritative: true,
          requirementIds: ['bill-status.official-status'],
        },
      ],
      { plan },
    );
    const findings = runGovernmentAffairsChecks({
      ledger,
      facts: [
        {
          kind: 'bill_status',
          evidenceId: 'bill',
          billId: '119-hr-100',
          jurisdiction: 'federal',
          status: 'introduced',
        },
      ],
    });
    if (!findings.some((finding) => finding.check === 'GA-L1-enactment-proof')) {
      failures.push('enactment-proof incident fixture did not fire');
    }

    if (!shouldBufferRequestBeforeRelease('What is the current FY27 amount?')) {
      failures.push('high-risk money/current request would stream irreversibly');
    }
    if (shouldBufferRequestBeforeRelease('Rewrite this greeting for clarity.')) {
      failures.push('low-risk style request was unnecessarily classified high-risk');
    }

    for (const example of DISABLED_LEGAL_POLICY_EXAMPLES) {
      const decision = evaluatePolicyPack(
        example,
        {
          tenantId: 'tenant',
          actorUserId: 'user',
          actorRole: 'user_admin',
          jurisdiction: 'federal',
          tool: 'send_email',
          channel: 'email',
          at: '2026-07-28T00:00:00.000Z',
        },
        true,
      );
      if (example.status !== 'disabled_example' || example.rules.length || decision.outcome !== 'WARN') {
        failures.push(`legal example ${example.id} is activatable or contains a substantive rule`);
      }
    }
    const generic = evaluatePolicyPack(CAPIRO_APPROVED_GENERIC_POLICY_PACK, {
      tenantId: 'tenant',
      actorUserId: 'user',
      actorRole: 'standard_user',
      jurisdiction: 'federal',
      tool: 'send_email',
      channel: 'email',
      recipientType: 'government',
      at: '2026-07-28T00:00:00.000Z',
    });
    // The rule really is 'send.requires_approval' in CAPIRO_APPROVED_GENERIC_POLICY_PACK;
    // the previous id here was never defined anywhere in the pack.
    if (generic.outcome !== 'WARN' || generic.ruleId !== 'send.requires_approval') {
      failures.push('approved generic external-send gate changed behavior');
    }

    const gate = evaluateReleaseGate({
      provenance: {
        gitSha: 'deterministic-fixture',
        promptVersion: 'ga-assurance-v1',
        contextCompilerVersion: 'context-compiler-v2.0',
        toolManifestHash: 'fixture',
        model: 'none-deterministic',
        provider: 'none',
        datasetVersion: GOVERNMENT_AFFAIRS_GOLDEN_VERSION,
        date: '2026-07-28T00:00:00.000Z',
      },
      thresholds: defaultReleaseGateThresholds(),
      results: [
        {
          id: 'critical-stage-regression',
          tier: 'L0',
          domain: 'legislation',
          severity: 'critical',
          passed: false,
          metric: 'deterministic_check',
          detail: 'Fixture proves category-specific blocking.',
        },
        {
          id: 'high-aggregate',
          tier: 'L3',
          domain: 'general',
          severity: 'low',
          passed: true,
          metric: 'expert_quality',
          score: 0.99,
          detail: 'Must not mask critical failure.',
        },
      ],
    });
    if (gate.allowed) failures.push('aggregate quality hid a critical category failure');

    return {
      pass: failures.length === 0,
      detail: failures.length
        ? failures.join('; ')
        : `${GOVERNMENT_AFFAIRS_GOLDENS.length} versioned goldens cover ${domains.size} domains; deterministic assurance mechanisms passed.`,
    };
  },
};
