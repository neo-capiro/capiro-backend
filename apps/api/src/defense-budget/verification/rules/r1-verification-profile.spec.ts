/**
 * r1-verification-profile.spec — Workstream D tests.
 *
 * Tests the actual Phase 2 policy registry and the R1_SPECIFIC_RULE against
 * realistic artifact contexts. Proves that an incomplete R-1 artifact cannot
 * receive VERIFICATION_PASSED.
 */
import { R1_SPECIFIC_RULE } from './r1-verification.rules.js';
import { lookupPolicyByExhibit } from '../verification-policy-registry.js';
import type { VerificationContextV1 } from '../verification-input-v1.js';
import type { DefenseBudgetExtractionArtifactV1 } from '../../contracts/extraction-artifact-v1.js';
import type { BudgetCycleManifestV1 } from '../../contracts/budget-cycle-manifest-v1.js';

const SHA = 'e'.repeat(64);

function makeManifest(overrides: Partial<BudgetCycleManifestV1> = {}): BudgetCycleManifestV1 {
  return {
    schemaVersion: 'defense_budget_cycle_manifest_v1',
    cycleId: 'pb_fy2027_rdte',
    fiscalYear: 2027,
    domain: 'defense',
    documents: [
      {
        documentKey: 'r1_army',
        required: true,
        title: 'R-1 Army',
        sourceLocator: 's3://b/r1.pdf',
        family: 'rdte',
        exhibit: 'R-1',
        authority: 'dod-comptroller',
        component: 'ARMY',
        budgetCycle: 'pb_fy2027',
        documentType: 'pb_exhibit',
        parserPolicy: 'deterministic_table',
        requiredDataCategories: ['identity', 'funding'],
        requiredFundingFields: ['request'],
        expectedLineKinds: ['RDTE_PE'],
        allowEmpty: false,
      },
    ],
    ...overrides,
  };
}

function makeArtifact(
  assertions: Array<Record<string, unknown>>,
  omissions: Array<Record<string, unknown>> = [],
  warnings: Array<Record<string, unknown>> = [],
  sourceFacts: Array<Record<string, unknown>> = [],
): DefenseBudgetExtractionArtifactV1 {
  return {
    schemaVersion: 'defense_budget_extraction_v1',
    artifactId: 'dbx1_' + 'e'.repeat(64),
    contentSha256: SHA,
    source: {
      manifestDocumentKey: 'r1_army',
      sourcePdfSha256: SHA,
      sourceLocator: 's3://b/r1.pdf',
      fiscalYear: 2027,
      family: 'rdte',
      exhibit: 'R-1',
      authority: 'dod-comptroller',
      component: 'ARMY',
      budgetCycle: 'pb_fy2027',
      documentType: 'pb_exhibit',
    },
    parserRuns: [],
    evidence: [],
    sourceFacts: sourceFacts as never,
    assertions: assertions as never,
    warnings: warnings as never,
    omissions: omissions as never,
    summary: {
      sourceFactCount: sourceFacts.length,
      requiredSourceFactCount: sourceFacts.length,
      coveredRequiredSourceFactCount: 0,
      omittedRequiredSourceFactCount: 0,
      uncoveredRequiredSourceFactCount: 0,
      assertionCount: assertions.length,
      warningCount: warnings.length,
      omissionCount: omissions.length,
      countsByAssertionKind: {},
      countsByOmissionReason: {},
      completenessStatus: 'incomplete',
    },
  } as DefenseBudgetExtractionArtifactV1;
}

function makeContext(artifact: DefenseBudgetExtractionArtifactV1): VerificationContextV1 {
  const policy = lookupPolicyByExhibit('R-1');
  if (policy == null) throw new Error('R-1 policy not registered');
  return {
    input: {
      request: {
        manifestDocumentKey: 'r1_army',
        sourceDocumentId: 'doc_1',
        manifestLocator: 's3://b/manifest.json',
        extractionArtifactLocator: 's3://b/artifact.json',
        mode: 'inspect',
      },
      manifest: makeManifest(),
      manifestContentSha256: SHA,
      manifestDocumentKey: 'r1_army',
      artifact,
      extractionArtifactSha256: SHA,
      proofBundle: {} as never,
      proofFindings: [],
      referenceArtifacts: [],
      referenceArtifactsProofBundles: [],
      referenceArtifactsFindings: [],
      startedAt: '2026-01-01T00:00:00Z',
    },
    policy,
    policySha256: SHA,
    verificationRunId: 'run_1',
    candidateId: 'cand_1',
  };
}

