import { useId, useMemo, useState, type KeyboardEvent } from 'react';
import './ContextInspector.css';

export type ContextExclusionReason =
  | 'expired'
  | 'superseded'
  | 'revoked'
  | 'over-budget'
  | 'unauthorized'
  | 'unavailable'
  | 'empty'
  | string;

export interface TrustContextItem {
  id: string;
  label: string;
  type: string;
  scope?: 'personal' | 'client' | 'firm' | string | null;
  authority?: string | null;
  status?: string | null;
  clientName?: string | null;
  userScoped?: boolean;
  asOf?: string | null;
  lastConfirmedAt?: string | null;
  rationale?: string | null;
  selection?: 'explicit' | 'automatic' | string | null;
}

export interface TrustContextExclusion {
  id?: string | null;
  label?: string | null;
  type?: string | null;
  reason: ContextExclusionReason;
}

export interface TrustContextPacket {
  /** Durable ID only. A failed persistence attempt must set persisted=false. */
  packetId?: string | null;
  persisted?: boolean;
  persistenceErrorCode?: string | null;
  compiledAt?: string | null;
  surface?: string | null;
  clientId?: string | null;
  items: TrustContextItem[];
  exclusions?: TrustContextExclusion[];
  unauthorizedCount?: number;
  degraded?: boolean;
  degradedReason?: string | null;
}

const REASON_LABELS: Record<string, string> = {
  expired: 'Expired',
  superseded: 'Superseded',
  revoked: 'Revoked',
  'over-budget': 'Omitted to fit the context budget',
  unauthorized: 'Not available to this user',
  unavailable: 'Temporarily unavailable',
  empty: 'No usable content',
  rejected: 'Rejected in review',
  stale: 'Stale — awaiting review',
  conflicted: 'Withheld: unresolved conflict',
  unapproved: 'Not approved for use yet',
  'invalid-until': 'Outside its validity window',
  'source-missing': 'No verifiable source',
  'legacy-unclassified': 'Unclassified — awaiting governance review',
  'wrong-client': 'Belongs to a different client',
  'sensitivity-denied': 'Above your access level',
};

const IDENTITY_WITHHELD_REASONS = new Set(['unauthorized', 'wrong-client', 'sensitivity-denied']);

const STATUS_LABELS: Record<string, string> = {
  suggested: 'Suggested',
  pending_review: 'Pending review',
  active: 'Active',
  stale: 'Stale — review due',
  conflicted: 'Conflicted — controlling item',
  rejected: 'Rejected',
  superseded: 'Superseded',
  revoked: 'Revoked',
  expired: 'Expired',
};

const AUTHORITY_LABELS: Record<string, string> = {
  'human-authored': 'Human authored',
  'system-of-record': 'System of record',
  derived: 'Derived',
  unknown: 'Unknown',
  firm_approved: 'Firm approved',
  client_approved: 'Client approved',
  external_authoritative: 'System of record',
  user_asserted: 'User asserted',
  analyst_verified: 'Analyst verified',
  working_draft: 'Working draft',
  model_inferred: 'Model inferred',
  legacy_unclassified: 'Unclassified',
};

