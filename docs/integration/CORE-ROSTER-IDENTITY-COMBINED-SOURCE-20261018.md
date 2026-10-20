# Core roster and history-release identity source

Status: local integration candidate; no history-release route is mounted or deployed.

This successor starts at the reviewed roster source `b97a3286487abcda6a7424cf1dc2812d93b65b3d` and applies the one-file Core middleware proposal from Meri draft PR188 `b3611559582be27f4545509d9c2f03dc3b1332cd` (`tenant-context.patch`, blob `46c92b55728dbf1bb6f65d2b6f2787c90f3a386d`). The first patch hunk sits after the roster Host mirror; the methods and local identity read retain the proposal's exact behavior.

The roster Host decision remains the first action in tenant middleware. It admits only exact native roster GET and rejects every other reserved-Host request before ordinary context resolution. The process gate sets `Cache-Control: no-store` before forwarding an admitted request to JSON parsing. For all other Hosts, the approved first-chat native GET/HEAD handling remains in place.

The history-release addition sets `no-store` on the proposed path and offers two unmounted methods: original user/tenant/member `FOR SHARE` locks and a fresh same-session Clerk plus local identity read on the caller's transaction. A future history owner must call them inside one `REPEATABLE READ` transaction, retain those locks through the final online observation and commit, and enforce the remaining batch/wire/selected-client contract. No caller or controller exists in this source candidate.

Focused verification: seven roster/config/history suites, 136 tests passed; `git diff --check` clean. This does not establish live Clerk, database role, transaction timeout, route behavior or deployment readback. The Core image and frontend roster source/URL admission remain held until separately qualified.
