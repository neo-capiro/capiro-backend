# First-chat Core source reconciliation (held)

This is a source-only review packet. It does not authorize a CloudFormation update,
database migration, image build, or service activation. The task-local AWS CLI returned
`NoCredentials`, so the newer listener and database observations below are reported
facts to verify against the account, not live attestations from this checkout.

## Listener source and reported layout

The source parent is Core PR #81 `a7353045feaddcbd0d71741a98c9716579d3565c`
(parent `bcdd689956e1aff3fa316103e75ec60ebe024fda`). Its CDK service stack
renders priority 1 POST bootstrap/identity/context, priority 2 POST membership,
priority 3 GET me/clients/client UUID, and an independently retained host-only
JSON 404 guard at priority 4. The last verified local listener snapshot instead
had the first two POST rules and guard at priorities 1/2/3, with no GET rule.

The coordinator reports a newer effective layout: priority 1 is an anchored
regex for exactly four POSTs (`/api/clio/conversations/bootstrap` and
`/api/clio/application-authority/{identity,context,membership}`), priority 2 is
GET `/api/me`, `/api/clients`, or `/api/clients/:uuid`, and priority 3 is the
retained preview-host 404. AWS documents at most three match evaluations per
condition and five per rule; four literal POST path values cannot be placed in
one path condition. An anchored path regex is required for the compact rule.
See https://docs.aws.amazon.com/elasticloadbalancing/latest/application/rule-condition-types.html .

The CDK task still pins the older `6542f5b089656b6d255465edd464d06c2a0b408f`
image, which does not contain PR #81's native GET gate, and does not set
`PREVIEW_NATIVE_GETS_ENABLED` (PR #81 defaults it off). A routing-template
update alone cannot qualify the GET path. A reviewed composed image, its exact
task-only flag/config, and the native credential policy are separate gates.

Before applying any source candidate, read back the current account, listener
rules **and their physical ARNs**, target group, both stack templates, stack
resources and drift status. Match the physical priority-2 GET to its actual
CloudFormation logical owner. Do not infer that it is the former membership
rule merely from its priority. Preserve the priority-1 and priority-2 physical
rule identities where the stack proves them, and preserve the independent guard
identity/export/Retain policies. A safe reviewed change set must show only the
intended rule-condition/priority updates or deletion of a proven redundant
service-stack resource; it must not replace the guard, target group, listener,
or any unrelated rule. The host-agnostic production `/api/*` rule sits below
the guard, so the guard must remain effective throughout reconciliation.

## Ordered-owner migration is partial

The coordinator reports that `clients.account_owner_version` was added alone.
The source migration
`apps/api/prisma/migrations/20281012020000_client_ordered_owners/migration.sql`
also adds the named nonnegative constraint, `client_ordered_owners` relation,
backfill, keys/index, forced RLS/policy/grant, consistency function and two
deferred constraint triggers. Its SHA-256 is
`734c0cd8432c4b7194991fe993fd24fd3b6f9924316447f3f8389eef75f570fe`.
The historical receipt-only run advanced only its separate receipt migration;
it did not certify this ordered-owner migration.

First read `_prisma_migrations` and the actual column/default/constraint,
relation/keys/index, row backfill, RLS/policy/grants, function and triggers
from the selected database catalog. Compare object definitions and ownership
to the exact source. If the report is confirmed, design a separate reviewed
transactional reconciliation with explicit preconditions and a full postcheck.
Do not replay the original `ADD COLUMN` against an existing column, mark the
whole migration applied from column-only evidence, or enable ordered-owner
writes against a partial schema. This packet executes no SQL.

## Control credential and PR #81 composition

The reported deployed commit
`ade7fc883b7459cbc50e6f71d40ce3644bace5ea` diverges from PR #81 at
`6542f5b089656b6d255465edd464d06c2a0b408f`. It adds a sidless
`meri_control_credential` exception to the **generic** Clerk session assertion.
That exception accepts an otherwise valid marked token when *any* session for
the subject is currently active, returning a `meri-template:<jti>` surrogate.
It has no token-specific revocation proof; a later new session can satisfy an
unexpired old token. The verifier does not pin an audience and checks the issuer
only if configured. PR #81's preview GET middleware and both membership reads
call the generic assertion, so simply composing these branches does not prove
that GET requires the real token `sid`. Ordinary tenant routes also do not
reject the marked credential at their entry point.

The minimum boundary for a reviewed repair is:

| Request | Accepted credential |
| --- | --- |
| GET `/api/me`, `/api/clients`, `/api/clients/:uuid` | Unmarked native Clerk session bearer with exact `sid/sub/exp`, online matching active `getSession(sid)`, then PR #81's before/after membership and client-currentness checks. Public HEAD hits the ALB guard; direct-app HEAD dispatch must also refuse marked credentials. |
| POST `/api/clio/application-authority/identity`, `/context`, `/membership` | Native session bearer, or a separately validated control credential if its audience, issuer, currentness and revocation policy is approved. |
| POST `/api/clio/conversations/bootstrap` and every other route | Native session bearer under its existing owner; never the control-credential exception. |

The middleware must refuse a marked credential on every non-allowlisted
method/path before tenant data I/O, including direct or absolute-form requests.
The native GET path must call a native-only assertion, not the generic one.
Focused composition tests must use the real Clerk assertion boundary rather
than mocking it as unconditional success; include sidless marked GET/HEAD,
bootstrap, unrelated routes, native sid/session match, current membership,
wrong audience/issuer, expiration, sign-out/re-sign-in and mid-request
revocation.

`apps/api/src/auth/clerk.service.ts` and
`apps/api/src/tenant/tenant-context.middleware.ts` both carry explicit Neo
change-control headers. Do not edit them before that approval and the control
credential policy are fixed. Required policy decisions: the exact token
audience and mandatory issuer; a token-specific revocation/currentness owner
or a session-bound replacement; and the intended result after all sessions
are signed out and one later signs in. Until then the composed image and
authenticated activation remain held. This packet changes neither file.
