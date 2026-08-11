import type { CSSProperties, ReactNode } from 'react';
import { CapiroButton } from '../actions/index.js';

export function CapiroEmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <section className="capiro-feedback" aria-label={title}>
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
}: {
  title?: string;
  description?: string;
  onRetry?: () => void;
}) {
  return (
    <section className="capiro-feedback" role="alert">
      <strong>{title}</strong>
      {description ? <span>{description}</span> : null}
      {onRetry ? <CapiroButton size="compact" onClick={onRetry}>Try again</CapiroButton> : null}
    </section>
  );
}
