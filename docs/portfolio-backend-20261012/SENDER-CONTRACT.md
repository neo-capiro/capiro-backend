# Exact single-mail sender contract candidate

Source implementation: `2ed276a27954fa11c851ba950b53bf88b81ec8b1` (tree
`fe5cfb50a6eead3533864f0864984d18ef2bc7c7`), based on main `4be13b0b1` with
separately attributed PR2364 reply-preflight and PR2381 attachment-ACL prerequisites.
Source-only draft; frontend integration and deployed acceptance remain separate.

## Read and send

`GET /api/engagement/mail/mailboxes` inherits the existing authenticated tenant
context, RolesGuard and `standard_user` controller floor. It returns only:

```json
[{
  "id": "44444444-4444-4444-8444-444444444444",
  "provider": "google_workspace",
  "accountEmail": "mailbox-b@example.test",
  "displayName": "Selected mailbox",
  "availability": "available",
  "signaturePolicy": "actor"
}]
```

The query uses the exact existing send resolver's tenant, connection creator,
connected status, supported Outlook/Gmail provider and stored-token predicates.
Rows without an account address are omitted. Selection and projection live in
`engagement/mailbox-selection.ts`. No credentials, token records, scopes, sync state,
errors or tenant/actor identifiers are selected or returned. `available` means
locally eligible at read time; it does not guarantee still-valid remote OAuth
consent or successful provider delivery. Provider adapters retain token authority.
The broad legacy integration-list route is unchanged and is not the picker contract.

`POST /api/engagement/mail/send` accepts optional UUID `senderConnectionId`.
Malformed/null/empty supplied selectors fail DTO validation. New messages omitting
it retain the existing most-recent connected mailbox selection. Supplying it uses
exactly that caller-owned connection; unavailable/disconnected/foreign/tokenless
selection fails without querying for or falling back to another mailbox.

For replies, the existing tenant/owner/active-message thread predicate runs before
connection selection, attachment bytes and provider dispatch. The originating
connection is mandatory. An omitted sender selects that connection; an explicit
different sender fails. An unavailable originating mailbox does not fall back.
The transaction retains the ownership check and additionally pins connection ID.
This preserves the existing local reply association; it does not introduce new
provider-native reply headers or change provider wire formats.

The actual dispatcher, runtime gate, token handling, MIME/Graph send formats,
attachment parent/viewer/readiness checks and provider error classification are
reused. Neither OAuth adapter nor runtime/security configuration changes.

## From, signature and receipt

Local From address/name and thread participants use the selected connection's
account address/display name. A missing address fails before provider dispatch;
the actor's profile address is never substituted. New local message metadata
records selected connection and signature policy. On deduplication, provider-sync
fields remain untouched; existing thread/message rows from another connection, or messages on a different local thread,
cause a rollback and an unavailable-receipt response, not a false success.

The existing sanitized signature belongs to the **actor**, not a mailbox. The
actor's enabled preference and explicit `appendSignature` override remain in force.
No per-mailbox signature is invented. The frontend must label this policy honestly.
Success adds these fields to the existing `ok`, thread/message IDs and provider:

```json
{
  "senderConnectionId": "44444444-4444-4444-8444-444444444444",
  "senderEmail": "mailbox-b@example.test",
  "senderName": "Selected mailbox",
  "signaturePolicy": "actor",
  "signatureAppended": true
}
```

A provider-ambiguous result returns503 `MAIL_SEND_OUTCOME_UNKNOWN`, chosen connection
and address, and `retryable:false`. Provider acceptance followed by a local persistence
failure returns503 `MAIL_SEND_RECEIPT_UNAVAILABLE` with that same sender identity and
`retryable:false`. Neither path retries or reports success. The user must reconcile
Sent Items before another send. This legacy single-mail route has no new durable
idempotency ledger; the response itself is not a replay/recovery service. The existing
versioned Outreach/send-intent owner remains separate.

## Review and frontend handoff

The implementation's own source review checked authorization-before-side-effect,
exact-selection no-fallback, actor signature sanitization, connection agreement,
non-disclosing preflight failures, post-send failure classification, and narrow
provider-sync updates. Preserved candidate behavior was independently inspected;
independent reviewer `independent_backend_review` accepted repair source
`14d66227c4898ad3aaa7e46ec054c5b2c325c5fe` within source-only scope after fixing the
dedup receipt inconsistency. Release/activation acceptance remains separate.

Keep the selector bound to the current actor and reviewed mailbox list; pin its ID
in the send input and validate the returned sender ID/address against that selection.
For a reply, display/lock the originating mailbox. Refreshing the list cannot grant
send authority; the backend rechecks selection. Do not treat a lost response,503,
permission failure or missing/mismatched receipt as permission to replay. No browser
change is included in this PR, and `ENG-prep_sender_select` is source-contract closed
only, not signed-in/provider acceptance.

The existing services/controller exceed size-review thresholds. The new shared
query/projection module is 50 lines and has no application-service dependency or
cycle. The controller adds only DTO validation and delegation. Existing send
orchestration retains the persistence/provider boundary; no second mail sender,
attachment resolver or task/objective system was added. Broader legacy extraction
would touch independently owned workflows and is outside this bounded candidate.

Preflight checks are not a transactional fence against concurrent grant revocation
or remote OAuth changes. Native RLS, actual provider Sent Items, lost-response
reconciliation and deployed browser checks remain unrun. No real message, credential,
resource, migration, customer-data mutation, paid model or deployment was performed.
