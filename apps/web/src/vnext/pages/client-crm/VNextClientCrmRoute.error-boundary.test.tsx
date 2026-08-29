/**
 * The client CRM subtree is wrapped in ClientCrmErrorBoundary so a render throw
 * (or a failed lazy chunk) inside any tab lands on a styled in-module recovery
 * state — not the raw App.tsx Suspense fallback that a fresh deep-link would
 * otherwise stick on. These exercise the REAL exported boundary: a throwing
 * child shows the recovery state and logs; a healthy child renders untouched.
 */
import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { ClientCrmErrorBoundary } from './VNextClientCrmRoute.js';

function ThrowingChild(): ReactNode {
  throw new Error('tab render boom');
}

describe('ClientCrmErrorBoundary', () => {
  it('shows the recovery state instead of propagating when a child throws', () => {
    // Silence React's own error-boundary console noise for this expected throw.
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    render(
      <ClientCrmErrorBoundary>
        <ThrowingChild />
      </ClientCrmErrorBoundary>,
    );
    expect(screen.getByText('This client profile hit an unexpected error')).toBeInTheDocument();
    expect(screen.getByText(/data is intact/)).toBeInTheDocument();
    consoleSpy.mockRestore();
  });

  it('renders children untouched when nothing throws', () => {
    render(
      <ClientCrmErrorBoundary>
        <div>healthy profile</div>
      </ClientCrmErrorBoundary>,
    );
    expect(screen.getByText('healthy profile')).toBeInTheDocument();
    expect(screen.queryByText('This client profile hit an unexpected error')).not.toBeInTheDocument();
  });
});
