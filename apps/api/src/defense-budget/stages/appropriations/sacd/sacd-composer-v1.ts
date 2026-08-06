/** Phase 6 Workstream I — deterministic, write-free SAC-D stage composition. */
import { ArtifactBuilderV1, parserRunIdV1 } from '../../../contracts/artifact-builders.js';
import type {
  DefenseBudgetExtractionArtifactV1,
  ExtractionSourceV1,
  ParserRunV1,
} from '../../../contracts/extraction-artifact-v1.js';
import {
  congressionalTableV1Schema,
  rowMoneyV1,
  type CongressionalTableV1,
} from '../../congressional-table-v1.js';
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
  assertSacdTableBinding,
  isSacdPackageAction,
  sacdActionMoney,
  sacdDuplicateDisposition,
} from './sacd-composition-helpers-v1.js';
import {
  addSacdEvidence,
  emitSacdBaseline,
  emitSacdDirectAction,
  emitSacdPackageAction,
  emitSacdPosition,
  emitSacdStageAction,
  emitSacdStageOmission,
  omitSacdRow,
  sacdStageOmissionSeverity,
} from './sacd-emission-v1.js';
import {
  addSacdUnresolvedBinding,
  countSacdAction,
  countSacdBinding,
  countSacdOmission,
  countSacdPosition,
  createSacdCoverageReport,
  createSacdUnresolvedReport,
  finalizeSacdReports,
  sacdLineFamily,
  touchSacdAccountCoverage,
  type SacdCoverageReportV1,
  type SacdUnresolvedReportV1,
} from './sacd-reports-v1.js';

export interface ComposeSacdStageV1Input {
  profile: DefenseBudgetStageSourceProfileV1;
  source: ExtractionSourceV1;
  parserRuns: readonly ParserRunV1[];
  tables: readonly CongressionalTableV1[];
  resolutionContext: LineReferenceResolutionContext;
}

export interface ComposeSacdStageV1Result {
  artifact: DefenseBudgetExtractionArtifactV1;
  bindings: ResolvedBudgetLineBindingV1[];
  coverage: SacdCoverageReportV1;
  unresolved: SacdUnresolvedReportV1;
}

