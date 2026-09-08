#!/usr/bin/env bash
set -uo pipefail
fail=0
check() {
  local label="$1" sql="$2" expected="$3" got
  got=$(psql "$PSQL_DATABASE_URL" -tAc "$sql" | tr -d '[:space:]')
  if [ "$got" != "$expected" ]; then
    echo "::error::$label — expected '$expected', got '$got'"
    fail=1
  else
    echo "ok: $label ($got)"
  fi
}

# The two lifecycle snapshot columns, and BOTH must be nullable. NULL means
# "no baseline yet", which the lifecycle pass treats as a silent first
# observation; a NOT NULL default would make every legacy row look
# already-observed and the first run would alert on the whole corpus.
check "source_fingerprint is nullable" \
  "SELECT is_nullable FROM information_schema.columns WHERE table_name='client_funding_opportunity' AND column_name='source_fingerprint'" \
  "YES"
check "source_active_snapshot is nullable" \
  "SELECT is_nullable FROM information_schema.columns WHERE table_name='client_funding_opportunity' AND column_name='source_active_snapshot'" \
  "YES"

# P07 decision columns. ALL nullable, and none may carry a DEFAULT: a
# default would fabricate a decision for the entire existing corpus, and
# NOT NULL would need a backfill that invents one.
for col in human_decision decision_reason decision_at decision_by_user_id next_action next_action_due_at; do
  check "$col is nullable"               "SELECT is_nullable FROM information_schema.columns WHERE table_name='client_funding_opportunity' AND column_name='$col'"               "YES"
done
check "no decision column has a DEFAULT"             "SELECT count(*) FROM information_schema.columns WHERE table_name='client_funding_opportunity' AND column_name IN ('human_decision','decision_reason','decision_at','decision_by_user_id','next_action','next_action_due_at') AND column_default IS NOT NULL"             "0"

# The three P07 CHECKs. The actor one is a three-way all-or-nothing, so a
# decision can never exist without the person and the moment it was made.
check "human_decision vocabulary CHECK"             "SELECT count(*) FROM pg_constraint WHERE conname='client_funding_opportunity_human_decision_chk'" "1"
check "decision actor+timestamp CHECK"             "SELECT count(*) FROM pg_constraint WHERE conname='client_funding_opportunity_decision_actor_chk'" "1"
check "next-action due-date CHECK"             "SELECT count(*) FROM pg_constraint WHERE conname='client_funding_opportunity_next_action_chk'" "1"
check "decision index exists"             "SELECT count(*) FROM pg_indexes WHERE indexname='client_funding_opportunity_decision_idx'" "1"
check "decision index is PARTIAL"             "SELECT CASE WHEN indexdef LIKE '%WHERE%' THEN 'yes' ELSE 'no' END FROM pg_indexes WHERE indexname='client_funding_opportunity_decision_idx'"             "yes"

# The three indexes the lifecycle migration creates.
check "lifecycle keyset cursor index" \
  "SELECT count(*) FROM pg_indexes WHERE indexname='client_funding_opportunity_tenant_cursor_idx'" "1"
check "grant discovery/enrichment index" \
  "SELECT count(*) FROM pg_indexes WHERE indexname='federal_grant_lifecycle_enrichment_idx'" "1"
check "sam lifecycle index" \
  "SELECT count(*) FROM pg_indexes WHERE indexname='sam_opportunity_lifecycle_idx'" "1"

# RLS must be ENABLED AND FORCED. Enabled-but-not-forced leaves the table
# owner exempt, and migrations run as the owner — which is how a PE Phase-C
# backfill silently no-op'd earlier this month.
check "client_funding_opportunity RLS enabled" \
  "SELECT relrowsecurity FROM pg_class WHERE relname='client_funding_opportunity'" "t"
check "client_funding_opportunity RLS FORCED" \
  "SELECT relforcerowsecurity FROM pg_class WHERE relname='client_funding_opportunity'" "t"
check "four RLS policies" \
  "SELECT count(*) FROM pg_policies WHERE tablename='client_funding_opportunity'" "4"

# THREE partial unique indexes now: grant, sam, and P13's generic
# identity. Postgres treats NULLs as distinct, so one unique index across
# the nullable source pair would admit unlimited duplicates for the other
# source — and the same reasoning is why the generic one is partial too.
check "three partial unique indexes" \
  "SELECT count(*) FROM pg_indexes WHERE tablename='client_funding_opportunity' AND indexname LIKE '%\\_uniq'" "3"

# ── P13 generic source identity ──────────────────────────────────────
# Both columns nullable and DEFAULT-free. Nullable is load-bearing: code
# deployed before P13 writes neither, so a NOT NULL turns the older API
# into a hard failure the moment the migration lands.
for col in source_record_type source_record_key; do
  check "$col is nullable"               "SELECT is_nullable FROM information_schema.columns WHERE table_name='client_funding_opportunity' AND column_name='$col'"               "YES"
done
check "no generic identity column has a DEFAULT"             "SELECT count(*) FROM information_schema.columns WHERE table_name='client_funding_opportunity' AND column_name IN ('source_record_type','source_record_key') AND column_default IS NOT NULL"             "0"

# The legacy pointers must SURVIVE. Removing them is a separate contract
# phase that has not been approved, and old code reads them.
check "grant_opportunity_id still exists"             "SELECT count(*) FROM information_schema.columns WHERE table_name='client_funding_opportunity' AND column_name='grant_opportunity_id'"             "1"
check "sam_opportunity_id still exists"             "SELECT count(*) FROM information_schema.columns WHERE table_name='client_funding_opportunity' AND column_name='sam_opportunity_id'"             "1"

check "generic identity unique index exists"             "SELECT count(*) FROM pg_indexes WHERE indexname='client_funding_opportunity_generic_uniq'"             "1"
check "generic identity unique index is PARTIAL"             "SELECT CASE WHEN indexdef LIKE '%WHERE%' THEN 'yes' ELSE 'no' END FROM pg_indexes WHERE indexname='client_funding_opportunity_generic_uniq'"             "yes"
check "generic identity unique index includes source"             "SELECT CASE WHEN indexdef LIKE '%source,%' THEN 'yes' ELSE 'no' END FROM pg_indexes WHERE indexname='client_funding_opportunity_generic_uniq'"             "yes"
check "generic identity lookup index exists"             "SELECT count(*) FROM pg_indexes WHERE indexname='client_funding_opportunity_source_record_idx'"             "1"

