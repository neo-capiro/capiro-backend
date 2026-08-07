# Outreach V3 Prototype Interaction Contract — v1

**Micro-session:** 2.1 — Extract the prototype interaction contract
**Schema version:** 1
**Prototype SHA-256:** `84b26c1d2ea0dd8d122ee0b4bdbe4087cdf37e1b328bf1ab6fd1146d0624f453`
**Manifest:** `apps/api/src/engagement/__fixtures__/outreach-v3-prototype-state-manifest.v1.json`
**Extractor:** `scripts/outreach-v3-prototype-contract.mjs`
**Tests:** `scripts/outreach-v3-prototype-contract.spec.mjs`

---

## What this is

The Outreach V3 standalone prototype is an 874 KB bundled HTML artifact. This
contract turns it into an 18 KB deterministic manifest so every later phase can
consume the UI contract without reverse-engineering the bundle again, and so any
change to the prototype shows up as a reviewable diff.

**The prototype itself is not committed.** It is an external input, frozen by
checksum in `docs/plans/engagement-api/phase-2-input-lock.md`. Neither the
prototype nor any asset it carries may enter the repository or a container
image.

This is a **contract, not an implementation**. Nothing here ships UI. Phase 2
deploys infrastructure only; Outreach V3 implementation belongs to Phases 5–9.

---

## Safety properties

The extractor never executes prototype code. This is enforced three ways:

1. **By construction.** The bundle is read as text. JSON payloads are parsed
   with `JSON.parse`, which is data-only. There is no DOM, no browser, no script
   evaluation.
2. **By exclusion.** The extractor contains no `eval`, no `new Function`, no
   `node:vm`, no `require`, and no `child_process`. A test asserts this against
   the extractor's own source.
3. **By behaviour.** A negative control injects
   `globalThis.__OUTREACH_V3_PROTOTYPE_EXECUTED__ = true`, `process.exit(97)`
   and a `throw` into a synthetic prototype, then asserts extraction completes
   and the global is still `undefined`.

Asset handling:

- Font, image, audio and video assets are **counted and never decoded**. Their
  bytes cannot reach the output because they are never read.
- Compressed *text* assets are decompressed only to prove integrity and the
  result is discarded. A corrupt compressed asset fails extraction rather than
  yielding a partial contract.
- Before returning, the manifest is scanned and rejected if it contains a
  `data:` URI, a base64-looking blob, an email address, or a non-null
  `extractedAt`. SHA-256 values are masked before the blob scan, since a
  64-character hex hash is a subset of the base64 alphabet — the check stays
  strict for everything else rather than being loosened.

The prototype's scenario data — people, offices, bills, campaign text — is
**fictional fixture content** authored for the mockup. It is not production
truth. No contact detail is extracted; `provenance.scenarioDataIsFictional` is
`true` in the manifest.

---

## Layout contract

The prototype and the master context disagree, and Phase 2 records the
difference rather than resolving it.

| Source | Layout |
|---|---|
| `engagement-api-outreach-v3-master-context.md` §10 | Permanent **left conversation pane** beside a right-side work surface |
| Outreach V3 prototype | Single **workbench** + **bottom-docked conversation bar** + **expandable history overlay** |

Extracted:

```json
{
  "workbench": "single",
  "conversation": "bottom_docked",
  "history": "expandable_overlay",
  "mobile": "stacked_conversation_first"
}
```

**The prototype wins for later UI implementation.** The master context remains
authoritative for service extraction, security, tenant isolation, side-effect
ownership, and send safety.

The layout is derived from the prototype's own invariant rules, not from CSS —
specifically *"The screen is not split. One workbench, with the conversation
docked across the bottom and its history expandable over the work."* A negative
control feeds a left-pane prototype through the extractor and asserts it reports
`left_pane` / `split`, proving the field tracks the artifact rather than a
hardcoded answer.

---

## Stage machine

Six user-visible stages:

```text
Goal · Targets · Delivery · Context · Drafts · Send
```

Thirteen internal stages:

