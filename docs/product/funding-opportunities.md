# Funding Opportunities — what it does, and what it does not claim

**Audience:** whoever supports, sells, or operates this feature. **Phase:** P51 closeout.

This document exists so that nobody has to infer a limit from silence. Every
capability below states what it is, and — where it matters — what it is *not*.

---

## What the product answers

1. **Why is this relevant to this client?** — deterministic relevance with cited evidence.
2. **Can the client realistically pursue it?** — eligibility, kept separate from relevance.
3. **What changed, and why does that matter?** — notice timeline with material-change classification.
4. **What government, budget, Program Element, and stakeholder context applies?**
5. **What should the team do next?** — a recommendation with a next action.
6. **Who owns it, and did it produce an outcome?**

---

## Five concepts that are deliberately not merged

Support questions get much easier once this is internalised. These are separate
fields, separate UI, and separate history:

| Concept | Example values | Who sets it |
|---|---|---|
| Machine recommendation | `pursue` `monitor` `pass` `needs_review` | computed, deterministic |
| Relevance | strong / moderate / weak fit | computed |
| Eligibility | eligible / ineligible / needs review / unknown | computed |
| Acquisition position | direct vehicle access / partner route / unknown | computed |
| Human decision | pursue / monitor / pass | a person |
| Workflow stage | reviewing → qualified → pursuing → submitted → won/lost/passed | a person |

**A strong relevance score with unresolved eligibility is `needs_review`, never
`pursue`.** That is a rule, not a tuning choice.

**Confidence is evidence quality, not probability of win.** "High confidence"
next to a dollar figure does not mean a high chance of winning it.

---

## Things the product will not do, on purpose

- **Grants and contracts are never added into one dollar total.** They are
  different instruments with different rules.
- **A missing figure renders as unknown, never as `$0`.** "The source stated
  nothing" and "the source stated zero" are different facts.
- **A failed request renders as a failure, never as an empty result.** An empty
  list means there is nothing; it never means the lookup broke.
- **Closed and informational notices cannot be marked as pursuits.**
- **No LLM decides anything.** Models may summarise and explain evidence. They
  may not calculate eligibility, change relevance, decide vehicle access,
  fabricate a value, turn missing evidence into a negative assertion,
  auto-accept profile enrichment, send outreach, or create an alert.
- **Attachment-derived claims require source evidence.** Nothing extracted from
  a document is released without a citation back to it.

---

## Provider data: additive, never authoritative

MakeGov/Tango supplies additional procurement intelligence. It is **additive**:

- First-party SAM.gov, Grants.gov and USAspending ingestion remain the source of
  record for canonical lifecycle fields.
- Provider observations may **verify, enrich, or conflict** with them. A conflict
  is **recorded**, never silently merged, and no source overwrites the other.
- Provider-exclusive datasets (agency forecasts) are provider-sourced, and every
  row carries source system, provider, fetch time, provider update time, content
  hash, and source URL.

**Normal product reads never depend on a live provider request.** If MakeGov is
unavailable, previously synchronised data stays usable and is shown as *stale*
rather than disappearing.

---

## Plan- and tier-dependent capabilities

| Capability | Status |
|---|---|
| Entities, opportunities, notices, forecasts, vehicles | available |
| Budget context, protest/exclusion risk | available, labelled beta |
| Extracted document text | tier-dependent |
| Webhook **reads** (event types, endpoint list) | available |
| Webhook **writes** (creating alert subscriptions) | **UNRESOLVED** — see below |
| DIBBS | **not available** |
| SBIR/STTR | **not available** |

**DIBBS and SBIR/STTR are not a roadmap item that slipped.** The provider SDK
(`@makegov/tango-node@1.1.0`) has no method for either dataset anywhere in its
client surface. Phases P40–P43 are blocked on the provider, not on engineering,
and no amount of Capiro work changes that until MakeGov ships a surface.

**Webhook writes are genuinely unknown.** The provider's documentation says
filter subscriptions are available on all tiers; its SDK documentation describes
webhook write methods as Large/Enterprise. Those cannot both be relied on. The
reconciler is built to discover the answer and stop cleanly — a tier refusal
exits 3 having attempted exactly one write, leaving nothing half-configured.

---

## Alerts, and why they are quiet

An alert fires only when **all** of these hold:

- the change is **material** (a deadline or cancellation, or a set-aside/NAICS/PSC
  change) — informational changes stay on the timeline;
- it is **not the first observation** of that record;
- somebody has **engaged** with the row — `reviewing`, `qualified`, `pursuing`, or
  `submitted`;
- nobody has already **passed** on it, and it is not `won`, `lost`, or `passed`;
- that exact change has **not already been alerted** for that client.

A machine-suggested row nobody has touched never alerts. That is by construction:
the default workflow status maps to no pipeline stage.

---

## Data retention and operational behaviour

| Topic | Behaviour |
|---|---|
| **Provider snapshots** | retained with content hashes; a changed payload creates a new observation rather than overwriting the prior one |
| **Webhook deliveries** | retained as immutable evidence of what arrived; retry state lives in a separate queue table |
| **Alerts** | retained; deduplicated by (tenant, client, source record, change fingerprint) |
| **Provider outage** | local data remains readable and is labelled stale; no product read blocks on the provider |
| **API key rotation** | update the Secrets Manager secret and restart the ephemeral sync task. No code change, no redeploy of API serve — the key is injected only into the sync task |
| **Webhook secret rotation** | update `capiro/<env>/tango-webhook-secret` and roll API serve. Deliveries signed with the old secret are rejected with 401 during the window, and the provider retries — so rotate in a low-traffic window, or pause the provider alerts first |
| **Incident response** | flags off first (every capability fails closed with a 404), then roll API/web to the prior immutable image digests. Additive data remains; no phase ships a destructive migration |

---

## Success metrics

Measured, not asserted. Baselines are set during the canary and reviewed
per-tenant.

| Metric | What it tells you |
|---|---|
| Reviewed recommendation precision | of recommendations a human reviewed, the share they agreed with |
| Time to decision | suggestion → human decision |
| Deadlines met | pursued opportunities submitted before their deadline |
| **Stale / false-alert rate** | alerts a human judged not worth sending — the number that decides whether alerting keeps its credibility |
| Workflow completion | rows reaching a terminal stage rather than being abandoned mid-pipeline |
| Source conflicts | provider-vs-first-party disagreements recorded; a rising count is a data-quality signal, not a bug |
| API usage and cost | calls, 429s, and spend against the account limit |
| Outcome capture | pursued rows that ended with a recorded outcome |

---

## Known limitations, named rather than implied

- **P40–P43 (DIBBS, SBIR/STTR)** — blocked on the provider. No SDK surface exists.
- **Webhook write tier** — unresolved until a real write is attempted.
- **P39's MCP connector** — merged without a live handshake; the host and header
  come from the plan document, not from a confirmed connection. Ships flag-off.
- **Vehicle changes do not raise webhook alerts.** The provider states no vehicle
  on a notice, so a vehicle change is not observable from notice history. It
  surfaces through the vehicle sync instead.
- **Requirement changes surface as an attachment-count change**, which is
  informational and does not alert. Real requirement diffs come from the
  evidence-bound extraction artifact.
- **The event drain reads what the notice sync holds**, rather than fetching
  inline. If the sync has not run since a delivery arrived, the change is picked
  up on the next cycle rather than immediately.

Every deferred capability is flag-off and named here. None is implied complete.