# P08 action idempotency: the task identity is a PARTIAL unique index
# because generic engagement tasks legitimately leave source_type and
# source_id NULL.
check "engagement task action-source unique index exists" \
  "SELECT count(*) FROM pg_indexes WHERE indexname='engagement_tasks_tenant_source_uniq'" \
  "1"
check "engagement task action-source unique index is UNIQUE" \
  "SELECT CASE WHEN indexdef LIKE 'CREATE UNIQUE INDEX%' THEN 'yes' ELSE 'no' END FROM pg_indexes WHERE indexname='engagement_tasks_tenant_source_uniq'" \
  "yes"
check "engagement task action-source unique index is PARTIAL" \
  "SELECT CASE WHEN indexdef LIKE '%WHERE%' THEN 'yes' ELSE 'no' END FROM pg_indexes WHERE indexname='engagement_tasks_tenant_source_uniq'" \
  "yes"

# The vocabulary CHECK is WIDENED, never narrowed: the three planned
# sources must be admissible so the generic branch of the exclusivity
# CHECK is reachable, and therefore testable.
for src in grants_gov sam_gov agency_forecast dibbs sbir_sttr; do
  check "source vocabulary admits $src"               "SELECT CASE WHEN pg_get_constraintdef(oid) LIKE '%''$src''%' THEN 'yes' ELSE 'no' END FROM pg_constraint WHERE conname='client_funding_opportunity_source_chk'"               "yes"
done

# THE THREE-VALUED-LOGIC GUARD. A CHECK passes when it evaluates to TRUE
# *or to NULL*, and `NULL = 'x'` is NULL — so an unguarded
# `type = 'sam_notice'` admits a row with a key and a NULL type. The first
# version of this migration did exactly that and the row inserted
# successfully in rehearsal. Both equality tests must reject NULL first.
#
# THREE occurrences, measured against the real constraint: two guarding the
# legacy equality tests, plus the future-source branch's own requirement
# that the pair be present.
check "exclusivity CHECK guards both equalities against NULL"             "SELECT (length(pg_get_constraintdef(oid)) - length(replace(pg_get_constraintdef(oid), 'source_record_type IS NOT NULL', '')))/length('source_record_type IS NOT NULL') FROM pg_constraint WHERE conname='client_funding_opportunity_one_source_chk'"             "3"

# ── P15 Tango substrate: four GLOBAL tables, none with RLS ────────────
# Same category as federal_grant / sam_opportunity, which also carry no
# RLS — a Tango observation is a fact about the federal marketplace, not
# about any one tenant. Asserting the ABSENCE of RLS is as load-bearing
# here as asserting its presence is on client_funding_opportunity above:
# a false "no tenant RLS claimed" would mean these tables silently
# started acting tenant-scoped with no policy to actually scope them.
for t in tango_resource_snapshot tango_resource_link tango_sync_checkpoint tango_api_usage; do
  check "$t has NO tenant_id column"               "SELECT count(*) FROM information_schema.columns WHERE table_name='$t' AND column_name='tenant_id'"               "0"
  check "$t RLS is NOT enabled"               "SELECT relrowsecurity FROM pg_class WHERE relname='$t'"               "f"
  check "$t has NO policies"               "SELECT count(*) FROM pg_policies WHERE tablename='$t'"               "0"
done

# The versioned-head invariant: at most one ACTIVE row per resource,
# enforced as a partial unique index, not just application discipline.
check "snapshot one-active-per-resource index exists"             "SELECT count(*) FROM pg_indexes WHERE indexname='tango_resource_snapshot_one_active_uniq'"             "1"
check "snapshot one-active index is PARTIAL"             "SELECT CASE WHEN indexdef LIKE '%WHERE%' THEN 'yes' ELSE 'no' END FROM pg_indexes WHERE indexname='tango_resource_snapshot_one_active_uniq'"             "yes"
check "snapshot natural-key index exists"             "SELECT count(*) FROM pg_indexes WHERE indexname='tango_resource_snapshot_natural_key_uniq'"             "1"
check "snapshot content hash format CHECK exists"             "SELECT count(*) FROM pg_constraint WHERE conname='tango_resource_snapshot_hash_chk'"             "1"
check "snapshot active-consistency CHECK exists"             "SELECT count(*) FROM pg_constraint WHERE conname='tango_resource_snapshot_active_consistency_chk'"             "1"

# The link table may only point at EXISTING global reference tables — a
# tenant resource must never be a valid target for a table with no RLS.
for local_type in sam_opportunity federal_grant federal_contractor federal_award; do
  check "link local-type vocabulary admits $local_type"               "SELECT CASE WHEN pg_get_constraintdef(oid) LIKE '%''$local_type''%' THEN 'yes' ELSE 'no' END FROM pg_constraint WHERE conname='tango_resource_link_local_type_chk'"               "yes"
done
check "link local-type vocabulary does NOT admit a tenant table"             "SELECT CASE WHEN pg_get_constraintdef(oid) LIKE '%client%' THEN 'yes' ELSE 'no' END FROM pg_constraint WHERE conname='tango_resource_link_local_type_chk'"             "no"
# PRE-EXISTING DEFECT, fixed at P44. This assertion shipped at P15 with no
# FROM clause, so every run errored with `column "oid" does not exist`,
# `got` came back empty, and the whole step failed. It has therefore
# never verified the thing it names — and could not have been noticed,
# because Actions has been broken account-wide since 2026-07-31. Fixed
# here rather than left, since P44 adds its own assertions to this same
# step and they cannot go green inside a step that always fails.
check "link basis is exactly the two non-fuzzy values"             "SELECT pg_get_constraintdef(oid) LIKE '%exact_identifier%' AND pg_get_constraintdef(oid) LIKE '%reviewed_manual%' AND pg_get_constraintdef(oid) NOT LIKE '%fuzzy%' AND pg_get_constraintdef(oid) NOT LIKE '%name_fallback%' FROM pg_constraint WHERE conname='tango_resource_link_basis_chk'"             "t"
check "link rejection-actor CHECK exists"             "SELECT count(*) FROM pg_constraint WHERE conname='tango_resource_link_rejection_actor_chk'"             "1"
check "link pair uniqueness exists"             "SELECT count(*) FROM pg_indexes WHERE indexname='tango_resource_link_pair_uniq'"             "1"

