# Independent draft-native workflow overlay review

Accepted sourceed1cb70cad206949ee27657d5748e2832952a0f1,
tree8988b19a56da936adb82f12173f3c2dfbd589833, above reviewed
bfd81c534c3bc336fde1a4509ce1a84ab4cb7e12. Non-document changes are only
cleanup1-gate.yml and ci-pr.yml. This is approval of source readiness for the
authorized stacked Draft PR, not native or full Cleanup acceptance.

Exact parsed-YAML comparison proves every original command, step, environment,
service, runner, timeout/budget, permission, branch/path filter and existing
condition unchanged. Both workflows retain default opened/synchronize/reopened
activities and add ready_for_review. Cleanup native job gains the reviewed
workflow_dispatch-or-explicit-JSON-false PR predicate. Exactly the two newly
inserted native-capable Core/Defense CI steps gain explicit JSON-false predicates;
all original CI steps and the new pure Web step remain unchanged.

27 pure event/payload fixtures cover the job and both identical native-step
predicates: all selected ready activities, all draft activities, missing property/
payload, null/numbers/stringfalse/empty string/array/object, unrelated events,
explicit dispatch, unselected activities and main-versus-feature base. Fixtures
model documented JSON serialization and preserved trigger constraints; no GitHub
Actions job, native engine, database, migration, provider or security operation
was invoked. Source expressions are compared exactly before modeling them.

GitHub documents the [job condition](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#jobsjob_idif)
as controlling job eligibility. Its [expression reference](https://docs.github.com/en/actions/reference/workflows-and-actions/expressions#tojson)
defines toJSON as JSON serialization; comparing serialized false distinguishes
the boolean from falsy/malformed payload values. The [event reference](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#pull_request)
confirms the default PR activities and ready_for_review support. These sources
corroborate the pure model; the receipt is not an actual Actions execution proof.

The initialb054 receipt/finding is retained: its condition protects cleanup job
but leaves the two new CI steps unconditional on future main-target drafts.
The actual authorized stacked base is PR2407's feature branch, which the
unchanged ci-pr main filter already excludes. Thus the initial incomplete-boundary
field concerns general main-target protection, not an observed unsafe run or a
blocker for that actual stack base. The finaled1 overlay closes that future-main
seam too. Existing native generation in original CI is unchanged; this review
makes no all-existing-CI-native-suppression claim.

All original gate commands remain available for eligible ready PRs and explicit
Cleanup dispatch. No test, guard, threshold or original acceptance assertion was
removed or weakened. Full Web is still the author's separately named active run
at this receipt; no partial count is inferred. Native/full Cleanup qualification
remains unrun/unaccepted. Reviewer changes are evidence only.
