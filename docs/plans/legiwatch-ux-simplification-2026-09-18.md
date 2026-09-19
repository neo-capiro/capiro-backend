# LegiWatch: make the existing product clear and easy to use

Implementation plan · September 18, 2026 · UI implementation complete locally; real-service qualification remains open

**Outcome:** A user can find a bill, understand a change, manage tracking, follow or record a hearing, and prepare a report without understanding LegiWatch's internal architecture. Every working feature and existing saved record remains available.

This plan is grounded in the [production Playwright audit](C:/dev/main/outputs/legiwatch-ux-audit-2026-09-17/legiwatch-ux-review.md) and the current components in `apps/web/src/vnext/pages/legiwatch`. The inspected checkout was `ac5acadb7`; reconcile intervening changes when implementation starts. Older handoff documents are background, not authority for current capabilities: several describe functionality that has since changed.

Implement the work in the sequence below and fix failures as they appear. There are no phase signoffs, design approvals, user-approval checkpoints, or new product approval flows. Automated checks and the final test pass are implementation work.

## 1. Keep the implementation small

- Reuse existing React components, design-system primitives, API hooks, query caches, permissions, feature flags and background jobs.
- Change presentation, navigation, copy and state handling in place. Extract a small shared helper only where the same behavior is actually reused.
- Keep current identifiers, saved settings, folder memberships, report definitions, monitoring rules, sessions, transcripts and historical outputs. No data migration is planned.
- Keep existing route/query contracts. Navigation groups are display organization, not new backend entities. In particular, existing `tab=watchlist` and `tab=watchlists` aliases must still open monitoring setup.
- Collapse advanced controls instead of deleting them. Keep the original capabilities reachable through labelled controls, including for tenants using the existing fallback Bills experience.
- Preserve authorization, private/public distinctions, existing input validation and recording/recipient requirements. Do not add new approval steps to simplify work.
- Do not build a new search service, monitoring engine, report engine, event pipeline, global state framework or design system. A small change to an existing endpoint is acceptable only if required for correct existing behavior, such as exact-match ordering across paginated results.

## 2. Final navigation and functionality map

The main navigation becomes **Updates · Watchlists · Research · Hearings · Reports**, with Settings in the existing gear menu. Remove the duplicated horizontal Intelligence navigation; retain the application's sidebar and accessible mobile navigation.

| Destination | Existing functionality retained | Presentation |
|---|---|---|
| Updates | Feed, all work states, assignment, snooze, dismiss, bulk actions, filtering, paging, client grouping, alert details, memo/brief/outreach handoffs, Analytics | Default destination for a bare `/legiwatch` URL. Changes first; Trends is a secondary view using existing Analytics. |
| Watchlists | Bill folders, tracked board/recommendations fallback, folder settings/permissions/archive, batch bill entry, filtering/sorting/columns, priority/importance/position/comments, daily activity, bill export, linked statutes/projects, monitoring setup | Saved items first, with one clear Add bills action and a Monitoring view. Existing folder terminology remains inside this destination. |
| Research | Bill metadata search, exact-text/version research, statutes/constitution, rules/deadlines, source coverage, News/personnel/registrations, Florida budget projects/documents/offers/calendar/updates/comparisons, committee directory/rooms/rosters | Clearly labelled secondary destinations. Preserve specialist views; show their scope and place advanced controls in Details or More filters. |
| Hearings | Schedule/calendar/agenda, following, attendance, prep drafts/revisions, public archive, server captures, browser sessions, recordings, transcript/intelligence/client relevance, official sources/documents, recaps, exports and handoffs | Schedule · Recordings · Past hearings. Live is an obvious schedule filter. A hearing page links its verified related work. |
| Reports | Intelligence briefs, bill reports, client briefings, templates/configuration, saved definitions, generated runs, history, exports, working schedules/delivery, contacts/lists, source citations and frozen output | One entry page with Library, History and Schedules. Report type chooses the existing workflow; avoid nested application shells. |
| Monitoring / Settings | Client topics/terms/jurisdictions, alert preferences, news/statute monitors, hearing/committee follows, agenda and published-record rules, enabled keyword rules and follow-up workflows, imports/reconciliation, display/timezone and coverage details | One place to find current monitoring and edit it. Advanced setup/import tools remain reachable under current access rules; moving them must not impose a new admin-only restriction. |

