/**
 * Workstream I — adapter for the legacy congressional rows artifacts consumed
 * by parse-hasc-sasc-reports.ts, parse-defense-approps-reports.ts,
 * parse-ndaa-conference.ts, and parse-defense-approps-public-law.ts.
 *
 * The caller selects one exact committee mode; the mode owns the target funding
 * field. Duplicate PE rows are preserved as duplicate facts/assertions — the
 * adapter NEVER calls the legacy last-wins `dedupeByPe` helper.
 *
 * Truthfulness rules:
 *   - Rows without a page produce `document_only` evidence plus a
 *     `legacy_committee_artifact_missing_page` warning; pages are never coerced.
 *   - Money units must be declared (row-level requestUnit/markUnit, or the
 *     configured legacy convention). Unprovable units become blocking
 *     `unsupported_unit` omissions; magnitude is never used to infer units.
 */
import { z } from 'zod';
import { isValidPeCode } from '../../extractors/types.js';
import { ArtifactBuilderV1, assertionIdV1 } from '../artifact-builders.js';
import type {
  BudgetAuthorityV1,
  DefenseBudgetExtractionArtifactV1,
  FundingFieldV1,
  MoneyValueV1,
} from '../extraction-artifact-v1.js';
import { moneyToMillionsString, parseCanonicalDecimalString } from '../decimal-string.js';
import {
  parserRunFromContext,
  sourceFromContext,
  type ExtractionAdapterContextV1,
} from './adapter-context.js';
import {
  buildOmission,
  buildSourceFact,
  buildTruthfulEvidence,
  buildWarning,
} from './adapter-helpers.js';

/* ------------------------------------------------------------------ */
/* adapter modes                                                       */
/* ------------------------------------------------------------------ */

export const COMMITTEE_ADAPTER_MODE_VALUES = [
  'HASC',
  'SASC',
  'HAC-D',
  'SAC-D',
  'NDAA_CONFERENCE',
  'APPROPRIATIONS_CONFERENCE',
  'PUBLIC_LAW',
] as const;
export type CommitteeAdapterMode = (typeof COMMITTEE_ADAPTER_MODE_VALUES)[number];

/** Mode owns the target funding field for the row's `mark` value. */
export const COMMITTEE_MODE_FUNDING_FIELD: Record<CommitteeAdapterMode, FundingFieldV1> = {
  HASC: 'hascMark',
  SASC: 'sascMark',
  'HAC-D': 'hacDMark',
  'SAC-D': 'sacDMark',
  NDAA_CONFERENCE: 'ndaaConference',
  APPROPRIATIONS_CONFERENCE: 'conference',
  PUBLIC_LAW: 'enacted',
};

/** Mode owns the contract authority asserted for the source document. */
export const COMMITTEE_MODE_AUTHORITY: Record<CommitteeAdapterMode, BudgetAuthorityV1> = {
  HASC: 'hasc',
  SASC: 'sasc',
  'HAC-D': 'hac_d',
  'SAC-D': 'sac_d',
  NDAA_CONFERENCE: 'ndaa_conference',
  APPROPRIATIONS_CONFERENCE: 'appropriations_conference',
  PUBLIC_LAW: 'public_law',
};

/* ------------------------------------------------------------------ */
/* adapter-local strict input schema                                   */
/* ------------------------------------------------------------------ */

const moneyInputSchema = z.union([z.string(), z.number()]);

export const committeeRowV1Schema = z
  .object({
    peCode: z.string().nullish(),
    fy: z.union([z.number(), z.string()]).nullish(),
    request: moneyInputSchema.nullish(),
    mark: moneyInputSchema.nullish(),
    explanation: z.string().nullish(),
    page: z.number().int().positive().nullish(),
    printedPage: z.string().nullish(),
    rowLabel: z.string().nullish(),
    requestUnit: z.enum(['dollars', 'thousands', 'millions']).nullish(),
    markUnit: z.enum(['dollars', 'thousands', 'millions']).nullish(),
  })
  .strict();

