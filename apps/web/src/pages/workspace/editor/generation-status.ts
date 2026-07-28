/**
 * How a generation run should be REPORTED to the user.
 *
 * Split out from the editor so the honesty rules are testable without a DOM: a
 * run that failed sections is never announced as a success, retained pre-failure
 * content is never announced as newly generated, and "Retry failed sections" is
 * offered exactly when there is something to retry.
 */
import type { WsGenerationRun, WsSectionMeta } from '../types.js';

export type GenerationTone = 'success' | 'warning' | 'error';

export interface GenerationReport {
  tone: GenerationTone;
  /** Transient toast text. */
  toast: string;
  /** True when a persistent banner must stay on screen until resolved. */
  persistent: boolean;
  /** Banner headline; empty when nothing needs to persist. */
  headline: string;
  detail: string;
  failedSections: string[];
  canRetryFailed: boolean;
  /** Sections whose visible content predates the failed attempt. */
  staleSections: string[];
}

const EMPTY: GenerationReport = {
  tone: 'success',
  toast: '',
  persistent: false,
  headline: '',
  detail: '',
  failedSections: [],
  canRetryFailed: false,
  staleSections: [],
};

function list(names: readonly string[]): string {
  if (names.length <= 3) return names.join(', ');
  return `${names.slice(0, 3).join(', ')} and ${names.length - 3} more`;
}

export function describeGenerationRun(run: WsGenerationRun | null | undefined): GenerationReport {
  if (!run) return EMPTY;
  const failedSections = run.failedSections.map((failure) => failure.section);
  const staleSections = run.failedSections
    .filter((failure) => failure.staleContentPreserved)
    .map((failure) => failure.section);
  const retried = run.retryOfRunId != null;

  if (run.status === 'failed') {
    return {
      tone: 'error',
      toast: `No section could be generated (${failedSections.length} failed).`,
      persistent: true,
      headline: 'Nothing was generated',
      detail:
        `Meri could not draft ${failedSections.length === 1 ? 'the requested section' : `any of the ${failedSections.length} requested sections`}: ` +
        `${list(failedSections)}. Existing content was left as it was.`,
      failedSections,
      canRetryFailed: failedSections.length > 0,
      staleSections,
    };
  }

  if (run.status === 'partial') {
    return {
      tone: 'error',
      toast: `${run.succeededSections.length} section(s) drafted, ${failedSections.length} failed.`,
      persistent: true,
      headline: `${failedSections.length} section${failedSections.length === 1 ? '' : 's'} could not be generated`,
      detail:
        `Drafted: ${list(run.succeededSections) || 'none'}. Failed: ${list(failedSections)}. ` +
        (staleSections.length
          ? 'The previous content of the failed sections is still shown and is marked as not regenerated.'
          : 'The failed sections were left empty.'),
      failedSections,
      canRetryFailed: true,
      staleSections,
    };
  }

  if (run.status === 'complete_with_warnings') {
    const warnings: string[] = [];
    if (run.snapshot.status === 'failed') {
      warnings.push('the "As generated" version snapshot could not be saved');
    }
    if (run.invalidCitations.length) {
      warnings.push(
        `${run.invalidCitations.length} citation token${run.invalidCitations.length === 1 ? '' : 's'} did not resolve and were removed`,
      );
    }
    if (run.contextDegraded) warnings.push('some approved context could not be applied');
    if (run.structuralFindings.length || run.groundingFindings.length) {
      warnings.push('the grounding checks raised findings to review');
    }
    return {
      tone: 'warning',
      toast: 'Drafted with warnings — review the checks.',
      persistent: true,
      headline: `${retried ? 'Retry' : 'Draft'} completed with warnings`,
      detail: warnings.length
        ? `Every requested section was drafted, but ${warnings.join('; ')}.`
        : 'Every requested section was drafted, but the run reported warnings to review.',
      failedSections: [],
      canRetryFailed: false,
      staleSections,
    };
  }

  return {
    ...EMPTY,
    toast: retried
      ? `Meri re-drafted ${run.succeededSections.length} previously failed section${run.succeededSections.length === 1 ? '' : 's'}.`
      : 'Meri drafted the document',
  };
}

/** True when this section's visible content predates a failed regeneration. */
export function isStaleSection(meta: WsSectionMeta | undefined): boolean {
  return meta?.generationStatus === 'failed' && meta?.stale === true;
}

/** Short, non-secret explanation for a stale section badge. */
export function staleSectionReason(meta: WsSectionMeta | undefined): string {
  if (!isStaleSection(meta)) return '';
  return (
    meta?.lastGenerationError?.message ??
    'The last attempt to regenerate this section failed; the previous content is still shown.'
  );
}