Existing URL values such as `tab=feed`, `tab=news`, `tab=budget`, `tab=analytics`, `tab=digest`, `digestMode`, `reportView`, `reportRun` and hearing/session paths continue to resolve. Select the appropriate new navigation group for those URLs rather than redirecting everything to the default screen. Old folder Reports links open Reports with the folder and return destination preserved.

## 3. Implementation sequence

### Work package 1 — navigation, context and everyday language

**Change:** Implement the five display groups and remove duplicate navigation. Keep a compact header with a plain title, Client selector and one search entry. Show Folder, Jurisdiction and Session only where they apply. Put the alert count in Updates as “177 open alerts,” rather than a global LIVE badge.

Use existing URL state as the source of truth. Centralize only the shared parameter-reading/updating logic. Carry compatible context between related views; reset pagination when filters change. Changing client clears an incompatible folder and its private draft selection, with a visible explanation. It must not edit the client's monitoring configuration. Cancel or ignore stale requests after a scope change.

Make the effective scope visible beside results: “1 of 3 saved bills · Federal · 119th Congress.” If an endpoint cannot provide the total, show the known result count and filters without inventing a denominator. Do not silently choose a client or default a federal search to Florida. Unsupported combinations remain explicit, with an action to choose a supported scope.

Replace “ingested” with “available,” “Client lens” with “Client,” and “FastTagger” with “Add bills by number.” Remove the internal System states reference from the user interface; keep useful refresh/error information and Retry. Show source-check time separately from analysis verification. Translate raw keys and capture codes into short explanations and preserve technical information in Details where useful. Distinguish unknown, unavailable, incomplete, zero results and no changes.

**Primary code:** `LegiWatchModule.tsx`, `VNextLegiWatchRoutes.tsx`, `lib/types.ts`, `lib/watchlist-navigation.ts`, `states/SystemStates.tsx`, `overlays/SystemStatesOverlay.tsx`, existing shell/navigation components.

**Done when:** Existing links open the same records, Back/Forward restores the correct view and scope, and ordinary screens contain no raw DTO keys, enum codes, contradictory verification labels or internal design-reference copy.

### Work package 2 — put bills and hearings above the controls

**Change:** Keep the content visible immediately. On Bills, show search, jurisdiction/session and More filters. Keep all other filters, column controls and sort options in compact controls or a disclosure. Show active filter chips and Clear filters even when the advanced panel is closed. Keep bulk actions next to the selection count. Move occasional folder operations into an explicitly labelled folder menu.

Preserve the two distinct existing values: keep the normal Low/Normal/Medium/High importance selector, and relabel the `topPriority` boolean as “Mark as top priority” with a short explanation that it is an additional flag. Put the secondary filter in More filters. Do not collapse these fields or rewrite saved values. Keep position and internal/external comments distinct.

On Hearings, combine the essential filters and date navigation into a compact toolbar. Put expanded agenda options and export options in their relevant menus. Replace large source-health panels with a concise, visible coverage message and View details. Keep serious actionable failures visible. The current events must not sit below operational diagnostics.

On mobile, use a compact global search button with an accessible label; eliminate wrapped header text. Use a section selector instead of requiring horizontal scrolling to discover primary destinations. Use bill cards or a reduced list with details for secondary columns. Advanced filters open in a mobile drawer and retain the same values as desktop. Ensure dialogs fit and scroll without hiding their actions or focus.

**Primary code:** `bills/FolderBillsTab.tsx`, `bills/BillsTab.tsx`, `bills/FolderContextPanel.tsx`, `bills/folder-tracker.css`, `hearings/HearingsTab.tsx`, `legiwatch.css`, existing shared shell/header components.

**Done when:** In a populated default fixture, the first bill row and first relevant hearing item begin within 600px of the top at 1440×900 and within 700px at 390×844. Primary content is not covered by fixed navigation. Every advanced control still works and survives reload/Back.

