import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App } from './App.js';

const harness = vi.hoisted(() => ({
  appShellRender: vi.fn(),
  billingRefetch: vi.fn(),
  meRefetch: vi.fn(),
  signOut: vi.fn(),
  billingState: {} as Record<string, unknown>,
  meState: {} as Record<string, unknown>,
}));

vi.mock('./components/AppShell.js', () => ({
  AppShell: () => {
    harness.appShellRender();
    return <div data-testid="app-shell">app-shell</div>;
  },
}));

vi.mock('./pages/HomePage.js', () => ({
  HomePage: () => <div data-testid="home-page">home</div>,
}));

vi.mock('./components/onboarding/LockoutScreen.js', () => ({
  LockoutScreen: () => <div data-testid="lockout-screen">locked</div>,
}));

vi.mock('./lib/billing.js', () => ({
  useBillingState: () => harness.billingState,
}));

vi.mock('./lib/me.js', () => ({
  useMe: () => harness.meState,
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
    useClerk: () => ({ signOut: harness.signOut }),
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
  beforeEach(() => {
    authState.isLoaded = true;
    authState.isSignedIn = true;
    harness.appShellRender.mockClear();
    harness.billingRefetch.mockReset();
    harness.meRefetch.mockReset();
    harness.signOut.mockReset();
    harness.billingState = {
      isLoading: false,
      isFetching: false,
      data: { billingEnabled: false },
      error: null,
      refetch: harness.billingRefetch,
    };
    harness.meState = {
      isLoading: false,
      isFetching: false,
      data: { tenant: { slug: 'test' } },
      error: null,
      refetch: harness.meRefetch,
    };
  });

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

  test('shows one stable access error immediately when tenant bootstrap returns 403', async () => {
    harness.meState = {
      isLoading: false,
      isFetching: false,
      data: undefined,
      error: { response: { status: 403, data: { message: 'sensitive tenant detail' } } },
      refetch: harness.meRefetch,
    };
    // A slower sibling bootstrap request must not hold the screen on Loading.
    harness.billingState = {
      isLoading: true,
      isFetching: true,
      data: undefined,
      error: null,
      refetch: harness.billingRefetch,
    };

    renderApp(['/legiwatch']);

    expect(
      await screen.findByRole('heading', { name: "We couldn't open your workspace" }),
    ).toBeInTheDocument();
    expect(screen.getAllByRole('alert')).toHaveLength(1);
    expect(screen.getByText(/could not verify access to a Capiro workspace/i)).toBeInTheDocument();
    expect(screen.queryByText(/sensitive tenant detail/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/^Loading$/i)).not.toBeInTheDocument();
    expect(harness.appShellRender).not.toHaveBeenCalled();
  });

  test('stops before the app shell on billing bootstrap 401 and retries both bootstrap reads', async () => {
    harness.billingState = {
      isLoading: false,
      isFetching: false,
      data: undefined,
      error: { response: { status: 401 } },
      refetch: harness.billingRefetch,
    };

    renderApp(['/legiwatch']);

    expect(
      await screen.findByRole('heading', { name: "We couldn't open your workspace" }),
    ).toBeInTheDocument();
    expect(screen.getByText(/sign-in could not be verified/i)).toBeInTheDocument();
    expect(harness.appShellRender).not.toHaveBeenCalled();

    screen.getByRole('button', { name: 'Try again' }).click();
    expect(harness.meRefetch).toHaveBeenCalledTimes(1);
    expect(harness.billingRefetch).toHaveBeenCalledTimes(1);

    screen.getByRole('button', { name: 'Sign out' }).click();
    expect(harness.signOut).toHaveBeenCalledWith({ redirectUrl: '/sign-in' });
  });

  test('preserves fail-open shell behavior for non-auth bootstrap outages', async () => {
    harness.billingState = {
      isLoading: false,
      isFetching: false,
      data: undefined,
      error: { response: { status: 503 } },
      refetch: harness.billingRefetch,
    };

    renderApp(['/legiwatch']);

    await waitFor(() => expect(screen.getByTestId('app-shell')).toBeInTheDocument());
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  test('preserves the definitive billing lockout after bootstrap succeeds', async () => {
    harness.billingState = {
      isLoading: false,
      isFetching: false,
      data: { billingEnabled: true, status: 'active', locked: true },
      error: null,
      refetch: harness.billingRefetch,
    };

    renderApp(['/legiwatch']);

    expect(await screen.findByTestId('lockout-screen')).toBeInTheDocument();
    expect(harness.appShellRender).not.toHaveBeenCalled();
  });
});
