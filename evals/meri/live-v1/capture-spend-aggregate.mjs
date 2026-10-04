import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256Stable } from './artifact-collector.mjs';
import { currentControlledReadCaptureAuthority } from './controlled-read-live-capture.mjs';
import { currentCase46CaptureAuthority } from './case46-live-capture.mjs';
import {
  CASE01_TERMINAL_SCOPE,
  currentOriginalCase01TerminalClosure,
} from './case01-terminal-spend-authority.mjs';
import { currentMemoryReadUsageAuthority } from './memory-read-budget-authority.mjs';
import { currentReviewedCaptureSpendReconciliation } from './capture-spend-reconciliation.mjs';
import { consumeCase01PresubmissionRecoveryAuthority } from './case01-presubmission-recovery-authority.mjs';
import { consumeCase20PresubmissionRecoveryAuthority } from './case20-presubmission-recovery-authority.mjs';
import { consumeCase01FailedReceiptCostAuthority } from './case01-failed-receipt-cost-authority.mjs';
import { consumeCase20TerminalCostAuthority } from './case20-terminal-cost-authority.mjs';
import { currentCase14ApprovalAuthority } from './case14-approval-capture.mjs';
import {
  consumeCase14ApprovalCostAuthority,
  assertCase14ApprovalCostAuthority,
  refreshCase14ApprovalCostAuthority,
} from './case14-approval-cost-authority.mjs';
import { currentCase14PostApprovalTaskAuthority } from './case14-postapproval-task-authority.mjs';
import {
  currentCase01CaptureAuthority,
  currentCase14RecallAuthority,
} from './case01-live-capture.mjs';

const helper = fileURLToPath(new URL('./lib/windows-capture-spend.py', import.meta.url));
const reservations = new WeakMap();
const freshRoot = 'C:/dev/main/outputs/meri-fresh-20261003';
const need = (condition) => {
  if (!condition) throw new Error('CAPTURE_SPEND_AGGREGATE_REJECTED');
};

function native(root, pythonExecutable, request) {
  need(process.platform === 'win32' && isAbsolute(root) && isAbsolute(pythonExecutable));
  const result = spawnSync(pythonExecutable, ['-I', helper], {
    input: JSON.stringify({ ...request, root: resolve(root) }),
    encoding: 'utf8',
    windowsHide: true,
    shell: false,
    timeout: 15000,
    maxBuffer: 2 * 1024 * 1024,
  });
  need(!result.error && result.status === 0);
  const value = JSON.parse(result.stdout);
  need(value.ok === true && value.state?.root === resolve(root));
  return value;
}

const checkpoint = (value) =>
  Object.freeze({
    kind:
      value.state?.freshVersion === 1
        ? 'meri-fresh-capture-spend-checkpoint'
        : 'meri-original-capture-spend-checkpoint',
    version: 1,
    state: structuredClone(value.state),
    snapshot: structuredClone(value.snapshot),
  });

/** Explicit local setup only. The root operator must review the actual prior-run
 * inventory and slice boundary first. Never automatically start a fresh ledger
 * when another ledger is full, uncertain, or missing its last checkpoint. */
export function initializeCaptureSpendAggregate({ root, inventory, pythonExecutable }) {
  return checkpoint(native(root, pythonExecutable, { op: 'init', inventory }));
}

/** Adopt only the existing pinned, fully settled fresh journal. This reads no
 * replacement ledger and creates no files. Future opens require its exact checkpoint. */
export function adoptExistingFreshCaptureSpend({ pythonExecutable }) {
  return checkpoint(native(freshRoot, pythonExecutable, { op: 'fresh_adopt' }));
}

/** Cost-only closure of the exact failed stream. It cannot grade or replay it. */
export function reconcileCase01FailedReceiptCost(authority, { pythonExecutable, invocation }) {
  need(invocation === 'RECONCILE_FAILED_CASE01_PROVIDER_COST_ONCE');
  const { proof, checkpoint: prior } = consumeCase01FailedReceiptCostAuthority(authority);
  need(
    prior.kind === 'meri-fresh-capture-spend-checkpoint' && prior.state.root === resolve(freshRoot),
  );
  return checkpoint(
    native(freshRoot, pythonExecutable, {
      op: 'fresh_reconcile_terminal',
      state: prior.state,
      event: {
        kind: 'reconcile_terminal',
        caseId: proof.caseId,
        captureRunId: proof.captureRunId,
        reservationId: proof.reservationId,
        proof,
      },
    }),
  );
}