check "checkpoint walk uniqueness exists"             "SELECT count(*) FROM pg_indexes WHERE indexname='tango_sync_checkpoint_walk_uniq'"             "1"
check "usage status vocabulary has no room for a header or key column"             "SELECT count(*) FROM information_schema.columns WHERE table_name='tango_api_usage' AND (column_name LIKE '%header%' OR column_name LIKE '%key%' OR column_name LIKE '%token%')"             "0"

# ── P27 Tango↔SAM parity ledger ───────────────────────────────────
# GLOBAL, like every other tango_* table: "SAM.gov and the provider
# disagree about this notice's deadline" is a fact about the federal
# marketplace, not about any one tenant. Asserting the ABSENCE of RLS
# is as load-bearing here as asserting its presence is on
# client_funding_opportunity — a false "no tenant RLS claimed" would
# mean the table silently started acting tenant-scoped with no policy
# to actually scope it.
check "tango_opportunity_parity has NO tenant_id column"             "SELECT count(*) FROM information_schema.columns WHERE table_name='tango_opportunity_parity' AND column_name='tenant_id'"             "0"
check "tango_opportunity_parity RLS is NOT enabled"             "SELECT relrowsecurity FROM pg_class WHERE relname='tango_opportunity_parity'"             "f"
check "tango_opportunity_parity has NO policies"             "SELECT count(*) FROM pg_policies WHERE tablename='tango_opportunity_parity'"             "0"

# NO foreign key, deliberately. The ledger is an observation about two
# INDEPENDENTLY-synced catalogs; a cascade from either side would
# delete the evidence that they ever disagreed, which is the one thing
# the table exists to keep.
check "tango_opportunity_parity has NO foreign keys"             "SELECT count(*) FROM pg_constraint WHERE conrelid='tango_opportunity_parity'::regclass AND contype='f'"             "0"

# The three bounded vocabularies. `field` admits only lifecycle facts
# BOTH catalogs carry — a provider-exclusive field would report as a
# conflict on every row and belongs in the snapshot instead.
for f in title solicitation_number response_deadline active set_aside naics_code psc_code agency; do
  check "parity field vocabulary admits $f"               "SELECT CASE WHEN pg_get_constraintdef(oid) LIKE '%''$f''%' THEN 'yes' ELSE 'no' END FROM pg_constraint WHERE conname='tango_opportunity_parity_field_chk'"               "yes"
done
check "parity field vocabulary does NOT admit a provider-exclusive field"             "SELECT CASE WHEN pg_get_constraintdef(oid) LIKE '%estimated_value%' THEN 'yes' ELSE 'no' END FROM pg_constraint WHERE conname='tango_opportunity_parity_field_chk'"             "no"

# FIVE agreement values, not two. "They disagree" and "only one of
# them said anything" are different findings and only the first is a
# conflict a human needs to look at.
for a in agree conflict local_only provider_only both_absent; do
  check "parity agreement vocabulary admits $a"               "SELECT CASE WHEN pg_get_constraintdef(oid) LIKE '%''$a''%' THEN 'yes' ELSE 'no' END FROM pg_constraint WHERE conname='tango_opportunity_parity_agreement_chk'"               "yes"
done

# A resolution that OVERWRITES the local value must not be expressible
# as a vocabulary entry — plan §4.2 forbids the merge, so the column
# can record "we accepted the provider's value as the better one" but
# there is no value meaning "we wrote it over ours".
for r in unreviewed local_canonical accepted_provider dismissed; do
  check "parity resolution vocabulary admits $r"               "SELECT CASE WHEN pg_get_constraintdef(oid) LIKE '%''$r''%' THEN 'yes' ELSE 'no' END FROM pg_constraint WHERE conname='tango_opportunity_parity_resolution_chk'"               "yes"
done

# The three-way all-or-nothing: a reviewed row carries its actor AND
# its moment, and an unreviewed row carries NEITHER. Same shape, and
# same reason, as client_funding_opportunity_decision_actor_chk (P07).
check "parity review-actor CHECK exists"             "SELECT count(*) FROM pg_constraint WHERE conname='tango_opportunity_parity_review_actor_chk'"             "1"
check "parity review-actor CHECK guards BOTH directions"             "SELECT CASE WHEN pg_get_constraintdef(oid) LIKE '%IS NULL%' AND pg_get_constraintdef(oid) LIKE '%IS NOT NULL%' THEN 'yes' ELSE 'no' END FROM pg_constraint WHERE conname='tango_opportunity_parity_review_actor_chk'"             "yes"

# One row per (provider record, local record, field) — what makes a
# re-run an UPDATE of the same comparison rather than a second opinion.
check "parity record/field uniqueness exists"             "SELECT count(*) FROM pg_indexes WHERE indexname='tango_opportunity_parity_record_field_uniq'"             "1"
check "parity conflict-scan index exists"             "SELECT count(*) FROM pg_indexes WHERE indexname='tango_opportunity_parity_conflict_idx'"             "1"
check "parity local-side lookup index exists"             "SELECT count(*) FROM pg_indexes WHERE indexname='tango_opportunity_parity_sam_idx'"             "1"

# ── P28 notice history ────────────────────────────────────────────
# Global, same category and same reasoning as every other tango_*
# table, and no FK for the same reason as P27's ledger: the record
# that an amendment happened must outlive either catalog's own row
# lifecycle.
check "tango_opportunity_notice has NO tenant_id column"             "SELECT count(*) FROM information_schema.columns WHERE table_name='tango_opportunity_notice' AND column_name='tenant_id'"             "0"
check "tango_opportunity_notice RLS is NOT enabled"             "SELECT relrowsecurity FROM pg_class WHERE relname='tango_opportunity_notice'"             "f"
check "tango_opportunity_notice has NO policies"             "SELECT count(*) FROM pg_policies WHERE tablename='tango_opportunity_notice'"             "0"
check "tango_opportunity_notice has NO foreign keys"             "SELECT count(*) FROM pg_constraint WHERE conrelid='tango_opportunity_notice'::regclass AND contype='f'"             "0"

