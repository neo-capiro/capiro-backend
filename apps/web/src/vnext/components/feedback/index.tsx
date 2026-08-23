import type { CSSProperties, ReactNode } from 'react';
import { CapiroButton } from '../actions/index.js';

export type EmptyStateVariant = 'no-data' | 'no-access' | 'first-use' | 'search-empty';

function EmptyStateIllustration({ variant }: { variant: EmptyStateVariant }) {
  return (
    <div className="capiro-feedback__illustration">
      <svg
        width="40"
        height="40"
        viewBox="0 0 40 40"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        {variant === 'no-data' && (
          <>
            <rect x="8" y="12" width="24" height="20" rx="2" />
            <path d="M8 16l8-8 8 8" />
          </>
        )}
        {variant === 'no-access' && (
          <>
            <rect x="10" y="18" width="20" height="14" rx="2" />
            <path d="M14 18v-4a6 6 0 0112 0v4" />
          </>
        )}
        {variant === 'first-use' && (
          <path d="M20 4v4M20 32v4M4 20h4M32 20h4M8.7 8.7l2.8 2.8M28.5 28.5l2.8 2.8M28.5 8.7l-2.8 2.8M8.7 28.5l2.8 2.8" />
        )}
        {variant === 'search-empty' && (
          <>
            <circle cx="18" cy="18" r="10" />
            <path d="M26 26l8 8" />
            <path d="M14 14l8 8M22 14l-8 8" />
          </>
        )}
      </svg>
    </div>
  );
}

export function CapiroEmptyState({
  title,
  description,
  action,
  variant,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
  variant?: EmptyStateVariant;
}) {
  const className = ['capiro-feedback', variant && `capiro-feedback--${variant}`]
    .filter(Boolean)
    .join(' ');
  return (
    <section className={className} aria-label={title}>
      {variant && <EmptyStateIllustration variant={variant} />}
      <strong>{title}</strong>
      {description ? <span>{description}</span> : null}
      {action}
    </section>
  );
}

export function CapiroSkeleton({ width = '100%', height = 16 }: { width?: CSSProperties['width']; height?: number }) {
  return <span className="capiro-skeleton" aria-hidden="true" style={{ width, height }} />;
}

export function CapiroErrorState({
  title = 'Something went wrong',
  description,
  onRetry,
  retryLabel = 'Try again',
}: {
  title?: string;
  description?: string;
  onRetry?: () => void;
  retryLabel?: string;
}) {
  return (
    <section className="capiro-feedback" role="alert">
      <strong>{title}</strong>
      {description ? <span>{description}</span> : null}
      {onRetry ? <CapiroButton size="compact" onClick={onRetry}>{retryLabel}</CapiroButton> : null}
    </section>
  );
}
