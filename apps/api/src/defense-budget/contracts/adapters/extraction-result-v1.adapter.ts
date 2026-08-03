/**
 * Workstream E — adapter for the current generic `ExtractionResult`
 * (apps/api/src/defense-budget/extractors/types.ts).
 *
 * Mapping rules (plan §10):
 *   - every LineAssertion becomes an identity fact + a typed identity-level
 *     assertion (or a blocking omission for UNKNOWN identities)
 *   - mission/projectCode/performerName become separate facts + assertions
 *   - referencedPeCodes become relationship facts + explicit relationships
 *     (a P-40 PE reference is NEVER a new Program Element identity)
 *   - every YearValueAssertion produces at least one source fact and either a
 *     typed assertion or an explicit omission — no silent drops
 *   - warnings remain individually visible
 *   - provenance stays truthful: llamaparse stays llamaparse, pdfplumber stays
 *     deterministic_pdfplumber, manual stays manual; page-only provenance is
 *     emitted as page_only evidence, never a fabricated bounding box
 */
import {
  isValidPeCode,
  type ExtractionResult,
  type LineAssertion,
  type ValueProvenance,
  type YearValueAssertion,
} from '../../extractors/types.js';
import { ArtifactBuilderV1, assertionIdV1 } from '../artifact-builders.js';
import type {
  BudgetLineIdentityV1,
  DefenseBudgetAssertionV1,
  DefenseBudgetExtractionArtifactV1,
  FundingFieldV1,
  MoneyValueV1,
  SourceEvidenceV1,
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

/** Extractor field vocabulary -> contract funding field (aliases normalized). */
const FIELD_MAP: Record<string, FundingFieldV1> = {
  request: 'request',
  hascMark: 'hascMark',
  sascMark: 'sascMark',
  hacdMark: 'hacDMark',
  sacdMark: 'sacDMark',
  hacDMark: 'hacDMark',
  sacDMark: 'sacDMark',
  ndaaConference: 'ndaaConference',
  conference: 'conference',
  enacted: 'enacted',
  reprogrammed: 'reprogrammed',
  executed: 'executed',
};

const PROVENANCE_METHOD_MAP = {
  llamaparse: 'llamaparse',
  deterministic_pdfplumber: 'deterministic_pdfplumber',
  manual: 'manual',
} as const;

export function adaptExtractionResultToArtifactV1(
  extraction: ExtractionResult,
  context: ExtractionAdapterContextV1,
): DefenseBudgetExtractionArtifactV1 {
  const builder = new ArtifactBuilderV1(sourceFromContext(context));
  const parserRun = parserRunFromContext(context);
  builder.addParserRun(parserRun);

  // Phase A.5: Verify parser provenance — every value's extraction method
  // must match the parser run method. Fail on disagreement.
  const expectedMethod = parserRun.method;
  const provenanceMismatch = (method: string): boolean => {
    const mapped = PROVENANCE_METHOD_MAP[method as keyof typeof PROVENANCE_METHOD_MAP];
    return mapped !== expectedMethod;
  };

  const evidenceCache = new Map<string, SourceEvidenceV1>();
  const evidenceFor = (prov: ValueProvenance, discriminator: string): SourceEvidenceV1 => {
    // Truthful provenance mapping: the current extractor's provenance has page
    // but no geometry, so granularity is page_only. The parser-run method on
    // the artifact comes from the ADAPTER CONTEXT; the extractionMethod on
    // provenance is preserved in fact raw values and never rewritten here.
    const key = `${prov.pdfPage}::${prov.printedPage ?? ''}::${prov.exhibit}::${
      prov.tableLabel ?? ''
    }::${prov.rowLabel ?? ''}::${prov.colLabel ?? ''}::${discriminator}`;
    const cached = evidenceCache.get(key);
    if (cached) return cached;
    const evidence = buildTruthfulEvidence(context, {
      parserRunId: parserRun.parserRunId,
      page: prov.pdfPage,
      printedPage: prov.printedPage,
      tableLabel: prov.tableLabel,
      rowLabel: prov.rowLabel,
      columnLabel: prov.colLabel,
      discriminator,
    });
    builder.addEvidence(evidence);
    evidenceCache.set(key, evidence);
    return evidence;
  };

  /* ---------------- line assertions ---------------- */
  extraction.lineAssertions.forEach((line, index) => {
    // Phase A.5: Check provenance consistency
    if (provenanceMismatch(line.provenance.extractionMethod)) {
      builder.addWarning(
        buildWarning({
          code: 'provenance_mismatch',
          severity: 'blocking',
          message: `lineAssertions[${index}] extraction method "${line.provenance.extractionMethod}" does not match parser run method "${expectedMethod}"`,
          discriminator: `lineAssertions[${index}].provenance`,
        }),
      );
    }
    mapLineAssertion(builder, context, line, index, evidenceFor, parserRun.parserRunId);
  });

  /* ---------------- year values ---------------- */
  extraction.yearValues.forEach((value, index) => {
    // Phase A.5: Check provenance consistency
    if (provenanceMismatch(value.provenance.extractionMethod)) {
      builder.addWarning(
        buildWarning({
          code: 'provenance_mismatch',
          severity: 'blocking',
          message: `yearValues[${index}] extraction method "${value.provenance.extractionMethod}" does not match parser run method "${expectedMethod}"`,
          discriminator: `yearValues[${index}].provenance`,
        }),
      );
    }
    mapYearValue(builder, context, value, index, evidenceFor);
  });

  /* ---------------- warnings ---------------- */
  extraction.warnings.forEach((message, index) => {
    builder.addWarning(
      buildWarning({
        code: 'legacy_extraction_warning',
        severity: 'review',
        message,
        discriminator: `warnings[${index}]`,
      }),
    );
  });

  return builder.finalize();
}

/* ------------------------------------------------------------------ */
/* line assertions                                                     */
/* ------------------------------------------------------------------ */

function mapLineAssertion(
  builder: ArtifactBuilderV1,
  context: ExtractionAdapterContextV1,
  line: LineAssertion,
  index: number,
  evidenceFor: (prov: ValueProvenance, discriminator: string) => SourceEvidenceV1,
  parserRunId: string,
): void {
  const basePath = `lineAssertions[${index}]`;
  const identityEvidence = evidenceFor(line.provenance, `${basePath}.identity`);
  const identityFact = buildSourceFact({
    sourcePath: `${basePath}.identity`,
    category: 'identity',
    requiredForCompleteness: true,
    rawValue: {
      lineKind: line.lineKind,
      code: line.code,
      title: line.title,
      account: line.account ?? null,
      component: line.component ?? null,
      budgetActivity: line.budgetActivity ?? null,
      extractionMethod: PROVENANCE_METHOD_MAP[line.provenance.extractionMethod],
    },
    evidenceIds: [identityEvidence.evidenceId],
  });
  builder.addSourceFact(identityFact);

  const identity = toBudgetLineIdentity(line);
  if (identity == null || identity.lineKind === 'UNKNOWN') {
    builder.addOmission(
      buildOmission({
        sourceFactId: identityFact.factId,
        reason: 'invalid_identity',
        severity: 'blocking',
        message: `line kind UNKNOWN or invalid identity for code ${line.code}`,
      }),
    );
  } else {
    builder.addAssertion(
      toIdentityAssertion(line, identity, identityFact.factId, identityEvidence.evidenceId, index),
    );
  }

  if (line.mission != null && line.mission.trim() !== '') {
    const missionEvidence = evidenceFor(line.provenance, `${basePath}.mission`);
    const missionFact = buildSourceFact({
      sourcePath: `${basePath}.mission`,
      category: 'text',
      requiredForCompleteness: true,
      rawValue: line.mission,
      evidenceIds: [missionEvidence.evidenceId],
    });
    builder.addSourceFact(missionFact);
    builder.addAssertion({
      assertionId: assertionIdV1({ sourcePath: `${basePath}.mission`, kind: 'narrative' }),
      assertionKind: 'narrative',
      identity: identity ?? { lineKind: 'UNKNOWN', code: line.code },
      narrativeType: 'mission',
      text: line.mission,
      sourceFactIds: [missionFact.factId],
      evidenceIds: [missionEvidence.evidenceId],
      confidence: line.provenance.confidence,
    });
  }

  if (line.projectCode != null && line.projectCode.trim() !== '') {
    const projectEvidence = evidenceFor(line.provenance, `${basePath}.projectCode`);
    const projectFact = buildSourceFact({
      sourcePath: `${basePath}.projectCode`,
      category: 'project',
      requiredForCompleteness: true,
      rawValue: { projectCode: line.projectCode, title: line.title },
      evidenceIds: [projectEvidence.evidenceId],
    });
    builder.addSourceFact(projectFact);
    if (identity != null && identity.lineKind === 'RDTE_PE') {
      builder.addAssertion({
        assertionId: assertionIdV1({ sourcePath: `${basePath}.projectCode`, kind: 'project' }),
        assertionKind: 'project',
        parentPeCode: identity.peCode,
        projectCode: line.projectCode,
        title: line.title,
        ...(line.mission != null ? { mission: line.mission } : {}),
        sourceFactIds: [projectFact.factId],
        evidenceIds: [projectEvidence.evidenceId],
        confidence: line.provenance.confidence,
      });
    } else {
      builder.addOmission(
        buildOmission({
          sourceFactId: projectFact.factId,
          reason: 'invalid_identity',
          severity: 'blocking',
          message: `project ${line.projectCode} has no valid parent RDT&E PE identity`,
        }),
      );
    }
  }

  if (line.performerName != null && line.performerName.trim() !== '') {
    const performerEvidence = evidenceFor(line.provenance, `${basePath}.performerName`);
    const performerFact = buildSourceFact({
      sourcePath: `${basePath}.performerName`,
      category: 'performer',
      requiredForCompleteness: true,
      rawValue: { performerName: line.performerName, performerRole: line.performerRole ?? null },
      evidenceIds: [performerEvidence.evidenceId],
    });
    builder.addSourceFact(performerFact);
    if (identity != null && identity.lineKind === 'RDTE_PE') {
      builder.addAssertion({
        assertionId: assertionIdV1({ sourcePath: `${basePath}.performerName`, kind: 'performer' }),
        assertionKind: 'performer',
        parentPeCode: identity.peCode,
        ...(line.projectCode != null ? { projectCode: line.projectCode } : {}),
        performerName: line.performerName,
        performerRole: line.performerRole ?? 'UNKNOWN',
        sourceFactIds: [performerFact.factId],
        evidenceIds: [performerEvidence.evidenceId],
        confidence: line.provenance.confidence,
      });
    } else {
      builder.addOmission(
        buildOmission({
          sourceFactId: performerFact.factId,
          reason: 'invalid_identity',
          severity: 'blocking',
          message: `performer ${line.performerName} has no valid parent RDT&E PE identity`,
        }),
      );
    }
  }

  for (const [refIndex, referencedPe] of (line.referencedPeCodes ?? []).entries()) {
    const refPath = `${basePath}.referencedPeCodes[${refIndex}]`;
    const refEvidence = evidenceFor(line.provenance, refPath);
    const refFact = buildSourceFact({
      sourcePath: refPath,
      category: 'relationship',
      requiredForCompleteness: true,
      rawValue: referencedPe,
      evidenceIds: [refEvidence.evidenceId],
    });
    builder.addSourceFact(refFact);
    const fromIdentity = identity ?? { lineKind: 'UNKNOWN' as const, code: line.code };
    if (!isValidPeCode(referencedPe)) {
      builder.addOmission(
        buildOmission({
          sourceFactId: refFact.factId,
          reason: 'invalid_identity',
          severity: 'blocking',
          message: `referenced PE code ${referencedPe} is not a valid PE code`,
        }),
      );
      continue;
    }
    builder.addAssertion({
      assertionId: assertionIdV1({ sourcePath: refPath, kind: 'relationship' }),
      assertionKind: 'relationship',
      from: fromIdentity,
      to: { lineKind: 'RDTE_PE', peCode: referencedPe },
      relationshipType: 'references',
      explicitInSource: true,
      sourceFactIds: [refFact.factId],
      evidenceIds: [refEvidence.evidenceId],
      confidence: line.provenance.confidence,
    });
  }
}

function toBudgetLineIdentity(line: LineAssertion): BudgetLineIdentityV1 | null {
  switch (line.lineKind) {
    case 'RDTE_PE':
      return isValidPeCode(line.code) ? { lineKind: 'RDTE_PE', peCode: line.code } : null;
    case 'PROCUREMENT_BLIN':
      if (line.account == null || line.account.trim() === '') return null;
      return {
        lineKind: 'PROCUREMENT_BLIN',
        code: line.code,
        account: line.account,
        component: toContractComponent(line.component),
      };
    case 'OM_SAG':
      if (line.account == null || line.account.trim() === '') return null;
      return {
        lineKind: 'OM_SAG',
        code: line.code,
        account: line.account,
        component: toContractComponent(line.component),
      };
    case 'MILCON_PROJECT':
      return {
        lineKind: 'MILCON_PROJECT',
        projectCode: line.code,
        component: toContractComponent(line.component),
      };
    case 'UNKNOWN':
      return null;
  }
}

function toContractComponent(
  component: string | undefined,
): BudgetLineIdentityV1 extends { component: infer C } ? C : never {
  const normalized = (component ?? '').trim().toUpperCase();
  switch (normalized) {
    case 'ARMY':
    case 'NAVY':
    case 'AF':
    case 'SF':
    case 'USMC':
    case 'DW':
    case 'DARPA':
    case 'DHA':
    case 'MDA':
    case 'SOCOM':
      return normalized as never;
    case '':
      return 'UNKNOWN' as never;
    default:
      return 'OTHER' as never;
  }
}

function toIdentityAssertion(
  line: LineAssertion,
  identity: Exclude<BudgetLineIdentityV1, { lineKind: 'UNKNOWN' }>,
  factId: string,
  evidenceId: string,
  index: number,
): DefenseBudgetAssertionV1 {
  const base = {
    sourceFactIds: [factId],
    evidenceIds: [evidenceId],
    confidence: line.provenance.confidence,
  };
  switch (identity.lineKind) {
    case 'RDTE_PE':
      return {
        ...base,
        assertionId: assertionIdV1({ sourcePath: `lineAssertions[${index}].identity` }),
        assertionKind: 'program_element_identity',
        identity,
        title: line.title,
        component: toContractComponent(line.component),
        ...(line.account != null ? { appropriation: line.account } : {}),
        ...(line.budgetActivity != null ? { budgetActivity: line.budgetActivity } : {}),
      };
    case 'PROCUREMENT_BLIN':
      // Identity-level document fact when no child-line description exists;
      // child-line assertions come from the P-doc adapter (Workstream J).
      return {
        ...base,
        assertionId: assertionIdV1({ sourcePath: `lineAssertions[${index}].identity` }),
        assertionKind: 'document_fact',
        fieldName: 'procurement_blin_identity',
        value: {
          code: identity.code,
          account: identity.account,
          component: identity.component,
          title: line.title,
          budgetActivity: line.budgetActivity ?? null,
        },
      };
    case 'OM_SAG':
      return {
        ...base,
        assertionId: assertionIdV1({ sourcePath: `lineAssertions[${index}].identity` }),
        assertionKind: 'om_line',
        identity,
        title: line.title,
        ...(line.budgetActivity != null ? { budgetActivity: line.budgetActivity } : {}),
      };
    case 'MILCON_PROJECT':
      return {
        ...base,
        assertionId: assertionIdV1({ sourcePath: `lineAssertions[${index}].identity` }),
        assertionKind: 'milcon_project',
        identity,
        title: line.title,
      };
  }
}

/* ------------------------------------------------------------------ */
/* year values                                                         */
/* ------------------------------------------------------------------ */

function mapYearValue(
  builder: ArtifactBuilderV1,
  context: ExtractionAdapterContextV1,
  value: YearValueAssertion,
  index: number,
  evidenceFor: (prov: ValueProvenance, discriminator: string) => SourceEvidenceV1,
): void {
  const basePath = `yearValues[${index}]`;
  const evidence = evidenceFor(value.provenance, basePath);
  const identity = toBudgetLineIdentity({
    lineKind: value.lineKind,
    code: value.code,
    title: '',
    account: value.account,
    component: value.component,
    provenance: value.provenance,
  });
  const confidence = value.provenance.confidence;

  const makeFact = (category: 'money' | 'quantity' | 'text', rawValue: unknown, suffix: string) =>
    buildSourceFact({
      sourcePath: `${basePath}.${suffix}`,
      category,
      requiredForCompleteness: true,
      rawValue: rawValue as never,
      evidenceIds: [evidence.evidenceId],
    });

  if (value.money != null) {
    const fact = makeFact(
      'money',
      {
        value: value.money.value,
        unit: value.money.unit,
        fieldName: value.fieldName,
        fy: value.fy,
      },
      'money',
    );
    builder.addSourceFact(fact);

    if (identity == null) {
      builder.addOmission(
        buildOmission({
          sourceFactId: fact.factId,
          reason: 'invalid_identity',
          severity: 'blocking',
          message: `money value has no valid line identity (code ${value.code})`,
        }),
      );
      return;
    }
    const field = FIELD_MAP[value.fieldName];
    if (field == null) {
      builder.addOmission(
        buildOmission({
          sourceFactId: fact.factId,
          reason: 'unsupported_field',
          severity: 'review',
          message: `money field ${value.fieldName} is not a contract funding field`,
        }),
      );
      return;
    }
    let money: MoneyValueV1;
    try {
      const originalValue = parseCanonicalDecimalString(value.money.value);
      money = {
        originalValue,
        originalUnit: value.money.unit,
        valueMillions: moneyToMillionsString(originalValue, value.money.unit),
      };
    } catch (cause) {
      builder.addOmission(
        buildOmission({
          sourceFactId: fact.factId,
          reason: 'invalid_number',
          severity: 'blocking',
          message: `money value ${value.money.value} is not a finite decimal: ${(cause as Error).message}`,
        }),
      );
      return;
    }
    builder.addAssertion({
      assertionId: assertionIdV1({ sourcePath: `${basePath}.money`, kind: 'funding' }),
      assertionKind: 'funding',
      identity,
      fiscalYear: value.fy,
      field,
      money,
      sourceFactIds: [fact.factId],
      evidenceIds: [evidence.evidenceId],
      confidence,
    });
    return;
  }

  if (value.quantity != null) {
    const fact = makeFact(
      'quantity',
      { quantity: value.quantity, fieldName: value.fieldName, fy: value.fy },
      'quantity',
    );
    builder.addSourceFact(fact);
    if (identity == null) {
      builder.addOmission(
        buildOmission({
          sourceFactId: fact.factId,
          reason: 'invalid_identity',
          severity: 'blocking',
          message: `quantity value has no valid line identity (code ${value.code})`,
        }),
      );
      return;
    }
    if (!Number.isFinite(value.quantity)) {
      builder.addOmission(
        buildOmission({
          sourceFactId: fact.factId,
          reason: 'invalid_number',
          severity: 'blocking',
          message: `quantity ${value.quantity} is not finite`,
        }),
      );
      return;
    }
    builder.addAssertion({
      assertionId: assertionIdV1({ sourcePath: `${basePath}.quantity`, kind: 'quantity' }),
      assertionKind: 'quantity',
      identity,
      fiscalYear: value.fy,
      quantity: parseCanonicalDecimalString(value.quantity),
      sourceFactIds: [fact.factId],
      evidenceIds: [evidence.evidenceId],
      confidence,
    });
    return;
  }

  if (value.valueText != null) {
    const fact = makeFact(
      'text',
      { valueText: value.valueText, fieldName: value.fieldName, fy: value.fy },
      'valueText',
    );
    builder.addSourceFact(fact);
    builder.addAssertion({
      assertionId: assertionIdV1({ sourcePath: `${basePath}.valueText`, kind: 'document_fact' }),
      assertionKind: 'document_fact',
      fieldName: value.fieldName,
      value: value.valueText,
      sourceFactIds: [fact.factId],
      evidenceIds: [evidence.evidenceId],
      confidence,
    });
    return;
  }

  // No value present: explicit omission, never a silent drop.
  const emptyFact = buildSourceFact({
    sourcePath: `${basePath}.value`,
    category: 'text',
    requiredForCompleteness: true,
    rawValue: {
      fieldName: value.fieldName,
      fy: value.fy,
      money: null,
      quantity: null,
      valueText: null,
    },
    evidenceIds: [evidence.evidenceId],
  });
  builder.addSourceFact(emptyFact);
  builder.addOmission(
    buildOmission({
      sourceFactId: emptyFact.factId,
      reason: 'missing_value',
      severity: 'review',
      message: `year value for field ${value.fieldName} fy ${value.fy} carries no money, quantity, or text`,
    }),
  );
}
