import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
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

describe('App auth gate wiring', () => {
  test('renders sign-in route and auth shell', async () => {
    authState.isLoaded = true;
    authState.isSignedIn = false;

    render(
      <MemoryRouter initialEntries={['/sign-in']}>
        <App />
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.getByTestId('sign-in-widget')).toBeInTheDocument());
  });

  test('renders signed-in app shell route', async () => {
    authState.isLoaded = true;
    authState.isSignedIn = true;

    render(
      <MemoryRouter initialEntries={['/program-elements/0602785A']}>
        <App />
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.getByTestId('app-shell')).toBeInTheDocument());
  });

  test('renders loading placeholder while auth is unresolved', async () => {
    authState.isLoaded = false;
    authState.isSignedIn = false;

    render(
      <MemoryRouter initialEntries={['/program-elements/0602785A']}>
        <App />
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.getByText(/Loading/i)).toBeInTheDocument());
    await waitFor(() => expect(screen.getByText(/Waiting for Clerk session/i)).toBeInTheDocument());
  });
});