### Work package 3 — make search predictable

**Change:** Keep one Search LegiWatch entry, backed by existing searches. Make result types/modes explicit: Bills, Bill text, Hearings/transcripts and Committees; link the existing News, Statutes/rules and Florida budget searches as clearly labelled research destinations. Do not imply an all-source query when only selected sources are being searched.

Bills mode uses the existing public bill corpus, with visible jurisdiction/session controls. Bill text uses the existing document research endpoint and clearly states its narrower coverage. Preserve all supported metadata, document-kind, stage and version filters. Reuse current views and handlers rather than duplicating search implementations.

Distinguish “Search all bills” from “Filter this folder.” Typing into a folder filter must not silently switch to the public corpus. If the current backend path combines those modes, select the existing folder-scoped read for the folder filter; preserve public corpus search as an explicit action. Keep client/folder as the save destination and private analysis context without pretending they filter the public corpus.

An exact identifier must prefer the matching jurisdiction/session and show both in every result. Preserve the ability to search all sessions. If ranking changes are needed, apply them in the existing server search so pagination remains correct; do not sort just the first loaded page and call it globally ranked.

Group document matches visually by bill while retaining every matching version, amendment, supplement, citation and comparison action. “Versions to search” gets a sensible default using existing semantics; explanatory labels must not misrepresent extraction time as publication time. Empty results explain the scope and offer Clear filters or Broaden search. Partial coverage remains visible.

**Primary code:** `overlays/LegiWatchSearchOverlay.tsx`, `research/ResearchTab.tsx`, `research/research-state.ts`, `bills/BillsTab.tsx`, `bills/FolderBillsTab.tsx`, `bills/folder-api.ts`, existing bill search handler only if required.

**Done when:** The same identifier and scope lead to the same bill from all entry points; metadata/full-text differences are explicit; exact identifiers cannot open the wrong session; local filtering never broadens the corpus without a user action.

### Work package 4 — make Updates understandable and monitoring findable

**Change:** Alert rows show bill/item title, what changed, when, affected client(s), and one useful relevance sentence from existing evidence. Do not fabricate a substantive change when only a new match is known. Details show evidence and available actions, with missing data described in plain language. Keep source verification separate from confidence and work state. Remove irrelevant disabled actions from the main action row; explain contextual limitations when relevant, and retain working Draft memo, Ask Meri and other handoffs.

Group records only when an existing stable event identity, or canonical record plus matching event type/revision/time, proves they are the same event. Keep distinct changes separate. Use presentation grouping, not database deduplication. If identity is insufficient, retain separate rows. Each expanded group retains every client alert, relevance, position, owner and work state. Acting on one client must affect only that client alert unless the user explicitly selected several. Counts must distinguish events from client alerts and continue to use server totals across pagination.

Create one Monitoring view with category sections for current watchlists, news/statute rules, hearing/committee follows, agenda/published-record alerts and enabled keyword/workflow features. Compose current read hooks and existing editors. Show only supported status, scope, cadence and channels; use Unknown when last-check information is unavailable. Load the selected client's/category's configuration on demand rather than issuing queries for every client. Existing source-specific setup links also open this view at the relevant section.

Clearly distinguish “Save to folder” (organize an item), “Follow updates” (notifications), and “Record hearing” (capture). Saving must not silently create a new subscription. If an existing folder rule automatically monitors newly added items, preserve that behavior and show it beside the save destination. Recording and following remain separate choices. Empty monitoring provides one clear setup action while public browsing remains available.

**Primary code:** `feed/FeedTab.tsx`, `feed/PacketDrawer.tsx`, `settings/WatchlistSetup.tsx`, `settings/LegiWatchSettingsTab.tsx`, `settings/AgendaRulesPanel.tsx`, `keywords/*`, current monitor/follow hooks.

**Done when:** A user can explain an alert without opening technical details and can inspect/edit all existing monitoring categories from one destination. Grouping and scope changes preserve all individual work states.

### Work package 5 — make each hearing and its recordings easy to find

