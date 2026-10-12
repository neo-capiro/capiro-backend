# Independent review of existing Outreach Objective destinations

Accepted for the bounded source contract at author head
`49c6fe290cfc4f02552b05357ae00df1f6750b67`, tree
`b3119cffa84304611f53c9627b2de665b1556df5`. No production blocker was found.
The separate review worktree is `/workspace/objective-destinations-review` on
`codex/objective-destination-independent-review-20261012`; its equivalent source
checkpoint `55c13abb097d717950d34ca7db858d37093524c9` has the same tree.

Combined rerun passed **119/119 tests across nine suites**, including 39 retained
independent cases and the author's eight selected suites. Exact commands/suite
paths and results are in `combined-final.log` and `combined-final.json`.
`RECEIPT.json` records all 12 incremental path SHA-256/Git blob hashes against the
reviewed author head. Every working-copy path matched. No database suite was run:
`objectives.pg.spec.ts` and `objectives.authorization.spec.ts` were excluded.

The review read the pinned reconciled ledger at `797e3a59158cff56b017ab7d01ee445bf624fced`
and prospect contract/integration documents at
`6c26ac2dad3756a61b6733329dea7ce3c9138ece`, plus the exact Objective destination
contract. No AGENTS.md was present at root, workspace, or this repository, and none
was tracked in the reviewed repository tree. The initially referenced
QUALIFICATION.md was pending author documentation, not a runtime prerequisite.

Authorization source inspection confirmed exact parameterized tenant, actor,
Clerk subject mapping, active membership/current internal role and nonarchived
client predicates. The wall check locks the actual grant and gives administrators
no bypass. The nondeleted same-client Objective must still have the requested
current version, and the revision lookup binds tenant/client/Objective/version.
The session repository applies tenant and actor ownership before Objective reads.
The resolver loads the locked current version, checks the existing canonical
parser/digest and context isolation, and requires exactly one matching client
sponsor. Existing read-only service ownership and persistence are reused.

Independent tests exercised both real source services together at a canned tagged
SQL boundary. They covered replay after tenant/membership/mapping/client/grant/
Objective/revision loss, role downgrade with stale administrator context, foreign
tenant/actor, historical revision refusal, deletion before stale-version conflict,
archival, sponsor transfer, other valid sponsor kinds, invalid stored state and
digest, and duplicate/nested query parameters through local Nest HTTP. Asynchronous
gates checked that no Objective lookup precedes the session-lock result and no
revision/content load precedes wall authorization. These synthetic tests assert
SQL boundaries and service sequencing; they do not execute SQL predicates or
establish PostgreSQL locking, MVCC, RLS or database permission acceptance.

Retained failures are evidence, not hidden production defects. `author-baseline.log`
records the wrong root Jest launcher path; the corrected launcher passed 37/37.
`independent-initial.log` records review config transform resolution; the config
was repaired to use the pinned absolute ts-jest path. The next run passed 33/39:
six failures came from invalid sponsor fixtures hashed before invoking the resolver
and an empty-array Jest.each fixture shape. `objective-independent-initial-fixture.ts`
preserves that exact fixture. Corrected valid alternative sponsor scopes return
404; corrupt single-client scopes correctly fail with `OUTREACH_STATE_CORRUPT`.
The corrected independent run passed 39/39 before the combined 119/119 run.

Two documentation precision changes were requested and acknowledged by the owner:
describe the canonical client policy as nonarchived, and describe the joined
tenant/membership/user/client query as one authority-lock stage. No native row
acquisition/deadlock claim should be inferred from the joined SQL source.

This acceptance covers one existing `outreach_session` resolver. It provides a
current-state observation, not a capability, durable association, creation route,
general destination registry, frontend navigation, generation or send. There is
no new schema/migration/service/store. Later changes can invalidate an observation;
every repeat must recheck current owner authority. Parent publication remains a
draft PR only. Existing Objective migration execution, native permissions,
PostgreSQL RLS/concurrency and final composed-source qualification remain release
gates. No database/migration execution, provider calls, AWS operations, paid model
calls, customer mutations or security/credential/network changes were performed.
