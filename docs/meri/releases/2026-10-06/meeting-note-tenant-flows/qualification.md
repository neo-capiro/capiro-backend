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
