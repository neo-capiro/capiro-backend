# LegiWatch vNext — API inventory (LEGIWATCH-HANDOFF §3.2)

Verified 2026-08-13 against `origin/main` (ad0fef2c0). Every row was followed
to its NestJS controller in `apps/intel-api/src` (global prefix `intel-api`)
or `apps/api/src`. Front-end client files are the canonical ones the current
app (`app.capiro.ai`) already calls — the vNext module reuses these clients
and their react-query key semantics (§3.3).

Legend: **Client file** = existing fetcher/hook the vNext build reuses.

## Feed / alert packet store

| Screen · element | Method | Path | Params | Response type | Client file | Server controller | Query key | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Feed list · packet rows | GET | `/intel-api/clients/:clientId/feed` | `sourceType?, order=date\|score, limit, cursor?, workState?` | `FeedResponse { items, nextCursor, hasMore, counts, severityCounts }` | `pages/clients/tracker/intel-feed-api.ts` | `intel-api/src/feed/feed.controller.ts:127` | `intelFeedKeys.feed(clientId, source, order)` | Keyset-paginated; `counts` is per-sourceType, `severityCounts` per severity — both same scope as the item query. |
| Feed list (all clients) | GET | `/intel-api/clients/_all/feed` | same | `FeedResponse` (adds `clientName`) | same | `feed.controller.ts:99` | `intelFeedKeys.tenantFeed(source, order)` | Tenant roll-up; distinct key namespace. |
| Packet drawer · full alert | GET | `/intel-api/clients/:clientId/feed/alerts/:alertId` | — | `FeedItem` (+evidence) | same | `feed.controller.ts:83` | — | Also `_all/feed/alerts/:alertId` (:73). |
| Packet drawer · GA packet | GET | `/intel-api/clients/:clientId/alerts/:alertId/packet` | — | `GovernmentAffairsAlertPacket` | `pages/clients/tracker/alert-packet.ts` | `feed/action-item.controller.ts:110` | — | proceduralMeaning, confidence, clientContext, officialEvidence w/ `SourceVerification`. |
| Work-state mutation (single) | POST | `/intel-api/clients/:clientId/alerts/:alertId/work-state` | `{ state?, assignedTo?, snoozedUntil? }` | `{ ok: true }` | `TrackerFeedPanel.tsx` (inline) | `feed/action-item.controller.ts:165` | invalidates `intel-feed*` | Per-user (alert global). Idempotent upsert. Snooze un-hides on expiry read — no job needed. |
| Work-state mutation (bulk) | POST | `/intel-api/clients/:clientId/alerts/work-state/bulk` | `{ alertIds[], state?, assignedTo?, snoozedUntil? }` | `{ updated }` | same | `feed/action-item.controller.ts:183` | invalidates `intel-feed*` | One call per selection. DTO caps `alertIds`; web chunks above it. |
| Worklist bucket counts | — | derived from feed query (`workState` facet) | — | — | — | `feed.service.ts:255-300` | — | **No per-bucket count endpoint** — buckets are a `workState` filter on the same query. See GAPS G1. |
| Match trace ("Why am I seeing this?") | — | on packet: `evidence.match` | — | `{ matchedTags, termId, topicLabel, why, details[] }` | `intel-feed-api.ts` `FeedEvidence.match` | `feed/normalize-evidence.ts` | — | Server-provided per packet. Also `evidence.scoreFactors` + `scoreUnavailable` for priority explanation. |
| Memo link / report / talking point | POST | `/intel-api/clients/:clientId/alerts/:alertId/{memo-link,talking-point,report}` | various | — | `alert-actions-api.ts` | `action-item.controller.ts:119-150` | — | Memo generation itself is `/api/...` (apps/api), action state in intel-api. |
| Action items state | GET | `/intel-api/clients/:clientId/action-items` | — | — | `alert-actions-api.ts` | `action-item.controller.ts:198` | — | |

## Bill service