```text
goal → readback → sponsor → criteria → targets → coverage → delivery
     → context → strategy → samples → drafts → preflight → sent
```

Entry points per visible stage: `goal`, `targets`, `delivery`, `context`,
`drafts`, `preflight`.

---

## States

62 states across seven prototype menu groups. Every state keeps its source group
in `menuGroup`, so the mapping into the six declared buckets is lossless.

| Bucket | Count | Source group(s) |
|---|---|---|
| `primaryFlowStates` | 22 | Flow |
| `edgeStates` | 22 | New in this version (10) + Target and context edge cases (12) |
| `loadingStates` | 6 | Loading |
| `errorStates` | 6 | Error and timeout |
| `emptyStates` | 3 | Empty |
| `systemStates` | 3 | System |

Two source groups map to `edgeStates` because the schema declares six buckets
for seven groups. "New in this version" holds the narrative contracts from the
plan's §1 list — express path, typed-instruction proposal, resume, interrupted
generation, draft provenance, post-send learning, and the two scenarios.

### Primary flow — the 22 states

| # | id | label |
|---|---|---|
| 1 | `outreach-landing` | 1 · Outreach landing |
| 2 | `read-back-no-client-required` | 2 · Read-back, no client required |
| 3 | `sponsor-ambiguity` | 3 · Sponsor ambiguity |
| 4 | `target-criteria` | 4 · Target criteria |
| 5 | `recommended-targets` | 5 · Recommended targets |
| 6 | `directory-search` | 6 · Directory search |
| 7 | `expanded-office-with-staff` | 7 · Expanded office with staff |
| 8 | `client-contacts-several-clients` | 8 · Client contacts, several clients |
| 9 | `saved-audiences` | 9 · Saved audiences |
| 10 | `manual-target-entry` | 10 · Manual target entry |
| 11 | `selected-targets-and-health` | 11 · Selected targets and health |
| 12 | `target-profile` | 12 · Target profile |
| 13 | `coverage-gap-review` | 13 · Coverage gap review |
| 14 | `delivery-recommendation` | 14 · Delivery recommendation |
| 15 | `context-recommendations` | 15 · Context recommendations |
| 16 | `strategy-review` | 16 · Strategy review |
| 17 | `representative-samples` | 17 · Representative samples |
| 18 | `draft-summary-12-drafts` | 18 · Draft summary, 12 drafts |
| 19 | `exception-review` | 19 · Exception review |
| 20 | `preflight-nothing-eligible-yet` | 20 · Preflight · nothing eligible yet |
| 21 | `preflight-partial-send-ready` | 21 · Preflight · partial send ready |
| 22 | `post-send-partial-failure` | 22 · Post-send, partial failure |

The `id` deliberately omits the flow number so it survives renumbering; the
ordinal lives in `flowNumber`.

The remaining 40 states are enumerated in the manifest.

---

## Taxonomies

**Sponsor scopes (6)** — `firm`, `client`, `clients`, `coalition`, `internal`,
`none`. Matches master context §11: a client is never required.

**Target sources (7)** — `recommended`, `directory`, `clients`, `saved`,
`recent`, `manual`, `selected`. A saved audience is a *source*, never a delivery
mode.

**Delivery patterns (3)** — `personalized` (one tailored draft per target),
`same` (one message delivered separately), `shared` (one email, recipients
visible). Matches master context §18.

**Governed-context categories (4)** — `required`, `writing`, `facts`, `target`.
Exclusion is a per-item decision with a stated reason, not a fifth category.

**Draft statuses (8, in precedence order)** — `Not generated`, `Failed`, `Held`,
`Stale`, `Dirty`, `Verifying`, `Approved`, `Ready for review`. The prototype's
own notes list the six user-facing ones and state: *only Approved drafts with a
verified address are sendable.*

**Scenarios (2)** — `hill` (firm to congressional, default) and `agency`
(coalition to federal agency).

**Reusable controls (18)** — captured as `commands`, each with its static
label(s), whether the label is computed, and any `kind` values.

