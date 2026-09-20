-- S-3: shared writable-profile state for an execution scope, in its OWN column.
--
-- Why not reuse `worker_state_jsonb`: that column already has an owner. The
-- worker lifecycle service read-modify-writes it while holding its own
-- per-scope advisory lock (`workerProvisioningLockKey`), and it parses the blob
-- into a closed `MeriHermesWorkerState` shape. Putting profile content in the
-- same blob would give one column two independent writers holding two
-- different locks — precisely the lost-update hazard S-3 exists to close — and
-- would feed unexpected keys to that parser.
--
-- `profile_state_jsonb` therefore has exactly one writer path:
-- `MeriHermesProfileLeaseService.writeSharedProfileState()`, which requires the
-- fenced profile lease and performs its read-modify-write with the scope row
-- locked FOR UPDATE inside one transaction.
ALTER TABLE "meri_execution_scopes"
  ADD COLUMN "profile_state_jsonb" JSONB NOT NULL DEFAULT '{}';

COMMENT ON COLUMN "meri_execution_scopes"."profile_state_jsonb" IS
  'Shared writable-profile state for this execution scope (S-3). Single-writer: written only through MeriHermesProfileLeaseService.writeSharedProfileState(), which requires the fenced lease in meri_agent_profile_leases and locks this row FOR UPDATE. Distinct from worker_state_jsonb, which belongs to the worker lifecycle claim and has its own lock.';
