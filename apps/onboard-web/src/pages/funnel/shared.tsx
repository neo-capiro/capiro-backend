import type React from 'react';

/** Inline critical-toned error line used across the funnel screens. */
export function ErrorText({
  children,
  style,
}: {
  children: React.ReactNode;
  style?: React.CSSProperties;
}) {
  return (
    <div
      style={{ fontSize: 11.5, color: 'var(--critical)', lineHeight: 1.5, marginTop: 10, ...style }}
    >
      {children}
    </div>
  );
}

export function errorMessage(err: unknown): string {
  return err instanceof Error && err.message
    ? err.message
    : 'Something went wrong — please try again.';
}
