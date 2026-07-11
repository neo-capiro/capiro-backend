import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import { MeriClientScopeSelect } from './MeriClientScopeSelect.js';

describe('MeriClientScopeSelect', () => {
  test('uses an accessible custom listbox and commits a client selection', () => {
    const onChange = vi.fn();
    render(
      <MeriClientScopeSelect
        clients={[
          { id: 'c1', name: 'C2 Strategies' },
          { id: 'c2', name: 'Maven Advocacy Partners' },
        ]}
        value=""
        onChange={onChange}
      />,
    );

    const trigger = screen.getByRole('button', { name: /general/i });
    expect(trigger.tagName).toBe('BUTTON');
    fireEvent.click(trigger);
    expect(screen.getByRole('listbox', { name: /client scope/i })).toBeTruthy();
    fireEvent.click(screen.getByRole('option', { name: 'C2 Strategies' }));
    expect(onChange).toHaveBeenCalledWith('c1');
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  test('Escape closes the menu without changing scope', () => {
    const onChange = vi.fn();
    render(<MeriClientScopeSelect clients={[]} value="" onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: /general/i }));
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });
});
