# Case12 completion/capture follow-up review

Verdict: PASS_SOURCE_ONLY_WITH_RUNTIME_BLOCKER

No concrete F1/F2 source exploit is supported after reviewing the omitted native call graph. F3 is narrowed to a trust-boundary limitation, not an established lower-trust bypass. This is not a full-native PASS, readiness decision, live authority, or capture permission: the current actual-factory hydration failed at the native 5-second timeout, so current corpus, completion, and capture readers were NOT RUN. Mandatory native same-journal admission/settlement and worker-census gates also remain absent, and the final packet's twice-census risk remains unmeasured.

## Scope and evidence

File-only review. No database, cloud, provider, implementation, or evidence changes were made. The reviewed root candidate remains the same frozen candidate88381completion/060fcapture and budget code as v1; no fixes are claimed. The supplied manifest identifies the two relevant candidate hashes as `88381c1dbe356e106b537340218278c10eb6542f8bce7ea81b1215d2707560cc` (setup completion reader) and `060f2e667239e981f584f06a17cce9a66074cc77de3fc6b975ccbecc814a701d` (capture authority), and says the remaining candidate/budget files are the same seven-file freeze. The new material is dependency closure, not a candidate correction. The v1 verdict remains preserved in `evidence/prior-review/review.md`; this follow-up explicitly adjudicates, rather than silently deleting, its findings.

The first review did not have the implementation of `assertSyntheticApprovedMemoryInTx`; that omission made its F1/F2 call graph incomplete. This review traced the current-owner path through `approvedMemoryDefinitions` / `expectedMemoryCandidatePayload`, the inventory owner's call to the genuine helper, and the helper's SQL content/provenance checks. References below are to line-numbered files under `evidence/`.

## Adjudication of prior findings

### F1 — Historical MA510 proof not joined to current MA510 row

Disposition: REJECTED as the proposed changed-text-plus-matching-hash exploit; NARROWED as a version/provenance join limitation.

The v1 reproduction proposed retaining the setup ledger/proofs, changing MA510's item text and `source_content_hash` together, then using a new current-corpus proof. That substitution does not pass the genuine native guard in the supplied call graph:

- The fixed recipe rebuilds the 510 approved definitions with MA510 first (`additional-native-closure/evals/meri/live-v1/fixture-provisioning/case12-memory-setup.mjs:111-128`). `approvedMemoryDefinitions` takes MA510 facts from the frozen manifest record and creates the candidate definition from those facts (`additional-native-closure/evals/meri/live-v1/fixture-provisioning/approved-memory-runtime.mjs:109-127`).
- The current owner rebuilds `expectedMemoryCandidatePayload` from that fixed candidate definition and the current proposer, then requires the joined candidate/item identity, approval state, source version and current hash to be consistent (`dependencies/evals/meri/live-v1/fixture-provisioning/case12-memory-current-owner.mjs:281-325`). It passes the native approval guard into the eligibility owner (`:409-425`). The inventory owner rebuilds the expected payload again, passes both candidate and item row-version guards, and calls `assertSyntheticApprovedMemoryInTx` for each row (`dependencies/evals/meri/live-v1/fixture-provisioning/case12-memory-inventory-owner.mjs:232-279`).
- The actual helper validates the candidate against the guard's fixed expected payload and provenance, including exact candidate payload JSON, source marker, scope, and governance (`additional-native-closure/apps/api/src/memory/synthetic-approved-memory.helpers.ts:150-202`). It derives the canonical record from that expected payload, then requires exact item title, the one-element `sections_jsonb` array/body, source version, source content hash and governance fields (`:169-230`). It also requires the exact Clio key/value and source provenance (`:245-253`). Thus replacing text and recomputing a matching row hash is insufficient: both the expected payload and canonical item fields must still match the recipe. A fake native port that simply echoes success would not establish this; this conclusion is from the supplied genuine helper SQL.
- The capture authority additionally binds its current proof to the current target's physical ID, source version, content hash and item row version, and verifies the canonical one-section shape plus hash consistency (`source/apps/api/src/meri/meri-case12-capture-authority.ts:87-105`).

The prior review correctly observed that `readCase12SetupCompletionInTx` validates historical proof row versions against the saved setup progress binding, not against `corpus.currentVerify.target` (`source/apps/api/src/meri/meri-case12-setup-completion.read.ts:54-71`). The native current-owner intentionally rebuilds its row versions from today's current rows (`dependencies/evals/meri/live-v1/fixture-provisioning/case12-memory-current-owner.mjs:281-325, 344-359, 375-408`); it does not require today's xmin to equal the setup-era xmin. This permits xmin to refresh for an otherwise unchanged canonical item. That is a historical-version continuity limitation, but it is not evidence that changed MA510 content can be substituted: the genuine guard checks content against the fixed recipe on the current path. I found no supported route in the supplied closure for the v1 changed-content reproduction. No DB reproduction was run.

### F2 — Exact MA510 text/section identity not demonstrated

Disposition: REJECTED as an open source qualification gap for the reviewed native path.

The additional closure resolves the exact omission identified in v1. The fixed manifest/recipe supplies the approved MA510 facts; approved definitions derive the candidate payload from them; the current inventory owner reconstructs that expected candidate payload and calls the genuine native helper; and that helper reconstructs the expected canonical record and requires exact `title`, `sections_jsonb`, source hash and source version (references in F1 above). The helper's sections are exactly `[{ key: 'memory', heading: 'Memory', owner: 'human', body: record.value.trim() }]` (`synthetic-approved-memory.helpers.ts:203-218`), and it also checks the corresponding Clio projection key/value (`:245-253`). The capture boundary's nonempty-body and section-shape checks are therefore downstream shape/integrity checks, not the only fixture-content identity control.

