import {
  createCase17WriteAccounting,
  inspectCase17WriteAccounting,
} from './case17-readonly-guard.mjs';

const ORIGIN = 'https://os.capiro.ai';
const CLERK = 'https://clerk.app.capiro.ai';

/** Preference writes are always denied. Only one exact approval may pass after
 * arming; unexpected writes invalidate arming and the final route decision. */
export function createCase14ApprovalWriteGuard(candidateId) {
  const accounting = createCase17WriteAccounting();
  let armed = false,
    submissions = 0;
  return Object.freeze({
    panelPhase: (phase) => accounting.panelPhase(phase),
    snapshot: () => ({ ...accounting.snapshot(), applicationApprovalSubmissions: submissions }),
    assertBeforeIntent() {
      inspectCase17WriteAccounting(accounting.snapshot());
      if (submissions !== 0) throw new Error('CASE14_APPROVAL_SUBMISSION_BOUND');
    },
    arm() {
      if (submissions !== 0 || armed) throw new Error('CASE14_APPROVAL_ARM');
      inspectCase17WriteAccounting(accounting.snapshot());
      armed = true;
    },
    disarm() {
      armed = false;
    },
    decide(request) {
      const url = new URL(request.url()),
        method = request.method();
      if (['GET', 'HEAD', 'OPTIONS'].includes(method) || url.origin === CLERK) return 'continue';
      if (
        armed &&
        submissions === 0 &&
        method === 'POST' &&
        url.origin === ORIGIN &&
        url.pathname === `/api/memory/review/candidates/${candidateId}/approve` &&
        !url.search &&
        !url.hash &&
        request.postData() === '{}'
      ) {
        armed = false;
        try {
          inspectCase17WriteAccounting(accounting.snapshot());
          submissions++;
          return 'continue';
        } catch {
          /* Deny rather than leave a rejected route handler hanging. */
        }
      }
      accounting.deny(request);
      return 'abort';
    },
  });
}

/** Accept historical zero-write evidence; new receipts must account for every
 * blocked request using the same bounded categories as the browser guard. */
export function inspectCase14WriteEvidence(evidence) {
  if (evidence?.applicationApprovalSubmissions !== 1 || evidence?.synthesisSubmissionCount !== 0)
    throw new Error('CASE14_APPROVAL_SUBMISSION_BOUND');
  if (
    !['blockedPreferenceWrites', 'blockedWriteRequests'].some((key) => Object.hasOwn(evidence, key))
  ) {
    if (evidence.blockedWrites !== 0) throw new Error('CASE14_APPROVAL_WRITE_ACCOUNTING');
    return true;
  }
  return inspectCase17WriteAccounting(evidence);
}
