# Phase 8 Session 8 — Live Official-Source Discovery

**Workstream K. Dark-deployment discovery infrastructure.**

Session 7 shipped a control loop whose discovery port read from a hand-written
manifest, and said so plainly: *"Live crawling of each publisher's index page or
API is dark-deployment infrastructure work, not control-plane logic. Swapping
this adapter for a live crawler changes where candidates come from and nothing
about those decisions."*

Session 8 is that swap. It adds no HTTP route, no schedule, no production
ownership and no GPU. It changes nothing about fingerprinting, revision
detection, classification, supersession, idempotency or queueing — those stay
exactly where Session 7 left them, and the frozen `SourceDiscoveryPort` interface
is implemented rather than altered.

---

## 1. What "live discovery" actually has to solve

The manifest carried one field a crawler cannot: `expectedSourceDedupKey`. A
human wrote it. A crawler sees a URL and has to work out, on its own, which
expected source — if any — a document could satisfy. Everything else follows from
getting that one thing right without ever guessing.

| Problem | Mechanism |
|---|---|
| Which documents exist at all | Per-publisher channel: GovInfo collection sitemaps, HTML index pages, one news feed |
| Which of them are ours | Fail-closed resolution against **registered** expected sources |
| How to afford it | `lastmod`-driven incremental crawl, cheap id prefilter, bounded resumable request budget |
| How not to abuse a publisher | Host-keyed pacing where the publisher's own crawl-delay wins |
| How to prove nothing was lost | Append-only audit of every request and every candidate decision |

## 2. The channel, chosen by measurement

Both official JSON APIs are unusable without a credential:

```text
GET https://api.govinfo.gov/collections   -> 401 {"code":"API_KEY_MISSING"}
GET https://api.congress.gov/v3/bill/...  -> 403 {"code":"API_KEY_MISSING"}
```

No key is configured, so the `api`-mode adapters run on GovInfo's **collection
sitemaps**, which need none and which govinfo's own `robots.txt` advertises:

```text
Sitemap: https://www.govinfo.gov/sitemap/CRPT_sitemap_index.xml
Sitemap: https://www.govinfo.gov/sitemap/BILLS_sitemap_index.xml
Sitemap: https://www.govinfo.gov/sitemap/PLAW_sitemap_index.xml
```

Those three map exactly onto the three GovInfo adapters. Measured, live:

| File | Entries | Contains |
|---|---:|---|
| `CRPT_2023_sitemap.xml` | 497 | `CRPT-118hrpt125` (HASC), `CRPT-118hrpt121` (HAC-D) |
| `BILLS_2023_sitemap.xml` | 13,354 | every version of H.R. 2670: `ih rh eh rds eas enr` |

Both Session 7 committee reports and the whole publisher version chain Session 7
replayed are discoverable through this channel.

## 3. Three things the sitemap does not give you

**It does not give you the document URL.** A real entry is
`https://www.govinfo.gov/app/details/CRPT-118hrpt125` — a human-facing page, not
the PDF the watcher hashes. The content URL is derived, and the derived URL is
the one that answers `200 application/pdf`, with `Last-Modified` and **no
`ETag`** — the same validator gap Session 7 built the byte-SHA identity around.

**It does not give you a usable title.** The details page's own `<title>` is
`H. Rept. 118-125 - CRPT-118hrpt125 | Content Details | GovInfo`: a label, not a
subject, and useless for deciding authorization versus appropriations. The
authoritative title is in `/metadata/pkg/<id>/mods.xml`, key-free, and it returns
exactly the phrases the Session 7 classifier already keys on.

**`lastmod` is not a publication date.** Real FY2024 packages carry `lastmod`
values in late 2024 and 2025 — it is GovInfo's metadata mtime. It is used only as
a change signal, never as "when this was published".

## 4. Resolution is fail-closed, and it is also the filter

`resolveDiscoveredCandidate` classifies from publisher metadata, derives the
Session 7 `expectedSourceDedupKey`, and then requires that key to be one a
bootstrapped cycle **actually registered**. Seven outcomes, one of which is
`resolved`; the other six each carry a reason.