/** Exact Case20 event24 cost closure; preserves its failed capture and claims. */
export function reconcileCase20TerminalCost(authority, { pythonExecutable, invocation }) {
  need(invocation === 'RECONCILE_FAILED_CASE20_PROVIDER_COST_ONCE');
  const { proof, checkpoint: prior } = consumeCase20TerminalCostAuthority(authority);
  need(
    prior.kind === 'meri-fresh-capture-spend-checkpoint' && prior.state.root === resolve(freshRoot),
  );
  return checkpoint(
    native(freshRoot, pythonExecutable, {
      op: 'fresh_reconcile_terminal',
      state: prior.state,
      event: {
        kind: 'reconcile_terminal',
        caseId: proof.caseId,
        captureRunId: proof.captureRunId,
        reservationId: proof.reservationId,
        proof,
      },
    }),
  );
}

/** A trusted operator passes the pinned last checkpoint, not model/user content.
 * Native handles fence identity/content/entry-set changes and concurrent writers.
 * Legacy ceilings remain consumed. Protocol v2 releases a NEW reservation's
 * unused ceiling only through the existing server-authoritative settlement. */
export function openCaptureSpendAggregate(prior, { pythonExecutable }) {
  return openCaptureSpendOwner(prior, { pythonExecutable });
}

/** Recover only the independently authenticated, exclusively claimed original
 * pre-submission failure. No reserve/adopt/settle is performed by restoration. */
export function restoreCase01PresubmissionCaptureSpend(
  authority,
  { pythonExecutable, invocation },
) {
  need(invocation === 'RESTORE_SAME_CASE01_UNSUBMITTED_RESERVATION_ONCE');
  const recovery = consumeCase01PresubmissionRecoveryAuthority(authority);
  return openCaptureSpendOwner(recovery.checkpoint, { pythonExecutable }, recovery);
}

/** Restore only the separately authenticated, fixed Case20 pre-submission failure. */
export function restoreCase20PresubmissionCaptureSpend(
  authority,
  { pythonExecutable, invocation },
) {
  need(invocation === 'RESTORE_SAME_CASE20_UNSUBMITTED_RESERVATION_ONCE');
  const recovery = consumeCase20PresubmissionRecoveryAuthority(authority);
  return openCaptureSpendOwner(recovery.checkpoint, { pythonExecutable }, recovery);
}

