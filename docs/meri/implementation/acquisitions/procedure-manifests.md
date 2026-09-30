# H5 procedure-manifest acquisition

## Source pin

The Commitments & Deliverables canonical procedure adapts two playbooks from:

- Repository: `NousResearch/hermes-agent`
- Commit: `516535b54275e963a82b4c28f866338fb768e7bc`
- `skills/productivity/meeting-action-items/SKILL.md`
- `skills/productivity/document-to-action-items/SKILL.md`

The pin is intentionally immutable. A future upstream review must record a new
pin rather than silently following a branch or tag.

## Adaptation mapping

The local server-owned recipe is implemented in
`apps/api/src/meri/skills/commitments-audit.procedure.ts`. It adapts these H5
playbook concepts into declarative procedure data:

- separate evidenced commitments from decisions, proposals, questions,
  blockers, and suggestions;
- retain source locators and citations;
- represent unsupported owner and due-date values as `unknown`;
- preserve obligation modality such as may, should, and must;
- deduplicate repeated promises while retaining evidence;
- distinguish tracked work from delivery or acceptance evidence; and
- keep read-only audit guidance separate from any approved write action.

No upstream scripts or execution engine are imported by this slice. The
canonical guidance and procedure clauses are immutable; tenant configuration
remains available through the presentation template and supported extra
read-only tools. Validation and resolution require the protected clauses from
the server-owned recipe.

## License and distribution

The pinned upstream repository is MIT licensed, Copyright (c) 2025 Nous
Research. `THIRD_PARTY_NOTICES` identifies both this H5 adaptation and the
existing H1 runtime-guardrails adaptation, and retains the complete MIT
permission, condition, and warranty text for distribution.

This acquisition record documents provenance and adaptation boundaries; it is
not evidence that served procedure binding or CD-01 through CD-07 have run.

## Concrete integrated disposition

At Capiro source `71efe006a7c120f157a90a6dac6adaf743353937`, the manifest/service slice is `ADAPTED_INTEGRATED_BOUNDED`. Original commits `aa6c161f73786eb3fdbdca5709cef4b0df63a8c5` and `7acbf3607247ee5d7e9968b8ca5083331809785c` are integrated as `92cecbef3ea16370460901ee77589079352db7cb` and `e4680ada973f4b8ceb2a2a65cadb7f7ab0b09c49`. Served binding candidate `5a1985ce9ccf2f6e33a91b95fc0b36a85adfc645`, present on candidate line `9a651d5fae1f240a36fc9b04c7007d76d8cba172`, is absent from current integration and remains held.

Exact donor SHA-256 values:

- `meeting-action-items/SKILL.md`: `1902f782551da96ee1f9b34d6f13af627f06150a498d874b0cc2a75d06d35aa8`
- `document-to-action-items/SKILL.md`: `8a7556754aca2a7d04d38847131fb4db8d6705fa2106fcb154279e26117b41ee`
- `LICENSE`: `821556e6336796450ab852d375117b48a4887e71d255794fd6318d99982a5ab6`

Current Capiro target SHA-256 values:

- `skills/commitments-audit.procedure.ts`: `0634e22cb494ea69fd3d857e9375ce63f2543d5af8d9292a7a58a95d455dca28`
- `skills/commitments-audit.procedure.spec.ts`: `4057cfd0b16e064c880441f5e39303a9295179f4854886f147a93a09e8fff2e8`
- `meri-firm-skills.helpers.ts`: `65dc0285b46d90116c7ccc81dcc7b0f33c6f94b16271f558f545a70f0ab5f6cf`
- `meri-firm-skills.service.ts`: `2f769139ea8ddbb31a55cf34b87e02ba08f9772c7c451554ff4d9ebf35e76e29`

Donor checklist mapping is concrete: evidence-type separation maps to `fixes all CD output fields, statuses, coverage, and requested-window policy`; unresolved owner/date and may/should/must map to `preserves modality and leaves unsupported owner and due date unknown`; deduplication/readback/approval separation maps to `is a zero-write contract across capabilities, policy, guidance, and completion`; the case register maps to `retains all seven CD benchmark IDs without claiming execution`. Service tests separately cover stale version, tenant, disable/delete and concurrent version conflicts.

Observed saved receipt: four manifest/service suites passed 51 tests; independent PostgreSQL 16/Prisma barriers exercised update/update and update/restore conflict winners and stale/current binding behavior. This is metadata/service proof only. CD-01 through CD-07 are still `NOT_RUN`, and the older "46 focused tests" status is superseded by the saved 51-test receipt. See external `procedure-version-repair-report.md` and `review-procedure-version-repair-report.md`.

License/distribution: root `THIRD_PARTY_NOTICES` retains the full pinned MIT text and names the two adapted playbooks. No donor script, connector, package, execution engine or whole skill file is shipped.

Rollback owner: File-01 lead / P1B firm-skill owner. Revert the manifest/version application changes and stop publishing the canonical procedure; no H5 migration/dependency was added. Review any persisted procedure JSON before rollback so it is not silently treated as an ordinary unprotected skill. A donor update requires a new pin and mapping.

Remaining mandatory gaps: selected starter identity, served current-authority binding, all source-family coverage including meetings, invocation freshness, authenticated client enforcement, zero-effect proof, actual result fields/statuses, and CD-01..CD-07. The held served candidate and manifest tests do not establish acceptance.