Two properties matter more than the mechanism:

- **An unresolved candidate is never given a key.** Not a placeholder, not a
  best guess. The database enforces this in both directions:
  `("resolution" = 'resolved') = ("expected_source_dedup_key" IS NOT NULL)`.
  Inventing an official identity is unrepresentable, not merely discouraged.
- **Requiring a registered expected source is what makes the crawl affordable.**
  13,354 BILLS entries would otherwise mean 13,354 downloads. It is a correctness
  rule first — an observation may only attach to an expected source — and an
  affordability rule second.

Resolution is **not** classification. The key it picks only decides which
expected source a candidate is compared against. The authoritative
classification still happens in the watcher, after the bytes are downloaded, with
content corroboration. Discovery passes `contentExcerptAvailable: false`, the
same "corroboration deferred" path Session 7 defined for PDF-only publishers, so
the lenient content-check branch is never reached from here.

### The HAC-D case, proven through the live channel

Session 7 called out that `CRPT-118hrpt121` states no "fiscal year" phrase at
all. Through live discovery the same document now resolves from its real MODS
title:

```text
CRPT-118hrpt125  "NATIONAL DEFENSE AUTHORIZATION ACT FOR FISCAL YEAR 2024"
                 -> authorization / hasc_report
CRPT-118hrpt121  "DEPARTMENT OF DEFENSE APPROPRIATIONS BILL, 2024"
                 -> appropriations / hac_d_report      (no "fiscal year" phrase)
```

Different tracks, different expected sources, from titles alone. The replay
asserts the absence of the phrase rather than trusting the note.

### The case that must NOT resolve

`PLAW-118publ42` is a genuine FY2024 omnibus with **no defence division**. Its
own titles are `"An act making consolidated appropriations for the fiscal year
ending September 30, 2024..."` and `"Consolidated Appropriations Act, 2024"` —
right year, right vehicle class, wrong subject. It resolves to **nothing**, and
the replay proves the appropriations-sounding alternative title does not smuggle
it onto the defence appropriations track.

### Reading one record more completely is not guessing

A real bill's primary MODS title is *"To authorize appropriations for fiscal year
2024 for military activities of the Department of Defense..."* — which names both
tracks in one breath and is correctly ambiguous. The popular title *"National
Defense Authorization Act for Fiscal Year 2024"* sits in the **same** record as
`<titleInfo type="alternative">`. Resolution therefore tries the document's own
titles in order, primary first, and takes the first that classifies.

Two guards keep that honest: only titles **before the first `<relatedItem>`** are
considered, because a related-item title describes a *different* document; and a
pure bill designator (`"H.R. 2670 (RH)"`) is skipped, because it identifies
rather than describes.

## 5. Pacing: per host, and the publisher can tighten it

Adapters share hosts. `dod-comptroller` and `dod-comptroller-reprogramming` both
publish on `comptroller.defense.gov`; all three GovInfo adapters publish on
`www.govinfo.gov`. Per-adapter pacing would let concurrent runs triple the real
request rate at one publisher, so pacing is keyed by **host**, reserved through a
single atomic statement — the same single-owner pattern as the Session 7 adapter
lease.

And the publisher may be stricter than we are:

```text
congress.gov robots.txt   Crawl-delay: 2      -> 2000 ms
adapter registry          congress-gov        -> 1000 ms
effective interval        max(...)            -> 2000 ms
```

A crawler honouring only its own registry would be twice as aggressive as the
site asks. `effectiveRequestIntervalMs` takes the maximum, always.

## 6. robots.txt, with the statuses that really occur

RFC 9309 group selection is implemented properly because it has to be:
`congress.gov` terminates a long list of AI-crawler user agents with a bare
`Disallow: /`. `assertUserAgentPermitted` refuses to crawl a host that has
excluded our agent, rather than crawling anyway.

