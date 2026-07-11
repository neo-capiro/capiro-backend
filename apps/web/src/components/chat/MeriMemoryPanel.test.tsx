import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import { MeriMemoryPanel } from './MeriMemoryPanel.js';

const memory = { id: 'm1', key: 'tone', value: 'Use concise weekly briefs', scope: 'private' };

describe('MeriMemoryPanel', () => {
  test('edits inline and commits with Enter', () => {
    const onSave = vi.fn();
    render(
      <MeriMemoryPanel
        memories={[memory]}
        forgotten={[]}
        expanded
        onExpandedChange={vi.fn()}
        onSave={onSave}
        onForget={vi.fn()}
        onUndo={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    const input = screen.getByRole('textbox', { name: 'Edit memory' });
    fireEvent.change(input, { target: { value: 'Use concise client briefs' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onSave).toHaveBeenCalledWith('m1', 'Use concise client briefs');
  });

  test('renders a reversible forget notification', () => {
    const onUndo = vi.fn();
    render(
      <MeriMemoryPanel
        memories={[]}
        forgotten={[memory]}
        expanded={false}
        onExpandedChange={vi.fn()}
        onSave={vi.fn()}
        onForget={vi.fn()}
        onUndo={onUndo}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(onUndo).toHaveBeenCalledWith('m1');
  });
});