export const committeeToplineV1Schema = z
  .object({
    scope: z.string().optional(),
    amountMillions: z.number().optional(),
    units: z.string().optional(),
    stage: z.string().optional(),
    vehicleClass: z.string().optional(),
    sourcePage: z.number().nullable().optional(),
    excerpt: z.string().nullable().optional(),
    note: z.string().nullable().optional(),
    effectiveDate: z.string().nullable().optional(),
    vehicleLabel: z.string().nullable().optional(),
    billId: z.string().nullable().optional(),
  })
  .strict();

export const committeeArtifactV1InputSchema = z
  .object({
    chamber: z.string().optional(),
    fy: z.number().optional(),
    source: z.string().optional(),
    rows: z.array(committeeRowV1Schema),
    toplines: z.array(committeeToplineV1Schema).optional(),
  })
  .strict();

export type CommitteeArtifactV1Input = z.infer<typeof committeeArtifactV1InputSchema>;

export interface CommitteeAdapterOptions {
  /** Exact committee mode; owns the target funding field for `mark`. */
  mode: CommitteeAdapterMode;
  /**
   * Declared printed unit for request/mark values when the rows do not carry
   * explicit units. Records the unit source in assertion metadata. When
   * omitted and a row carries no unit, the money fact becomes a blocking
   * `unsupported_unit` omission — the unit is never guessed from magnitude.
   */
  legacyDeclaredUnit?: 'dollars' | 'thousands' | 'millions';
  /** Fallback fiscal year for rows that do not carry `fy`. */
  defaultFiscalYear: number;
}

/* ------------------------------------------------------------------ */
/* adapter                                                             */
/* ------------------------------------------------------------------ */