| Observed | Host | Treatment |
|---|---|---|
| `200` | `www.govinfo.gov`, `www.congress.gov` | Parse and apply. `/search/` is disallowed and never requested. |
| `403` | `comptroller.defense.gov` | RFC 9309 "unavailable" — unrestricted, **flagged** `robotsUnavailable`. |
| `500` | `api.govinfo.gov` | A JSON application fault, not a directive. Allowed and flagged. |

On the 5xx case we deliberately do **not** take RFC 9309's optional
"complete disallow": the real observed 500 is an app error from a publisher that
never expressed a restriction, and failing closed there would blind discovery for
no stated reason. The permission is granted and the flag is persisted, so the
decision is visible rather than implicit.

## 7. Bounded, resumable, and never silently truncated

A cold crawl faces a large backlog, so a run is bounded by a request budget. When
it runs out:

- the collection's watermark is **not** advanced past work that was never
  examined — advancing it would skip the remainder permanently;
- `backfillPending` is set on that collection's cursor;
- the shortfall is logged.

A silent cap would read as "nothing left to find", which is why the measured cost
is published rather than implied:

```text
BILLS_2023: 11,391 of 13,354 entries survive the id-shape prefilter (85.3%)
```

That is honest, not comfortable. An id-shape prefilter cannot know subject, and
congress 118 plus `hr`/`s` covers most of a 2023 bill sitemap, so a **cold** BILLS
backfill needs roughly one MODS request per survivor and spans many bounded runs.
Steady state is cheap, because it is driven by `lastmod` deltas.

The watermark comparison is deliberately **inclusive**, with a boundary set of
package ids already emitted at that instant. Two GovInfo packages routinely share
a `lastmod` to the millisecond; an exclusive comparison would skip one forever,
whereas re-seeing an unchanged entry is free — the Session 7 byte comparison makes
it a no-op.

## 8. Publishers that refuse us

Measured from a plain client while building this session:

```text
comptroller.defense.gov/Budget-Materials/            403  Akamai
asafm.army.mil/                                      403  Akamai
www.defense.gov/                                     403  Akamai
saffm.hq.af.mil/                                     ---  no connection
www.secnav.navy.mil/fmc/fmb/Pages/Fiscal-Year-*.aspx 200  no direct document links
armedservices.house.gov/legislation                  200  no direct document links
www.armed-services.senate.gov/legislation            200  2 document links
appropriations.house.gov/                            200  2 document links
www.appropriations.senate.gov/legislation            200  no direct document links
```

Five of the fourteen adapters cover hosts that will not serve us at all. The
database makes misreporting that impossible: `status = 'succeeded'` requires a
2xx, `'blocked_by_publisher'` requires the real status code, `'unreachable'`
requires the absence of one, and any non-success requires a stated reason. So
"we were turned away" can never be stored as "nothing was published".

Making those hosts yield is an egress/allowlisting question for the deployment
session. It is not something code can assert.

## 9. Publisher-native document kinds

The Session 7 classifier resolves document kind from the official GovInfo package
id and returns `review` when there is none:

```text
classifyLifecycleSource({ packageId: null, title: 'DEPARTMENT OF DEFENSE APPROPRIATIONS BILL, 2027' })
  -> decision 'review', classification null,
     reasons ['official document kind could not be determined from package id "<none>"']
```

Correct for GovInfo, and fatal for everything else: nine of the fourteen adapters
publish on their own websites and issue no package id at all. Under that rule
alone live discovery would be GovInfo-only, which is not the session's scope.

**The missing evidence is not in the document — it is who published it.** The
governed cycle template already binds each mark to exactly one adapter:

```text
adapterId 'hasc'                 -> authorization / hasc_mark  / HASC  / house
adapterId 'house-appropriations' -> appropriations / hac_d_mark / HAC-D / house
```

So reading the stage from the adapter is the template's own binding, read from the
other direction. A document fetched from `armedservices.house.gov` by the `hasc`
adapter — a host the registry already proved belongs to that adapter — is a House
Armed Services document. That is evidence, not a guess.

Four guards keep it from becoming a hole:

1. **Only when the package-id chain resolved nothing.** A GovInfo document is
   classified byte-for-byte as Session 7 classified it; the branch is unreachable
   for it. Asserted directly, including confidence `0.95` on both real committee
   reports.
