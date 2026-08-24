import { useEffect, useState, type ReactNode } from 'react';
import { PfDrawer } from './portfolio-overlays.js';
import type { Client } from '../../../pages/clients/clientTypes.js';

/**
 * Phase 4 (vnext UI cleanup — client record restructuring).
 *
 * The right-side slide-over for the four "directory" surfaces (Relationships/
 * Work/Files/Capabilities) that the sticky `DrawerRail` opens. This is a thin
 * wrapper around `PfDrawer` (portfolio-overlays.tsx §12), which already
 * implements the fixed scrim, `role="dialog"`, focus trap, Escape-to-close,
 * the `--pf-shadow-drawer` box-shadow and the `capPfSlideIn` animation — it
 * was built in an earlier phase but had no caller until this one. Nothing
 * here reinvents that chrome; this only supplies the client-scoped title/sub
 * and the module's own narrow-viewport convention.
 *
 * Width: 560px desktop / 480px narrow (PORTFOLIO-UI-BUILD-SPEC.md "Drawer
 * 560/480px"), using the same `w < 1200` boundary `tabs/FilesTab.tsx`'s
 * `usePfNarrow` already uses — not a new breakpoint.
 */

function usePfNarrow(): boolean {
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 1199px)');
    const apply = () => setNarrow(mq.matches);
    apply();
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, []);
  return narrow;
}

export interface RecordDrawerProps {
  /** Only used for the eyebrow above the title — real client name, not a placeholder. */
  client: Client;
  title: string;
  sub?: string;
  onClose: () => void;
  children: ReactNode;
}

export function RecordDrawer({ client, title, sub, onClose, children }: RecordDrawerProps) {
  const narrow = usePfNarrow();
  return (
    <PfDrawer eyebrow={client.name} title={title} sub={sub} onClose={onClose} width={560} narrow={narrow}>
      {children}
    </PfDrawer>
  );
}