function openCaptureSpendOwner(prior, { pythonExecutable }, recovery = null) {
  const fresh = prior?.kind === 'meri-fresh-capture-spend-checkpoint';
  need((fresh || prior?.kind === 'meri-original-capture-spend-checkpoint') && prior.version === 1);
  const root = prior.state?.root;
  need(
    fresh
      ? root === resolve(freshRoot) && prior.state.freshVersion === 1
      : !prior.state?.freshVersion,
  );
  const operation = (op) => (fresh ? `fresh_${op}` : op);
  let value = native(root, pythonExecutable, { op: operation('read'), state: prior.state });
  if (recovery) {
    const key = `${recovery.reservation.caseId}:${recovery.reservation.captureRunId}`;
    need(
      fresh &&
        value.snapshot.activeRun === key &&
        value.snapshot.runs[key]?.reservationId === recovery.reservation.reservationId &&
        value.snapshot.runs[key]?.ceilingMicros === recovery.reservation.ceilingMicros &&
        sha256Stable(value.state) === sha256Stable(prior.state) &&
        sha256Stable(value.snapshot) === sha256Stable(prior.snapshot),
    );
    recovery.assertOwned();
  } else if (fresh) need(value.snapshot.activeRun === null);
  let poisoned = false;
  const advance = (op, event) => {
    need(!poisoned);
    try {
      value = native(root, pythonExecutable, { op: operation(op), event, state: value.state });
      return checkpoint(value);
    } catch {
      poisoned = true;
      throw new Error('CAPTURE_SPEND_AGGREGATE_REJECTED');
    }
  };
  const capabilityFor = (event, approval = null) => {
    const { caseId, captureRunId, ceilingMicros, reservationId } = event;
    const capability = Object.freeze({
      caseId,
      captureRunId,
      ceilingMicros: approval ? event.recallCeilingMicros : ceilingMicros,
      reservationId,
      ...(approval
        ? {
            combinedCeilingMicros: ceilingMicros,
            approvalCeilingMicros: event.approvalCeilingMicros,
            approvalBoundSha256: event.approvalBoundSha256,
            deadlineAtMs: approval.proof.deadlineAtMs,
          }
        : {}),
    });
    reservations.set(capability, {
      owner,
      approval,
      settled: false,
      expected: null,
      requiredExpected: recovery ? sha256Stable(recovery.expected) : null,
      assertSubmission: recovery?.assertSubmission,
      recheck() {
        recovery?.assertOwned();
        const current = advance('read');
        const key = `${caseId}:${captureRunId}`;
        need(
          current.snapshot.activeRun === key &&
            current.snapshot.runs[key]?.reservationId === reservationId,
        );
      },
    });
    return capability;
  };
  const owner = Object.freeze({
    checkpoint: () => checkpoint(value),
    reserve({ caseId, captureRunId, ceilingMicros }) {
      need(!recovery);
      // Fresh14 has a mandatory preapproval envelope; generic recall-only
      // reservations cannot pay for its ordinary approval provider work.
      if (fresh) need(['01', '20'].includes(caseId));
      const event = {
        kind: 'reserve',
        caseId,
        captureRunId,
        ceilingMicros,
        reservationId: randomUUID(),
      };
      advance('reserve', event);
      return capabilityFor(event);
    },
    reserveCase14Approval({ captureRunId, costAuthority }) {
      need(fresh && !recovery && !poisoned);
      const proof = consumeCase14ApprovalCostAuthority(costAuthority, captureRunId);
      const event = {
        kind: 'reserve',
        caseId: '14',
        captureRunId,
        ceilingMicros: 15000000,
        approvalCeilingMicros: 1000000,
        recallCeilingMicros: 14000000,
        approvalBoundSha256: proof.approvalBoundSha256,
        reservationId: randomUUID(),
      };
      advance('reserve', event);
      return capabilityFor(event, {
        proof,
        costAuthority,
        claimed: false,
        submitted: false,
        outcome: null,
        projectionTerminal: null,
      });
    },
    settleCaptured(reservation, outcome) {
      const binding = reservations.get(reservation);
      need(binding?.owner === owner && !binding.settled && binding.expected);
      binding.recheck();
      if (reservation.caseId === '46') {
        // Distinct governed-write authority; never manufacture a read-only envelope.
        const authority = currentCase46CaptureAuthority(outcome);
        const { expected, inputs } = authority.evidence;
        const usage = inputs.after.providerUsage;
        need(
          sha256Stable(expected) === binding.expected &&
            expected.caseId === '46' &&
            expected.captureRunId === reservation.captureRunId &&
            expected.maxSpendMicros === reservation.ceilingMicros &&
            usage.kind === 'governed_artifact_provider_usage' &&
            usage.caseId === '46' &&
            usage.captureRunId === reservation.captureRunId &&
            usage.allAttemptsSettled === true &&
            Number.isSafeInteger(usage.costMicros) &&
            usage.costMicros >= 0 &&
            usage.costMicros <= reservation.ceilingMicros,
        );
        const result = advance('settle', {
          kind: 'settle',
          caseId: '46',
          captureRunId: reservation.captureRunId,
          reservationId: reservation.reservationId,
          chargedCostMicros: usage.costMicros,
          ledgerSha256: usage.ledgerSha256,
          envelopeSha256: sha256Stable(inputs.after),
        });
        binding.settled = true;
        return result;
      }
      const authority =
        reservation.caseId === '01'
          ? currentCase01CaptureAuthority(outcome)
          : reservation.caseId === '14'
            ? currentCase14RecallAuthority(outcome)
            : currentControlledReadCaptureAuthority(outcome);
      const inputs = authority.evidence.inputs;
      const { assistantMessageId: _assistantMessageId, ...expected } = inputs.expected;
      need(sha256Stable(expected) === binding.expected);
      const receipt = inputs.envelope.receipt;
      const budget = receipt.providerBudget;
      if (binding.approval) {
        need(
          binding.approval.submitted &&
            binding.approval.outcome &&
            binding.approval.projectionTerminal,
        );
        const approved = currentCase14ApprovalAuthority(binding.approval.outcome);
        need(approved.captureRunId === reservation.captureRunId);
      }
      need(
        receipt.caseId === reservation.caseId &&
          receipt.captureRunId === reservation.captureRunId &&
          inputs.expected.caseId === reservation.caseId &&
          inputs.expected.captureRunId === reservation.captureRunId &&
          budget.status === 'SETTLED' &&
          budget.maxCostMicros === reservation.ceilingMicros &&
          budget.unaccountedBoundaries.length === 0 &&
          Number.isSafeInteger(budget.chargedCostMicros) &&
          budget.chargedCostMicros >= 0 &&
          budget.chargedCostMicros <= reservation.ceilingMicros,
      );
      const result = advance('settle', {
        kind: 'settle',
        caseId: reservation.caseId,
        captureRunId: reservation.captureRunId,
        reservationId: reservation.reservationId,
        chargedCostMicros: budget.chargedCostMicros,
        ledgerSha256: budget.ledgerSha256,
        envelopeSha256: sha256Stable(inputs.envelope),
        ...(binding.approval
          ? {
              conservativeApprovalCostMicros: 1000000,
              approvalBoundSha256: reservation.approvalBoundSha256,
              approvalOutcomeSha256: sha256Stable(
                currentCase14ApprovalAuthority(binding.approval.outcome),
              ),
              projectionTerminalSha256: binding.approval.projectionTerminal,
            }
          : {}),
      });
      binding.settled = true;
      return result;
    },
    settleMemoryRead(reservation, authority) {
      need(!fresh);
      const binding = reservations.get(reservation);
      need(binding?.owner === owner && !binding.settled && binding.expected);
      binding.recheck();
      need(
        value.snapshot.protocolVersion === 2 &&
          ['01', '02', '03', '04', '05'].includes(reservation.caseId),
      );
      const proof = currentMemoryReadUsageAuthority(authority);
      need(
        proof.caseId === reservation.caseId &&
          proof.captureRunId === reservation.captureRunId &&
          proof.reservationId === reservation.reservationId &&
          proof.chargedCostMicros <= reservation.ceilingMicros &&
          proof.expectedSha256 === binding.expected,
      );
      const result = advance('settle', {
        kind: 'settle',
        caseId: proof.caseId,
        captureRunId: proof.captureRunId,
        reservationId: proof.reservationId,
        chargedCostMicros: proof.chargedCostMicros,
        ledgerSha256: proof.ledgerSha256,
        envelopeSha256: proof.envelopeSha256,
      });
      binding.settled = true;
      return result;
    },
  });
  return recovery
    ? Object.freeze({ owner, reservation: capabilityFor(recovery.reservation) })
    : owner;
}

