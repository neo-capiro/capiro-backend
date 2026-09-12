# LegiWatch Phase 3 — calendar and preparation

This implementation uses the September 11 implementation handoff as its
requirements and the user's “execute phase 3” request as authorization to
implement and deploy. Captured recipient lists are evidence, not authorization
to activate delivery. Raw captures and live identity mappings stay outside Git.

The initial repository base was `70f5fe8a9f2b8287b0cd7f2c3f8d242a1d32861d`.
The evidence manifest's 70 files and the standalone handoff were verified.
The release must include newer main changes before publishing the UI.

## Ownership

API owns canonical public hearings, typed agenda items, notice revisions,
material transitions, Florida source qualification and calendar exports. Intel
owns private folder scope, immutable preparation snapshots, agenda rules and
leased delivery. Workspace continues to own editable documents and public
preview. No second document editor, canonical hearing table or capture pipeline
is introduced.

State identities require geography, session when qualified, chamber and a
source body key. Exact official notice identity can join observations across
providers and refine an unresolved body/session without changing an existing
hearing ID. A conflicting known geography, chamber, body or session is rejected.
Display names never establish a person or committee crosswalk.

Complete fields may explicitly remove an agenda, location or announced time.
Omitted or partial fields preserve prior confirmed values. Older/lower-authority
observations cannot resurrect withdrawn agenda entries. Material A→B→A→B
changes produce four durable revisions; repeat checks do not. Source observations,
typed agenda membership and transition writes commit together under an advisory
lock. State bill IDs never enter `committee_hearing_bill`.

Federal IDs and legacy links remain stable. An explicit federal read helper and
`federal_committee_hearing` view keep state records out of legacy search,
retrieval, archive, preflight, metrics and capture consumers. Legacy NULL
geography remains readable as federal during compatibility; new federal writers
set US and every state writer requires its explicit geography. Calendar revision
is stored and advances on material schedule changes rather than export time.

LegiScan calendar imports retain stable per-source identities and immutable
version snapshots. Complete disappearance marks an observation absent; it does
not claim that a hearing was canceled. Invalid entries are contained while valid
entries follow the documented partial-response policy.

## Source policy

Florida Senate committee directory and published meeting notice PDFs, and
Florida House daily schedules and meeting notice HTML, are the qualified primary
sources. Reads are HTTPS-host restricted, paced, size/timeout bounded, with
bounded retries for transient HTTP status codes. PDF text covers all pages.
Published notice text, document hash, deadline text and source URLs are retained.

Each chamber gets an attempted/complete/partial/failed coverage record with its
requested window, expected notice denominator, found records and explicit
issues. A missing directory/table or missing notice identity cannot produce a
confident absence claim. The scheduled default checks seven preceding days
through fourteen days ahead, with a maximum 32-day explicit window.

Only source-qualified regular/special session identity can resolve a bill.
The current production entry point requires an explicit regular session. A
House notice's breadcrumb/selector establishes its session; the globally selected
year is insufficient. Special-session identifiers without a qualified canonical
session mapping remain unresolved. The initial source schedule qualifies
committee notices, not every Florida floor proceeding.

OpenStates is a supplemental directory/coverage comparison. Its deleted-event
flag is not cancellation evidence. Vendor legislator 901 and archived 2023
committee 2176 remain unresolved unless source identifiers independently qualify
their mappings. A current name match does not rewrite historical identity.

## User workflows

Calendar filters apply before count/pagination/export. Private folder selection
is authorized by Intel and supplies public canonical bill IDs to API. Federal
is the default; explicit Florida/All require the state-calendar capability.
Following is a user-scoped overlay independent of attendance. Date navigation,
day/week selection, compact/expanded agenda display, mobile filter drawer,
source coverage and export share the same selection.

Exports include all matching pages up to the explicit 5,000-event limit and
report skipped/unavailable selections. Stable UID and stored SEQUENCE survive
re-export. Unknown/relative start times require explicit date-only reminder
selection. Missing end times are not fabricated. The test gate parses ICS with
the independent `ical.js` parser, including DST and cancellation.

Preparation works before a transcript exists. Intel freezes the event revision,
ordered agenda, current public bill facts and selected permitted folder context.
The web flow creates Workspace metadata, saves the initial public document via
Workspace's supported PATCH endpoint, and attaches private grounding through
its context endpoint. Initial shareable section content excludes private folder
notes. Workspace's existing public preview excludes configuration/context items.
Later calendar revisions show a stale-source notice; existing draft edits are
never overwritten.

## Agenda rules and delivery

Only the captured Tagged Bill Agenda family is promoted in this phase. Live
inspection confirmed eight deployed staged records under
`lobbytools:rubin-turnbull` with capture-qualified source IDs
`2026-09-10:alert-04` through `2026-09-10:alert-11`. Those IDs come from the
deployed import, not an invented new capture prefix. The evidence has 30 folder
memberships across 27 distinct folders. Source cadence is unknown for all eight;
in-app and enhancement begin off. Empty-target and deleted-owner records require
review. Promotions preserve staging evidence and prior edits.

Agenda transitions use a distinct delivery kind and typed inbox event. Detection
baselines reviewed rules; prior and current agenda bills participate in removal
and cancellation audiences. Compatible transition/recipient/client/cadence
intents combine reasons, while different client scopes/cadences remain separate.
Dispatch reauthorizes every rendered bill-folder reference and reuses Phase 2
leases/fencing. Partial revocation holds the complete unsent packet. Ambiguous
provider outcomes remain uncertain for reconciliation rather than being resent.

`legiwatch_state_calendar_v1` and `legiwatch_agenda_alerts_v1` explicitly default
off, including internal tenants. Worker ingestion/transition/delivery switches
are separate. Rollout and recipient activation are separately recorded.

## Validation and design

The CI workflow adds mandatory PostgreSQL preparation/delivery, state/federal
calendar and selection/export gates. Existing Phase 1/2 and federal regressions
remain enumerated, with zero failures, zero skips and minimum test counts.
`scripts/legiwatch-phase3-qualification.mjs` runs the same scopes sequentially on
disposable migrated databases for native ARM64 qualification.

The working Figma page is
[LegiWatch — Phase 3 Calendar & Preparation](https://www.figma.com/design/2aa9ipR2qOfumaixZErCfU?node-id=1424-2502).
It preserves the original Phase 1/2/library pages. Calendar, detail, preparation,
settings, directory, notification preview and mobile frames reuse Capiro text,
spacing/color variables and existing button instances. Browser/runtime evidence
and exact source/image/task identities belong in the release addendum; this
implementation note does not assert that deployment or recipient activation has
already occurred.
