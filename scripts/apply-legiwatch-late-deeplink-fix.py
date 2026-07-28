from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    p = Path(path)
    text = p.read_text(encoding='utf-8')
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f'{path}: expected one anchor, found {count}: {old[:120]!r}')
    p.write_text(text.replace(old, new, 1), encoding='utf-8')


panel = 'apps/web/src/pages/clients/tracker/TrackerFeedPanel.tsx'
replace_once(
    panel,
    """  useEffect(() => {
    if (!focusAlertId) return;
    setWorkFilter('all');
    focusExhaustedRef.current = null;
  }, [focusAlertId]);""",
    """  useEffect(() => {
    if (!focusAlertId) return;
    // The target may not belong to the source filter the analyst was using
    // before an email link arrived in-place. Widen both controls visibly.
    setSource('all');
    setWorkFilter('all');
    focusExhaustedRef.current = null;
  }, [focusAlertId]);""",
)
replace_once(
    panel,
    """  useEffect(() => {
    if (!focusAlertId || !query.data) return;
    if (items.some((item) => item.id === focusAlertId)) {""",
    """  useEffect(() => {
    // When focusAlertId arrives after mount, the widening effect above schedules
    // a new query. Do not declare the target missing from the OLD filtered result
    // during that render; wait until the visible controls and query are both All.
    if (!focusAlertId || !query.data || source !== 'all' || workFilter !== 'all') return;
    if (items.some((item) => item.id === focusAlertId)) {""",
)
replace_once(
    panel,
    """    query.isFetchNextPageError,
    query.isFetchingNextPage,
  ]);""",
    """    query.isFetchNextPageError,
    query.isFetchingNextPage,
    source,
    workFilter,
  ]);""",
)

spec = 'apps/web/src/pages/clients/tracker/TrackerFeedPanel.test.tsx'
replace_once(
    spec,
    """function renderPanel(
  props: { focusAlertId?: string; onFocused?: () => void } = {},
) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <AntApp>
          <TrackerFeedPanel
            clientId=\"c1\"
            clientName=\"Acme Aerospace\"
            focusAlertId={props.focusAlertId}
            onFocused={props.onFocused}
          />
        </AntApp>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}""",
    """function renderPanel(
  props: { focusAlertId?: string; onFocused?: () => void } = {},
) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const tree = (next: { focusAlertId?: string; onFocused?: () => void }) => (
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <AntApp>
          <TrackerFeedPanel
            clientId=\"c1\"
            clientName=\"Acme Aerospace\"
            focusAlertId={next.focusAlertId}
            onFocused={next.onFocused}
          />
        </AntApp>
      </MemoryRouter>
    </QueryClientProvider>
  );
  const view = render(tree(props));
  return { ...view, rerenderPanel: (next: typeof props) => view.rerender(tree(next)) };
}""",
)
replace_once(
    spec,
    """  test('widens to All and keyset-pages until an older focused alert is loaded', async () => {""",
    """  test('waits for the widened query when focus arrives after mount', async () => {
    const onFocused = vi.fn();
    const target = feedItem({ id: 'late-alert', title: 'Late linked regulation', sourceType: 'regulation' });
    apiGetMock.mockImplementation(async (url: string) => {
      if (!url.includes('/feed')) return { data: {} };
      feedUrls.push(url);
      return url.includes('workState=all')
        ? { data: feedPage([target]) }
        : { data: feedPage([feedItem({ id: 'active-alert', title: 'Active queue item' })]) };
    });

    const view = renderPanel();
    expect(await screen.findByText('Active queue item')).toBeInTheDocument();
    view.rerenderPanel({ focusAlertId: 'late-alert', onFocused });

    expect(await screen.findByText('Late linked regulation')).toBeInTheDocument();
    await waitFor(() => expect(onFocused).toHaveBeenCalledTimes(1));
    expect(feedUrls.some((url) => url.includes('source=all') && url.includes('workState=all'))).toBe(true);
  });

  test('widens to All and keyset-pages until an older focused alert is loaded', async () => {""",
)

ci = '.github/workflows/legiwatch-ci.yml'
replace_once(
    ci,
    'run: node scripts/assert-test-summary.mjs "$GITHUB_WORKSPACE/web-summary.json" apps/web 100 371',
    'run: node scripts/assert-test-summary.mjs "$GITHUB_WORKSPACE/web-summary.json" apps/web 100 372',
)

print('Applied late-arriving alert deep-link fix')
