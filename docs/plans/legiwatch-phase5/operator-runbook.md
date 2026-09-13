# Phase 5 operations (candidate in preparation)

Do not release from this initial checkpoint. Existing Phase 4 and provider schedules remain in force. `LEGISCAN_VOTE_REFRESH_CAP` bounds detail refreshes per existing bill-drain invocation (default 200; maximum 1000). Changed bill hashes request detail checks but do not create changed vote evidence unless normalized content changes. Incomplete details leave a partial source state and the bill queued for the next invocation.

No history deletion, message replay, source grant or recipient activation is part of migration. Rollback must preserve immutable evidence and hold stale unsent work; it must not discard prior publications or stop unrelated capture/delivery kinds. Exact release, rollback and source-specific qualification commands are pending the implemented candidate and its validation.
