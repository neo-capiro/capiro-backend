# API compiler capacity qualification

Hosted runs at b40d25e70 failed before completing their existing compilation gates:

- Federal market job 109237090122 exhausted the default approximately 2 GiB Node heap during the API package typecheck and exited 134.
- Engagement job 109237089576 exhausted its 4 GiB Node heap during the same API package typecheck and exited 134.
- Outreach Phase 3 job 109237089502 reached the nested Phase 2 API production build, exhausted the default heap, and exited 134.

The two typecheck steps now allow 6144 MiB and run their unchanged Turbo package selections with concurrency 1. The nested Phase 2 API production build receives the same bounded allowance while preserving inherited Node options. This changes compiler capacity and scheduling only. Existing assertions, filters, test counts, failure propagation, migrations and application behavior are unchanged. Other workflow steps retain their existing settings.

PASS: the full apps/api/tsconfig.json compiler, including spec files, exits 0 with the 6144 MiB allowance at source 84c3465d7. The complete API/web Turbo typecheck also exits 0 with concurrency 1 and forced execution: seven tasks pass, with zero cached results. This includes the API package's additional TypeScript projects and its existing safety verifier. The API production build exits 0 with the same heap setting. Scoped Prettier, verifier syntax and whitespace checks pass. These validate the changed commands, not the complete hosted workflows or the complete nested Phase 2 verifier.

Independent Hermes/Bedrock Kimi static review exits 0 with SCOPED PASS for the three-file diff. Its assertion that concurrent heap accumulation caused the hosted failures is not established by the logs; the evidence establishes per-process heap exhaustion. Serial scheduling is a precaution against simultaneous large compiler heaps, not a proven diagnosis of host-wide exhaustion.

Hosted qualification remains NOT RUN for this repair. At source 84c3465d7, GitHub returned startup_failure with no jobs/check runs. A rerun of previously successful job 109237089361 at unchanged source b40d25e70 also returned startup_failure with zero jobs. This supports an Actions startup problem, but does not establish its cause or waive any product gate. Billing information was unavailable through the current CLI permissions.

Evidence under C:/dev/cap-meri-foundation-evidence: ci-b40-109237090122.log, ci-b40-109237089576.log, ci-b40-109237089502.log, api-full-typecheck-6gb-exit.json, ci-api-web-serial-typecheck.log and its exit receipt, ci-phase2-api-build-6gb.log and its exit receipt, review-ci-serial-capacity.jsonl and actions-identical-sha-control.json. No GitHub-main merge, AWS deployment, shared database mutation, routing or model-policy change is claimed.
