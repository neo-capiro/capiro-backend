# LegiWatch LW-01–03: rollout and verification

Prepared September 9, 2026. This change repairs coverage wording, committee identity handling, capture/source status summaries, and discovery of saved browser captures. **Deployment, ingestion replay, and production identity repair have not been performed.** Passing local tests does not establish that the two Airland records or the Fauci association are repaired in production.

## Behavior being shipped

| Issue | Changed behavior | Evidence still required after rollout |
| --- | --- | --- |
| LW-01 | An empty committee room describes missing or unverified coverage. Parent-source health cannot establish a successful child-calendar check. Published child codes normalize to their parent and child slots; compatible legacy child codes can be read without changing hearing IDs. | Inspect the actual Airland records and provenance, replay the appropriate source if needed, and confirm both dated proceedings appear in the child room. |
| LW-02 | Capture attention, selected-week live proceedings, and registered committee-source health are separate summaries. Interrupted captures remain visible; loading/error states remain unknown. | A failing source and an interrupted session appear simultaneously without a global all-clear claim. |
| LW-03 | `GET /api/legiwatch/live-hearings/events/:id/sessions` returns accessible saved-session metadata and recording links. Archive transcript filters consider associated saved transcripts while public counts remain separate. | Establish the real Fauci identity association and confirm search, public detail, Archive and My Sessions reach the saved room. |

The saved-session bridge applies an explicit tenant predicate to sessions and child counts. Private session visibility uses the Clerk creator ID, matching intel-api. It reads metadata and counts only; it does not decrypt, copy or publish tenant transcript/intelligence bodies.

An existing `hearing_id` takes precedence. An unlinked or orphaned public hearing/markup session may be associated through an exact official page/media URL already present in the public corpus, only if that identity resolves to one hearing. Registered source URLs and generic calendar/listing paths are excluded even when only one hearing has been imported. Media/player URLs additionally require a recognized event-specific provider identity: a YouTube video ID, a dated Senate ISVP filename, or the Senate Akamai dated committee-recording path. Unknown media needs an explicit hearing ID. Titles, dates and similar words are insufficient. Ambiguous canonical records fail closed. Detail requests bound session metadata to the requested hearing while source-identity uniqueness is checked across the full public corpus. Missing intel tables produce `savedSessionsState: unavailable`, not a verified empty session list.

## Reproduce the tests

Use a checkout with dependencies installed and Prisma clients generated according to the repository setup. Build the shared package if its local exports have not been built:

```bash
pnpm --filter @capiro/shared build
```

For the SQL test, configure `DATABASE_URL` to a **disposable PostgreSQL database** reachable from the test runner. Its test role must be able to create temporary tables and a temporary-purpose schema. The suite creates temporary tables on one connection and a generated helper-function schema, then removes the schema. It does not require the full application migration chain. It must not point at production. If `DATABASE_URL` is absent the integration suite is skipped, which is not a passing SQL proof.

From the repository root:

```bash
pnpm --filter @capiro/api exec jest src/live-hearings/legiwatch-saved-sessions-pg.integration.spec.ts --runInBand
pnpm --filter @capiro/api exec jest src/hearing-discovery/hearing-committee-identity.spec.ts src/hearing-discovery/adapters/congress-gov-committee-identity.spec.ts src/live-hearings/live-hearings.service.spec.ts src/live-hearings/committee-directory.service.spec.ts scripts/sync-hearings-zone-guard.spec.ts --runInBand
pnpm --filter @capiro/api exec jest src/live-hearings/legiwatch-wave1-attendance.spec.ts src/live-hearings/legiwatch-wave1-relevance.spec.ts src/live-hearings/legiwatch-wave1-committee-routes.http.spec.ts --runInBand
pnpm --filter @capiro/web exec vitest run src/vnext/pages/legiwatch/hearings/hearing-health-status.integration.test.tsx src/vnext/pages/legiwatch/hearings/hearing-detail-navigation.integration.test.tsx src/vnext/pages/legiwatch/hearings/saved-hearing-identity.integration.test.tsx src/vnext/pages/legiwatch/hearings/saved-hearing-sessions.integration.test.tsx
```

The SQL suite runs production discovery and Archive SQL, including tenant/private isolation, final-segment counts, room-card deduplication, direct-ID precedence, unique official URLs, ambiguity refusal, positive and negative transcript filters, facets, paging, and explicit unavailable-state handling. The repair session also executed this suite using PGlite; the PostgreSQL command above is the portable reproduction path and does not depend on the session's scratch adapters.

`.github/workflows/legiwatch-ci.yml` supplies PostgreSQL 16 for a dedicated saved-session SQL step and checks its Jest summary for a real suite/test execution. The ordinary mock-test step excludes this SQL suite, preventing an absent database from being mistaken for SQL verification.