export function composeSacdStageV1(input: ComposeSacdStageV1Input): ComposeSacdStageV1Result {
  const profile = parseStageSourceProfileV1(input.profile);
  if (profile.stage !== 'sac_d' || profile.authority !== 'sacd_appropriations') {
    throw new Error('SAC-D composer requires stage=sac_d and authority=sacd_appropriations');
  }
  if (input.source.authority !== 'sac_d') {
    throw new Error("SAC-D source authority must be 'sac_d'");
  }
  if (input.source.fiscalYear !== profile.fiscalYear) {
    throw new Error('SAC-D fiscal-year mismatch');
  }

  const builder = new ArtifactBuilderV1(input.source);
  const standInRun = {
    parserRunId: parserRunIdV1({ source: input.source.sourcePdfSha256, profile: profile.profileId }),
    method: 'manual' as const,
    parserVersion: 'sacd-stage-composer-v1',
    parserConfigSha256: stageSourceProfileHashV1(profile),
    inputSourceSha256: input.source.sourcePdfSha256,
    outputArtifactSha256: input.source.sourcePdfSha256,
  };
  for (const run of input.parserRuns) builder.addParserRun(run);
  const runId = input.parserRuns[0]?.parserRunId ?? standInRun.parserRunId;
  const coverage = createSacdCoverageReport(profile, input.source);
  const unresolved = createSacdUnresolvedReport(profile, input.source);
  const bindings: ResolvedBudgetLineBindingV1[] = [];

  for (const rawTable of input.tables) {
    const table = congressionalTableV1Schema.parse(rawTable);
    assertSacdTableBinding(table, profile, input.source);
    const duplicates = sacdDuplicateDisposition(table);
    const evidenceByRow = new Map<number, string[]>();
    for (const row of table.rows) {
      evidenceByRow.set(row.rowIndex, addSacdEvidence(builder, table, row, runId));
    }

    for (const row of table.rows) {
      const bucket = coverage.byLineFamily[sacdLineFamily(row, table)];
      const account = touchSacdAccountCoverage(coverage, row);
      bucket.representedRows += 1;
      coverage.totals.representedRows += 1;
      if (account != null) account.representedRows += 1;
      const ownEvidence = evidenceByRow.get(row.rowIndex) ?? [];

      if (duplicates.conflicts.has(row.rowIndex)) {
        omitSacdRow(
          builder,
          table,
          row,
          ownEvidence,
          'ambiguous_layout',
          'blocking',
          'duplicate SAC-D rows state conflicting totals',
        );
        countSacdOmission(bucket, coverage.totals, account, 'blocking');
        continue;
      }
      if (duplicates.secondary.has(row.rowIndex)) continue;
      const groupedRows = duplicates.groups.get(row.rowIndex) ?? [row];
      const allEvidence = groupedRows.flatMap(
        (groupedRow) => evidenceByRow.get(groupedRow.rowIndex) ?? [],
      );

      if (isSacdPackageAction(row)) {
        if (emitSacdPackageAction(builder, table, row, allEvidence)) {
          countSacdAction(bucket, coverage.totals, account);
        } else {
          omitSacdRow(
            builder,
            table,
            row,
            allEvidence,
            'missing_value',
            'blocking',
            'package-scope SAC-D action has no typed amount',
          );
          countSacdOmission(bucket, coverage.totals, account, 'blocking');
        }
        continue;
      }

      const binding = resolveBudgetLineReferenceV1(row.reference, input.resolutionContext);
      binding.supportingEvidenceIds = allEvidence;
      bindings.push(binding);
      countSacdBinding(bucket, coverage.totals, binding.status);
      if (binding.status !== 'accepted' || binding.targetIdentity == null) {
        addSacdUnresolvedBinding({ report: unresolved, table, row, binding, evidenceIds: allEvidence });
        const severity = binding.status === 'candidate' ? 'review' : 'blocking';
        omitSacdRow(
          builder,
          table,
          row,
          allEvidence,
          'invalid_identity',
          severity,
          `SAC-D row binding is ${binding.status}; machine pass is forbidden`,
        );
        countSacdOmission(bucket, coverage.totals, account, severity);
        continue;
      }

      if (row.semanticKind === 'general_provision') {
        const amount = sacdActionMoney(rowMoneyV1(table, row));
        if (amount != null) {
          emitSacdDirectAction(
            builder,
            table,
            row,
            binding.targetIdentity,
            amount,
            allEvidence,
          );
          countSacdAction(bucket, coverage.totals, account);
        } else {
          omitSacdRow(
            builder,
            table,
            row,
            allEvidence,
            'missing_value',
            'blocking',
            'line-specific SAC-D general provision has no typed amount',
          );
          countSacdOmission(bucket, coverage.totals, account, 'blocking');
        }
        continue;
      }

      const rowTable: CongressionalTableV1 = { ...table, rows: [row] };
      const emission = emitStageRowsV1({
        profile,
        table: rowTable,
        bindingsByRowIndex: new Map([[row.rowIndex, binding]]),
      });
      for (const baseline of emission.baselines) {
        emitSacdBaseline(builder, baseline, table, row, allEvidence);
      }
      for (const position of emission.positions) {
        emitSacdPosition(builder, profile, position, table, row, allEvidence);
        countSacdPosition(bucket, coverage.totals, account);
      }
      for (const action of emission.actions) {
        emitSacdStageAction(builder, action, table, row, allEvidence);
        countSacdAction(bucket, coverage.totals, account);
      }

      if (emission.positions.length > 0) {
        const adjustment = sacdActionMoney(rowMoneyV1(table, row));
        if (adjustment != null) {
          emitSacdDirectAction(
            builder,
            table,
            row,
            binding.targetIdentity,
            adjustment,
            allEvidence,
          );
          countSacdAction(bucket, coverage.totals, account);
        }
      }

      for (const omission of emission.omissions) {
        emitSacdStageOmission(builder, table, row, allEvidence, omission);
        countSacdOmission(
          bucket,
          coverage.totals,
          account,
          sacdStageOmissionSeverity(omission),
        );
      }
      if (
        emission.positions.length === 0 &&
        emission.actions.length === 0 &&
        emission.omissions.length === 0
      ) {
        const severity = row.semanticKind === 'narrative_only' ? 'review' : 'blocking';
        omitSacdRow(
          builder,
          table,
          row,
          allEvidence,
          'unsupported_field',
          severity,
          `SAC-D row semantic '${row.semanticKind}' produced no stage output`,
        );
        countSacdOmission(bucket, coverage.totals, account, severity);
      }
    }
  }

  if (input.parserRuns.length === 0) builder.addParserRunCoveringAddedEvidence(standInRun);
  finalizeSacdReports(coverage, unresolved);
  return { artifact: builder.finalize(), bindings, coverage, unresolved };
}
