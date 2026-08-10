import { useNavigate } from 'react-router-dom';
import { useMailboxSyncStatus, type MailboxSyncViewModel } from '../../adapters/legacy/useMailboxSyncStatus.js';

export function MailboxSyncStatus() {
  const status = useMailboxSyncStatus();
  const navigate = useNavigate();
  return <MailboxSyncStatusView status={status} onClick={() => navigate('/settings/integrations')} />;
}

export function MailboxSyncStatusView({
  status,
  onClick,
}: {
  status: MailboxSyncViewModel;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      className="capiro-mailbox-status capiro-elevation-control"
      data-state={status.state}
      onClick={onClick}
      aria-label={`${status.title}. ${status.detail}`}
    >
      <span aria-hidden="true">✉</span>
      <span className="capiro-mailbox-status__copy">
        <span className="capiro-mailbox-status__title">{status.title}</span>
        <span className="capiro-mailbox-status__detail">{status.detail}</span>
      </span>
      <span className="capiro-mailbox-status__indicator" aria-hidden="true" />
    </button>
  );
}