## Release sequence

1. Record the reviewed commit and build immutable API and web images from it. Include the repaired hearing ingestion code in the image used by hearing jobs.
2. Verify the target environment has the existing intel tables used by the bridge: `intel_live_hearing_session`, `intel_transcript_segment`, and `intel_live_summary_card`. This repair introduces no new schema migration. Missing rails must stay visibly unavailable.
3. Deploy API, then web through the normal release process. Verify deployed image digests and commit identifiers. Deploy the repaired ingestion job image before any replay.
4. Run the read-only inspection below with the affected user's verified tenant and Clerk identity. Do not guess those IDs from a client name.
5. If source data or association evidence is missing, complete the authorized, provenance-backed repair described below. Then execute the complete browser matrix.

## Read-only production inspection

Run these statements through the existing authorized database access path. They use PostgreSQL prepared statements and a read-only transaction. In `psql`, supply the verified tenant and Clerk IDs using `qa_tenant_id` and `qa_clerk_id`; the `:'variable'` syntax quotes their values safely. Do not paste credentials into logs or commit query results containing tenant metadata.

```sql
BEGIN READ ONLY;
SELECT set_config('app.current_tenant', :'qa_tenant_id', true);

PREPARE inspect_hearing(text) AS
SELECT id, title, date, starts_at, event_status, visibility,
       committee_code, committee_system_code, subcommittee_system_code, url
FROM committee_hearing WHERE id = $1;
EXECUTE inspect_hearing('119-64382-2026-07-29');

PREPARE inspect_saved_session(text, text, text) AS
SELECT s.id, s.hearing_id, s.title, s.status, s.source_type, s.source_url,
       s.created_by, s.started_at, s.ended_at,
       (SELECT count(*) FROM intel_transcript_segment seg
        WHERE seg.tenant_id = $1 AND seg.session_id = s.id AND seg.is_final) AS saved_final_segments,
       (SELECT count(DISTINCT coalesce(card.segment_id, card.id))
        FROM intel_live_summary_card card
        WHERE card.tenant_id = $1 AND card.session_id = s.id) AS saved_room_moments
FROM intel_live_hearing_session s
WHERE s.tenant_id = $1 AND s.id = $3
  AND (s.source_type::text IN ('hearing', 'markup') OR s.created_by = $2);
EXECUTE inspect_saved_session(:'qa_tenant_id', :'qa_clerk_id', 'cms64c5ne0088kouo5vdxrms0');

PREPARE inspect_candidates(text) AS
SELECT id, hearing_id, provider, official_page_url, media_url,
       resolution_state, capture_policy, source_id
FROM hearing_stream_candidate WHERE hearing_id = $1 ORDER BY priority, id;
EXECUTE inspect_candidates('119-64382-2026-07-29');

-- Execute this with the EXACT stored session source_url too, if it differs.
-- The URL below was observed in the saved room's official player during QA;
-- that browser observation alone is not permission to fabricate a corpus link.
PREPARE inspect_official_identity(text) AS
WITH matches AS (
  SELECT DISTINCT h.id, h.title, h.date, h.url
  FROM committee_hearing h
  LEFT JOIN hearing_stream_candidate sc ON sc.hearing_id = h.id
  WHERE h.visibility = 'public'
    AND (h.url = $1 OR sc.official_page_url = $1 OR sc.media_url = $1)
)
SELECT *, count(*) OVER () AS matching_public_hearings FROM matches ORDER BY date, id;
EXECUTE inspect_official_identity('https://www-senate-gov-media-srs.akamaized.net/hls/live/2036792/govtaff/govtaff072926/master.m3u8');

PREPARE inspect_provenance(text) AS
SELECT o.hearing_id, o.external_event_id, o.observed_title, o.observed_date,
       o.observed_status, o.first_seen_at, o.last_seen_at,
       s.adapter_key, s.source_url, o.source_metadata
FROM hearing_source_observation o
JOIN committee_source s ON s.id = o.source_id
WHERE o.hearing_id = $1 ORDER BY o.last_seen_at DESC;
EXECUTE inspect_provenance('119-64382-2026-07-29');

PREPARE inspect_airland(text, text, date, date) AS
SELECT id, title, date, committee_code, committee_system_code,
       subcommittee_system_code, visibility, event_status, url
FROM committee_hearing
WHERE date BETWEEN $3 AND $4
  AND (committee_code IN ($1, $2) OR committee_system_code IN ($1, $2)
       OR subcommittee_system_code = $1)
ORDER BY date, id;
EXECUTE inspect_airland('ssas14', 'ssas00', DATE '2025-09-09', DATE '2026-09-08');

-- Also inspect all Senate records on the two dates: filtering only existing
-- committee codes could hide precisely the misfiled records being repaired.
SELECT id, date, title, committee_name, committee_code,
       committee_system_code, subcommittee_system_code, url, visibility, event_status
FROM committee_hearing
WHERE date IN (DATE '2026-05-12', DATE '2026-06-09') AND lower(chamber) = 'senate'
ORDER BY date, id;

SELECT hearing_id, external_event_id, observed_date,
       source_metadata->'event'->>'committeeSystemCode' AS observed_parent,
       source_metadata->'event'->>'subcommitteeSystemCode' AS observed_child,
       source_metadata->'event'->>'officialPageUrl' AS official_page,
       source_metadata->'event'->'raw'->'committees' AS published_bodies
FROM hearing_source_observation
WHERE observed_date IN (DATE '2026-05-12', DATE '2026-06-09')
ORDER BY observed_date, external_event_id;

PREPARE inspect_sources(text, text) AS
SELECT id, committee_system_code, adapter_key, source_url, enabled,
       source_health, last_checked_at, last_success_at, last_error_at, last_error
FROM committee_source
WHERE committee_system_code IN ($1, $2)
ORDER BY committee_system_code, adapter_key, source_url;
EXECUTE inspect_sources('ssas14', 'ssas00');

SELECT source_health, count(*) AS sources
FROM committee_source WHERE enabled GROUP BY source_health ORDER BY source_health;

ROLLBACK;
DEALLOCATE ALL;
```

