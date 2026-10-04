import {
  createCase17WriteAccounting,
  inspectCase17WriteAccounting,
} from '../../../../../evidence/evals/meri/live-v1/case17-readonly-guard.mjs';

const ORIGIN = 'https://os.capiro.ai';
const CLERK = 'https://clerk.app.capiro.ai';

/** Route decision helper for the Case14 collector. Every write is denied except
 * the one exact approval request while armed; preference writes are only tallied. */
export function createCase14ApprovalWriteGuard(candidateId, accounting = createCase17WriteAccounting()) {
  let armed = false;
  let submissions = 0;
  const approvalPath = `/api/memory/review/candidates/${candidateId}/approve`;
  const snapshot = () => ({
    ...accounting.snapshot(),
    applicationApprovalSubmissions: submissions,
  });
  return Object.freeze({
    arm() {
      if (submissions !== 0 || armed) throw new Error('CASE14_APPROVAL_ARM');
      // Reject any already-seen unexpected write before creating intent/arming.
      inspectCase17WriteAccounting(accounting.snapshot());
      armed = true;
    },
    disarm() {
      armed = false;
    },
    panelPhase(phase) {
      accounting.panelPhase(phase);
    },
    decide(request) {
      const url = new URL(request.url());
      const method = request.method();
      if (['GET', 'HEAD', 'OPTIONS'].includes(method) || url.origin === CLERK)
        return 'continue';
      if (
        armed &&
        submissions === 0 &&
        method === 'POST' &&
        url.origin === ORIGIN &&
        url.pathname === approvalPath &&
        !url.search &&
        !url.hash &&
        request.postData() === '{}'
      ) {
        // A prior non-preference write or overbound preference count makes this
        // fail closed, before the approval request can reach the application.
        inspectCase17WriteAccounting(accounting.snapshot());
        submissions++;
        armed = false;
        return 'continue';
      }
      accounting.deny(request);
      return 'abort';
    },
    snapshot,
    assertBeforeIntent() {
      inspectCase17WriteAccounting(accounting.snapshot());
      if (submissions !== 0) throw new Error('CASE14_APPROVAL_SUBMISSION_BOUND');
    },
    validateEvidence(evidence) {
      if (
        evidence?.applicationApprovalSubmissions !== 1 ||
        evidence?.synthesisSubmissionCount !== 0
      ) throw new Error('CASE14_APPROVAL_SUBMISSION_BOUND');
      const hasAccounting = [
        'blockedPreferenceWrites',
        'blockedWriteRequests',
      ].some((key) => Object.hasOwn(evidence, key));
      if (!hasAccounting) {
        // Compatibility for historical evidence is strict: zero blocked writes
        // and no partial/bogus accounting fields.
        if (evidence.blockedWrites !== 0) throw new Error('CASE14_APPROVAL_WRITE_ACCOUNTING');
        return true;
      }
      inspectCase17WriteAccounting({
        blockedWrites: evidence.blockedWrites,
        blockedPreferenceWrites: evidence.blockedPreferenceWrites,
        blockedWriteRequests: evidence.blockedWriteRequests,
      });
      return true;
    },
  });
}

/** Include this bounded accounting object in approval, interruption and recall
 * UI evidence; it contains only the helper's fixed, redacted categories. */
export function case14WriteEvidence(guard) {
  const { applicationApprovalSubmissions, ...accounting } = guard.snapshot();
  return { ...accounting, applicationApprovalSubmissions };
}

export function inspectCase14WriteEvidence(evidence) {
  if (evidence?.applicationApprovalSubmissions !== 1 || evidence?.synthesisSubmissionCount !== 0)
    throw new Error('CASE14_APPROVAL_SUBMISSION_BOUND');
  const hasAccounting = ['blockedPreferenceWrites', 'blockedWriteRequests'].some((key) =>
    Object.hasOwn(evidence, key),
  );
  if (!hasAccounting) {
    if (evidence.blockedWrites !== 0) throw new Error('CASE14_APPROVAL_WRITE_ACCOUNTING');
    return true;
  }
  inspectCase17WriteAccounting({
    blockedWrites: evidence.blockedWrites,
    blockedPreferenceWrites: evidence.blockedPreferenceWrites,
    blockedWriteRequests: evidence.blockedWriteRequests,
  });
  return true;
}

export { inspectCase17WriteAccounting };