function identityAssertion(peCode: string) {
  return {
    assertionKind: 'program_element_identity',
    assertionId: `asrt_id_${peCode}`,
    sourceFactIds: [`fact_id_${peCode}`],
    evidenceIds: [],
    confidence: 1,
    identity: { lineKind: 'RDTE_PE', peCode },
    title: `PE ${peCode}`,
    component: 'ARMY',
  };
}

function fundingAssertion(peCode: string, fy: number, metadata?: Record<string, unknown>) {
  return {
    assertionKind: 'funding',
    assertionId: `asrt_f_${peCode}_${fy}`,
    sourceFactIds: [`fact_f_${peCode}_${fy}`],
    evidenceIds: [],
    confidence: 1,
    identity: { lineKind: 'RDTE_PE', peCode },
    fiscalYear: fy,
    field: 'request',
    money: { originalValue: '100', originalUnit: 'thousands', valueMillions: '0.1' },
    metadata,
  };
}

function moneyFact(id: string) {
  return {
    factId: id,
    sourcePath: 'page:1',
    category: 'money',
    requiredForCompleteness: true,
    rawValue: '100',
    evidenceIds: [],
  };
}

describe('R-1 verification policy profile', () => {
  it('R-1 policy is registered and supported', () => {
    const policy = lookupPolicyByExhibit('R-1');
    expect(policy).not.toBeNull();
    expect(policy?.family).toBe('rdte');
    expect(policy?.exhibit).toBe('R-1');
    expect(policy?.requiredDataCategories).toContain('identity');
    expect(policy?.requiredDataCategories).toContain('funding');
  });
});

