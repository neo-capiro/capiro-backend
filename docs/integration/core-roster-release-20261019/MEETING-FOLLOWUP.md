# Meeting follow-up design — held

**Design only, for a separate feature branch after candidate preparation.** The initial release remains the reviewed roster/native-read preview. Frozen Core candidate `50475125275853299798fc40f8cb119f0b865464` is unchanged. This document does not authorize meeting route activation or application edits.

The following operations remain held:

| Operation | Reason |
| --- | --- |
| `GET /api/engagement/meetings?from&to&clientId` | Existing ownership and association filtering do not establish current selected-client authority; contact association can include unassigned meetings. |
| `GET /api/engagement/meetings/:id` | Parent ownership is checked, but its current client wall is not. |
| `GET /api/engagement/meetings/:id/notes` | Parent ownership and body visibility are checked, but current client authority is not. |
| `GET /api/engagement/meetings/:id/debriefs` | Same client-authority gap as notes. |
| `PUT /api/engagement/meetings/:id` | Current client authority needs review; supplying an unchanged client can still mutate association metadata. |

The separate capabilities GET is source-supported as a configuration snapshot only; it does not qualify these operations or establish runtime readiness.

## Existing boundaries to preserve

All anchors refer to the frozen candidate. These are ordinary Clerk-authenticated engagement handlers, not entries in the native preview GET matcher. Keep the existing role guard, tenant resolution and ownership predicate. Do not edit shared middleware, widen the preview matcher or substitute a service credential.

`apps/api/src/engagement/engagement-access.helpers.ts:36` permits a meeting created by the actor or received through a calendar connection owned by that actor, excluding deleted meetings. An administrator does not bypass this parent predicate. Preserve it in list, detail, notes and debriefs.

The list at `apps/api/src/engagement/engagement.service.ts:1413–1444` adds a time window and optional association filter. The helper at `apps/api/src/engagement/engagement-access.helpers.ts:46` includes explicit assignment **or** qualifying unassigned contact-email associations. The detail at service line 1448 and artifact reads at lines 6138 and 6194 authorize the parent but have no selected-client wall check.

Keep existing note/debrief body rules at `engagement-access.helpers.ts:111`: the admin exception applies to decrypting a body only after parent access succeeds. Restricted bodies must remain null. Do not change response fields, decryption, approved content or sharing semantics.

Ordinary middleware may update activity or repair existing identity records. Adding a local authority boundary does not make the entire HTTP request database-read-only.

## Smallest proposed read fix

Limit implementation to the four controller/service call paths, one small engagement authority/read helper and focused tests. Existing internal service callers must be reviewed explicitly; do not silently change unrelated callers, meeting creation, sharing, notetaker dispatch, capabilities or shared authentication.

1. **Bind proof to the real request.** For the future preview cohort, pass a request-bound authority port from the controller into the service read boundary. Reuse the existing public `TenantContextMiddleware.readApplicationAuthority(req, ctx)` at `apps/api/src/tenant/tenant-context.middleware.ts:710`; do not modify that middleware. Require current native identity before the read, compare identity revisions/principal/expiry after awaited work, then perform the proof's local `recheckCurrent`. Follow the ordering in `apps/api/src/auth/application-authority.ts:143–169`, including re-reading local owners after the online await. No synthetic credential, user-supplied approval flag or internal HTTP call to an authority endpoint is appropriate. The future preview dispatch must be selected by server-owned policy while retaining ordinary authentication and ownership.
2. **Narrow existing owner authority with current client authority.** In the same transaction as parent/content reads, resolve the canonical client from a locked, freshly read parent. Require same-tenant, nonarchived client, current active actor membership and the established `clientMemoryAllowed` predicate. Client permission never replaces `ownMeetingWhere`. Denied detail/artifact access should be an opaque not-found response.
3. **Authorize before association reads.** For a selected-client list, authorize that client before reading profile/contact emails. The proposed bounded preview permits only the approved existing completed, private, manual meeting/client cohort and at most 42 local calendar days, resolved using the reviewed timezone. Enforce that cohort on the server. An inferred unassigned association is not approval for this preview. Preserve general list semantics outside this explicit cohort; do not silently broaden it into unfiltered or inferred meetings.
4. **Close parent/client drift around awaits.** Re-read the parent assignment and wall/membership owners after online checks, and hold the necessary parent/client/member/grant protections through response materialization and the final authority check. A check before reading is insufficient if a meeting moves from allowed client A to denied client B during the read. Inspect existing writer lock order first; list locks need deterministic ordering and a bounded row set. Do not hold database locks across online network calls if the same release invariant can be maintained with an online check followed by a local locked re-read and final proof check.

