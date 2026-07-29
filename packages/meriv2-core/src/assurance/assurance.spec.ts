import { describe, expect, it } from '@jest/globals';
import {
  resolveGovernmentAffairsOperatingFrame,
  operatingFrameTraceRef,
} from './operating-frame';
import {
  inferClaimCategories,
  planGovernmentAffairsEvidence,
  missingRequiredEvidence,
} from './evidence-plan';
import {
  buildAssuredClaimLedger,
  claimLedgerReleaseable,
  evidenceSupportsNegativeClaim,
  repairClaimsForRelease,
  type AssuredEvidence,
} from './claim-ledger';
import { runGovernmentAffairsChecks } from './checks';
import {
  classifyAssuranceRisk,
  evaluateAssuranceRelease,
  shouldBufferRequestBeforeRelease,
} from './risk-gate';
import {
  genericRecommendationOption,
  validateGovernmentAffairsRecommendation,
} from './recommendation';
import {
  CAPIRO_APPROVED_GENERIC_POLICY_PACK,
  DISABLED_LEGAL_POLICY_EXAMPLES,
  canPublishPolicyPack,
  evaluatePolicyPack,
  proposalPolicyBinding,
  publishPolicyPack,
  rollbackPolicyPack,
  selectPolicyPack,
  validatePolicyPack,
  type CompliancePolicyPack,
} from './policy-pack';
import {
  defaultReleaseGateThresholds,
  evaluateReleaseGate,
  type EvalProvenance,
} from './eval-gate';
import {
  createFeedbackFixtureCandidate,
  reviewFeedbackFixtureCandidate,
} from './feedback-fixtures';
import { assuranceMetric } from './observability';
import { buildAssurancePromptBlock } from './prompt-block';

const NOW = '2026-07-28T16:00:00.000Z';

function frame(request: string, over: Record<string, unknown> = {}) {
  return resolveGovernmentAffairsOperatingFrame({
    request,
    asOf: NOW,
    ...over,
  });
}

function evidence(over: Partial<AssuredEvidence> = {}): AssuredEvidence {
  return {
    id: 'ev-1',
    sourceType: 'get_bill_status',
    sourceId: '119-hr-100',
    evidenceClass: 'official_action_vote_status',
    primary: true,
    authoritative: true,
    requirementIds: ['bill-status.official-status', 'bill-status.procedure'],
    asOf: NOW,
    ...over,
  };
}

function provenance(): EvalProvenance {
  return {
    gitSha: 'a'.repeat(40),
    promptVersion: 'ga-v1',
    contextCompilerVersion: 'context-v2',
    toolManifestHash: 'b'.repeat(64),
    model: 'test-model',
    provider: 'recorded',
    datasetVersion: 'ga-goldens-v1',
    date: NOW,
  };
}

