# Phase 4 acceptance evidence

Implementation, tests, deployment, activation and client acceptance are separate.
An entry remains pending until its evidence is linked here.

| Gate | Status | Evidence |
| --- | --- | --- |
| Evidence integrity and Phase 3 baseline | Verified | 45 manifest hashes/sizes; merged PR #1607; isolated current-main branch |
| Additive migrations and RLS | Pending | Disposable PostgreSQL required |
| Durable browser audio, reopen and seek | Pending | Real decoded retained media required |
| Four-hour browser capture | Pending | Actual elapsed >=4 hours; simulated time is insufficient |
| Four-hour unattended capture | Pending | Separate worker run, viewer closed, fencing and recovery |
| Source permission and state bridge | Pending | Source-specific evidence and exact event/session identity |
| Reviewed email and delivery races | Pending | Current audience, immutable evidence and authorized receipt |
| SMS consent, suppression and receipt | Pending | Purpose-bound verification plus account readiness |
| Versioned unofficial recap and export | Pending | Every factual claim resolves; approved bytes preserved |
| Figma, accessibility and browser regression | Pending | Product-file Phase 4 states and implementation screenshots |
| Release, rollback and client acceptance | Pending | Exact images/tasks, qualified activation and owner acceptance |

## Incremental local evidence (not release acceptance)

- API state attendance/federal regression: 46 tests passed; four new scoped state
  permission tests passed.
- Real PostgreSQL state media/demand plus FFmpeg runtime: eight tests passed,
  including two tenants/one capture, current permission, cancellation, gap denial
  and immutable storage retry.
- Recording/publication PostgreSQL: 19 tests passed at the preceding checkpoint;
  subsequent playback revocation assertions are awaiting their next run.
- Existing API inbox integration: two tests passed, including two independent
  concurrent clients, immutable version/hash, actual internal user UUID,
  wrong owner and removed membership. The first attempt hit the local client's
  two-second transaction-start deadline; the rerun uses independent clients with
  bounded ten-second fixture transaction settings.
- Approved document tests: five passed, including deterministic DOCX bytes,
  hash/client matching and permission withdrawal before attachment write.
- API full typecheck, Intel typecheck, web typecheck and Meri build passed at the
  preceding checkpoint; later edits require another final check.
- Both four-hour gates remain pending. The first server long run failed; its
  replacement began at 22:09:25.805 UTC. Details and honest fixture limitations
  are recorded in the engineering note.

No messages, hearing captures or Phase 4 production mutations have been performed
at this baseline checkpoint.
