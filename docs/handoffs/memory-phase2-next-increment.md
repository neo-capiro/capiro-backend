# Memory Review UX Phase 2 — Next Increment

Implement immutable revision and resubmission after a reviewer requests changes.

Required outcomes:

1. Only the original proposer may submit a revised candidate.
2. The revised candidate is immutable and links to its predecessor.
3. Revision numbers increase monotonically.
4. The predecessor becomes superseded atomically with successor creation.
5. Authorization, ethical-wall access, client status, grants, and reviewer eligibility are evaluated again.
6. Active memory remains unchanged until independent approval of the revised candidate.
7. Concurrent revisions produce exactly one live successor.
8. Compatibility routes cannot bypass the revision workflow.
9. Tests cover lineage, concurrency, lost access, blocked clients, and terminal-state races.

Do not begin notifications or the Review Inbox redesign until this increment passes its focused gate.
