import type { ReactNode } from 'react';
import { PfDrawer } from './portfolio-overlays.js';

/**
 * Phase 4 (vnext UI cleanup — client record restructuring).
 *
 * The right-side slide-over for the four directory surfaces (Relationships,
 * Work, Files and Capabilities) in `ClientRecordDirectory`. This is a thin
 * wrapper around `PfDrawer` (portfolio-overlays.tsx §12), which already
 * implements the fixed scrim, `role="dialog"`, focus trap, Escape-to-close,
 * the `--pf-shadow-drawer` box-shadow and the `capPfSlideIn` animation — it
 * was built in an earlier phase but had no caller until this one. The current
 * standalone client-record prototype supersedes the retired 560/480px drawer
 * rule: every directory drawer is `min(1280px, calc(100% - 56px))`, uses the
 * compact 20px title, and lets its child surface run edge to edge.
 */

export interface RecordDrawerProps {
  title: string;
  sub?: string;
  onClose: () => void;
  children: ReactNode;
}

export function RecordDrawer({ title, sub, onClose, children }: RecordDrawerProps) {
  return (
    <PfDrawer eyebrow="Overland AI" title={title} sub={sub} onClose={onClose} variant="record">
      {children}
    </PfDrawer>
  );
}