function dateLabel(value: string | null | undefined): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleString([], {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function scopeLabel(item: TrustContextItem): string | null {
  if (item.scope === 'personal') return 'Personal';
  if (item.scope === 'client') return item.clientName ? `Client · ${item.clientName}` : 'Client';
  if (item.scope === 'firm') return 'Firm';
  if (item.scope) return item.scope;
  if (item.userScoped) return 'Personal';
  return null;
}

function authorityLabel(value: string | null | undefined): string | null {
  if (!value) return null;
  return AUTHORITY_LABELS[value] ?? 'Unknown';
}

export function ContextInspector({
  packet,
  onReviewContext,
  label = 'Context used',
}: {
  packet: TrustContextPacket | null | undefined;
  onReviewContext?: () => void;
  label?: string;
}) {
  const instanceId = useId();
  const summaryId = `${instanceId}-summary`;
  const bodyId = `${instanceId}-body`;
  const includedHeadingId = `${instanceId}-included`;
  const excludedHeadingId = `${instanceId}-excluded`;
  const degradedId = `${instanceId}-degraded`;
  const [open, setOpen] = useState(false);

  const exclusions = packet?.exclusions ?? [];
  const visibleExclusions = useMemo(
    () => exclusions.filter((item) => !IDENTITY_WITHHELD_REASONS.has(item.reason)),
    [exclusions],
  );
  const withheldCount =
    (packet?.unauthorizedCount ?? 0) +
    exclusions.filter((item) => IDENTITY_WITHHELD_REASONS.has(item.reason)).length;
  const exclusionCount = visibleExclusions.length + withheldCount;
  const compiledAt = dateLabel(packet?.compiledAt);
  // Fail closed: a packet ID is renderable only when the server explicitly proved
  // persistence. Reloaded/stored packet views set persisted=true; legacy or partial
  // shapes with no persistence evidence must not revive the historical false-ID bug.
  const durablePacketId = packet?.persisted === true ? packet.packetId : null;
  const persistenceDegraded = packet?.persisted === false;
  const degraded = Boolean(packet?.degraded || persistenceDegraded);

  const handleSummaryKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== 'Enter' && event.key !== ' ' && event.key !== 'Spacebar') return;
    event.preventDefault();
    setOpen((current) => !current);
  };

  if (!packet) {
    return (
      <div className="trust-context trust-context--missing" role="status" aria-live="polite">
        <strong>{label}:</strong> details unavailable for this response.
      </div>
    );
  }

  const summaryLabel = [
    label,
    `${packet.items.length} included context item${packet.items.length === 1 ? '' : 's'}`,
    exclusionCount > 0
      ? `${exclusionCount} excluded context item${exclusionCount === 1 ? '' : 's'}`
      : null,
    degraded ? 'Context degraded' : null,
  ]
    .filter(Boolean)
    .join('. ');

  return (
    <details
      className="trust-context"
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
      aria-labelledby={summaryId}
    >
      <summary
        id={summaryId}
        aria-label={summaryLabel}
        aria-controls={bodyId}
        aria-expanded={open}
        onKeyDown={handleSummaryKeyDown}
      >
        <span>{label}</span>
        <span aria-hidden="true">{packet.items.length} included</span>
        {exclusionCount > 0 && <span aria-hidden="true">· {exclusionCount} excluded</span>}
      </summary>

      <div id={bodyId} className="trust-context__body">
        {degraded && (
          <div
            id={degradedId}
            className="trust-context__degraded"
            role="alert"
            aria-live="assertive"
            aria-atomic="true"
          >
            <strong>Context degraded.</strong>{' '}
            {packet.degradedReason ||
              (persistenceDegraded
                ? 'The durable context provenance trace could not be saved.'
                : 'One or more required context sources could not be loaded.')}
          </div>
        )}

        <section aria-labelledby={includedHeadingId}>
          <h4 id={includedHeadingId}>Included</h4>
          {packet.items.length === 0 ? (
            <p>No firm, client, or user context was included.</p>
          ) : (
            <ul>
              {packet.items.map((item) => {
                const scope = scopeLabel(item);
                const authority = authorityLabel(item.authority);
                const asOf = dateLabel(item.asOf);
                const confirmed = dateLabel(item.lastConfirmedAt);
                return (
                  <li key={item.id}>
                    <div className="trust-context__item-heading">
                      <strong>{item.label}</strong>
                      <span>{item.type}</span>
                    </div>
                    <div className="trust-context__meta">
                      {scope && <span>{scope}</span>}
                      {authority && <span>Authority · {authority}</span>}
                      {item.status && (
                        <span>Lifecycle · {STATUS_LABELS[item.status] ?? 'Unknown'}</span>
                      )}
                      {item.selection && (
                        <span>
                          {item.selection === 'explicit'
                            ? 'Selected by user'
                            : 'Retrieved automatically'}
                        </span>
                      )}
                      {asOf && <span>As of · {asOf}</span>}
                      {confirmed && <span>Confirmed · {confirmed}</span>}
                    </div>
                    {item.rationale && <p>{item.rationale}</p>}
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        {exclusionCount > 0 && (
          <section aria-labelledby={excludedHeadingId}>
            <h4 id={excludedHeadingId}>Excluded</h4>
            <ul>
              {visibleExclusions.map((item, index) => (
                <li key={item.id ?? `${item.reason}-${index}`}>
                  <strong>{item.label || item.type || 'Context item'}</strong>
                  <span> · {REASON_LABELS[item.reason] ?? item.reason}</span>
                </li>
              ))}
              {withheldCount > 0 && (
                <li>
                  <strong>
                    {withheldCount} restricted item{withheldCount === 1 ? '' : 's'}
                  </strong>
                  <span> · identity withheld by access controls</span>
                </li>
              )}
            </ul>
          </section>
        )}

        <div className="trust-context__footer">
          {compiledAt && <span>Compiled {compiledAt}</span>}
          {durablePacketId && (
            <span title={durablePacketId}>Packet {durablePacketId.slice(0, 8)}</span>
          )}
          {onReviewContext && (
            <button type="button" onClick={onReviewContext}>
              Review context
            </button>
          )}
        </div>
      </div>
    </details>
  );
}
