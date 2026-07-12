# Gmail / Google Workspace Integration — Technical Blueprint

**Status:** Design — no code written. Core decisions RESOLVED 2026-07-10 (§12): full-body
`gmail.readonly` scope, **production-grade launch (full verification, In Production)** like Outlook,
clone-and-adapt. Remaining open items: §12.3 (GCP ownership — currently BLOCKING, see
[docs/runbooks/gmail-phase-0-google-verification.md](../runbooks/gmail-phase-0-google-verification.md) §0),
§12.5 (safety-net poll opt-in).
**Phase 0 corrected 2026-07-10** after adversarially-verified research against primary Google/ADA
sources: §8 and §10 below were updated in place (marked "CORRECTED") — domain verification is
NOT required for Gmail/Calendar push (only for the OAuth consent screen's authorized domains), and
Google will not accept a verification submission until Phase 1's OAuth flow is already live — see
the runbook for the full citation trail and the corrected 0a/Phase-1/0b sequencing.
**Author role:** Principal architect / staff eng / pragmatic CTO review.
**Goal:** Bring Google Workspace (Gmail + Google Calendar) to **functional parity** with the
existing Microsoft 365 / Outlook integration, reusing the engagement data model, the
client-association engine, token crypto, and the hard-won concurrency fixes — without
touching or destabilizing the change-controlled Microsoft path.

> Ground rule for this doc: every "today" statement about Outlook is verified against current
> code (cited). Everything Gmail-specific is called out as **DESIGN** (a decision we are making)
> or **OPEN** (a decision that requires Neo/Ninja sign-off, listed in §12). No silent assumptions.

---

## 1. Definition of "parity" (the acceptance surface)

The Outlook integration today delivers exactly this surface. Gmail must match each row.

| Capability | Outlook today (verified) | Gmail target |
|---|---|---|
| Connect a user's own mailbox (delegated) | MSAL auth-code, cert client, `/organizations` authority | Google OAuth 2.0 auth-code, Web client + secret |
| Multi-tenant (any customer org) | authority `/organizations` | inherent (any Google account); Workspace admin can gate |
| Encrypted token storage + RLS isolation | `IntegrationConnectionToken` + `TokenCryptoService` + `withTenant` | **reused unchanged** |
| Token refresh + rotation | `acquireTokenByRefreshToken`, MSAL cache rotation | OAuth2 refresh grant |
| Calendar sync (±365d window) | `calendarView/delta`, `syncState.calendar` cursor | `events.list` + `nextSyncToken` |
| Mail sync (365d backfill, inbox+sent) | `mailFolders/{f}/messages/delta` per folder | `messages.list` + `history.list` (INBOX/SENT labels) |
| Normalize → `Meeting`/`MailThread`/`MailMessage`/`EngagementContact` | `persistGraphEvent` / `persistGraphMessage` | Gmail/Calendar adapters → **same persistence core** |
| Auto client-association | `ClientAssociationService.associate()` | **reused unchanged** |
| Send mail (outreach + Meri) | `sendMail` → `/me/sendMail` (JSON) | `messages.send` (raw RFC-822 MIME) |
| Realtime push | Graph `/subscriptions` (events+messages) → `/notifications` | Gmail `users.watch`+Pub/Sub; Calendar `events.watch` |
| Manual "Sync now" + "Realtime" UI | `IntegrationsPage.tsx` (MS-only buttons) | enable the already-rendered Google card |
| Consumers (Radar / Engagement / Intel / Meri) | read by `(tenant, client)`, source-agnostic | **surface automatically** once `source=google` rows exist |

Explicit **non-goals** for parity: contacts API sync (Outlook doesn't do a dedicated contacts
pull — contacts are derived from attendees/participants), Drive/SharePoint, chat.

---

## 2. Ground truth — how Outlook works today (verified, with citations)

- **OAuth**: [microsoft-oauth.service.ts](../../apps/api/src/engagement/microsoft/microsoft-oauth.service.ts).
  Confidential client with **certificate** auth (capiro.ai tenant blocks secrets), authority
  `https://login.microsoftonline.com/organizations`. `start()` creates/reuses an
  `IntegrationConnection` (status `needs_configuration`), signs an HMAC `state`
  (`{c:connId, t:tenant, n:nonce, e:exp}`, 600s TTL), returns an auth URL with
  `prompt:'select_account'`. `handleCallback()` exchanges code, extracts the refresh token from
  the MSAL cache, persists via `TokenCryptoService`, flips status to `connected`.
- **Sync engine**: [microsoft-graph-sync.service.ts](../../apps/api/src/engagement/microsoft/microsoft-graph-sync.service.ts)
  (1,542 lines). Delta cursors live in `IntegrationConnection.syncState` (untyped JSON):
  `calendar.{cursor,nextLink,deltaLink}`, `mail.folders.{inbox,sentitems}.{...}`,
  `webhooks.subscriptions[]`. Page caps: **12 calendar pages / 12 mail pages per folder per run**,
  `hasMore` lets the client re-run. Backfill window: ±365 days.
- **Persistence** (`persistGraphEvent` / `persistGraphMessage`): upsert keyed on
  `(tenantId, source, externalId)`. Runs inside `withTenantRetry` with a **20s tx timeout** and,
  critically, a **per-tenant Postgres advisory lock** `pg_advisory_xact_lock(hashtext("msgraph-sync:<tenant>"))`
  ([line 1310](../../apps/api/src/engagement/microsoft/microsoft-graph-sync.service.ts)) that
  serializes a tenant's write txns cluster-wide. Contacts upserted **deduped + sorted by email**
  (deterministic lock order). These two are the fix for the June deadlock/refresh-storm incidents —
  **they are mandatory to replicate, and the lock key must be shared across providers** (see §9).
- **Association**: [client-association.service.ts](../../apps/api/src/engagement/client-association.service.ts)
  — `associate(tx, tenantId, {subject, body, attendeeEmails?, participantEmails?})`. Fully
  provider-agnostic. Honors manual overrides (`ClientAssociationOverride`) and `associationSignals.manual`.
- **Token refresh** (`getValidAccessToken`): scope-gate + 5-min skew; on `invalid_grant`/`AADSTS65001`/
  `consent` → `markConnectionNeedsReconnect` (status `needs_configuration`, friendly `lastError`). The
  refresh-storm bug is fixed by persisting the **canonical requested scopes**, not the provider's
  echoed scopes ([line 1059](../../apps/api/src/engagement/microsoft/microsoft-graph-sync.service.ts)).
- **Webhooks**: `configureSubscriptions` creates two Graph subscriptions (`me/events`, `me/messages`),
  6-day expiry, HMAC-signed `clientState`. `/notifications` (public, see below) validates `clientState`,
  **coalesces** notifications per `(connection, resource)`, fires one sync each.
- **Send**: `sendMail` posts JSON to `/me/sendMail` (`saveToSentItems:true`), supports HTML body,
  Cc/Bcc, file attachments (base64).
- **Public routes**: [tenant-context.middleware.ts:74](../../apps/api/src/tenant/tenant-context.middleware.ts)
  `bypassPaths` exempts `/api/engagement/integrations/microsoft/callback` and `/notifications` from
  Clerk/tenant auth. **Gmail's callback + push endpoints must be added here** (change-controlled file).
- **No scheduler**: `nextSyncAt` is written on error but read by nothing. Sync = manual + webhook only.
  (This is a latent gap we can optionally close for both providers — see §10 Phase 3.5.)
- **Change-control banner**: the MS OAuth/sync files carry a ⛔ "approval required" header. All
  auth/integration/token edits — including the middleware `bypassPaths` and the send-path dispatcher —
  require **explicit Neo approval** before merge/deploy.

---

## 3. What already exists and is reused as-is (no work)

- **Enums**: `EngagementProvider.google_workspace`, `EngagementSource.google` already in
  [schema.prisma:48](../../apps/api/prisma/schema.prisma). **No migration for enums.**
- **Models**: `IntegrationConnection`, `IntegrationConnectionToken`, `MailThread`, `MailMessage`,
  `Meeting`, `MeetingAttendee`, `EngagementContact`, `EngagementAttachment` are provider-neutral
  (`source`/`externalId` discriminated). Gmail writes `source=google`; unique keys don't collide with MS.
- **`syncState` is untyped `Json`** → Google cursors (`historyId`, `syncToken`, watch channel state)
  store freely with **no schema change**.
- **`TokenCryptoService`** — reused verbatim (shared `OAUTH_TOKEN_ENCRYPTION_KEY`).
- **`ClientAssociationService`** — reused verbatim.
- **`OAUTH_STATE_SECRET`** — reused for Google `state` + push-channel token signing.
- **Web UI**: [IntegrationsPage.tsx](../../apps/web/src/pages/settings/IntegrationsPage.tsx) already
  renders a "Google Workspace" card (currently a disabled "Connect OAuth" button).
- **`defaultScopes()`** ([engagement.service.ts:6749](../../apps/api/src/engagement/engagement.service.ts))
  already returns `gmail.readonly`/`gmail.send`/`calendar.readonly` for `google_workspace`.
- **`hasConnectedInbox()`** already counts `google_workspace` → inbox gating just works.
- **Consumers** (meetings/mail read endpoints, Radar, Intel, Meri tools) filter by tenant/client, not
  source → Gmail data appears with zero consumer changes.

**Net:** roughly half the system (data model, crypto, association, UI shell, downstream consumers)
is already Gmail-ready. The work is the OAuth adapter, the sync/fetch adapter, the send MIME path,
and the push infrastructure.

---

## 4. Architecture decision: adapter strategy

Three options considered:

- **A. Clone-and-adapt** — copy `microsoft/` → `google/`, thin send dispatcher. Fast; MS path
  untouched (respects change-control); ~1,000–1,500 lines duplicated.
- **B. Unify now** — extract an `EmailProvider` interface (`connect/refresh/syncCalendar/syncMail/
  send/configurePush/handlePush`) + shared core; rewrite MS as an adapter. Cleanest long-term; **high
  blast radius** on the change-controlled file; more up-front testing.
- **C. Hybrid (RECOMMENDED)** — new sibling `google/` module for the provider-specific fetch/OAuth
  (option A shape), **but** the provider-neutral pieces already exist as shared services
  (`ClientAssociationService`, `TokenCryptoService`) and the persistence pattern is copied, not
  re-abstracted. Introduce **one** genuinely shared new seam: a provider-dispatching
  **`EngagementMailSender`** for the send path (the only place shared outreach code must change).

**Rationale for C:** parity ships fast, the ⛔ MS OAuth/sync files stay frozen (no destabilization),
duplication is contained to fetch/mapping code that legitimately differs per API. A later refactor to
the unified interface (Phase 4, optional) is cheap once Gmail is proven in prod. We do **not** pay the
refactor-risk tax before the feature has earned it.

Proposed layout (new):
```
apps/api/src/engagement/google/
  google-oauth.service.ts        # OAuth2 client, state sign/verify (reuse pattern), token persist
  google-oauth.controller.ts     # /engagement/integrations/google/{capabilities,start,callback,:id/sync,:id/watch,notifications}
  google-sync.service.ts         # Gmail + Calendar fetch, map → shared persistence, watch/renew, push handler
  google-mime.ts                 # RFC-822 builder for messages.send
  (reuses) ../client-association.service, ../microsoft/token-crypto.service
apps/api/src/engagement/
  engagement-mail-sender.service.ts   # NEW: provider dispatcher (MS | Google) for outreach/Meri send
```
Wire providers/controllers into [engagement.module.ts](../../apps/api/src/engagement/engagement.module.ts).
`TokenCryptoService` should move to (or be re-exported from) a provider-neutral path to avoid a
`google/ → microsoft/` import edge; mechanically trivial, flag for review since it's a change-controlled file.

---

## 5. Gmail / Google API mapping (the substantive engineering)

### 5.1 OAuth (google-oauth.service.ts)
- Library: `googleapis` (or `google-auth-library`) `OAuth2Client`. **DESIGN:** Google uses a **client
  secret** (Web app client) — there is no MS-style cert confidential client for this flow. Secret lives
  in AWS Secrets Manager (never plaintext env). (capiro.ai's "no secrets" rule was an *Azure-tenant*
  policy, not ours — confirm in §12.)
- `generateAuthUrl({ access_type:'offline', prompt:'consent', include_granted_scopes:true, scope:[...],
  state })`. `access_type=offline` + `prompt=consent` is **required** to reliably receive a
  `refresh_token` (Google returns it only on first consent otherwise). `state` reuses the exact HMAC
  scheme (`signState`/`verifyState`) from the MS service.
- Callback: exchange code → `{access_token, refresh_token, expiry_date, scope, id_token}`. Derive
  account email from `id_token` (or `oauth2.userinfo`). Persist with `TokenCryptoService`; flip to
  `connected`. **Edge:** if `refresh_token` absent (re-consent without `prompt=consent`), keep the prior
  stored refresh token; if none exists, set `needs_configuration` with a "reconnect" message.
- Refresh: `OAuth2Client.refreshAccessToken()` equivalent. On `invalid_grant` → mirror
  `markConnectionNeedsReconnect`. Google **does not rotate** refresh tokens per-redemption (unlike
  Azure), so the MSAL-cache extraction dance is unnecessary — simpler.

### 5.2 Calendar sync (near 1:1 with Graph delta)
- Backfill/first run: `events.list('primary', { timeMin, timeMax, singleEvents:true,
  orderBy:'startTime', maxResults, pageToken })` over the ±365d window; paginate `pageToken` with the
  same 12-pages-per-run cap.
- Incremental: on the final page Google returns **`nextSyncToken`** → store in
  `syncState.calendar.syncToken`. Next run passes `syncToken` (omit timeMin/timeMax). **410 GONE** ⇒
  token invalidated ⇒ drop token, full re-sync (direct analog to Graph's resync-required).
- Map: `event.id`→`Meeting.externalId` (`source=google`); `summary`→subject; `description`→body;
  `start.dateTime||start.date`, `end...`; `organizer.email`; `attendees[].{email,responseStatus}`;
  `status==='cancelled'` ⇒ mark deleted (analog to `@removed`). Feed the **same** `association.associate`
  + `upsertContacts` + `MeetingAttendee` rebuild as `persistGraphEvent`.

### 5.3 Gmail sync (labels, not folders; history, not delta)
- Backfill: `messages.list({ q:'after:<epoch>', labelIds:['INBOX'] / ['SENT'], pageToken })` for the
  365d window → `messages.get({ id, format:'metadata' or 'full' })`. Use the **batch** endpoint to cut
  round-trips. `snippet` is the `bodyPreview` analog; walk `payload.parts` for text/plain (and HTML →
  optional `bodyHtmlS3Key`, currently unused by MS too).
- Incremental: baseline `historyId` from `getProfile` (or last `messages.get`). Store in
  `syncState.mail.historyId`. Next run `history.list({ startHistoryId, historyTypes:
  [messageAdded,messageDeleted,labelAdded,labelRemoved] })` → changed message IDs → `get`. **404** ⇒
  `startHistoryId` too old (Gmail history retention is short/best-effort) ⇒ full re-sync.
- Threading is **cleaner than Graph**: `message.threadId`→`MailThread.externalId`;
  `message.id`→`MailMessage.externalId`. Parse `From/To/Cc/Bcc/Date/Subject/Message-ID` from
  `payload.headers`. Feed the **same** persistence core (thread upsert, manual-override honoring,
  participants JSON, `MailMessage.upsert`) as `persistGraphMessage`. `labelIds` → `metadata.folder`
  equivalent (INBOX/SENT).

### 5.4 Send (google-mime.ts + messages.send)
- `messages.send({ raw: base64url(RFC-822) })`. Build MIME with a builder (e.g. nodemailer's
  `MailComposer` used to *compile*, not send, or `mimetext`) — headers (To/Cc/Bcc/Subject/From/
  MIME-Version), HTML body (reuse existing sanitized HTML from outreach), `multipart/mixed` for
  base64 attachments. Gmail **auto-stores in SENT** (no `saveToSentItems` flag needed).
- Input contract mirrors `MicrosoftGraphSendMailInput` so the dispatcher is a thin switch.

### 5.5 Realtime push (the biggest divergence from Graph)
Two **separate** mechanisms (Graph had one unified `/subscriptions`):
- **Gmail → Cloud Pub/Sub**: create a topic; grant `gmail-api-push@system.gserviceaccount.com`
  Publish. `users.watch({ topicName, labelIds:['INBOX','SENT'] })` returns `{historyId, expiration}`
  (**≤7 days**, Google recommends daily renewal). Pub/Sub **push subscription** → POSTs
  `{message:{data:base64({emailAddress,historyId})}}` to our public endpoint. Map `emailAddress`→
  connection → `history.list`. **Authenticity:** configure the push subscription with an OIDC token;
  verify JWT `aud`/`iss` (the `clientState` analog). Store `watch` state in `syncState.mail.watch`.
- **Calendar → events.watch**: `events.watch('primary', { id, type:'web_hook', address, token })`
  returns `{resourceId, expiration}`. Google POSTs header-only notifications
  (`X-Goog-Resource-State`, `X-Goog-Channel-Token`) — no body → we then `events.list(syncToken)`.
  Verify our `token`. Store `{channelId, resourceId, expiration}` in `syncState.calendar.watch`; must
  `channels.stop` on disconnect and **renew** before expiry.
- **Renewal**: watches expire ⇒ a **renewal cron** (EventBridge → `renew-google-watches` verb) is
  mandatory, unlike MS where the user re-clicks "Realtime". Alarm on watch-age.
- **Domain verification**: Google requires the push receiving domain (`app.capiro.ai`) be **verified**
  in the GCP project (Search Console / Webmaster). Without it, `watch`/`events.watch` are rejected.

**Recommendation:** Phase 1 ships **polling only** (parity with the manual "Sync now" experience,
which is all Outlook guarantees without the Realtime click). Push is Phase 3.

---

## 6. Data model & storage

- **No enum migration**, **no new required table**. Google cursors and watch/channel state live in the
  existing untyped `syncState` JSON, exactly like MS webhooks do today.
- **OPEN (optional):** a first-class `IntegrationWebhookChannel` table would make the renewal-cron
  query (`find channels expiring < 24h`) efficient and greppable vs. scanning `syncState` JSON across
  all connections. Not needed for parity; recommend deferring unless the cron's JSON scan is a concern.
- `EngagementContact.source` is free-text — Gmail uses `'google'`/`'gmail'` (MS uses `'microsoft_graph'`).
- Attachments: parity with MS = we currently store `hasAttachments` + `raw`, not attachment bytes to S3
  during sync (`EngagementAttachment` is populated by other flows). Gmail matches this — no attachment
  download during sync. (Send-side attachments already flow through the sender contract.)

---

## 7. Configuration & secrets (config.schema.ts, fail-closed)

New Zod keys (all `.optional()` so the feature is **inert until wired**, matching MS/Recall posture):
```
GOOGLE_CLIENT_ID
GOOGLE_CLIENT_SECRET
GOOGLE_REDIRECT_URI                  default https://app.capiro.ai/api/engagement/integrations/google/callback
GOOGLE_OAUTH_SUCCESS_REDIRECT        default /settings/integrations
GOOGLE_PUBSUB_TOPIC                  projects/<proj>/topics/<topic>          (Phase 3)
GOOGLE_PUSH_NOTIFICATION_URL         .../integrations/google/notifications   (Phase 3)
GOOGLE_PUSH_VERIFICATION_AUD         OIDC audience for Pub/Sub push verify   (Phase 3)
```
Reused: `OAUTH_STATE_SECRET`, `OAUTH_TOKEN_ENCRYPTION_KEY`. `capabilities()` returns
`configured:false` until the core set is present → the UI Google button stays disabled, the routes
`ServiceUnavailable`. **Deploy dark, enable by wiring secrets.**

---

## 8. Infrastructure & GCP setup (Phase 0, the long pole)

1. **GCP project** (billing account + org — see §12). Enable **Gmail API, Google Calendar API, Cloud
   Pub/Sub API**.
2. **OAuth consent screen**: user type **External** (customers are external Google accounts),
   app name/logo/support + privacy-policy URLs, scopes registered.
3. **OAuth 2.0 client** (Web application) → client ID + secret. Authorized redirect URIs:
   prod / staging / `localhost:4000` (mirror MS).
4. **Domain verification of `capiro.ai`** via Google Search Console (DNS-level Domain Property, a
   TXT record on the existing CDK-managed Route53 zone — add it out-of-band, not via `cdk deploy
   DnsStack`). **CORRECTED 2026-07-10:** this is required ONLY for the OAuth consent screen's
   "Authorized domains" list — verified research found Gmail push (`users.watch`) and Calendar push
   (`events.watch`) each need **no domain verification at all** (Gmail push needs only an IAM grant
   to `gmail-api-push@system.gserviceaccount.com` on a Pub/Sub topic; Calendar push needs only a
   valid HTTPS cert on the callback address; Google Cloud Pub/Sub's own docs state it "doesn't
   require proof of ownership for push subscription URL domains"). Full citations in
   [docs/runbooks/gmail-phase-0-google-verification.md](../runbooks/gmail-phase-0-google-verification.md) §2.3.
5. **Pub/Sub** (Phase 3 only, not needed for 0a): topic + push subscription (endpoint =
   `GOOGLE_PUSH_NOTIFICATION_URL`, OIDC auth) + IAM Publish grant to the Gmail push service account.
6. **AWS Secrets Manager**: store `GOOGLE_*` as `capiro/dev/GOOGLE_*` (no leading slash — required for
   the ECS exec role's `capiro/dev/*` grant); inject into the `capiro-dev-api` task def
   **out-of-band**, **not** via `cdk deploy Compute` — per the known CDK↔task-def drift
   (a `cdk deploy Compute` would drop drifted secrets incl. `MERIV2_*`, `STRIPE_*`). See infra memory.
7. **ALB**: callback/push are under `/api/...` → already routed to `capiro-dev-api` by path. **But**
   both must be added to `tenant-context.middleware.ts` `bypassPaths` (change-controlled).
8. **OAuth verification + CASA security assessment** — **CORRECTED 2026-07-10: cannot be submitted
   yet.** Verified research found Google will not accept a verification submission for an app still
   in Testing/Development/Staging status — the app must already be flipped to Production with a
   real, working, deployed OAuth flow, and the mandatory demo video must show that actual flow. This
   step moves to Phase 0b, after Phase 1 ships. See §10 and the runbook §1/§4 for the corrected
   sequencing and full citations.

---

## 9. Concurrency, idempotency, correctness (replicate the June fixes exactly)

These are non-negotiable — they encode production incidents already paid for on the MS side:

- **Advisory lock — provider-neutral key.** Gmail/Calendar persist txns must take the **same**
  `pg_advisory_xact_lock` as MS, keyed **per tenant, not per provider**. Rename the key to
  `engagement-sync:<tenant>` (used by both adapters). **Why it matters:** a Google sync and an Outlook
  sync for the same tenant/user both upsert `engagement_contacts` on `(tenant,email)` — different lock
  key ⇒ the exact cross-provider deadlock the MS fix eliminated returns. This is a concrete, testable
  requirement (see §13 cross-provider deadlock test).
- **Sorted+deduped contact upsert** (copy `upsertContacts`).
- **20s tx timeout + `withTenantRetry`** around each persist.
- **Idempotent upserts** on `(tenant, source, externalId)` — makes Pub/Sub **at-least-once /
  duplicate / out-of-order** delivery safe by construction.
- **Notification coalescing** per `(connection, resource)` (copy the `handleNotifications` map).
- **Page caps + `hasMore`** re-run semantics (copy).
- **Retry/backoff** on 429/5xx with `Retry-After` (copy `graphFetch`'s retry; Gmail/Calendar return
  429 + per-user rate-limit errors).
- **Cursor-expiry fallbacks**: Calendar 410 → full resync; Gmail history 404 → full resync. Must be
  explicit branches, not crashes.

---

## 10. Delivery sequencing (phased, each with entry/exit gates)

Every phase gate: change-control approval (Neo) for auth/integration/middleware edits;
`pnpm typecheck` + prettier + tests (repo `pnpm lint` is known-broken — do **not** gate on it);
`/verify` run against the real flow.

- **Phase 0a — GCP + OAuth client setup, Testing status only (start Day 0). No code.**
  Project, APIs, consent screen (stays in Testing), OAuth client, domain verification, draft (don't
  submit) scope-justification text. **CORRECTED 2026-07-10 — this is as far as Phase 0 can go before
  Phase 1 exists**, per verified Google policy: submission requires a live Production flow to already
  be running and a demo video of that real flow, so "submit verification" cannot be this phase's exit
  criterion. *Exit:* Testing-mode OAuth client (ID+secret) usable by dev. Blocked today on a
  legitimate Capiro GCP identity — see runbook §0.

- **Phase 1 — Connect + read-only sync (polling) + UI. (~1–1.5 wk)**
  `google-oauth.service/controller`, token persist, `capabilities()`; `google-sync` Calendar
  (`events.list`+`syncToken`) and Gmail (`messages.list`+`history.list`) with the §9 machinery; enable
  the Google card in `IntegrationsPage.tsx` (start/sync mutations + callback effect for
  `provider=google_workspace`). Runs against the Phase 0a Testing-mode client — Google explicitly
  exempts Testing/dev/staging apps from verification, so this is the sanctioned "build first" window
  (≤100 test users, 7-day tokens). Finalize the exact scope list and consent-screen fields here —
  changing them after Phase 0b submission restarts the review clock.
  *Exit:* a Google account connects; mail threads + meetings appear as `source=google` in Engagement /
  Radar / Intel, tenant-isolated; reuses crypto + association + shared lock; MS path untouched; the
  flow is stable enough to film as the Phase 0b demo video.

- **Phase 0b — Verification submission + CASA (only after Phase 1 is stable). Budget 2–4 months.**
  Flip to Production, record the demo video of the real flow, submit scope justification, await
  Google's review (~6 weeks quoted, not guaranteed), receive Google's CASA tier assignment by email
  (Tier 2 plausible for Capiro's profile per a comparable B2B precedent, not guaranteed — do not
  self-initiate, it forces Tier 3), engage an ADA-authorized assessor (~$500–$1,800 Tier 2 / ~$4,500–
  $8,000+ Tier 3, recurring annually), submit the resulting Letter of Validation. See the runbook §4
  for the full process, real-world cost/timeline evidence, and citations.
  *Exit:* app is verified and **In Production** — no user cap, no 7-day token expiry. GA-ready.

- **Phase 2 — Send (outreach + Meri). (~3–4 d)**
  `google-mime.ts` + `GoogleMailSender`; introduce `EngagementMailSender` dispatcher; replace the **9**
  direct `microsoftGraph.sendMail` call sites (6 in `engagement.service.ts`, 3 in `meri-tools.service.ts`)
  with `sender.send(...)` routed by the user's connected provider.
  *Exit:* an outreach campaign + Meri "send on behalf" send via Gmail; Outlook send unchanged;
  `campaignSendingProvider` reported correctly per connection.

- **Phase 3 — Realtime push. (~1–1.5 wk)**
  Gmail `users.watch`+Pub/Sub push endpoint (OIDC verify); Calendar `events.watch` channel (token
  verify); add both public routes to `bypassPaths`; **renewal cron** (EventBridge → `renew-google-watches`).
  *Exit:* new mail/events sync within seconds without a manual click; watches auto-renew; alarm on
  stale watch.

- **Phase 3.5 — Scheduled safety-net poll (RECOMMENDED, closes an existing gap). (~2–3 d)**
  A cron that polls due connections (`nextSyncAt`/staleness) for **both** providers. Today Outlook has
  no fallback if a webhook is missed; this hardens both. In scope only if approved (§12).

- **Phase 4 — Unify to `EmailProvider` interface (OPTIONAL, post-GA).**
  Refactor MS + Google onto one interface once Gmail is proven. Deferred by design.

**GA is gated on Phase 0b verification**, which cannot start until Phase 1 ships — not purely "gated
on Phase 0" as originally stated. Phases 1–2 can be prod-dark behind unset secrets while 0b runs.

---

## 11. Security & compliance — the real risk (not the code)

- **Restricted-scope verification + CASA.** `gmail.readonly` is a **restricted** scope → Google
  requires app verification **plus an annual third-party CASA security assessment** by an ADA-listed
  authorized assessor (Google itself does not tier, charge, or broker this — it's a direct developer↔
  assessor contract). `gmail.send` and `calendar.readonly` are **sensitive** (verification, no CASA).
  **Corrected 2026-07-10 with real sourced numbers** (was a vague "low-thousands" guess): Google
  assigns the tier itself by risk calculation, not by scope alone — Tier 2 costs realistically
  ~$500–$1,800/yr (a comparable B2B SaaS requesting `gmail.readonly` was assigned Tier 2, not
  guaranteed for Capiro); Tier 3, if assigned, runs ~$4,500–$8,000+/yr. **This recurs annually**, not
  once — Google's non-renewal language is non-committal ("use of the API may be suspended") with no
  published grace period, so this needs a permanent owner, not a one-time Phase 0 task. Full
  cost/tier/process evidence in the runbook §4.4. This is the Google analog to — and heavier than —
  the MS publisher-verification/admin-consent saga.
- **Publishing status.** In **Testing**: ≤100 users and **refresh tokens expire in 7 days** (fine for a
  pilot, not prod). Must move to **In Production** (and pass verification) for durable tokens and no
  100-user cap.
- **Workspace admin App Access Control.** Security-conscious customers block unconfigured third-party
  apps; their Workspace admin must **trust/allowlist** our app (the admin-consent analog — same reality
  we hit with c2strategies on Outlook). Must be documented in onboarding.
- **Least privilege.** If Intel/association can run on headers+snippet, `gmail.metadata` (sensitive,
  **not** restricted, no CASA) is dramatically cheaper to ship — at the cost of body text. This is a
  real product tradeoff (§12).
- **SOC 2 / data scope.** Reading customer mail expands the data footprint: the DPA must cover Google
  data; the GDPR/erasure path must delete `mail_threads`/`mail_messages`/`meetings` for `source=google`
  (ties into the already-tracked MeriV2 erasure gap); tokens stay AES-GCM at rest (reused) + RLS.
- **Push authenticity.** Verify Pub/Sub OIDC token (`aud`/`iss`) and Calendar channel `token` — the
  `clientState` HMAC analog. Never trust an unverified push to trigger a sync.

---

## 12. DECISIONS — sign-off status

**RESOLVED 2026-07-10 (Ninja):**

1. ✅ **Gmail scope depth = `gmail.readonly` (full bodies).** RESTRICTED scope → the annual
   third-party **CASA Tier 2 assessment is committed and on the critical path**. Full body text →
   Intel/association reaches true Outlook parity. Consequence: Phase 0 verification is now a hard GA
   gate; budget + assessor engagement must be secured up front.
2. ✅ **Launch posture = production-grade, like Outlook.** No permanent Testing-mode/pilot launch.
   The app must reach **"In Production" publishing status** with full OAuth verification + CASA passed
   → durable refresh tokens, no 100-user cap, no "unverified app" screen. Testing mode is used **only
   as a dev/internal staging step** to build and validate Phases 1–2 while verification runs in
   parallel; customers are onboarded only after production verification clears.
4. ✅ **Adapter strategy = clone-and-adapt** (§4-C). Sibling `google/` module; Outlook's
   change-controlled files stay frozen; unify later (Phase 4, optional).

**STILL OPEN — need an answer before Phase 0 can complete:**

3. **GCP project ownership.** Which GCP org/billing account? Who administers the project + Pub/Sub?
   *(Blocks Phase 0 — the verification submission is tied to a specific project + support/privacy URLs.)*
5. **Scheduled safety-net poll (Phase 3.5).** In scope? (Recommended — hardens Outlook too.)

**RECOMMENDED defaults (proceeding unless overridden):**

6. **Advisory-lock key** made **provider-neutral per-tenant** (`engagement-sync:<tenant>`) — a tenant's
   MS + Google syncs serialize (correct; prevents the June cross-provider `engagement_contacts` deadlock).
7. **Client secret** in AWS Secrets Manager (Google has no MS-style cert confidential-client for this
   flow; capiro.ai's no-secret rule was an Azure-tenant policy, not ours).

---

## 13. Testing strategy

- **Unit:** MIME builder (headers/HTML/attachments/encoding); Gmail+Calendar → normalized-DTO mappers;
  history/syncToken cursor + expiry-fallback branches; scope gate (mirror
  `microsoft-graph-sync.scopes.spec.ts`); state sign/verify parity.
- **Integration (mocked Google APIs):** connect→callback→persist; backfill pagination + page-cap
  `hasMore`; incremental via history/syncToken; 404/410 → full-resync; 429 backoff.
- **Idempotency:** replay the same Pub/Sub push twice ⇒ no duplicate rows.
- **Cross-provider deadlock:** concurrent MS + Google sync for the same tenant/user ⇒ no 40P01 (proves
  the shared lock key, §9).
- **E2E (Testing mode + a real dev Google account):** connect, sync, see `source=google` data, send an
  outreach test, verify push arrives (Phase 3).
- **Diag verb:** `diag-google-sync` (read-only, RLS-bypassed, run as one-off ECS task with
  `TMPDIR=/dev/shm`), mirroring `diag-outlook-sync`.

---

## 14. Observability & ops

- Structured logs per phase (connect, per-page sync stats, refresh, push receipt/verify, watch
  renew) with `{tenantId, connectionId}` — mirror the MS logger.
- Surface `IntegrationConnection.lastError`/`status` in the UI (already wired).
- SNS alarms: Google connection error-rate; **stale-watch age** (push silently stopped); refresh
  failure spikes (the Google refresh-storm early-warning).
- `capabilities()` on the settings page shows configured/scopes for support triage.

---

## 15. Rollout & rollback

- **Fail-closed & dark by default:** no `GOOGLE_*` ⇒ `capabilities:false` ⇒ button disabled, routes 503.
- **Enable per-env** by wiring Secrets Manager values into the task def out-of-band; no code deploy to
  toggle.
- **Rollback:** unset the secrets (feature goes inert) and/or hide the Google button. **No schema
  migration to revert.** Per-connection kill via `status=disabled`.
- **Blast-radius guarantee:** with clone-and-adapt, a Gmail defect cannot regress the Outlook path
  (separate module, separate routes) except through the shared send dispatcher and the shared advisory
  lock — both explicitly covered by tests in §13.

---

## 16. Effort summary

**Corrected 2026-07-10 — the phase order changed** (§10): Phase 0 splits around Phase 1, it does not
precede it. See [the Phase 0 runbook](../runbooks/gmail-phase-0-google-verification.md) for citations.

| Phase | Scope | Eng effort | Gating |
|---|---|---|---|
| 0a | GCP project + Testing-mode OAuth client + domain verification | no code, ~1–2 days once unblocked | **GCP identity (blocking now)** |
| 1 | Connect + read-only polling sync + UI | ~1–1.5 wk | Neo approval (auth) |
| 2 | Send dispatcher + Gmail MIME | ~3–4 d | Neo approval (send path) |
| 0b | Verification submission + CASA (Tier 2 realistic ~$500–1,800/yr, Tier 3 possible ~$4,500–8,000+/yr, recurring) | no code, **budget 2–4 months calendar** | Phase 1 stable + assessor engagement |
| 3 | Realtime push + renewal cron | ~1–1.5 wk | Pub/Sub setup (no domain verify needed) |
| 3.5 | Safety-net poll (both providers) | ~2–3 d | opt-in (§12.5) |
| 4 | Unify provider interface | optional, post-GA | — |

**Coding ≈ 2.5–3.5 weeks, and it is NOT blocked on Google verification — Phase 1 runs in Testing mode
while Phase 0b's 2–4 month clock is still ahead of it.** What IS blocked right now, before any of this
can start, is Phase 0a's GCP identity (§0 in the runbook). Once that's resolved, Phase 0a is ~1–2 days
of mechanical setup and Phase 1 coding can begin immediately.