| Screen · element | Method | Path | Params | Response type | Client file | Server controller | Query key | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Bills board (stage columns) | GET | `/intel-api/clients/:clientId/tracker/board` | `cursor?, changedWithinDays?, activeOnly?, stages[]?, clientIds[]?` | `IntelBoard { columns[{id,label,cards}], nextCursor, hasMore, total, withheld }` | `pages/clients/tracker/intel-tracker-api.ts` (`adaptBoard`) | `tracker/tracker-board.controller.ts:60` | `trackerKeys` (shared w/ old app) | Stage server-authoritative; `passageProbability`; `canonicalStatus` + `terminalRisk` for terminal bills (null-safe). |
| Tracked status (one bill) | GET | `/intel-api/clients/:clientId/tracker/bills/:billId/status` | — | — | same | `tracker-board.controller.ts:82` | — | Server-authoritative tracked flag. |
| Tab-badge summary | GET | `/intel-api/clients/:clientId/tracker/summary` | — | `{ boardCount, unread }` | same | `tracker-board.controller.ts:92` | — | |
| Recommendations strip | GET | `/intel-api/clients/:clientId/recommendations` | — | `IntelRec[]` (fit, matchedTags, matchReasons, why) | same (`adaptRecs`) | `tracker-board.controller.ts:41` | — | Not-yet-tracked by definition; fit floor 0.45. |
| Track / untrack | POST | `/intel-api/clients/:clientId/tracker/{track,untrack}` | `{ billId, … }` | — | `tracker-api.ts` hooks | `tracker-board.controller.ts:107/120` | invalidates board + recs + summary | Server-authoritative; round-trips. |
| Bill 360 dossier | GET | `/intel-api/bills/:billId/dossier` · `/intel-api/clients/:clientId/bills/:billId/dossier` | — | dossier (see `bill-dossier.types.ts`) | `pages/bills/Bill360Page.tsx` | `bill-dossier/bill-dossier.controller.ts:39/47` | — | `bill_360` feature guard (404 when off). Funding gated by `defense_funding_intel`. |
| Bill→hearings interlink | GET | `/intel-api/clients/:clientId/bills/:billId/hearings` | — | — | `bill-hearings-api.ts` | (tracker) | — | Bill 360 Hearings tab. |
| Bill search | GET | `/intel-api/clients/:clientId/tracker/bill-search` | — | — | `intel-tracker-api.ts` | `tracker-board.controller.ts:100` | — | |

## Hearing / transcription service

| Screen · element | Method | Path | Params | Response type | Client file | Server controller | Query key | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Hearing schedule (upcoming) | GET | `/intel-api/upcoming-hearings` | — | `UpcomingHearing[]` (scheduledAt, committee, chamber, sessionId, sessionStatus, watchlistMatchCount, recapSaved) | `lib/hearing-watch-api.ts` `useUpcomingHearings` | `upcoming-hearings.controller.ts:13` | `['intel','upcoming-hearings']` | **Forward window only; no date-range param** — see GAPS G4 (calendar needs a window). |
| Hearing browse (past+upcoming) | GET | `/intel-api/upcoming-hearings/browse` | `scope=upcoming\|past\|all, search?, chamber?, limit, offset` | `{ items, total }` | same (`useBrowseHearings`) | `upcoming-hearings.controller.ts:18` | `['intel','browse-hearings',…]` | Searchable/paged corpus. |
| Stream capability resolution | POST | `/intel-api/hearings/resolve-stream` | `{ pageUrl?, hearingId? }` | `ResolveStreamResult { status: resolved\|candidates\|pending\|unresolvable, media?, candidates?, reference? }` | same (`useResolveStream`) | `hearing.controller.ts:62` | — | **The honest-capability source.** Maps to §6.4: resolved→direct (if media) else browser; pending→pending; unresolvable→unavailable. |
| Create hearing session | POST | `/intel-api/hearings` | `{ title, sourceType, audioSource, recordingPolicy, sourceUrl?, consentAttestation?, clientId?, hearingId?, …ids }` | `LiveHearingSession` | same (`useCreateHearing`) | `hearing.controller.ts:47` | invalidates `['intel','hearings']` | Browser-tab audio capture only — **no server-side stream ingestion** (see GAPS G2: no unattended capture). |
| Session read | GET | `/intel-api/hearings/:id` | — | `LiveHearingSession` | same (`useHearingSession`) | `hearing.controller.ts:85` | `['intel','hearing',id]` | |
| Session history (My Sessions) | GET | `/intel-api/hearings/history` | `limit, cursor?` | `HearingSessionHistoryPage` | same (`useHearingSessionHistory`) | `hearing.controller.ts:73` | `['intel','hearings','history']` | |
| Consent | POST | `/intel-api/hearings/:id/consent` | `{ attestation }` | — | same (`useConfirmConsent`) | `hearing.controller.ts:90` | — | |
| Transcript (persisted pages) | GET | `/intel-api/hearings/:id/transcript` | `offset, limit` | `HearingTranscriptPage { items[{startMs,endMs,text,speakerLabel,resolvedSpeakerName,confidence}] }` | same (`useHearingTranscript`) | `hearing.controller.ts:106` | `['intel','hearing',id,'transcript']` | |
| Live transcript transport | WSS | `/intel-api/live` (socket.io) | ticket | transcript segments | `LiveHearingRoomPage.tsx` | `hearing.gateway.ts:80` | — | Ticket minted over HTTPS first (`ws-ticket`). |
| WS ticket | POST | `/intel-api/hearings/:id/ws-ticket` | — | `WsTicket { ticket, expiresAt }` | `mintWsTicket` | `hearing.controller.ts:158` | — | |
| Hearing brief / recap | GET | `/intel-api/hearings/:id/brief` | — | `HearingBrief` | same (`useGenerateBrief`) | `hearing.controller.ts:133` | — | |
| Save recap → client doc | POST | `/api/intelligence/clients/:clientId/hearing-recaps` | `{ sessionId, title, markdown, replaceAttachmentId? }` | — | same (`useSaveRecap`) | apps/api | invalidates recaps/history/upcoming | |
| Saved recaps list | GET | `/api/intelligence/clients/:clientId/hearing-recaps` | `limit, cursor?` | `SavedHearingRecapPage` | same (`useSavedHearingRecaps`) | apps/api | `['intel','hearing-recaps',clientId]` | |

