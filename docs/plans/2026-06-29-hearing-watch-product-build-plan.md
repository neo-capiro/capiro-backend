# Capiro Hearing Watch — Product Build Plan + Success Criteria

Date: 2026-06-29
Owner: Neo Martinez (CTO)
Status: In progress. Backend engine (apps/intel-api) built + image in ECR. This plan covers the
gap from "engine" to "client-ready Hearing Watch product," with a HARD requirement that the
whole feature is visible ONLY to the Capiro internal tenant until each piece is fully functional.

Parent: docs/plans/2026-06-29-live-hearing-deepgram-implementation-plan.md (the intel-api engine).

---

## 0. Visibility gating (the "only Capiro sees it" requirement) — FOUNDATIONAL

Requirement: do NOT show Hearing Watch to client tenants until it's fully functional. Gate it to
the Capiro internal tenant, flip on per-tenant later.

Mechanism — a tenant-scoped feature flag, enforced in BOTH layers (defense in depth; never rely
on UI hiding alone):

1. Backend gate (authoritative): intel-api + apps/api check the resolved `tenantId` against a
   `hearing_watch` flag. Implementation: a `FeatureFlag` lookup (allowlist of tenant IDs) seeded
   with ONLY the Capiro tenant id. Every Hearing Watch endpoint + WS handshake returns 404/403
   for non-allowed tenants — so even if a client guessed the URL, the API refuses.
2. Frontend gate (cosmetic): apps/web hides the Hearing Watch nav entry, routes, and any entry
   points unless `GET /intel-api/feature-flags` reports `hearing_watch: true` for the current
   tenant. A client tenant never sees the menu item.

Flip mechanism: add a tenant id to the flag's allowlist → that tenant sees it. Remove → hidden.
No redeploy. Default state: allowlist = [capiro_internal_tenant_id] only.

### SC0 — Gating
- SC0.1 A client (non-Capiro) tenant gets 403/404 on every Hearing Watch API route + WS connect.
- SC0.2 A client tenant's apps/web shows NO Hearing Watch nav item / route (verified logged in as
  a client-tenant user).
- SC0.3 The Capiro tenant sees and can use the full feature.
- SC0.4 Adding/removing a tenant id from the flag toggles visibility with no redeploy (< 1 min).

---

## 1. Current state (honest baseline)

