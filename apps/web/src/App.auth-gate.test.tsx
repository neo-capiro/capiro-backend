import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App } from './App.js';

vi.mock('./components/AppShell.js', () => ({
  AppShell: () => <div data-testid="app-shell">app-shell</div>,
}));

vi.mock('./pages/HomePage.js', () => ({
  HomePage: () => <div data-testid="home-page">home</div>,
}));

vi.mock('./lib/billing.js', () => ({
  useBillingState: () => ({ isLoading: false, data: { billingEnabled: false } }),
}));

const authState = {
  isLoaded: true,
  isSignedIn: true,
};

vi.mock('@clerk/clerk-react', async () => {
  return {
    SignIn: () => <div data-testid="sign-in-widget">sign-in-widget</div>,
    SignUp: () => <div data-testid="sign-up-widget">sign-up-widget</div>,
    useAuth: () => authState,
  };
});

function renderApp(initialEntries: string[]) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={initialEntries}>
        <App />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('App auth gate wiring', () => {
  test('renders sign-in route and auth shell', async () => {
    authState.isLoaded = true;
    authState.isSignedIn = false;

    renderApp(['/sign-in']);

    await waitFor(() => expect(screen.getByTestId('sign-in-widget')).toBeInTheDocument());
  });

  test('renders signed-in app shell route', async () => {
    authState.isLoaded = true;
    authState.isSignedIn = true;

    renderApp(['/program-elements/0602785A']);

    await waitFor(() => expect(screen.getByTestId('app-shell')).toBeInTheDocument());
  });

  test('renders loading placeholder while auth is unresolved', async () => {
    authState.isLoaded = false;
    authState.isSignedIn = false;

    renderApp(['/program-elements/0602785A']);

    await waitFor(() => expect(screen.getByText(/Loading/i)).toBeInTheDocument());
    await waitFor(() => expect(screen.getByText(/Waiting for Clerk session/i)).toBeInTheDocument());
  });
});
