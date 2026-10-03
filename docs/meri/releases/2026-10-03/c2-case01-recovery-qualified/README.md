# Case01 same-reservation continuation — local qualification

The original bootstrap for run `bd35c0f4-1604-4371-b7e9-a1338369e53f`
stopped before native execute. Its failed execution and 13-event history remain
unchanged. A separate read-only diagnostic reproduced Clerk being unavailable
immediately after hard navigation and ready after an explicit identity/session
wait. This demonstrates the readiness defect, not the original masked exception.

The qualified local evaluator resumes only the existing $15 reservation
`cf7ea1df-6996-4d29-a5d5-b98db9c85c61` and empty owned conversation
`f493355c-ee97-44a1-a0b0-e05e7b104b59`. It does not create a conversation, adopt a
new journal, reserve again, reset, refund or replay setup. A fixed authenticated
GET sequence proves current actor, exact ownership, empty transcript, no durable
provider metadata and fresh fixture/budget readiness. A fresh read-only
captureAdmission is expected; it is distinct from durable provider admission.
Metadata absence is combined with stopped-process/no-stream/claim proof, since
it is not an immutable historical audit by itself.

A separate exclusive fsynced claim precedes the process-private authority.
Restoration checks the exact native21-event checkpoint and creates the same
reservation capability. Native preparation, immutable build verification,
admission, sole stream dispatch and server-backed settlement remain in use.
An additional one-use authenticated recheck precedes native execute, and the
normal pre-stream reservation assertion consumes the submission fence. Any
failure retains the claim and unresolved reservation; no automatic retry exists.

The new operator pins a clean reviewed commit and permits only the three exact
evaluator files plus documentation after the original operator commit. It waits
for the exact Clerk session/user/organization after navigation. The normal
one-hour capiro token lifetime was verified read-only. The first lifetime-read
script assumed an array and failed to parse the paginated SDK result; v2 handled
that envelope. Neither script changed a template, created a session or called a
provider. No credentials are archived.

The checkpoint records tests of forged/duplicate/stale authority, changed
evidence, metadata conflicts, two real competing file owners and actual native
disposable-journal restoration/settlement. Existing spend regressions use exact
hash-verified copies of the original20-event prefix; the actual21-event journal
was never reset. Test-only substitutions cannot mint live authority. All
actual cloud/provider execution remains outside this qualification archive.

This is local qualification, not a live benchmark result. Full original
acceptance remains0/75, CD0/7, CW0/8; human review remains outstanding. Any later
execution is a separate preserved checkpoint. The prior setup and failure are
in [the original checkpoint](../c2-native-case01-checkpoint/README.md).
