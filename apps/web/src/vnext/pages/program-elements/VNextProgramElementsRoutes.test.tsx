/**
 * Module-router branch contract: the capiro-internal tenant gate (reproduced
 * from App.tsx's ProgramElementFinderGate/ProgramElementWatchGate, INCLUDING
 * its no-loading-branch semantics), the two native static segments (never
 * tenant-gated), and the sibling swap contract — the canonical profile mounts
 * inside `.pe-vnext-root` while the non-internal fallbacks mount WITHOUT the
 * wrapper (their layout must match the pre-Phase-3 Outlet fallthrough).
 *
 * All five page bodies are stubbed: this file tests only the branch logic.
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
vi.mock('../../../pages/program-element/ProgramElementV2ProfilePage.js', () => ({
  ProgramElementV2ProfilePage: () => <div data-testid="canonical-v2-profile" />,
}));
vi.mock('../../../pages/program-element/ProgramElementFinderPage.js', () => ({
  ProgramElementFinderPage: () => <div data-testid="canonical-finder" />,
}));
vi.mock('../../../pages/program-element/ProgramElementWatchPage.js', () => ({
  ProgramElementWatchPage: () => <div data-testid="canonical-watch" />,
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

describe('VNextProgramElementsRoutes — tenant gate + branch contract', () => {
  it('renders the NATIVE workspace for capiro-internal at the root', async () => {
    useMeMock.mockReturnValue(INTERNAL);
    renderAt('/program-elements');
    expect(await screen.findByTestId('native-workspace')).toBeInTheDocument();
  });

  it('renders the canonical finder for a non-internal tenant at the root — without the pe-vnext-root wrapper', async () => {
    useMeMock.mockReturnValue(OTHER_TENANT);
    const { container } = renderAt('/program-elements');
    expect(await screen.findByTestId('canonical-finder')).toBeInTheDocument();
    expect(screen.queryByTestId('native-workspace')).not.toBeInTheDocument();
    expect(container.querySelector('.pe-vnext-root')).toBeNull();
  });

  it('renders the finder while /me is still loading — canonical gate parity (no loading branch)', async () => {
    useMeMock.mockReturnValue(LOADING);
    renderAt('/program-elements');
    expect(await screen.findByTestId('canonical-finder')).toBeInTheDocument();
  });

  it('renders the canonical v2 profile for capiro-internal at :peCode — inside the pe-vnext-root wrapper', async () => {
    useMeMock.mockReturnValue(INTERNAL);
    const { container } = renderAt('/program-elements/0604201A');
    expect(await screen.findByTestId('canonical-v2-profile')).toBeInTheDocument();
    expect(container.querySelector('.pe-vnext-root')).not.toBeNull();
  });

  it('renders the canonical watch page for a non-internal tenant at :peCode — without the wrapper', async () => {
    useMeMock.mockReturnValue(OTHER_TENANT);
    const { container } = renderAt('/program-elements/0604201A');
    expect(await screen.findByTestId('canonical-watch')).toBeInTheDocument();
    expect(container.querySelector('.pe-vnext-root')).toBeNull();
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
});
