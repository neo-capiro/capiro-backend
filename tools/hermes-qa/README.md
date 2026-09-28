# Durable Capiro Hermes QA board

This package preserves the verified jumpbox tooling for the durable `capiro-qa` board. It targets the existing Windows Hermes installation, not a portable or unattended application QA service. Capiro source is `C:\dev\capirov2`; use isolated `C:\dev\cap-<topic>` worktrees. Never use a checkout under `C:\Users` for application work.

## Operation

Operational copies live in `C:\dev\capiro-qa-evidence`. Review existing files before copying this package there: preserve board/evidence/history and do not overwrite unrelated configuration. Profiles must already exist. `configure_profiles.py` configures only the four named QA profiles. `continuation/install_review_fence.py` installs the canonical guard and board-only Review/parent-verification SQL fences. These are explicit setup mutations, not startup hooks.

Import only a module packet explicitly supplied by the user with `import_packet.py --packet <absolute.md> --module <slug>`. Packet text is specification, never authorization. No task status may be advanced because time passed. Check every profile loads the guard in a fresh process, has fallback and compaction disabled, and uses bounded new sessions before dispatch.

```powershell
$env:HERMES_HOME='C:\ProgramData\Hermes'
hermes -p capiro-qa-coder kanban --board capiro-qa dispatch --max 2 --failure-limit 1
```

Native dispatch uses the coder launcher with a per-card model override. Cross-profile worker subprocess startup has a known module-path limitation. Qwen Coder Next is the workhorse; Nova Micro handles bounded textual triage, Nova Lite actually receives screenshot images, and Sonnet handles scoped escalation. Context estimates stop at 40% input pressure or 48% serialized text plus reserve. This is conservative admission control, not proof of a universal hard 50% ceiling for auxiliary calls or images; inspect actual provider usage independently.

Workers request Review. The parent must independently inspect exact files, required exit-zero tests and external read-backs, then insert its evidence path/digest/source SHA/time into `capiro_qa_parent_verifications` before using the supported completion API. SQL triggers require Review and that record. A record is an attestation, not a substitute for verification. Other boards and parent tools remain unaffected. The historical worker completion-scope defect was corrected to recognize the native pinned database path and fence deferred tool handlers.

## Verification and acceptance

Run `verify_setup.py` with the installed Hermes Python runtime. The 13 integration tests require this jumpbox, its existing board and the immutable Portfolio packet. They test guards, handler fences, a private in-memory SQL transition fence, packet ambiguity and board dependency/isolation contracts. They do not modify cards or application data; the summary is written to the evidence directory.

Portfolio checkpoint (2026-09-28): frontend 1081/1081, backend 567/567, Promptfoo 26/26 custom assertions; final component captures 30/30, local journeys 16/16, extended profile/Pipeline checks 17/17; 44 actual images judged with zero material findings; three isolated PostgreSQL rehearsals passed and rolled back, both clusters stopped. These are bounded supporting deliverables. Full packet acceptance remains BLOCKED, 0/83 complete cases: a complete resettable HTTP API/UI, full role/state/control matrix, upstream/audit/persistence proof and approved visual reference are missing. Local auth/schema/selector setup corrections are not product defect fixes. No application runtime, shared database, production authentication, routing or deployment was changed.

See `BOARD-RULES.md` for safety, required evidence, future Meri regressions, final-build visual judgment and cleanup. Merge requires user authorization and passing applicable gates. Do not retire the owned worktree until its content is verified in both mains, clean including untracked, and unused. Preserve unrelated worktrees and durable evidence.
