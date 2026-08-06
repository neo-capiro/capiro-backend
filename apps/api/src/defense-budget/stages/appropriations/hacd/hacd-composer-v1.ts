/** Phase 6 Workstream H — deterministic, write-free HAC-D stage composition. */
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
  assertHacdTableBinding,
  hacdActionMoney,
  hacdDuplicateDisposition,
  isHacdPackageAction,
} from './hacd-composition-helpers-v1.js';
import {
  addHacdEvidence,
  emitHacdBaseline,
  emitHacdDirectAction,
  emitHacdPackageAction,
  emitHacdPosition,
  emitHacdStageAction,
  emitHacdStageOmission,
  hacdStageOmissionSeverity,
  omitHacdRow,
} from './hacd-emission-v1.js';
import {
  addHacdUnresolvedBinding,
  countHacdAction,
  countHacdBinding,
  countHacdOmission,
  countHacdPosition,
  createHacdCoverageReport,
  createHacdUnresolvedReport,
  finalizeHacdReports,
  hacdLineFamily,
  touchHacdAccountCoverage,
  type HacdCoverageReportV1,
  type HacdUnresolvedReportV1,
} from './hacd-reports-v1.js';

export interface ComposeHacdStageV1Input {
  profile: DefenseBudgetStageSourceProfileV1;
  source: ExtractionSourceV1;
  parserRuns: readonly ParserRunV1[];
  tables: readonly CongressionalTableV1[];
  resolutionContext: LineReferenceResolutionContext;
}

export interface ComposeHacdStageV1Result {
  artifact: DefenseBudgetExtractionArtifactV1;
  bindings: ResolvedBudgetLineBindingV1[];
  coverage: HacdCoverageReportV1;
  unresolved: HacdUnresolvedReportV1;
}