The Airland query intentionally returns parent and child rows for inspection. It does not assert that every parent hearing belongs to Airland. Inspect each relevant record's `hearing_source_observation` using the prepared provenance query before deciding which identity is supported.

An empty saved-session result may mean the wrong tenant/Clerk context, an inaccessible private session, or a missing row. Investigate that distinction through the normal authorized path; do not broaden the query to disclose other tenants' records.

## Airland source repair

The acceptance evidence is the May 12, 2026 Air Force modernization hearing and the June 9, 2026 Airland NDAA markup. Both fall inside the reported September 9, 2025–September 8, 2026 window. Primary references:

- [Government video record for the May 12 hearing](https://www.war.gov/Multimedia/videoid/1006611/dvpmoduleid/5963/).
- [Senate May 12 Air Force modernization page](https://www.armed-services.senate.gov/hearings/to-receive-testimony-on-air-force-modernization-in-review-of-the-defense-authorization-request-for-fiscal-year-2027-and-the-future-years-defense-program), which explicitly names the Airland subcommittee.
- [Senate Airland markup page](https://www.armed-services.senate.gov/hearings/to-markup-the-airland-portion-of-the-national-defense-authorization-act-for-fiscal-year-2027).
- [Congressional Record Daily Digest listing the June 9 Airland business meeting](https://www.govinfo.gov/content/pkg/CREC-2026-06-08/html/CREC-2026-06-08-pt1-PgD600.htm).

The June 9 markup is a closed meeting with no public broadcast. The Senate page's template labels it “Full Committee Hearing”; use the Daily Digest's explicit Airland assignment when evaluating that conflicting metadata. No verified Congress.gov event-ID permalink has been established for these two records in this repair session.

First determine whether those proceedings are absent or merely stored under legacy child codes. The repaired read normalization can expose an explicitly stored child without a data rewrite. A canonical child takes precedence over legacy fields; conflicting parent/child codes require provenance review.

For canonical discovery, `discover:hearings` supports source selection, an explicit Congress, a full rescan, page limits and a real dry run. Use the repaired job image and its normal Congress API configuration. Capture the dry-run output before the authorized write replay:

```bash
pnpm --filter @capiro/api discover:hearings -- --source=congress-gov --congress=119 --full --max-pages=40 --list-limit=250 --delay-ms=150 --dry-run
```

The corresponding write replay is:

```bash
pnpm --filter @capiro/api discover:hearings -- --source=congress-gov --congress=119 --full --max-pages=40 --list-limit=250 --delay-ms=150
```

`--full` ignores the incremental watermark; it does not remove pagination limits or guarantee that Congress.gov supplies every Senate event. Verify the adapter's observed records, page exhaustion and errors, then inspect persisted provenance and child identities. A source fetch succeeding is not proof that the two target proceedings were retrieved.

The separate legacy command is:

```bash
HOUSE_DOCS_ENABLED=false pnpm --filter @capiro/api sync:hearings
```

At this revision, `sync:hearings` targets Congress **119** in code. It reads committee-meeting schedules (up to 40 × 250 list rows), published hearings (up to 30 × 100), and, by default, the next 21 days of the House repository. It performs broad direct upserts and requires `CONGRESS_API_KEY` and target database access. It has **no supported dry-run or Congress CLI argument**; appending `--dry-run` does not prevent writes. Use it only as an explicitly selected legacy refresh, not as a substitute for checking source provenance or as a purported read-only command.

The command above disables the unrelated House repository pass. It still refetches and reprocesses every fetched Congress 119 detail, with no incremental watermark or existing-row skip. Neither replay command imports arbitrary Senate-page URLs. The generic committee-site adapter does not discover events, and the Senate-calendar adapter's manual provenance backfill covers already-present events; neither is a general missing-event importer.

If the official Airland records are absent from the selected adapter, repair the appropriate official-source adapter/ingestion path through the normal reviewed process. Do not manufacture hearing records or child associations from the words “Airland” in a title. Until both records are ingested and verified, the UI must continue to say child coverage is incomplete or unverified.

## Fauci association repair decision

The browser QA observed 710 saved segments and 19 displayed moments in [the saved Fauci room](https://os.capiro.ai/intelligence/hearing-watch/cms64c5ne0088kouo5vdxrms0). These are observed QA counts, not permanent expected database constants. [The public hearing](https://os.capiro.ai/legiwatch/hearings/119-64382-2026-07-29) also has a [published GovInfo transcript](https://www.govinfo.gov/content/pkg/CHRG-119shrg64382/html/CHRG-119shrg64382.htm).

1. If the accessible session's existing `hearing_id` is the public target, the bridge should expose it immediately after deployment.
2. If it is unlinked/orphaned and its exact stored official source resolves uniquely to that hearing, the bridge should expose it with `association: official_source` without a data write.
3. If an existing hearing ID points elsewhere, inspect that hearing and both provenance histories. The bridge deliberately preserves the explicit association.
4. If the source matches multiple hearings, or no durable official-source association exists, leave the automatic association unresolved. Validate the official event/transcript/media chain and capture provenance, prepare a bounded identity/candidate repair with before/after evidence and expected affected-row counts, then apply it through the normal authorized repair path.

There is deliberately no guessed `UPDATE hearing_id` statement in this runbook. Matching titles or the date encoded in `govtaff072926` alone is insufficient. A provenance-backed repair must preserve the session ID, its tenant ownership and the existing transcript/intelligence artifacts. After any repair, rerun the same read-only inspection and all four browser paths below.

## Browser acceptance matrix

Use the affected user's real signed-in tenant and record the deployed commit, time, URLs and returned counts. Use an approved test environment for induced failures; do not sabotage a production source or capture to manufacture a test.

| Path | Required result |
| --- | --- |
| Committees → Senate Armed Services → Airland | May 12 and June 9 proceedings appear once their source records are repaired. An inherited parent check is labeled as inherited and does not imply a successful child-calendar fetch. No verified “no proceedings occurred” assertion appears. |
| Hearings / My Sessions | The interrupted Fauci session appears under capture attention. No live proceedings/matches may be shown independently. An actual failing committee source remains visible in source status, with retry available when status loading fails. |
| Analytics / committee directory | Registered-source totals and failing source names agree with the hearing source-status summary for the same observation period. Complete calendar coverage is not inferred from a healthy-source percentage. |
| Global LegiWatch search for Fauci | The public hearing result is discoverable and provides the saved-session path or leads to its public detail, where the saved recording link is present. |
| Public Fauci detail | The saved session is listed with its actual saved counts and opens `/intelligence/hearing-watch/cms64c5ne0088kouo5vdxrms0`. Public capture/transcript counters stay distinctly labeled; zero public segments do not imply no saved transcript. |
| Archive → Transcript Available → Fauci | The associated hearing appears. Result count, facets and paging include it once, even if several sessions exist. Its saved-session link opens the same recording room. Transcript Not Available excludes it when saved final segments are accessible. |
| My Sessions → Fauci | Opens that same session and loads its persisted transcript, intelligence and official player. Returning to the public hearing does not require creating another capture. |
| Isolation / partial rollout | A second tenant cannot discover the affected tenant's session. Another same-tenant user cannot discover a creator-private session. Missing or failing saved-session rails display unavailable, rather than a verified empty result. |

Close LW-01 only after both target Airland proceedings and the qualified source-health wording are verified. Close LW-02 only after both the capture-attention and source-failure states are accurate. Close LW-03 only after the same saved content is reachable through search, public detail, Archive Transcript Available and My Sessions.

If the application rollout must be reverted, use the normal image rollback. Any later ingestion or provenance-backed data repair is a separate recorded operation and is not undone by rolling back application images.
