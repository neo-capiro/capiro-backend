# Stage 3b: calibrated cascade

The calibrated cascade is a reusable, registry-driven decision path for claim assessment. It is dark by default: production continues to use `MERI_CHAT_EVIDENCE_JUDGE=paired`. The shadow claim assessor selects this path only when routing is explicitly set to `cascade`; live repair uses the same helper while preserving its existing behavior.

## Decision flow

The cascade asks Jev first when it is available. A confident, in-distribution Jev outcome is used directly unless an escalation rule applies. On escalation, the legacy judge is called and the existing live-repair selection rule is preserved exactly: a legacy outcome wins; otherwise a Jev outcome wins; otherwise the available failure is returned.

Stable escalation reason codes are:

- `jev_unavailable`: Jev is absent, unavailable, or the request was already aborted/expired.
- `jev_failure`: Jev returned or degraded to an operational failure.
- `low_confidence`: confidence is below the registered `escalateBelowConfidence` threshold.
- `compound_claim`: the claim is compound and the registration enables compound escalation.
- `conflict`: Jev reports conflicting evidence, or contradicts a registered high-impact category.
- `high_impact_category`: the claim is materially high impact or belongs to a registered high-impact category.
- `out_of_distribution`: a non-empty calibrated category list does not contain the claim category.
- `audit_sample`: a supported approval falls into the deterministic audit sample.

The claim-support registration in `JEV_TASK_REGISTRY` owns the confidence threshold, compound rule, high-impact categories, evaluated categories, and audit rate. Changing a registration changes cascade behavior without introducing another hardcoded policy.

## Calibration requirements

A task is not considered calibrated merely because it has thresholds. Promotion from `provisional` to `calibrated` requires:

1. a held-out evaluation set that represents the intended claim categories and records accuracy, false-approval, and disagreement behavior;
2. canary evidence from the same pinned model and question version under realistic envelopes;
3. reviewed thresholds and category scope supported by those results; and
4. a registry-version change when the model, question, thresholds, or calibrated scope changes.

Categories outside a non-empty evaluated set escalate rather than relying on unsupported generalization.

## Audit sampling

High-confidence supported decisions still need auditing because confidence-based escalation cannot detect confidently wrong approvals. Sampling is a pure deterministic function of `sampleKey` and `auditSampleRate`; it does not use `Math.random`. Replays therefore select the same claims. Live repair retains its existing FNV-style hash and sample key (`conversationId:claimId`), so the refactor does not move claims into or out of the audit cohort.

## Rollout

Cascade fields are additive in `meri.evidence_shadow`: `escalated`, `escalationReasons`, `audited`, and `auditDisagreement`. Paired routing emits the prior event shape unchanged and continues to call both judges.

The cascade must remain off in production until held-out and canary evidence supports its registered calibration. Activation is an explicit routing decision using `MERI_CHAT_EVIDENCE_JUDGE=cascade`; merely deploying this code does not activate it. Provider errors, aborts, and deadlines degrade to the prior decision path and must not hold or duplicate a turn.
