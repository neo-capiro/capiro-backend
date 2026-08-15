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