**Change:** Schedule shows public proceedings with obvious Following and Live filters. Recordings brings the existing server captures and saved browser sessions together visually, with their types and lifecycle states clear. Past hearings retains the server-searched public archive, including proceedings without a private recording. Do not replace the archive with a saved-session list.

Use the existing canonical hearing page as the hub when a verified hearing link exists. Show Follow updates and Record hearing near its title. Keep preparation, original documents, transcript, analysis, client relevance, source links, exports and handoffs in predictable tabs. List separate capture attempts and recordings where necessary; never merge them by title. Sessions with no verified hearing association remain directly accessible as unlinked recordings, with their current session routes intact.

Use plain-language recording states: Scheduled, Checking stream, Recording, Processing transcript, Ready, Interrupted, Failed, Unavailable and Canceled, mapped to existing backend states. Do not call processing complete prematurely. Preserve partial transcripts, original failure details, retry/cancel capabilities, browser permission handling and server attendance that continues after the page closes. Clarify browser attendance's open-tab/device requirement.

Keep current official times/timezones, date-only events, uncertain times and calendar export semantics. Calendar preferences change display, not source timestamps. Preserve prep revisions and provenance; preserve existing recap saves and Meri/outreach context.

**Primary code:** `hearings/HearingsTab.tsx`, `HearingDetailRoute.tsx`, `SavedHearingSessions.tsx`, `ServerCaptureSessions.tsx`, `ArchiveSubTab.tsx`, `FollowDialog.tsx`, `AttendDialog.tsx`, `HearingActions.tsx`, `PreparationPanel.tsx`, `live/*`, existing identity/date/state helpers.

**Done when:** A linked hearing's recording, transcript and analysis can be reached from that hearing; public archive and unlinked recordings remain searchable; following and recording remain independent and every lifecycle state has the correct explanation/action.

### Work package 6 — give Reports one clear entry

**Change:** Remove the outer Intelligence brief / Daily bill reports split. Reports lands on the library with a clear Create report action. Offer the current report types as labelled choices: Intelligence brief, Bill report and Client briefing. Each choice uses its existing generator/editor; do not build a generalized report engine.

Keep Library, History and Schedules as the everyday views. Retain type filters/sections where their data differ. Place contacts/lists in report settings. Monitoring-rule shortcuts lead to Monitoring. Imports/reconciliation stay in an advanced setup area with current access rights. Keep keyword/workflow tools discoverable when enabled.

Creation starts with client/folder and report type, then a preview. Keep existing selection/inclusion/order/link/audience options under Customize, with current safe defaults and no hidden removal. Preserve generation, edit, duplicate, version history, frozen runs, citations, exports, saved briefings and source-gap handling. Folder shortcuts open the same workspace pre-scoped and Back returns to the folder.

Display working schedules and delivery statuses using existing capability flags. Keep legacy saved cadence values intact, but move preferences that do not automate anything to an explicitly labelled legacy preference detail, outside the scheduling flow. Unsupported report types state “Generate on demand”; no inactive Daily/Weekly or Send action should imply a working automation. Preserve all delivery that actually functions today, including recipient lists, timezone/cadence, pause/resume, history and failures. Do not add delivery systems to make the interface appear complete.

**Primary code:** `digest/DigestTab.tsx`, `reports/ReportWorkspace.tsx`, `reports/report-api.ts`, `editorial/BriefingWorkspace.tsx`, `editorial/BriefingHistory.tsx`, `bills/FolderReportPreview.tsx`, folder Reports links.

**Done when:** All report entry points arrive in one coherent workspace; every existing report type, saved output and functioning delivery option remains usable; the UI accurately explains which actions will generate, export, save or send.

### Work package 7 — finish the secondary views and integration checks

Apply the same compact toolbar, active-filter, plain-language state and responsive patterns to News, Florida budget, Committees, Statutes/rules and Trends. Preserve their full functionality rather than converting them to basic search lists. Keep original source and revision details accessible; preserve budget stage comparisons without presenting requests as awards. Ensure topic/monitor labels, source coverage, fiscal years and legislative sessions remain explicit.

