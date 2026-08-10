import type { ReactNode } from 'react';
import { CapiroIconButton } from '../actions/index.js';

interface OverlayProps {
  open: boolean;
  title: string;
  children: ReactNode;
  onClose: () => void;
}

function OverlayBody({ kind, title, children, onClose }: Omit<OverlayProps, 'open'> & { kind: 'modal' | 'drawer' }) {
  return (
    <div className="capiro-overlay" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <section
        className={`${kind === 'modal' ? 'capiro-modal' : 'capiro-drawer'} capiro-elevation-widget`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 12 }}>
          <h2 className="capiro-vnext-heading" style={{ fontSize: 17 }}>{title}</h2>
          <CapiroIconButton label="Close" icon="×" onClick={onClose} />
        </div>
        {children}
      </section>
    </div>
  );
}

export function CapiroModal({ open, ...props }: OverlayProps) {
  return open ? <OverlayBody kind="modal" {...props} /> : null;
}

export function CapiroDrawer({ open, ...props }: OverlayProps) {
  return open ? <OverlayBody kind="drawer" {...props} /> : null;
}
