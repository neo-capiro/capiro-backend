# Restore the native vNext hearing room

PR #1499 repaired browser capture by mounting the older canonical room in vNext. This regressed the native hearing-room design. This repair restores the vNext presentation while retaining the repaired shared capture lifecycle.

## Changes

- Restore the session bar, dark health strip, video spanning the source/transcript columns, Source & capture panel, timestamped Live transcript, and Intelligence panel.
- Keep the existing 1179px/779px responsive layout rules and native LegiWatch tokens. App navigation is unchanged.
- Add a typed presentation boundary to the shared room. WebSocket tickets, capture readiness, recorder queues, final draining, consent, wake lock, persisted transcript/intelligence recovery, and recap persistence continue through the existing handlers.
- Use actual media playback controls and actual capture state. A saved session marked live does not by itself imply that this browser is recording.
- Restore transcript search, speaker and matched-only filters, pause/jump-to-live behavior, and intelligence timestamps that reveal their supporting testimony. Matching uses persisted/live intelligence cards. Long transcripts use virtualized rows.
- Keep the working Save recap flow. Do not restore the earlier no-op Save moment / Ask Meri buttons or decorative playback/quality indicators.
- No backend, recording-worker, rollout, or infrastructure changes.

## Verification

- 264 selected tests passed across 23 suites: the vNext LegiWatch folder, shared browser room, and wake-lock hook. Includes five critical capture/recovery cases exercised in both canonical and vNext presentations.
- A focused final run of the 28 room/capture/wake-lock tests also passed after the last adjustment. Tests cover repeated evidence jumps, filters, persisted/live intelligence deduplication, capture readiness, late callbacks, final draining, and upload overflow.
- A 14,400-segment/four-hour fixture verifies that transcript history remains searchable while the view mounts a bounded set of rows.
- TypeScript reported no diagnostics in changed room files. The whole web typecheck is still blocked by missing unrelated modules in this partial source snapshot; this is not a full build pass.
- The real view and stylesheet bundle successfully for a local fixture. Existing responsive tests pass. Browser visual inspection could not run because the browser refused the local preview URL (`ERR_BLOCKED_BY_CLIENT`); no screenshot or pixel-perfect claim is made.
- Diff whitespace checks passed.

## Before deployment

Run the full web build/CI and visually review the actual route at desktop and phone widths. Check a real browser session's video playback, consent, start/stop, transcript, intelligence, and recap. This focused UI repair preserves the prior long-session fixes; it does not constitute a new four-hour production soak or certify server capture deployment/configuration.

Base: `d762a5f91b8b25350687579112014161f81e4512`.
