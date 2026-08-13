/**
 * LegiWatch vNext — the eight system states (§9). One vocabulary, one
 * component family, used by every module. Modules RETAIN their geometry in
 * every state — a panel never collapses, the page never reflows because a
 * source failed.
 *
 * Missing data never equals zero; a failed, stale or unmapped source renders
 * one of these explicit states — never `0`, never a hidden panel.
 */
import type { ReactNode } from 'react';
import { LwPill, LwSkeleton, LwButton } from '../lib/primitives.js';

export type LwStateKind =
  | 'loading'
  | 'partial'
  | 'stale'
  | 'unavailable'
  | 'empty'
  | 'allclear'
  | 'permission'
  | 'recoverable';

/** LOADING — skeleton preserving module geometry. */
export function LwStateLoading({ rows = 3 }: { rows?: number }) {
  return (
    <div className="lw-state" role="status" aria-label="Loading">
      {Array.from({ length: rows }).map((_, i) => (
        <LwSkeleton key={i} height={i === 0 ? 20 : 44} delay={i === 1 ? 2 : i === 2 ? 3 : undefined} />
      ))}
    </div>
  );
}

/** UNAVAILABLE — the source name and the reason. Never an empty result,
 *  never `0 alerts`, never a generic error. */
export function LwStateUnavailable({
  source,
  reason,
  onRetry,
}: {
  source: string;
  reason: string;
  onRetry?: () => void;
}) {
  return (
    <div className="lw-state" role="alert">
      <LwPill tone="error">UNAVAILABLE</LwPill>
      <h3 className="lw-state__title">{source} is unavailable</h3>
      <p className="lw-state__body">{reason}</p>
      {onRetry ? <LwButton onClick={onRetry}>Retry {source}</LwButton> : null}
    </div>
  );
}

/** PARTIAL — some source families resolved, others failed. The available
 *  packets PLUS the named unavailable source and a targeted retry. */
export function LwStatePartial({
  available,
  failed,
  onRetry,
  children,
}: {
  available: number;
  failed: string[];
  onRetry?: () => void;
  children: ReactNode;
}) {
  return (
    <>
      <div className="lw-state" role="status" style={{ padding: '14px 18px' }}>
        <LwPill tone="warning">PARTIAL</LwPill>
        <p className="lw-state__body">
          {available} source {available === 1 ? 'family remains' : 'families remain'} current.{' '}
          {failed.join(', ')} {failed.length === 1 ? 'is' : 'are'} unavailable — showing what resolved.
        </p>
        {onRetry ? <LwButton onClick={onRetry}>Retry {failed.join(', ')}</LwButton> : null}
      </div>
      {children}
    </>
  );
}

/** STALE — last successful read is aging. Actions that depend on freshness
 *  are disabled with the reason. */
export function LwStateStale({
  age,
  onRefresh,
  children,
}: {
  age: string;
  onRefresh?: () => void;
  children?: ReactNode;
}) {
  return (
    <>
      <div className="lw-state" role="status" style={{ padding: '14px 18px' }}>
        <LwPill tone="warning">STALE</LwPill>
        <p className="lw-state__body">
          Showing the last successful read from {age}. Actions that depend on freshness are paused.
        </p>
        {onRefresh ? <LwButton onClick={onRefresh}>Refresh now</LwButton> : null}
      </div>
      {children}
    </>
  );
}

/** EMPTY — filters, not ingestion, produced the result. Source health stays
 *  visible and Reset stays in reach. */
export function LwStateEmpty({ onReset }: { onReset?: () => void }) {
  return (
    <div className="lw-state" role="status">
      <LwPill tone="gray">EMPTY</LwPill>
      <h3 className="lw-state__title">No alerts matched these filters</h3>
      <p className="lw-state__body">
        The current filters produced no rows — ingestion is still running and sources are healthy.
        Loosen a filter or reset to the saved view.
      </p>
      {onReset ? <LwButton onClick={onReset}>Reset filters</LwButton> : null}
    </div>
  );
}

/** ALL CLEAR — genuinely nothing to action. Calm success with source health
 *  and last scan time — visibly different from no data. */
export function LwStateAllClear({ lastScan }: { lastScan?: string }) {
  return (
    <div className="lw-state" role="status">
      <LwPill tone="success">ALL CLEAR</LwPill>
      <h3 className="lw-state__title">Nothing needs action right now</h3>
      <p className="lw-state__body">
        Every source is current and nothing matched the watchlist since the last scan
        {lastScan ? ` (${lastScan})` : ''}. New movement lands here first.
      </p>
    </div>
  );
}

/** PERMISSION — client outside the user's scope. Route preserved; the missing
 *  entitlement is explained; no restricted packet data leaks. */
export function LwStatePermission({ client }: { client?: string }) {
  return (
    <div className="lw-state" role="alert">
      <LwPill tone="warning">NO ACCESS</LwPill>
      <h3 className="lw-state__title">
        {client ? `${client} is outside your scope` : 'This client is outside your scope'}
      </h3>
      <p className="lw-state__body">
        You don't have access to this client's LegiWatch packets. Ask an administrator to grant the
        entitlement — no restricted data is shown here.
      </p>
    </div>
  );
}

/** RECOVERABLE — hearing capture lost its source. Session, transcript, exact
 *  failure reason and recovery options retained. NEVER labelled completed. */
export function LwStateRecoverable({
  reason,
  onResolve,
  onResume,
  onEnd,
}: {
  reason: string;
  onResolve?: () => void;
  onResume?: () => void;
  onEnd?: () => void;
}) {
  return (
    <div className="lw-state" role="alert" style={{ background: 'var(--lw-warn-card)' }}>
      <LwPill tone="warning">RECOVERABLE</LwPill>
      <h3 className="lw-state__title">Capture lost its source</h3>
      <p className="lw-state__body">
        {reason}. The session and its transcript are retained. Resolve the source and resume, or end
        the session — it is not marked completed.
      </p>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
        {onResolve ? <LwButton onClick={onResolve}>Resolve source</LwButton> : null}
        {onResume ? <LwButton variant="primary" onClick={onResume}>Resume</LwButton> : null}
        {onEnd ? <LwButton onClick={onEnd}>End session</LwButton> : null}
      </div>
    </div>
  );
}
