# Meri v3 undocked — pixel-parity report

Presentation-only pass on `feat/vnext-meri-pixel-parity`. No endpoint, payload, query-key, or streaming-transport changes.

## §8 defects

| # | Fix | File · region |
| --- | --- | --- |
| 1 | Floating window on `#E7ECF1` backdrop, 20px inset, 1560 / `min(940px, 100vh-40px)`, radius 14 | `vnext-meri.css` `.vnext-meri-page` / `.vnext-meri`; `VNextMeriShell.tsx` `data-meri-window` |
| 2 | Dock / maximise / close, 32px, working states + docked pill | `VNextMeriTopBar.tsx` chrome buttons; `VNextMeriShell.tsx` docked pill; `meri-prefs.ts` |
| 3 | Product mark `public/assets/meri-logo.png` at 26px + divider + `LayoutAlt01` | `VNextMeriTopBar.tsx` brand cluster; `VNextMeriConversation.tsx` landing mark |
| 4 | Every emoji / text glyph replaced with `MeriIcon` from the purchased 164-set | `meri-icons.tsx`; all `VNextMeri*.tsx` |
| 5 | Kit identity mark `size="sm"` (32px) + status dot, not a 44px circle | `VNextMeriTopBar.tsx` `IdentityMark` |
| 6 | Scope chip: `Building01` + mono 11px + `ChevronDown`, inset ring | `VNextMeriTopBar.tsx`; `vnext-meri.css` `.vnext-meri__scope-trigger` |
| 7 | New chat is inline 36px metal + `Plus` 16 | `VNextMeriThreadRail.tsx`; extra CSS `.vnext-meri__new-chat-btn` |
| 8 | Rail order Saved prompts → Workspaces → Recent | `VNextMeriThreadRail.tsx` `data-meri-rail-section` |
| 9 | Rail search, 200ms debounce, local + `GET /api/clio/conversations/search` | `VNextMeriThreadRail.tsx` `data-meri-rail-search` |
| 10 | Row menu → Delete → confirm → archive mutation + Undo restore | `VNextMeriThreadRail.tsx`; `VNextMeriWorkspace.tsx` `archiveThread` / `restoreThread` |
| 11 | 20px ringed kind-icon tile | `VNextMeriThreadRail.tsx` + `threadKindIcon()` |
| 12 | Server title, else first-available user text to 48 + `…` | `meri-presentation.ts` `displayThreadTitle` |
| 13 | 32px `#F2F4F7` kind circle + 15px icon | `VNextMeriConversation.tsx` header |
| 14 | Inter sentence-case sub-line | `threadScopeSubline()` |
| 15 | Reasoning chip `MODE · {TIER}` + menu (existing API) | `VNextMeriReasoningControl.tsx` |
| 16 | Bookmark + overflow 32px (honest disabled until a verb exists) | `VNextMeriConversation.tsx` |
| 17 | 820px column + `data-meri-column` | `VNextMeriConversation.tsx` |
| 18 | White canvas in `standard` / `empty` | `.vnext-meri__conversation-scroll.is-standard` |
| 19 | Day dividers between local-date groups | `VNextMeriConversation.tsx` |
| 20 | User bubble `12px 12px 4px 12px`, no author line | `VNextMeriMessage.tsx` `data-meri-user-bubble` |
| 21 | 26px inverted mark + time only | `VNextMeriMessage.tsx` |
| 22 | Sanitized GFM + Meri answer grammar | `VNextMeriMessage.tsx` + `.vnext-meri-md__*` |
| 23 | Unterminated fences buffered; fence stays `pre` unless an analysis artifact exists | `visibleMarkdown()`; existing `AnalysisChartCard` |
| 24 | Source strip + chips + `GROUNDED` | `VNextMeriSourceChip.tsx`; `VNextMeriMessage.tsx` |
| 25 | Ungrounded strip in Inter + `NOT GROUNDED` (server statement is a logged gap) | `VNextMeriMessage.tsx`; `docs/handoff/GAPS.md` |
| 26 | Quick-action icon tiles, not letters | `VNextMeriContextRail.tsx` |
| 27 | 66px badged strip, persisted | `VNextMeriContextRail.tsx`; `meri-prefs.ts` |
| 28 | 10px thumb, no OS arrow buttons | extra CSS scrollbar rules |
| 29 | Inter + IBM Plex Mono already loaded in `apps/web/index.html`; Meri sans forced to Inter | `index.html`; `--meri-font-sans` |

## Verification

Focused tests (this pass): `meri-presentation.test.ts`, existing `VNextMeriReasoningControl.test.tsx`, `meri-route-state.test.ts`.

Live §9 DOM assertions and 1024 / 1200 / 1440 / 1600 screenshots require a signed-in vNext session and are not claimed from this CLI run.

## Scope

Touched: `apps/web/src/vnext/meri/**`, `apps/web/public/assets/meri-logo.png`, `apps/web/public/untitledui/meri-icons.js`, `docs/handoff/GAPS.md`, `docs/handoff/meri-parity-report.md`.