export function adaptCommitteeArtifactToArtifactV1(
  input: CommitteeArtifactV1Input,
  context: ExtractionAdapterContextV1,
  options: CommitteeAdapterOptions,
): DefenseBudgetExtractionArtifactV1 {
  const artifact = committeeArtifactV1InputSchema.parse(input);
  const builder = new ArtifactBuilderV1(sourceFromContext(context));
  const parserRun = parserRunFromContext(context);
  builder.addParserRun(parserRun);

  const docEvidence = buildTruthfulEvidence(context, {
    parserRunId: parserRun.parserRunId,
    discriminator: 'document',
  });
  builder.addEvidence(docEvidence);

  const markField = COMMITTEE_MODE_FUNDING_FIELD[options.mode];
  let missingPageWarned = false;

  artifact.rows.forEach((row, rowIndex) => {
    const rowPath = `rows[${rowIndex}]`;
    const page = row.page ?? undefined;
    const rowEvidence = buildTruthfulEvidence(context, {
      parserRunId: parserRun.parserRunId,
      ...(page != null ? { page } : {}),
      ...(row.printedPage != null ? { printedPage: row.printedPage } : {}),
      ...(row.rowLabel != null ? { rowLabel: row.rowLabel } : {}),
      discriminator: rowPath,
    });
    builder.addEvidence(rowEvidence);

    if (page == null && !missingPageWarned) {
      missingPageWarned = true;
      builder.addWarning(
        buildWarning({
          code: 'legacy_committee_artifact_missing_page',
          severity: 'review',
          message:
            'one or more legacy committee rows carry no page provenance; document_only evidence is used and page completeness cannot be proven',
          evidenceIds: [docEvidence.evidenceId],
        }),
      );
    }

    /* ---------------- identity fact ---------------- */
    const peCodeRaw = (row.peCode ?? '').toString().trim().toUpperCase();
    const identityFact = buildSourceFact({
      sourcePath: `${rowPath}.identity`,
      category: 'identity',
      requiredForCompleteness: true,
      rawValue: { peCode: row.peCode ?? null, rowLabel: row.rowLabel ?? null },
      evidenceIds: [rowEvidence.evidenceId],
    });
    builder.addSourceFact(identityFact);

    const peValid = peCodeRaw.length > 0 && isValidPeCode(peCodeRaw);
    if (!peValid) {
      builder.addOmission(
        buildOmission({
          sourceFactId: identityFact.factId,
          reason: 'invalid_identity',
          severity: 'blocking',
          message: `committee row has no valid RDT&E PE code: ${row.peCode ?? '(absent)'}`,
        }),
      );
    } else {
      builder.addAssertion({
        assertionId: assertionIdV1({ sourcePath: `${rowPath}.identity` }),
        assertionKind: 'program_element_identity',
        identity: { lineKind: 'RDTE_PE', peCode: peCodeRaw },
        title: row.rowLabel != null && row.rowLabel.trim().length > 0 ? row.rowLabel : peCodeRaw,
        component: context.component,
        sourceFactIds: [identityFact.factId],
        evidenceIds: [rowEvidence.evidenceId],
        confidence: 1,
        metadata: { committeeMode: options.mode },
      });
    }

    /* ---------------- fiscal year ---------------- */
    const fyResult = resolveRowFiscalYear(row.fy, options.defaultFiscalYear);

    // Phase A.4: Invalid FY must create an omission, not substitute.
    if (fyResult.kind === 'invalid') {
      const invalidFyFact = buildSourceFact({
        sourcePath: `${rowPath}.fy`,
        category: 'metadata',
        requiredForCompleteness: true,
        rawValue: { fy: fyResult.raw, reason: 'invalid_fiscal_year' },
        evidenceIds: [rowEvidence.evidenceId],
      });
      builder.addSourceFact(invalidFyFact);
      builder.addOmission(
        buildOmission({
          sourceFactId: invalidFyFact.factId,
          reason: 'invalid_number',
          severity: 'blocking',
          message: `row fiscal year "${fyResult.raw}" is not a valid year (1900-2200)`,
        }),
      );

      // Phase A.4: Invalid FY must NOT silently drop other represented values
      // on the same row. Create a source fact + blocking omission for every
      // represented value (request, mark, explanation). Do not create
      // funding or narrative assertions — the row FY is unresolvable.
      const invalidFyMessage = 'value cannot be asserted because the row fiscal year is invalid';

      if (row.request != null) {
        const requestPath = `${rowPath}.request`;
        const requestFact = buildSourceFact({
          sourcePath: requestPath,
          category: 'money',
          requiredForCompleteness: true,
          rawValue: {
            value: row.request,
            unit: row.requestUnit ?? options.legacyDeclaredUnit ?? null,
          },
          evidenceIds: [rowEvidence.evidenceId],
        });
        builder.addSourceFact(requestFact);
        builder.addOmission(
          buildOmission({
            sourceFactId: requestFact.factId,
            reason: 'other',
            severity: 'blocking',
            message: invalidFyMessage,
          }),
        );
      }

      if (row.mark != null) {
        const markPath = `${rowPath}.mark`;
        const markFact = buildSourceFact({
          sourcePath: markPath,
          category: 'money',
          requiredForCompleteness: true,
          rawValue: { value: row.mark, unit: row.markUnit ?? options.legacyDeclaredUnit ?? null },
          evidenceIds: [rowEvidence.evidenceId],
        });
        builder.addSourceFact(markFact);
        builder.addOmission(
          buildOmission({
            sourceFactId: markFact.factId,
            reason: 'other',
            severity: 'blocking',
            message: invalidFyMessage,
          }),
        );
      }

      if (row.explanation != null && row.explanation.trim().length > 0) {
        const explanationPath = `${rowPath}.explanation`;
        const explanationFact = buildSourceFact({
          sourcePath: explanationPath,
          category: 'text',
          requiredForCompleteness: true,
          rawValue: row.explanation,
          evidenceIds: [rowEvidence.evidenceId],
        });
        builder.addSourceFact(explanationFact);
        builder.addOmission(
          buildOmission({
            sourceFactId: explanationFact.factId,
            reason: 'other',
            severity: 'blocking',
            message: invalidFyMessage,
          }),
        );
      }

      // Do not create funding/narrative assertions for this row.
      return;
    }

    // Phase A.4: Missing FY uses manifest FY with a review warning.
    if (fyResult.kind === 'missing') {
      builder.addWarning(
        buildWarning({
          code: 'missing_fiscal_year_defaulted',
          severity: 'review',
          message: `row at ${rowPath} has no fiscal year; using manifest fiscal year ${fyResult.fy}`,
          discriminator: `${rowPath}.fy`,
        }),
      );
    }

    const rowFy = fyResult.fy;

    /* ---------------- request money fact ---------------- */
    if (row.request != null) {
      const requestPath = `${rowPath}.request`;
      const requestFact = buildSourceFact({
        sourcePath: requestPath,
        category: 'money',
        requiredForCompleteness: true,
        rawValue: {
          value: row.request,
          unit: row.requestUnit ?? options.legacyDeclaredUnit ?? null,
        },
        evidenceIds: [rowEvidence.evidenceId],
      });
      builder.addSourceFact(requestFact);
      emitMoneyAssertionOrOmission(builder, {
        fact: { factId: requestFact.factId, sourcePath: requestPath },
        rawValue: row.request,
        rowUnit: row.requestUnit ?? undefined,
        legacyDeclaredUnit: options.legacyDeclaredUnit,
        unitMetadataKey: 'requestUnitSource',
        peValid,
        peCode: peCodeRaw,
        fiscalYear: rowFy,
        field: 'request',
        evidenceId: rowEvidence.evidenceId,
      });
    }

    /* ---------------- mark money fact ---------------- */
    if (row.mark != null) {
      const markPath = `${rowPath}.mark`;
      const markFact = buildSourceFact({
        sourcePath: markPath,
        category: 'money',
        requiredForCompleteness: true,
        rawValue: { value: row.mark, unit: row.markUnit ?? options.legacyDeclaredUnit ?? null },
        evidenceIds: [rowEvidence.evidenceId],
      });
      builder.addSourceFact(markFact);
      emitMoneyAssertionOrOmission(builder, {
        fact: { factId: markFact.factId, sourcePath: markPath },
        rawValue: row.mark,
        rowUnit: row.markUnit ?? undefined,
        legacyDeclaredUnit: options.legacyDeclaredUnit,
        unitMetadataKey: 'markUnitSource',
        peValid,
        peCode: peCodeRaw,
        fiscalYear: rowFy,
        field: markField,
        evidenceId: rowEvidence.evidenceId,
      });
    }

    /* ---------------- explanation text fact ---------------- */
    if (row.explanation != null && row.explanation.trim().length > 0) {
      const explanationPath = `${rowPath}.explanation`;
      const explanationFact = buildSourceFact({
        sourcePath: explanationPath,
        category: 'text',
        requiredForCompleteness: true,
        rawValue: row.explanation,
        evidenceIds: [rowEvidence.evidenceId],
      });
      builder.addSourceFact(explanationFact);
      if (peValid) {
        builder.addAssertion({
          assertionId: assertionIdV1({ sourcePath: explanationPath, kind: 'narrative' }),
          assertionKind: 'narrative',
          identity: { lineKind: 'RDTE_PE', peCode: peCodeRaw },
          narrativeType: 'rationale',
          text: row.explanation,
          sourceFactIds: [explanationFact.factId],
          evidenceIds: [rowEvidence.evidenceId],
          confidence: 1,
          metadata: { committeeMode: options.mode },
        });
      } else {
        builder.addOmission(
          buildOmission({
            sourceFactId: explanationFact.factId,
            reason: 'invalid_identity',
            severity: 'review',
            message: `explanation text sits under a row with no valid PE code: ${row.peCode ?? '(absent)'}`,
          }),
        );
      }
    }
  });

  /* ---------------- toplines: document facts only ---------------- */
  (artifact.toplines ?? []).forEach((topline, index) => {
    const toplinePath = `toplines[${index}]`;
    const toplineEvidence = buildTruthfulEvidence(context, {
      parserRunId: parserRun.parserRunId,
      ...(topline.sourcePage != null ? { page: topline.sourcePage } : {}),
      ...(topline.excerpt != null ? { excerpt: topline.excerpt } : {}),
      discriminator: toplinePath,
    });
    builder.addEvidence(toplineEvidence);
    const toplineFact = buildSourceFact({
      sourcePath: toplinePath,
      category: 'metadata',
      requiredForCompleteness: true,
      rawValue: topline,
      evidenceIds: [toplineEvidence.evidenceId],
    });
    builder.addSourceFact(toplineFact);
    builder.addAssertion({
      assertionId: assertionIdV1({ sourcePath: toplinePath, kind: 'document_fact' }),
      assertionKind: 'document_fact',
      fieldName: 'committee_topline',
      value: topline,
      sourceFactIds: [toplineFact.factId],
      evidenceIds: [toplineEvidence.evidenceId],
      confidence: 1,
      metadata: { committeeMode: options.mode },
    });
  });

  return builder.finalize();
}

