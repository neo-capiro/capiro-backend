# Exact roster routing proposal

**Held for explicit shared-listener priority approval, verified ownership and concrete task/configuration review.** The 20:21 UTC approval covers the bounded $6 build allocation ($4 Core / $2 frontend, one attempt each, within the $616 overall cap); it does not authorize this route or DNS mutation. Root owns approved build execution. This document is a proposal only.

Use [listener-before.json](./listener-before.json) as the observed baseline and [route-plan.json](./route-plan.json) for exact rule identities, conditions, actions and request fields. Re-read the listener before any separately approved execution and stop on drift. Source remains `50475125275853299798fc40f8cb119f0b865464`; a later documentation commit never replaces it.

## Why the shared priorities are involved

The roster authority is the exact Host `core-roster-preview.capiro.ai`. It needs an allow rule for **GET `/api/clients`** followed by a **host-only fixed 404 guard for every other path/method**, both ahead of the shared/header routes. The source gate additionally checks raw Host, exact request target and bounded query keys; ALB routing does not replace those checks.

All P1-15 slots are occupied. The fresh projected readback at **2026-10-19T20:32:23Z** matches the published baseline; **P16 and P17 are free**. A roster rule placed in those free slots without moving earlier rules can lose to the header-only Engagement P6 or generic API P10 rule. One rule cannot both forward the selected path and conditionally reject all other paths.

**The ten-rule proposal below supersedes the eleven-rule proposal at documentation commit `0c88c6d198c01a9bb0b8d7f0d82ffa8bdce779c0`.** Existing P5 is restricted to `app.capiro.ai`, so it cannot match the roster host and need not move. Preserve P1-5, shift only old P6-15 to P8-17, then add allow P6 and guard P7.

Ten existing moves are minimal for this listener while preserving every existing relative position and adding the required two-rule containment. Both new rules must precede old P6. With no gaps in P1-15, moving old P6 to at least P8 forces each following old rule through P15 to move. Free P16/P17 alone cannot provide containment before P6. A separate endpoint would require its own demonstrated infrastructure and review.

Every existing condition and action stays unchanged, and relative ordering is preserved:

| Existing rule | Before | Proposed |
| --- | ---: | ---: |
| Header-only Engagement wildcard | 6 | 8 |
| Recall | 7 | 9 |
| Onboard host | 8 | 10 |
| Onboard path | 9 | 11 |
| Generic API | 10 | 12 |
| Strategy | 11 | 13 |
| Workspace | 12 | 14 |
| Meri API | 13 | 15 |
| Intel | 14 | 16 |
| Webhooks | 15 | 17 |

Existing **Core P1-3, Meri P4 and callbacks P5 remain unchanged**, as do Marketing P20, OS P50 and the default action. New P6 is the exact roster allow; new P7 is the host-only 404 guard. The guard is **created first**, despite its later evaluation priority.

Old P5 and P7 have `ManagedBy=manual-alb-rule` tags. These tags do not identify an approving owner, and absent tags on the other rules establish no ownership. Verify the affected rule owners and obtain explicit approval of the ten priority changes. The current preservation constraint means this proposal is not executable merely because the build budget was approved.

## Proposed execution order after those holds clear

1. Revalidate baseline identities/priorities/conditions/actions, task/configuration approval, ownership and permissions. Confirm the roster and wildcard DNS records remain absent and existing `*.capiro.ai` ACM coverage remains valid. Stop on any drift.
2. Use the exact descending single-rule requests: **15→17, 14→16, 13→15, 12→14, 11→13, 10→12, 9→11, 8→10, 7→9, 6→8**. Each destination is vacant at that step; read back after every operation and stop on drift. All existing relative ordering remains unchanged after each completed move. Alternatively, the ten-rule batch has the same final state. AWS permits a conflict-free new order in [SetRulePriorities](https://docs.aws.amazon.com/cli/latest/reference/elbv2/set-rule-priorities.html); this does **not** establish transactional traffic-cutover or propagation guarantees.
3. Create **P7 host-only fixed 404 guard**. Verify its exact response, including paths/methods and legacy preview-header probes. The guard is independent of method and path.
4. Only after candidate task/native-authority qualification, create **P6 Host + GET + `^/api/clients$` allow** to the pinned Core target group. No wildcard path, HEAD allowance, meeting path or extra ordinary-auth read is included. Recheck the allow and all-deny fallback together.
5. **DNS last:** create only the absent A alias from the exact request; retain its returned receipt and wait for INSYNC. No AAAA or certificate change is proposed. Existing ACM coverage does not prove DNS/routing readiness.
6. Complete live TLS, native authentication and normalization/query negative cases, preserve existing Core/Meri behavior, then qualify the frontend PR111 source/origin pair. Do not fill frontend admission values from an unqualified source or a successful build alone.

Record actual new rule ARNs, DNS change ID, task ARN and immutable image digest after successful operations. Null request/receipt fields are unresolved values, never executable placeholders. Stop on a failed or uncertain step; inspect actual state before any retry. The build one-attempt limit supplies no retry authority for unrelated operations.

## Evidence and limits

[Offline verification](./offline-route-verification.json) passed **5,040 final non-roster and 630 final roster requests**, plus **50,400 non-roster checks across the ten intermediate moves** and **630 guard-only cases**. It preserves 18 existing rules, changes only ten priorities and adds two rules. Each move targets a vacant priority; the batch and descending sequence produce identical final states. Modeled non-roster requests retain the same rule identity/action; the canonical roster host admits only GET `/api/clients`, including with the legacy Engagement preview header. Independent review confirmed the ten-move minimum under these constraints.

This model does not cover ALB URI/Host normalization, query validation, propagation, TLS or authorization. Frozen application checks and live authenticated positive/negative probes remain mandatory. These results are not evidence that a route, task, image, DNS record or frontend successor is serving.

## Rollback and later cleanup

1. Remove the frontend roster admission pair first; retain `CAPIRO_PREVIEW_READ_ONLY=true`.
2. Remove only the newly created P6 allow, leaving the roster host denied by P7. Remove only the newly created DNS alias using its exact receipt fields.
3. If image/auth behavior regressed, restore the observed Core task revision 2 and verify its exact image and prior authority behavior. Preserve existing Core P1–3 and the original first-chat guard throughout.
4. **Keep the new roster guard and shifted priorities while DNS caches and requesting clients quiesce.** Immediate restoration puts the old Engagement rule at P6 ahead of the guard and Recall at the occupied P7; this conflicts with containment and can expose roster traffic to shared API fallback.
5. Treat removal of the new guard and restoration of all ten original priorities as separately reviewed cleanup. Restore priorities in one priority request and verify original conditions/actions. Guard deletion is a separate operation; no atomic rollback is claimed. DNS removal alone does not prevent direct requests carrying the roster Host, so cleanup must explicitly decide whether to retire that host reservation or preserve equivalent containment before removing its guard.

Do not delete the existing first-chat guard, unrelated DNS records or any rule without an exact creation/baseline receipt. Successful build spend and this source packet confer no shared-listener cleanup permission.
