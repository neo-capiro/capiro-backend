/*
 * P0-1: the SINGLE source of the "is this node still part of the plan?" predicate.
 *
 * sp_node is soft-deleted. A non-destructive version restore ARCHIVES the nodes
 * the restored snapshot omits (instead of DELETEing them and cascading their
 * sp_node_artifact back-links away), so an archived row is still physically
 * present and still referenced by runs, approvals, provenance and artifacts.
 *
 * Consequence: EVERY read that means "the live plan" must filter on archivedAt.
 * That filter is deliberately explicit at each call site rather than hidden in
 * the PrismaService query hook — the hook already injects tenantId invisibly,
 * and a second invisible predicate would make the snapshot/verifier/eligibility
 * reads impossible to reason about. Import these constants so the live-vs-
 * archived decision at every site is greppable.
 *
 * Live reads that MUST use LIVE_NODE_WHERE:
 *  - loadStrategyDetail / StrategyService.byId+list  (the editor payload)
 *  - VersioningService.snapshot                      (an archived node must
 *                                                     never re-enter a version)
 *  - NodeService update/remove/linkArtifact/deps      (no editing an archived node)
 *  - MeriService edit-set lookups + plan reads        (assistant + change-set apply)
 *  - ExecutionService.loadPlanState                  (never execute an archived node)
 *  - WatcherService plan reads                        (no alerts on archived nodes)
 */

/** A node that is still part of the live plan. */
export const LIVE_NODE_WHERE = { archivedAt: null } as const;

/** A node soft-deleted by a version restore (the detached surface). */
export const ARCHIVED_NODE_WHERE = { archivedAt: { not: null } } as const;

/** An artifact relationship still attached to the live plan. */
export const ATTACHED_ARTIFACT_WHERE = { detachedAt: null } as const;