# The content hash is what makes a re-sync free: identical content,
# same hash, no new observation, no phantom change on the derived
# timeline. A truncated or differently-cased hash silently defeats
# that, so the format is a CHECK rather than a convention.
check "notice content-hash format CHECK exists"             "SELECT count(*) FROM pg_constraint WHERE conname='tango_opportunity_notice_hash_chk'"             "1"
# A negative count is a mapping bug, not fewer attachments.
check "notice attachment-count CHECK exists"             "SELECT count(*) FROM pg_constraint WHERE conname='tango_opportunity_notice_attachment_count_chk'"             "1"
# `sam_opportunity_id` MUST stay nullable: a notice whose parent is
# ambiguous is stored unstamped and becomes reachable when the
# ambiguity resolves. NOT NULL would mean discarding it instead.
check "notice sam_opportunity_id is nullable"             "SELECT is_nullable FROM information_schema.columns WHERE table_name='tango_opportunity_notice' AND column_name='sam_opportunity_id'"             "YES"

check "notice id uniqueness exists"             "SELECT count(*) FROM pg_indexes WHERE indexname='tango_opportunity_notice_notice_id_uniq'"             "1"
check "notice parent-ordering index exists"             "SELECT count(*) FROM pg_indexes WHERE indexname='tango_opportunity_notice_parent_idx'"             "1"
check "notice local-side ordering index exists"             "SELECT count(*) FROM pg_indexes WHERE indexname='tango_opportunity_notice_sam_idx'"             "1"

# The timeline is DERIVED on read, never stored. A table holding one
# would be a second thing that can be wrong about its own inputs.
check "no stored timeline table exists"             "SELECT count(*) FROM information_schema.tables WHERE table_name LIKE '%opportunity_timeline%'"             "0"

# ── P29 attachment archive ────────────────────────────────────────
check "opportunity_attachment has NO tenant_id column"             "SELECT count(*) FROM information_schema.columns WHERE table_name='opportunity_attachment' AND column_name='tenant_id'"             "0"
check "opportunity_attachment RLS is NOT enabled"             "SELECT relrowsecurity FROM pg_class WHERE relname='opportunity_attachment'"             "f"
check "opportunity_attachment has NO foreign keys"             "SELECT count(*) FROM pg_constraint WHERE conrelid='opportunity_attachment'::regclass AND contype='f'"             "0"

# THE acceptance line, as a constraint: a failed fetch cannot mark
# metadata complete. `archived` requires every archive fact, and a
# NON-archived row may carry none of them — so a stale bucket/key
# from an earlier success cannot make a failed row look citable.
check "archived-completeness CHECK exists"             "SELECT count(*) FROM pg_constraint WHERE conname='opportunity_attachment_archived_chk'"             "1"
check "archived CHECK names every archive fact"             "SELECT CASE WHEN pg_get_constraintdef(oid) LIKE '%archive_bucket%' AND pg_get_constraintdef(oid) LIKE '%archive_key%' AND pg_get_constraintdef(oid) LIKE '%content_sha256%' AND pg_get_constraintdef(oid) LIKE '%observed_size_bytes%' THEN 'yes' ELSE 'no' END FROM pg_constraint WHERE conname='opportunity_attachment_archived_chk'"             "yes"
check "unarchived-cleanliness CHECK exists"             "SELECT count(*) FROM pg_constraint WHERE conname='opportunity_attachment_unarchived_chk'"             "1"
check "an unexplained refusal or failure is refused"             "SELECT count(*) FROM pg_constraint WHERE conname='opportunity_attachment_failure_chk'"             "1"
check "an attachment with no parent is refused"             "SELECT count(*) FROM pg_constraint WHERE conname='opportunity_attachment_parent_chk'"             "1"
check "attachment content-hash format CHECK exists"             "SELECT count(*) FROM pg_constraint WHERE conname='opportunity_attachment_hash_chk'"             "1"
for s in metadata_only archived refused failed; do
  check "attachment status vocabulary admits $s"               "SELECT CASE WHEN pg_get_constraintdef(oid) LIKE '%''$s''%' THEN 'yes' ELSE 'no' END FROM pg_constraint WHERE conname='opportunity_attachment_status_chk'"               "yes"
done

# The uniqueness COALESCEs both parent columns. Postgres treats NULLs
# as distinct, so a plain composite would admit unlimited duplicates
# for a notice-parented row (whose sam_opportunity_id is null).
check "attachment parent/url uniqueness exists"             "SELECT count(*) FROM pg_indexes WHERE indexname='opportunity_attachment_parent_url_uniq'"             "1"
check "attachment uniqueness COALESCEs both parents"             "SELECT CASE WHEN indexdef LIKE '%COALESCE%' THEN 'yes' ELSE 'no' END FROM pg_indexes WHERE indexname='opportunity_attachment_parent_url_uniq'"             "yes"
check "attachment content-hash dedup index exists"             "SELECT count(*) FROM pg_indexes WHERE indexname='opportunity_attachment_hash_idx'"             "1"

# ── P30 extracted text ────────────────────────────────────────────
# THE rule: blank is never "this document has no requirements". An
# `available` row REQUIRES text, a method and a count; every other
# status must hold NO text, so a not_entitled row cannot carry a
# leftover body from a period when the account was entitled.
check "text availability CHECK exists"             "SELECT count(*) FROM pg_constraint WHERE conname='opportunity_document_text_available_chk'"             "1"
check "a non-available text row may hold no text"             "SELECT CASE WHEN pg_get_constraintdef(oid) LIKE '%text IS NULL%' THEN 'yes' ELSE 'no' END FROM pg_constraint WHERE conname='opportunity_document_text_available_chk'"             "yes"
for s in available not_entitled not_provided pending failed; do
  check "text status vocabulary admits $s"               "SELECT CASE WHEN pg_get_constraintdef(oid) LIKE '%''$s''%' THEN 'yes' ELSE 'no' END FROM pg_constraint WHERE conname='opportunity_document_text_status_chk'"               "yes"
