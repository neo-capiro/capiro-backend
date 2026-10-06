import { App as AntApp } from 'antd';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { CapiroToastProvider } from '../../vnext/components/feedback/toast.js';
import { useWorkspaceMessage } from './workspace-message.js';

function Feedback() {
  const message = useWorkspaceMessage();
  return <>{(['info', 'success', 'error', 'warning'] as const).map((kind) => (
    <button key={kind} onClick={() => message[kind](`${kind} feedback`)}>{kind}</button>
  ))}</>;
}

describe('Workspace feedback across shells', () => {
  it('supports every Workspace notification without Ant App on vNext', () => {
    render(<CapiroToastProvider><Feedback /></CapiroToastProvider>);
    for (const kind of ['info', 'success', 'error', 'warning']) {
      fireEvent.click(screen.getByRole('button', { name: kind, exact: true }));
      expect(screen.getByText(`${kind} feedback`)).toBeInTheDocument();
    }
    expect(screen.getAllByRole('status')).toHaveLength(2);
    expect(screen.getAllByRole('alert')).toHaveLength(2);
  });

  it('retains legacy Ant feedback without duplicating native notifications', async () => {
    const { container } = render(<CapiroToastProvider><AntApp><Feedback /></AntApp></CapiroToastProvider>);
    fireEvent.click(screen.getByRole('button', { name: 'info', exact: true }));
    expect(await screen.findByText('info feedback')).toBeInTheDocument();
    expect(container.querySelector('.capiro-toast')).toBeNull();
  });
});