Conclusion is limited to this supplied recipe/native composition and source call graph. It is not a claim that a native current-corpus/capture execution passed; those readers were not reached in the reported runtime attempt.

### F3 — Completion checksums do not authenticate proof origin

Disposition: NARROWED to a trusted-writer / aggregate-admission limitation; no concrete lower-trust bypass established in the available source.

The completion reader recomputes hashes over the claim, progress, bindings, terminal metadata and stored ledger, but the proof hash is stored beside its metadata in the same tenant settings JSON. The reader itself does not cryptographically authenticate the historical proof or re-read the setup terminal rows (`source/apps/api/src/meri/meri-case12-setup-completion.read.ts:34-84`). Therefore these hashes provide internal consistency, not DB-admin-tamper resistance. Under a threat model that grants an attacker arbitrary writes to the relevant tenant settings JSON, a writer able to rewrite the claim, ledger, proofs and checksums can manufacture internally consistent stored evidence. The reviewed material does not establish protection against that DB-administrator-level mutation, nor should the reader be described as a signature or immutable journal.

Conversely, the prior review's attack sketch is not evidence of a reachable lower-trust application path. The durable setup owner requires native admission and terminal-inspection ports before database activity (`additional-native-closure/apps/api/src/meri/meri-case12-setup-budget-owner.ts:79-100, 117-123`); captures/binds those dependencies privately; returns an opaque `WeakMap` handle; and rejects foreign/poisoned handles (`:221-250, 263-288`). Its row completion calls the private terminal inspector and writes the proof together with completion state in the same application-owned transaction (`:361-386`). The setup executor passes that authority through its private flow, writes its own claim/progress with transaction-bound updates, and describes the opaque native handle as closure-only (`additional-native-closure/evals/meri/live-v1/fixture-provisioning/case12-memory-setup.mjs:342-363, 438-460, 483-518`). I found no supplied route, public JSON input, or lower-trust settings-writer path that lets an ordinary caller invoke those private ports or forge that completion through the application API.

This narrows but does not erase the trust requirement: source closure supports an app-controlled writer/native-port model; it does not prove that every deployment role capable of changing tenant settings is trusted or technically prevented from tampering. Treat the stored completion as relying on that writer boundary, and do not claim cryptographic DB-admin tamper resistance. Also, the manifest explicitly says native same-journal admission and worker census are still absent mandatory gates; this review does not substitute the settings ledger for those gates.

## Runtime and remaining limits

The supplied manifest records that the genuine native factory setup of 510 rows / 1,020 transport doubles passed, but hydration (`readCase12Setup`) failed with P2028 at the native 5-second timeout. Current corpus, completion and capture readers were therefore not reached. This is a real runtime qualification blocker, independent of the source-only F1/F2 conclusions; do not label it a source defect or report a full-native PASS. No attempt to reproduce it was made in this file-only review.

The candidate completion reader itself is explicitly provenance/accounting, not a fresh vector scan, quiescence proof, aggregate settlement, provider permission or capture admission (`source/apps/api/src/meri/meri-case12-setup-completion.read.ts:21-24`). Separate native same-journal admission/settlement and worker/helper census remain mandatory and absent from this evidence. The final packet's two-census risk is unmeasured, not a demonstrated timing failure. No readiness, live authority, capture permission or promotion is granted.

## Final disposition

PASS_SOURCE_ONLY_WITH_RUNTIME_BLOCKER. F1's changed-content exploit and F2's missing native content-identity evidence are rejected on the newly complete call graph; F1 remains narrowed to no historical-xmin-to-current-xmin equality requirement. F3 remains a stated trusted-writer/aggregate-admission limitation, not a proven lower-trust bypass or cryptographic tamper guarantee. Native hydration timeout blocks runtime qualification, and the explicitly missing native gates remain outstanding.

No evidence files were changed. This review was written to `review.md` only.

## Principal references

- `evidence/source/apps/api/src/meri/meri-case12-setup-completion.read.ts:21-84`
- `evidence/source/apps/api/src/meri/meri-case12-capture-authority.ts:53-115`
- `evidence/dependencies/evals/meri/live-v1/fixture-provisioning/case12-memory-current-owner.mjs:281-325, 344-425`
- `evidence/dependencies/evals/meri/live-v1/fixture-provisioning/case12-memory-inventory-owner.mjs:232-323`
- `evidence/additional-native-closure/evals/meri/live-v1/fixture-provisioning/approved-memory-runtime.mjs:109-127`
- `evidence/additional-native-closure/apps/api/src/memory/synthetic-approved-memory.helpers.ts:107-231, 245-253`
- `evidence/additional-native-closure/apps/api/src/meri/meri-case12-setup-budget-owner.ts:79-123, 221-288, 361-400`
- `evidence/additional-native-closure/evals/meri/live-v1/fixture-provisioning/case12-memory-setup.mjs:342-363, 438-518, 568-779`
- `evidence/manifest.json:2-3, 146-197`
- `evidence/prior-review/review.md:9-39` (raw v1 F1-F3 verdict retained for adjudication)

Line references above use the line-numbered evidence files as supplied.