/** Explicit root-only disposition of the one rejected original01 request.
 * Full ceiling stays consumed, actual billing remains UNKNOWN, and the old run
 * cannot be reserved/claimed/settled again. This does not submit a new request. */
export function closeOriginalCase01TerminalUncertain(
  prior,
  { pythonExecutable, authority, invocation },
) {
  need(invocation === 'CLOSE_ORIGINAL01_TERMINAL_COST_UNKNOWN_ONCE');
  need(prior?.kind === 'meri-original-capture-spend-checkpoint' && prior.version === 1);
  const proof = currentOriginalCase01TerminalClosure(authority);
  const scope = CASE01_TERMINAL_SCOPE;
  const value = native(prior.state.root, pythonExecutable, {
    op: 'close_terminal_uncertain',
    state: prior.state,
    event: {
      kind: 'close_terminal_uncertain',
      caseId: scope.caseId,
      captureRunId: scope.captureRunId,
      reservationId: scope.reservationId,
      disposition: 'TERMINAL_SETUP_REJECTION_COST_UNKNOWN',
      actualCostMicros: null,
      proof,
    },
  });
  return checkpoint(value);
}

/** Explicit reviewed root operation, never automatic initialization or upgrade.
 * Old entries/UNKNOWN charges remain immutable; one journal still owns all runs. */
export function reviseCaptureSpendProtocol(
  prior,
  { pythonExecutable, invocation, reviewSha256, deadlineAtMs },
) {
  need(invocation === 'ACTIVATE_SHARED_SPEND_V2_SERVER_SETTLEMENT_ONCE');
  need(prior?.kind === 'meri-original-capture-spend-checkpoint' && prior.version === 1);
  need(/^[a-f0-9]{64}$/.test(reviewSha256));
  const value = native(prior.state.root, pythonExecutable, {
    op: 'revise_protocol',
    state: prior.state,
    event: {
      kind: 'revise_protocol',
      protocolVersion: 2,
      maxCostMicros: 30000000,
      perCaseMaxCostMicros: 15000000,
      concurrency: 1,
      settlementAuthority: 'server_settled_provider_ledger',
      uncertainDisposition: 'full_ceiling_no_refund',
      reviewSha256,
      activatedAtMs: Date.now(),
      deadlineAtMs,
    },
  });
  return checkpoint(value);
}

