# B1 tenant-wide directory-note policy — local acceptance

The user chose tenant-wide client-directory notes on 2026-09-25. `search_research_sources` therefore includes directory-contact notes even with an explicit selected client, but they remain filtered by the authenticated tenant and are returned with `clientId: null` and `scope: tenant_wide_directory`. The result and both model-facing tool descriptions state that the selected client does not own or scope those notes. Client-owned sources retain the existing visible-client/ownership predicates. A selected client denied by the ethical wall still fails before any directory query.

Local checks on this policy delta:

- `meri-tools.firmdata.spec.ts`: 68/68 passed, including tenant-bound directory lookup, explicit-client scope label, and denied-client pre-query behavior.
- Shared package build, full API typecheck with `PE_PHASE_A_B_SAFETY_OK`, and API Nest build: passed.
- No production write, deployment, or browser prompt replay was performed.

This is a policy-specific local acceptance, not a requalification of the full B1–B6 release candidate. Its source HEAD changed after the earlier 1,564-test exact-HEAD report, so broad exact-HEAD tests, immutable image/digest review, user deployment GO, and final live QA are still required. The user declined creation of non-admin test identities/grants; ordinary-user live ethical-wall acceptance remains unverified and must not be represented by an admin test.

The migrated-Postgres B1 fixture now also asserts that an unattributed directory note remains labeled `clientId: null` and `scope: tenant_wide_directory` with a selected, granted client and after that user's wall grant is revoked, while a matching foreign-tenant directory note never appears. This added assertion has not been run on the integrated source.

Remaining live oracle: use an existing active ordinary user with an authorized walled client, a uniquely searchable unattributed directory note, client-linked sentinel records, and a matching note in another tenant. Through the deployed Meri tool path, confirm that a selected-client search returns the local directory note with the tenant-wide label, client-linked results obey ownership and the wall, and the foreign note is absent. After the ordinary user's grant is revoked, the same user's explicit selected-client search must be denied; an unscoped search may still return the labeled tenant-wide note but must omit all records linked to the revoked client, including with a small result limit. An administrator account cannot establish the ordinary-user authentication, ownership, or revocation behavior. If no existing ordinary-user identity and grant are available, this live oracle remains open until the user authorizes them.
