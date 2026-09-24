/**
 * Test fixtures for the canonical procurement line writer, modelled on the
 * real FY2027 Procurement, Defense-Wide (0300D) P-1 Line 68 — 0204WARSYS
 * "Warrior Systems <$5M" (scripts/__data__/pe_md_export/
 * pseries_defensewide_procurement_fy2027.md): FY2025 406,637 $K, FY2026
 * 499,582 $K, FY2027 511,016 $K; P-40/P-40a on PROC_SOCOM_PB_2027.pdf pp. 205-224.
 *
 * Pure data builders — shared by the planner, writer and read-service specs.
 * Not a spec itself.
 */
import type {
  DefenseBudgetAssertionV1,
  DefenseBudgetExtractionArtifactV1,
  ExhibitV1,
  FundingFieldV1,
  BudgetComponentV1,
  SourceEvidenceV1,
} from '../contracts/extraction-artifact-v1.js';
import {
  composeProcurementFamily,
  type ProcurementExhibitArtifacts,
  type ProcurementFamilyReport,
} from './procurement-composer-v1.js';

export const P1_SHA = 'a'.repeat(64);
export const P40_SHA = 'b'.repeat(64);
export const P1_SOURCE_DOCUMENT_ID = '11111111-1111-4111-8111-111111111111';
export const P40_SOURCE_DOCUMENT_ID = '22222222-2222-4222-8222-222222222222';
export const P1_URL =
  'https://comptroller.war.gov/Portals/45/Documents/defbudget/FY2027/FY2027_p1.pdf';
export const P40_URL =
  'https://comptroller.war.gov/Portals/45/Documents/defbudget/FY2027/budget_justification/pdfs/02_Procurement/PROC_SOCOM_PB_2027.pdf';

export const LINE68 = {
  code: '0204WARSYS',
  account: '0300D: Procurement, Defense-Wide',
  component: 'SOCOM' as BudgetComponentV1,
  title: 'Warrior Systems <$5M',
  p1LineNumber: 68,
  budgetActivity: 'BA 02: Special Operations Command',
  budgetSubActivity: 'U.S. Special Operations Command',
  relatedPeCode: '1160431BB',
} as const;

export const LINE69 = {
  code: '0206CMR',
  account: '0300D: Procurement, Defense-Wide',
  component: 'SOCOM' as BudgetComponentV1,
  title: 'Combat Mission Requirements',
  p1LineNumber: 69,
} as const;

/** FY -> P-1 request in $M (printed $K / 1000, exact). */
export const LINE68_REQUEST_M: Readonly<Record<number, string>> = {
  2025: '406.637',
  2026: '499.582',
  2027: '511.016',
};

export function blin(
  line: { code: string; account: string; component: BudgetComponentV1 },
  advanceProcurement = false,
) {
  return {
    lineKind: 'PROCUREMENT_BLIN' as const,
    code: line.code,
    account: line.account,
    component: line.component,
    ...(advanceProcurement ? { advanceProcurement: true } : {}),
  };
}

export function evidenceRow(input: {
  id: string;
  sha: string;
  page: number;
  excerpt?: string;
  sourceSpanSha256?: string;
}): SourceEvidenceV1 {
  return {
    evidenceId: input.id,
    sourcePdfSha256: input.sha,
    parserRunId: `run_${input.sha.slice(0, 4)}`,
    granularity: 'page_only',
    page: input.page,
    ...(input.excerpt ? { excerpt: input.excerpt } : {}),
    ...(input.sourceSpanSha256 ? { sourceSpanSha256: input.sourceSpanSha256 } : {}),
  };
}

export function catalogAssertion(input: {
  id: string;
  line: { code: string; account: string; component: BudgetComponentV1; title: string };
  fy: number;
  page?: number;
  metadata?: Record<string, string | number | boolean | null>;
  evidenceIds?: string[];
}): DefenseBudgetAssertionV1 {
  return {
    assertionId: input.id,
    assertionKind: 'procurement_line',
    parentIdentity: blin(input.line),
    description: input.line.title,
    fiscalYear: input.fy,
    sourceFactIds: [],
    evidenceIds: input.evidenceIds ?? [],
    confidence: 0.95,
    metadata: { ...(input.page != null ? { page: input.page } : {}), ...(input.metadata ?? {}) },
  };
}