/** Root-only recovery of the currently active run, without re-creating a lost
 * reservation capability, grading the answer, or sending another request. */
export function reconcileCaptureSpendTerminal(prior, { pythonExecutable, authority, invocation }) {
  need(invocation === 'RECONCILE_ACTIVE_TERMINAL_SPEND_ONCE');
  need(prior?.kind === 'meri-original-capture-spend-checkpoint' && prior.version === 1);
  const p = currentReviewedCaptureSpendReconciliation(authority);
  const current = native(prior.state.root, pythonExecutable, { op: 'read', state: prior.state });
  const key = `${p.caseId}:${p.captureRunId}`,
    row = current.snapshot.runs[key];
  need(
    current.snapshot.activeRun === key &&
      row?.reservationId === p.reservationId &&
      row.ceilingMicros === p.ceilingMicros,
  );
  const value = native(prior.state.root, pythonExecutable, {
    op: 'reconcile_terminal',
    state: current.state,
    event: {
      kind: 'reconcile_terminal',
      caseId: p.caseId,
      captureRunId: p.captureRunId,
      reservationId: p.reservationId,
      disposition: p.disposition,
      chargedCostMicros: p.chargedCostMicros,
      proof: {
        readbackSha256: p.readbackSha256,
        ledgerSha256: p.ledgerSha256,
        envelopeSha256: p.envelopeSha256,
        conversationId: p.conversationId,
        completedAtMs: p.completedAtMs,
        observedAtMs: p.observedAtMs,
        providerDeadlineAtMs: p.providerDeadlineAtMs,
        pendingProviderAttempts: p.pendingProviderAttempts,
        providerAttempts: p.providerAttempts,
        answerGrade: 'NOT_EVALUATED',
      },
    },
  });
  return checkpoint(value);
}

/** One native collector may claim one reservation. JSON lookalikes and a second
 * conversation/session cannot reuse it, even before the first provider call. */
export function claimCaptureSpendReservation(reservation, expected) {
  const binding = reservations.get(reservation);
  need(
    binding &&
      !binding.settled &&
      binding.expected === null &&
      expected.caseId === reservation.caseId &&
      expected.captureRunId === reservation.captureRunId &&
      expected.maxSpendMicros === reservation.ceilingMicros,
  );
  if (binding.approval)
    need(
      binding.approval.outcome &&
        binding.approval.projectionTerminal &&
        binding.approval.submitted &&
        Date.now() < binding.approval.proof.deadlineAtMs,
    );
  need(binding.requiredExpected === null || binding.requiredExpected === sha256Stable(expected));
  binding.recheck();
  binding.expected = sha256Stable(expected);
}

/** Same process approval gate. Copying the reservation/config cannot create or
 * restore this single submission claim; the full combined hold already exists. */
export function claimCase14ApprovalSpendReservation(reservation, config, candidateId) {
  const b = reservations.get(reservation),
    a = b?.approval;
  need(
    a &&
      !b.settled &&
      !a.claimed &&
      config.caseId === '14' &&
      config.captureRunId === reservation.captureRunId &&
      sha256Stable(config) === a.proof.scopeSha256 &&
      candidateId === a.proof.candidateId,
  );
  b.recheck();
  a.claimed = true;
}

export async function refreshCase14ApprovalSpendReservation(reservation) {
  const b = reservations.get(reservation),
    a = b?.approval;
  need(a && a.claimed && !a.submitted && !b.settled);
  b.recheck();
  await refreshCase14ApprovalCostAuthority(a.costAuthority);
}

export function assertCase14ApprovalSpendReservation(reservation, { submit = false } = {}) {
  const b = reservations.get(reservation),
    a = b?.approval;
  need(a && a.claimed && !a.submitted && !b.settled);
  b.recheck();
  assertCase14ApprovalCostAuthority(a.costAuthority);
  if (submit) a.submitted = true;
}

export function bindCase14ApprovalSpendOutcome(reservation, outcome) {
  const b = reservations.get(reservation),
    a = b?.approval;
  need(a && a.submitted && !a.outcome && !b.settled);
  const evidence = currentCase14ApprovalAuthority(outcome);
  need(
    evidence.captureRunId === reservation.captureRunId &&
      evidence.after.fixtureEvidence.candidateId === a.proof.candidateId &&
      evidence.after.fixtureEvidence.recipeSha256 === a.proof.recipeSha256,
  );
  b.recheck();
  a.outcome = outcome;
}

