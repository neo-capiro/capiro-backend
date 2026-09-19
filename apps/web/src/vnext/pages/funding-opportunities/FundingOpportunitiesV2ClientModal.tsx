import { useEffect, useRef } from 'react';
import { DashboardIcon } from '../../components/untitledui/dashboard-icons.js';

export type FundingClientOption = { id: string; name: string; status?: string; meta?: string };
export type FundingClientMatchCount = { clientId: string; total: number | null };

type Props = {
  clients: FundingClientOption[];
  selected: string | null;
  matchedCount?: FundingClientMatchCount | null;
  onChoose: (id: string | null) => void;
  onClose: () => void;
  returnFocusRef?: React.RefObject<HTMLElement | null>;
};

function initials(name: string) {
  return name.split(/\s+/).map((part) => part[0]).join('').slice(0, 2).toUpperCase();
}

export function FundingOpportunitiesV2ClientModal({
  clients,
  selected,
  matchedCount = null,
  onChoose,
  onClose,
  returnFocusRef,
}: Props) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  const initialFocusRef = useRef<HTMLButtonElement>(null);
  closeRef.current = onClose;

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const nodes = () => [...dialog.querySelectorAll<HTMLElement>('button:not([disabled])')];
    initialFocusRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        closeRef.current();
        return;
      }
      if (event.key !== 'Tab') return;
      const focusables = nodes();
      if (!focusables.length) return;
      if (event.shiftKey && document.activeElement === focusables[0]) {
        event.preventDefault();
        focusables.at(-1)?.focus();
      } else if (!event.shiftKey && document.activeElement === focusables.at(-1)) {
        event.preventDefault();
        focusables[0]?.focus();
      }
    };
    dialog.addEventListener('keydown', onKeyDown);
    return () => {
      dialog.removeEventListener('keydown', onKeyDown);
      if (returnFocusRef?.current?.isConnected) returnFocusRef.current.focus();
    };
  }, [returnFocusRef]);

  return (
    <div
      className="fo-v2-client-modal"
      data-fo-overlay="true"
      role="dialog"
      aria-modal="true"
      aria-label="Choose a client"
    >
      <div ref={dialogRef} className="fo-v2-client-modal-card">
        <header className="fo-v2-overlay-header">
          <div>
            <span className="fo-module-eyebrow">CLIENT CONTEXT</span>
            <h2>Choose a client</h2>
            <p>
              Relevance ranking, match explanations and saved searches are per client. Discovery
              mode keeps the catalog unscoped.
            </p>
          </div>
          <button ref={initialFocusRef} className="fo-v2-icon-button" aria-label="Close" onClick={onClose}>
            <DashboardIcon name="XClose" size={20} />
          </button>
        </header>
        <div className="fo-v2-client-options">
          <button className={!selected ? 'selected' : ''} onClick={() => onChoose(null)}>
            <span className="fo-v2-client-initials">ALL</span>
            <span>
              <strong>All clients — discovery mode</strong>
              <span>Unscoped catalog, no ranking or explanations</span>
            </span>
            <b>?</b>
          </button>
          {clients.map((client) => (
            <button
              key={client.id}
              className={selected === client.id ? 'selected' : ''}
              onClick={() => onChoose(client.id)}
            >
              <span className="fo-v2-client-initials">{initials(client.name)}</span>
              <span>
                <strong>{client.name}</strong>
                <span>{client.meta ?? 'Client profile'}</span>
              </span>
              <b>
                {matchedCount?.clientId === client.id && matchedCount.total != null
                  ? `${matchedCount.total} matched`
                  : '?'}
              </b>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

export default FundingOpportunitiesV2ClientModal;
