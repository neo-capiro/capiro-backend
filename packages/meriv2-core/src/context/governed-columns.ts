/**
 * The ONE definition of the extra `memory_items` columns ContextPacket v2 needs.
 *
 * Three apps read `memory_items` directly (apps/api, apps/meriv2-orchestrator,
 * apps/workspace). Their v1 SELECT lists have already drifted apart once, and a v2
 * compile is far less forgiving: `filterGovernedMemory` withholds an item whose
 * class/approval/sensitivity it cannot see, so an adapter missing these columns
 * silently drops every firm-identity and client-steering item as `unapproved` and
 * mislabels a private user-voice item as firm scope. Defining the fragment once
 * makes that failure mode impossible to reintroduce in one app only.
 *
 * Every column here is added by `20260729010000_memory_governance_context_v2`, so
 * the fragment must only ever be appended on the v2 path — referencing it before
 * that migration is applied fails the read with 42703.
 *
 * `source_excerpt` is DELIBERATELY absent. It is confidential source content; a
 * Context Packet records refs, hashes and metadata, never bodies.
 *
 * Raw SQL rather than a Prisma selection because all three call sites read through
 * `$queryRaw` (the governed columns are read before any app models them for
 * queries). It interpolates no caller input.
 */
export const GOVERNED_STEERING_COLUMNS_SQL = `,
               visibility, owner_user_id AS "ownerUserId",
               memory_class AS "memoryClass",
               memory_authority AS "governedAuthority",
               source_type AS "sourceType", source_id AS "sourceId",
               source_ref AS "sourceRef",
               source_content_hash AS "sourceContentHash",
               source_version AS "sourceVersion",
               asserted_by_user_id AS "assertedByUserId",
               approved_by_user_id AS "approvedByUserId", approved_at AS "approvedAt",
               second_approved_by_user_id AS "secondApprovedByUserId",
               second_approved_at AS "secondApprovedAt",
               as_of AS "asOf", effective_from AS "effectiveFrom",
               valid_until AS "validUntil", review_due_at AS "reviewDueAt",
               conflict_status AS "conflictStatus",
               conflict_group_id AS "conflictGroupId",
               controlling_item_id AS "controllingItemId",
               sensitivity, confidence,
               instructions_allowed AS "instructionsAllowed",
               review_state AS "reviewState",
               origin_surface AS "originSurface", origin_trace_id AS "originTraceId",
               origin_context_packet_id AS "originContextPacketId",
               origin_model AS "originModel",
               origin_prompt_version AS "originPromptVersion"`;

/**
 * The pre-governance columns `compareSteeringRows` sorts on. apps/api and
 * apps/workspace already select these on the v1 path; the orchestrator adapter does
 * NOT, which is why the same rows compile to a differently ordered packet on the
 * two paths.
 *
 * Appended on the v2 path only, so closing the drift cannot reorder any prompt that
 * ships today. The v1 drift itself is left alone deliberately: fixing it would
 * change live orchestrator prompt order with no switch to hide behind.
 */
export const STEERING_ORDER_COLUMNS_SQL = `,
               updated_at AS "updatedAt",
               last_confirmed_at AS "confirmedAt",
               provenance AS authority`;
