# Outreach — Engagement V2 prototype parity

What the Outreach builder is now, why it changed shape, and which of its
controls are not wired to a real endpoint.

Source of truth: the `Capiro Engagement V2` design-canvas prototype. Its live
Outreach surface is the campaign home (Campaigns / Templates) plus a nine-step
campaign builder.

## 1. The load-bearing discovery

The prototype export contains **two** Outreach step machines. Only one is real.

`outreachVals()` in the prototype's script defines a six-step flow — `Goal ·
Targets · Delivery · Context · Drafts · Send` — with a Meri chat thread beside
it. **The prototype's markup never binds a single one of its keys.** It is dead
code: no `isStep0`, no `deliveryCards`, no `ctxGroups`, no `targetTabs`, no
`thread` anywhere in the template. The same is true of the constants it reads
(`STEPS`, `TARGETS`, `PROFILES`, `AUDIENCES`, `DELIVERY`, `CTX_GROUPS`,
`SAFETY`, `SAMPLES`, `RECIPIENTS`, `CHECKS`, `RECORDS`).

The live wizard is `wizardVals()`, and it is a different flow entirely.

That matters because the previous implementation — `VNextOutreachWorkspace`'s
seven-step `goal · targets · delivery · context · examples · drafts · send`
rail — was built to the dead one. It has no Campaign type step, no Name step, no
Template step and no Format step, and it has three steps the prototype does not
have at all.

Verification method, if this needs re-checking: extract every `{{ identifier }}`
from the prototype markup's Outreach region and diff it against the keys each
`*Vals()` method returns.

## 2. The step machine

`apps/web/src/vnext/pages/engagement/outreach-campaign-flow.ts`

```
Campaign type · Name · <Template> · [Format] · Targets · Context ‖ Review · Drafts · Send
```

- The template step's rail label follows the campaign type: **Request template**
  / **Update template** / **Template**.
- **Format exists for every campaign type except "Request a meeting"** — meeting
  requests always send as standard email. Custom keeps Format *and* keeps the
  Template step, which renders an explainer instead of a list.
- The rail numbers only the setup steps (1…6, or 1…5 without Format). `Review ·
  Drafts · Send` sit after a divider, un-numbered.
- **Every rail chip is clickable, in both directions.** The prototype has no
  forward gating and neither does this. The gates that matter are on the
  actions — accepting the packet, sending — not on navigation.
- A stale `format` step resolves *forward* to `targets`, so switching campaign
  type never strands the user on a step with no chip.

Every step title, subline and primary-button label lives in that module and is
the prototype's string verbatim. Components must not re-inline them.

## 3. How the steps reach the real Campaign Spec

`apps/web/src/vnext/pages/engagement/outreach-builder-model.ts`

Three of the prototype's decisions have no field on the Campaign Spec, so they
are mapped:

| Prototype decision | Where it lives |
|---|---|
| Campaign type | `goal.goal`, read back through the phrase the generator already keys on |
| Campaign name | `goal.topic` **and** a campaign-scoped `writing_guidance` ref titled `Campaign subject line` |
| Sponsor | `SET_SPONSOR_SCOPE` |
| Template structure | `SET_CONTENT_SKELETON` |
| Email format | a `writing_guidance` ref titled `Campaign email format · <name>` |
| Template options | a `writing_guidance` ref titled `Campaign template options` |
| Personal note | a target-scoped `target_specific` ref |

Reading a marker back by `title` is safe: the command engine copies
`locator.title` onto the resolved ref verbatim, and `subjectLineContextSelection`
has relied on that since the guided flow shipped.

## 4. Controls that are NOT wired to an endpoint

Built, because the standing rule is to build the UI ahead of the backend and
say which controls are not wired — not to quietly drop them. The authoritative
list is `OUTREACH_UNWIRED_CONTROLS` in `outreach-builder-model.ts`; it is
mirrored here for people who read docs rather than code.

| Control | What actually happens |
|---|---|
| **Email format** | Stored as campaign writing guidance. It steers generation; nothing validates that a draft came out as a briefing card. |
| **Per-template context options** | Same channel as the format. No per-template options field exists on the spec. |
| **Campaign document upload** | The context endpoint accepts an already-stored document id. There is no upload route for a campaign-scoped file, so the picker lists documents that exist and the drop zone reports rather than pretends. |
| **Send scheduling** | The send contract creates immediate intents only. "Send now" is the only real path — the prototype says so itself, in copy that ships verbatim. |
| **Send pacing** | Provider policy governs pacing. There is no per-campaign pacing setting to persist. |
| **Campaign subject line** | Stored as `goal.topic` and as campaign writing guidance telling the writer to use it verbatim. Each generated draft version carries its own subject; nothing validates that it matches. |

## 5. Deliberate divergences from the prototype

The prototype is a static mock. Where it is simply wrong or simply stops, it is
not followed:

- **Draft approval.** The prototype has no approve control, but the server's
  preflight blocks on `DRAFT_NOT_EXACTLY_APPROVED`. "Continue to send" approves
  the exact versions the reader has just been shown — which is precisely the
  prototype's own claim that "approval is pinned to the exact version you read".
- **Send confirmation.** The prototype's send button fires immediately, while
  its own gate copy says "The confirmation dialog is the only real-send
  trigger." The dialog ships.
- **Preflight check count.** The prototype hardcodes "Fourteen checks". The
  server returns a real number of real checks; that is what is shown.
- **Applying a saved audience** actually adds its members. In the prototype the
  card says "Saved" and the selection never changes.
- **Post-send.** The prototype ends at a toast. Real send progress, results,
  delivery reconciliation and reply learning already exist and stay.
- **Template management.** The prototype's template card has one action.
  Duplicate / Publish / Edit / Settings / History / Archive are real, shipped
  capability; they move behind a per-card overflow so the card reads like the
  prototype at rest, rather than being deleted.
- **Required fields are enforced.** The prototype marks the campaign name
  REQUIRED and then lets you continue without one.
- **Blocked primaries are `disabled`**, not dimmed-but-clickable.
- **A group is counted as one email.** The prototype has no group concept, so
  its Send step says "N emails, one person each" whatever the audience is. When
  the Targets step saves or applies a *group*, the campaign's delivery pattern
  becomes `shared_thread` and the server plans ONE message that shows every
  recipient to the others. The Send step counts the plan's slots, not the
  targets, and says so — and it does not promise that a blocked recipient on a
  shared email "receives nothing", because they do not.
- **"Create one from scratch"** says "Applied to this campaign only", not the
  prototype's "Saved to your personal library only". Nothing persists a content
  template today, and the same step says so twice more.

## 5b. What follows the send

The prototype's Send step ends at a toast. A real send creates a durable intent
that progresses through provider states, so once one exists the step shows the
record instead of the setup form: live progress while the provider works, then
the results — per-recipient delivery outcomes, replies synced, template capture,
and the governed reply-learning proposal. None of that is reachable anywhere
else, and `delivery_unknown` stays terminal there, so the record cannot spin
forever on an outcome no retry can move.

## 5c. Deleted with the old flow

`VNextOutreachWorkspace` (the seven-step planning rail), `VNextOutreachGuided
Workspace` (the superseded eight-step template-first flow), `VNextOutreach
OperatorWorkspace`, `VNextOutreachPhase1Workspace` and `VNextOutreachApproveSend
Workspace`, with their tests and stylesheets. `OutreachV3CompleteRoute` — the
canonical Engagement host — now mounts the same builder, so there is one
Outreach flow rather than two that drift.

## 6. Copy rule

Where the prototype and this implementation both have a string, the prototype's
string wins character for character — including its internal inconsistencies.
The campaigns empty state still reads "goal, targets, delivery, context,
immutable drafts, preflight, send" even though the builder has no Delivery step.
That is the prototype's sentence; changing it is a product decision, not a port.