`SEND` is deliberately modelled in full. It is a three-branch conditional with
kinds `blocked`, `review` and `send` — an object-literal-only extractor would
have silently omitted the most safety-critical control in the flow. A test
asserts `SEND` is present with all three kinds.

---

## Responsive rules

- **Desktop ≥1280px** — One workbench. Work surface capped at 1060px of content,
  conversation bar docked underneath. The target profile is a nested overlay,
  never a page of its own.
- **Tablet 900–1280px** — Resizable split with a 360px conversation minimum.
  Target tabs wrap; the brief stays collapsed.
- **Mobile <900px** — Stacked. Conversation first with the live question pinned,
  work surface below, sticky segmented jump control, composer always reachable,
  brief becomes a one-line expandable header. Hit targets stay at 44px.

---

## Invariant rules

17 rules are captured verbatim in `invariantRules`. The ones that bind backend
behaviour in later phases:

- Meri recommends targets but never pre-adds them.
- Target-specific context is scoped to one person and cannot appear in another
  target's draft.
- Sending always requires the dedicated preflight confirmation. Typing "send it"
  opens preflight and never sends.
- A typed instruction is never applied on its own — Meri proposes, effects are
  named, the user applies.
- Nothing is written to memory after a send unless each proposal is approved
  individually.
- Sponsor, audience class and target class are separate concerns.

---

## Determinism

Same input bytes produce byte-identical output. A test extracts twice and
compares serialized results.

**Recorded decision.** The plan says "sort every list deterministically."
Inherently ordered sequences keep **source order** and carry an explicit `order`
index: `visibleStages`, `internalStages`, `stageEntryPoints`, every state list,
`sponsorScopes`, `targetSources`, `deliveryPatterns`, `draftStatuses`
(precedence order), `responsive`, `invariantRules`. Genuinely unordered sets are
**sorted alphabetically**: `contextCategories`, `commandLabels`, `commands` (by
id), `scenarios`, `assetSummary.mimes`.

Both satisfy determinism. Alphabetizing the 22 flow states would have destroyed
the flow sequence, which is the contract's most load-bearing property.

---

## Regenerating and verifying

```bash
export OUTREACH_V3_PROTOTYPE_PATH="/path/to/Outreach V3 (standalone).html"
export EXPECTED_OUTREACH_V3_PROTOTYPE_SHA256=84b26c1d2ea0dd8d122ee0b4bdbe4087cdf37e1b328bf1ab6fd1146d0624f453
node scripts/outreach-v3-prototype-contract.mjs --out apps/api/src/engagement/__fixtures__/outreach-v3-prototype-state-manifest.v1.json
```

Drift check without rewriting:

```bash
node scripts/outreach-v3-prototype-contract.mjs --check apps/api/src/engagement/__fixtures__/outreach-v3-prototype-state-manifest.v1.json
```

Tests:

```bash
node scripts/outreach-v3-prototype-contract.spec.mjs
```

The suite has 25 assertions in three layers. 24 run hermetically against the
committed fixture and synthetic in-memory bundles, so **CI needs no access to
the prototype**. The 25th compares the fixture against the real prototype and
runs only when `OUTREACH_V3_PROTOTYPE_PATH` is set; when it does not run, the
suite prints an explicit notice rather than passing silently.

---

## Downstream consumers

**Micro-session 2.2** builds the UI-to-API capability matrix and must produce
exactly one entry per state in this manifest — all 62, not just the 22 primary
ones. `menuGroup` and `flowNumber` identify each state; `id` is the stable join
key.

Two corrections 2.2 must carry, from the input lock §10:

- The **web** route `/engagement/integrations` does not exist. Integrations is
  at `/settings/integrations`. The **API** routes under
  `/api/engagement/integrations` do exist.
- No state in this manifest may be classified as implemented. Phase 2 ships no
  V3 UI.

**Micro-sessions 2.3 / 2.6** carry `prototypeSha256` into the service task as
`OUTREACH_V3_PROTOTYPE_SHA256` — nonsecret release provenance only. It does not
enable any UI.

**Micro-session 2.13** should add both the drift check and this spec to
`pnpm verify:engagement-phase-2`.