done
# The binding that makes a citation safe. NOT NULL: text with no
# binding is text nothing may cite.
check "text binding hash is NOT NULL"             "SELECT is_nullable FROM information_schema.columns WHERE table_name='opportunity_document_text' AND column_name='attachment_content_sha256'"             "NO"
check "text binding hash is format-checked"             "SELECT count(*) FROM pg_constraint WHERE conname='opportunity_document_text_hash_chk'"             "1"
# Provider and local text coexist as separate rows and never blend.
check "text attachment/method uniqueness exists"             "SELECT count(*) FROM pg_indexes WHERE indexname='opportunity_document_text_attachment_method_uniq'"             "1"
check "opportunity_document_text has NO tenant_id column"             "SELECT count(*) FROM information_schema.columns WHERE table_name='opportunity_document_text' AND column_name='tenant_id'"             "0"
check "opportunity_document_text RLS is NOT enabled"             "SELECT relrowsecurity FROM pg_class WHERE relname='opportunity_document_text'"             "f"

# -- P31 requirement artifacts --------------------------------------
# TWO tables, and the split is the design: the REQUIREMENT is a fact
# about a public document (global, no RLS), the REVIEW is one team's
# decision (tenant-scoped, RLS ENABLED + FORCED, four policies).
check "opportunity_requirement has NO tenant_id column"             "SELECT count(*) FROM information_schema.columns WHERE table_name='opportunity_requirement' AND column_name='tenant_id'"             "0"
check "opportunity_requirement RLS is NOT enabled"             "SELECT relrowsecurity FROM pg_class WHERE relname='opportunity_requirement'"             "f"
check "opportunity_requirement_review RLS enabled"             "SELECT relrowsecurity FROM pg_class WHERE relname='opportunity_requirement_review'"             "t"
check "opportunity_requirement_review RLS FORCED"             "SELECT relforcerowsecurity FROM pg_class WHERE relname='opportunity_requirement_review'"             "t"
check "opportunity_requirement_review has four RLS policies"             "SELECT count(*) FROM pg_policies WHERE tablename='opportunity_requirement_review'"             "4"

# NO ASSERTION WITHOUT EVIDENCE, as columns: every evidence field is
# NOT NULL, so an uncited requirement is unstorable rather than merely
# discouraged.
for col in attachment_id attachment_content_sha256 source_excerpt excerpt_start excerpt_end extraction_method extraction_model; do
  check "requirement $col is NOT NULL"               "SELECT is_nullable FROM information_schema.columns WHERE table_name='opportunity_requirement' AND column_name='$col'"               "NO"
done
# The span must be coherent AND the excerpt length must MATCH it. An
# excerpt longer than its claimed range is a paraphrase wearing a
# citation.
check "requirement span CHECK exists"             "SELECT count(*) FROM pg_constraint WHERE conname='opportunity_requirement_span_chk'"             "1"
check "requirement span CHECK ties excerpt length to the range"             "SELECT CASE WHEN pg_get_constraintdef(oid) LIKE '%length(source_excerpt)%' THEN 'yes' ELSE 'no' END FROM pg_constraint WHERE conname='opportunity_requirement_span_chk'"             "yes"
check "requirement excerpt is bounded and non-empty"             "SELECT count(*) FROM pg_constraint WHERE conname='opportunity_requirement_excerpt_chk'"             "1"
# Re-extracting the SAME bytes is idempotent by construction.
check "requirement evidence uniqueness exists"             "SELECT count(*) FROM pg_indexes WHERE indexname='opportunity_requirement_evidence_uniq'"             "1"
# A reviewed row carries its actor AND its moment; a pending one
# carries neither. Same shape as P07's decision-actor CHECK.
check "requirement review-actor CHECK exists"             "SELECT count(*) FROM pg_constraint WHERE conname='opportunity_requirement_review_actor_chk'"             "1"

# ── P35: the pursuit pipeline ──────────────────────────────────────
#
# ROLLING-DEPLOY SAFETY, asserted rather than assumed. `pipeline_stage`
# must be NULLABLE with NO default, so an older pod's INSERT that omits
# it still succeeds and the row honestly has no stage. The version token
# must be the opposite — NOT NULL with a default — so the same INSERT
# still produces a usable optimistic-concurrency value.
check "pipeline_stage is nullable"             "SELECT is_nullable FROM information_schema.columns WHERE table_name='client_funding_opportunity' AND column_name='pipeline_stage'"             "YES"
check "pipeline_stage has NO default"             "SELECT count(*) FROM information_schema.columns WHERE table_name='client_funding_opportunity' AND column_name='pipeline_stage' AND column_default IS NOT NULL"             "0"
check "pipeline_stage_version is NOT NULL"             "SELECT is_nullable FROM information_schema.columns WHERE table_name='client_funding_opportunity' AND column_name='pipeline_stage_version'"             "NO"
check "pipeline_stage_version defaults to 0"             "SELECT column_default FROM information_schema.columns WHERE table_name='client_funding_opportunity' AND column_name='pipeline_stage_version'"             "0"
for col in pipeline_stage_at pipeline_stage_by_user_id; do
  check "$col is nullable"               "SELECT is_nullable FROM information_schema.columns WHERE table_name='client_funding_opportunity' AND column_name='$col'"               "YES"
done

# The bounded vocabulary, and the two coherence CHECKs. The at/actor one
# is deliberately NOT a three-way all-or-nothing like P07's: a stage with
# a timestamp and NO actor is the BACKFILL basis, and the read reports it
# as derived rather than claiming a person moved it.
check "pipeline stage vocabulary CHECK"             "SELECT count(*) FROM pg_constraint WHERE conname='client_funding_opportunity_pipeline_stage_chk'"             "1"
check "pipeline stage timestamp CHECK"             "SELECT count(*) FROM pg_constraint WHERE conname='client_funding_opportunity_pipeline_stage_at_chk'"             "1"
check "pipeline version is non-negative"             "SELECT count(*) FROM pg_constraint WHERE conname='client_funding_opportunity_pipeline_version_chk'"             "1"

