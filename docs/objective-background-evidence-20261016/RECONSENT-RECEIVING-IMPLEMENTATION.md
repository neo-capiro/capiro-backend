# Reconsent and canonical Planner receiving source checkpoint

This successor implements the centrally allocated Core consent commands and the actual API-Strategy transaction owner. It does not enable background generation or claim a completed Objective-to-Planner runtime.

## Source ownership and behavior

Core owns `auth/workload-authority/objective-consent-policy.ts`, `clients/objectives/work/`, the narrow `ClientsModule` registration, and the exclusively reserved `apps/api/prisma/migrations/20281015050000_client_objective_work_reconsent/migration.sql`. The migration adds three raw-SQL tables: work controls, immutable consents, and immutable command receipts. No Prisma model, earlier migration, shared contract, lockfile or role is replaced. Engagement 40000 remains independently owned.

Authenticated commands use the existing request-local authority owner, current native membership/client/Objective policy, exact expected versions and immutable original/new actor lineage. Historical receipt replay precedes new-write source/CAS checks. New explicit consent uses policy `capiro.objective-generation-consent`, integer revision 1, default/configured maximum 30 minutes, reduced by known stricter action/tenant/token/delegation limits. UNKNOWN is refused before allocating a new identity. Cancellation can fence expired work without pretending to undo a remote effect. The current request's own expiry and local identity/impersonation evidence are checked again after waits and before release; this is not an atomic cross-service Clerk-session guarantee.

The real reconciliation/settings port is unconnected and fails closed. Thus missing jobs never mean not_started, and retry is unavailable until an actual owner supplies authoritative original operation accounting and applicable settings. Local consent records do not mint credentials or call a model.

API-Strategy owns the fixed private canonical application controller/service, denied-by-default workload authority port, current Core/consent fence, and the Planner owner's passed-transaction materializer methods. All output rows, the Planner owner's v2 creation receipt, the immutable application ACK, and the explicit applied head share one Prisma transaction. The final claim/source/consent/DB-clock fence runs after all writes; failure escapes the transaction. No browser POST sequencing or cross-service HTTP transaction is substituted.

The automatic path maps the actual default project row and its task memberships to the reserved canonical project ID. Public/manual groups and multihoming remain unchanged. Existing canonical output collisions refuse rather than overwrite human edits. New projects use existing private/list/on_track defaults; tasks use existing todo/unassigned/priority-none defaults. This path creates internal owner events but does not create project rules, outreach, external activation or another model run.

The immutable creation ACK and current permission-filtered observation are separate. Historical lookup can recover the original ACK after the requested Objective advances or the effect consent expires, under fresh current read authority. Hidden output IDs cause the full ACK to be withheld. Missing/malformed paired evidence is uncertainty, never evidence of no write or permission to dispatch again. The mutable applied head is rebuilt against its paired immutable evidence before CAS advancement.

## Contract and identity

`CANONICAL-APPLICATION.schema.json` and `RECEIVING-TRUST-ALLOCATION.md` describe the exact closed nine-field POST, ACK, success/read and safe errors. Routes are relative to the existing Strategy API prefix. POST success is 201, GET success 200. GET exports no authoritative empty/eligibility response; missing ACK is 503 OUTCOME_UNCONFIRMED. Actor IDs are native Core UUIDs, not Clerk subjects.

Stable Core application identity binds the complete original canonical token plus the original native actor of that admitted continuation. Meri's workflow identity may additionally bind immutable consent ID/control version: explicit reconsent does not edit the Objective or invent a new ready intent. The same consent/lost ACK retains one workflow. A new consent cannot rewrite or adopt an earlier creation ACK, and UNKNOWN cannot authorize a new attempt. Full immutable original work/attempt binding remains an obligation of the real trusted admission owner.

## Actual validation and limits

The first bounded Node batch passed 136/136 cases. Only affected files were rerun after two corrections: 13/13 static migration cases, and 26/26 command cases including one new newline adversary. A final exact accounting-fingerprint match correction passed 27/27 affected command cases, adding one new case. These are 138 unique fixture cases across the retained runs; overlapping affected reruns are not added. Each process used a 128 MiB V8 cap, 120-second supervisor, one test process with isolation disabled, sanitized environment names and a network/server/child guard. Actual elapsed times were 0.230, 0.118, 0.156 and 0.150 seconds; all four owned processes exited. Peak working-set sampling returned null and is not claimed. A fresh physical-memory observation was retained; no denied commit-memory probe was retried.

Tests cover policy terms, command replay/CAS/current-authority failures, UNKNOWN refusal, cancellation/expiry, exact parsing, ACK reconstruction/forgery, current human edits/partial permissions, actual pure transaction-order logic with synthetic outer rollback, and static SQL invariants. Static SQL assertions do not execute PostgreSQL. The test service ports are synthetic; they do not qualify real Nest/Prisma integration.

Full semantic Core/Strategy typing, the eight new owner Jest cases, legacy HTTP/materializer regressions and native PostgreSQL concurrency/RLS/grants/deferred-trigger execution remain UNRUN for this successor. Earlier source tests/typing apply only to their earlier pins. The native ACL STOP and all earlier failed/unrun evidence remain preserved. No migration, live SQL, DACL change, provider call, AWS action, deployment or merge occurred here.

## Exact remaining integration dependencies

1. Bind a named workload issuer/audience/delegation verifier and transaction-local current claim witness. The concrete port currently denies before DB access; generic internal secrets, context digests and task/model tokens are not substituted.
2. Add the trusted generation producer's immutable canonical-intent/actor/consent-to-Meri-run/attempt/job association and the narrow Strategy writer seam that persists the reserved canonical Strategy ID. Existing legacy Objective jobs do not contain that RunBinding. Model completion or caller-selected IDs cannot start followthrough.
3. Define and implement update behavior for routine regeneration into an existing canonical project while retaining its ID and human edits. Current collision refusal is truthful and preserves manual/multiple-group output semantics.
4. Qualify the exact integrated source with semantic typing, real owner HTTP regressions, and native app-role transactions, expiry/claim races, rollback, privileges and RLS before enabling the verifier or claiming full automatic completion.

Evidence under `evidence/reconsent-receiving/` consists of exact custody copies. Archived launchers retain their original task-local relative paths and are not portable entrypoints or instructions to rerun a held stage.
