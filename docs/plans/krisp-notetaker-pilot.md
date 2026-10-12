# Krisp Notetaker

Krisp is a personal OAuth connection in Meri integrations. A user explicitly enables
automatic imports and may select a Krisp folder. The Engagement background owner polls
every three minutes and copies Krisp's existing notes verbatim into both Meeting Notes
and Debrief. No Meri model or debrief generator is invoked. Notes and debriefs are encrypted, approved, private,
and committed together with import completion. This integration does not store an additional
raw transcript or change/delete the user's originals in Krisp.

## Rollout

- Apply `20261005160000_krisp_notetaker` before running the new API/worker code.
  It creates user- and tenant-isolated preference/import tables and enables
  `settings_jsonb.clioFeatureFlags["notetaker.krisp.enabled"]` only for
  `capiro-internal` and `c2-strategies`, preserving their other settings.
- The initial two-tenant pilot restriction has been removed. Any tenant with
  `notetaker.krisp.enabled=true` can use the connector, OAuth callback, tools,
  settings routes, and worker. The October 5 expansion enables this flag for all
  existing tenants; missing/false flags still disable access.
- The existing MCP OAuth callback, token encryption, notes encryption
  configuration must already work. `CLIO_MCP_ENABLED=false` disables
  MCP access. `MERI_MCP_KRISP_ENABLED=false` additionally disables Krisp provider access.
- The existing Engagement runtime policy selects the sole background owner and
  disables polling/provider calls in a shadow process. No second scheduler is needed.
- Each user connects their own account and enables imports. New meetings start from
  the enable time; polling considers the most recent seven days. Existing discovered
  imports retain their own retry state. Changing folder/reconnecting requires renewed
  opt-in and discards unfinished jobs from the previous scope.
- Disable access by setting `notetaker.krisp.enabled=false` for a tenant.
  Gate and connection checks are fresh, including before artifact commit.
  Existing notes/debriefs remain available. Disconnecting also stops access.

## Matching and recovery

Only meetings owned by the connected user are candidates. Match by a unique calendar
identifier within ten minutes, otherwise a unique join URL or matching organizer,
subject, and time. Ambiguous/unmatched records appear in Meri integrations for explicit
selection from the user's meetings near that date. A deleted/inaccessible/reassigned
meeting cannot receive an in-flight imported artifact.

Durable imports are unique per tenant, user, and Krisp document ID. Compare-and-set
leases fence competing workers. Notes, debrief, and completion are one transaction;
partial failures roll back. A disconnected account, disabled preference/flag, inactive
membership, or changed meeting is rechecked before save. Completed import tombstones
prevent retries from recreating manually deleted artifacts. Provider/write failures
retry up to ten times, with manual retry by selecting a meeting again. Waiting for a
Krisp notes does not consume that failure budget.

## Provider verification and limits

The live unauthenticated endpoint was checked on October 5, 2026:

- `https://mcp.krisp.ai/mcp` responds with a 401 challenge pointing to
  `https://mcp.krisp.ai/.well-known/oauth-protected-resource`.
- Authorization metadata advertises dynamic registration, S256 PKCE, and confidential
  client authentication. Krisp registration requests `client_secret_post`; the existing
  encrypted OAuth credential store persists the returned secret. Other connectors keep
  their previous registration behavior.
- Only the advertised read scopes for user identity, meeting metadata/notes/transcripts,
  and meeting listing are requested. Only `search_meetings`, `get_multiple_documents`,
  and `list_folders` are permitted by the managed tool allowlist.

Authenticated tool schemas and JSON response shapes were verified on October 6, 2026.
Search uses `after`/`before`, `folder_ids`, `limit=50`, and `offset`. Its `count` is
only the page count, so a full page requires fetching the next page. Documents use
`get_multiple_documents({ ids, include: ['notes'], format: 'json' })`; the returned
`results[].document.notes` string is preserved exactly. A missing notes body waits
for Krisp and never falls back to transcript, summary, or Meri generation. The
requested document ID is checked at both envelope and document level.

The MCP API does not document starting a live meeting recorder. Krisp must capture
the meeting separately. Notes above 100,000 characters or explicitly truncated
responses fail closed, below the provider's 120,000-character response limit.
Automatic searches beyond 20 pages require a narrower scope.

## Operator backfill

`apps/api/scripts/lib/krisp-backfill.cjs` is an operator-only library with a dry-run
default. It takes an exact tenant/user context, active personal connection and
preference, bounded dates, and an explicit historical-meeting option. It reuses
the worker's authorization, ownership, lease, encryption, and atomic paired-save
path; it never bootstraps the application or calls a model. Completed/skipped
imports and active leases are preserved. Historical meetings have a deterministic
per-user Krisp ID, original timestamps, private visibility, and no guessed client.
Existing manual notes are never replaced. Readback decrypts both saved artifacts
and verifies equal text without logging their contents. A rerun skips completed
imports. Only run apply after the direct-notes worker is deployed, so an old
worker cannot claim a backfill record and generate text.

References:

- [Krisp integration guide](https://help.krisp.ai/hc/en-us/articles/25416400191004-Krisp-MCP-Integrating-your-own-MCP-client)
- [Krisp tools](https://help.krisp.ai/hc/en-us/articles/25416265429660-Krisp-MCP-Supported-tools)

## Validation

- API and web TypeScript checks.
- Focused backend tests: tenant/OAuth/tool gates, revoked access, lease fencing,
  atomic rollback/retry, notes readiness, and unchanged Recall behavior.
- UI tests: explicit opt-in, folder selection, disconnected state, ambiguous meeting
  selection, and existing managed OAuth interactions.
- `pnpm --filter @capiro/api exec tsx scripts/verify-krisp-notetaker-db.ts --verify` uses an
  ephemeral embedded PostgreSQL database to verify the migration, flag scope,
  user/tenant RLS, duplicate uniqueness, and disconnect cascade behavior.
- Headless desktop/mobile component preview with representative API responses: no
  browser exceptions or horizontal overflow, and meeting selection works.

Live acceptance: in each pilot tenant connect a user's Krisp account, enable a folder,
capture a new meeting, verify one encrypted note/debrief pair, repeat a worker pass,
then verify disconnect and flag rollback prevent another import. Confirm a third
tenant cannot see/connect the feature. This requires rollout and user authorization;
it is not covered by the local fixtures.