/** Gate the trusted native setup dispatcher, before it performs cloud writes.
 * A serialized outcome or reservation cannot authorize another native setup. */
export function claimCase14PostApprovalSetup(reservation, outcome) {
  const b = reservations.get(reservation),
    a = b?.approval;
  need(
    a &&
      a.outcome === outcome &&
      !a.postApprovalClaimed &&
      !b.settled &&
      Date.now() < a.proof.deadlineAtMs,
  );
  currentCase14ApprovalAuthority(outcome);
  b.recheck();
  a.postApprovalClaimed = true;
  a.dispatch = {
    registrationMarker: randomUUID(),
    startedBy: 'meri-c2-receipt-' + randomUUID().slice(0, 18),
  };
  return currentCase14PostApprovalSpendScope(reservation, outcome);
}
export function bindCase14PostApprovalDispatch(reservation, outcome, dispatch) {
  currentCase14PostApprovalSpendScope(reservation, outcome);
  const a = reservations.get(reservation).approval;
  need(
    !a.dispatch.taskDefinitionArn &&
      /^arn:aws:ecs:us-east-1:967807252336:task-definition\/capiro-dev-meri-c2-case14-postapproval-20261004:[1-9][0-9]*$/u.test(
        dispatch.taskDefinitionArn,
      ) &&
      /^[a-f0-9]{64}$/u.test(dispatch.inputByteSha256),
  );
  Object.assign(a.dispatch, {
    taskDefinitionArn: dispatch.taskDefinitionArn,
    inputByteSha256: dispatch.inputByteSha256,
  });
}
export function bindCase14PostApprovalTask(reservation, outcome, taskArn) {
  currentCase14PostApprovalSpendScope(reservation, outcome);
  const a = reservations.get(reservation).approval;
  need(
    a.dispatch.taskDefinitionArn &&
      !a.dispatch.taskArn &&
      /^arn:aws:ecs:us-east-1:967807252336:task\/capiro-dev\/[a-f0-9]{32}$/u.test(taskArn),
  );
  a.dispatch.taskArn = taskArn;
}
export function currentCase14PostApprovalSpendScope(reservation, outcome) {
  const b = reservations.get(reservation),
    a = b?.approval;
  need(
    a &&
      a.outcome === outcome &&
      a.postApprovalClaimed &&
      !b.settled &&
      Date.now() < a.proof.deadlineAtMs,
  );
  currentCase14ApprovalAuthority(outcome);
  b.recheck();
  return Object.freeze({
    captureRunId: reservation.captureRunId,
    approvalBoundSha256: reservation.approvalBoundSha256,
    approvalWindow: Object.freeze({
      startedAtMs: a.proof.deadlineAtMs - 900000,
      deadlineAtMs: a.proof.deadlineAtMs,
    }),
    maxCostMicros: reservation.ceilingMicros,
    dispatch: Object.freeze({ ...a.dispatch }),
  });
}

export function bindCase14PostApprovalSetup(reservation, outcome, authority) {
  const b = reservations.get(reservation),
    a = b?.approval;
  currentCase14PostApprovalSpendScope(reservation, outcome);
  need(!a.projectionTerminal);
  const proof = currentCase14PostApprovalTaskAuthority(authority, reservation, outcome);
  a.projectionTerminal = sha256Stable(proof.value.results['projection-terminal']);
  return proof;
}

/** Revalidate immediately before the single provider submission. A journal
 * change, prior process crash, settled claim or changed scope fails closed. */
export function assertCaptureSpendReservation(reservation, expected) {
  const binding = reservations.get(reservation);
  need(binding && !binding.settled && binding.expected === sha256Stable(expected));
  if (binding.approval) need(Date.now() < binding.approval.proof.deadlineAtMs);
  binding.recheck();
  binding.assertSubmission?.();
}

export function settleCaptureSpendReservation(reservation, outcome) {
  const binding = reservations.get(reservation);
  need(binding && !binding.settled);
  return binding.owner.settleCaptured(reservation, outcome);
}

export function settleMemoryReadSpendReservation(reservation, authority) {
  const binding = reservations.get(reservation);
  need(binding && !binding.settled);
  return binding.owner.settleMemoryRead(reservation, authority);
}
