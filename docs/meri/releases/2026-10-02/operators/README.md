# Historical task operators

These are the reviewed task-local operators used for the October 2 release and
its two-tenant verification. They are preserved for audit and handover, not as
standing authorization or replayable deployment commands. Their Windows paths,
plan expirations, operation locks, exact source hashes and task identities belong
to that attended operation. Read the parent `OUTCOME.md` for completed actions.

Do not rerun a completed database command, remove a lock, or reuse an expired
plan. The runbooks describe the original preparation phase; their "not run"
language is historical. Current shared operating policy remains authoritative.
For a new change, obtain its authorized scope and prepare a new reviewed plan
from current source and live state.

The synthetic canary adapter validates actual CodeBuild provenance and image
digests, preserves all existing cohort entries, and adds only the two explicitly
named synthetic tenants. The small reconciliation and resume helpers preserve
the original failed receipts and revalidate completed operations before reuse.
They do not justify a blind retry. Source hashes in the original receipts refer
to the original local bytes; Git may normalize line endings in these audit copies.

The browser driver creates only ephemeral sessions for the fixed ordinary
synthetic members, allows at most one explicit no-tools turn per actor, and
revokes newly created sessions. Credentials and the private fixture manifest
are intentionally absent from this repository. The bounded smoke does not
replace the full original File01 acceptance suite.
