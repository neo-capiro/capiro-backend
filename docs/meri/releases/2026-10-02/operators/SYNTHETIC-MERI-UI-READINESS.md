# Bounded synthetic UI smoke readiness

Status: NOT RUN. This packet prepares a fresh authenticated check after root confirms all three released service digests and the two-tenant canary apply receipt. No authenticated request, session, or Meri turn was executed during preparation.

Shared policy freshly fetched and read at `39590a3bfc57ce03b0411ff7912a7c8d99deb70c`. Machine map resolves Playwright to `C:\dev\node_modules\playwright`, application source to `C:\dev\capirov2`, Hermes credential store to `C:\ProgramData\Hermes`. Script source dependencies resolve from the currently occupied release worktree without changing it.

The old `C:\dev\cap-meri-foundation-evidence\fixture-browser-auth.cjs` demonstrates the existing synthetic Clerk ticket mechanism but must not be launched as-is: it persists browser authentication state, a screenshot, and raw page text. The September 30 `file01-parallel-20260930\live-qa-prep-report.md` and `verify-live-qa-synthetic-identity.cjs` provide prior preparation evidence only. Fresh identity checks are built into the new script.

## Execution gate

Root must create a separate copy of `synthetic-meri-ui-readiness-template.json` after verified release and cohort enablement. Set `ready: true`, actual merged source, three served digests matching the reviewed canary plan, the reviewed plan path, the VERIFIED apply receipt path, and an expiry no more than 15 minutes in the future. The template deliberately cannot execute. This local gate records root's deployment release; it is not independent AWS verification.

Then a newly assigned, bounded actual Hermes operator may run exactly:

```powershell
node C:\dev\cap-meri-foundation-evidence\oct02-release-path\synthetic-meri-ui-smoke.cjs --readiness C:\dev\cap-meri-foundation-evidence\oct02-release-path\synthetic-meri-ui-ready.json --execute-two-synthetic-turns
```

The helper uses ordinary synthetic `pat` in `meri-foundation-20260928-t1` and separate `t2Actor` in `meri-foundation-20260928-t2`. It validates the configured Clerk instance, exact fixture org slug and namespace, synthetic email/name markers, and exactly one ordinary membership in the intended org. It never uses a personal browser profile or prior authentication state.

Each tenant uses a separate ephemeral Chromium context at `https://os.capiro.ai/meri/new`. Only one new unscoped conversation POST and one exact no-tools chat POST can pass the browser request guard. Creation redirects are disabled. Other mutation requests stop the run. The fixture manifest and Clerk secret are read only inside the process and never printed or persisted. Freshly created Clerk sessions are revoked in cleanup. No screenshots, traces, HAR, storage state, raw page text, raw responses, or session IDs are saved.

The prompt asks only for `Meri smoke check complete.` and expressly forbids tools, retrieval, memory, business changes, tasks, and external sends. This is a no-tools observation assertion, not a server-side tool-disable switch. The result requires HTTP success, a done frame, zero error/tool-call frames, exact reply visible, and correct identity. It deliberately does not test retrieval, citations, starter behavior, or the full 75-case original File01 acceptance.

An exclusive permanent task-local execution lock prevents another automatic run after a possibly accepted request. On failure, stop and reconcile the sanitized counts/result; do not remove the lock, retry a chat turn, broaden request allowlists, switch identity, or bypass a readiness error. Setup failures are not automatically product defects. Output is `synthetic-meri-ui-smoke-result.json`; actual process exit must be captured by the operator separately.

The script received an independent source review from the CD lane. Their concrete fixes were applied: `/meri/new`, creation `maxRedirects: 0`, and process-only session revocation. Syntax checking is the only execution allowed during preparation; authenticated assertions remain NOT RUN.
