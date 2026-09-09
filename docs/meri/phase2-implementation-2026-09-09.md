# Meri Phase 2 — downloads and scope attribution

Implementation base: upstream main `cab0e866dc0d0873f177d88c6ef1e90526ffb495`, including merged Phase 1 PR #1552. The [Phase 0 register](phase0-contract-map-2026-09-09.md) remains the original source audit. This change implements MW-01, MW-02 and MW-05. No migration or dependency change is required.

## Changes and acceptance evidence

| Finding | Implemented behavior | Verification |
| --- | --- | --- |
| MW-01: authenticated artifact downloads | Inline Markdown controls and the artifact canvas use the same authenticated canonical download request. Every attempt obtains current auth and the same stored artifact ID. UI shows progress, timeout, access errors and retry; it rejects empty/unexpected responses and cancels stale requests after context changes. Server filenames are honored and blob URLs remain alive long enough for the browser download to start. | Web helper, inline, actual message renderer and canvas tests cover Office formats, decorated URLs, fresh-auth retry, hung auth, cancellation, reopen, payload failures and external-origin isolation. API tests generate actual DOCX ZIP bytes and read them with Mammoth, retaining all eight Glass Harbor fixture values and the original document ID/filename. |
| MW-02: historical source and context scope | V3 captures the dispatch-time client identity and actual retrieval scope in existing message metadata and SSE. Source detail and Show work use that turn's scope, independent of the current picker. Historical context opens by the message's persisted packet ID. Latest-context navigation clears old content during a thread change. Legacy records use only authoritative stored associations; unknown scope stays explicit. | Capture, persistence, hydration, message callback and rail tests cover both client directions, portfolio/external/general scopes, source navigation/reopen, renamed clients, absent metadata, exact historical packet access and thread changes. |
| MW-05: proposal targets | Every review/owned proposal card shows its actual client, firm or personal target. Queue text explains that it spans authorized firm proposals and is independent of the picker. Canonical services resolve client names only after authorization and reviewer assignment; restricted names remain hidden. | UI/API tests cover changing the picker, exact approve/reject/withdraw IDs, refreshed status, restricted targets, missing names and denied actions. Meri now collects the reason already required by the canonical rejection API. Governance rules remain unchanged. |

The download response exposes only `Content-Disposition` for filename reading and uses `Cache-Control: private, no-store`; no bearer token is put in a URL. Existing tenant/user document lookup remains authoritative. Review also found an adjacent chart-embedding lookup that checked tenant alone. It now checks the current user as well; generated-document tests verify that another user's chart bytes cannot be embedded.

These changes preserve the canonical artifact store, governed Institutional Memory and provider reasoning. Captured **turn scope** describes the answer's retrieval context; it does not claim that every cited source belongs to that client.

## Validation limits

160 distinct tests across 14 focused suites passed: 73 API tests across six suites and 87 web tests across eight suites. The combined web run passed 85 tests, followed by a 17-test rail/message rerun containing two additional regressions for out-of-order packet responses and the message scope callback. Web TypeScript passes; API TypeScript reports the same 10 diagnostics as the untouched baseline, with no new diagnostics. Those baseline failures concern existing test constructor mismatches and the environment's `simple-statistics` CommonJS/ESM resolution.

API tests use the repository Jest configuration with the local CJS `htmlparser2` compatibility mapping. The artifact suite isolates unrelated service graphs and a defense-budget helper affected by test-runtime module resolution. The document service, DOCX renderer, ZIP contents and Mammoth parser are real; persistence is exercised through a controlled Prisma-port double. This establishes service behavior, not deployed HTTP authentication, real database RLS or desktop Word rendering.

## Live status

Before implementation, the existing live Word link still returned `401 Missing bearer token`; the historical Anduril source still displayed `SCOPE L3 Harris`. The old generated document retained the eight synthetic fixture values in the transcript. These observations establish the repair baseline, not successful browser acceptance of this branch.

This branch has not been merged or deployed. After deploying the reviewed candidate, complete these checks against the actual candidate revision:

1. Download the existing Synthetic QA Memo from its inline control and the canvas. Open the actual files and confirm Glass Harbor, $7,500,000, FY2027, internal draft/not approved or enacted, September 16 2026 at 10:00 UTC, Policy lead, September 14 2026, and `BLUE-ORBIT-47`. Repeat after reopening the conversation. Check expired authentication recovery and a denied second identity.
2. Run L3 → Anduril → L3 and the reverse, including portfolio transitions. Open old sources, Show work and each answer's context packet after reload and reopening another window. Verify original scope and exact packet identity while new sends use the newly selected client. Legacy missing scope must remain unavailable.
3. With controlled proposals for two clients, verify actual target labels under either picker and portfolio. Approve, reject with a reason, and withdraw eligible synthetic proposals, then read their canonical statuses and target IDs. Verify a non-reviewer cannot act and restricted client names remain hidden.

Phase 2's live exit gate remains open until those post-deployment checks pass. PDF export, full-source content and later-phase workflow repairs retain their separate planned scope.