Check shared shell changes against Dashboard, Portfolio, Workspace, Engagement, Directory and the other Intelligence destinations. Preserve working global search, notifications, Quick Note and Meri. Keep existing permission/feature-flag fallback paths functional. Retain public browsing and saved reports when a client has no configured monitoring.

**Primary code:** `editorial/EvidenceTab.tsx`, `editorial/evidence.css`, `research/*`, `committees/CommitteesTab.tsx`, `hearings/CommitteeRoomRoute.tsx`, `analytics/AnalyticsTab.tsx`, existing shell regression tests.

**Done when:** Every capability in the map has a reachable destination and a regression scenario; no secondary feature is stranded by the new navigation.

## 4. Final qualification: test the whole product

Extend the existing Vitest suites and use the shared Playwright installation. Add one focused LegiWatch browser suite with reusable test data; do not create a new testing framework. Use the current API/database integration tests where they already exercise the behavior.

Maintain two kinds of evidence: controlled fixtures for repeatable interface/error tests, and real existing services for persistence, generation, delivery and recording. A mocked success screen does not establish that an integration works. Mutation tests use isolated test-owned clients/folders, designated test recipients and controlled permitted streams. Reload or start a fresh context to verify persistence. Remove only test-owned data using normal supported cleanup. Production inspection after implementation is a separate read-only smoke pass on `os.capiro.ai`.

