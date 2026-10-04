# One-time Case12 failed-capture remediation

The initial Case12 capture failed before model dispatch and left a zero-cost ledger on its conversation. The ordinary installer correctly refuses replay. A separate operator-only owner can now archive that exact historical state and install one distinct run/conversation, reusing the completed 510-record setup. It rechecks the native corpus, expired zero-attempt ledger, owned empty conversation, database row versions and plan hash. Old conversation metadata stays unchanged; fresh provider qualification is required. Current authority is fenced to the new conversation. There is no new route, setup execution, provider call or model change.

Validation: 30 PostgreSQL tests plus 72 authority, budget and readback tests pass; API typecheck passes. PGlite does not simulate concurrent backends. The initial mixed VM-mode suite and typecheck failures are retained, alongside corrected final runs. The actual configured Hermes session reached its 45-minute limit with a partial draft; root completed the implementation and tests. No new paid capture or human acceptance is claimed.

Build qualification will retain the existing 28 API packaged probes and add the remediation owner/conversation-fence probe. Deployment remains separate from this source qualification.
