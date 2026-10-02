# Case17 blocked-write accounting and screenshot correction

PASS source/tests only; LIVE acceptance NOT RUN.

Isolated clean commit `88e489f2939172de90c432b84fd037f273a1d4f0` on `codex/meri-case17-preference-accounting-20261002` in C:\dev\cap-meri-approval-recovery. Parent b673 and frozen v6 are preserved. This commit adds six files/changes; complete driver88 differs from code823 only in the seven eval paths listed in qualification.json (includes prior query-wait b673). No API, Web or orchestrator runtime changes; no new image required for this collector-only patch. A new operator must explicitly pin the seven driver paths/source hashes before any root-owned serial live execution. Do not edit/reuse frozen v6 in place.

All non-auth writes remain aborted at page/context guards; one shared accounting object avoids double counting. Only exact PUT to same-origin `/api/clio/vnext/preferences`, no query/fragment, during initial/afterReload panel navigation can be an accepted denied attempt. Bound3 per round/6total; other writes, writes outside panel rounds, unknown counts or owner change fail. Native cleanup validates the same final counts before minting opaque outcome authority. Current-owner and zero application/synthesis write assertions remain.

`case17/readonly-guard-diagnostic.json` persists both actual owner hashes, equality and safe write counts/categories before the final check, including failure. `case17/native-write-guard-diagnostic.json` persists post-cleanup final counts/session-revoke result. Unknown request paths are `[redacted]`; no body/header/query/auth state is stored.

Screenshot helper centers actual element in scroll ancestors, checks its rect against viewport and all clipping ancestor content boxes, then captures unchanged pixels. Cards that cannot fully fit fail rather than receive a visual PASS. Actual live D still requires visual inspection.

Validation: all6 case17 test files,16pass/0fail/0skip, exit0. Includes real Chromium aborted preference PUT and business POST, no duplicate accounting, upper bounds/foreign origin/query/other paths, nested clipping correction/oversized rejection, and actual nativeWindows collector diagnostic persistence on success, unknown write and changed owner. Exact commands/exits/log hashes: final-checks.json. The tests require explicit MERI_WINDOWS_ARTIFACT_TEST_ROOT and MERI_WINDOWS_ARTIFACT_PYTHON, supplied by run-checks.py. Initial test-only raster-rounding/charset failures are recorded in initial-test-failures.md.

Independent actual Bedrock Kimi review: session `20261002_122725_9160f2`, model moonshotai.kimi-k2.5, exit0,0tool calls,PASS; raw report and usage preserved. Its mistaken route ordering/finally wording and ambiguous exemption terminology are corrected explicitly in qualification.json; implementation/tests remain authoritative.

No AWS/sharedDB/auth/live model calls occurred. No main/GitHub changes. First01 failed continuation is unchanged; no budget materialization or aggregate initialization. Root owns final source review and next serial run.
