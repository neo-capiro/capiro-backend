import { useState } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  ReportTargetDirectory,
  directoryTargetDefaults,
  reportClientLabel,
  type DirectoryContactOption,
} from './ReportTargetDirectory.js';
import { EngagementDialog } from '../../../pages/engagement/meetings/EngagementDialog.js';

const getMock = vi.fn();
vi.mock('../../../lib/use-api.js', () => ({ useApi: () => ({ get: getMock }) }));

const ana: DirectoryContactOption = {
  id: 'member-1',
  fullName: 'Ana Smith',
  chamber: 'House',
  district: 'CA-1',
  committees: ['Appropriations'],
  officeLocation: '123 Rayburn HOB',
};
const ben: DirectoryContactOption = {
  id: 'member-2',
  fullName: 'Ben Smith',
  chamber: 'Senate',
  state: 'CA',
  committees: ['Armed Services'],
  officeLocation: '201 Hart SOB',
};
function deferred() {
  let resolve!: (value: { data: { contacts: DirectoryContactOption[] } }) => void;
  const promise = new Promise<{ data: { contacts: DirectoryContactOption[] } }>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function mount() {
  function Picker() {
    const [value, setValue] = useState<DirectoryContactOption | null>(null);
    return (
      <ReportTargetDirectory value={value} onSelect={setValue} onClear={() => setValue(null)} />
    );
  }
  const result = render(<Picker />);
  return { ...result, input: screen.getByRole('combobox') };
}
async function debounce() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(250);
  });
}

