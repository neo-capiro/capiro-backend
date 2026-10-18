# Core integrated source candidate — 2026-10-18

This branch is a source receiving candidate for the next Core ship owner. It does not
qualify an image, run a migration, enable a route, or establish live runtime access.
The merge commits preserve the published source commits and their ancestry.

| Received source | Exact input |
| --- | --- |
| Core successor, including Option B, approval/consent work, and approved 1 vCPU / 2 GiB task template | `b40971b1f8de888687a8fb92fbdf4ff653fe10d3` (PR86) |
| Ten retained reads, then documents schema/source and the gated eleventh receiver | `8130f4404d770db396b6732aac436d6e9ac93b82` (PR87), `7f72239d4f7746ea99fe10df701190132af84e87` (PR92), `01b5d90c8a50fee6076768dd4f226abb3e258581` |
| Deployment source packet | `986ca0ed6320c46b0b98685708c40fb2090cc362` (PR90) |
| Canonical Quick Log detail fields | `31313d4366bc5f7b1e65eac9b62ced352909a089` (PR94) |
| Client-wide registered attachment usage report | `948d4a7c8d500864c27f1aeb233a80903637591c` (PR95) |
| Unmounted Objective admission-read adapter | `7a4ca55ff3bff229a0d8fff045b32dbddf66e29e` |
| Modules receiving map | `76c193e8c86eb6132aba765b5d03c58db8848b87` (PR89) |
| Core prepared-approval verifier through bounded run facts | `3d30faca6cdaaf906705ddfbcee2da8ac68050a0` |
| Memory receiving, preserving published and local histories | `20fc9f5473e0b5f3a7d9057c4e0417b9701855d3` (PR88) |
| Unmounted task-bound memory page and proposal source | `ab1675ade0da4da2820e667a06497109b53d9f27` |
| Fail-closed document runtime identity adapter | `93ac25e0ef3a59ec10adf269bc8455bdd856b308` |
| Default-off reservation-bound A8 action query receiver | `868aafea8a6d731a0cab4210c169a955359daecc` |
| Exact PR171 wrapped-body and signed-correlation A8 receiver | `3f726d585860ac9e43097c293d6824f96682381f` |
| Retained-source TypeScript control-flow repair | `1955e5d3c202ddd68030d2d8719153b3b31320f7` |

Retained reads are **source-wired, not available in preview**. The document receiver
now has an ECS metadata selector and fail-closed adapter for independent Core
image/config identity readback. Its trusted control-plane readback port and Nest
provider remain unimplemented and unregistered, so the default 503 remains in force.
The remaining Meri relay/runtime integration and live readback are still outstanding.
The exact source_text_only tariff is tied to the original ADMITTED
allocation under the existing transaction lock; do not substitute a later allocation
or claim a source pin as proof of deployment. The current admission snapshot and its
original ADMITTED grant set remain unchanged.

Quick Log writes its Core activity and local durable follow-up intent atomically;
downstream Planner command creation is a resumable idempotent saga. The Planner
command route, migration, configuration, and live readback still need qualification.
The storage endpoint reports usage and a per-client allowance; it does not enforce a
limit. The Objective adapter is unmounted, and `/decisions` and issuance remain
disabled. PR88 memory source and unmounted task-bound page/proposal guards are
included. The signed one-use eligibility helper, reservation-bound proposal
alias, and final receipt-expiry release still need an allocated shared contract.
The `20281018090000` memory content-free migration intentionally raises before
dropping its payload column, so plain Prisma migration deploy across this source
will stop until the release owner verifies each target's applied checksum,
retention/hold disposition, and separately authorizes the forward path.

The A8 `actions.query@0.2.0` receiver retains the original UNKNOWN
reservation, call key, arguments hash and exact emitted-body hash. Its
`/api/clio/tools/actions.query` branch is default-off and requires a one-use
`CapiroMeriRead` token plus selected-client authority before dispatching to
the existing `query_action_items` owner. The current Meri receiving counterpart
is draft PR171 `eeeda2d415a976ea240de482e62f71a32020c9b7`, including
PR169/170 action source. It emits exact `JSON.stringify({input,metadata:null})`
bytes with a signed four-field correlation after UNKNOWN reservation;
the Core successor `3f726d58` validates that wrapper and correlation before
projecting a bounded flat body to the canonical owner. Original
`query_action_items@0.2.0` remains a separate uncorrelated flat-body path.
PR171 preserves the full 76-operation desired catalog; its measured desired
source is `8850af4b50666deef9e4c7edc23d32f25d663840748380c7baaa066585602f6a`.
Keep the alias disabled until the Meri relay and Core source/image/config pins,
provider and preview readbacks are qualified through reviewed shipping configuration.
Legal citation observations, nested Outreach detail authority, unscoped
Outreach, and four separate news facts remain held.

Core's approval verifier now reads a bounded prepared-approval aggregate from the
existing `run_facts_v1` interface and fails closed on missing, overflow, or mismatched
facts. The corresponding Meri projection is draft PR165 at
`e2d62589742fd349907274e5ee325e39059f14f4`, stacked on PR157. Meri centrally
allocated `apps/runtime/native-authority/read-delegation/migrations/0002_prepared_approval_facts.sql`
(SHA-256 `b203cf0faef94523270eb9c43f7508d0b805e658652214e71ca92e10a050fc1a`)
and pinned it in `first-chat-migrate.mjs`'s integration stage after read-delegation
`0001` and approval-metadata `0001`, before `integration_grants`. It adds a bounded
64-item prepared-approval projection and overflow refusal to the existing
security-barrier `run_facts_v1` view. The source migration is registered but has
**not been applied or qualified in the shared runtime**. Restricted-role runtime
readback and allocation-before-prepare proof remain gates. No raw-table grant is
added; the existing admission predicate, transaction lock, and original ADMITTED
grant set remain unchanged.
Confirm the exact source/image/config pins, migrations and restricted-role
behavior, signed relay, listener and output validation, and runtime readback before
changing availability.

Merge preparation verified every input SHA is an ancestor of this branch and
`git diff --check` against PR86 is clean. In this combined worktree, focused
serial Jest runs passed 41/41 approval/issuance/PGlite view tests, 16/16
memory-receiving and document-receiver tests, and 9/9 legacy memory recall
eligibility tests. The Objective adapter, Quick Log, and storage slices had
separate focused tests on their published source branches; this integration
pass did not rerun broad API, infrastructure, or live tests.
