# Engagement vNext — endpoint wire audit

Method, so the numbers can be re-derived rather than trusted:

1. Parsed every `@Get/@Post/@Put/@Patch/@Delete` in `apps/api/src/**/*.controller.ts`
   with its `@Controller` prefix — 901 routes, of which **171 distinct
   verb+path pairs** are Engagement-scope (`/engagement/**` plus
   `/memory/proposals/outreach-*`). Duplicate registrations from the twin OAuth
   controllers are collapsed.
2. Resolved every `api.get/post/put/patch/delete` call across all of
   `apps/web/src` — following `const ROOT = '/api/...'` constants, path helpers
   like `sessionPath()` / `outreachV3SessionPath()`, nested template literals,
   and query-string ternaries — to a concrete normalised path. 1312 calls.
3. Matched by verb + path with `:param` normalised.
4. Hand-verified all 31 non-matches by grepping for the path tail across every
   non-test, non-generated source. `engagement-api-preview-routes.generated.ts`
   is excluded on purpose: it is an allowlist of routes, not a caller, and
   counting it would have made every endpoint look wired.

**Result: 171 Engagement endpoints — 140 wired, 31 not. Zero frontend calls
point at a route that does not exist.**

---

## A. Backend endpoints with NO frontend caller (31)

Nothing below was built or stubbed. Grouped by *why*, because the groups need
different decisions.

### A1 — Not a frontend surface by design (4). No action.

Provider redirects and webhooks. The browser never calls these; Google/Microsoft do.

| Endpoint | Role |
| --- | --- |
| `GET /engagement/integrations/google/callback` | OAuth redirect target |
| `GET /engagement/integrations/microsoft/callback` | OAuth redirect target |
| `GET /engagement/integrations/microsoft/notifications` | Graph subscription validation handshake |
| `POST /engagement/integrations/microsoft/notifications` | Graph change notifications |

### A2 — Superseded Outreach 1.0 campaign API (10). Dead, deletion candidates.

Entirely replaced by `outreach-v3/sessions`. No caller anywhere in the web app,
including the v2 wizard.

`GET|POST /engagement/campaigns` · `GET|PATCH|DELETE /engagement/campaigns/:id` ·
`POST /engagement/campaigns/:id/generate` ·
`POST /engagement/campaigns/:id/recipients` ·
`DELETE /engagement/campaigns/:id/recipients/:recipientId` ·
`POST /engagement/campaigns/:id/send` ·
`POST /engagement/campaigns/:id/send-test`

`POST .../send` and `POST .../send-test` are live send paths with no UI and no
governed preflight in front of them. Worth confirming they are actually
unreachable rather than merely un-linked.

### A3 — Legacy v2 remnants (5). Deletion candidates, but check the v2 wizard first.

| Endpoint | Note |
| --- | --- |
| `PUT /engagement/outreach/ai-templates/:id` | v2 wizard does GET-list + POST-create only |
| `DELETE /engagement/outreach/ai-templates/:id` | same — no edit or delete UI |
| `GET /engagement/outreach/ai-templates/:id/preview` | no preview UI |
| `GET /engagement/outreach/draft-versions/:id` | V3 uses `sessions/:id/drafts/:versionId` |
| `POST /engagement/outreach/jobs/send` | superseded by the V3 send-intent spine |

### A4 — Real capability, no UI anywhere (12). These are the interesting ones.

| Endpoint | What the UI is missing |
| --- | --- |
| `GET /engagement/outcomes`, `POST /engagement/outcomes` | Outcome tracking has a controller and no surface at all. |
| `GET /engagement/debriefs` | Cross-meeting debrief list. The UI only ever reads `meetings/:id/debriefs`, so there is no "all debriefs" view. |
| `POST /engagement/meetings/:id/notes` | Notes can be read, PATCHed and approved, but **not created** from the UI. Only Meri writes a first note, so a meeting with no notetaker has no manual path in. |
| `POST /engagement/outreach-v3/sessions/:id/context/document` | Attaching a document to campaign context. This is the "sole-client `doc-*` attachments" leg of the Context step, and it is unreachable. |
| `GET /engagement/outreach-v3/sessions/:id/events` | Session event stream — the audit trail. |
| `GET /engagement/outreach-v3/sessions/:id/versions` | List of immutable Campaign Spec versions. |
| `GET /engagement/outreach-v3/sessions/:id/versions/:version` | One historical spec version. |
| `POST /engagement/outreach-v3/sessions/:id/proposals` | Creating a proposal. The UI lists, applies and rejects proposals but cannot create one. |
| `GET /engagement/outreach-v3/reasoning/conversations/:id` | Conversation detail. The UI creates conversations and reads/writes turns, never the parent. |
| `POST /engagement/outreach-v3/reasoning/conversations/:id/archive` | No archive control. |
| `POST /engagement/outreach/insights/talking-points` | Talking-point generation, unfronted. |

The three spec-history endpoints (`events`, `versions`, `versions/:version`)
matter more than they look: the builder tells the user *"Every confirmed change
creates a new immutable Campaign Spec version"*, and there is no way to see one.
That is a claim the UI makes and cannot back.

