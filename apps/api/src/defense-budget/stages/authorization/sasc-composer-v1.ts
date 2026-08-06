/** Phase 6 Workstream E — deterministic, write-free SASC stage composition. */
import {
  ArtifactBuilderV1,
  parserRunIdV1,
} from '../../contracts/artifact-builders.js';
import type {
  DefenseBudgetExtractionArtifactV1,
  ExtractionSourceV1,
  ParserRunV1,
} from '../../contracts/extraction-artifact-v1.js';
import {
  congressionalTableV1Schema,
  rowMoneyV1,
  type CongressionalTableV1,
} from '../congressional-table-v1.js';
import type { ResolvedBudgetLineBindingV1 } from '../budget-line-reference-v1.js';
import {
  resolveBudgetLineReferenceV1,
  type LineReferenceResolutionContext,
} from '../line-reference-resolver.js';
import {
  parseStageSourceProfileV1,
  stageSourceProfileHashV1,
  type DefenseBudgetStageSourceProfileV1,
} from '../stage-source-profile-v1.js';
import { emitStageRowsV1 } from '../stage-row-emitter-v1.js';
import {
  assertSascTableBinding,
  isSascPackageAction,
  sascActionMoney,
  sascDuplicateDisposition,
} from './sasc-composition-helpers-v1.js';
import {
  addSascEvidence,
  emitSascBaseline,
  emitSascDirectAction,
  emitSascPackageAction,
  emitSascPosition,
  emitSascStageAction,
  emitSascStageOmission,
  omitSascRow,
  sascStageOmissionSeverity,
} from './sasc-emission-v1.js';
import {
  addSascUnresolvedBinding,
  countSascAction,
  countSascBinding,
  countSascOmission,
  countSascPosition,
  createSascCoverageReport,
  createSascUnresolvedReport,
  finalizeSascReports,
  sascLineKind,
  type SascCoverageReportV1,
  type SascUnresolvedReportV1,
} from './sasc-reports-v1.js';

export interface ComposeSascStageV1Input {
  profile: DefenseBudgetStageSourceProfileV1;
  source: ExtractionSourceV1;
  parserRuns: readonly ParserRunV1[];
  tables: readonly CongressionalTableV1[];
  resolutionContext: LineReferenceResolutionContext;
}

export interface ComposeSascStageV1Result {
  artifact: DefenseBudgetExtractionArtifactV1;
  bindings: ResolvedBudgetLineBindingV1[];
  coverage: SascCoverageReportV1;
  unresolved: SascUnresolvedReportV1;
}

