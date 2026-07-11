# Meri Dock/Undock UI QA Evidence

Date: 2026-07-11
Branch: `ship/meri-dock-undock`

## Visual source of truth

Reference handoff captures:

- `prototype-launcher.png`
- `prototype-docked.png`
- `prototype-undocked.png`
- `prototype-undocked-collapsed.png`

Final production-surface captures:

- `implementation-launcher-final.png`
- `implementation-docked-v3.png`
- `implementation-undocked-empty-v2.png`
- `implementation-undocked-thread-collapsed-v3.png`
- `implementation-undocked-maximized-final.png`
- `implementation-mobile-emulated-final.png`

The mobile image was captured through Chrome DevTools viewport emulation at exactly 390×844. The earlier `implementation-mobile-final.png` used Chrome's desktop minimum layout width and is not acceptance evidence.

## Visual verdicts

| State | Verdict | Notes |
|---|---|---|
| Launcher | PASS | Official existing Meri bubble, gradient, presence dot, 22px corner placement, no clipping. |
| Docked thread | PASS | All response actions and suggestions clear the composer; no horizontal overflow. |
| Undocked empty | PASS | Full 2×2 starter grid, intact hero mark, balanced sidebar/main layout. |
| Undocked collapsed thread | PASS | User bubble fully contained; complete text and rounded edge visible; actions aligned. |
| Maximized | PASS | Intended viewport insets, full containment, no clipping. |
| Mobile 390×844 | PASS | Full-screen containment, readable controls, usable stacked starters, no horizontal overflow. |

## Automated verification

- API feature resolver: default OFF, explicit tenant true/false covered.
- Window-state compatibility: `setChatOpen(true)` opens docked; false closes.
- Geometry: default/max rects, clamp, edge resize, malformed localStorage rejection.
- Custom dropdown: listbox semantics, selection, Escape close.
- Inbox banner: hidden-empty state, schedule rendering, priority styling, dismiss and clear-all.
- Memory: inline edit, Enter commit, reversible Forget/Undo.
- Overlay integration: open, close, dock, undock, redock, shared conversation, details toggle.
- Production visual fixture: real docked thread and undocked empty shell.
- Existing message regression: Markdown/GFM tables, citations, source drawer, verification, sanitization, copy.

## Functional parity checklist

- Conversations: create, rename, assign client, save, archive, search/load.
- Streaming: standard SSE, Stop, close-abort, trace/plan/thinking, suggestions.
- Turns: regenerate, edit/resend, feedback toggle, copy.
- Attachments: upload, limits, status/error/truncation chips, removal.
- Research: plan, clarification, run/skip, report stream, open page, Word download.
- Artifacts: streamed canvas, chart cards, copy/download/close/error handling.
- Trust: citations, source drawer, verification/confidence warnings, approval-gated writes.
- Integration events: draft updates, workflow updates, page writes.
- Memory: recent fetch, expand, inline edit, delayed forget with Undo.
- Alerts/scheduling: launcher badge, conditional banner, per-alert dismiss, clear-all; existing natural-language schedule/list/cancel tools remain unchanged.
- Workspace editor rail: `MeriPanel.tsx` unchanged.

## Rollback

`meriDockUndockUi.enabled` defaults to false. Set the tenant flag false to return immediately to the legacy global drawer without reverting code.