# The audit table is TENANT-SCOPED, unlike the provider catalog tables in
# this program: "who moved this to lost, when, and why" is a fact about
# ONE team.
check "stage transition table exists"             "SELECT count(*) FROM information_schema.tables WHERE table_name='funding_opportunity_stage_transition'"             "1"
check "stage transition RLS enabled"             "SELECT relrowsecurity FROM pg_class WHERE relname='funding_opportunity_stage_transition'"             "t"
check "stage transition RLS FORCED"             "SELECT relforcerowsecurity FROM pg_class WHERE relname='funding_opportunity_stage_transition'"             "t"
check "stage transition has four RLS policies"             "SELECT count(*) FROM pg_policies WHERE tablename='funding_opportunity_stage_transition'"             "4"

# PRODUCERS CANNOT MOVE A STAGE, as a column: there is no way to record a
# move nobody performed.
check "stage transition actor is NOT NULL"             "SELECT is_nullable FROM information_schema.columns WHERE table_name='funding_opportunity_stage_transition' AND column_name='actor_user_id'"             "NO"
# An outcome nobody explained is one nobody can learn from. Enforced in
# the database as well as the service, so a caller that bypasses the
# service still cannot do it.
check "outcome stages REQUIRE a reason"             "SELECT count(*) FROM pg_constraint WHERE conname='funding_opportunity_stage_transition_reason_chk'"             "1"
check "the reason CHECK rejects whitespace, not just NULL"             "SELECT CASE WHEN pg_get_constraintdef(oid) LIKE '%btrim%' THEN 'yes' ELSE 'no' END FROM pg_constraint WHERE conname='funding_opportunity_stage_transition_reason_chk'"             "yes"
check "a move to where it already was is refused"             "SELECT count(*) FROM pg_constraint WHERE conname='funding_opportunity_stage_transition_distinct_chk'"             "1"
check "stage transition cascades from its subject"             "SELECT confdeltype FROM pg_constraint WHERE conname='funding_opportunity_stage_transition_row_fkey'"             "c"

# -- P44: Tango budget beta context ---------------------------------
# GLOBAL, like every other tango_* catalog table. Asserting the
# ABSENCE of RLS is as load-bearing here as asserting its presence is
# on client_funding_opportunity: a false "tenant-scoped" would mean
# the table silently started acting scoped with no policy to scope it.
for t in tango_budget_account tango_budget_vendor_flow; do
  check "$t has NO tenant_id column"               "SELECT count(*) FROM information_schema.columns WHERE table_name='$t' AND column_name='tenant_id'"               "0"
  check "$t RLS is NOT enabled"               "SELECT relrowsecurity FROM pg_class WHERE relname='$t'"               "f"
  check "$t has NO policies"               "SELECT count(*) FROM pg_policies WHERE tablename='$t'"               "0"
done

# NULL IS NOT ZERO, as columns. On a real provider row most of these
# were null while contract_obligated carried a number; a NOT NULL or a
# DEFAULT 0 here would turn "the provider has not attributed this
# account" into "this account obligated nothing". NUMERIC, not a
# float: a float that rounds an obligation is a number nobody can
# reconcile against the source.
for col in requested_ba enacted_ba apportioned obligated_total outlayed_total unobligated_balance contract_obligated assistance_obligated; do
  check "budget $col is nullable"               "SELECT is_nullable FROM information_schema.columns WHERE table_name='tango_budget_account' AND column_name='$col'"               "YES"
  check "budget $col is NUMERIC, not a float"               "SELECT data_type FROM information_schema.columns WHERE table_name='tango_budget_account' AND column_name='$col'"               "numeric"
done
check "no budget money column carries a DEFAULT"             "SELECT count(*) FROM information_schema.columns WHERE table_name='tango_budget_account' AND column_name LIKE '%obligated%' AND column_default IS NOT NULL"             "0"

check "budget provider row id is UNIQUE"             "SELECT count(*) FROM pg_indexes WHERE indexname='tango_budget_account_row_id_uniq'"             "1"
check "budget fiscal-year range CHECK exists"             "SELECT count(*) FROM pg_constraint WHERE conname='tango_budget_account_fiscal_year_chk'"             "1"
check "a blank federal account symbol is refused"             "SELECT count(*) FROM pg_constraint WHERE conname='tango_budget_account_symbol_chk'"             "1"

# A UEI is 12 characters. A wrong-length value would silently match no
# client, which reads as "this vendor received nothing".
check "vendor-flow UEI length CHECK exists"             "SELECT count(*) FROM pg_constraint WHERE conname='tango_budget_vendor_flow_uei_chk'"             "1"
# CASCADE, unlike P27/P28's deliberately FK-free ledgers: a parity row
# is evidence that must outlive both catalogs, whereas a vendor flow
# with no account is a dollar figure attributed to nothing.
check "vendor flow cascades from its account"             "SELECT confdeltype FROM pg_constraint WHERE conname='tango_budget_vendor_flow_account_fkey'"             "c"
# COALESCE on the office: Postgres treats NULLs as distinct, so a plain
# composite would admit unlimited duplicates for a flow the provider
# reported with no funding office.
check "vendor-flow grain uniqueness exists"             "SELECT count(*) FROM pg_indexes WHERE indexname='tango_budget_vendor_flow_grain_uniq'"             "1"
check "vendor-flow uniqueness COALESCEs the office"             "SELECT CASE WHEN indexdef LIKE '%COALESCE%' THEN 'yes' ELSE 'no' END FROM pg_indexes WHERE indexname='tango_budget_vendor_flow_grain_uniq'"             "yes"

# THE PROHIBITION, as a schema assertion: this program creates no
# table whose name could be mistaken for a canonical Program Element
# one, and adds no column to one.
check "no PE-shaped tango table exists"             "SELECT count(*) FROM information_schema.tables WHERE table_name LIKE 'tango_%program_element%' OR table_name LIKE 'tango_%pe_%'"             "0"

