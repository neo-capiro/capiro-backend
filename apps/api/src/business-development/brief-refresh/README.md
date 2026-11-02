# Retained brief refresh

Core prepares a private immutable proposal using the current dossier and a selected saved brief version. POST `brief/refresh-proposals` takes a caller-generated proposal UUID, expected version number and explicit preserve-edits choice. It does not change the current brief. GET `brief/refresh-proposals/:proposalId` reads that exact actor-owned proposal and its original accepted version, if any.

POST `brief/refresh-accept` requires the retained proposal UUID and hash. It rechecks current membership, feature entitlement, prospect/client access and write eligibility, then compares the current brief pointer and a fresh authorized dossier fingerprint. The fingerprint excludes retrieval observation timestamps; source dates, identities, facts, coverage and order remain bound. The proposal retains the exact original timestamps. External sources are observed before the short database transaction, not locked across the network.

Acceptance appends the exact retained sections, citations and snapshot through the existing immutable brief-version owner. The prospect row lock and existing unique idempotency key serialize concurrent acceptance. Replays return the original version even after newer versions or source changes. Legacy acceptance without a retained identity is rejected. The old GET comparison remains read-only.

Edited sections retain their original citation metadata and evidence. Citation indexes are remapped without replacing historical provenance with revised source facts. Exceeding the existing citation/snapshot limits refuses preparation.

The frontend retains only request identity and acceptance intent in the existing encrypted recovery journal. It checks the original server result before retrying; an unresolved acceptance cannot be discarded as if nothing happened. Text and citations are read from the authorized Core proposal.

Validation: focused service/role tests, citation composition tests, and opt-in PostgreSQL tests for ordinary-role immutability, tenant isolation, revoked membership, concurrent acceptance and transaction rollback. The PostgreSQL harness accepts only the explicitly named local disposable test database. No application/image build or deployed acceptance is claimed.