export function fundingAssertion(input: {
  id: string;
  line: { code: string; account: string; component: BudgetComponentV1 };
  fy: number;
  field?: FundingFieldV1;
  valueMillions: string;
  originalValue?: string;
  originalUnit?: 'dollars' | 'thousands' | 'millions';
  page?: number;
  evidenceIds?: string[];
  metadata?: Record<string, string | number | boolean | null>;
  advanceProcurement?: boolean;
  confidence?: number;
}): DefenseBudgetAssertionV1 {
  return {
    assertionId: input.id,
    assertionKind: 'funding',
    identity: blin(input.line, input.advanceProcurement ?? false),
    fiscalYear: input.fy,
    field: input.field ?? 'request',
    money: {
      originalValue: input.originalValue ?? input.valueMillions,
      originalUnit: input.originalUnit ?? 'millions',
      valueMillions: input.valueMillions,
    },
    sourceFactIds: [],
    evidenceIds: input.evidenceIds ?? [],
    confidence: input.confidence ?? 0.95,
    metadata: {
      fundingStage: 'budget_year_request',
      baseOcoStatus: 'none',
      ...(input.page != null ? { page: input.page } : {}),
      ...(input.metadata ?? {}),
    },
  };
}

export function quantityAssertion(input: {
  id: string;
  line: { code: string; account: string; component: BudgetComponentV1 };
  fy: number;
  quantity: string;
  page?: number;
  metadata?: Record<string, string | number | boolean | null>;
}): DefenseBudgetAssertionV1 {
  return {
    assertionId: input.id,
    assertionKind: 'quantity',
    identity: blin(input.line),
    fiscalYear: input.fy,
    quantity: input.quantity,
    sourceFactIds: [],
    evidenceIds: [],
    confidence: 0.9,
    metadata: { ...(input.page != null ? { page: input.page } : {}), ...(input.metadata ?? {}) },
  };
}

export function makeArtifact(input: {
  id: string;
  exhibit: ExhibitV1;
  sha: string;
  url?: string;
  sourceDocumentId?: string;
  component?: BudgetComponentV1;
  assertions: DefenseBudgetAssertionV1[];
  evidence?: SourceEvidenceV1[];
}): DefenseBudgetExtractionArtifactV1 {
  return {
    schemaVersion: 'defense_budget_extraction_v1',
    artifactId: input.id,
    contentSha256: 'c'.repeat(64),
    source: {
      manifestDocumentKey: `${input.exhibit.toLowerCase()}_fy2027_socom`,
      ...(input.sourceDocumentId ? { sourceDocumentId: input.sourceDocumentId } : {}),
      sourcePdfSha256: input.sha,
      sourceLocator: `s3://capiro-defense-raw/${input.id}.pdf`,
      ...(input.url ? { sourceUrl: input.url } : {}),
      fiscalYear: 2027,
      family: 'procurement',
      exhibit: input.exhibit,
      authority: 'dod-comptroller',
      component: input.component ?? 'SOCOM',
      budgetCycle: 'pb_fy2027',
      documentType: 'pb_exhibit',
    },
    parserRuns: [
      {
        parserRunId: `run_${input.sha.slice(0, 4)}`,
        method: 'deterministic_pdfplumber',
        parserVersion: '1.2.3',
        parserConfigSha256: 'd'.repeat(64),
        inputSourceSha256: input.sha,
        outputArtifactSha256: 'e'.repeat(64),
        pageRanges: [],
      },
    ],
    evidence: input.evidence ?? [],
    sourceFacts: [],
    assertions: input.assertions,
    warnings: [],
    omissions: [],
    summary: {
      sourceFactCount: 0,
      requiredSourceFactCount: 0,
      coveredRequiredSourceFactCount: 0,
      omittedRequiredSourceFactCount: 0,
      uncoveredRequiredSourceFactCount: 0,
      assertionCount: input.assertions.length,
      warningCount: 0,
      omissionCount: 0,
      countsByAssertionKind: {},
      countsByOmissionReason: {},
      completenessStatus: 'complete',
    },
  };
}

