/** Phase 6 Workstream G — deterministic, write-free NDAA conference composition. */
import { ArtifactBuilderV1, parserRunIdV1 } from '../../../contracts/artifact-builders.js';
import type {
  DefenseBudgetExtractionArtifactV1,
  ExtractionSourceV1,
  ParserRunV1,
} from '../../../contracts/extraction-artifact-v1.js';
import { composeDuplicateRowsV1, type CongressionalTableV1 } from '../../congressional-table-v1.js';
import type { ResolvedBudgetLineBindingV1 } from '../../budget-line-reference-v1.js';
import {
  resolveBudgetLineReferenceV1,
  type LineReferenceResolutionContext,
} from '../../line-reference-resolver.js';
import {
  parseStageSourceProfileV1,
  stageSourceProfileHashV1,
  type DefenseBudgetStageSourceProfileV1,
} from '../../stage-source-profile-v1.js';
import { emitStageRowsV1 } from '../../stage-row-emitter-v1.js';
import {
  parseNdaaConferenceVehicleProofV1,
  type NdaaConferenceVehicleProofV1,
} from './ndaa-conference-facts-v1.js';
import {
  addNdaaConferenceEvidenceV1,
  emitNdaaConferenceBaselineV1,
  emitNdaaConferenceChamberFactV1,
  emitNdaaConferencePositionV1,
  emitNdaaConferenceStageActionV1,
  emitNdaaConferenceVehicleProofV1,
  omitNdaaConferenceRowV1,
} from './ndaa-conference-emission-v1.js';
import {
  addNdaaConferenceUnresolvedV1,
  countNdaaConferenceBindingV1,
  countNdaaConferenceOmissionV1,
  countNdaaConferencePositionV1,
  createNdaaConferenceCoverageReportV1,
  createNdaaConferenceUnresolvedReportV1,
  finalizeNdaaConferenceReportsV1,
  ndaaConferenceLineKindV1,
  type NdaaConferenceCoverageReportV1,
  type NdaaConferenceUnresolvedReportV1,
} from './ndaa-conference-reports-v1.js';
import {
  ndaaConferenceEmissionTableV1,
  ndaaConferenceTableV1Schema,
  printedConferenceMoneyForRowV1,
  type NdaaConferenceTableV1,
} from './ndaa-conference-table-v1.js';

export interface ComposeNdaaConferenceStageV1Input {
  profile: DefenseBudgetStageSourceProfileV1;
  source: ExtractionSourceV1;
  parserRuns: readonly ParserRunV1[];
  tables: readonly NdaaConferenceTableV1[];
  resolutionContext: LineReferenceResolutionContext;
  vehicleProof: NdaaConferenceVehicleProofV1;
}

export interface ComposeNdaaConferenceStageV1Result {
  artifact: DefenseBudgetExtractionArtifactV1;
  bindings: ResolvedBudgetLineBindingV1[];
  coverage: NdaaConferenceCoverageReportV1;
  unresolved: NdaaConferenceUnresolvedReportV1;
}

