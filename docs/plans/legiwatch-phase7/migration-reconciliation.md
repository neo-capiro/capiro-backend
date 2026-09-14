# Phase 7 migration reconciliation

The client evidence archive remains immutable and outside Git. All 45 package manifest hashes were verified. Private ledgers contain the full source capture/staged IDs, raw labels/URLs/titles, source paths, capture hashes, mapped target folders, source versions, source qualification and unresolved reasons.

| Inventory | Accounted for | Applied at this checkpoint |
|---|---:|---:|
| Statute-folder assignments | 174 | 0 |
| Distinct displayed labels | 164 | Not canonical section count |
| Source folders | 35, all mapped | Existing folder mappings preserved |
| Chapter / section assignments | 7 / 167 | 0 |
| Archived / read-only assignments | 13 / 2 | Existing access state preserved |
| Populated / missing statute URLs | 93 / 81 | All rows retained |
| Typed statute alert definitions | Six staged entries | No activation or delivery |
| Earlier-session client exports | None supplied | 0 |

Publisher evidence supports 155 exact identity/title matches. Ten proposed corrections are 397.693→397.68111, 397.695→397.68112, 397.6955→397.68151, 316.64→316.640, 316.65→316.650, 321.5→321.50, 934.5→934.50 twice, 339.7→339.70 and 561.2→561.20. These remain proposals; the original captured labels are retained. Nine rows remain unresolved, including the section-0 / 409.9112 URL discrepancy. Live staged title encoding differences are retained separately and never silently replace original captured text.

| Capture | Captured name | Source folders | Captured memberships / email recipients | Decision/remedy |
|---|---|---|---|---|
| alert-23 | Unnamed | 3683, 14572, 3700, 25698, 24994, 3702, 10990, 24995 | 3 / 3 | Keep unnamed; deleted creator and six empty folders require review. |
| alert-24 | 316.173 | 49542, 57738 | 5 / 1 | Use actual Gallo/Miami Parking folder contents. Title is not a statute criterion. |
| alert-25 | 381.986 | None | 0 / 0 | Supply targets and current staff or explicitly exclude. |
| alert-26 | Airbnb Chapter 509 | None | 0 / 1 | Supply targets or explicitly exclude. |
| alert-27 | HCA F.S. 395.003(e) | 59218 | 1 / 2 | Actual captured object is section 395.003. Do not invent subsection (e). |
| alert-28 | Priority Statute Alerts | 30204 | 5 / 2 | Review mixed chapter/section targets and descendant policy. |

Runtime identities use `2026-09-10:alert-23` through `2026-09-10:alert-28` plus the actual staged UUID and expected version. No frequency was captured. Cadence stays null until explicitly configured. Captured email checkboxes do not authorize new sends or SMS. Promotion, matching, internal follow-up and outward delivery remain separate states.

Canonical import decisions compare the staged version/hash and current folder mapping inside the authoritative owner transaction. Source aliases retain independent provenance while canonical membership deduplicates. Manual removals/tombstones, restored memberships, current owner/client access and immutable decision history are tested. Replaying a supplied historical export cannot recreate a manually removed assignment or overwrite a current-session assignment.