## Watchlist / targeting service (read-only here; §7.9 removes the editor)

| Screen · element | Method | Path | Params | Response type | Client file | Server controller | Query key | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Watchlist read | GET | `/intel-api/tracker/watchlists/:clientId` | — | `IntelWatchlist { issueAreas, topics[{label,position,priority,terms[]}], jurisdictions, version, suggestedIssueAreas? }` | `intel-tracker-api.ts` (`adaptWatchlist`) | `tracker/tracker-watchlist.controller.ts:28` | `trackerKeys` | Drives matching, coverage, cold start. `suggestedIssueAreas` = cold-start starter model. |
| Compiled terms | GET | `/intel-api/tracker/watchlists/:clientId/compiled` | — | `IntelCompiled` | same | `tracker-watchlist.controller.ts:66` | — | |
| Alert prefs | GET/PUT | `/intel-api/tracker/watchlists/:clientId/alert-prefs` | — | `IntelAlertPrefs` (triggers, materiality, email/sms cadence, jurisdictions) | same (`adaptPrefs`) | `tracker-watchlist.controller.ts:52/57` | — | Digest delivery channel status source. |
| Seed suggestions | GET | `/intel-api/tracker/watchlists/:clientId/seed-suggestions` | — | — | same | `tracker-watchlist.controller.ts:47` | — | Cold-start suggestions (stay suggestions until approved — PUT is the approval mutation). |
| Issue areas taxonomy | GET | `/intel-api/tracker/issue-areas` | — | — | same | `tracker-taxonomy.controller.ts` | — | |
| Coverage score | — | **NOT FOUND** | — | — | — | — | — | No server coverage score / per-dimension gaps. GAPS G3. |

## Clients (scope control)

| Screen · element | Method | Path | Params | Response type | Client file | Server controller | Query key | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Client list (scope selector) | GET | `/api/clients` | — | `Client[]` | `lib/use-api.ts` | apps/api | `['clients']` | Same mechanism Portfolio uses; scope lives in `?client=` URL param. |

## Program Elements (read-only, §12.1)

Read via the PE module's existing endpoints (`/api/defense-budget/…`,
`/intel-api/…` PE change detectors). LegiWatch renders `FeedProgramElementEvidence`
from the feed and links to the PE dossier — it never re-derives a position.
See `docs/handoff/pe-vnext-module-map.md` for the canonical PE surface.

## NOT FOUND — logged in GAPS.md

- Morning digest read/history/schedule/PDF endpoints (only the email digest
  *queue drain* task exists — `intel-alert.service.ts:727`, `tasks/task-runner.ts:504`).
- Saved views (any persistence). Only hit is an unrelated hearing-recap service.
- Analytics aggregates (signal-volume series, momentum, exposure matrix).
- Source-health telemetry ("5 sources · refreshed N min ago").
- Scheduled/unattended hearing capture queue + scheduler.
- Hearing capability as a stored field on the schedule row (resolved ad hoc via `resolve-stream`).
- Hearing schedule date-range window param.
- Per-worklist-bucket count endpoint.
- Watch presets + 30-day backtest preview.