| Capability | State | Where |
|---|---|---|
| Audio → Deepgram → diarized/timestamped transcript | BUILT | intel-api gateway + stream manager |
| Encrypted, tenant-scoped segment storage | BUILT | SegmentCommitService + crypto |
| Recording-policy + consent gating | BUILT | session service |
| Post-hearing raw materials (quotes/actions/mentions/claim map) | BUILT | PostHearingService |
| Quote search within a session | BUILT | findQuotes |
| Entity extraction call-out | BUILT (caller) | OrchestratorClient (tool not yet on orchestrator) |
| **Client watchlists** | NOT BUILT | — |
| **Stance/sentiment/impact classifier** | NOT BUILT | — |
| **Client-ready post-hearing brief** | NOT BUILT | — |
| **Client-specific alerts (assembled + delivered)** | NOT BUILT | — |
| **Keyterm prompting (bill #s, acronyms)** | NOT WIRED | small add to stream manager |
| **Archive semantic search** | NOT BUILT | embeddings not wired for intel_* |
| **Any UI** | NOT BUILT (0%) | apps/web |

---

## 2. Phased build + success criteria

### Phase H1 — Tenant gating + keyterm accuracy (foundation, fast)
Work: FeatureFlag model + `/intel-api/feature-flags` endpoint + backend guard on all Hearing
Watch routes; seed Capiro-only. Wire Deepgram keyterm prompting (bill numbers, acronyms, policy
terms) from a session's watchlist/issue context.
- SC1.1 SC0.1–SC0.4 all pass (gating works end to end).
- SC1.2 Keyterms are passed to Deepgram; a hearing mentioning "SB 410" / "interconnection queue"
  transcribes those tokens correctly in a test stream (vs. garbled without keyterms).

### Phase H2 — Client Watchlists (the targeting layer)
Work: `Watchlist` + `WatchlistTerm` Prisma models (bills, agencies, committees, legislators,
companies, competitors, topics, risk phrases, support/opposition language), CRUD API, and a
matching engine that scores each final segment against the client's terms.
- SC2.1 A watchlist with ≥8 term types can be created/edited/deleted per client (tenant-scoped).
- SC2.2 A transcript segment containing a watchlist term produces a match record with the term,
  client, and segment id+timestamp.
- SC2.3 A segment with no watchlist hit produces no match (no false-positive flood) — measured on
  a labeled test transcript: precision ≥ 0.8 on the pilot watchlist.

### Phase H3 — Stance / Sentiment / Impact classifier
Work: an orchestrator tool that classifies each relevant moment as structured JSON:
sentiment (pos/neg/neutral), stance (supports/opposes/concerned/neutral), intensity
(low/med/high), client_impact (favorable/unfavorable/monitor/no_action), recommended_action.
- SC3.1 Each watchlist-matched segment gets the full 5-field classification persisted.
- SC3.2 On a labeled gold set (≥30 moments), stance accuracy ≥ 0.75 and client_impact ≥ 0.7.
- SC3.3 Classifier returns "neutral/no_action" (not a guess) when a moment is genuinely ambiguous.

### Phase H4 — Post-Hearing Brief (the MVP deliverable)
Work: brief generator producing exec summary, key moments, relevant quotes w/ timestamps,
supporters & opponents, tone, client-specific risks/opportunities, recommended next steps, and a
draft client-update email — every claim sourced to a segment id+timestamp (claim map).
- SC4.1 A finished session produces a brief with all 8 sections populated from real transcript data.
- SC4.2 Every quote/claim in the brief links to a transcript segment id + timestamp (no unsourced
  claims).
- SC4.3 The draft client email is generated and editable; sending routes through MS Graph OAuth
  (existing path, compliance-gated) — never auto-sent.

### Phase H5 — Client-Specific Alerts (assembled + delivered)
Work: assemble the alert object (hearing/timestamp/speaker/issue/excerpt/why-it-matters/
client-impact/suggested-action/source-link) from a watchlist match + classification; deliver
through the shared §8 alert taxonomy into the Needs-Attention / changes inbox.
- SC5.1 A high-priority watchlist match raises an alert with all 9 fields populated.
- SC5.2 Alerts land in the existing shared inbox (no separate Hearing Watch silo).
- SC5.3 Live alerts are flagged "preliminary" and superseded by the final post-hearing analysis.

### Phase H6 — UI (apps/web) — gated to Capiro tenant the whole time
Work (all behind the H1 flag): (a) Watchlist manager, (b) Live Hearing Room (4-pane: transcript /
cards / relevance+quotes+actions / timeline), (c) Alert inbox view, (d) Post-hearing brief view +
draft-email, (e) Archive search, (f) hearing list/scheduler.
- SC6.1 All six surfaces render for the Capiro tenant and are absent for client tenants (SC0.2).
- SC6.2 Live Hearing Room shows interim captions < 2s and final segments with speaker labels.
- SC6.3 A user can: create a watchlist → start a session → watch live → open the post-hearing
  brief → see/triage the alert — end to end, in the UI.

### Phase H7 — Archive semantic search
Work: add intel_* transcript/quote tables to the embedding backfill; NL query endpoint + UI.
- SC7.1 "Show every hearing where data centers and grid reliability were discussed" returns the
  right sessions across the tenant's archive.
- SC7.2 "Which lawmakers mentioned permitting reform this quarter?" returns speaker-attributed
  results with timestamps.

---

## 3. Pilot scope (per the product plan)
1 jurisdiction, 3–5 committees, 3–5 client watchlists, post-hearing briefs FIRST, live alerts
second. Vertical: pick one (energy/utilities is the strongest fit given the SB-410/interconnection
examples). Stays Capiro-tenant-only until SC4 (briefs) + SC0 (gating) are green, then flip on for
ONE friendly pilot client.

## 4. Success metrics instrumentation (Phase H5+)
Track: relevant alerts generated, false-positive rate, missed important moments, time saved,
client actions triggered, brief quality score, willingness to pay. North-star: "did Capiro
surface something important before the client would have?"

## 5. Sequencing rationale
H1 (gate + accuracy) → H2 (watchlists) → H3 (classify) → H4 (brief = MVP deliverable) →
H5 (alerts) → H6 (UI) → H7 (archive). Briefs before live alerts (per product plan). UI is built
behind the flag from H1 onward so nothing leaks to clients pre-readiness.

## 6. Deploy state (engine)
- apps/intel-api image: built + pushed to ECR (digest sha256:16098f...).
- Task-defs registered, target group created, secrets + log group provisioned.
- Pending (gated to CTO): ECS service create + DB migrate (additive), and the prod-ALB listener
  rule (shared ALB — explicit approval required). Deepgram key rotation (exposed in chat) — CTO.
