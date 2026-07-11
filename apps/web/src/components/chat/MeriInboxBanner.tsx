import type { MeriAlert } from './chat-store.js';

function priorityClass(priority: string): string {
  const normalized = priority.trim().toLowerCase();
  if (['critical', 'high', 'urgent'].includes(normalized)) return 'critical';
  if (['notable', 'medium', 'warning'].includes(normalized)) return 'notable';
  return 'info';
}

export function MeriInboxBanner({
  alerts,
  count,
  expanded,
  onExpandedChange,
  onDismiss,
  onClearAll,
}: {
  alerts: MeriAlert[];
  count: number;
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
  onDismiss: (id: string) => void;
  onClearAll: () => void;
}) {
  const pending = alerts.filter((alert) => alert.status === 'pending');
  if (pending.length === 0) return null;

  return (
    <section className="chat-alerts meri-inbox-banner" aria-label="Scheduled briefings">
      <div className="chat-alerts-header">
        <button
          type="button"
          className="chat-alerts-toggle"
          onClick={() => onExpandedChange(!expanded)}
          aria-expanded={expanded}
        >
          <span className="chat-alerts-title">
            <span className="chat-alerts-icon" aria-hidden="true">
              🔔
            </span>
            Scheduled briefings
            {count > 0 && <span className="chat-alerts-count">{count}</span>}
          </span>
          <span className="chat-alerts-chevron" aria-hidden="true">
            {expanded ? '▾' : '▸'}
          </span>
        </button>
        {pending.length > 1 && (
          <button
            type="button"
            className="chat-alerts-clear"
            onClick={onClearAll}
            title="Dismiss all briefings"
          >
            Clear all
          </button>
        )}
      </div>
      {expanded && (
        <div className="chat-alerts-list">
          {pending.map((alert) => (
            <article
              key={alert.id}
              className={`chat-alert-item chat-alert-item--unread chat-alert-item--${priorityClass(alert.priority)}`}
            >
              <div className="chat-alert-item-head">
                <span className="chat-alert-item-title">{alert.title}</span>
                <button
                  type="button"
                  className="chat-alert-item-dismiss"
                  onClick={() => onDismiss(alert.id)}
                  aria-label={`Dismiss ${alert.title}`}
                  title="Dismiss"
                >
                  Dismiss
                </button>
              </div>
              <div className="chat-alert-item-body">{alert.body}</div>
              <time className="chat-alert-item-meta" dateTime={alert.createdAt}>
                {new Date(alert.createdAt).toLocaleString()}
              </time>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
