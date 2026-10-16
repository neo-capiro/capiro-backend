# Objective Planner continuation source increment

This increment is based on Objective PR #42 at `6d24414da975b52ab9802a883b22c868ad14fc92`. Its current head was verified before implementation. The original reconciliation at `da1fd7b173410c7c37d6c520a807240eb2511ab3` was read through GitHub, including `GOVERNMENT-COVERAGE.md`, `INCREMENTAL-PLAN.md`, and `README.md`. The separate `integration/core-objective-first-chat-20261016` branch diverges from PR #42 and contains first-chat and authority changes; this increment does not compose that release branch.

## Scope

The new private Planner continuation source reconstructs its application identity from the existing saved-generation owner evidence. Its immutable Objective receipt carries the accepted source revision, compiled government and relationship context digests, exact saved Strategy/version and saved snapshot digest. An independently resolved Planner consent stays separate from the original Strategy-generation consent.

The bounded continuation coordinator reconciles the original Planner operation before preparing a plan. Missing receipts and transport failures cannot establish that an operation never started. A lost prepare reply is reconciled using the original application identity; the coordinator does not create a replacement job, run, request ID or token. Existing Planner owners retain all current authority, source, dependency, human-edit, receipt and transaction fences.

This is unmounted source. It does not install a scheduler, bind a transport or configure workload authority. Durable generation and application evidence provide reconstruction inputs, but they do not themselves grant permission to execute. A connected, leased worker and genuine original-operation reconciliation remain required before automatic continuation after browser closure is available.

## Government context policy

The reconciliation's `GOVERNMENT-COVERAGE.md` explicitly requires omitting EIN from general generation unless a necessary purpose and approved policy allow it. Both Objective source-reader copies now exclude that field. The prompt compiler also filters it at the model boundary for mixed-version source inputs, without reading its value. Coverage records `policy_omitted` independently of whether an EIN exists; it does not report absence or disclose a value. This closes the dedicated government-profile field exposure; it is not a classifier or redactor for arbitrary free text or historical artifacts.

Other government profile fields, targets, facilities, current Directory details, notes, history and retained Fill evidence keep their existing owners and inventory. Existing required-context and packet-budget failures remain. This increment does not claim a new complete relationship-evidence contract: the documented rich-record budgets, mail/outreach body and recipient-role coverage, external as-of observations and enrichment review limitations remain.

## Integration boundaries

There is no new public Objective, Strategy or Planner API and no frontend change. Current ordinary-chat behavior, first-chat bootstrap, authority files, migration IDs, central allocations and shipping recipes are outside this diff. No dependency installation, database operation, provider/model call, AWS change, deployment or merge is part of this increment.

## Verification

On Node `22.23.3`, the new continuation source suite passed **21/21**. Combined with the existing producer, saved-plan and application suites, the focused run passed **111/111**. The suites load actual source helpers and codecs; SQL, custody, framework and original-operation owner ports are explicitly synthetic. Cases include separate consents, pinned asynchronous inputs, changed source/binding refusal, original-operation uncertainty, committed lost-reply recovery, truncated/malformed prepare and lookup replies, current read revocation, historical expiry and no second prepare.

The existing Objective context Jest suite passed **11/11**, including the EIN throwing-getter and policy-omission checks, preserved government/relationship fields, reader parity, missing source and packet-budget refusals. It reused the installed dependency tree without installing packages.

Scoped strict Node16 TypeScript checks passed for the new continuation module and the changed Core context service/both source readers, using the existing dependency and generated-client declarations. No full application build or complete typecheck was run. `git diff --check` passed.

Independent source review is recorded in the draft PR. Source fixtures do not establish native PostgreSQL locking/RLS, mounted HTTP authentication, live Meri custody, installed worker execution or browser acceptance.
