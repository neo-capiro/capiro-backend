/**
 * Saved views overlay (§7.13) — one store with two surfaces (§4.1 #4). Two
 * panes: the view list (share + default badges) and the selected view's
 * definition, sharing, current-match statement and Rename/Duplicate/Delete.
 *
 * There is no saved-view persistence backend (GAPS LW-G8) — the overlay opens
 * to the honest unavailable state rather than a fabricated list. The Feed's
 * saved-view strip is omitted for the same reason.
 */
import { LwModal } from './LwModal.js';
import { LwPill } from '../lib/primitives.js';

export function SavedViewsOverlay({ onClose }: { onClose: () => void }) {
  return (
    <LwModal
      kind="views"
      eyebrow="LegiWatch view presets"
      title="Saved views"
      subtitle="Reusable combinations of scope, work state, source, sort, and arrangement."
      note="Saved views persist per user. Team-shared views remain read-only until duplicated."
      primaryLabel="Apply view"
      primaryDisabled
      primaryTitle="Saved views have no persistence backend yet (GAPS LW-G8)."
      onClose={onClose}
    >
      <div className="lw-state" role="status">
        <LwPill tone="warning">UNAVAILABLE</LwPill>
        <h3 className="lw-state__title">Saved views need a persistence backend</h3>
        <p className="lw-state__body">
          There is no saved-view store to list, apply, share, or delete against (GAPS LW-G8). The
          Feed&rsquo;s filter rail applies the same scope, work state, source, sort and arrangement —
          those settings are real; saving them as a named view is what isn&rsquo;t built yet.
        </p>
      </div>
    </LwModal>
  );
}
