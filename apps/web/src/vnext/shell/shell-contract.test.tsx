// Phase 1 shell contract tests. These assert the behaviors the Figma
// interaction contract (`730:2573`) makes normative, plus the Dashboard
// all-client scope rule (`729:2612`) and the explicit Directory route gaps.
import { describe, expect, it } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { useRef } from 'react';
import { ShellOverlayProvider, useShellOverlay } from './overlay-manager.js';
import { CapiroSidebar } from './Sidebar/index.js';
import { isClientContextEnabledForPath } from '../adapters/legacy/useShellClientContext.js';
import { VNEXT_ROUTE_MANIFEST } from '../adapters/routes/routeManifest.js';

function OverlayProbe({ id, label }: { id: 'search' | 'profile'; label: string }) {
  const { isOpen, containerRef, toggle } = useShellOverlay(id);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  return (
    <div ref={containerRef}>
      <button ref={triggerRef} onClick={() => toggle(triggerRef.current)}>
        {label}
      </button>
      {isOpen ? <div role="dialog" aria-label={`${label} panel`} /> : null}
    </div>
  );
}

function renderProbes() {
  return render(
    <ShellOverlayProvider>
      <OverlayProbe id="search" label="Search" />
      <OverlayProbe id="profile" label="Profile" />
    </ShellOverlayProvider>,
  );
}

describe('shell overlay contract', () => {
  it('keeps only one shell overlay open at a time', () => {
    renderProbes();

    fireEvent.click(screen.getByText('Search'));
    expect(screen.getByLabelText('Search panel')).toBeTruthy();

    fireEvent.click(screen.getByText('Profile'));
    expect(screen.getByLabelText('Profile panel')).toBeTruthy();
    expect(screen.queryByLabelText('Search panel')).toBeNull();
  });

  it('closes on Escape without firing a destructive action', () => {
    renderProbes();

    fireEvent.click(screen.getByText('Search'));
    expect(screen.getByLabelText('Search panel')).toBeTruthy();

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByLabelText('Search panel')).toBeNull();
  });

  it('closes on outside pointer-down', () => {
    renderProbes();

    fireEvent.click(screen.getByText('Search'));
    expect(screen.getByLabelText('Search panel')).toBeTruthy();

    fireEvent.pointerDown(document.body);
    expect(screen.queryByLabelText('Search panel')).toBeNull();
  });

  it('returns keyboard focus to the invoking control', async () => {
    renderProbes();
    const trigger = screen.getByText('Search');

    trigger.focus();
    fireEvent.click(trigger);
    fireEvent.keyDown(document, { key: 'Escape' });

    // Focus restoration is deferred to the frame after unmount.
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
    expect(document.activeElement).toBe(trigger);
  });
});

describe('dashboard client-context rule', () => {
  it('disables client context on Dashboard and enables it elsewhere', () => {
    expect(isClientContextEnabledForPath('/')).toBe(false);
    expect(isClientContextEnabledForPath('/clients')).toBe(true);
    expect(isClientContextEnabledForPath('/engagement')).toBe(true);
  });
});

describe('directory navigation gaps', () => {
  it('renders destinations without a canonical route as unavailable, never as links', () => {
    const directory = VNEXT_ROUTE_MANIFEST.find((route) => route.id === 'directory')!;

    render(
      <MemoryRouter>
        <ShellOverlayProvider>
          <CapiroSidebar routes={[directory]} />
        </ShellOverlayProvider>
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole('button', { name: /Directory/ }));
    const menu = screen.getByRole('menu', { name: 'Directory' });

    for (const label of ['Congressional Staff', 'Committee Staff', 'Department of War']) {
      const entry = within(menu).getByText(label).closest('[role="menuitem"]')!;
      expect(entry.getAttribute('aria-disabled')).toBe('true');
      expect(entry.tagName).not.toBe('A');
    }

    expect(within(menu).queryAllByRole('link')).toHaveLength(0);
  });
});
