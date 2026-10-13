/** Separate backend/full evidence while preserving the established full shape. */
import {
  PE_PHASE_9_EXTENDED_PROOF_IDS,
  PE_PHASE_9_EXTENDED_PROOF_OWNERS,
  type PePhase9Scope,
} from './pe-phase-9-rehearsal-catalog.js';
import type {
  PePhase9BaseComparison,
  PePhase9GateResult,
  PePhase9IntegrityResult,
  PePhase9StepOutcome,
} from './pe-phase-9-rehearsal.js';

export interface PePhase9Execution {
  headSha: string;
  mainSha: string;
  mergeBase: string;
  integrity: PePhase9IntegrityResult;
  outcomes: PePhase9StepOutcome[];
  baseComparisons: PePhase9BaseComparison[];
  gate: PePhase9GateResult;
}

export function pePhase9Evidence(scope: PePhase9Scope, execution: PePhase9Execution) {
  const { headSha, mainSha, mergeBase, integrity, outcomes, baseComparisons, gate } = execution;
  return {
    phase: 9,
    kind: scope === 'backend' ? 'backend_release_rehearsal' : 'integrated_release_rehearsal',
    ...(scope === 'backend'
      ? {
          scope: 'backend',
          excludedFrontendSteps: ['web_typecheck', 'web_build', 'web_pe_tests'],
          fullReleaseQualified: false,
        }
      : {}),
    headSha,
    mergeBase,
    mainSha,
    generatedAt: new Date().toISOString(),
    integrity,
    outcomes,
    baseComparisons,
    gate: {
      ok: gate.ok,
      blockers: gate.blockers,
      warnings: gate.warnings,
      classifications: gate.classifications,
    },
    extendedProofs: PE_PHASE_9_EXTENDED_PROOF_IDS.map((id) => ({
      id,
      ...PE_PHASE_9_EXTENDED_PROOF_OWNERS[id],
    })),
    note:
      scope === 'backend'
        ? 'PE_PHASE_9_BACKEND_OK covers the backend/shared rehearsal only. Web Phase H, frontend build/typecheck and independent REVIEW remain separate requirements. Synthetic goldens remain NOT human-reviewed.'
        : 'PE_PHASE_9_OK certifies the executable rehearsal harness only. Independent adversarial REVIEW is still required. Synthetic goldens remain NOT human-reviewed.',
  };
}
export function pePhase9EvidenceMarkdown(
  scope: PePhase9Scope,
  evidence: ReturnType<typeof pePhase9Evidence>,
): string {
  const { headSha, mainSha, mergeBase, outcomes, gate } = evidence;
  return [
    scope === 'backend'
      ? '# Phase 9 backend release rehearsal evidence'
      : '# Phase 9 integrated release rehearsal evidence',
    '',
    `- HEAD: \`${headSha}\``,
    `- merge-base: \`${mergeBase}\``,
    `- origin/main: \`${mainSha}\``,
    `- gate.ok: **${gate.ok}**`,
    `- generated: ${evidence.generatedAt}`,
    '',
    '## Blockers',
    gate.blockers.length ? gate.blockers.map((b) => `- ${b}`).join('\n') : '- (none)',
    '',
    '## Warnings / base-proven',
    gate.warnings.length ? gate.warnings.map((w) => `- ${w}`).join('\n') : '- (none)',
    '',
    '## Outcomes',
    ...outcomes.map(
      (o) =>
        `- \`${o.stepId}\` exit=${o.exitCode}${o.durationMs != null ? ` (${o.durationMs}ms)` : ''}`,
    ),
    '',
    ...(scope === 'backend'
      ? [
          '## Scope',
          '',
          '- Backend/shared checks only; web typecheck, build and Phase H are excluded.',
          '- This evidence does not qualify the full release.',
          '',
        ]
      : []),
    '## Honesty',
    '',
    '- This file is machine + implementer evidence, **not** independent REVIEW PASS.',
    '- Grounded-field goldens remain SYNTHETIC / NOT human-reviewed (Phase K6).',
    scope === 'backend'
      ? '- Database command targets require separate disposable qualification; no shared environment is authorized.'
      : '- No shared-env migrate/deploy/ingestion/email/LlamaParse/Secrets Manager in this phase.',
    '',
  ].join('\n');
}
