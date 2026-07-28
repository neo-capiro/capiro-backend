/**
 * Persistent generation-run state. A toast disappears; a partially generated
 * document does not. This banner stays until the user retries or dismisses it,
 * names the sections that failed, and offers a retry that regenerates ONLY those
 * sections.
 */
import { Icon } from '../kit.js';
import type { GenerationReport } from './generation-status.js';

export function GenerationRunBanner({
  report,
  retrying,
  onRetryFailed,
  onDismiss,
  disabled,
}: {
  report: GenerationReport;
  retrying?: boolean;
  onRetryFailed?: () => void;
  onDismiss?: () => void;
  disabled?: boolean;
}) {
  if (!report.persistent) return null;

  const isError = report.tone === 'error';
  const accent = isError ? 'var(--danger)' : 'var(--warning, #b26a00)';

  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: 10,
        padding: '10px 30px',
        borderBottom: '1px solid var(--border-1)',
        background: isError ? 'var(--danger-soft, #fff1f0)' : 'var(--warning-soft, #fffbe6)',
        flex: 'none',
      }}
    >
      <Icon
        name={isError ? 'AlertTriangle' : 'AlertCircle'}
        size={14}
        style={{ color: accent, marginTop: 2, flex: 'none' }}
      />
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ fontWeight: 600, fontSize: 13, color: accent }}>{report.headline}</div>
        <div style={{ fontSize: 12, color: 'var(--ink-2)', marginTop: 2 }}>{report.detail}</div>
        {report.staleSections.length > 0 && (
          <div style={{ fontSize: 12, color: 'var(--ink-3)', marginTop: 2 }}>
            Showing the previous content for: {report.staleSections.join(', ')}. It was not
            regenerated.
          </div>
        )}
      </div>
      {report.canRetryFailed && onRetryFailed && (
        <button
          className="btn sm"
          onClick={onRetryFailed}
          disabled={disabled || retrying}
          title="Regenerate only the sections that failed — successful sections are left untouched"
          style={{ flex: 'none' }}
        >
          <Icon name="RefreshCw" size={12} />
          {retrying ? 'Retrying…' : 'Retry failed sections'}
        </button>
      )}
      {onDismiss && (
        <button
          className="btn sm btn-ghost"
          onClick={onDismiss}
          title="Hide this notice"
          style={{ flex: 'none' }}
        >
          Dismiss
        </button>
      )}
    </div>
  );
}
