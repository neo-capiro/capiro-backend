import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { StrategiesModalShell } from './StrategiesModalShell.js';

afterEach(cleanup);

function renderModal(props: { dirty?: boolean; primaryBusy?: boolean } = {}) {
  return render(
    <MemoryRouter initialEntries={['/upload']}>
      <Routes>
        <Route path="/" element={<div>Context library</div>} />
        <Route path="/upload" element={
          <div data-testid="page-container" style={{ transform: 'translateX(120px)', width: 320 }}>
            <StrategiesModalShell
              eyebrow="Context library"
              title="Upload files"
              primaryLabel="Review information"
              onPrimary={vi.fn()}
              closeTo="/"
              maxWidth={960}
              {...props}
            >
              <label>Client<input aria-label="Client" /></label>
            </StrategiesModalShell>
          </div>
        } />
      </Routes>
    </MemoryRouter>,
  );
}

describe('StrategiesModalShell', () => {
  it('centers a viewport overlay outside narrow or transformed page containers', () => {
    const style = document.createElement('style');
    style.textContent = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), 'modal-shell.css'), 'utf8');
    document.head.appendChild(style);
    try {
      renderModal();
      const dialog = screen.getByRole('dialog', { name: 'Upload files' });
      const overlay = dialog.parentElement!;
      expect(overlay.parentElement).toBe(document.body);
      expect(screen.getByTestId('page-container').contains(dialog)).toBe(false);
      expect(overlay.classList.contains('capiro-vnext-root')).toBe(true);
      expect(overlay.classList.contains('capiro-vnext-uui')).toBe(true);
      const layout = getComputedStyle(overlay);
      expect(layout.position).toBe('fixed');
      expect(layout.inset).toBe('0');
      expect(layout.display).toBe('flex');
      expect(layout.alignItems).toBe('center');
      expect(layout.justifyContent).toBe('center');
      expect(document.activeElement).toBe(dialog);
      expect(document.body.style.overflow).toBe('hidden');
    } finally {
      style.remove();
    }
  });

  it('keeps the unsaved-change guard and closes to the caller after discarding', () => {
    renderModal({ dirty: true });
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.getByRole('alertdialog', { name: 'Discard unsaved changes?' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Keep editing' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    fireEvent.mouseDown(screen.getByRole('dialog').parentElement!);
    fireEvent.click(screen.getByRole('button', { name: 'Discard changes' }));
    expect(screen.getByText('Context library')).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.body.style.overflow).toBe('');
  });

  it('retains keyboard focus wrapping after moving into the portal', () => {
    renderModal();
    const first = screen.getByRole('button', { name: 'Close' });
    const last = screen.getByRole('button', { name: 'Review information' });
    last.focus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(document.activeElement).toBe(first);
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(last);
  });

  it('does not dismiss a running operation through Escape or the backdrop', () => {
    renderModal({ dirty: true, primaryBusy: true });
    fireEvent.keyDown(document, { key: 'Escape' });
    fireEvent.mouseDown(screen.getByRole('dialog').parentElement!);
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });
});
