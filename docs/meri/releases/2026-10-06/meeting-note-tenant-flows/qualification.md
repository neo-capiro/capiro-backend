# Meeting notes tenant flow qualification

The user confirmed that only C2 Strategies should copy Krisp's finished notes directly into Meeting Notes and Debrief. Other tenants retain Meri generation from the Krisp transcript. Meri Notetaker's existing transcript -> generated Meeting Notes -> same generated Debrief path is unchanged.

The importer chooses its mode from the current tenant record, reports that mode to Settings, and rechecks it before generation and inside the locked artifact transaction. Tenant consent, active membership, connection ownership, meeting ownership, current meeting/client version, lease fencing, approved private artifacts, and idempotence remain enforced. No feature flag, existing note, debrief, meeting, client association, or schema is changed.

Validation performed before release:
- Existing Meri Notetaker, Krisp, and exact debrief read suites: 100 tests passed before the edit.
- Revised Krisp, governed meeting AI, artifact lifecycle, and Engagement API module suites: 57 tests passed; three additional mode/status drift tests subsequently pass with all 20 importer tests.
- Notes tab, Debrief tab, and tenant-aware Krisp Settings: 41 tests passed, including manual debrief generation and saving, displaying generated notes, and both import-mode descriptions.
- Capture persistence adapter tests passed; operator backfill tests: 4 passed.
- Build isolation and diff whitespace checks passed. API TypeScript checking passed with an 8 GiB heap after rebuilding shared outputs. Initial typecheck exposed a missing import (fixed); a 4 GiB attempt exhausted memory before the successful final check.

Production checks at 23:11-23:16 UTC on October 6:
- Every completed Meri capture in the initial 14-day updated-at scan has a MeetingNote (15/15). Thirteen have session-linked debriefs. The other two were created September 2 and 4 and only reappeared due to retention updates; September 4 has a separately saved debrief, September 2 has notes without a debrief. This is not evidence that two recent generations failed.
- An October 1 generation failed after a provider credit error and malformed fallback JSON. Two October 6 bots ended without recordings. These historical failures are retained; no records were silently rewritten.
- A fresh, synthetic-text-only call to the deployed debrief generator and tenant credential resolver succeeded with OpenAI gpt-6.1-sol using the internal tenant's configured key. It returned a nonempty recap and the expected proposal action item. No customer text was used and no meeting artifacts were persisted. The deployed generation and Notetaker source files are unchanged relative to this feature branch.
- C2 has 393 completed Krisp imports and four awaiting meeting matching. Internal has opted in but no completed Krisp imports; other active tenants have no Krisp opt-in. This release will not regenerate C2's imported notes.

Release candidates must preserve each service's currently deployed source. API baseline 41aead03cd5ad9fec8abecb45e6c12569b0ea08e and web baseline fe8822dd8e2f4a1d5db48734c420b19e4a3684bf contain newer LegiWatch fixes outside main. The engagement worker baseline is 34d34c6f8201ad0849865118ebd932b3b26bbe7b. Candidate branches layer only this feature's reviewed files onto those exact baselines and must not replace those unrelated fixes. Each candidate retains its baseline schema/migrations unchanged. No retired runtime imports are introduced. Guarded one-service prepare/promote/readback remains required; these local checks alone are not deployment acceptance.

Implementation merged in [PR #2142](https://github.com/neo-capiro/capirov2/pull/2142), feature commit `35b8ea9134be36b31b4fde5d4129bf31a74cbc5d`, merge commit `6e388645a261caf84625138023829369cf3495a9`.

Production ledger readback at 23:23 UTC found all 458 migrations from the API baseline present among 515 applied entries, no unfinished migration, and exact checksums for the Krisp schema and newer Federal evidence search migration. The worker's 457 packaged migrations are unchanged from its live baseline. Sixty-one older historical checksum differences were recorded without alteration; this release introduces no migrations, ledger changes, or Prisma schema changes.

Release review is performed by the Codex release agent under the owner's explicit authorization to merge and ship to AWS and confirmation that only C2 copies directly. This is not a claim that a separate human reviewer inspected the release evidence.

All three native ARM64 CodeBuild builds passed. Their exact source and immutable digest records are in `api-build.json`, `engagement-api-build.json`, and `web-vnext-build.json`; the executed build scripts are alongside them. Packaged API/worker probes passed for tenant mode, exact notes preservation, import graph, and complete migration identity/checksum parity with source. The packaged web bundle contains both tenant-specific flow descriptions. Source blob comparisons confirm that every changed file is identical to the tested feature commit, each candidate changes only those files, and native Meri generation/capture source and schema remain unchanged from the live baseline.

## Deployed backend acceptance

The guarded operator promoted API revision 627 and engagement worker revision 137 and verified their exact image digests, task definitions, desired counts, and actual healthy ALB targets. Their manifests and receipts are alongside this report. Background ownership, external actions, Recall webhooks, flags, secrets, network, and scaling configuration were preserved. Both worker instances successfully initialized with no dependency failures or Krisp sweep warnings in their startup logs at 23:40 UTC.

An isolated read-only task using the exact deployed API image finished with exit 0 at 23:35 UTC. It called the real `KrispNotetakerService.status` and `EngagementService.listMeetings`, `listMeetingNotes`, and `listMeetingDebriefs` methods with tenant/user scope and production decryption, without printing content. C2 returned `direct_notes`; the internal tenant returned `generated`. All 393 of Tom's completed imports appeared in the Engagement list, each had approved notes, and both readable artifacts had identical decrypted bodies. Four additional imports remain `needs_match`; this release does not guess meeting or client associations. The 14-day **created-at** scan found 13 completed Meri captures (12 internal, one Maven), all with both notes and session-linked debriefs. This is a scoped application-service readback, not a browser sign-in or HTTP authorization test.

The initial web candidate was superseded before promotion because another owner shipped revision 435, source `f6f9f696b1f3418cdd354778a98ea5ea61cc7ce8`, with additional hearing-label and CSS fixes. A replacement web candidate, `a734bb0a54322ac5327dc04b81647a407a28fb61`, layers only the identical two tested Krisp Settings files onto that exact newer baseline. The original successful web build is retained as evidence, but must not be promoted over the newer live version.

The replacement web build passed native ARM64 compilation and the packaged two-mode UI probe. `web-vnext-build.json` and `web-vnext-build.sh` now refer to this replacement; the original unpromoted candidate is retained under `superseded-web/`. Exact source blob comparison confirms the replacement preserves every baseline file except the two tested Krisp Settings files.

## Final release result

All three guarded promotions completed: API 627, engagement worker 137, and web vNext 438. The final API/worker inspections still reported the qualified image digests, and the worker recheck at 23:44 UTC found no Krisp sweep warnings after its polling interval. The public `https://os.capiro.ai` runtime identified web source `a734bb0a54322ac5327dc04b81647a407a28fb61`; its served VNext bundle contained both the C2 direct-copy and other-tenant generation descriptions selected by the server response. `web-acceptance.json` records the exact served assets. AWS then completed the web rollout and verified the exact deployment and healthy target. No flags, credentials, schemas, client assignments, or existing customer artifacts were modified.

The synthetic live generation and 13/13 recent completed native captures verify the existing Meri path. Historical failed captures are not represented as repaired: one October 1 provider failure and two October 6 captures without recordings remain as recorded. The four unmatched Krisp imports also remain pending a meeting match.
