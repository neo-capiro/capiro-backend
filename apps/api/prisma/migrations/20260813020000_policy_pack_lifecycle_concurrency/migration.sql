-- Phase 10: make policy-pack lifecycle transitions concurrency-safe at the
-- authoritative database boundary.
--
-- The application performs role, review, and product-policy checks before a
-- transition. This trigger is defense in depth for stale writers and concurrent
-- reviewers: immutable identities cannot be replaced after another transaction
-- commits, reviewed decision material cannot be edited in place, illegal state
-- jumps fail closed, and no-op stale transitions cannot append misleading audit
-- events. Additive only; no seed or shared-environment execution.

CREATE OR REPLACE FUNCTION enforce_policy_pack_lifecycle_concurrency()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.pack_key IS DISTINCT FROM OLD.pack_key
     OR NEW.version IS DISTINCT FROM OLD.version
     OR NEW.owner_user_id IS DISTINCT FROM OLD.owner_user_id THEN
    RAISE EXCEPTION 'policy_pack_identity_immutable'
      USING ERRCODE = 'P0001';
  END IF;

  -- A concurrent second first-review must not replace the reviewer that won the
  -- row lock. PostgreSQL rechecks OLD after waiting on the committed row, so this
  -- is effective under READ COMMITTED as well as stricter isolation levels.
  IF OLD.reviewed_by_user_id IS NOT NULL
     AND (
       NEW.reviewed_by_user_id IS DISTINCT FROM OLD.reviewed_by_user_id
       OR NEW.reviewed_at IS DISTINCT FROM OLD.reviewed_at
     ) THEN
    RAISE EXCEPTION 'policy_pack_first_reviewer_immutable'
      USING ERRCODE = 'P0001';
  END IF;

  IF OLD.second_approved_by_user_id IS NOT NULL
     AND (
       NEW.second_approved_by_user_id IS DISTINCT FROM OLD.second_approved_by_user_id
       OR NEW.second_approved_at IS DISTINCT FROM OLD.second_approved_at
     ) THEN
    RAISE EXCEPTION 'policy_pack_second_reviewer_immutable'
      USING ERRCODE = 'P0001';
  END IF;

  IF NEW.reviewed_by_user_id IS NOT NULL
     AND NEW.reviewed_by_user_id = NEW.owner_user_id THEN
    RAISE EXCEPTION 'policy_pack_owner_cannot_review'
      USING ERRCODE = 'P0001';
  END IF;

  IF NEW.second_approved_by_user_id IS NOT NULL
     AND (
       NEW.second_approved_by_user_id = NEW.owner_user_id
       OR NEW.second_approved_by_user_id = NEW.reviewed_by_user_id
     ) THEN
    RAISE EXCEPTION 'policy_pack_second_reviewer_not_independent'
      USING ERRCODE = 'P0001';
  END IF;

  IF OLD.status IS DISTINCT FROM NEW.status
     AND NOT (
       (OLD.status = 'draft' AND NEW.status = 'pending_review')
       OR (OLD.status = 'pending_review' AND NEW.status = 'reviewed')
       OR (OLD.status = 'reviewed' AND NEW.status = 'published')
       OR (OLD.status = 'published' AND NEW.status = 'retired')
       OR (OLD.status = 'retired' AND NEW.status = 'published')
     ) THEN
    RAISE EXCEPTION 'policy_pack_illegal_lifecycle_transition:%->%', OLD.status, NEW.status
      USING ERRCODE = 'P0001';
  END IF;

  -- Once review starts, the decision-bearing material is immutable. A new
  -- version must be drafted instead of silently changing the reviewed rules.
  IF OLD.status <> 'draft'
     AND (
       NEW.jurisdiction IS DISTINCT FROM OLD.jurisdiction
       OR NEW.authority_jsonb IS DISTINCT FROM OLD.authority_jsonb
       OR NEW.effective_from IS DISTINCT FROM OLD.effective_from
       OR NEW.effective_until IS DISTINCT FROM OLD.effective_until
       OR NEW.four_eyes_required IS DISTINCT FROM OLD.four_eyes_required
       OR NEW.rules_jsonb IS DISTINCT FROM OLD.rules_jsonb
       OR NEW.fallback_outcome IS DISTINCT FROM OLD.fallback_outcome
       OR NEW.non_production IS DISTINCT FROM OLD.non_production
       OR NEW.rules_hash IS DISTINCT FROM OLD.rules_hash
     ) THEN
    RAISE EXCEPTION 'policy_pack_reviewed_material_immutable'
      USING ERRCODE = 'P0001';
  END IF;

  IF OLD.status IN ('reviewed', 'published', 'retired')
     AND NEW.legal_review_status IS DISTINCT FROM OLD.legal_review_status THEN
    RAISE EXCEPTION 'policy_pack_legal_review_immutable'
      USING ERRCODE = 'P0001';
  END IF;

  IF OLD.status = 'pending_review'
     AND OLD.reviewed_by_user_id IS NOT NULL
     AND NEW.legal_review_status IS DISTINCT FROM OLD.legal_review_status THEN
    RAISE EXCEPTION 'policy_pack_legal_review_immutable'
      USING ERRCODE = 'P0001';
  END IF;

  -- A stale transition that writes no lifecycle or decision change is rejected
  -- instead of producing a duplicate append-only event that suggests a second
  -- decision occurred.
  IF NEW.status IS NOT DISTINCT FROM OLD.status
     AND NEW.legal_review_status IS NOT DISTINCT FROM OLD.legal_review_status
     AND NEW.reviewed_by_user_id IS NOT DISTINCT FROM OLD.reviewed_by_user_id
     AND NEW.reviewed_at IS NOT DISTINCT FROM OLD.reviewed_at
     AND NEW.second_approved_by_user_id IS NOT DISTINCT FROM OLD.second_approved_by_user_id
     AND NEW.second_approved_at IS NOT DISTINCT FROM OLD.second_approved_at
     AND NEW.published_by_user_id IS NOT DISTINCT FROM OLD.published_by_user_id
     AND NEW.published_at IS NOT DISTINCT FROM OLD.published_at
     AND NEW.jurisdiction IS NOT DISTINCT FROM OLD.jurisdiction
     AND NEW.authority_jsonb IS NOT DISTINCT FROM OLD.authority_jsonb
     AND NEW.effective_from IS NOT DISTINCT FROM OLD.effective_from
     AND NEW.effective_until IS NOT DISTINCT FROM OLD.effective_until
     AND NEW.four_eyes_required IS NOT DISTINCT FROM OLD.four_eyes_required
     AND NEW.rules_jsonb IS NOT DISTINCT FROM OLD.rules_jsonb
     AND NEW.fallback_outcome IS NOT DISTINCT FROM OLD.fallback_outcome
     AND NEW.non_production IS NOT DISTINCT FROM OLD.non_production
     AND NEW.rules_hash IS NOT DISTINCT FROM OLD.rules_hash THEN
    RAISE EXCEPTION 'policy_pack_stale_or_noop_transition'
      USING ERRCODE = 'P0001';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS compliance_policy_pack_lifecycle_concurrency
  ON compliance_policy_pack;
CREATE TRIGGER compliance_policy_pack_lifecycle_concurrency
BEFORE UPDATE ON compliance_policy_pack
FOR EACH ROW
EXECUTE FUNCTION enforce_policy_pack_lifecycle_concurrency();
