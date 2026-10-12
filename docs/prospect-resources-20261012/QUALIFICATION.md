# Prospect Files / Workspace source qualification

Runtime source is `ef64c441302e32b1c141c70751e165fd7456a472`, tree
`672ba05a50556ed9c19b66af1c655456c60f1209`. Retained independent regression tests
and fixture corrections are source `e7dd54326b8c2eb147845670e23f8760c0c6ce5d`;
runtime/migration files are byte-identical. Final retained-test source
`9c2765224fc38d111df0fe184ca50229c6128373` supplies one required unused ShareLinkService constructor
dependency in the independent fixture; assertions are unchanged. All are based on
preserved sender PR2393.
No database migration, customer write, provider message/upload or paid model call
was used. Synthetic tests do not prove native RLS/MVCC or provider operation.

## Author checks

- First consolidated source `056bae1a00004f1ad7b0001ed89c48e704f84a7f`:
  Core 218/218 in 17 suites; Workspace 121/121 in 12 suites.
- Final consolidated replay on `ef64c441302e32b1c141c70751e165fd7456a472`:
  Core 219/219 in 17 suites; Workspace 125/125 in 13 suites; zero skipped.
- Follow-up source `ef64c441302e32b1c141c70751e165fd7456a472`: changed-boundary
  tests Core 38/38 in two suites and Workspace 21/21 in two suites, including
  uppercase UUID retry and same-name client-library exclusion.
- Primary Core and Workspace `tsc --noEmit` passed. Primary Nest builds passed.
  Exact-source final primary receipts are included in evidence.
- `sendSingleMail` method is byte-identical to PR2393, with its SHA-256 recorded.
  Existing sender-selection, thread/reply, attachment refusal and ambiguous-outcome
  regression suites are included in the consolidated checks.
- Pinned Prisma 5.22 WASM DMMF/schema validation and `noEngine` client generation
  passed for both schemas. Generated clients are local ignored artifacts only.
- `git diff --check` passed. Local lint failed to start with exit 127: the repository
  does not install an eslint executable for this package. No global substitution
  or dependency/lockfile modification was made to hide that limitation.

## Failures found and fixed

Author initial Core typing caught a misplaced prospect filter on an unrelated
Outreach record query; corrected to the attachment list. Later typing found a
strict mock invocation index and obsolete fifth arguments on the outbound helper;
corrected, with unsupported prospect send scaffolding removed. Two regression
fixtures needed `prospectId:null` in their exact query assertions. Public guest
comment fixture required an actual parent draft under the new orphan/share guard.
A new list isolation test initially omitted the existing required parent/unlinked
selector; corrected without weakening that validation. Initial monorepo-root Jest invocations exited 127 because the executable lives
in each app; reruns used the app-local binaries. Workspace initial Jest
wrapper used a missing transform key; corrected to the repository's real mapping.
Expanded independent Core checks also found six strict client-KB query fixtures
and one authorized document fixture missing the new nullable prospect field. These
fixtures were corrected while retaining their existing negative controls. Failed
attempts and successful reruns remain in evidence.

Independent review identified archived draft-receipt replay and uploader erasure
compatibility edges. The source now checks current read scope for exact receipt
replay, write scope only for new creation, and permits only uploader clearing under
existing user erasure while the durable actor receipt remains unchanged. The client
library exclusion prevents free-text name aliasing of canonical prospect drafts.

## Independent review

On exact retained source `e7dd54326b8c2eb147845670e23f8760c0c6ce5d`, the independent
expanded replay passes Core **407/407 across 27 suites** and Workspace **154/154
across 16 suites**, zero skipped. This includes 19 independently authored Core
cases and 17 independently authored Workspace cases, initially retained
byte-identically in real test paths. Final Workspace fixture changes only the
required unused constructor argument; the 17-case replay and primary type-check
both pass. Core retained-test primary typing also passes. Their original RED lifecycle reproductions, repaired replays,
fixture failures and exact runtime/migration/test equivalence remain in evidence.
Final independent verdict on `9c2765224fc38d111df0fe184ca50229c6128373` is
**acceptable within the documented bounded source scope, no unresolved source
blocker**. It verifies the sole test constructor repair, runtime/migration/assertion
equivalence and a final 17/17 replay. The independent review report describes
source findings and native limitations.

## Unrun release qualification

- No SQL migration was run, including ephemeral databases. Native database grants,
  forced RLS, trigger/FK behavior, concurrent revocation/confirmation/creation and
  process-level recovery remain unqualified. The preserved native Prisma engine
  download restriction is an environment limitation; WASM typing is not a substitute
  for these native checks.
- No real S3 checksum upload/delete or mailbox/provider send; no real model calls.
- No merged/composed candidate test. Core schema and module owners must be composed
  explicitly per INTEGRATION.md and qualified on that exact source.
- No deployment or release readiness claim. Dot owns deployment preparation.
