import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App } from './App.js';

/**
 * Regression coverage for the os.capiro.ai sign-in layout bug: AuthPage
 * (App.tsx) renders the legacy `.auth-page`/`.auth-shell`/`.auth-logo`/
 * `.auth-clerk-frame` classes, whose only styling lives in theme.css — the
 * LEGACY surface's stylesheet, which main.tsx deliberately never loads on the
 * vNext surface (no-legacy-ui contract). On os.capiro.ai those classes
 * therefore carried no styling at all: the logo rendered at its raw
 * intrinsic size and the page had no centering. AuthPage now branches on
 * `isVNextSurface` and renders a parallel `vnext-auth-*` class set (styled
 * by vnext/app/auth/vnext-auth.css, loaded from main.tsx) instead.
 */

vi.mock('./env.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./env.js')>();
  return { ...actual, isVNextSurface: true };
});

vi.mock('./lib/billing.js', () => ({
  useBillingState: () => ({ isLoading: false, data: { billingEnabled: false } }),
}));

vi.mock('@clerk/clerk-react', () => ({
  SignIn: () => <div data-testid="sign-in-widget">sign-in-widget</div>,
  SignUp: () => <div data-testid="sign-up-widget">sign-up-widget</div>,
  useAuth: () => ({ isLoaded: true, isSignedIn: false }),
}));

function renderApp() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/sign-in']}>
        <App />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('AuthPage on the vNext surface', () => {
  test('renders the vnext-auth-* layout classes, not the legacy (unstyled-on-vNext) ones', async () => {
    const { container } = renderApp();

    await waitFor(() => expect(screen.getByTestId('sign-in-widget')).toBeInTheDocument());

    expect(container.querySelector('.vnext-auth-page')).not.toBeNull();
    expect(container.querySelector('.vnext-auth-shell')).not.toBeNull();
    expect(container.querySelector('.vnext-auth-logo')).not.toBeNull();
    expect(container.querySelector('.vnext-auth-clerk-frame')).not.toBeNull();

    // The legacy classes would have carried no styling at all on this
    // surface (theme.css never loads here) — they must not appear.
    expect(container.querySelector('.auth-page')).toBeNull();
    expect(container.querySelector('.auth-shell')).toBeNull();
    expect(container.querySelector('.auth-logo')).toBeNull();
    expect(container.querySelector('.auth-clerk-frame')).toBeNull();
  });

  test('still renders the Capiro logo and the real Clerk sign-in widget', async () => {
    renderApp();

    await waitFor(() => expect(screen.getByTestId('sign-in-widget')).toBeInTheDocument());
    expect(screen.getByAltText('Capiro')).toBeInTheDocument();
  });
});