export function composeNdaaConferenceStageV1(
  input: ComposeNdaaConferenceStageV1Input,
): ComposeNdaaConferenceStageV1Result {
  const profile = parseStageSourceProfileV1(input.profile);
  const proof = parseNdaaConferenceVehicleProofV1(input.vehicleProof);
  assertNdaaConferenceSourceBinding(profile, input.source, proof);

  const builder = new ArtifactBuilderV1(input.source);
  const standInRun = {
    parserRunId: parserRunIdV1({
      source: input.source.sourcePdfSha256,
      profile: profile.profileId,
      stage: 'ndaa_conference',
    }),
    method: 'manual' as const,
    parserVersion: 'ndaa-conference-stage-composer-v1',
    parserConfigSha256: stageSourceProfileHashV1(profile),
    inputSourceSha256: input.source.sourcePdfSha256,
    outputArtifactSha256: input.source.sourcePdfSha256,
  };
  for (const run of input.parserRuns) builder.addParserRun(run);
  const runId = input.parserRuns[0]?.parserRunId ?? standInRun.parserRunId;
  emitNdaaConferenceVehicleProofV1(builder, proof, runId);

  const coverage = createNdaaConferenceCoverageReportV1(profile, input.source);
  const unresolved = createNdaaConferenceUnresolvedReportV1(profile, input.source);
  const bindings: ResolvedBudgetLineBindingV1[] = [];

  for (const rawBundle of input.tables) {
    const bundle = ndaaConferenceTableV1Schema.parse(rawBundle);
    assertTableBinding(bundle, profile, input.source);
    const emissionTable = ndaaConferenceEmissionTableV1(bundle);
    const duplicates = duplicateDisposition(bundle, emissionTable);
    const evidenceByRow = new Map<number, string[]>();
    for (const row of bundle.table.rows) {
      evidenceByRow.set(row.rowIndex, addNdaaConferenceEvidenceV1(builder, bundle.table, row, runId));
    }

    for (const row of bundle.table.rows) {
      const bucket = coverage.byLineKind[ndaaConferenceLineKindV1(row)];
      bucket.representedRows += 1;
      coverage.totals.representedRows += 1;
      const ownEvidence = evidenceByRow.get(row.rowIndex) ?? [];

      if (duplicates.conflicts.has(row.rowIndex)) {
        omitNdaaConferenceRowV1(
          builder,
          bundle.table,
          row,
          ownEvidence,
          'ambiguous_layout',
          'blocking',
          'duplicate NDAA conference rows state conflicting conference totals',
        );
        countNdaaConferenceOmissionV1(bucket, coverage.totals, 'blocking');
        continue;
      }
      if (duplicates.secondary.has(row.rowIndex)) continue;
      const groupedRows = duplicates.groups.get(row.rowIndex) ?? [row];
      const allEvidence = groupedRows.flatMap(
        (item) => evidenceByRow.get(item.rowIndex) ?? [],
      );

      const binding = resolveBudgetLineReferenceV1(row.reference, input.resolutionContext);
      binding.supportingEvidenceIds = allEvidence;
      bindings.push(binding);
      countNdaaConferenceBindingV1(bucket, coverage.totals, binding.status);
      if (binding.status !== 'accepted' || binding.targetIdentity == null) {
        addNdaaConferenceUnresolvedV1({
          report: unresolved,
          row,
          page: bundle.table.page,
          ...(bundle.table.printedPage != null ? { printedPage: bundle.table.printedPage } : {}),
          binding,
          evidenceIds: allEvidence,
        });
        const severity = binding.status === 'candidate' ? 'review' : 'blocking';
        omitNdaaConferenceRowV1(
          builder,
          bundle.table,
          row,
          allEvidence,
          'invalid_identity',
          severity,
          `NDAA conference row binding is ${binding.status}; machine certification is forbidden`,
        );
        countNdaaConferenceOmissionV1(bucket, coverage.totals, severity);
        continue;
      }

      const emissionRow = emissionTable.rows.find((item) => item.rowIndex === row.rowIndex)!;
      const rowTable: CongressionalTableV1 = { ...emissionTable, rows: [emissionRow] };
      const emission = emitStageRowsV1({
        profile,
        table: rowTable,
        bindingsByRowIndex: new Map([[row.rowIndex, binding]]),
      });

      for (const baseline of emission.baselines) {
        emitNdaaConferenceBaselineV1(builder, baseline, bundle.table, row, allEvidence);
      }
      for (const position of emission.positions) {
        emitNdaaConferencePositionV1(builder, profile, position, bundle.table, row, allEvidence);
        emitNdaaConferenceChamberFactV1({
          builder,
          bundle,
          row,
          identity: binding.targetIdentity,
          fiscalYear: position.fiscalYear ?? profile.fiscalYear,
          position,
          evidenceIds: allEvidence,
        });
        countNdaaConferencePositionV1(bucket, coverage.totals);
      }
      for (const action of emission.actions) {
        emitNdaaConferenceStageActionV1(builder, action, bundle.table, row, allEvidence);
      }
      for (const omission of emission.omissions) {
        const severity = omission.reason === 'row_not_interpretable' ? 'review' : 'blocking';
        omitNdaaConferenceRowV1(
          builder,
          bundle.table,
          row,
          allEvidence,
          omission.reason === 'undeclared_unit'
            ? 'unsupported_unit'
            : omission.reason === 'binding_not_accepted'
              ? 'invalid_identity'
              : 'missing_value',
          severity,
          `NDAA conference stage emission omitted row: ${omission.reason}${
            omission.detail == null ? '' : ` (${omission.detail})`
          }`,
        );
        countNdaaConferenceOmissionV1(bucket, coverage.totals, severity);
      }
      if (emission.positions.length === 0 && emission.actions.length === 0 && emission.omissions.length === 0) {
        omitNdaaConferenceRowV1(
          builder,
          bundle.table,
          row,
          allEvidence,
          'unsupported_field',
          'blocking',
          'NDAA conference row produced no conference position or typed action',
        );
        countNdaaConferenceOmissionV1(bucket, coverage.totals, 'blocking');
      }
    }
  }

  if (input.parserRuns.length === 0) builder.addParserRunCoveringAddedEvidence(standInRun);
  finalizeNdaaConferenceReportsV1(coverage, unresolved);
  return { artifact: builder.finalize(), bindings, coverage, unresolved };
}