Use established read primitives without importing unrelated ordered-owner requirements. `apps/api/src/clients/client-ordered-owner.access.ts:37–66` demonstrates active-member, nonarchived-client and wall-grant checks, but `requireOwnerClient` also reads account-owner version fields and takes a client `FOR UPDATE` lock. Prefer a small engagement read helper over adopting that whole owner operation. Its `write=true` mode requires user-admin and would incorrectly change standard-user meeting permissions. `clientMemoryAllowed` alone does not cover membership, archive state or release-time currentness.

A static frontend meeting/client pin plus ordinary JWT validation does not provide this server-side proof. The four GETs stay held until the local authority design, scope dispatch, lock order and negative tests are reviewed.

## Smallest same-client PUT fix

`apps/api/src/engagement/engagement.service.ts:1563–1644` already locks the parent when `clientId` is present and then reads it with tenant/owner scope. At line 1579 it calls `reassignMeetingClient` whenever the property is present, even when equal. That helper at lines 1664–1711 rewrites association fields; an internal/null case can additionally change visibility, sharing, children and indexing state.

On the later branch:

- Keep the existing parent lock and read order (`lockMeetingClientAssignment`, line 1649), owner predicate and expected-revision check. Compare normalized UUID-or-null values only after the locked fresh read.
- Call reassignment only when the canonical client actually changes. Use the same canonical-change decision for association-override creation, avoiding a case-only UUID difference creating an override.
- When the client is unchanged, preserve `isInternal`, association score/reason/signals, visibility/sharing, child client IDs and index state. Do not run association cleanup or enqueue attachment indexing.
- Preserve existing requested-field behavior: subject trimming; blank description/location becoming null; existing date parsing; and location/description virtuality derivation. Preserve ordinary response shape, content and normal update timestamps. Do not turn an equal client field into an instruction to rewrite unrelated metadata.
- Genuine reassignment retains its existing transaction/propagation behavior and requires separate current destination-client authority. Do not relax that authority to make this preview pass.

For the proposed preview, the optional edit body remains limited to subject, description, location, startsAt and endsAt, with the selected client unchanged. Omitting clientId in a frontend successor avoids triggering the known equal-client branch, but does not solve the server-side authority gap or approve PUT. Broader DTO fields, true reassignment and date-policy changes are outside this follow-up.

## Focused acceptance tests

| Case | Required result |
| --- | --- |
| Native current actor owns approved meeting and has current selected-client access | Existing response fields and allowed body content are preserved. |
| Foreign tenant, nonowner, archived client or missing wall grant; repeat as administrator | No meeting/artifact release; administrator does not bypass parent/client authority. |
| Membership/grant revoked, session changed or proof expires during an awaited read | Refuse release; no stale identity or wall proof is reused. |
| Parent reassigned from allowed A to denied B while reading list/detail/notes/debriefs | No B content is released under A's authority; lock ordering completes without deadlock. |
| Selected-client list with denied client, inferred unassigned match or out-of-cohort/time-window record | No unauthorized contact read; no extra preview row is admitted. |
| Confidential body unavailable to actor | Body remains null with existing metadata/shape; authorized body behavior is unchanged. |
| Same client, case-normalized same UUID, unchanged null, and omitted clientId | Only requested ordinary fields/timestamps change; no association override, sharing reset, child propagation, cleanup or indexing call. Include an internal/null fixture. |
| Genuine client change with allowed and denied destination | Allowed path preserves established propagation; denied destination performs no mutation. |
| Description/location edited with unchanged client | Existing trim/null and virtuality behavior is preserved. |

Tests should exercise the real service transaction boundary with controllable await/race barriers, not just compare a predicate to itself. Assert no provider, LLM, notetaker or external-send action is introduced. No new migration is expected if the helper uses existing meeting/client/member/wall fields; implementation must verify that claim and avoid accidental ordered-owner schema dependencies.

No application change or test run accompanies this design. Meeting GETs and PUT remain held independently of roster activation.
