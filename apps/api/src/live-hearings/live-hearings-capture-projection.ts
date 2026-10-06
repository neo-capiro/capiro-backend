/** Display-only projection. Scheduling and worker permission gates remain authoritative. */
export interface CaptureResolutionProjectionInput {
  resolutionCapturePolicy?: string | null;
  resolutionState?: string | null;
  lastResolutionAt?: Date | null;
  selectedStreamCandidateId?: string | null;
}

interface CandidateProjectionInput {
  id?: string;
  capturePolicy: string;
  resolutionState: string;
  lastProbeAt?: Date | null;
  expiresAt?: Date | null;
}

const RESTRICTIVE_POLICIES = new Set(['LICENSE_REQUIRED', 'BROWSER_CAPTURE_ONLY', 'BLOCKED']);

export function projectCaptureResolution(
  capture: CaptureResolutionProjectionInput | null,
  candidates: CandidateProjectionInput[],
  now = new Date(),
): { capturePolicy: string | null; streamState: string } {
  const streamState = capture?.resolutionState || 'NOT_CHECKED';
  const policy = capture?.resolutionCapturePolicy;
  if (policy && RESTRICTIVE_POLICIES.has(policy)) return { capturePolicy: policy, streamState };

  // Never turn an advertised candidate or pending capture into permission.
  // Persisted worker approval also cannot outlive its selected media expiry or
  // a newer probe restricting an advertised source.
  const resolvedAt = capture?.lastResolutionAt?.getTime();
  const selected = candidates.find(
    (candidate) => candidate.id === capture?.selectedStreamCandidateId,
  );
  const selectedMissing = Boolean(capture?.selectedStreamCandidateId && !selected);
  const selectedExpired = selected?.expiresAt && selected.expiresAt.getTime() <= now.getTime();
  const newerRestriction = candidates.some(
    (candidate) =>
      RESTRICTIVE_POLICIES.has(candidate.capturePolicy) &&
      candidate.lastProbeAt &&
      (!resolvedAt || candidate.lastProbeAt.getTime() > resolvedAt),
  );
  if (
    policy === 'SERVER_CAPTURE_ALLOWED' &&
    resolvedAt &&
    !selectedMissing &&
    !selectedExpired &&
    !newerRestriction
  ) {
    return { capturePolicy: policy, streamState };
  }

  // Match the attendance policy's restrictive precedence only when every
  // candidate is explicitly restrictive. Mixed or unresolved evidence remains
  // pending; this fallback can never approve unattended recording.
  if (
    candidates.length &&
    candidates.every((candidate) => RESTRICTIVE_POLICIES.has(candidate.capturePolicy))
  ) {
    for (const restrictive of ['LICENSE_REQUIRED', 'BROWSER_CAPTURE_ONLY', 'BLOCKED']) {
      const candidate = candidates.find((row) => row.capturePolicy === restrictive);
      if (candidate)
        return {
          capturePolicy: restrictive,
          streamState: candidate.resolutionState || streamState,
        };
    }
  }
  return { capturePolicy: policy === 'REVIEW_REQUIRED' ? policy : null, streamState };
}
