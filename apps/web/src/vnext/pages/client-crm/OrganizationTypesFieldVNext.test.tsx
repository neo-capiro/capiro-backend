import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { GRANTS_GOV_ORGANIZATION_TYPE_GROUPS } from '@capiro/shared';
import { OrganizationTypesField } from './OrganizationTypesFieldVNext.js';

const first = GRANTS_GOV_ORGANIZATION_TYPE_GROUPS[0].options[0];

describe('native organization taxonomy editing', () => {
  it('shows outdated values without changing a saved record on mount', () => {
    const onChange = vi.fn();
    render(
      <OrganizationTypesField value={[first.value, 'Legacy organization']} onChange={onChange} />,
    );
    expect(screen.getByRole('status').textContent).toContain('Legacy organization');
    expect(screen.getByRole('checkbox', { name: first.label })).toBeChecked();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('removes outdated entries only on an explicit cleanup action', () => {
    const onChange = vi.fn();
    render(
      <OrganizationTypesField value={[first.value, 'Legacy organization']} onChange={onChange} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Remove outdated selections' }));
    expect(onChange).toHaveBeenCalledWith([first.value]);
  });

  it('retains Grants.gov identities when editing and clearing selections', () => {
    const onChange = vi.fn();
    const { rerender } = render(<OrganizationTypesField value={[]} onChange={onChange} />);
    fireEvent.click(screen.getByRole('checkbox', { name: first.label }));
    expect(onChange).toHaveBeenLastCalledWith([first.value]);
    rerender(<OrganizationTypesField value={[first.value]} onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: 'Clear organization types' }));
    expect(onChange).toHaveBeenLastCalledWith([]);
  });
});