export function composeSascStageV1(input: ComposeSascStageV1Input): ComposeSascStageV1Result {
  const profile = parseStageSourceProfileV1(input.profile);
  if (profile.stage !== 'sasc' || profile.authority !== 'sasc_authorization') {
    throw new Error('SASC composer requires stage=sasc and authority=sasc_authorization');
  }
  if (input.source.authority !== 'sasc') {
    throw new Error("SASC source authority must be 'sasc'");
  }
  if (input.source.fiscalYear !== profile.fiscalYear) {
    throw new Error('SASC fiscal-year mismatch');
  }

  const builder = new ArtifactBuilderV1(input.source);
  const standInRun = {
    parserRunId: parserRunIdV1({
      source: input.source.sourcePdfSha256,
      profile: profile.profileId,
    }),
    method: 'manual' as const,
    parserVersion: 'sasc-stage-composer-v1',
    parserConfigSha256: stageSourceProfileHashV1(profile),
    inputSourceSha256: input.source.sourcePdfSha256,
    outputArtifactSha256: input.source.sourcePdfSha256,
  };
  for (const run of input.parserRuns) builder.addParserRun(run);
  const runId = input.parserRuns[0]?.parserRunId ?? standInRun.parserRunId;
  const coverage = createSascCoverageReport(profile, input.source);
  const unresolved = createSascUnresolvedReport(profile, input.source);
  const bindings: ResolvedBudgetLineBindingV1[] = [];

  for (const rawTable of input.tables) {
    const table = congressionalTableV1Schema.parse(rawTable);
    assertSascTableBinding(table, profile, input.source);
    const duplicates = sascDuplicateDisposition(table);
    const evidenceByRow = new Map<number, string[]>();
    for (const row of table.rows) {
      evidenceByRow.set(row.rowIndex, addSascEvidence(builder, table, row, runId));
    }

    for (const row of table.rows) {
      const bucket = coverage.byLineKind[sascLineKind(row)];
      bucket.representedRows += 1;
      coverage.totals.representedRows += 1;
      const ownEvidence = evidenceByRow.get(row.rowIndex) ?? [];

      if (duplicates.conflicts.has(row.rowIndex)) {
        omitSascRow(
          builder,
          table,
          row,
          ownEvidence,
          'ambiguous_layout',
          'blocking',
          'duplicate SASC rows state conflicting totals',
        );
        countSascOmission(bucket, coverage.totals, 'blocking');
        continue;
      }
      if (duplicates.secondary.has(row.rowIndex)) continue;

      const groupedRows = duplicates.groups.get(row.rowIndex) ?? [row];
      const allEvidence = groupedRows.flatMap(
        (groupedRow) => evidenceByRow.get(groupedRow.rowIndex) ?? [],
      );

      if (isSascPackageAction(row)) {
        if (emitSascPackageAction(builder, table, row, allEvidence)) {
          countSascAction(bucket, coverage.totals);
        } else {
          omitSascRow(
            builder,
            table,
            row,
            allEvidence,
            'missing_value',
            'blocking',
            'package-scope SASC action has no typed amount',
          );
          countSascOmission(bucket, coverage.totals, 'blocking');
        }
        continue;
      }

      const binding = resolveBudgetLineReferenceV1(row.reference, input.resolutionContext);
      binding.supportingEvidenceIds = allEvidence;
      bindings.push(binding);
      countSascBinding(bucket, coverage.totals, binding.status);

      if (binding.status !== 'accepted' || binding.targetIdentity == null) {
        addSascUnresolvedBinding({
          report: unresolved,
          row,
          page: table.page,
          ...(table.printedPage != null ? { printedPage: table.printedPage } : {}),
          binding,
          evidenceIds: allEvidence,
        });
        const severity = binding.status === 'candidate' ? 'review' : 'blocking';
        omitSascRow(
          builder,
          table,
          row,
          allEvidence,
          'invalid_identity',
          severity,
          `SASC row binding is ${binding.status}; machine pass is forbidden`,
        );
        countSascOmission(bucket, coverage.totals, severity);
        continue;
      }

      const rowTable: CongressionalTableV1 = { ...table, rows: [row] };
      const emission = emitStageRowsV1({
        profile,
        table: rowTable,
        bindingsByRowIndex: new Map([[row.rowIndex, binding]]),
      });

      for (const baseline of emission.baselines) {
        emitSascBaseline(builder, baseline, table, row, allEvidence);
      }
      for (const position of emission.positions) {
        emitSascPosition(builder, profile, position, table, row, allEvidence);
        countSascPosition(bucket, coverage.totals);
      }
      for (const action of emission.actions) {
        emitSascStageAction(builder, action, table, row, allEvidence);
        countSascAction(bucket, coverage.totals);
      }

      // A printed Senate position may also state the chamber adjustment.
      if (emission.positions.length > 0) {
        const adjustment = sascActionMoney(rowMoneyV1(table, row));
        if (adjustment != null) {
          emitSascDirectAction(
            builder,
            table,
            row,
            binding.targetIdentity,
            adjustment,
            allEvidence,
          );
          countSascAction(bucket, coverage.totals);
        }
      }

      for (const omission of emission.omissions) {
        emitSascStageOmission(builder, table, row, allEvidence, omission);
        countSascOmission(
          bucket,
          coverage.totals,
          sascStageOmissionSeverity(omission),
        );
      }

      if (
        emission.positions.length === 0 &&
        emission.actions.length === 0 &&
        emission.omissions.length === 0
      ) {
        const severity = row.semanticKind === 'narrative_only' ? 'review' : 'blocking';
        omitSascRow(
          builder,
          table,
          row,
          allEvidence,
          'unsupported_field',
          severity,
          `SASC row semantic '${row.semanticKind}' produced no stage output`,
        );
        countSascOmission(bucket, coverage.totals, severity);
      }
    }
  }

  if (input.parserRuns.length === 0) {
    builder.addParserRunCoveringAddedEvidence(standInRun);
  }
  finalizeSascReports(coverage, unresolved);
  return { artifact: builder.finalize(), bindings, coverage, unresolved };
}
