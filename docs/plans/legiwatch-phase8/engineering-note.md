# Phase 8 engineering record

Phase 8 extends LegiWatch with retained news, Florida fiscal evidence and original client briefings. Accepted baseline: `62fc017d1` (Phase 7 release record, PR 1633). Five services are affected: API, Intel API, Workspace, Meri orchestrator and Web. This is the September LobbyTools replacement scope; federal PE parsing and live recording policy are unchanged.

## Ownership and contracts

API owns immutable article observations, current-revision pointers, source receipts/bytes, the 74-publisher checklist, fiscal documents/projects/amounts/events and temporal personnel observations. `NewsEvidenceService` separates all retained provider observations from the eight-card dashboard. NewsCatcher requests use explicit parse-date intervals, English, selected publishers, 100 records/page and at most ten pages. A shared PostgreSQL daily request budget covers dashboard and monitoring when retention is enabled. Headline/link retention is the NewsCatcher default; RSS retains permitted feed excerpts. Missing bodies remain unknown to local matching.

Intel owns private monitor configuration, versioned match/run receipts, folder tracking, import decisions, briefing selections and scheduled occurrences. Private tables use owner/tenant RLS and current folder/client authorization. A monitoring retry resumes its original interval and skips pages with successful receipts. A paused/revised monitor establishes a new from-now baseline on activation. Delayed indexing is represented separately from publication time. The immutable corpus includes every fetched article before presentation ranking.

`/intel-api/legiwatch/evidence` exposes news, monitors, personnel, budget, exact sources, tracking, import preview/stage and briefing authoring/configuration/review. Meri exposes `search_legiwatch_news`, `get_florida_budget_project`, `compare_florida_budget_amounts` and `prepare_legiwatch_briefing` through the shared contracts and authoritative handlers.

Workspace reuses its existing source-action receipt and private document access. A selection pins exact source revisions, locators, cutoff, timezone, client context and relevant tracking/monitor versions. Canonical request hashing survives PostgreSQL JSON key ordering. Generation inputs and model output are durably recorded before Workspace; lost acknowledgments replay the same draft without replacing human edits. Three distinct templates cover Research Update, Daily Legislative Brief and Morning News Brief. No analysis produces an explicitly labeled source-list draft.

Reports owns exact edited-output review and immutable editions. The existing delivery queue supports the typed `editorial_brief` adapter, including current recipient/contact/list versions, active client access, source/tracking corrections, output-hash and standing-approval checks immediately before dispatch. Internal editions cannot use outward delivery. Provider acceptance is distinct from recipient delivery; uncertain sends are not blindly retried.

## Scheduling and sources

The existing report worker processes bounded news-monitor batches and local-day briefing occurrences. Monitoring, preparation and sending have independent process gates. Material configuration changes pause the subscription and clear standing approval. Source/category decisions, selected dictionary, weekdays/timezone/cutoff policy, no-change policy and current recipients require explicit configuration. The same local-day/version occurrence is unique through DST folds and retries. No change can skip with a receipt; missing monitoring windows hold sending. An explicitly reviewed excerpt policy may allow limited-field source material while retaining visible limitations.

The reviewed public manifest importer verifies original bytes, SHA-256, all selected-document pages and exact fiscal amount identities before transactional import. It is not a statewide autonomous fiscal parser. The existing RSS worker can revisit up to 12 retained official source URLs daily. It retains changed bytes and marks extraction review required without publishing new amounts. A later reviewed version clears the older-source hold. Personnel directory crosswalks require an existing Florida identity, exact retained official URL and an explicit reviewed evidence locator; unresolved people stay unmerged.

## Design

[Phase 8 Figma page](https://www.figma.com/design/2aa9ipR2qOfumaixZErCfU?node-id=1502-2502) includes News, import review, Budget project/comparison, briefing, schedule review and narrow-screen views. Existing shell, field, button and table instances/tokens are reused. Product text uses Inter. These are technical design references, not a client acceptance record.

The current NewsCatcher account check returned inactive, free_tier, 2,500 plan calls and zero remaining calls (2026-09-14T07:44:25Z). Four captured Florida publishers have qualified public RSS feeds. Monitor configuration explicitly chooses `rss` or `newscatcher`; RSS scans retained observations without consuming NewsCatcher calls and preserves feed/history limitations in the run receipt. The pilot uses RSS and leaves paid-provider monitoring unactivated.

## Scheduled fiscal statement integrity

Scheduled monetary statements are composed from qualified fiscal observations after provider generation. Each retains the exact selected project, source revision/page, dollar display, chamber, stage, fund, basis and separate allocation identity. The provider receives a labeled normalized projection; original PDF passages remain in the source corpus and citation review. Projections cannot be quoted as verbatim publisher text. Provider budget facts and interpretations are replaced by these deterministic statements; news commentary and source gaps remain distinct. The draft discloses that cross-stage totals, differences and percentages require compatible Budget comparison. Original provider output and the reviewed composition remain in the occurrence payload before Workspace preparation. Missing exact observations or oversized editions hold rather than silently truncating the fiscal scope.