---

## B. Frontend / design controls with NO endpoint (nothing fabricated)

### B1 — In the V2 prototype, deliberately not built

| Prototype control | Endpoint status |
| --- | --- |
| **Format** step (writing format) | No spec field, no endpoint. Cut, per the handoff. |
| **Timing** — "Send now" / "Schedule" + date & time | `OutreachV3SendSettings` is `senderConnectionId`, `appendSignature`, `attachmentIds` only; the send-intent body is `excludedGenerationKeys`, `testGenerationKey`, `acknowledgeHeldOut`, `requestKey`. **No scheduling field exists anywhere in the send contract.** Not built. |
| **Pacing** — "Steady" / "Quick" | Same. No throttle or pacing field. Not built. |
| **"If some recipients are not ready"** — send-ready-now vs wait-for-all | No such field. The server decides `sendable` per version; there is no campaign-level strategy toggle. Not built. |
| **"Request New Outreach Type"** modal | No endpoint of any kind. Not built. |
| **"Export PDF"** on meeting prep | No PDF or export route on the engagement controller. Not built. |
| **Update-letter templates** (Hearings week-ahead, FO match digest, Awards roll-up) with ~10 knobs each | An entire prototype subsystem with no backing API. Not built. |
| Prototype global search + ⌘K palette, notifications panel | Shell concerns rather than Engagement, and the prototype's are simulated. Not built here. |

### B2 — Already in the repo, correctly disclosed before this change

- **"Repeat a previous campaign"** — omitted from the start-campaign chooser
  rather than shown dead (`VNextOutreachHome.tsx:37`).
- **Library text search** — no server-side text search exists
  (`MeetingLibraryQueryDto` has no text field, and the global `ValidationPipe`
  would reject an undeclared `q`). Relabelled "Filter this page" in this change,
  since it only narrows the loaded page of a paginated list.

### B3 — Was NOT correctly disclosed, and is fixed in this change

- **"Sync calendar"** in the vNext Meetings workspace was a **dead control**. It
  dispatched `capiro:sync-inbox`; the only listener is in
  `components/AppShell.tsx`, which `App.tsx` never mounts on the vNext surface.
  It now calls the real provider sync endpoints, and is disabled with a stated
  reason when no mailbox is connected.

---

## C. Two handoff premises that the repository contradicts

Recorded because acting on them would have removed working functionality.

1. **"Templates ships disabled behind a flag (decision 1)"** — the stated reason
   is that it "looks live, does nothing". It is fully built on both sides: 14
   server routes in `outreach-v3/templates/*`, all wired from
   `outreach-v3-template-api.ts`, with `VNextOutreachTemplates.tsx`,
   `OutreachTemplateWizard.tsx`, duplicate/publish/archive/provenance and passing
   tests. **Not gated off** — turning off a shipped feature is a product call,
   not a cleanup. Decision 1 appears to predate the Templates phase.
2. **"The prototype's four semantic states do not match"** —
   `engagement-tones.css` already carries the prototype's exact
   `navy / gray / warn / err` `[bg, ring, fg, dot]` table, verified in a live
   browser (`--eng-tone-navy-bg` resolves to `#edf3f7`, the prototype's
   `#EDF3F7`). A prior pass landed it.

## D. Out-of-scope defects found, deliberately not fixed

- `components/primitives.css` breaks `foundation-contract.test.ts`'s
  no-hex-literal guard on clean `origin/main` via six `var(..., #hex)` fallbacks,
  two of which (`#f2f0eb`, `#e8e5df`) are the reverted warm palette and one of
  which (`--uui-brand-solid, #444ce7`) does not match the token's real value
  (`#3e4784`). **Not removed:** `OutreachV3CompleteRoute.tsx:135` mounts
  `.capiro-vnext-root` *without* `.capiro-vnext-uui`, so `--uui-*` genuinely does
  not resolve there and those fallbacks are load-bearing. The fix is to define
  the tokens on `.capiro-vnext-root` too, which is a foundation change.
- `MeetingDetailPanel.tsx` — the Prep / Meeting Notes / Debrief strip has no
  `role="tablist"` / `role="tab"` / `aria-selected`, and the drawer overlay uses
  an inline `zIndex: 40`, off the foundation ladder. Shared with the non-vNext
  surface, so out of this scope.
- `apps/web` has no runnable `eslint` in this worktree, and its `lint` script
  still uses ESLint 8's `--ext` flag. `pnpm --filter @capiro/web lint` cannot be
  part of a definition of done until that is fixed.

## E. Open question that blocks the Meri deletion

Decision 4 removes Meri from Engagement. The dead rail plumbing can go, but
**Send Meri** (notetaker), **Generate with Meri** (prep/debrief) and **Edit with
Meri** (draft refine) are separate capabilities on real, wired endpoints
(`POST /meetings/:id/notetaker`, `POST /meetings/:id/prep`,
`POST /meetings/:id/debrief-draft`,
`POST /sessions/:id/drafts/:artifactId/refine`). Nothing has been deleted pending
an answer. `VNextOutreachOperatorWorkspace` and `outreach-meri-operator.css` are
left in the tree, unrouted.