Not touched: `apps/web` legacy chat components, API contracts, query keys, streaming transport.

---

# Meri v4 standalone-handoff parity pass

Second presentation-only pass, against `design_handoff_meri/README.md` (the v4
standalone handoff) rather than the earlier v3 defect list. No endpoint, payload,
query-key or streaming-transport change; every new string is server-derived or
verbatim handoff copy.

| Handoff § | Gap closed | File · region |
| --- | --- | --- |
| §3 `MeriDepthPicker` | Chip reads `DEPTH · {TIER}`, menu eyebrow `REASONING DEPTH · THIS THREAD`, four descriptions verbatim. Renamed from `MODE ·` specifically so it is not confused with the composer's Task Mode. | `VNextMeriReasoningControl.tsx` |
| §3 rail toggle | Thread rail collapses; `Menu02` expand button at the left of the conversation header, and on the greeting row on home (which has no header). | `VNextMeriShell.tsx`, `VNextMeriConversation.tsx`, `VNextMeriThreadRail.tsx` |
| §2e search snippet | Matched excerpt under title+meta, only while the rail search has a query. Server hit snippet preferred; local-filter rows fall back to the latest message body. | `VNextMeriThreadRail.tsx` |
| §1a scope selector | `This thread` row showing the server's recorded scope, rendered only when it differs from the current selection. | `VNextMeriTopBar.tsx` |
| §1b capability popover | Third card, `Ask for the deliverable, not the tool`, verbatim. | `VNextMeriTopBar.tsx` |
| §4d skill tag | `DEEP RESEARCH · COMPLETE` / `SKILL · {INTENT}` beside the assistant timestamp, from the research report or the router's own intent code. | `VNextMeriMessage.tsx` |
| §4g streaming cursor | 8×16 block cursor + `COMPOSING ANSWER…`, replacing the three-dot ellipsis. | `VNextMeriMessage.tsx` |
| §10a verification chip | `ALL CLAIMS CHECKED` / `N CLAIMS UNSUPPORTED` / `MEDIUM CONFIDENCE` / `LOW CONFIDENCE` / `NOT VERIFIED` / `REVIEW FLAGGED`, mapped from the real verification block. Coverage stays a separate pill — the four trust signals are not merged. | `VNextMeriMessage.tsx` |
| §10a evidence toggle | `EVIDENCE` / `HIDE EVIDENCE` moved into the trust row as its last control, with a chevron. | `VNextMeriMessage.tsx` |
| §11a message actions | `COPY` (+ `Answer copied.` toast) and an icon on `REGENERATE`, in a `padding:11px 18px` row with a right-aligned audit stamp. | `VNextMeriMessage.tsx` |
| §11c follow-ups | `SUGGESTED NEXT` eyebrow + `CornerDownRight` chips that **fill the composer** instead of auto-sending. | `VNextMeriMessage.tsx` |
| §12 `MeriTaskModePicker` | Segmented `STANDARD` / `RESEARCH` / `WRITE`, wired to the controller's real `researchMode` / `writeMode` flags (derived, not a second source of truth). | `VNextMeriComposer.tsx` |

## Honesty notes — where the fixture was NOT copied

- **Audit stamp.** The handoff fixture reads `AUDIT TRAIL ON · 7 OF 9 SOURCES
  CHECKED`. The orchestrator sends no "sources attempted" figure, so the stamp is
  built only from resolved citations and real verification counts
  (`… · 4 SOURCES · 7 OF 9 CLAIMS VERIFIED`), and is omitted entirely when a turn
  carries neither rather than printing `0 SOURCES`.
- **`FIXED AT CREATION`.** The prototype labels the thread-scope row that way, but
  in this build a scope change is an audited move that affects later answers, so
  the row reads `RECORDED SCOPE · {SCOPE}` instead of asserting immutability the
  server does not enforce.
- **Thread-rail collapse persistence** is client state; the preferences DTO
  rejects a fourth key. Logged as `GAPS.md` §28.

## Verification

```
tsc --noEmit ......... CLEAN
vitest src/vnext/meri src/vnext/foundation-contract.test.ts
                       25 files / 156 tests PASSING
visual (CDP) ......... 5 fixture screens via the Clerk-free harness
                       (vite.harness.config.ts): answer, unsupported-claims,
                       composer, streaming, depth chip
harness files ........ removed; git status clean
```

The visual pass is a **structural** check against the handoff's stated geometry,
not a numeric pixel overlay. It caught three defects the green suite could not
see: the actions/follow-up rows were missing the §11a/§11c `18px` gutter (COPY
flush to the card edge, audit stamp clipped), the new task-mode picker wrapped
the Send button onto a second line at column width, and the depth chip still read
`MODE ·`. All three were fixed and re-captured.

Live §9 DOM assertions against a signed-in session remain unclaimed from this CLI
run.