# -- P45: protest and exclusion risk ---------------------------------
# GLOBAL, like every other tango_* catalog table. A GAO docket and a
# SAM exclusion are public records about the federal marketplace.
for t in tango_procurement_protest tango_entity_exclusion; do
  check "$t has NO tenant_id column"               "SELECT count(*) FROM information_schema.columns WHERE table_name='$t' AND column_name='tenant_id'"               "0"
  check "$t RLS is NOT enabled"               "SELECT relrowsecurity FROM pg_class WHERE relname='$t'"               "f"
  check "$t has NO policies"               "SELECT count(*) FROM pg_policies WHERE tablename='$t'"               "0"
done

# NO FK on the protest, for the same reason P27's and P28's ledgers
# have none: the record that a protest happened must outlive the
# catalog row it once pointed at.
check "protest has NO foreign keys"             "SELECT count(*) FROM pg_constraint WHERE conrelid='tango_procurement_protest'::regclass AND contype='f'"             "0"
# sam_opportunity_id stays NULLABLE forever: most protests will never
# link to a notice Capiro holds, and NOT NULL would mean discarding
# them.
check "protest sam_opportunity_id is nullable"             "SELECT is_nullable FROM information_schema.columns WHERE table_name='tango_procurement_protest' AND column_name='sam_opportunity_id'"             "YES"
# NULL outcome means OPEN or unstated. A DEFAULT here would turn every
# open case into a decided one.
check "protest outcome is nullable"             "SELECT is_nullable FROM information_schema.columns WHERE table_name='tango_procurement_protest' AND column_name='outcome'"             "YES"
check "protest outcome has NO default"             "SELECT count(*) FROM information_schema.columns WHERE table_name='tango_procurement_protest' AND column_name='outcome' AND column_default IS NOT NULL"             "0"

check "protest case id is UNIQUE"             "SELECT count(*) FROM pg_indexes WHERE indexname='tango_procurement_protest_case_uniq'"             "1"
check "a blank protest case id is refused"             "SELECT count(*) FROM pg_constraint WHERE conname='tango_procurement_protest_case_id_chk'"             "1"
check "a decision before its filing is refused"             "SELECT count(*) FROM pg_constraint WHERE conname='tango_procurement_protest_date_order_chk'"             "1"
# SAME-NAME ENTITIES INHERIT NOTHING, as a constraint: the only key is
# a 12-character UEI, and a malformed one cannot become a key that
# matches the wrong company.
check "protester UEI length CHECK exists"             "SELECT count(*) FROM pg_constraint WHERE conname='tango_procurement_protest_uei_chk'"             "1"
check "exclusion UEI length CHECK exists"             "SELECT count(*) FROM pg_constraint WHERE conname='tango_entity_exclusion_uei_chk'"             "1"
check "one exclusion observation per entity"             "SELECT count(*) FROM pg_indexes WHERE indexname='tango_entity_exclusion_uei_uniq'"             "1"

# observed_at is NOT NULL because, while the provider states no
# exclusion dates, freshness is the ONLY thing separating "excluded"
# from "was flagged at some point".
check "exclusion observed_at is NOT NULL"             "SELECT is_nullable FROM information_schema.columns WHERE table_name='tango_entity_exclusion' AND column_name='observed_at'"             "NO"
# TEXT, not boolean: a boolean throws away the difference between "the
# provider said no" and "the provider said nothing".
check "exclusion flag is TEXT, not boolean"             "SELECT data_type FROM information_schema.columns WHERE table_name='tango_entity_exclusion' AND column_name='exclusion_status_flag'"             "text"
check "exclusion date-order CHECK exists"             "SELECT count(*) FROM pg_constraint WHERE conname='tango_entity_exclusion_date_order_chk'"             "1"

# -- P46: verified webhook delivery ledger ----------------------------
# GLOBAL, and this one is load-bearing rather than incidental: a webhook
# arrives with NO session and NO tenant, and the receiver is mounted
# outside TenantContext middleware. If a tenant_id column ever appears
# here it means something inferred a tenant from provider-controlled
# data, which is the failure this assertion exists to catch.
check "delivery has NO tenant_id column"             "SELECT count(*) FROM information_schema.columns WHERE table_name='tango_webhook_delivery' AND column_name='tenant_id'"             "0"
check "delivery RLS is NOT enabled"             "SELECT relrowsecurity FROM pg_class WHERE relname='tango_webhook_delivery'"             "f"
check "delivery has NO policies"             "SELECT count(*) FROM pg_policies WHERE tablename='tango_webhook_delivery'"             "0"

# THE idempotency guarantee. Without this unique index two concurrent
# provider retries both insert, and P48 later fans out two alerts for
# one event. This is the single most important assertion in the block.
check "delivery_id is UNIQUE"             "SELECT count(*) FROM pg_indexes WHERE indexname='tango_webhook_delivery_delivery_id_uniq'"             "1"
check "a blank delivery id is refused"             "SELECT count(*) FROM pg_constraint WHERE conname='tango_webhook_delivery_delivery_id_chk'"             "1"
check "a blank event type is refused"             "SELECT count(*) FROM pg_constraint WHERE conname='tango_webhook_delivery_event_type_chk'"             "1"

# The payload digest must be a real lowercase hex SHA-256. A truncated
# or upper-cased hash would silently never match on comparison, making
# "same content twice" undetectable.
check "payload_sha256 shape CHECK exists"             "SELECT count(*) FROM pg_constraint WHERE conname='tango_webhook_delivery_sha256_chk'"             "1"
check "payload_bytes non-negative CHECK exists"             "SELECT count(*) FROM pg_constraint WHERE conname='tango_webhook_delivery_bytes_chk'"             "1"

# Lifecycle vocabulary is closed, and a drained row must carry its
# drain time — otherwise a half-written P47 drain looks complete.
check "delivery status vocabulary is closed"             "SELECT count(*) FROM pg_constraint WHERE conname='tango_webhook_delivery_status_chk'"             "1"
check "processed_at agrees with status"             "SELECT count(*) FROM pg_constraint WHERE conname='tango_webhook_delivery_processed_chk'"             "1"

