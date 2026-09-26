/**
 * Module-router branch contract: every tenant gets the same native Program
 * Elements workspace/profile, while the two native static segments remain
 * available during the /me loading transition.
 *
 * All page bodies are stubbed: this file tests only the branch logic.
 */
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { VNextProgramElementsRoutes } from './VNextProgramElementsRoutes.js';

const useMeMock = vi.hoisted(() => vi.fn());
vi.mock('../../../lib/me.js', () => ({ useMe: useMeMock }));

vi.mock('./PeWorkspacePage.js', () => ({
  PeWorkspacePage: () => <div data-testid="native-workspace" />,
}));
vi.mock('./PeMarkupMonitorPage.js', () => ({
  PeMarkupMonitorPage: () => <div data-testid="native-markup-monitor" />,
}));
vi.mock('./PePersonCandidatesPage.js', () => ({
  PePersonCandidatesPage: () => <div data-testid="native-contacts" />,
}));
vi.mock('./PeResearchView.js', () => ({
  PeResearchView: () => <div data-testid="native-research" />,
}));
vi.mock('./profile/index.js', () => ({
  PeProfileVNext: () => <div data-testid="native-profile" />,
}));

const INTERNAL = { isLoading: false, data: { tenant: { slug: 'capiro-internal' } } };
const OTHER_TENANT = { isLoading: false, data: { tenant: { slug: 'acme-federal' } } };
const LOADING = { isLoading: true, data: undefined };

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <VNextProgramElementsRoutes />
    </MemoryRouter>,
  );
}

describe('VNextProgramElementsRoutes — all-tenant parity', () => {
  it('renders the NATIVE workspace for capiro-internal at the root', async () => {
    useMeMock.mockReturnValue(INTERNAL);
    renderAt('/program-elements');
    expect(await screen.findByTestId('native-workspace')).toBeInTheDocument();
  });

  it('renders the native workspace for a non-internal tenant at the root', async () => {
    useMeMock.mockReturnValue(OTHER_TENANT);
    const { container } = renderAt('/program-elements');
    expect(await screen.findByTestId('native-workspace')).toBeInTheDocument();
    expect(container.querySelector('.pe-vnext-root')).not.toBeNull();
  });

  it('renders the native workspace while /me is still loading', async () => {
    useMeMock.mockReturnValue(LOADING);
    renderAt('/program-elements');
    expect(await screen.findByTestId('native-workspace')).toBeInTheDocument();
  });

  it('renders the NATIVE profile (PeProfileVNext) for capiro-internal at :peCode — inside the pe-vnext-root wrapper', async () => {
    useMeMock.mockReturnValue(INTERNAL);
    const { container } = renderAt('/program-elements/0604201A');
    expect(await screen.findByTestId('native-profile')).toBeInTheDocument();
    expect(container.querySelector('.pe-vnext-root')).not.toBeNull();
  });

  it('renders the native profile for a non-internal tenant at :peCode', async () => {
    useMeMock.mockReturnValue(OTHER_TENANT);
    const { container } = renderAt('/program-elements/0604201A');
    expect(await screen.findByTestId('native-profile')).toBeInTheDocument();
    expect(container.querySelector('.pe-vnext-root')).not.toBeNull();
  });

  it('renders the NATIVE mark-up monitor for any tenant (canonical never gated it)', async () => {
    useMeMock.mockReturnValue(OTHER_TENANT);
    renderAt('/program-elements/mark-up-monitor');
    expect(await screen.findByTestId('native-markup-monitor')).toBeInTheDocument();
  });

  it('renders the NATIVE contact review queue for any tenant (canonical never gated it)', async () => {
    useMeMock.mockReturnValue(OTHER_TENANT);
    renderAt('/program-elements/contacts');
    expect(await screen.findByTestId('native-contacts')).toBeInTheDocument();
  });

  it('renders the native defense research surface for every tenant', async () => {
    useMeMock.mockReturnValue(OTHER_TENANT);
    renderAt('/program-elements/research?view=relationships');
    expect(await screen.findByTestId('native-research')).toBeInTheDocument();
  });
});
