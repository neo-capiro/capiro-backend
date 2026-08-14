import { useNavigate } from 'react-router-dom';
import { useMailboxSyncStatus, type MailboxSyncViewModel } from '../../adapters/legacy/useMailboxSyncStatus.js';

export function MailboxSyncStatus() {
  const status = useMailboxSyncStatus();
  const navigate = useNavigate();
  return <MailboxSyncStatusView status={status} onClick={() => navigate('/settings/integrations')} />;
}

export function MailboxSyncStatusView({ status, onClick }: { status: MailboxSyncViewModel; onClick?: () => void }) {
  return (
    <button
      type="button"
      className="capiro-mailbox-status"
      data-state={status.state}
      onClick={onClick}
      aria-label={`${status.title}. ${status.detail}`}
    >
      <span className="capiro-mailbox-status__headline">
        <span className="capiro-mailbox-status__indicator" aria-hidden="true" />
        <span className="capiro-mailbox-status__title">{status.title}</span>
      </span>
      <span className="capiro-mailbox-status__detail">{status.detail}</span>
    </button>
  );
}
