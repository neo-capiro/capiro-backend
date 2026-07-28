import { randomUUID } from 'node:crypto';

export type GenerationRunStatus = 'complete' | 'complete_with_warnings' | 'partial' | 'failed';
export type GenerationSectionStatus = 'succeeded' | 'failed';
export type GenerationSnapshotStatus = 'created' | 'failed';

export interface GenerationSectionFailure {
  section: string;
  status: 'failed';
  errorCode:
    | 'credential_unavailable'
    | 'provider_timeout'
    | 'provider_rate_limited'
    | 'provider_unavailable'
    | 'invalid_response'
    | 'persistence_failed'
    | 'unknown';
  message: string;
  /** Existing section content was intentionally retained rather than relabeled as new. */
  staleContentPreserved: boolean;
}

export interface GenerationSectionSuccess {
  section: string;
  status: 'succeeded';
  contentChars: number;
}

export type GenerationSectionResult = GenerationSectionSuccess | GenerationSectionFailure;

export interface InvalidGenerationCitation {
  section: string;
  token: string;
}

export interface GenerationRunSummary {
  id: string;
  status: GenerationRunStatus;
  requestedSections: string[];
  succeededSections: string[];
  failedSections: GenerationSectionFailure[];
  sectionResults: GenerationSectionResult[];
  invalidCitations: InvalidGenerationCitation[];
  structuralFindings: unknown[];
  groundingFindings: unknown[];
  provider: 'anthropic';
  model: string;
  credentialSource: 'tenant' | 'platform';
  contextPacketId: string | null;
  contextTraceHash: string | null;
  contextDegraded: boolean;
  snapshot: {
    status: GenerationSnapshotStatus;
    versionId: string | null;
    errorCode?: 'snapshot_persistence_failed';
  };
  startedAt: string;
  completedAt: string;
  retryOfRunId: string | null;
}

export interface GenerationRunDraft {
  id?: string;
  requestedSections: string[];
  sectionResults: GenerationSectionResult[];
  invalidCitations?: InvalidGenerationCitation[];
  structuralFindings?: unknown[];
  groundingFindings?: unknown[];
  provider?: 'anthropic';
  model: string;
  credentialSource: 'tenant' | 'platform';
  contextPacketId?: string | null;
  contextTraceHash?: string | null;
  contextDegraded?: boolean;
  snapshot: GenerationRunSummary['snapshot'];
  startedAt: string;
  completedAt: string;
  retryOfRunId?: string | null;
}

export function finalizeGenerationRun(input: GenerationRunDraft): GenerationRunSummary {
  const failedSections = input.sectionResults.filter(
    (result): result is GenerationSectionFailure => result.status === 'failed',
  );
  const succeededSections = input.sectionResults
    .filter((result): result is GenerationSectionSuccess => result.status === 'succeeded')
    .map((result) => result.section);
  const warningCount =
    (input.invalidCitations?.length ?? 0) +
    (input.structuralFindings?.length ?? 0) +
    (input.groundingFindings?.length ?? 0) +
    (input.contextDegraded ? 1 : 0) +
    (input.snapshot.status === 'failed' ? 1 : 0);

  const status: GenerationRunStatus = failedSections.length
    ? succeededSections.length
      ? 'partial'
      : 'failed'
    : warningCount
      ? 'complete_with_warnings'
      : 'complete';

  return {
    id: input.id ?? randomUUID(),
    status,
    requestedSections: [...input.requestedSections],
    succeededSections,
    failedSections,
    sectionResults: [...input.sectionResults],
    invalidCitations: [...(input.invalidCitations ?? [])],
    structuralFindings: [...(input.structuralFindings ?? [])],
    groundingFindings: [...(input.groundingFindings ?? [])],
    provider: input.provider ?? 'anthropic',
    model: input.model,
    credentialSource: input.credentialSource,
    contextPacketId: input.contextPacketId ?? null,
    contextTraceHash: input.contextTraceHash ?? null,
    contextDegraded: input.contextDegraded ?? false,
    snapshot: input.snapshot,
    startedAt: input.startedAt,
    completedAt: input.completedAt,
    retryOfRunId: input.retryOfRunId ?? null,
  };
}

/** Bounded, non-secret error projection for persisted run telemetry. */
export function generationFailure(section: string, error: unknown): GenerationSectionFailure {
  const raw = error instanceof Error ? error.message : '';
  const normalized = raw.toLowerCase();
  const errorCode: GenerationSectionFailure['errorCode'] = normalized.includes('credential')
    ? 'credential_unavailable'
    : normalized.includes('timeout') || normalized.includes('abort')
      ? 'provider_timeout'
      : normalized.includes('429') || normalized.includes('rate limit')
        ? 'provider_rate_limited'
        : normalized.includes('503') || normalized.includes('unavailable')
          ? 'provider_unavailable'
          : normalized.includes('invalid') || normalized.includes('empty response')
            ? 'invalid_response'
            : normalized.includes('persist') || normalized.includes('database')
              ? 'persistence_failed'
              : 'unknown';
  const messages: Record<GenerationSectionFailure['errorCode'], string> = {
    credential_unavailable: 'No usable generation credential was available.',
    provider_timeout: 'The model provider did not respond before the generation deadline.',
    provider_rate_limited: 'The model provider rate-limited this section.',
    provider_unavailable: 'The model provider was temporarily unavailable.',
    invalid_response: 'The model response could not be validated as section content.',
    persistence_failed: 'The generated section could not be saved durably.',
    unknown: 'This section could not be generated.',
  };
  return {
    section,
    status: 'failed',
    errorCode,
    message: messages[errorCode].slice(0, 240),
    staleContentPreserved: true,
  };
}

export function failedSectionNames(run: GenerationRunSummary | null | undefined): string[] {
  if (!run) return [];
  return run.failedSections.map((failure) => failure.section);
}
