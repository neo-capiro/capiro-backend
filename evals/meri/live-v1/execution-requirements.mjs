const STANDARD_DEEP_CASES = new Set(['01', '20', '22', '42', '49', '51', '59', '74']);

const standardDeepMatrix = Object.freeze([
  Object.freeze({ runtimeMode: 'Standard', verificationMode: 'default', disposition: 'CAPTURE_OR_UNSUPPORTED' }),
  Object.freeze({ runtimeMode: 'Deep', verificationMode: 'default', disposition: 'CAPTURE_OR_UNSUPPORTED' }),
]);

const modePersistenceTransitions = Object.freeze([
  'mode_selected',
  'answer_captured',
  'mode_persisted_next_turn',
  'mode_persisted_after_reload',
]);

const requirements = {
  '25': {
    previousTurns: { required: true, anchorTurnOffset: 45, minimumPriorTurns: 45, largeAuthorizedToolOutputCount: 20, stablePointersRequired: true },
    injectedFaults: [],
    modeMatrix: [{ runtimeMode: 'Standard', verificationMode: 'default', disposition: 'CAPTURE_REQUIRED' }],
    requiredTransitions: ['early_constraint_recorded', 'conversation_compacted', 'constraint_restored', 'scoped_identity_resolved'],
  },
  '42': {
    previousTurns: { required: true, attachmentTurnOffset: 3, minimumPriorTurns: 3, compactBeforePrompt: true, stablePointersRequired: true },
    injectedFaults: [],
    modeMatrix: standardDeepMatrix,
    requiredTransitions: ['attachment_recorded', 'conversation_compacted', 'attachment_pointer_resolved', 'attachment_bytes_read'],
  },
  '56': {
    previousTurns: { required: false },
    injectedFaults: [{ id: 'jev-draft-incorrect-request', target: 'draft_claim', response: '$48M FY27 request', deterministic: true }],
    modeMatrix: [
      { runtimeMode: 'Standard', verificationMode: 'enabled-canary', disposition: 'CAPTURE_REQUIRED' },
      { runtimeMode: 'Standard', verificationMode: 'shadow', disposition: 'CAPTURE_REQUIRED' },
    ],
    requiredTransitions: ['incorrect_draft_detected', 'authoritative_passage_read', 'enabled_answer_repaired_before_stream', 'shadow_issue_recorded'],
  },
  '57': {
    previousTurns: { required: false },
    injectedFaults: [{ id: 'initial-unverified-award-metadata', target: 'award_metadata', response: 'unverified', deterministic: true }],
    modeMatrix: [
      { runtimeMode: 'Standard', verificationMode: 'enabled-canary', disposition: 'CAPTURE_REQUIRED' },
      { runtimeMode: 'Standard', verificationMode: 'shadow', disposition: 'CAPTURE_REQUIRED' },
    ],
    requiredTransitions: ['unverified_metadata_read', 'targeted_authority_fetch', 'award_verified', 'shadow_issue_recorded'],
  },
  '58': {
    previousTurns: { required: false },
    injectedFaults: [{ id: 'contradictory-draft-claim', target: 'draft_claim', response: 'unsupported contradictory finding', deterministic: true }],
    modeMatrix: [
      { runtimeMode: 'Standard', verificationMode: 'enabled-canary', disposition: 'CAPTURE_REQUIRED' },
      { runtimeMode: 'Standard', verificationMode: 'shadow', disposition: 'CAPTURE_REQUIRED' },
    ],
    requiredTransitions: ['supported_claims_preserved', 'contradiction_detected', 'affected_claim_repaired', 'shadow_issue_recorded'],
  },
  '71': {
    previousTurns: { required: true, anchorTurnOffset: 0, minimumPriorTurns: 0, largeAuthorizedToolOutputCount: 20, stablePointersRequired: true },
    injectedFaults: [{ id: 'external-adapter-429', target: 'first_external_adapter', response: '429 + Retry-After', repeated: true, deterministic: true }],
    modeMatrix: [{ runtimeMode: 'Deep', verificationMode: 'default', disposition: 'CAPTURE_REQUIRED' }],
    requiredTransitions: ['rate_limited', 'retry_after_honored', 'bounded_retry_terminal', 'provider_input_watermark_recorded'],
  },
  '72': {
    previousTurns: { required: false },
    injectedFaults: [{ id: 'logical-error-in-http-200', target: 'memo_adapter', response: "200 {error:'document unavailable'}", repeated: true, deterministic: true }],
    modeMatrix: [{ runtimeMode: 'Standard', verificationMode: 'default', disposition: 'CAPTURE_REQUIRED' }],
    requiredTransitions: ['http_200_received', 'logical_error_detected', 'no_progress_retry_suppressed', 'partial_or_failed_terminal'],
  },
  '73': {
    previousTurns: { required: true, anchorTurnOffset: 0, minimumPriorTurns: 0, completedReadCount: 1, stablePointersRequired: true },
    injectedFaults: [{ id: 'user-stop', target: 'active_research_run', response: 'accepted cancellation', deterministic: true }],
    modeMatrix: [{ runtimeMode: 'Deep', verificationMode: 'default', disposition: 'CAPTURE_REQUIRED' }],
    requiredTransitions: ['run_active', 'stop_accepted', 'calls_quiesced', 'cancelled_terminal'],
  },
  '74': {
    previousTurns: { required: true, anchorTurnOffset: 0, minimumPriorTurns: 0, completedReadCount: 2, totalReadCount: 4, stablePointersRequired: true },
    injectedFaults: [{ id: 'research-worker-kill', target: 'research_worker', response: 'terminated after two reads', deterministic: true }],
    modeMatrix: standardDeepMatrix,
    requiredTransitions: ['two_read_receipts_persisted', 'worker_terminated', 'same_run_resumed', 'remaining_reads_completed_once'],
  },
  '75': {
    previousTurns: { required: false },
    injectedFaults: [
      { id: 'provider-incomplete', target: 'first_provider_attempt', response: 'incomplete', deterministic: true },
      { id: 'malformed-tool-arguments', target: 'first_tool_call', response: 'malformed arguments', deterministic: true },
    ],
    modeMatrix: [{ runtimeMode: 'Standard', verificationMode: 'default', disposition: 'CAPTURE_REQUIRED' }],
    requiredTransitions: ['first_attempt_incomplete', 'invalid_tool_call_rejected', 'zero_tools_executed_for_invalid_call', 'bounded_second_attempt'],
  },
};

for (const caseId of STANDARD_DEEP_CASES) {
  const current = requirements[caseId] ?? {
    previousTurns: { required: false },
    injectedFaults: [],
    requiredTransitions: [],
  };
  requirements[caseId] = {
    ...current,
    modeMatrix: standardDeepMatrix,
    requiredTransitions: [...new Set([...(current.requiredTransitions ?? []), ...modePersistenceTransitions])],
  };
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

export const structuredExecutionRequirements = deepFreeze(requirements);
export const structuredExecutionCaseIds = Object.freeze(Object.keys(requirements).sort());
export const standardDeepCaseIds = Object.freeze([...STANDARD_DEEP_CASES]);