| ID | Workflow to test | Required result |
|---|---|---|
| UX-01 | Open bare LegiWatch; navigate all five groups, secondary screens and settings; refresh and use Back/Forward | Correct selected navigation and content, no redirect loops; active filters and scope restored; meaningful empty/error states. |
| UX-02 | Open existing bill, folder, report-run, research comparison, committee, hearing and session links, including legacy aliases | Same underlying records and permissions; old parameters preserved or explicitly mapped; no lost saved draft or incorrect default landing. |
| UX-03 | Change All clients → client A → client B; combine folder, jurisdiction and session; switch rapidly during reads/mutations | No stale content, draft attachment, save destination, results or success message from another client; incompatible context is cleared and explained; public scope and private context remain distinct. |
| UX-04 | Search H.R. 8800 in the 119th and 117th Congress; search a state identifier shared across years; test number/title/text modes and later pages | Correct canonical bill and session; same identity across entry points; explicit full-text coverage; stable paging without missing or duplicated results. |
| UX-05 | Filter one folder; clear the filter; intentionally switch to public corpus; test every advanced filter, sort, column, summary and daily-activity option | Local filter never broadens search silently; active filters remain visible; exact selected/filtered scope retained across all pages. |
| UX-06 | Create/edit/archive/restore a test folder where supported; add bills singly and by batch; resolve ambiguous/invalid IDs; copy/remove selected bills; reload | Existing actions persist correctly; duplicates/invalid input handled; counts consistent; no production/test-unowned data changed. |
| UX-07 | Edit Top priority, Importance, Position, internal/external comments independently; open Bill 360 drawer/full page and all its available tabs | No field remapping or loss; folder context distinct from public facts; fact-sheet/funding exports, evidence and hearing links retain correct record scope. |
| UX-08 | Use tracked-board/recommendations fallback when folder tracking is off; enable/disable relevant feature flags | Tracking, untracking, recommendations, filters, all-client view and dossier still function; disabled features do not create blank/dead destinations. |
| UX-09 | Review all alert source types; assign, change review state, complete, snooze, dismiss and bulk-process; inspect next pages and grouped events | Server-persisted states/counts agree; grouping affects only proven same events; individual client states remain independent; snoozed items return according to existing expiry behavior. |
| UX-10 | Configure each supported monitoring category, change an existing rule, pause/resume/unfollow where supported, and reopen | Saved rule and channel/cadence shown accurately; browsing does not create a subscription; available categories retain source-specific behavior and history. |
| UX-11 | Browse/search news, personnel, registrations; save source material and include it in a briefing; inspect/import/edit existing monitor setup using test records | Existing records, expressions, source scopes and actions retained; saving a story does not activate monitoring; unavailable sources stated accurately. |
| UX-12 | Research statutes/constitution and rule deadlines; search exact text, select/compare versions, inspect citations, save research/briefing selections; test a slow older response | Correct revisions and original sources; no stale comparison attached after scope change; every specialist filter and draft persistence retained. |
| UX-13 | Browse Florida budget projects/documents/offers/calendar/updates; change fiscal year/session, compare supported stages, track and include evidence in briefing | Same project identities, values, source observations and stage semantics; requests/alternatives not labelled as awards; unavailable comparisons not fabricated. |
| UX-14 | Browse committees/subcommittees, roster/member links, room/history/upcoming proceedings; follow/unfollow and inspect notifications | Existing relationships and follow controls work; personal/client scope respected; source limitations clear; no duplicated follow configuration. |
| UX-15 | Use hearing day/week/calendar/agenda, all supported jurisdictions/chambers/statuses, following/live filters, public archive and timezones | Same public events accessible; default schedule not buried; DST/date-only/unknown-time display and single/bulk ICS exports accurate; source warnings do not falsely mean no events. |
| UX-16 | Create and revise preparation, Follow updates, modify/unfollow; separately schedule/cancel recording and use browser attendance | Independent persisted outcomes; following does not record, recording does not silently subscribe; prep revision, consent/permissions and existing source checks retained. |
| UX-17 | Complete real controlled server and browser capture paths: schedule/start → recording → transcript processing → ready; reopen after leaving | Server capture survives page closure; browser requirement is clear; durable playable recording/transcript/analysis found on correct hearing/session; separate attempts and unlinked sessions retained. |
| UX-18 | Interrupt capture, remove/unresolve stream, deny browser permission, fail/retry processing and reopen a partial session | Honest state/action; saved material remains accessible; no false completion or duplicate recording job. Verify fixture fault paths plus supported real recovery paths. |
| UX-19 | Search/read/page transcripts; inspect intelligence/client relevance; save recap or moment; Ask Meri, create brief, draft memo and stage outreach where supported | Correct citations/client/source context and saved result; UI handoffs do not send external outreach; unavailable actions explain their actual prerequisite. |
| UX-20 | Create/edit/duplicate and generate all existing report types; customize options; open old/frozen history; export files; return from a folder shortcut | Correct client/folder/date scope and original report version; readable nonempty PDF/CSV and other currently supported formats; internal comments excluded from external outputs according to existing rules. |
| UX-21 | Test contacts/lists and each currently supported schedule/delivery path through designated recipients; pause/resume and trigger a retry | Actual received payload matches output; cadence/timezone/paused state respected; no duplicate send after retry; failed delivery distinguishable from sent; inactive legacy preferences cannot look like active schedules. |
| UX-22 | Exercise existing import/reconciliation, keyword rules and follow-up workflows when enabled; inspect Trends/coverage | Tools remain reachable under the same roles; existing behavior preserved; 0 versus unknown versus not monitored correct; no silent rule activation from viewing an import. |
| UX-23 | Visit representative pages with empty, populated, loading, partial, stale, unavailable, permission-denied, expired-authentication and mutation-failure responses | Useful explanation/recovery, no fake zero/all-clear, no indefinite spinner; Retry preserves user input; failed save never reports success; reauthentication resumes at the intended authorized destination. |
| UX-24 | Use authorized writable, read-only and restricted-client/other-tenant test accounts; open direct URLs and exports | Existing access boundaries and disabled-state explanations preserved; no inaccessible private notes, recipients, sessions or data leaked through grouping/search. |
| UX-25 | Test 1440×900, 1280×800, 768×1024 and 390×844, plus a 320px narrow-screen smoke check; keyboard-only operation and 200% zoom | No clipped headers, unreachable primary tabs, page-level horizontal overflow or covered actions; core workflows usable on mobile; focus, dialog return, labels, errors and status announcements work. |
| UX-26 | Open other application modules after shared shell changes; inspect console/network and existing regression suites | No broken navigation/global controls, uncaught errors, failed essential requests or accidental per-row request fanout introduced by this work. |

