# Krisp sign-in popup repair

PR #2008 merged as `ac45312b829615a276dbe654065e7326bcfdaf06`.
The user reported the callback completion page failing after approving Krisp.
A scoped read-only production inspection found the pilot connector transitioned
from creation to disconnected in approximately three seconds, with all pending
OAuth credentials already removed and no saved access token. No credential
values were read or printed. No callback token-exchange or tool-discovery failure
was logged. This matches the UI's two-poll popup-closed cancellation path.

The old UI treated `popup.closed` as user cancellation. Browser COOP isolation
can sever the opener handle while the actual consent window remains open.
The checked-in headless Chromium reproduction demonstrates that condition.
See the [browser behavior documentation](https://developer.mozilla.org/en-US/docs/Web/API/Window/open).
The updated UI waits for backend connection status or the existing five-minute
timeout. It does not relax signatures, nonce validation, PKCE, issuer validation,
tenant gating, or provider permissions.

Two regression cases fail before the fix (closed handle and blocked handle
access) and pass afterward. All 54 tests in the eight connector/Krisp and standard
web release suites pass. The timeout test verifies abandoned authorizations
still clear pending credentials. Build publication uses the existing native
ARM64 CodeBuild fallback, canonical web Dockerfile, Node 22.23.3, exact source tag
and OCI revision label. The image build runs web TypeScript and Vite. Its offline
package probe requires the timeout message and rejects the removed premature
cancellation message. The recipe fails on any failed probe.

This is a web-only promotion with no schema or API/worker change. Relative to
the previous deployed web source, the only web change is this popup fix. Shared
code also includes the merged additive budget/bill citation helper repair;
existing response shapes remain accepted. No retired runtime imports, table
dependencies, feature flags, or deployment configuration are restored or changed.
The old/new web images remain compatible with the current API. Application
rollback uses the saved digest-bound service receipt and needs no schema change.

The user previously authorized merge and AWS deployment, then reported this
failure in that release. The implementing agent reviewed these results under
that continuing repair authorization. This is not an independent human review.
The previous failed authorization cannot be reused; live acceptance requires
refreshing Meri and starting a new Krisp connection after rollout. Build and
promotion receipts are added beside this record as they complete.