export interface Line68FixtureOptions {
  /** Override the P-40 FY2026 value to force a P-1↔P-40 mismatch (blocking finding). */
  p40Fy2026?: string;
  /** Drop the P-1 artifact entirely (composer -> REJECTED). */
  omitP1?: boolean;
  /** Add a second, clean line (0206CMR) with matching P-1/P-40 values. */
  withLine69?: boolean;
  /** Strip page provenance from the P-1 assertion for this FY. */
  missingPageFy?: number;
  /** Add an RDT&E PE funding assertion inside the P-40 artifact. */
  withRdtePeAssertion?: boolean;
  /** Add an advance-procurement identity funding assertion. */
  withAdvanceProcurement?: boolean;
  /** Add a P-40a subline (category P1 "Satellite Deployable Node (SDN)") FY2027 value. */
  withSubline?: boolean;
  /** Add a FY2027 quantity assertion on the P-40. */
  quantityFy2027?: string;
}

/** The exact artifacts the composer consumes for the Line 68 family. */
export function line68Artifacts(options: Line68FixtureOptions = {}): ProcurementExhibitArtifacts {
  const p1Assertions: DefenseBudgetAssertionV1[] = [
    catalogAssertion({
      id: 'p1_cat_0204WARSYS',
      line: LINE68,
      fy: 2027,
      page: 12,
      metadata: { p1LineNumber: LINE68.p1LineNumber, budgetActivity: LINE68.budgetActivity },
    }),
  ];
  const p1Evidence: SourceEvidenceV1[] = [];
  for (const fy of [2025, 2026, 2027]) {
    const value = LINE68_REQUEST_M[fy]!;
    const evidenceId = `p1_ev_${fy}`;
    const hasPage = options.missingPageFy !== fy;
    if (hasPage) {
      p1Evidence.push(
        evidenceRow({
          id: evidenceId,
          sha: P1_SHA,
          page: 12,
          excerpt: `68 0204WARSYS Warrior Systems <$5M ... FY ${fy}: ${value.replace('.', ',')}`,
        }),
      );
    }
    p1Assertions.push(
      fundingAssertion({
        id: `p1_req_${fy}`,
        line: LINE68,
        fy,
        valueMillions: value,
        originalValue: value.replace('.', ''),
        originalUnit: 'thousands',
        evidenceIds: hasPage ? [evidenceId] : [],
        metadata: { p1LineNumber: LINE68.p1LineNumber },
      }),
    );
  }
  if (options.withLine69) {
    p1Assertions.push(
      catalogAssertion({
        id: 'p1_cat_0206CMR',
        line: LINE69,
        fy: 2027,
        page: 12,
        metadata: { p1LineNumber: LINE69.p1LineNumber },
      }),
      fundingAssertion({
        id: 'p1_req_0206CMR_2027',
        line: LINE69,
        fy: 2027,
        valueMillions: '4.988',
        originalValue: '4988',
        originalUnit: 'thousands',
        page: 12,
      }),
    );
  }

  const p40Assertions: DefenseBudgetAssertionV1[] = [
    catalogAssertion({
      id: 'p40_cat_0204WARSYS',
      line: LINE68,
      fy: 2027,
      page: 205,
      metadata: {
        budgetActivity: LINE68.budgetActivity,
        budgetSubActivity: LINE68.budgetSubActivity,
        relatedPeCode: LINE68.relatedPeCode,
      },
    }),
  ];
  const p40Evidence: SourceEvidenceV1[] = [];
  for (const fy of [2025, 2026, 2027]) {
    const value = fy === 2026 && options.p40Fy2026 ? options.p40Fy2026 : LINE68_REQUEST_M[fy]!;
    const evidenceId = `p40_ev_${fy}`;
    p40Evidence.push(
      evidenceRow({
        id: evidenceId,
        sha: P40_SHA,
        page: 205,
        excerpt: `Net Procurement (P-1) ($ in Millions) ... FY ${fy} ${value}`,
      }),
    );
    p40Assertions.push(
      fundingAssertion({
        id: `p40_req_${fy}`,
        line: LINE68,
        fy,
        valueMillions: value,
        evidenceIds: [evidenceId],
      }),
    );
  }
  if (options.withLine69) {
    p40Assertions.push(
      catalogAssertion({ id: 'p40_cat_0206CMR', line: LINE69, fy: 2027, page: 225 }),
      fundingAssertion({
        id: 'p40_req_0206CMR_2027',
        line: LINE69,
        fy: 2027,
        valueMillions: '4.988',
        page: 225,
      }),
    );
  }
  if (options.withSubline) {
    p40Assertions.push(
      fundingAssertion({
        id: 'p40a_req_P1_2027',
        line: LINE68,
        fy: 2027,
        valueMillions: '101.841',
        page: 206,
        metadata: {
          subExhibit: 'P-40a',
          sublineKey: 'P1',
          sublineTitle: 'Satellite Deployable Node (SDN)',
          // Distinct stage so the composer does not treat it as a duplicate P-40 total.
          fundingStage: 'continuation',
        },
      }),
    );
  }
  if (options.quantityFy2027) {
    p40Assertions.push(
      quantityAssertion({
        id: 'p40_qty_2027',
        line: LINE68,
        fy: 2027,
        quantity: options.quantityFy2027,
        page: 205,
      }),
    );
  }
  if (options.withRdtePeAssertion) {
    p40Assertions.push({
      assertionId: 'p40_pe_leak',
      assertionKind: 'funding',
      identity: { lineKind: 'RDTE_PE', peCode: '1160431BB' },
      fiscalYear: 2027,
      field: 'request',
      money: { originalValue: '1', originalUnit: 'millions', valueMillions: '1' },
      sourceFactIds: [],
      evidenceIds: [],
      confidence: 0.5,
      metadata: { page: 205 },
    });
  }
  if (options.withAdvanceProcurement) {
    p40Assertions.push(
      fundingAssertion({
        id: 'p40_ap_2027',
        line: LINE68,
        fy: 2027,
        valueMillions: '9.5',
        page: 207,
        advanceProcurement: true,
      }),
    );
  }

  return {
    p1Artifacts: options.omitP1
      ? []
      : [
          makeArtifact({
            id: 'dbx1_p1_fy2027_dw',
            exhibit: 'P-1',
            sha: P1_SHA,
            url: P1_URL,
            sourceDocumentId: P1_SOURCE_DOCUMENT_ID,
            component: 'DW',
            assertions: p1Assertions,
            evidence: p1Evidence,
          }),
        ],
    p40Artifacts: [
      makeArtifact({
        id: 'dbx1_p40_fy2027_socom',
        exhibit: 'P-40',
        sha: P40_SHA,
        url: P40_URL,
        sourceDocumentId: P40_SOURCE_DOCUMENT_ID,
        assertions: p40Assertions,
        evidence: p40Evidence,
      }),
    ],
    p5Artifacts: [],
    p21Artifacts: [],
    p3aArtifacts: [],
  };
}

export function composeLine68(
  artifacts: ProcurementExhibitArtifacts,
  overrides: Partial<Parameters<typeof composeProcurementFamily>[0]> = {},
): ProcurementFamilyReport {
  return composeProcurementFamily({
    artifacts,
    requiredIdentityKeys: [],
    p40Required: true,
    enrichmentRequired: false,
    requiredQuantityCategories: [],
    requiredUnitCostCategories: [],
    requiredNarrativeSections: [],
    ...overrides,
  });
}