2. **Only for the nine listed adapters.** No GovInfo or congress.gov adapter has a
   profile, so the omnibus ambiguity cannot be rescued by publisher identity — the
   FY2024 omnibus with no defence division still resolves to nothing.
3. **The document must still look like what that publisher issues.** A press
   release on a committee site is not a chairman mark. Where the document's own
   text resolves a track that *contradicts* the publisher, document evidence wins
   and the candidate is refused.
4. **Confidence is capped at 0.7, below the 0.8 accept threshold.** A document
   with no official package id can be routed but never auto-accepted: the decision
   is `review`, so it lands in the persisted review backlog and no stage advances
   on publisher identity alone.

Two pre-existing mapping gaps had to be closed for this to land on real expected
sources, both of which produced dedup keys nothing could ever match:

- **Reprogramming and transfer collapsed into `alt_supplemental`.** Both are
  separately registered families, so a real DD-1415 action could never attach to a
  cycle.
- **All President's Budget material defaulted to `pb_overview`.** The template
  registers PB material per exhibit family and component (`pb_r2`/`ARMY`), so no
  service-comptroller exhibit could ever match. Exhibit designators (`R-1`,
  `R-2A`, `P-1`, `OP-5`, `C-1`, `DD 1391`, …) now resolve the family, and a gate
  asserts every family the resolver can emit is one the template registers — the
  same bug class Session 7's closeout found.

Component comes from the publishing service comptroller, narrowed by the document
only where the template registers the sibling: SAF/FM's Space Force volumes are a
distinct `SF` component, while the Navy comptroller's Marine Corps volumes fold
into `NAVY` because the template registers **zero** `USMC` entries. Narrowing to
`USMC` would mint a key no cycle expects, turning a real registered Navy exhibit
into an unresolved candidate.

Measured result: all fourteen adapter classes resolve to a registered expected
source, and all five authority tracks — request, authorization, appropriations,
alternative funding and execution — are reachable through live discovery.

One useful side effect: committee sites overwhelmingly write "NDAA", which the
frozen Session 7 subject pattern deliberately does not match. Publisher identity
supplies the track instead, so the frozen pattern needed no loosening.

## 10. What Session 8 does not do

No HTTP route (the Session 3 surface stays frozen at 49 routes). No schedule and
no EventBridge watcher — production schedule ownership is Session 10's work. No
snapshot promotion or activation. No production data or AWS mutation. No NVIDIA
experimentation, endpoint or spend. No change to the deterministic parser default.
No funding amount, anywhere: the discovery tables have no monetary column, and
the rehearsal measures that against `information_schema` rather than asserting it.

Live crawling is **opt-in twice over**. The module defaults to the Session 7
manifest adapter, which reaches no network at all, and switches to live discovery
only under `PHASE8_SESSION8_LIVE_DISCOVERY=true`. The governed command additionally
requires `PHASE8_SESSION8_CRAWL_AUTHORIZED=true` before it issues a single request,
and `PHASE8_SESSION8_COMMIT_AUTHORIZED=true` before it persists anything.

The manifest adapter is deliberately kept: it is what the Session 7 historical
replay runs against, and a deterministic offline discovery source stays useful.

## 11. Commands

```bash
# Domain + control loop
node scripts/test-phase8-session8-discovery-domain.mjs
pnpm --filter @capiro/defense-api exec tsx --test \
  src/budget-lifecycle/discovery/live-discovery.spec.ts

# Real official sources: materialise, then replay
node scripts/prepare-phase8-session8-discovery-corpus.mjs
node scripts/phase8-session8-discovery-replay.mjs \
  --out docs/defense-budget/phase8-session8-discovery-replay-evidence.json

# Gates
node scripts/verify-phase8-session8.mjs --enforce-replay
node scripts/verify-phase8-session8-db.mjs

# Governed command (plan-only by default; no request without authorisation)
cd apps/defense-api
node scripts/run-live-discovery.mjs --list-adapters
node scripts/run-live-discovery.mjs --adapter govinfo-committee-reports --plan
```