/* ------------------------------------------------------------------ */
/* internals                                                           */
/* ------------------------------------------------------------------ */

type FiscalYearResult =
  | { kind: 'valid'; fy: number }
  | { kind: 'missing'; fy: number }
  | { kind: 'invalid'; raw: string | number };

/**
 * Phase A.4: Resolve row fiscal year.
 * - Missing FY may use the manifest FY with a review warning.
 * - A supplied but invalid FY must create an omission.
 * - Do not create assertions using a substituted year.
 */
function resolveRowFiscalYear(
  rowFy: number | string | null | undefined,
  defaultFiscalYear: number,
): FiscalYearResult {
  if (rowFy == null || rowFy === '') return { kind: 'missing', fy: defaultFiscalYear };
  const parsed = typeof rowFy === 'number' ? rowFy : Number(rowFy);
  if (!Number.isInteger(parsed) || parsed < 1900 || parsed > 2200) {
    return { kind: 'invalid', raw: rowFy };
  }
  return { kind: 'valid', fy: parsed };
}

function emitMoneyAssertionOrOmission(
  builder: ArtifactBuilderV1,
  args: {
    fact: { factId: string; sourcePath: string };
    rawValue: string | number;
    rowUnit?: 'dollars' | 'thousands' | 'millions' | undefined;
    legacyDeclaredUnit?: 'dollars' | 'thousands' | 'millions' | undefined;
    unitMetadataKey: 'requestUnitSource' | 'markUnitSource';
    peValid: boolean;
    peCode: string;
    fiscalYear: number;
    field: FundingFieldV1;
    evidenceId: string;
  },
): void {
  const unit = args.rowUnit ?? args.legacyDeclaredUnit;
  const unitSource =
    args.rowUnit != null ? 'row' : args.legacyDeclaredUnit != null ? 'adapter_context' : null;

  if (unit == null) {
    builder.addOmission(
      buildOmission({
        sourceFactId: args.fact.factId,
        reason: 'unsupported_unit',
        severity: 'blocking',
        message:
          'money value carries no row-level unit and no declared legacy convention unit; unit is never inferred from magnitude',
      }),
    );
    return;
  }
  if (!args.peValid) {
    builder.addOmission(
      buildOmission({
        sourceFactId: args.fact.factId,
        reason: 'invalid_identity',
        severity: 'blocking',
        message: 'money value sits under a row with no valid PE code',
      }),
    );
    return;
  }

  let money: MoneyValueV1;
  try {
    const originalValue = parseCanonicalDecimalString(args.rawValue);
    money = {
      originalValue,
      originalUnit: unit,
      valueMillions: moneyToMillionsString(originalValue, unit),
    };
  } catch (cause) {
    builder.addOmission(
      buildOmission({
        sourceFactId: args.fact.factId,
        reason: 'invalid_number',
        severity: 'blocking',
        message: `money value ${String(args.rawValue)} is not a finite decimal: ${(cause as Error).message}`,
      }),
    );
    return;
  }

  builder.addAssertion({
    assertionId: assertionIdV1({ sourcePath: args.fact.sourcePath, kind: 'funding' }),
    assertionKind: 'funding',
    identity: { lineKind: 'RDTE_PE', peCode: args.peCode },
    fiscalYear: args.fiscalYear,
    field: args.field,
    money,
    sourceFactIds: [args.fact.factId],
    evidenceIds: [args.evidenceId],
    confidence: 1,
    metadata: { [args.unitMetadataKey]: unitSource },
  });
}
