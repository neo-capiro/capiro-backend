# Krisp all-tenant activation

Completed October 5 at 21:41 UTC. Engagement worker revision 133 passed the
guarded promotion's ECS/task/digest/ALB health checks; rollback revision is 132.
The separate configuration transaction committed successfully: 17 of 17 existing
tenants enabled, 15 flags changed, other settings preserved, user preferences
unchanged. The transaction also verified every tenant's effective flag through
the live API image's packaged helper. Public Integrations and health return 200;
unauthenticated Krisp access still returns 401. Receipts are included here.

Application change: PR #2014, merged source fdf1ccecf504ea495b27bfff759a31cd16b10686.
The tenant flag still defaults off and rejects missing/non-boolean values. The
slug restriction has been removed from OAuth/connector access and worker selection.
Each user must connect a personal account and opt into importing new meetings.

76 tests pass across seven Krisp/OAuth/managed-connector suites. Enabled non-pilot
OAuth and import paths, all-tenant sweep selection, disable/revocation, atomic
artifact saving, and ownership controls are covered. The build-isolation guard
passes. Both exact-source ARM64 builds passed TypeScript compilation, packaged
module imports, non-pilot enabled/disabled flag probes, worker allowlist absence,
and exact comparison of all 454 packaged migrations against the source tree.
No schema changes or migrations are part of this activation.

Broader runtime/attachment verification initially had five failures: the original
Krisp controller was missing from the test route inventory; two PDF cases needed
Node VM-module support; Excel and HTTP startup exceeded the local 5-second timeout.
The controller inventory generator/fixture are corrected in this evidence change
without changing application runtime code. All affected suites now pass (10 route/
HTTP tests and five attachment tests). The original run's other 300 tests passed.
Both original output and rechecks are retained, without mislabeling the first run.

Live API revision 561 uses 94c84fc03d8aee8be4d7e62a5a552c48471cda67, a descendant of
this application change. Preserve that newer release: do not promote the earlier
API candidate built here. Engagement worker revision 131 still uses the original
pilot image and requires the qualified engagement-api candidate. Its source is a
descendant of that baseline; existing encryption, schema, provider permissions,
user preferences, runtime ownership, and deployment settings remain compatible.
No retired runtime, table dependency, or feature configuration is restored.

A scoped read-only check found 17 existing tenants, two explicitly enabled. The
separate activation transaction locks those tenant rows, enables only the Krisp
flag, checks exact preservation of other settings, verifies all resulting flags
through the packaged application helper, and commits. It changes no user import
preferences and retains a private before-state for rollback. New tenants still
require explicit flag enablement. No transcript or token values are inspected.

The user explicitly requested all-tenant activation after authorizing merge/AWS
shipment. The implementing agent reviewed the source, test outcomes, and immutable
image evidence under that authorization; this is not independent human review.
The guarded release operator promoted the worker before the scoped flag update.
ECS health and flag readback do not establish a completed provider import. Live
OAuth and note-sync acceptance are reported separately from rollout evidence.
