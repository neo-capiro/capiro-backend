/**
 * F10 (2026-09-10 remediation plan §8) — structured execution blockers.
 *
 * Observed defect: failed and waiting runs repeat technical strings (raw
 * ownerUserId fields, backend phrasing), give broad advice that does not
 * identify the missing input, and classify a generic generated-artifact
 * verification failure as missing context even when the actual missing
 * requirement is not known.
 *
 * This suite pins the server's blocker PROJECTION: a small additive mapping
 * from run.findings.g0 (eligibility reasons, verifierChainErrors,
 * missingRequired, versionDrift, openMaterialConflicts) to a stable code +
 * known requirements + affected IDs + repair target. Raw diagnostics stay
 * available for inspection. No new storage — this is a projection of the
 * persisted findings at list/get time.
 */
import { describe, expect, it } from 'vitest';
import { projectExecutionBlocker } from './execution-blocker.js';
import type { ExecutionBlocker } from './execution-blocker.js';

describe('projectExecutionBlocker (F10 structured blocker projection)', () => {
  it('maps a missing-owner eligibility reason to owner_missing with a readable requirement and step repair target', () => {
    const blocker = projectExecutionBlocker({
      state: 'waiting_for_input',
      waitingReason: 'node no longer eligible: node has no owner (ownerUserId is required)',
      findings: {
        g0: {
          eligibility: {
            eligible: false,
            reasons: ['node has no owner (ownerUserId is required)'],
          },
        },
        execution: { nodeId: 'node-1', strategyId: 'strat-1' },
      },
    });
    expect(blocker).toMatchObject({
      code: 'owner_missing',
      primary: 'Assign an owner to this step before preparing work.',
      requirements: [{ kind: 'owner', label: 'Step owner' }],
      nodeId: 'node-1',
      strategyId: 'strat-1',
      repair: 'open_step',
    } satisfies Partial<ExecutionBlocker>);
  });

  it('maps a missing target date to date_missing with a readable requirement', () => {
    const blocker = projectExecutionBlocker({
      state: 'waiting_for_input',
      waitingReason:
        'node no longer eligible: node has no target date (startsOn or endsOn is required)',
      findings: {
        g0: {
          eligibility: {
            eligible: false,
            reasons: ['node has no target date (startsOn or endsOn is required)'],
          },
        },
        execution: { nodeId: 'node-2', strategyId: 'strat-1' },
      },
    });
    expect(blocker?.code).toBe('date_missing');
    expect(blocker?.primary).toBe('Add a target date to this step.');
    expect(blocker?.repair).toBe('open_step');
  });

  it('maps an invalid workspace kind/subject to kind_subject_invalid with a review-details target', () => {
    const blocker = projectExecutionBlocker({
      state: 'waiting_for_input',
      waitingReason:
        "node no longer eligible: node kind must be 'action' for workspace execution (is 'gate'); node subject must be one of deliverable, submission for workspace execution (is 'member')",
      findings: {
        g0: {
          eligibility: {
            eligible: false,
            reasons: [
              "node kind must be 'action' for workspace execution (is 'gate')",
              "node subject must be one of deliverable, submission for workspace execution (is 'member')",
            ],
          },
        },
        execution: { nodeId: 'node-3', strategyId: 'strat-1' },
      },
    });
    expect(blocker?.code).toBe('kind_subject_invalid');
    expect(blocker?.primary).toBe(
      'Workspace preparation requires an Action with a Deliverable or Submission subject.',
    );
    expect(blocker?.repair).toBe('review_step');
  });

  it('maps missingRequired context to required_source_missing naming ONLY the known missing types', () => {
    const blocker = projectExecutionBlocker({
      state: 'waiting_for_input',
      waitingReason: 'required client context is missing: client_constraints',
      findings: {
        g0: {
          eligibility: { eligible: false, reasons: [] },
          missingRequired: ['client_constraints'],
        },
        execution: { nodeId: 'node-4', strategyId: 'strat-1' },
      },
    });
    expect(blocker?.code).toBe('required_source_missing');
    // Only the KNOWN missing type — never prescribes a strategy brief too.
    expect(blocker?.requirements).toEqual([
      { kind: 'client_constraints', label: 'Client constraints' },
    ]);
    expect(blocker?.repair).toBe('add_context');
  });

  it('maps an open material conflict to material_conflict with scoped steward review', () => {
    const blocker = projectExecutionBlocker({
      state: 'waiting_for_input',
      waitingReason: 'unresolved material conflict',
      findings: {
        g0: {
          eligibility: { eligible: false, reasons: [] },
          openMaterialConflicts: [{ id: 'c1', subject: 'Revenue figures' }],
        },
        execution: { nodeId: 'node-5', strategyId: 'strat-1' },
      },
    });
    expect(blocker?.code).toBe('material_conflict');
    expect(blocker?.repair).toBe('review_context');
  });

  it('maps version drift to plan_version_changed', () => {
    const blocker = projectExecutionBlocker({
      state: 'waiting_for_input',
      waitingReason: 'plan changed since approval',
      findings: {
        g0: { eligibility: { eligible: false, reasons: [] }, versionDrift: true },
        execution: { nodeId: 'node-6', strategyId: 'strat-1' },
      },
    });
    expect(blocker?.code).toBe('plan_version_changed');
    expect(blocker?.primary).toBe('The plan changed after this run was prepared.');
    expect(blocker?.repair).toBe('review_step');
  });

  it('distinguishes unknown-cause artifact-verification failure from missing context (never asserts an unproven cause)', () => {
    const blocker = projectExecutionBlocker({
      state: 'failed_recoverable',
      waitingReason: null,
      error:
        'generated artifact verification did not pass — no Workspace or Outreach artifact was created',
      findings: {
        g0: { eligibility: { eligible: true, reasons: [] }, missingRequired: [] },
        execution: { nodeId: 'node-7', strategyId: 'strat-1' },
      },
    });
    expect(blocker?.code).toBe('verification_failed_unknown');
    expect(blocker?.primary).toBe('The generated content could not be verified.');
    // CRITICAL: no requirement invented — the cause is unknown.
    expect(blocker?.requirements).toEqual([]);
    expect(blocker?.repair).toBe('inspect_findings');
  });

  it('degrades an unrecognized legacy failure to other with honest copy and only server-authorized recovery', () => {
    const blocker = projectExecutionBlocker({
      state: 'waiting_for_input',
      waitingReason: 'something unprecedented happened',
      findings: null,
    });
    expect(blocker?.code).toBe('other');
    expect(blocker?.primary).toBe('This run needs attention. Review its details before retrying.');
    expect(blocker?.repair).toBe('inspect_findings');
  });

  it('returns null when nothing blocks (ready/completed runs keep a clean card)', () => {
    expect(
      projectExecutionBlocker({
        state: 'ready_for_review',
        waitingReason: null,
        error: null,
        findings: { g0: { eligibility: { eligible: true, reasons: [] }, missingRequired: [] } },
      }),
    ).toBeNull();
  });

  it('carries raw diagnostics for the collapsed Technical details section', () => {
    const blocker = projectExecutionBlocker({
      state: 'waiting_for_input',
      waitingReason: 'node no longer eligible: node has no owner (ownerUserId is required)',
      findings: {
        g0: {
          eligibility: {
            eligible: false,
            reasons: ['node has no owner (ownerUserId is required)'],
          },
        },
      },
    });
    expect(blocker?.raw?.waitingReason).toBe(
      'node no longer eligible: node has no owner (ownerUserId is required)',
    );
  });
});
