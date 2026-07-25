/*
 * The write-ahead staging sentinel, in its own PURE module so the P0-2 recovery
 * rules (run-recovery.ts) can reason about reservations without importing
 * ExecutionService and dragging Nest into a pure module's graph.
 * ExecutionService re-exports PENDING_ARTIFACT_REF, so existing importers are
 * unaffected.
 */

/**
 * Write-ahead intent sentinel for sp_node_artifact.artifactRef. A staging attempt
 * commits a row carrying THIS ref BEFORE the external create hop
 * (ExecutionService.reserveArtifact); recordArtifact then retires it and commits
 * the REAL ref atomically with the node-status advance. Staging's external create
 * and its local back-link cannot be one transaction, so this sentinel is what
 * makes a retry safe: if a prior attempt created the upstream artifact but its
 * back-link write failed, the sentinel survives, so the retry FINDS it and parks
 * for reconciliation instead of issuing a second external create (a duplicate
 * staged artifact). Real WsDraft/OutreachRecord ids are uuids and never collide.
 */
export const PENDING_ARTIFACT_REF = '__staging_pending__';

/** True for the write-ahead sentinel (i.e. NOT a real upstream artifact id). */
export function isPendingRef(ref: string | null | undefined): boolean {
  return ref === PENDING_ARTIFACT_REF;
}

/** True for a real upstream artifact id (a committed, usable back-link). */
export function isRealRef(ref: string | null | undefined): boolean {
  return typeof ref === 'string' && ref.length > 0 && ref !== PENDING_ARTIFACT_REF;
}
