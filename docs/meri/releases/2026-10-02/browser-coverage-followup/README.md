# Direct browser coverage follow-up

The deployed task read completed, but Meri appended a contradictory warning that
its source had never been called. A failed mailbox search received the same
incorrect warning. The repair resolves the generic negative-claim requirement
against its requested task/mail tool families and uses the observed outcome.
Explicit complete empty results can support scoped absence. Failed, partial,
unavailable, unrelated, and unknown coverage retain an accurate limitation.

Recovery requires an unambiguous source/result pair and matching explicit scope
and page coordinates. A successful final page cannot erase a failed or skipped
earlier page. Earlier complete evidence is preserved. This change does not add
tool calls or alter official/private evidence requirements, routing, permissions,
provider settings, or database schema.

Root verification on the final patch: 113 assertions across four coverage and
formatting Jest suites passed, exit 0; orchestrator TypeScript passed, exit 0.
The worker's narrower run passed 79 assertions across two suites, exit 0.
Those counts overlap and must not be added together. Independent source review
passed, including a separately reproduced final-page false-completeness case.
Final release evidence is recorded separately. Live repair verification is NOT RUN
until the new immutable image is deployed and checked through the browser.

The mailbox timeout remains a separate observed defect. A bounded read-only
analysis of the deployed SELECT took 25,594 ms, including 24,369 ms of I/O wait,
and returned no customer rows to the operator. The existing thread covering
index is valid and used. Owned-loopback tests under FORCE RLS showed only modest
improvement from a materialized query or ownership B-tree. Six-field and
concatenated trigram indexes were not selected under the ordinary application's
RLS policy; no such indexes or security changes were applied live. Increasing
the query deadline is not treated as a repair.

The original File01 acceptance remains incomplete. This regression work is not
the original 75-case suite or its additional variants, failure injections,
semantic-clock controls, and human review. Defense Chat remains excluded.

Evidence retained locally in the approved evidence workspace:

- `oct02-browser-footer-repair/`: actual focused and integration test output.
- `oct02-browser-mail-503/`: current catalog/plan, wait sampling, local A/B and
  trigram comparisons; no shared database mutation.
- `oct02-browser-mail-analyze/`: one source-pinned, read-only EXPLAIN ANALYZE,
  with SQL conditions and customer content excluded from its stored receipt.

Shared policy: `b32b4803933760dc0a93fffdcd8fba30a89c3aac` (contains published
`b2b0ce8c2bf03817b81e671d968b7892985b8d06`); machine map dated 2026-09-30.