# payload_sha256 is deliberately NON-unique: identical content
# legitimately arrives under two delivery ids. A unique index here
# would silently drop the second, real delivery.
check "payload_sha256 index is NOT unique"             "SELECT count(*) FROM pg_indexes WHERE indexname='tango_webhook_delivery_payload_sha_idx' AND indexdef LIKE '%UNIQUE%'"             "0"

# provider_event_at stays nullable forever: a payload carrying no
# timestamp is missing evidence, not stale evidence, and a NOT NULL
# here would force the receiver to invent one.
check "provider_event_at is nullable"             "SELECT is_nullable FROM information_schema.columns WHERE table_name='tango_webhook_delivery' AND column_name='provider_event_at'"             "YES"

# No FK, same reason as P45's ledgers: the record that a delivery
# arrived must outlive whatever row it later resolves to.
# -- P48: event outbox and quiet alerts -------------------------------
# The outbox is GLOBAL work; the alert is TENANT truth. If that split
# ever collapses, one of these two blocks fails.
check "outbox has NO tenant_id"             "SELECT count(*) FROM information_schema.columns WHERE table_name='tango_event_outbox' AND column_name='tenant_id'"             "0"
check "outbox RLS is NOT enabled"             "SELECT relrowsecurity FROM pg_class WHERE relname='tango_event_outbox'"             "f"
# ONE ROW PER EVENT, not per delivery. The single-column key made a
# multi-event batch unrepresentable: the receiver accepted it and the
# outbox kept only events[0], marking the row done while every later
# event was silently discarded.
check "the old delivery-only key is GONE"             "SELECT count(*) FROM pg_indexes WHERE indexname='tango_event_outbox_delivery_uniq'"             "0"
check "idempotency is (delivery, event_index)"             "SELECT count(*) FROM pg_indexes WHERE indexname='tango_event_outbox_delivery_event_uniq'"             "1"
check "event_index is NOT NULL"             "SELECT is_nullable FROM information_schema.columns WHERE table_name='tango_event_outbox' AND column_name='event_index'"             "NO"
check "event_index has a non-negative CHECK"             "SELECT count(*) FROM pg_constraint WHERE conname='tango_event_outbox_event_index_chk'"             "1"
check "outbox status vocabulary is closed"             "SELECT count(*) FROM pg_constraint WHERE conname='tango_event_outbox_status_chk'"             "1"
check "completed_at agrees with outbox status"             "SELECT count(*) FROM pg_constraint WHERE conname='tango_event_outbox_completed_chk'"             "1"

# The alert table is the one place in this phase that holds tenant
# data, so it carries the full four-policy FORCE RLS treatment.
check "alert HAS tenant_id"             "SELECT count(*) FROM information_schema.columns WHERE table_name='tango_event_alert' AND column_name='tenant_id'"             "1"
check "alert RLS is ENABLED"             "SELECT relrowsecurity FROM pg_class WHERE relname='tango_event_alert'"             "t"
check "alert RLS is FORCED"             "SELECT relforcerowsecurity FROM pg_class WHERE relname='tango_event_alert'"             "t"
check "alert has FOUR tenant policies"             "SELECT count(*) FROM pg_policies WHERE tablename='tango_event_alert'"             "4"

# THE quiet guarantee: replay and out-of-order delivery produce one
# result, and only a unique index can promise that under concurrency.
check "alert dedupe index is UNIQUE"             "SELECT count(*) FROM pg_indexes WHERE indexname='tango_event_alert_dedupe_uniq' AND indexdef LIKE '%UNIQUE%'"             "1"
check "alert fingerprint shape CHECK"             "SELECT count(*) FROM pg_constraint WHERE conname='tango_event_alert_fingerprint_chk'"             "1"
check "alert severity vocabulary is closed"             "SELECT count(*) FROM pg_constraint WHERE conname='tango_event_alert_severity_chk'"             "1"
check "alert stage vocabulary is closed"             "SELECT count(*) FROM pg_constraint WHERE conname='tango_event_alert_stage_chk'"             "1"

check "delivery has NO foreign keys"             "SELECT count(*) FROM pg_constraint WHERE conrelid='tango_webhook_delivery'::regclass AND contype='f'"             "0"

# EXECUTE the statement the drain actually issues, rather than asserting
# the index exists. Those are different claims, and the difference was a
# real bug: `tango_event_alert_dedupe_uniq` is a unique INDEX, so
# `ON CONFLICT ON CONSTRAINT <name>` raised "constraint does not exist"
# on EVERY insert — the drain would have retried each event five times,
# quarantined it, and written no alert at all. Every unit test passed,
# because they drive the service against an in-memory double and never
# run this SQL.
#
# So this runs it twice and requires 1 row then 0: the insert works AND
# the dedupe bites. An index-existence check could not have caught it.
FP_A=$(printf 'a%.0s' $(seq 1 64))
ins() {
  psql "$DATABASE_URL" -tAc "INSERT INTO tango_event_alert
    (tenant_id,client_id,source_type,source_record_key,change_dimension,
     severity,change_fingerprint,evidence_jsonb)
   VALUES ('11111111-1111-1111-1111-111111111111','33333333-3333-3333-3333-333333333333',
           'sam_opportunity','ci-probe','deadline','critical','$FP_A','{}'::jsonb)
   ON CONFLICT (tenant_id, client_id, source_record_key, change_fingerprint)
   DO NOTHING" 2>&1
}
first=$(ins); second=$(ins)
if echo "$first" | grep -q "INSERT 0 1"; then
  echo "  PASS  the drain's real alert INSERT executes"
else
  echo "::error::the drain's alert INSERT failed: $first"; fail=1
fi
if echo "$second" | grep -q "INSERT 0 0"; then
  echo "  PASS  a duplicate alert is deduped by the unique index"
else
  echo "::error::alert dedupe did not bite: $second"; fail=1
fi
psql "$DATABASE_URL" -q -c "DELETE FROM tango_event_alert WHERE source_record_key='ci-probe'" >/dev/null 2>&1

exit $fail