describe('R1_SPECIFIC_RULE', () => {
  it('passes a complete valid R-1 artifact', () => {
    const artifact = makeArtifact(
      [identityAssertion('0601101A'), fundingAssertion('0601101A', 2027)],
      [],
      [],
      [moneyFact('fact_f_0601101A_2027')],
    );
    const result = R1_SPECIFIC_RULE.execute(makeContext(artifact));
    expect(result.check?.outcome).toBe('PASS');
    expect(result.discrepancies.filter((d) => d.severity === 'blocking')).toHaveLength(0);
  });

  it('blocks when a required R-1 document has zero PE identities', () => {
    const artifact = makeArtifact([]);
    const result = R1_SPECIFIC_RULE.execute(makeContext(artifact));
    expect(result.check?.outcome).toBe('FAIL');
    expect(
      result.discrepancies.some((d) => d.code === 'r1_zero_pe_identities' && d.severity === 'blocking'),
    ).toBe(true);
  });

  it('blocks on invalid PE identity', () => {
    const artifact = makeArtifact([identityAssertion('O6O11O1A')]);
    const result = R1_SPECIFIC_RULE.execute(makeContext(artifact));
    expect(
      result.discrepancies.some((d) => d.code === 'r1_invalid_pe_identity' && d.severity === 'blocking'),
    ).toBe(true);
  });

  it('blocks when a printed money fact is neither asserted nor omitted', () => {
    const artifact = makeArtifact(
      [identityAssertion('0601101A')],
      [],
      [],
      [moneyFact('fact_orphan')],
    );
    const result = R1_SPECIFIC_RULE.execute(makeContext(artifact));
    expect(
      result.discrepancies.some(
        (d) => d.code === 'r1_money_fact_neither_asserted_nor_omitted' && d.severity === 'blocking',
      ),
    ).toBe(true);
  });

  it('blocks on missing unit omissions', () => {
    const artifact = makeArtifact(
      [identityAssertion('0601101A')],
      [
        {
          omissionId: 'omit_1',
          sourceFactId: 'fact_1',
          reason: 'unsupported_unit',
          severity: 'blocking',
          message: 'missing unit',
        },
      ],
    );
    const result = R1_SPECIFIC_RULE.execute(makeContext(artifact));
    expect(
      result.discrepancies.some((d) => d.code === 'r1_missing_unit' && d.severity === 'blocking'),
    ).toBe(true);
  });

  it('blocks on duplicate conflicting PE/FY/role values', () => {
    const artifact = makeArtifact(
      [identityAssertion('0601101A')],
      [],
      [
        {
          warningId: 'warn_1',
          code: 'r1_duplicate_conflicting_value',
          severity: 'blocking',
          message: 'conflict',
          sourceFactIds: [],
          evidenceIds: [],
        },
      ],
    );
    const result = R1_SPECIFIC_RULE.execute(makeContext(artifact));
    expect(
      result.discrepancies.some(
        (d) => d.code === 'r1_duplicate_conflicting_value' && d.severity === 'blocking',
      ),
    ).toBe(true);
  });

  it('blocks when budget-year request is missing but funding is required', () => {
    const artifact = makeArtifact([identityAssertion('0601101A')]);
    const result = R1_SPECIFIC_RULE.execute(makeContext(artifact));
    expect(
      result.discrepancies.some(
        (d) => d.code === 'r1_budget_year_request_missing' && d.severity === 'blocking',
      ),
    ).toBe(true);
  });

  it('blocks when a contextual value is marked canonical-request eligible', () => {
    const artifact = makeArtifact([
      identityAssertion('0601101A'),
      fundingAssertion('0601101A', 2027, {
        columnRole: 'prior_actual_context',
        disposition: 'canonical_request_candidate',
      }),
    ]);
    const result = R1_SPECIFIC_RULE.execute(makeContext(artifact));
    expect(
      result.discrepancies.some(
        (d) => d.code === 'r1_contextual_or_outyear_marked_canonical' && d.severity === 'blocking',
      ),
    ).toBe(true);
  });

  it('blocks when an outyear value is marked canonical-request eligible', () => {
    const artifact = makeArtifact([
      identityAssertion('0601101A'),
      fundingAssertion('0601101A', 2028, {
        columnRole: 'outyear_projection',
        disposition: 'canonical_request_candidate',
      }),
    ]);
    const result = R1_SPECIFIC_RULE.execute(makeContext(artifact));
    expect(
      result.discrepancies.some(
        (d) => d.code === 'r1_contextual_or_outyear_marked_canonical' && d.severity === 'blocking',
      ),
    ).toBe(true);
  });

  it('blocks when a request assertion uses the wrong fiscal year', () => {
    const artifact = makeArtifact([
      identityAssertion('0601101A'),
      fundingAssertion('0601101A', 2028),
    ]);
    const result = R1_SPECIFIC_RULE.execute(makeContext(artifact));
    expect(
      result.discrepancies.some(
        (d) => d.code === 'r1_request_wrong_fiscal_year' && d.severity === 'blocking',
      ),
    ).toBe(true);
  });

  it('blocks when an outyear projection is not after the cycle FY', () => {
    const artifact = makeArtifact([
      identityAssertion('0601101A'),
      {
        assertionKind: 'document_fact',
        assertionId: 'asrt_df_1',
        sourceFactIds: [],
        evidenceIds: [],
        confidence: 1,
        fieldName: 'r1_outyear_projection',
        value: {
          peCode: '0601101A',
          fiscalYear: 2026,
          columnRole: 'outyear_projection',
          disposition: 'pe_budget_position',
        },
      },
    ]);
    const result = R1_SPECIFIC_RULE.execute(makeContext(artifact));
    expect(
      result.discrepancies.some(
        (d) => d.code === 'r1_outyear_not_after_cycle_fy' && d.severity === 'blocking',
      ),
    ).toBe(true);
  });

  it('blocks when historical context is marked canonical', () => {
    const artifact = makeArtifact([
      identityAssertion('0601101A'),
      {
        assertionKind: 'document_fact',
        assertionId: 'asrt_df_2',
        sourceFactIds: [],
        evidenceIds: [],
        confidence: 1,
        fieldName: 'r1_prior_actual_context',
        value: {
          peCode: '0601101A',
          fiscalYear: 2025,
          columnRole: 'prior_actual_context',
          disposition: 'canonical_request_candidate',
        },
      },
    ]);
    const result = R1_SPECIFIC_RULE.execute(makeContext(artifact));
    expect(
      result.discrepancies.some(
        (d) => d.code === 'r1_historical_context_marked_canonical' && d.severity === 'blocking',
      ),
    ).toBe(true);
  });

  it('routes unexpected header vocabulary to review', () => {
    const artifact = makeArtifact(
      [identityAssertion('0601101A'), fundingAssertion('0601101A', 2027)],
      [
        {
          omissionId: 'omit_2',
          sourceFactId: 'fact_2',
          reason: 'ambiguous_layout',
          severity: 'review',
          message: 'unresolved column',
        },
      ],
    );
    const result = R1_SPECIFIC_RULE.execute(makeContext(artifact));
    expect(
      result.discrepancies.some(
        (d) => d.code === 'r1_unexpected_header_vocabulary' && d.severity === 'review',
      ),
    ).toBe(true);
  });

  it('does not run on non-R-1 documents', () => {
    const artifact = makeArtifact([]);
    const ctx = makeContext(artifact);
    const doc = ctx.input.manifest.documents[0];
    if (doc != null) {
      (doc as { exhibit: string }).exhibit = 'R-2';
    }
    const result = R1_SPECIFIC_RULE.execute(ctx);
    expect(result.check?.outcome).toBe('PASS');
  });
});