export function composeHacdStageV1(input: ComposeHacdStageV1Input): ComposeHacdStageV1Result {
  const profile = parseStageSourceProfileV1(input.profile);
  if (profile.stage !== 'hac_d' || profile.authority !== 'hacd_appropriations') {
    throw new Error('HAC-D composer requires stage=hac_d and authority=hacd_appropriations');
  }
  if (input.source.authority !== 'hac_d') {
    throw new Error("HAC-D source authority must be 'hac_d'");
  }
  if (input.source.fiscalYear !== profile.fiscalYear) {
    throw new Error('HAC-D fiscal-year mismatch');
  }

  const builder = new ArtifactBuilderV1(input.source);
  const standInRun = {
    parserRunId: parserRunIdV1({ source: input.source.sourcePdfSha256, profile: profile.profileId }),
    method: 'manual' as const,
    parserVersion: 'hacd-stage-composer-v1',
    parserConfigSha256: stageSourceProfileHashV1(profile),
    inputSourceSha256: input.source.sourcePdfSha256,
    outputArtifactSha256: input.source.sourcePdfSha256,
  };
  for (const run of input.parserRuns) builder.addParserRun(run);
  const runId = input.parserRuns[0]?.parserRunId ?? standInRun.parserRunId;
  const coverage = createHacdCoverageReport(profile, input.source);
  const unresolved = createHacdUnresolvedReport(profile, input.source);
  const bindings: ResolvedBudgetLineBindingV1[] = [];

  for (const rawTable of input.tables) {
    const table = congressionalTableV1Schema.parse(rawTable);
    assertHacdTableBinding(table, profile, input.source);
    const duplicates = hacdDuplicateDisposition(table);
    const evidenceByRow = new Map<number, string[]>();
    for (const row of table.rows) {
      evidenceByRow.set(row.rowIndex, addHacdEvidence(builder, table, row, runId));
    }

    for (const row of table.rows) {
      const bucket = coverage.byLineFamily[hacdLineFamily(row, table)];
      const account = touchHacdAccountCoverage(coverage, row);
      bucket.representedRows += 1;
      coverage.totals.representedRows += 1;
      if (account != null) account.representedRows += 1;
      const ownEvidence = evidenceByRow.get(row.rowIndex) ?? [];

      if (duplicates.conflicts.has(row.rowIndex)) {
        omitHacdRow(
          builder,
          table,
          row,
          ownEvidence,
          'ambiguous_layout',
          'blocking',
          'duplicate HAC-D rows state conflicting totals',
        );
        countHacdOmission(bucket, coverage.totals, account, 'blocking');
        continue;
      }
      if (duplicates.secondary.has(row.rowIndex)) continue;
      const groupedRows = duplicates.groups.get(row.rowIndex) ?? [row];
      const allEvidence = groupedRows.flatMap(
        (groupedRow) => evidenceByRow.get(groupedRow.rowIndex) ?? [],
      );

      if (isHacdPackageAction(row)) {
        if (emitHacdPackageAction(builder, table, row, allEvidence)) {
          countHacdAction(bucket, coverage.totals, account);
        } else {
          omitHacdRow(
            builder,
            table,
            row,
            allEvidence,
            'missing_value',
            'blocking',
            'package-scope HAC-D action has no typed amount',
          );
          countHacdOmission(bucket, coverage.totals, account, 'blocking');
        }
        continue;
      }

      const binding = resolveBudgetLineReferenceV1(row.reference, input.resolutionContext);
      binding.supportingEvidenceIds = allEvidence;
      bindings.push(binding);
      countHacdBinding(bucket, coverage.totals, binding.status);
      if (binding.status !== 'accepted' || binding.targetIdentity == null) {
        addHacdUnresolvedBinding({ report: unresolved, table, row, binding, evidenceIds: allEvidence });
        const severity = binding.status === 'candidate' ? 'review' : 'blocking';
        omitHacdRow(
          builder,
          table,
          row,
          allEvidence,
          'invalid_identity',
          severity,
          `HAC-D row binding is ${binding.status}; machine pass is forbidden`,
        );
        countHacdOmission(bucket, coverage.totals, account, severity);
        continue;
      }

      if (row.semanticKind === 'general_provision') {
        const amount = hacdActionMoney(rowMoneyV1(table, row));
        if (amount != null) {
          emitHacdDirectAction(
            builder,
            table,
            row,
            binding.targetIdentity,
            amount,
            allEvidence,
          );
          countHacdAction(bucket, coverage.totals, account);
        } else {
          omitHacdRow(
            builder,
            table,
            row,
            allEvidence,
            'missing_value',
            'blocking',
            'line-specific HAC-D general provision has no typed amount',
          );
          countHacdOmission(bucket, coverage.totals, account, 'blocking');
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
        emitHacdBaseline(builder, baseline, table, row, allEvidence);
      }
      for (const position of emission.positions) {
        emitHacdPosition(builder, profile, position, table, row, allEvidence);
        countHacdPosition(bucket, coverage.totals, account);
      }
      for (const action of emission.actions) {
        emitHacdStageAction(builder, action, table, row, allEvidence);
        countHacdAction(bucket, coverage.totals, account);
      }

      if (emission.positions.length > 0) {
        const adjustment = hacdActionMoney(rowMoneyV1(table, row));
        if (adjustment != null) {
          emitHacdDirectAction(
            builder,
            table,
            row,
            binding.targetIdentity,
            adjustment,
            allEvidence,
          );
          countHacdAction(bucket, coverage.totals, account);
        }
      }

      for (const omission of emission.omissions) {
        emitHacdStageOmission(builder, table, row, allEvidence, omission);
        countHacdOmission(
          bucket,
          coverage.totals,
          account,
          hacdStageOmissionSeverity(omission),
        );
      }
      if (
        emission.positions.length === 0 &&
        emission.actions.length === 0 &&
        emission.omissions.length === 0
      ) {
        const severity = row.semanticKind === 'narrative_only' ? 'review' : 'blocking';
        omitHacdRow(
          builder,
          table,
          row,
          allEvidence,
          'unsupported_field',
          severity,
          `HAC-D row semantic '${row.semanticKind}' produced no stage output`,
        );
        countHacdOmission(bucket, coverage.totals, account, severity);
      }
    }
  }

  if (input.parserRuns.length === 0) builder.addParserRunCoveringAddedEvidence(standInRun);
  finalizeHacdReports(coverage, unresolved);
  return { artifact: builder.finalize(), bindings, coverage, unresolved };
}
