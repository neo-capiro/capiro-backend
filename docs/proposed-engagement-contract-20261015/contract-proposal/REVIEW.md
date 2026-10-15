# Independent publication quality review

Reviewer: `patch_review`, 2026-10-15.

Reviewed exact files:

- [PROPOSAL.md](PROPOSAL.md): SHA-256 `e015eb5672d7e2a1fd1f2004e862defe0f9a58fd1fdf7c30ddc54255b8237658`.
- [Packet README](../README.md): SHA-256 `bfda0a6a2f6668527ca3433e5b4d4def71acabfd16b1a6c9297015f23af0cbaf`.
- [CALENDAR-FACTS.md](CALENDAR-FACTS.md): SHA-256 `9a152a4db0340aab051f67dff867b63d105d46b6522d39ef594bee4a25ee7eb9`.

No remaining technical blocker was found to publishing these documents for owner review. This accepts documentation quality and internal consistency only. It does not approve business policy, implement a contract, allocate persistence/schema/migrations, authorize shared-owner changes, or qualify live behavior.

## Findings disposition

1. Current facts and proposed behavior are separated. Legacy registration evidence supports a source-registration conclusion rather than a deployed-runtime claim. The original [REVIEWED-SNAPSHOT.md](REVIEWED-SNAPSHOT.md) still has exact SHA-256 `b9ae6fa53fe28eb3ef1af5eded7b0140af304a39edc5a6e3fb5ca8fbb3b508eb`; [PRIOR-REVIEW.md](PRIOR-REVIEW.md) remains scoped to that checkpoint. The unavailable archived Plan-frame bytes are not represented as recovered current evidence.
2. Cardinality follows the supplied direction: one immutable client per plan, multiple plans per client and child waves. Multiple active plans are representable; no hidden exclusivity, replacement, account-assignment model or sibling-plan mutation was introduced. Design Active/Stale/No-plan labels are distinguished from proposed persisted lifecycle states.
3. The manual lifecycle table is coherent and reversible. Authorization and expected-version checks precede no-op decisions. Authorized archived plans remain readable and restorable to draft; unsupported archived commands produce a lifecycle conflict after authorization. Child history and explicit child archives survive parent archive/restore. No transition schedules or changes an external campaign, outreach, task or meeting.
4. Creation reconciliation covers both plans and waves. An original receipt/version is distinct from the current aggregate version. Ambiguous non-create outcomes retain uncertainty instead of automatic replay. Every real child/lifecycle/review change shares the parent aggregate version.
5. Access preserves exactly the current authenticated membership/role boundary plus `!memoryWall || matching current grant`; no grant-only rule or administrator/owner bypass remains. Office-reference rescope, rekey, archive and merge/deletion are addressed explicitly. Existing target-owner fencing and race qualification remain coordinated implementation prerequisites; the document does not change frozen target routes or allocate FK/cascade behavior.
6. The explicit-deadline V+1 review protocol is concrete and remains PROPOSED for owner acceptance. Expiry, every later aggregate change, no-op behavior and restore effects are consistent; prior review cannot silently become current again. No default age threshold or external-change invalidation formula was invented.
7. Minimal v1 omits an unverified wave execution enum. A manual format label is display data, not a DC-eligibility classification. Half-open date-only windows with an explicit IANA timezone are proposed wire validation, without invented instants, availability or ranking. A future integration must deliberately translate these boundaries when consuming the existing inclusive-day calendar API and preserve source time precision.
8. Calendar evidence distinguishes known public events, tenant/user overlays, bounded source-health and Florida coverage receipts, and Strategy prototype-derived planning references from complete federal sitting/recess coverage. Null instants, absent public scheduled ends and the recess verifier's data-gap limitation remain explicit. No availability certificate or ranking policy is claimed.

## Checks and limits

Read the proposal, packet README and calendar evidence. Spot-checked frozen source for the client wall predicate and lock order, Live Hearings routes/query/time shapes, Florida coverage, federal agenda-derived check state, Strategy baseline provenance and recess-verifier behavior. The preserved snapshot hash was verified. No implementation, dependency installation, runtime test, provider call, database activity or source mutation was performed by this review; only this review record was added.

The publication manifest is generated after this review and excludes itself. Remote Git blob/full-byte comparison and final packet link/scope checks remain the publishing owner's separate checks; this review is not their receipt. Parent acceptance and the stated coordination/qualification gates still precede any persistence or migration implementation.