function assertNdaaConferenceSourceBinding(
  profile: DefenseBudgetStageSourceProfileV1,
  source: ExtractionSourceV1,
  proof: NdaaConferenceVehicleProofV1,
): void {
  if (profile.stage !== 'ndaa_conference' || profile.authority !== 'ndaa_conference_authorization') {
    throw new Error('NDAA conference composer requires ndaa_conference authorization profile');
  }
  if (source.authority !== 'ndaa_conference' || source.exhibit !== 'conference_report') {
    throw new Error('NDAA conference source must use authority=ndaa_conference and conference_report exhibit');
  }
  if (source.fiscalYear !== profile.fiscalYear || proof.fiscalYear !== profile.fiscalYear) {
    throw new Error('NDAA conference fiscal-year mismatch');
  }
  if (profile.billId == null || !proof.billIds.includes(profile.billId)) {
    throw new Error('NDAA conference vehicle proof does not contain the governed billId');
  }
  if (profile.reportNumber == null || proof.reportNumber !== profile.reportNumber) {
    throw new Error('NDAA conference report-number mismatch');
  }
  if (proof.primary.manifestDocumentKey !== source.manifestDocumentKey) {
    throw new Error('NDAA conference primary manifest-document mismatch');
  }
  if (source.sourceDocumentId == null || proof.primary.sourceDocumentId !== source.sourceDocumentId) {
    throw new Error('NDAA conference primary source-document mismatch');
  }
  if (proof.primary.sourceSha256 !== source.sourcePdfSha256) {
    throw new Error('NDAA conference primary source SHA mismatch');
  }
  if (!profile.sourceDocumentKeys.includes(proof.primary.manifestDocumentKey)) {
    throw new Error('NDAA conference primary document is not governed by the source profile');
  }
  const requiredJes = profile.companionDocuments.find(
    (item) => item.companionKind === 'joint_explanatory_statement' && item.required,
  );
  if (requiredJes != null) {
    if (
      proof.jointExplanatoryStatement == null ||
      proof.jointExplanatoryStatement.manifestDocumentKey !== requiredJes.manifestDocumentKey
    ) {
      throw new Error('required joint explanatory statement proof is missing or mismatched');
    }
  }
}

function assertTableBinding(
  bundle: NdaaConferenceTableV1,
  profile: DefenseBudgetStageSourceProfileV1,
  source: ExtractionSourceV1,
): void {
  if (bundle.table.profileId !== profile.profileId) throw new Error('NDAA conference table profile mismatch');
  if (bundle.table.sourceSha256 !== source.sourcePdfSha256) throw new Error('NDAA conference table source SHA mismatch');
  if (bundle.table.sourceDocumentId !== source.sourceDocumentId) throw new Error('NDAA conference table source-document mismatch');
}

function duplicateDisposition(bundle: NdaaConferenceTableV1, table: CongressionalTableV1) {
  const conflicts = new Set<number>();
  const secondary = new Set<number>();
  const groups = new Map<number, CongressionalTableV1['rows']>();
  for (const group of composeDuplicateRowsV1(table, { allowBaselinePlusChange: true })) {
    if (group.rows.length < 2) continue;
    const rows = [...group.rows].sort((a, b) => a.rowIndex - b.rowIndex);
    const printedSignatures = new Set(
      rows.map((row) =>
        printedSignature(bundle, bundle.table.rows.find((item) => item.rowIndex === row.rowIndex)!),
      ),
    );
    if (group.conflict != null || printedSignatures.size > 1) {
      rows.forEach((row) => conflicts.add(row.rowIndex));
    } else if (group.agreedValue != null) {
      groups.set(rows[0]!.rowIndex, rows);
      rows.slice(1).forEach((row) => secondary.add(row.rowIndex));
    }
  }
  return { conflicts, secondary, groups };
}

function printedSignature(bundle: NdaaConferenceTableV1, row: CongressionalTableV1['rows'][number]): string {
  return printedConferenceMoneyForRowV1(bundle, row)
    .map((item) => `${item.role}:${item.value}:${item.unit}:${item.fiscalYear ?? 'none'}`)
    .sort()
    .join('|');
}
