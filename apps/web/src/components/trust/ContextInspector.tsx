import { useMemo } from 'react';

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
  packetId?: string | null;
  compiledAt?: string | null;
  surface?: string | null;
  clientId?: string | null;
  items: TrustContextItem[];
  exclusions?: TrustContextExclusion[];
  /** A DB-boundary denial may be counted, but its identity must never be exposed. */
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

export function ContextInspector({
  packet,
  onReviewContext,
  label = 'Context used',
}: {
  packet: TrustContextPacket | null | undefined;
  onReviewContext?: () => void;
  label?: string;
}) {
  const exclusions = packet?.exclusions ?? [];
  const visibleExclusions = useMemo(
    () => exclusions.filter((item) => item.reason !== 'unauthorized'),
    [exclusions],
  );
  const withheldCount =
    (packet?.unauthorizedCount ?? 0) + exclusions.filter((item) => item.reason === 'unauthorized').length;
  const compiledAt = dateLabel(packet?.compiledAt);

  if (!packet) {
    return (
      <div className="trust-context trust-context--missing" role="status">
        <strong>{label}:</strong> details unavailable for this response.
      </div>
    );
  }

  return (
    <details className="trust-context">
      <summary>
        <span>{label}</span>
        <span aria-label={`${packet.items.length} included context items`}>
          {packet.items.length} included
        </span>
        {visibleExclusions.length + withheldCount > 0 && (
          <span aria-label={`${visibleExclusions.length + withheldCount} excluded context items`}>
            · {visibleExclusions.length + withheldCount} excluded
          </span>
        )}
      </summary>

      <div className="trust-context__body">
        {packet.degraded && (
          <div className="trust-context__degraded" role="alert">
            <strong>Context degraded.</strong>{' '}
            {packet.degradedReason || 'One or more required context sources could not be loaded.'}
          </div>
        )}

        <section aria-labelledby="trust-context-included">
          <h4 id="trust-context-included">Included</h4>
          {packet.items.length === 0 ? (
            <p>No firm, client, or user context was included.</p>
          ) : (
            <ul>
              {packet.items.map((item) => {
                const scope = scopeLabel(item);
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
                      {item.authority && <span>Authority · {item.authority}</span>}
                      {item.selection && (
                        <span>{item.selection === 'explicit' ? 'Selected by user' : 'Retrieved automatically'}</span>
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

        {(visibleExclusions.length > 0 || withheldCount > 0) && (
          <section aria-labelledby="trust-context-excluded">
            <h4 id="trust-context-excluded">Excluded</h4>
            <ul>
              {visibleExclusions.map((item, index) => (
                <li key={item.id ?? `${item.reason}-${index}`}>
                  <strong>{item.label || item.type || 'Context item'}</strong>
                  <span> · {REASON_LABELS[item.reason] ?? item.reason}</span>
                </li>
              ))}
              {withheldCount > 0 && (
                <li>
                  <strong>{withheldCount} restricted item{withheldCount === 1 ? '' : 's'}</strong>
                  <span> · identity withheld by access controls</span>
                </li>
              )}
            </ul>
          </section>
        )}

        <div className="trust-context__footer">
          {compiledAt && <span>Compiled {compiledAt}</span>}
          {packet.packetId && <span title={packet.packetId}>Packet {packet.packetId.slice(0, 8)}</span>}
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
