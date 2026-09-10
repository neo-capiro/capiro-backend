import { fireEvent, render, screen, cleanup } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { useState } from 'react';
import { CapiroModal } from './index.js';
afterEach(cleanup);
test('nested modal Escape closes the top dialog and restores trigger focus', () => {
  function Example() {
    const [outer, setOuter] = useState(true),
      [inner, setInner] = useState(false);
    return (
      <CapiroModal open={outer} title="Outer" onClose={() => setOuter(false)}>
        <button onClick={() => setInner(true)}>Preview</button>
        <CapiroModal open={inner} title="Inner" onClose={() => setInner(false)} width={960}>
          <button>Download</button>
        </CapiroModal>
      </CapiroModal>
    );
  }
  render(<Example />);
  const trigger = screen.getByText('Preview');
  trigger.focus();
  fireEvent.click(trigger);
  expect(screen.getByRole('dialog', { name: 'Inner' }).style.maxWidth).toBe('100%');
  fireEvent.keyDown(document, { key: 'Escape' });
  expect(screen.queryByRole('dialog', { name: 'Inner' })).toBeNull();
  expect(screen.getByRole('dialog', { name: 'Outer' })).toBeTruthy();
  expect(document.activeElement).toBe(trigger);
  fireEvent.keyDown(document, { key: 'Escape' });
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(document.body.style.overflow).toBe('');
});
test('Shift Tab from the dialog stays inside and unmounting nested dialogs releases the scroll lock', () => {
  const close = vi.fn();
  const rendered = render(
    <CapiroModal open title="Outer" onClose={close}>
      <CapiroModal open title="Inner" onClose={close}>
        <button>Last</button>
      </CapiroModal>
    </CapiroModal>,
  );
  screen.getByRole('dialog', { name: 'Inner' }).focus();
  fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
  expect(document.activeElement).toBe(screen.getByText('Last'));
  rendered.unmount();
  expect(document.body.style.overflow).toBe('');
});