describe('ReportTargetDirectory', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    getMock.mockReset();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test('uses officeLocation and never invents a responsible staffer from several contacts', () => {
    expect(
      directoryTargetDefaults({
        ...ana,
        office: 'Ana Smith office (CA-1)',
        staff: [{ fullName: 'One' }, { fullName: 'Two' }],
      } as DirectoryContactOption),
    ).toEqual({
      memberPrincipal: 'Ana Smith',
      committee: 'Appropriations',
      building: '123 Rayburn HOB',
      staffer: '',
    });
    expect(reportClientLabel({ clientId: 'A', clientName: null, scopeKey: 'A' })).toBe('Client A');
    expect(reportClientLabel({ clientId: null, clientName: null, scopeKey: 'all' })).toContain(
      'Unassigned',
    );
  });

  test('visible Directory defaults match the server display-field limits', () => {
    const defaults = directoryTargetDefaults({
      ...ana,
      fullName: 'A'.repeat(260),
      committees: ['C'.repeat(90), 'D'.repeat(90)],
      officeLocation: 'B'.repeat(160),
      staff: [{ fullName: 'S'.repeat(180) }],
    });
    expect(defaults.memberPrincipal).toHaveLength(240);
    expect(defaults.committee).toHaveLength(120);
    expect(defaults.building).toHaveLength(120);
    expect(defaults.staffer).toHaveLength(160);
  });

  test('a response arriving after clearing cannot reopen the menu', async () => {
    const slow = deferred();
    getMock.mockReturnValue(slow.promise);
    const { input } = mount();
    fireEvent.change(input, { target: { value: 'Ana' } });
    await debounce();
    expect(getMock).toHaveBeenCalledTimes(1);
    fireEvent.change(input, { target: { value: '' } });
    await act(async () => slow.resolve({ data: { contacts: [ana] } }));
    expect(input).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('option')).not.toBeInTheDocument();
  });

  test('changing a query invalidates the old request during the next debounce', async () => {
    const slow = deferred();
    getMock.mockReturnValueOnce(slow.promise).mockResolvedValue({ data: { contacts: [ben] } });
    const { input } = mount();
    fireEvent.change(input, { target: { value: 'Ana' } });
    await debounce();
    fireEvent.change(input, { target: { value: 'Ben' } });
    await act(async () => slow.resolve({ data: { contacts: [ana] } }));
    expect(screen.queryByRole('option', { name: /Ana/ })).not.toBeInTheDocument();
    await debounce();
    expect(
      screen.getByRole('option', { name: /Ben Smith · Senate · CA · Armed Services/ }),
    ).toBeInTheDocument();
  });

  test('out-of-order results preserve the latest query', async () => {
    const first = deferred();
    const second = deferred();
    getMock.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const { input } = mount();
    fireEvent.change(input, { target: { value: 'Ana' } });
    await debounce();
    fireEvent.change(input, { target: { value: 'Ben' } });
    await debounce();
    await act(async () => second.resolve({ data: { contacts: [ben] } }));
    await act(async () => first.resolve({ data: { contacts: [ana] } }));
    expect(screen.getByRole('option', { name: /Ben Smith/ })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /Ana Smith/ })).not.toBeInTheDocument();
  });

  test('Escape dismisses pending results and stops the enclosing dialog Escape handler', async () => {
    const slow = deferred();
    getMock.mockReturnValue(slow.promise);
    const { input } = mount();
    const listener = vi.fn();
    document.addEventListener('keydown', listener);
    fireEvent.change(input, { target: { value: 'Ana' } });
    await debounce();
    fireEvent.keyDown(input, { key: 'Escape' });
    await act(async () => slow.resolve({ data: { contacts: [ana] } }));
    expect(listener).not.toHaveBeenCalled();
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    document.removeEventListener('keydown', listener);
  });

  test('keyboard selection disambiguates exact records and does not start another search', async () => {
    getMock.mockResolvedValue({ data: { contacts: [ana, { ...ben, fullName: 'Ana Smith' }] } });
    const { input } = mount();
    fireEvent.change(input, { target: { value: 'Ana' } });
    await debounce();
    expect(screen.getAllByRole('option')).toHaveLength(2);
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(screen.getByRole('option', { name: /Senate/ })).toHaveAttribute('aria-selected', 'true');
    fireEvent.keyDown(input, { key: 'Enter' });
    await debounce();
    expect(input).toHaveValue('Ana Smith');
    expect(input).toHaveAttribute('aria-expanded', 'false');
    expect(getMock).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Clear selection' })).toBeInTheDocument();
  });

  test('the real dialog stays open for the picker Escape and closes on the next Escape', async () => {
    const close = vi.fn();
    const slow = deferred();
    getMock.mockReturnValue(slow.promise);
    render(
      <EngagementDialog open title="Add target" onClose={close}>
        <ReportTargetDirectory value={null} onSelect={vi.fn()} onClear={vi.fn()} />
      </EngagementDialog>,
    );
    const input = screen.getByRole('combobox');
    fireEvent.change(input, { target: { value: 'Ana' } });
    await debounce();
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(close).not.toHaveBeenCalled();
    await act(async () => slow.resolve({ data: { contacts: [ana] } }));
    expect(screen.queryByRole('option')).not.toBeInTheDocument();
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(close).toHaveBeenCalledOnce();
  });

  test('ArrowUp from no active option selects the last exact record', async () => {
    getMock.mockResolvedValue({ data: { contacts: [ana, ben] } });
    const { input } = mount();
    fireEvent.change(input, { target: { value: 'Smith' } });
    await debounce();
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    expect(screen.getByRole('option', { name: /Ben Smith/ })).toHaveAttribute(
      'aria-selected',
      'true',
    );
  });

  test('a failed search provides a retry without silently selecting a person', async () => {
    getMock
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue({ data: { contacts: [ana] } });
    const { input } = mount();
    fireEvent.change(input, { target: { value: 'Ana' } });
    await debounce();
    expect(screen.getByRole('alert')).toHaveTextContent('Directory search failed');
    fireEvent.click(screen.getByRole('button', { name: 'Retry search' }));
    await debounce();
    expect(screen.getByRole('option', { name: /Ana Smith · House · CA-1/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Clear selection' })).not.toBeInTheDocument();
  });
});
