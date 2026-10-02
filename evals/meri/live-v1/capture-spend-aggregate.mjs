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
import {
  currentCase01CaptureAuthority,
  currentCase14RecallAuthority,
} from './case01-live-capture.mjs';

const helper = fileURLToPath(new URL('./lib/windows-capture-spend.py', import.meta.url));
const reservations = new WeakMap();
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
    kind: 'meri-original-capture-spend-checkpoint',
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

/** A trusted operator passes the pinned last checkpoint, not model/user content.
 * Native handles fence identity/content/entry-set changes and concurrent writers.
 * Legacy ceilings remain consumed. Protocol v2 releases a NEW reservation's
 * unused ceiling only through the existing server-authoritative settlement. */
export function openCaptureSpendAggregate(prior, { pythonExecutable }) {
  need(prior?.kind === 'meri-original-capture-spend-checkpoint' && prior.version === 1);
  const root = prior.state?.root;
  let value = native(root, pythonExecutable, { op: 'read', state: prior.state });
  let poisoned = false;
  const advance = (op, event) => {
    need(!poisoned);
    try {
      value = native(root, pythonExecutable, { op, event, state: value.state });
      return checkpoint(value);
    } catch {
      poisoned = true;
      throw new Error('CAPTURE_SPEND_AGGREGATE_REJECTED');
    }
  };
  const owner = Object.freeze({
    checkpoint: () => checkpoint(value),
    reserve({ caseId, captureRunId, ceilingMicros }) {
      const event = {
        kind: 'reserve',
        caseId,
        captureRunId,
        ceilingMicros,
        reservationId: randomUUID(),
      };
      advance('reserve', event);
      const capability = Object.freeze({
        caseId,
        captureRunId,
        ceilingMicros,
        reservationId: event.reservationId,
      });
      reservations.set(capability, {
        owner,
        settled: false,
        expected: null,
        recheck() {
          const current = advance('read');
          const key = `${caseId}:${captureRunId}`;
          need(
            current.snapshot.activeRun === key &&
              current.snapshot.runs[key]?.reservationId === event.reservationId,
          );
        },
      });
      return capability;
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
      });
      binding.settled = true;
      return result;
    },
    settleMemoryRead(reservation, authority) {
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
  return owner;
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
  const key = `${p.caseId}:${p.captureRunId}`, row = current.snapshot.runs[key];
  need(current.snapshot.activeRun === key && row?.reservationId === p.reservationId && row.ceilingMicros === p.ceilingMicros);
  const value = native(prior.state.root, pythonExecutable, {
    op: 'reconcile_terminal', state: current.state,
    event: { kind: 'reconcile_terminal', caseId: p.caseId, captureRunId: p.captureRunId,
      reservationId: p.reservationId, disposition: p.disposition, chargedCostMicros: p.chargedCostMicros,
      proof: { readbackSha256: p.readbackSha256, ledgerSha256: p.ledgerSha256, envelopeSha256: p.envelopeSha256,
        conversationId: p.conversationId, completedAtMs: p.completedAtMs, observedAtMs: p.observedAtMs,
        providerDeadlineAtMs: p.providerDeadlineAtMs, pendingProviderAttempts: p.pendingProviderAttempts,
        providerAttempts: p.providerAttempts, answerGrade: 'NOT_EVALUATED' } },
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
  binding.recheck();
  binding.expected = sha256Stable(expected);
}

/** Revalidate immediately before the single provider submission. A journal
 * change, prior process crash, settled claim or changed scope fails closed. */
export function assertCaptureSpendReservation(reservation, expected) {
  const binding = reservations.get(reservation);
  need(binding && !binding.settled && binding.expected === sha256Stable(expected));
  binding.recheck();
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
