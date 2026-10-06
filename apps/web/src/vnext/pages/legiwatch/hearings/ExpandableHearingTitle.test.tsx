import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ExpandableHearingTitle } from './ExpandableHearingTitle.js';
afterEach(cleanup);
it('retains the entire source title and expands without opening the containing row', () => {
  const navigate = vi.fn();
  const title = 'A very long official hearing title '.repeat(100);
  render(<div onClick={navigate}><ExpandableHearingTitle title={title} /></div>);
  expect(screen.getByText(title.trim()).className).toContain('--clamped');
  fireEvent.click(screen.getByRole('button', { name: 'Show full title' }));
  expect(screen.getByText(title.trim()).className).not.toContain('--clamped');
  expect(navigate).not.toHaveBeenCalled();
  expect(screen.getByRole('button', { name: 'Show less' }).getAttribute('aria-expanded')).toBe('true');
});
