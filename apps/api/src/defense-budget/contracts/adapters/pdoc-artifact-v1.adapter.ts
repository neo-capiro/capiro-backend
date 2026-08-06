/**
 * Workstream J — adapter for the legacy P-doc procurement artifact consumed by
 * parse-pdoc-army.ts and shaped by `parseProcurementPes`.
 *
 * Truthfulness rules:
 *   - Procurement identity stays PROCUREMENT_BLIN with account + component
 *     context; it is NEVER collapsed into RDTE_PE even though the canonical
 *     writer stores procurement parents in program_element.
 *   - Parent fyData request amounts carry the explicit `thousands` unit (P-1
 *     convention). Child line-item dollars need an explicit unit (row-level or
 *     declared legacy convention); otherwise they become blocking omissions.
 *   - Legacy aliases are accepted only when exactly one alias is populated;
 *     conflicting aliases fail closed and the chosen source path names the
 *     field that actually supplied the value.
 *   - Quantities are quantity assertions, never money. Unit costs stay dollars.
 *   - Empty child descriptions become omissions rather than disappearing.
 */
import { z } from 'zod';
import { ArtifactBuilderV1, assertionIdV1 } from '../artifact-builders.js';
import type {
  BudgetComponentV1,
  DefenseBudgetExtractionArtifactV1,
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
/* adapter-local strict input schema                                   */
/* ------------------------------------------------------------------ */

const numericInputSchema = z.union([z.string(), z.number()]);

export const pdocFyDataRowV1Schema = z
  .object({
    fy: z.union([z.number(), z.string()]).nullish(),
    quantity: numericInputSchema.nullish(),
    requestDollarsThousands: numericInputSchema.nullish(),
    request_dollars_thousands: numericInputSchema.nullish(),
    dollars: numericInputSchema.nullish(),
    unitCostDollars: numericInputSchema.nullish(),
    unit_cost_dollars: numericInputSchema.nullish(),
    unitCost: numericInputSchema.nullish(),
    page: z.number().int().positive().nullish(),
  })
  .strict();

export const pdocLineItemV1Schema = z
  .object({
    description: z.string().nullish(),
    fy: z.union([z.number(), z.string()]).nullish(),
    quantity: numericInputSchema.nullish(),
    dollars: numericInputSchema.nullish(),
    dollarsUnit: z.enum(['dollars', 'thousands', 'millions']).nullish(),
    unitCost: numericInputSchema.nullish(),
    unit_cost: numericInputSchema.nullish(),
    page: z.number().int().positive().nullish(),
  })
  .strict();

export const pdocPeV1Schema = z
  .object({
    peCode: z.string().nullish(),
    title: z.string().nullish(),
    budgetActivity: z.string().nullish(),
    lineNumber: z.string().nullish(),
    programOfRecord: z.string().nullish(),
    page: z.number().int().positive().nullish(),
    fyData: z.array(pdocFyDataRowV1Schema).nullish(),
    lineItems: z.array(pdocLineItemV1Schema).nullish(),
  })
  .strict();

export const pdocArtifactV1InputSchema = z
  .object({
    service: z.string().optional(),
    fy: z.number().optional(),
    sourceUrl: z.string().optional(),
    pes: z.array(pdocPeV1Schema),
  })
  .strict();

export type PdocArtifactV1Input = z.infer<typeof pdocArtifactV1InputSchema>;

export interface PdocAdapterOptions {
  /**
   * Appropriation account context for the PROCUREMENT_BLIN identity (e.g.
   * 'missile_procurement_army'). Required — procurement identity without
   * account context is rejected by the contract.
   */
  account: string;
  /**
   * True when this artifact carries advance-procurement lines rather than base
   * procurement lines. Part of the identity natural key; base and advance
   * procurement for the same code never share identity.
   */
  advanceProcurement?: boolean;
  /**
   * Declared printed unit for child line-item `dollars` when rows do not carry
   * `dollarsUnit`. When omitted and a row carries no unit, the child money
   * fact becomes a blocking `unsupported_unit` omission.
   */
  legacyLineItemDollarsUnit?: 'dollars' | 'thousands' | 'millions';
  /** Fallback fiscal year for rows that do not carry `fy`. */
  defaultFiscalYear: number;
}

export class PdocAliasConflictError extends Error {
  readonly code = 'pdoc_numeric_alias_conflict';

  constructor(sourcePath: string, aliases: readonly string[]) {
    super(`${sourcePath} contains multiple populated legacy aliases: ${aliases.join(', ')}`);
    this.name = 'PdocAliasConflictError';
  }
}

type NumericAliasSelection<K extends string> = {
  key: K;
  value: string | number;
};

function selectSingleNumericAlias<K extends string>(
  record: Partial<Record<K, string | number | null | undefined>>,
  keys: readonly K[],
  sourcePath: string,
): NumericAliasSelection<K> | null {
  const populated = keys.flatMap((key) => {
    const value = record[key];
    return value == null ? [] : [{ key, value }];
  });
  if (populated.length > 1) {
    throw new PdocAliasConflictError(
      sourcePath,
      populated.map((entry) => entry.key),
    );
  }
  return populated[0] ?? null;
}

/* ------------------------------------------------------------------ */
/* adapter                                                             */
/* ------------------------------------------------------------------ */

export function adaptPdocArtifactToArtifactV1(
  input: PdocArtifactV1Input,
  context: ExtractionAdapterContextV1,
  options: PdocAdapterOptions,
): DefenseBudgetExtractionArtifactV1 {
  const artifact = pdocArtifactV1InputSchema.parse(input);
  const builder = new ArtifactBuilderV1(sourceFromContext(context));
  const parserRun = parserRunFromContext(context);
  builder.addParserRun(parserRun);

  const docEvidence = buildTruthfulEvidence(context, {
    parserRunId: parserRun.parserRunId,
    discriminator: 'document',
  });
  builder.addEvidence(docEvidence);

  const component: BudgetComponentV1 = context.component;

  artifact.pes.forEach((pe, peIndex) => {
    const pePath = `pes[${peIndex}]`;
    const peCode = (pe.peCode ?? '').toString().trim();
    const peEvidence = buildTruthfulEvidence(context, {
      parserRunId: parserRun.parserRunId,
      ...(pe.page != null ? { page: pe.page } : {}),
      rowLabel: pe.title ?? undefined,
      discriminator: pePath,
    });
    builder.addEvidence(peEvidence);

    /* ---------------- parent identity fact ---------------- */
    const identityFact = buildSourceFact({
      sourcePath: `${pePath}.identity`,
      category: 'identity',
      requiredForCompleteness: true,
      rawValue: {
        peCode: pe.peCode ?? null,
        title: pe.title ?? null,
        budgetActivity: pe.budgetActivity ?? null,
        lineNumber: pe.lineNumber ?? null,
        programOfRecord: pe.programOfRecord ?? null,
      },
      evidenceIds: [peEvidence.evidenceId],
    });
    builder.addSourceFact(identityFact);

    const identityValid = peCode.length > 0;
    const parentIdentity = identityValid
      ? {
          lineKind: 'PROCUREMENT_BLIN' as const,
          code: peCode,
          account: options.account,
          component,
          ...(options.advanceProcurement != null
            ? { advanceProcurement: options.advanceProcurement }
            : {}),
        }
      : null;

    if (parentIdentity == null) {
      builder.addOmission(
        buildOmission({
          sourceFactId: identityFact.factId,
          reason: 'invalid_identity',
          severity: 'blocking',
          message: `P-doc parent row has no procurement line code: ${pe.peCode ?? '(absent)'}`,
        }),
      );
    } else {
      builder.addAssertion({
        assertionId: assertionIdV1({ sourcePath: `${pePath}.identity`, kind: 'procurement_line' }),
        assertionKind: 'procurement_line',
        parentIdentity,
        description: pe.title ?? '',
        fiscalYear: options.defaultFiscalYear,
        sourceFactIds: [identityFact.factId],
        evidenceIds: [peEvidence.evidenceId],
        confidence: 1,
        metadata: {
          parentLevel: true,
          ...(pe.budgetActivity != null ? { budgetActivity: pe.budgetActivity } : {}),
          ...(pe.lineNumber != null ? { lineNumber: pe.lineNumber } : {}),
          ...(pe.programOfRecord != null ? { programOfRecord: pe.programOfRecord } : {}),
        },
      });
    }

    /* ---------------- parent fyData rows ---------------- */
    (pe.fyData ?? []).forEach((row, fyIndex) => {
      const fyPath = `${pePath}.fyData[${fyIndex}]`;
      const requestAlias = selectSingleNumericAlias(
        row,
        ['requestDollarsThousands', 'request_dollars_thousands', 'dollars'] as const,
        `${fyPath}.request`,
      );
      const unitCostAlias = selectSingleNumericAlias(
        row,
        ['unitCostDollars', 'unit_cost_dollars', 'unitCost'] as const,
        `${fyPath}.unitCost`,
      );
      const rawRequest = requestAlias?.value ?? null;
      const requestPath =
        requestAlias == null
          ? `${fyPath}.requestDollarsThousands`
          : `${fyPath}.${requestAlias.key}`;
      const rawUnitCost = unitCostAlias?.value ?? null;
      const unitCostPath =
        unitCostAlias == null ? `${fyPath}.unitCostDollars` : `${fyPath}.${unitCostAlias.key}`;
      const fyResult = resolvePdocFiscalYear(row.fy, options.defaultFiscalYear);

      if (fyResult.kind === 'invalid') {
        const invalidFyEvidence = buildTruthfulEvidence(context, {
          parserRunId: parserRun.parserRunId,
          ...(row.page != null ? { page: row.page } : pe.page != null ? { page: pe.page } : {}),
          discriminator: `${fyPath}.fy`,
        });
        builder.addEvidence(invalidFyEvidence);
        const invalidFyFact = buildSourceFact({
          sourcePath: `${fyPath}.fy`,
          category: 'metadata',
          requiredForCompleteness: true,
          rawValue: { fy: fyResult.raw, reason: 'invalid_fiscal_year' },
          evidenceIds: [invalidFyEvidence.evidenceId],
        });
        builder.addSourceFact(invalidFyFact);
        builder.addOmission(
          buildOmission({
            sourceFactId: invalidFyFact.factId,
            reason: 'invalid_number',
            severity: 'blocking',
            message: `fyData row fiscal year "${fyResult.raw}" is not a valid year (1900-2200)`,
          }),
        );

        const invalidFyMessage = 'value cannot be asserted because the row fiscal year is invalid';

        if (rawRequest != null) {
          const moneyFact = buildSourceFact({
            sourcePath: requestPath,
            category: 'money',
            requiredForCompleteness: true,
            rawValue: {
              value: rawRequest,
              unit: 'thousands',
              sourceField: requestAlias!.key,
            },
            evidenceIds: [invalidFyEvidence.evidenceId],
          });
          builder.addSourceFact(moneyFact);
          builder.addOmission(
            buildOmission({
              sourceFactId: moneyFact.factId,
              reason: 'other',
              severity: 'blocking',
              message: invalidFyMessage,
            }),
          );
        }

        if (row.quantity != null) {
          const quantityPath = `${fyPath}.quantity`;
          const quantityFact = buildSourceFact({
            sourcePath: quantityPath,
            category: 'quantity',
            requiredForCompleteness: true,
            rawValue: row.quantity,
            evidenceIds: [invalidFyEvidence.evidenceId],
          });
          builder.addSourceFact(quantityFact);
          builder.addOmission(
            buildOmission({
              sourceFactId: quantityFact.factId,
              reason: 'other',
              severity: 'blocking',
              message: invalidFyMessage,
            }),
          );
        }

        if (rawUnitCost != null) {
          const unitCostFact = buildSourceFact({
            sourcePath: unitCostPath,
            category: 'money',
            requiredForCompleteness: true,
            rawValue: {
              value: rawUnitCost,
              unit: 'dollars',
              sourceField: unitCostAlias!.key,
            },
            evidenceIds: [invalidFyEvidence.evidenceId],
          });
          builder.addSourceFact(unitCostFact);
          builder.addOmission(
            buildOmission({
              sourceFactId: unitCostFact.factId,
              reason: 'other',
              severity: 'blocking',
              message: invalidFyMessage,
            }),
          );
        }

        return;
      }

      const rowFy = fyResult.fy;
      const rowEvidence = buildTruthfulEvidence(context, {
        parserRunId: parserRun.parserRunId,
        ...(row.page != null ? { page: row.page } : pe.page != null ? { page: pe.page } : {}),
        discriminator: fyPath,
      });
      builder.addEvidence(rowEvidence);

      if (fyResult.kind === 'missing') {
        builder.addWarning(
          buildWarning({
            code: 'legacy_pdoc_fydata_missing_fy',
            severity: 'review',
            message: `fyData row under ${peCode || '(no code)'} carries no valid fy; defaultFiscalYear ${options.defaultFiscalYear} applied`,
            evidenceIds: [rowEvidence.evidenceId],
            discriminator: fyPath,
          }),
        );
      }

      if (rawRequest != null) {
        const moneyFact = buildSourceFact({
          sourcePath: requestPath,
          category: 'money',
          requiredForCompleteness: true,
          rawValue: {
            value: rawRequest,
            unit: 'thousands',
            sourceField: requestAlias!.key,
          },
          evidenceIds: [rowEvidence.evidenceId],
        });
        builder.addSourceFact(moneyFact);
        if (parentIdentity == null) {
          builder.addOmission(
            buildOmission({
              sourceFactId: moneyFact.factId,
              reason: 'invalid_identity',
              severity: 'blocking',
              message: 'fyData request value sits under a parent with no procurement code',
            }),
          );
        } else {
          const money = tryBuildMoney(rawRequest, 'thousands');
          if (money == null) {
            builder.addOmission(
              buildOmission({
                sourceFactId: moneyFact.factId,
                reason: 'invalid_number',
                severity: 'blocking',
                message: `fyData request value ${String(rawRequest)} is not a finite decimal`,
              }),
            );
          } else {
            builder.addAssertion({
              assertionId: assertionIdV1({ sourcePath: requestPath, kind: 'funding' }),
              assertionKind: 'funding',
              identity: parentIdentity,
              fiscalYear: rowFy,
              field: 'request',
              money,
              sourceFactIds: [moneyFact.factId],
              evidenceIds: [rowEvidence.evidenceId],
              confidence: 1,
              metadata: {
                declaredUnit: 'thousands',
                declaredUnitSource: 'p1_convention',
                sourceField: requestAlias!.key,
              },
            });
          }
        }
      }

      if (row.quantity != null) {
        const quantityPath = `${fyPath}.quantity`;
        const quantityFact = buildSourceFact({
          sourcePath: quantityPath,
          category: 'quantity',
          requiredForCompleteness: true,
          rawValue: row.quantity,
          evidenceIds: [rowEvidence.evidenceId],
        });
        builder.addSourceFact(quantityFact);
        const quantity = tryParseDecimal(row.quantity);
        if (parentIdentity == null) {
          builder.addOmission(
            buildOmission({
              sourceFactId: quantityFact.factId,
              reason: 'invalid_identity',
              severity: 'blocking',
              message: 'fyData quantity sits under a parent with no procurement code',
            }),
          );
        } else if (quantity == null) {
          builder.addOmission(
            buildOmission({
              sourceFactId: quantityFact.factId,
              reason: 'invalid_number',
              severity: 'blocking',
              message: `fyData quantity ${String(row.quantity)} is not a finite decimal`,
            }),
          );
        } else {
          builder.addAssertion({
            assertionId: assertionIdV1({ sourcePath: quantityPath, kind: 'quantity' }),
            assertionKind: 'quantity',
            identity: parentIdentity,
            fiscalYear: rowFy,
            quantity,
            sourceFactIds: [quantityFact.factId],
            evidenceIds: [rowEvidence.evidenceId],
            confidence: 1,
          });
        }
      }

      if (rawUnitCost != null) {
        const unitCostFact = buildSourceFact({
          sourcePath: unitCostPath,
          category: 'money',
          requiredForCompleteness: true,
          rawValue: {
            value: rawUnitCost,
            unit: 'dollars',
            sourceField: unitCostAlias!.key,
          },
          evidenceIds: [rowEvidence.evidenceId],
        });
        builder.addSourceFact(unitCostFact);
        const unitCost = tryParseDecimal(rawUnitCost);
        if (parentIdentity == null) {
          builder.addOmission(
            buildOmission({
              sourceFactId: unitCostFact.factId,
              reason: 'invalid_identity',
              severity: 'blocking',
              message: 'fyData unit cost sits under a parent with no procurement code',
            }),
          );
        } else if (unitCost == null) {
          builder.addOmission(
            buildOmission({
              sourceFactId: unitCostFact.factId,
              reason: 'invalid_number',
              severity: 'blocking',
              message: `fyData unit cost ${String(rawUnitCost)} is not a finite decimal`,
            }),
          );
        } else {
          builder.addAssertion({
            assertionId: assertionIdV1({ sourcePath: unitCostPath, kind: 'unit_cost' }),
            assertionKind: 'unit_cost',
            identity: parentIdentity,
            fiscalYear: rowFy,
            unitCostDollars: unitCost,
            sourceFactIds: [unitCostFact.factId],
            evidenceIds: [rowEvidence.evidenceId],
            confidence: 1,
            metadata: {
              declaredUnit: 'dollars',
              declaredUnitSource: 'p1_convention',
              sourceField: unitCostAlias!.key,
            },
          });
        }
      }
    });

    /* ---------------- child line items ---------------- */
    (pe.lineItems ?? []).forEach((lineItem, lineIndex) => {
      const linePath = `${pePath}.lineItems[${lineIndex}]`;
      const lineUnitCostAlias = selectSingleNumericAlias(
        lineItem,
        ['unitCost', 'unit_cost'] as const,
        `${linePath}.unitCost`,
      );
      const rawLineUnitCost = lineUnitCostAlias?.value ?? null;
      const lineUnitCostPath =
        lineUnitCostAlias == null
          ? `${linePath}.unitCost`
          : `${linePath}.${lineUnitCostAlias.key}`;
      const lineFyResult = resolvePdocFiscalYear(lineItem.fy, options.defaultFiscalYear);

      if (lineFyResult.kind === 'invalid') {
        const invalidFyEvidence = buildTruthfulEvidence(context, {
          parserRunId: parserRun.parserRunId,
          ...(lineItem.page != null
            ? { page: lineItem.page }
            : pe.page != null
              ? { page: pe.page }
              : {}),
          discriminator: `${linePath}.fy`,
        });
        builder.addEvidence(invalidFyEvidence);
        const invalidFyFact = buildSourceFact({
          sourcePath: `${linePath}.fy`,
          category: 'metadata',
          requiredForCompleteness: true,
          rawValue: { fy: lineFyResult.raw, reason: 'invalid_fiscal_year' },
          evidenceIds: [invalidFyEvidence.evidenceId],
        });
        builder.addSourceFact(invalidFyFact);
        builder.addOmission(
          buildOmission({
            sourceFactId: invalidFyFact.factId,
            reason: 'invalid_number',
            severity: 'blocking',
            message: `line item fiscal year "${lineFyResult.raw}" is not a valid year (1900-2200)`,
          }),
        );

        const invalidFyMessage = 'value cannot be asserted because the row fiscal year is invalid';

        const descriptionFact = buildSourceFact({
          sourcePath: `${linePath}.description`,
          category: 'text',
          requiredForCompleteness: true,
          rawValue: lineItem.description ?? null,
          evidenceIds: [invalidFyEvidence.evidenceId],
        });
        builder.addSourceFact(descriptionFact);
        builder.addOmission(
          buildOmission({
            sourceFactId: descriptionFact.factId,
            reason: 'other',
            severity: 'blocking',
            message: invalidFyMessage,
          }),
        );

        if (lineItem.dollars != null) {
          const dollarsUnit = lineItem.dollarsUnit ?? options.legacyLineItemDollarsUnit ?? null;
          const dollarsFact = buildSourceFact({
            sourcePath: `${linePath}.dollars`,
            category: 'money',
            requiredForCompleteness: true,
            rawValue: { value: lineItem.dollars, unit: dollarsUnit },
            evidenceIds: [invalidFyEvidence.evidenceId],
          });
          builder.addSourceFact(dollarsFact);
          builder.addOmission(
            buildOmission({
              sourceFactId: dollarsFact.factId,
              reason: 'other',
              severity: 'blocking',
              message: invalidFyMessage,
            }),
          );
        }

        if (lineItem.quantity != null) {
          const quantityFact = buildSourceFact({
            sourcePath: `${linePath}.quantity`,
            category: 'quantity',
            requiredForCompleteness: true,
            rawValue: lineItem.quantity,
            evidenceIds: [invalidFyEvidence.evidenceId],
          });
          builder.addSourceFact(quantityFact);
          builder.addOmission(
            buildOmission({
              sourceFactId: quantityFact.factId,
              reason: 'other',
              severity: 'blocking',
              message: invalidFyMessage,
            }),
          );
        }

        if (rawLineUnitCost != null) {
          const unitCostFact = buildSourceFact({
            sourcePath: lineUnitCostPath,
            category: 'money',
            requiredForCompleteness: true,
            rawValue: {
              value: rawLineUnitCost,
              unit: 'dollars',
              sourceField: lineUnitCostAlias!.key,
            },
            evidenceIds: [invalidFyEvidence.evidenceId],
          });
          builder.addSourceFact(unitCostFact);
          builder.addOmission(
            buildOmission({
              sourceFactId: unitCostFact.factId,
              reason: 'other',
              severity: 'blocking',
              message: invalidFyMessage,
            }),
          );
        }

        return;
      }

      const lineFy = lineFyResult.fy;
      const lineEvidence = buildTruthfulEvidence(context, {
        parserRunId: parserRun.parserRunId,
        ...(lineItem.page != null
          ? { page: lineItem.page }
          : pe.page != null
            ? { page: pe.page }
            : {}),
        discriminator: linePath,
      });
      builder.addEvidence(lineEvidence);

      const description = (lineItem.description ?? '').toString().trim();
      const descriptionFact = buildSourceFact({
        sourcePath: `${linePath}.description`,
        category: 'text',
        requiredForCompleteness: true,
        rawValue: lineItem.description ?? null,
        evidenceIds: [lineEvidence.evidenceId],
      });
      builder.addSourceFact(descriptionFact);

      if (description.length === 0) {
        builder.addOmission(
          buildOmission({
            sourceFactId: descriptionFact.factId,
            reason: 'missing_value',
            severity: 'blocking',
            message: `line item under ${peCode || '(no code)'} carries an empty description`,
          }),
        );
      }

      const dollarsUnit = lineItem.dollarsUnit ?? options.legacyLineItemDollarsUnit ?? null;
      let dollarsMoney: MoneyValueV1 | null = null;
      let dollarsBlocked = false;
      const dollarsFact =
        lineItem.dollars != null
          ? buildSourceFact({
              sourcePath: `${linePath}.dollars`,
              category: 'money',
              requiredForCompleteness: true,
              rawValue: { value: lineItem.dollars, unit: dollarsUnit },
              evidenceIds: [lineEvidence.evidenceId],
            })
          : null;
      if (dollarsFact != null) {
        builder.addSourceFact(dollarsFact);
        if (dollarsUnit == null) {
          dollarsBlocked = true;
          builder.addOmission(
            buildOmission({
              sourceFactId: dollarsFact.factId,
              reason: 'unsupported_unit',
              severity: 'blocking',
              message:
                'line-item dollars carry no row-level dollarsUnit and no declared legacy convention unit; unit is never inferred from magnitude',
            }),
          );
        } else {
          dollarsMoney = tryBuildMoney(lineItem.dollars!, dollarsUnit);
          if (dollarsMoney == null) {
            dollarsBlocked = true;
            builder.addOmission(
              buildOmission({
                sourceFactId: dollarsFact.factId,
                reason: 'invalid_number',
                severity: 'blocking',
                message: `line-item dollars ${String(lineItem.dollars)} is not a finite decimal`,
              }),
            );
          }
        }
      }

      let quantity: string | null = null;
      let quantityBlocked = false;
      const quantityFact =
        lineItem.quantity != null
          ? buildSourceFact({
              sourcePath: `${linePath}.quantity`,
              category: 'quantity',
              requiredForCompleteness: true,
              rawValue: lineItem.quantity,
              evidenceIds: [lineEvidence.evidenceId],
            })
          : null;
      if (quantityFact != null) {
        builder.addSourceFact(quantityFact);
        quantity = tryParseDecimal(lineItem.quantity!);
        if (quantity == null) {
          quantityBlocked = true;
          builder.addOmission(
            buildOmission({
              sourceFactId: quantityFact.factId,
              reason: 'invalid_number',
              severity: 'blocking',
              message: `line-item quantity ${String(lineItem.quantity)} is not a finite decimal`,
            }),
          );
        }
      }

      let unitCost: string | null = null;
      let unitCostBlocked = false;
      const unitCostFact =
        rawLineUnitCost != null
          ? buildSourceFact({
              sourcePath: lineUnitCostPath,
              category: 'money',
              requiredForCompleteness: true,
              rawValue: {
                value: rawLineUnitCost,
                unit: 'dollars',
                sourceField: lineUnitCostAlias!.key,
              },
              evidenceIds: [lineEvidence.evidenceId],
            })
          : null;
      if (unitCostFact != null) {
        builder.addSourceFact(unitCostFact);
        unitCost = tryParseDecimal(rawLineUnitCost!);
        if (unitCost == null) {
          unitCostBlocked = true;
          builder.addOmission(
            buildOmission({
              sourceFactId: unitCostFact.factId,
              reason: 'invalid_number',
              severity: 'blocking',
              message: `line-item unit cost ${String(rawLineUnitCost)} is not a finite decimal`,
            }),
          );
        }
      }

      const descriptionBlocked = description.length === 0;
      const canAssert =
        parentIdentity != null &&
        !descriptionBlocked &&
        !dollarsBlocked &&
        !quantityBlocked &&
        !unitCostBlocked;

      if (canAssert && parentIdentity != null) {
        const consumedFactIds = [
          descriptionFact.factId,
          ...(dollarsFact != null ? [dollarsFact.factId] : []),
          ...(quantityFact != null ? [quantityFact.factId] : []),
          ...(unitCostFact != null ? [unitCostFact.factId] : []),
        ];
        builder.addAssertion({
          assertionId: assertionIdV1({ sourcePath: linePath, kind: 'procurement_line' }),
          assertionKind: 'procurement_line',
          parentIdentity,
          description,
          fiscalYear: lineFy,
          ...(quantity != null ? { quantity } : {}),
          ...(dollarsMoney != null ? { dollars: dollarsMoney } : {}),
          ...(unitCost != null ? { unitCostDollars: unitCost } : {}),
          sourceFactIds: consumedFactIds,
          evidenceIds: [lineEvidence.evidenceId],
          confidence: 1,
          metadata: {
            ...(lineItem.dollarsUnit != null
              ? { dollarsUnitSource: 'row' }
              : options.legacyLineItemDollarsUnit != null && dollarsFact != null
                ? { dollarsUnitSource: 'adapter_context' }
                : {}),
            ...(lineUnitCostAlias != null ? { unitCostSourceField: lineUnitCostAlias.key } : {}),
          },
        });
      } else {
        const strandedReason =
          parentIdentity == null
            ? ('invalid_identity' as const)
            : descriptionBlocked
              ? ('missing_value' as const)
              : ('legacy_artifact_missing_detail' as const);
        const strandedMessage =
          parentIdentity == null
            ? 'line item sits under a parent with no procurement code'
            : descriptionBlocked
              ? 'line-item value sits on a row whose description is empty'
              : 'line-item value cannot join a procurement_line assertion because a sibling value on the same row is blocked';
        if (!descriptionBlocked) {
          builder.addOmission(
            buildOmission({
              sourceFactId: descriptionFact.factId,
              reason: strandedReason,
              severity: 'blocking',
              message: strandedMessage,
            }),
          );
        }
        if (dollarsFact != null && !dollarsBlocked) {
          builder.addOmission(
            buildOmission({
              sourceFactId: dollarsFact.factId,
              reason: strandedReason,
              severity: 'blocking',
              message: strandedMessage,
            }),
          );
        }
        if (quantityFact != null && !quantityBlocked) {
          builder.addOmission(
            buildOmission({
              sourceFactId: quantityFact.factId,
              reason: strandedReason,
              severity: 'blocking',
              message: strandedMessage,
            }),
          );
        }
        if (unitCostFact != null && !unitCostBlocked) {
          builder.addOmission(
            buildOmission({
              sourceFactId: unitCostFact.factId,
              reason: strandedReason,
              severity: 'blocking',
              message: strandedMessage,
            }),
          );
        }
      }
    });
  });

  return builder.finalize();
}

/* ------------------------------------------------------------------ */
/* internals                                                           */
/* ------------------------------------------------------------------ */

function isValidFiscalYearValue(value: number | string): boolean {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isInteger(parsed) && parsed >= 1900 && parsed <= 2200;
}

type PdocFiscalYearResult =
  | { kind: 'valid'; fy: number }
  | { kind: 'missing'; fy: number }
  | { kind: 'invalid'; raw: string | number };

function resolvePdocFiscalYear(
  rowFy: number | string | null | undefined,
  defaultFiscalYear: number,
): PdocFiscalYearResult {
  if (rowFy == null || rowFy === '') return { kind: 'missing', fy: defaultFiscalYear };
  if (typeof rowFy === 'number' || typeof rowFy === 'string') {
    if (isValidFiscalYearValue(rowFy)) {
      return { kind: 'valid', fy: typeof rowFy === 'number' ? rowFy : Number(rowFy) };
    }
  }
  return { kind: 'invalid', raw: rowFy };
}

function tryParseDecimal(value: string | number): string | null {
  try {
    return parseCanonicalDecimalString(value);
  } catch {
    return null;
  }
}

function tryBuildMoney(
  value: string | number,
  unit: 'dollars' | 'thousands' | 'millions',
): MoneyValueV1 | null {
  const originalValue = tryParseDecimal(value);
  if (originalValue == null) return null;
  return {
    originalValue,
    originalUnit: unit,
    valueMillions: moneyToMillionsString(originalValue, unit),
  };
}