describe('GovernmentAffairsOperatingFrame', () => {
  it('resolves federal, state, regulatory, procurement, grants, and mixed rails without defaulting federal', () => {
    expect(frame('What is the status of H.R. 100 in Congress?').jurisdictions).toEqual(['federal']);
    expect(frame('Compare the Florida state bill with H.R. 100.').jurisdictions).toEqual([
      'federal',
      'state',
    ]);
    expect(frame('Is the EPA proposed rule comment period still open?').jurisdictions).toEqual([
      'regulatory',
    ]);
    expect(frame('Review the SAM.gov RFP and the Grants.gov NOFO.').jurisdictions).toEqual([
      'procurement',
      'grants',
    ]);
    expect(frame('Write a background paragraph about autonomy.').jurisdictions).toEqual([]);
    expect(frame('Write a background paragraph about autonomy.').missingRequired).toContain(
      'jurisdiction',
    );
  });

  it('requires state, FY, and client-direction dimensions when material', () => {
    const result = frame('Recommend an advocacy strategy for the state budget request.');
    expect(result.missingRequired).toEqual(
      expect.arrayContaining(['stateCodes', 'fiscalYears', 'clientObjective', 'authorizedAsk']),
    );
  });

  it('uses client objective and ask only from approved direction', () => {
    const denied = frame('Recommend a strategy.', {
      approvedClientDirection: {
        approved: false,
        clientId: 'client-1',
        objective: 'Invented objective',
        authorizedAsk: 'Invented ask',
      },
    });
    expect(denied.clientObjective).toBeUndefined();
    expect(denied.authorizedAsk).toBeUndefined();

    const approved = frame('Recommend a strategy.', {
      approvedClientDirection: {
        approved: true,
        clientId: 'client-1',
        objective: 'Protect the authorized program',
        authorizedAsk: 'Restore the House cut',
      },
    });
    expect(approved.clientObjective).toBe('Protect the authorized program');
    expect(approved.authorizedAsk).toBe('Restore the House cut');
    expect(operatingFrameTraceRef(approved).operatingFrameHash).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe('domain evidence planning', () => {
  it('requires the correct official tool families for high-stakes categories', () => {
    const operatingFrame = frame(
      'Did H.R. 100 pass, how did the member vote, and what is the FY27 enacted amount?',
    );
    const plan = planGovernmentAffairsEvidence({
      request:
        'Did H.R. 100 pass, how did the member vote, and what is the FY27 enacted amount?',
      frame: operatingFrame,
      surface: 'chat',
    });
    expect(plan.requestCategories).toEqual(
      expect.arrayContaining(['bill_status', 'member_vote', 'budget_amount', 'enactment']),
    );
    expect(plan.requiredRequirementIds).toEqual(
      expect.arrayContaining([
        'bill-status.official-status',
        'member-vote.roll-call',
        'budget-amount.official',
        'enactment.public-law',
      ]),
    );
    expect(missingRequiredEvidence(plan, [])).toEqual(plan.requiredRequirementIds);
  });

  it('requires complete coverage for no/none/all/every claims', () => {
    expect(inferClaimCategories('There are no other awards and every relevant bill failed.')).toContain(
      'negative_or_exhaustive',
    );
    const operatingFrame = frame('There are no other federal awards.');
    const plan = planGovernmentAffairsEvidence({
      request: 'There are no other federal awards.',
      frame: operatingFrame,
    });
    expect(plan.requiredRequirementIds).toContain('negative-claim.coverage');
  });
});

describe('claim ledger', () => {
  it('does not accept fluent factual prose as self-supporting evidence', () => {
    const ledger = buildAssuredClaimLedger(
      [
        {
          id: 'claim-1',
          text: 'H.R. 100 became law.',
          type: 'fact',
          category: 'enactment',
          sourceIds: [],
          confidence: 'high',
        },
      ],
      [],
    );
    expect(ledger.claims[0]).toEqual(
      expect.objectContaining({
        confidence: 'unknown',
        unsupportedReason: expect.stringContaining('No cited evidence'),
      }),
    );
    expect(ledger.highRiskUnsupportedClaimIds).toEqual(['claim-1']);
    expect(claimLedgerReleaseable(ledger)).toBe(false);
  });

  it('resolves primary authoritative evidence and caps confidence at the evidence ceiling', () => {
    const ledger = buildAssuredClaimLedger(
      [
        {
          id: 'claim-1',
          text: 'H.R. 100 is introduced.',
          type: 'fact',
          category: 'bill_status',
          sourceIds: ['ev-1'],
          confidence: 'high',
        },
      ],
      [evidence()],
    );
    expect(ledger.claims[0]).toEqual(
      expect.objectContaining({ primarySourcePresent: true, confidence: 'high' }),
    );
    expect(claimLedgerReleaseable(ledger)).toBe(true);
  });

  it('requires complete non-truncated coverage for a negative claim', () => {
    const incomplete = evidence({
      evidenceClass: 'official_government_data',
      coverage: {
        description: 'First 20 results',
        complete: false,
        truncated: true,
        failedSources: [],
      },
    });
    expect(evidenceSupportsNegativeClaim([incomplete])).toBe(false);
    const ledger = buildAssuredClaimLedger(
      [
        {
          id: 'negative',
          text: 'No other awards exist.',
          type: 'fact',
          category: 'negative_or_exhaustive',
          sourceIds: ['ev-1'],
        },
      ],
      [incomplete],
    );
    expect(ledger.claims[0]?.unsupportedReason).toContain('complete, non-truncated');
  });

  it('removes unsupported facts and can relabel unsupported advice as uncertainty', () => {
    const ledger = buildAssuredClaimLedger(
      [
        { id: 'fact', text: 'It passed.', type: 'fact', category: 'bill_status' },
        {
          id: 'advice',
          text: 'Contact the chair.',
          type: 'recommendation',
          category: 'client_recommendation',
        },
      ],
      [],
    );
    const repaired = repairClaimsForRelease(ledger, {
      preserveUnsupportedAdviceAsUncertainty: true,
    });
    expect(repaired.removedClaimIds).toEqual(['fact']);
    expect(repaired.rewrittenClaimIds).toEqual(['advice']);
    expect(repaired.claims[0]?.type).toBe('uncertainty');
  });
});

describe('deterministic government-affairs checks', () => {
  it('requires enactment proof and correct stage ordering', () => {
    const ledger = buildAssuredClaimLedger(
      [
        {
          id: 'enacted',
          text: 'H.R. 100 was enacted and became public law.',
          type: 'fact',
          category: 'enactment',
          sourceIds: ['ev-1'],
        },
      ],
      [evidence()],
    );
    const findings = runGovernmentAffairsChecks({
      ledger,
      facts: [
        {
          kind: 'bill_status',
          evidenceId: 'ev-1',
          billId: '119-hr-100',
          jurisdiction: 'federal',
          status: 'introduced',
        },
      ],
    });
    expect(findings.map((item) => item.check)).toEqual(
      expect.arrayContaining(['GA-L1-enactment-proof', 'GA-L2-stage-ordering']),
    );
  });

  it('catches failed-rule advancement and a narrated vote with no roll call', () => {
    const ledger = buildAssuredClaimLedger(
      [
        {
          id: 'procedure',
          text: 'H.R. 100 advanced to the floor and passed by a 220-210 vote.',
          type: 'fact',
          category: 'bill_status',
          sourceIds: ['ev-1'],
        },
      ],
      [evidence()],
    );
    const findings = runGovernmentAffairsChecks({
      ledger,
      facts: [
        {
          kind: 'bill_status',
          evidenceId: 'ev-1',
          billId: '119-hr-100',
          jurisdiction: 'federal',
          status: 'introduced',
          ruleStatus: 'failed',
        },
        {
          kind: 'vote',
          evidenceId: 'ev-1',
          billId: '119-hr-100',
          voteRecorded: false,
        },
      ],
    });
    expect(findings.map((item) => item.check)).toEqual(
      expect.arrayContaining(['GA-L3-failed-rule', 'GA-L4-no-recorded-vote']),
    );
  });

  it('separates authorization/appropriation and PE/procurement identity', () => {
    const ledger = buildAssuredClaimLedger(
      [
        {
          id: 'budget',
          text: 'The NDAA appropriated $20 million to procurement PE 1234W567.',
          type: 'fact',
          category: 'budget_amount',
          sourceIds: ['budget-ev'],
        },
      ],
      [
        evidence({
          id: 'budget-ev',
          sourceId: '1234W567',
          evidenceClass: 'official_budget_exhibit_mark_law',
        }),
      ],
    );
    const findings = runGovernmentAffairsChecks({
      ledger,
      facts: [
        {
          kind: 'budget_position',
          evidenceId: 'budget-ev',
          subjectId: '1234W567',
          identifierKind: 'procurement_line',
          fiscalYear: 2027,
          stage: 'house',
          vehicleClass: 'authorization',
          scope: 'line_item',
          amount: 20,
          units: 'millions',
          appropriationCategory: 'procurement',
        },
      ],
    });
    expect(findings.map((item) => item.check)).toEqual(
      expect.arrayContaining([
        'GA-B1-authorization-appropriation',
        'GA-B4-pe-procurement-identity',
      ]),
    );
  });

  it('refuses a delta across different fiscal years/scopes', () => {
    const ledger = buildAssuredClaimLedger(
      [
        {
          id: 'delta',
          text: 'Funding increased by $10 million.',
          type: 'fact',
          category: 'budget_delta',
          sourceIds: ['a', 'b'],
        },
      ],
      [
        evidence({ id: 'a', sourceId: 'a', evidenceClass: 'official_budget_exhibit_mark_law' }),
        evidence({ id: 'b', sourceId: 'b', evidenceClass: 'official_budget_exhibit_mark_law' }),
      ],
    );
    const findings = runGovernmentAffairsChecks({
      ledger,
      facts: [
        {
          kind: 'budget_position',
          evidenceId: 'a',
          subjectId: '0600001A',
          identifierKind: 'program_element',
          fiscalYear: 2027,
          stage: 'request',
          vehicleClass: 'request',
          scope: 'program_element',
          amount: 10,
          units: 'millions',
        },
        {
          kind: 'budget_position',
          evidenceId: 'b',
          subjectId: '0600001A',
          identifierKind: 'program_element',
          fiscalYear: 2028,
          stage: 'house',
          vehicleClass: 'appropriation',
          scope: 'account',
          amount: 20,
          units: 'millions',
        },
      ],
    });
    expect(findings.map((item) => item.check)).toContain('GA-B3-delta-comparability');
  });

  it('requires canonical current-role, district, deadline, and timezone evidence', () => {
    const ledger = buildAssuredClaimLedger(
      [
        {
          id: 'mixed',
          text: 'The current chair represents District 5 and the docket is open until August 1.',
          type: 'fact',
          category: 'current_role',
          sourceIds: ['role', 'district', 'docket'],
        },
      ],
      [
        evidence({ id: 'role', sourceId: 'role', evidenceClass: 'official_government_data' }),
        evidence({ id: 'district', sourceId: 'district', evidenceClass: 'official_government_data' }),
        evidence({ id: 'docket', sourceId: 'docket', evidenceClass: 'committee_agency_guidance' }),
      ],
    );
    const findings = runGovernmentAffairsChecks({
      ledger,
      now: NOW,
      facts: [
        {
          kind: 'entity_role',
          evidenceId: 'role',
          label: 'Alex Smith',
          canonical: false,
          ambiguous: true,
        },
        {
          kind: 'district_representation',
          evidenceId: 'district',
          deterministicJoin: false,
        },
        {
          kind: 'regulatory_window',
          evidenceId: 'docket',
          docketId: 'D-1',
          stage: 'final',
          commentDeadline: '2026-07-01T23:59:00.000Z',
        },
      ],
    });
    expect(findings.map((item) => item.check)).toEqual(
      expect.arrayContaining([
        'GA-E1-entity-resolution',
        'GA-E2-current-role-asof',
        'GA-E3-district-determinism',
      ]),
    );
  });

  it('treats empty/failed/truncated retrieval as non-proof of absence', () => {
    const ledger = buildAssuredClaimLedger(
      [
        {
          id: 'negative',
          text: 'No other grants exist.',
          type: 'fact',
          category: 'negative_or_exhaustive',
          sourceIds: ['coverage'],
        },
      ],
      [
        evidence({
          id: 'coverage',
          sourceId: 'coverage',
          evidenceClass: 'official_government_data',
        }),
      ],
    );
    const findings = runGovernmentAffairsChecks({
      ledger,
      facts: [
        {
          kind: 'coverage',
          evidenceId: 'coverage',
          description: 'First page only',
          complete: false,
          truncated: true,
          failedSources: ['grants.gov detail'],
          empty: true,
        },
      ],
    });
    expect(findings.map((item) => item.check)).toEqual(
      expect.arrayContaining(['GA-A1-negative-coverage', 'GA-A2-tool-empty-failure']),
    );
  });
});

describe('buffer-before-release and recommendations', () => {
  it('buffers money/status/roles/deadlines and external artifacts before release', () => {
    expect(shouldBufferRequestBeforeRelease('What is the FY27 funding amount?')).toBe(true);
    expect(shouldBufferRequestBeforeRelease('Rewrite this greeting.')).toBe(false);
    expect(shouldBufferRequestBeforeRelease('Rewrite this greeting.', 'outreach')).toBe(true);
  });

  it('holds unsupported high-risk content rather than caveating it after release', () => {
    const operatingFrame = frame('What is the bill status?');
    const plan = planGovernmentAffairsEvidence({
      request: 'What is the bill status?',
      frame: operatingFrame,
      surface: 'chat',
    });
    const ledger = buildAssuredClaimLedger(
      [{ id: 'claim', text: 'It passed.', type: 'fact', category: 'bill_status' }],
      [],
      { plan },
    );
    const gate = evaluateAssuranceRelease({
      surface: 'chat',
      plan,
      ledger,
      verificationAvailable: true,
    });
    expect(gate.assessment.requiresBufferBeforeRelease).toBe(true);
    expect(gate.decision).toBe('repair');
    expect(gate.canStreamIrreversibly).toBe(false);
  });

  it('does not manufacture a client objective', () => {
    const operatingFrame = frame('Recommend a strategy.');
    const ledger = buildAssuredClaimLedger([], []);
    const option = genericRecommendationOption({
      id: 'option-1',
      requestedAction: 'Consider requesting a briefing.',
      evidenceBasis: [],
      uncertainty: 'The client objective has not been approved.',
      nextVerificationStep: 'Confirm the authorized ask with the client lead.',
    });
    expect(validateGovernmentAffairsRecommendation(option, operatingFrame, ledger).valid).toBe(
      false,
    );
    const clientSpecific = {
      ...option,
      genericOption: false,
      clientSpecific: true,
      evidenceBasis: ['missing'],
    };
    expect(
      validateGovernmentAffairsRecommendation(clientSpecific, operatingFrame, ledger).blockers,
    ).toEqual(expect.arrayContaining([expect.stringContaining('No approved client objective')]));
  });
});

describe('versioned compliance policy packs', () => {
  it('keeps approved generic action gates active and binds decisions to pack version', () => {
    expect(validatePolicyPack(CAPIRO_APPROVED_GENERIC_POLICY_PACK).valid).toBe(true);
    const selected = selectPolicyPack([CAPIRO_APPROVED_GENERIC_POLICY_PACK], {
      tenantId: 'tenant',
      actorUserId: 'user',
      actorRole: 'standard_user',
      jurisdiction: 'federal',
      tool: 'send_email',
      channel: 'email',
      recipientType: 'government',
      at: NOW,
    });
    expect(selected?.id).toBe(CAPIRO_APPROVED_GENERIC_POLICY_PACK.id);
    const decision = evaluatePolicyPack(selected!, {
      tenantId: 'tenant',
      actorUserId: 'user',
      actorRole: 'standard_user',
      jurisdiction: 'federal',
      tool: 'send_email',
      channel: 'email',
      recipientType: 'government',
      at: NOW,
    });
    expect(decision).toEqual(
      expect.objectContaining({ outcome: 'WARN', ruleId: 'send.requires_approval' }),
    );
    expect(proposalPolicyBinding(decision)).toContain(
      `${selected!.id}@${selected!.version}`,
    );
    for (const tool of [
      'save_note',
      'save_memory',
      'create_word',
      'create_excel',
      'create_powerpoint',
      'create_meeting_brief',
      'draft_policy_memo',
    ]) {
      expect(
        evaluatePolicyPack(selected!, {
          tenantId: 'tenant',
          actorUserId: 'user',
          actorRole: 'standard_user',
          jurisdiction: 'federal',
          tool,
          channel: 'internal',
          at: NOW,
        }).outcome,
      ).toBe('PASS');
    }
  });

  it('makes every legal-policy example impossible to activate', () => {
    for (const pack of DISABLED_LEGAL_POLICY_EXAMPLES) {
      expect(pack.status).toBe('disabled_example');
      expect(pack.rules).toEqual([]);
      expect(
        canPublishPolicyPack(pack, { userId: 'admin', role: 'user_admin' }).valid,
      ).toBe(false);
      expect(
        evaluatePolicyPack(
          pack,
          {
            tenantId: 'tenant',
            actorUserId: 'admin',
            actorRole: 'user_admin',
            jurisdiction: 'federal',
            tool: 'anything',
            channel: 'internal',
            at: NOW,
          },
          true,
        ).outcome,
      ).toBe('WARN');
    }
  });

  it('enforces admin publishing, review state, and optional four-eyes separation', () => {
    const reviewed: CompliancePolicyPack = {
      ...JSON.parse(JSON.stringify(CAPIRO_APPROVED_GENERIC_POLICY_PACK)),
      version: 'next',
      status: 'reviewed',
      legalReviewStatus: 'approved',
      ownerUserId: 'owner',
      reviewedByUserId: 'reviewer-1',
      reviewedAt: NOW,
      secondApprovedByUserId: 'reviewer-2',
      secondApprovedAt: NOW,
      publishedByUserId: undefined,
      publishedAt: undefined,
      fourEyesRequired: true,
    };
    expect(canPublishPolicyPack(reviewed, { userId: 'standard', role: 'standard_user' }).valid).toBe(
      false,
    );
    expect(canPublishPolicyPack(reviewed, { userId: 'reviewer-1', role: 'user_admin' }).valid).toBe(
      false,
    );
    const published = publishPolicyPack(reviewed, { userId: 'publisher', role: 'user_admin' }, NOW);
    expect(published.status).toBe('published');
    const rolled = rollbackPolicyPack(
      published,
      CAPIRO_APPROVED_GENERIC_POLICY_PACK,
      { userId: 'admin-2', role: 'user_admin' },
      NOW,
    );
    expect(rolled.retired.status).toBe('retired');
    expect(rolled.restored.status).toBe('published');
  });
});

describe('release eval gates and feedback loop', () => {
  it('does not let an aggregate score hide a critical category failure', () => {
    const report = evaluateReleaseGate({
      provenance: provenance(),
      thresholds: defaultReleaseGateThresholds(),
      results: [
        {
          id: 'legislation-enactment',
          tier: 'L0',
          domain: 'legislation',
          severity: 'critical',
          passed: false,
          metric: 'deterministic_check',
          detail: 'Enactment proof regressed.',
        },
        {
          id: 'overall-quality',
          tier: 'L3',
          domain: 'general',
          severity: 'low',
          passed: true,
          score: 0.99,
          metric: 'expert_quality',
          detail: 'Aggregate score is high.',
        },
      ],
    });
    expect(report.allowed).toBe(false);
    expect(report.blockers[0]).toContain('Critical legislation regression');
    expect(report.domains.find((item) => item.domain === 'legislation')?.criticalFailed).toBe(1);
  });

  it('never turns feedback into a golden fixture without review and anonymization', () => {
    const candidate = createFeedbackFixtureCandidate({
      reasonCodes: ['factually_wrong'],
      surface: 'chat',
      traceId: 'trace-1',
      contextPacketId: 'packet-1',
      claimLedgerHash: 'hash-1',
      summary: 'The answer used the wrong chamber status.',
      createdByUserId: 'user-1',
      createdAt: NOW,
    });
    expect(candidate.status).toBe('pending_review');
    expect(() =>
      reviewFeedbackFixtureCandidate(candidate, {
        decision: 'accept',
        reviewerUserId: 'reviewer',
        reviewReason: 'Valid regression',
        anonymizationVersion: '',
        datasetVersion: 'v2',
      }),
    ).toThrow('anonymized');
    const accepted = reviewFeedbackFixtureCandidate(candidate, {
      decision: 'accept',
      reviewerUserId: 'reviewer',
      reviewReason: 'Validated and anonymized.',
      anonymizationVersion: 'anon-v1',
      datasetVersion: 'ga-goldens-v2',
      at: NOW,
    });
    expect(accepted.candidate.status).toBe('accepted');
    expect(accepted.fixture?.sourceCandidateId).toBe(candidate.id);
  });

  it('keeps observability content-free', () => {
    expect(
      assuranceMetric({
        name: 'citation_failure',
        dimensions: { surface: 'chat', severity: 'high', model: 'test' },
        at: NOW,
      }),
    ).toEqual(expect.objectContaining({ namespace: 'Capiro/MeriAssurance' }));
    expect(() =>
      assuranceMetric({
        name: 'unsupported_claim',
        dimensions: { surface: 'chat', prompt: 'secret prompt' } as never,
      }),
    ).toThrow('may not include content');
  });

  it('renders a shared prompt block with frame gaps and evidence requirements', () => {
    const operatingFrame = frame('Recommend a state budget strategy.');
    const plan = planGovernmentAffairsEvidence({
      request: 'Recommend a state budget strategy.',
      frame: operatingFrame,
      surface: 'strategy',
    });
    const block = buildAssurancePromptBlock(operatingFrame, plan);
    expect(block).toContain('<government_affairs_assurance version="1">');
    expect(block).toContain('Blocking frame gaps');
    expect(block).toContain('client-recommendation.approved-direction');
    expect(classifyAssuranceRisk('strategy', plan).requiresBufferBeforeRelease).toBe(true);
  });
});