For delivery/capture/generation, verify a real result with existing services and durable records, not just a queued response. When a third-party source is unavailable, test the failure presentation and state explicitly which real path remains unverified. Do not label the entire suite passed, replace it with mocks, or remove the feature to hide an integration failure.

## 5. Measurable success criteria

The implementation is complete when all of the following hold:

1. **Functionality:** Every item in the functionality map is reachable and its applicable workflow above passes. Existing records, legacy links and supported feature-flag variants remain usable. No loss or unintended rewrite of saved data.
2. **Discoverability:** From LegiWatch, bill discovery is available in one action. After selecting a result, saving it requires at most two further actions excluding data entry. From a hearing page, Follow updates or Record hearing opens directly in one action. From a folder, Create report opens a pre-scoped flow in one action. Advanced options are one clearly labelled disclosure away.
3. **Content visibility:** First populated bill/hearing item meets the 600px desktop / 700px mobile threshold above. Mobile header text does not overlap; essential actions remain visible or within a labelled overflow menu.
4. **Scope:** Client, save destination and search coverage are explicit where applicable. All tested scope changes, reloads, deep links and Back/Forward operations return correct data. No silent jurisdiction/client substitution or local-filter-to-global-search transition.
5. **Comprehension:** No raw internal keys or status enums on everyday screens; no source-check timestamp masquerading as verification; no “active,” “sent” or “complete” state for inactive or unfinished work. Save, Follow and Record describe different outcomes consistently.
6. **Real integrations:** Each currently enabled report generation/export, notification/delivery and recording/transcript workflow has a successful real-service test with persisted or received output. Unsupported capabilities are accurately presented rather than fabricated. Missing integration evidence is recorded as unverified, never a pass.
7. **Access and errors:** All role-boundary, private-note/export, permission, stale-response, empty, partial and failure scenarios pass. No unresolved defect causing a blocked core task, misleading result, lost data or cross-client mutation remains.
8. **Accessibility and responsiveness:** Core flows work with keyboard only at desktop and mobile widths; visible focus and meaningful accessible names; dialog focus is contained and restored; new errors/statuses are announced; automated accessibility checks have no new serious/critical findings. Inspect contrast and 200% zoom visually as well as automated checks.
9. **Responsiveness:** Cached tab/filter/drawer actions settle within one second in the controlled test environment; network-dependent work immediately shows a truthful loading state and a recoverable error on failure. Preserve server pagination; no fetch-all workaround or new request per displayed row. Compare the same fixtures/environment before and after if a slowdown appears.
10. **Evidence:** Produce one final test report listing each UX ID, environment/role/feature configuration, pass/fail/unverified result, relevant trace/screenshots and integration output. Include desktop/mobile before-and-after captures and the read-only production smoke result. These are test results, not approval checkpoints.

## 6. Practical execution and verification

Start by extending nearby tests that already cover the changed behavior: module/scope and URL-state tests; folder Bills and legacy-corpus tests; Research/search/version tests; feed triage/client-packet tests; hearing identity/navigation/capture tests; report workspace/digest/briefing tests; watchlist/committee-notification tests; responsive and shell regression tests. Avoid tests that only assert renamed strings or mirror component internals.

Use the existing web commands from the repository root:

```powershell
pnpm --filter @capiro/web typecheck
pnpm --filter @capiro/web lint
pnpm --filter @capiro/web test -- src/vnext/pages/legiwatch
pnpm --filter @capiro/web build
```

Run targeted neighboring shell/Bill360/client-tracker tests and relevant existing API/database integration suites for the changed flows. Add a focused Playwright runner, for example `apps/web/scripts/legiwatch-ux-acceptance.mjs`, using the already shared Playwright installation; do not add or reinstall Playwright in the monorepo. Use existing authentication fixtures and environment configuration. Record unrelated pre-existing failures separately and do not hide failures introduced by these changes.

Implement packages 1–7 in order, running focused checks as each is completed; then run the full UX-01–UX-26 matrix against the final build. Fix findings and rerun the affected scenarios and shared dependencies. Capture the final evidence on the exact implemented build. The existing unrelated untracked engagement QA files in this checkout are not part of this work and should remain untouched.
