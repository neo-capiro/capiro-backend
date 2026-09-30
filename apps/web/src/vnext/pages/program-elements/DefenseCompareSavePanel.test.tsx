import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it, vi, afterEach } from 'vitest';
import { DefenseCompareSavePanel, savedBasisFromMetricKey } from './DefenseCompareSavePanel.js';
import type { DefenseComparisonResponseDto, DefenseSavedComparisonDto } from '@capiro/shared';
const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock('../../../lib/use-api.js', () => ({ useApi: () => api }));
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.resetAllMocks();
  localStorage.clear();
});
const projection: DefenseComparisonResponseDto = {
  projectionVersion: 'defense-comparison-v1',
  subjects: [
    {
      key: 'program_element:0600000A',
      type: 'program_element',
      id: '0600000A',
      label: 'Alpha',
      availability: 'available',
    },
    {
      key: 'program_element:0600001A',
      type: 'program_element',
      id: '0600001A',
      label: 'Beta',
      availability: 'available',
    },
  ],
  metrics: [],
  alignments: [],
  limitations: [],
};
function mount(saved?: DefenseSavedComparisonDto, actor = 'actor-1') {
  const onLoad = vi.fn(),
    onEdit = vi.fn();
  const mounted = render(
    <QueryClientProvider
      client={
        new QueryClient({
          defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
        })
      }
    >
      <DefenseCompareSavePanel
        key={actor}
        authority={[actor, 'org-1', null]}
        comparison={projection}
        saved={saved}
        onLoad={onLoad}
        onEdit={onEdit}
      />
    </QueryClientProvider>,
  );
  return { onLoad, onEdit, ...mounted };
}
describe('Defense Compare saved capture controls', () => {
  it('saves explicitly empty selection without submitting client projection or knownAt', async () => {
    api.get.mockResolvedValue({ data: [] });
    api.post.mockResolvedValue({ data: { comparison: { id: 'saved-1' } } });
    const { onLoad } = mount();
    fireEvent.change(screen.getByLabelText('Comparison name'), {
      target: { value: 'Owned capture' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save new comparison' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(1));
    const body = api.post.mock.calls[0]?.[1];
    expect(body.selection).toEqual({ mode: 'explicit', subjectKeys: [], passageIds: [] });
    expect(body.subjects).toHaveLength(2);
    expect(body).not.toHaveProperty('capturedProjection');
    expect(body).not.toHaveProperty('knownAt');
    expect(body.displayVersion).toBe('defense-compare-display-v1');
    await waitFor(() => expect(onLoad).toHaveBeenCalledWith('saved-1'));
  });
  it('loads a saved capture explicitly and requires edit before version capture', async () => {
    const saved = {
      id: 'saved-1',
      name: 'My capture',
      revision: 1,
      portfolioId: null,
      currentVersion: {
        version: 1,
        capturedAt: '2026-09-28T00:00:00Z',
        selection: { mode: 'explicit', subjectKeys: [], passageIds: [] },
        basisPair: { left: savedBasisFromMetricKey(''), right: savedBasisFromMetricKey('') },
      },
    } as unknown as DefenseSavedComparisonDto;
    api.get.mockResolvedValue({ data: [saved] });
    const { onLoad, onEdit } = mount(saved);
    expect(screen.getByText(/This view shows the saved capture/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Save new comparison' })).toBeNull();
    fireEvent.click(
      screen.getByRole('button', { name: 'Edit subjects and capture a new version' }),
    );
    expect(onEdit).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.getByRole('option', { name: 'My capture' })).toBeTruthy());
    fireEvent.change(screen.getByLabelText('Open saved comparison'), {
      target: { value: 'saved-1' },
    });
    expect(onLoad).toHaveBeenCalledWith('saved-1');
    expect(api.post).not.toHaveBeenCalled();
  });
  it('keeps edition/FY/unit/price distinctions when choosing a basis', () => {
    expect(
      savedBasisFromMetricKey('PB26|2027|request|funding|usd_millions|USD|constant_2026'),
    ).toMatchObject({
      requestEdition: 'PB26',
      fundingFiscalYear: 2027,
      unit: 'usd_millions',
      priceBasis: 'constant_2026',
    });
    expect(
      savedBasisFromMetricKey('PB27|2027|request|quantity|units|USD|unknown-price-basis'),
    ).toMatchObject({
      requestEdition: 'PB27',
      fundingFiscalYear: 2027,
      metric: 'quantity',
      unit: 'units',
      priceBasis: null,
    });
  });
  it('reuses an operation key after a lost response until content changes or save succeeds', async () => {
    api.get.mockResolvedValue({ data: [] });
    api.post
      .mockRejectedValueOnce(new Error('lost response'))
      .mockResolvedValueOnce({ data: { comparison: { id: 'saved-1' } } });
    mount();
    fireEvent.change(screen.getByLabelText('Comparison name'), {
      target: { value: 'Retry same capture' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save new comparison' }));
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Retry original saved operation' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(2));
    expect(api.post.mock.calls[0]?.[1].idempotencyKey).toBe(
      api.post.mock.calls[1]?.[1].idempotencyKey,
    );
  });
  it('persists the original request before POST, survives remount, freezes edits and never autosends recovery', async () => {
    api.get.mockResolvedValue({ data: [] });
    api.post.mockImplementationOnce(async (_url: string, body: any) => {
      const stored = localStorage.getItem(
        'capiro:defense-compare-pending:v1:' + JSON.stringify(['actor-1', 'org-1', null]),
      );
      expect(JSON.parse(stored ?? '{}').input).toEqual(body);
      throw new Error('lost response');
    });
    const first = mount();
    fireEvent.change(screen.getByLabelText('Comparison name'), {
      target: { value: 'Original retained request' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save new comparison' }));
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
    const original = api.post.mock.calls[0]?.[1];
    first.unmount();
    mount();
    expect(api.post).toHaveBeenCalledTimes(1);
    expect((screen.getByLabelText('Comparison name') as HTMLInputElement).disabled).toBe(true);
    expect(
      (screen.getByRole('button', { name: 'Save new comparison' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    api.post.mockResolvedValueOnce({ data: { comparison: { id: 'recovered' } } });
    fireEvent.click(screen.getByRole('button', { name: 'Retry original saved operation' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(2));
    expect(api.post.mock.calls[1]?.[1]).toEqual(original);
    await waitFor(() =>
      expect(
        localStorage.getItem(
          'capiro:defense-compare-pending:v1:' + JSON.stringify(['actor-1', 'org-1', null]),
        ),
      ).toBeNull(),
    );
  });
  it('separates uncertain recovery between actors and keeps the original actor record intact', async () => {
    api.get.mockResolvedValue({ data: [] });
    api.post.mockRejectedValueOnce(new Error('lost response'));
    const first = mount();
    fireEvent.change(screen.getByLabelText('Comparison name'), {
      target: { value: 'Actor one draft' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save new comparison' }));
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
    first.unmount();
    mount(undefined, 'actor-2');
    expect(screen.queryByRole('button', { name: 'Retry original saved operation' })).toBeNull();
    expect((screen.getByLabelText('Comparison name') as HTMLInputElement).value).toBe('');
    expect(
      localStorage.getItem(
        'capiro:defense-compare-pending:v1:' + JSON.stringify(['actor-1', 'org-1', null]),
      ),
    ).not.toBeNull();
    expect(api.post).toHaveBeenCalledTimes(1);
  });
  it('does not load or refetch the former authority after a late successful response', async () => {
    let finish: (value: any) => void = () => {};
    api.get.mockResolvedValue({ data: [] });
    api.post.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const first = mount();
    fireEvent.change(screen.getByLabelText('Comparison name'), {
      target: { value: 'Actor one inflight' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save new comparison' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(1));
    first.unmount();
    const second = mount(undefined, 'actor-2');
    finish({ data: { comparison: { id: 'actor-one-saved' } } });
    await waitFor(() =>
      expect(
        localStorage.getItem(
          'capiro:defense-compare-pending:v1:' + JSON.stringify(['actor-1', 'org-1', null]),
        ),
      ).toBeNull(),
    );
    expect(first.onLoad).not.toHaveBeenCalled();
    expect(second.onLoad).not.toHaveBeenCalled();
    expect((screen.getByLabelText('Comparison name') as HTMLInputElement).value).toBe('');
  });
  it('unlocks a fresh definitive 409 and retains editable intent for a corrected new attempt', async () => {
    api.get.mockResolvedValue({ data: [] });
    api.post
      .mockRejectedValueOnce({ response: { status: 409 } })
      .mockResolvedValueOnce({ data: { comparison: { id: 'corrected' } } });
    mount();
    fireEvent.change(screen.getByLabelText('Comparison name'), {
      target: { value: 'Retained rejected draft' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save new comparison' }));
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toContain('save was rejected'),
    );
    expect((screen.getByLabelText('Comparison name') as HTMLInputElement).disabled).toBe(false);
    expect((screen.getByLabelText('Comparison name') as HTMLInputElement).value).toBe(
      'Retained rejected draft',
    );
    expect(screen.queryByRole('button', { name: 'Retry original saved operation' })).toBeNull();
    fireEvent.change(screen.getByLabelText('Comparison name'), {
      target: { value: 'Corrected editable draft' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save new comparison' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(2));
    expect(api.post.mock.calls[1]?.[1].name).toBe('Corrected editable draft');
    expect(api.post.mock.calls[1]?.[1].idempotencyKey).not.toBe(
      api.post.mock.calls[0]?.[1].idempotencyKey,
    );
  });
  it('keeps the original operation locked after an uncertain response followed by 409', async () => {
    api.get.mockResolvedValue({ data: [] });
    api.post
      .mockRejectedValueOnce(new Error('unknown network outcome'))
      .mockRejectedValueOnce({ response: { status: 409 } });
    mount();
    fireEvent.change(screen.getByLabelText('Comparison name'), {
      target: { value: 'Original uncertain draft' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save new comparison' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('uncertain'));
    fireEvent.click(screen.getByRole('button', { name: 'Retry original saved operation' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Retry original saved operation' })).toBeTruthy(),
    );
    expect((screen.getByLabelText('Comparison name') as HTMLInputElement).disabled).toBe(true);
    expect(api.post.mock.calls[1]?.[1]).toEqual(api.post.mock.calls[0]?.[1]);
    const record = JSON.parse(
      localStorage.getItem(
        'capiro:defense-compare-pending:v1:' + JSON.stringify(['actor-1', 'org-1', null]),
      ) ?? '{}',
    );
    expect(record.uncertain).toBe(true);
    expect(record.rejected).toBe(false);
  });
  it('keeps confirmed success when recovery storage cleanup throws', async () => {
    api.get.mockResolvedValue({ data: [] });
    api.post.mockResolvedValueOnce({ data: { comparison: { id: 'confirmed' } } });
    const remove = vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
      throw new Error('cleanup unavailable');
    });
    const { onLoad } = mount();
    fireEvent.change(screen.getByLabelText('Comparison name'), {
      target: { value: 'Confirmed saved draft' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save new comparison' }));
    await waitFor(() => expect(onLoad).toHaveBeenCalledWith('confirmed'));
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Retry original saved operation' })).toBeNull();
    expect(remove).toHaveBeenCalled();
  });
  it('reloads the current saved revision after a fresh conflict while retaining revised intent', async () => {
    api.get.mockResolvedValue({ data: [] });
    api.post
      .mockRejectedValueOnce({ response: { status: 409 } })
      .mockResolvedValueOnce({ data: { comparison: { id: 'saved-1' } } });
    const basis = savedBasisFromMetricKey(''),
      saved = {
        id: 'saved-1',
        name: 'Current version',
        revision: 1,
        portfolioId: null,
        currentVersion: {
          version: 1,
          capturedAt: '2026-09-28T00:00:00Z',
          selection: { mode: 'explicit', subjectKeys: [], passageIds: [] },
          basisPair: { left: basis, right: basis },
        },
      } as unknown as DefenseSavedComparisonDto;
    const client = new QueryClient({
        defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
      }),
      onLoad = vi.fn();
    const tree = (value?: DefenseSavedComparisonDto) => (
      <QueryClientProvider client={client}>
        <DefenseCompareSavePanel
          authority={['actor-1', 'org-1', null]}
          comparison={projection}
          saved={value}
          onLoad={onLoad}
          onEdit={() => {}}
        />
      </QueryClientProvider>
    );
    const page = render(tree(saved));
    page.rerender(tree());
    fireEvent.change(screen.getByLabelText('Comparison name'), {
      target: { value: 'Retained revised intent' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save new version' }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Reload current saved capture' })).toBeTruthy(),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Reload current saved capture' }));
    expect(onLoad).toHaveBeenCalledWith('saved-1');
    page.rerender(tree({ ...saved, revision: 2 }));
    page.rerender(tree());
    expect((screen.getByLabelText('Comparison name') as HTMLInputElement).value).toBe(
      'Retained revised intent',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Save new version' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(2));
    expect(api.post.mock.calls[1]?.[1].expectedRevision).toBe(2);
  });
});
