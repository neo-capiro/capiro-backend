# Rich newsletter local editor and receiving guard

This PR16 slice repairs generic Outreach metadata loss and adds a deliberately local rich newsletter editor. It does **not** complete native rich newsletter authoring or delivery. PR15 remains frozen at source `1585438295776604f23a5cb5ab592729f7c468ca`, evidence `3a83e874383d9129726689bb8fc66438c2f18f18`. The current executable source/evidence binding is recorded in `RICH-SLICE-EVIDENCE-MANIFEST.json`.

## Implemented behavior and ownership

The existing generic receiving schema selectively retains valid `newsletterStageId` and positive safe-integer `newsletterRevision` metadata. Absent/null metadata and absent stage hints remain ordinary. Present malformed reserved fields fail decoding; unrelated fields still strip. The Engagement feature prevents rich candidates and wrong-type hints from reaching the plain-text writer. Direct rich links, ambiguous IDs and legacy draft selections enter an explicit unavailable destination without rich reads, opens, preparation or send calls. Back clears local selection or preserves a valid client hint in its canonical return link. `/engagement/outreach` is a thin compatibility entry under the existing shared shell. Stage UUIDs and saved document-version UUIDs remain distinct.

`features/modules/workspace/rich-newsletter` owns a local draft, bounded Undo/Redo, structure selection, basic block addition/removal, content/style controls and inert desktop/mobile/plain-text preview. It uses the installed public content factories/types and renderer, adopted Tiptap and DOMPurify; it imports no backend implementation or private package paths. Nested design fields, font/source hints and unedited content survive local transforms. The preview preserves the canonical responsive styles, disables navigation/forms/scripts/external assets and permits bundled newsletter images. The root application boundary discards editor state on session/org/client replacement. The editor explicitly says it is local; saving/staging/delivery remain unavailable. No new endpoint or revision claim was invented.

All179 original public assets and the37 original test histories remain intact. The existing saved-version staging owner and meaningful tests are unchanged. All43 historical rich runtime facets remain unaccepted; basic local editing is partial coverage, not a replacement for the original scope.

## Consolidated validation

| Check | Result |
|---|---|
| Metadata regression baseline |13 failed /8 passed before repair;21 pass after repair |
| Final affected browser suite |39 passed:14 rich editor/routing,9 saved-version staging,16 prospect Workspace |
| Current source/operation unit suite |157 passed, including21 metadata,16 route and3 rich draft tests |
| Final application unit suite |1275 passed; includes the existing16 saved-version unit cases |
| Root script tests after sparse setup repair |62 passed |
| Packed public package |120 passed; tarball hash/integrity unchanged |
| Architecture tests |31 passed |
| Architecture |429 signals:405 reviewed,24 unchanged inherited/unreviewed,0 blocking;0 boundary errors |
| Typecheck, authored format, source whitespace |Passed |
| Targeted lint |0 errors;2 inherited warnings (type-only helper and existing location.assign) |
| Independent review |Bounded slice accepted after Back, history-focus, renderer/control and responsive-preview fixes; exact six function reviews preserved |
| Production build |FAILED: webpack compilation and TypeScript passed; prerender exhausted filesystem space (ENOSPC) |
| Actual Next server / new clean root install |NOT RUN to completion; borrowed pinned dependencies do not constitute a clean install |

Preserved diagnostic history includes the failing Undo→type focus test, its corrected green result, and the responsive assertion's initial38-pass/1-fail run. The latter expected a375px table inside a375px frame but ignored the canonical table cell's2px inset; the replacement checks actual inner-viewport containment, no horizontal overflow and the canonical32px mobile heading rule. It does not alter the renderer to satisfy a pixel assertion. Initial broad script failures were missing tracked design/deployment files in this sparse worktree; exact HEAD files were materialized and all62 cases passed. An initial size-record insertion used the wrong registry shape; the corrected records use the existing function-review owner, with no guard relaxation.

The failed build generated947MB of cache. A failed cross-filesystem copy was removed only after every original was verified present. The original generated cache was archived and every archived file SHA-256 verified before removing this run's cache; archive and byte manifest remain in `/tmp/capiro-newsletter-rich-dispatch-evidence`. Original owner work, prior proofs, frozen PR15, assets and package bytes were not removed. The archive is a local diagnostic, not a deployable output or a source deliverable.

## Material dependency and remaining coverage

At reviewed backend PR2427 `62d057b4a17b2c038920f10b93e83e51e46239bc`, the qualified public package lacks runtime receiving parsers and dedicated rich-record/stage-read envelope types. The public `NewsletterStage` type is the stage-creation receipt, not the stage-read response. The backend owner needs to publish browser-safe parsers/types for document/list/create/save responses, saved preview/checks and dedicated rich record/stage-read envelopes, plus malformed-response fixtures and newly pinned package bytes. Generic reserved metadata validation is already supported by its explicit receiving handoff. Do not cast unknown JSON, duplicate editable DTOs or import private Nest validators.

After that dependency: implement explicit create/load and revision-CAS save; retain edits on409, require read-back after uncertain writes, and bind every result to the current document/session/client lifetime. Preview POST renders **saved current state**, not unsaved edits. Some document GETs activate invitations. Rich stage/open remains a separately authorized explicit action; it is never a side effect of decoding/navigation. Delivery needs current backend record/stage/source access and immutable-version checks. These facts are bound in the independent contract report.

Remaining original facets: revisioned persistence; advanced block/layout and responsive style controls; brand/fonts; assets/uploads/revisions; image editor; review/invitations/threads; social follow/share; apps/video/AI/check tools; saved-survey preservation; rich recipient preparation, immutable versions, test/send status and recovery. Original unavailable hosted-survey/product creation stays unavailable. No endpoint, provider workflow, group-recipient permission or ID bridge is invented.

Native authorization/RLS, CAS concurrency and durability, real client replacement, provider delivery, complete Figma comparison, full accessibility, deployed asset origin and full product acceptance remain unrun/unaccepted. All337 Portfolio native rows remain held, with the existing eight exclusions unchanged. Current basic keyboard/focus/labels, local session replacement, viewport and sanitized-preview checks do not substitute for those gates. PR16 must not delay or silently join the separate frozen shipping candidate.
