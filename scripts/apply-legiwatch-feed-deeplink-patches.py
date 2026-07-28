from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    p = Path(path)
    text = p.read_text(encoding='utf-8')
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f'{path}: expected one anchor, found {count}: {old[:120]!r}')
    p.write_text(text.replace(old, new, 1), encoding='utf-8')


feed = 'apps/web/src/pages/clients/tracker/TrackerFeedPanel.tsx'
replace_once(
    feed,
    """  const [workFilter, setWorkFilter] = useState('default');
  const [selectedIds, setSelectedIds] = useState<string[]>([]);""",
    """  // An alert email is an explicit request to inspect that alert. Start on
  // All so the user's own dismissed/snoozed work state cannot make a valid
  // deep-link target disappear before the panel has a chance to find it.
  const [workFilter, setWorkFilter] = useState(focusAlertId ? 'all' : 'default');
  const [selectedIds, setSelectedIds] = useState<string[]>([]);""",
)
replace_once(
    feed,
    """  const [tpItem, setTpItem] = useState<FeedItem | null>(null);
  const [tpText, setTpText] = useState('');

  const setReport = useSetReport();""",
    """  const [tpItem, setTpItem] = useState<FeedItem | null>(null);
  const [tpText, setTpText] = useState('');
  const focusPagingRef = useRef(false);
  const focusExhaustedRef = useRef<string | null>(null);

  // A focused alert can arrive after mount when URL state changes in place.
  // Keep the visible work-state control honest about the widened search.
  useEffect(() => {
    if (!focusAlertId) return;
    setWorkFilter('all');
    focusExhaustedRef.current = null;
  }, [focusAlertId]);

  const setReport = useSetReport();""",
)
replace_once(
    feed,
    """  const items = query.data?.pages.flatMap((p) => p.items) ?? [];
  // §4.8 edge case 4: how many loaded alerts predate the re-weight.""",
    """  const items = query.data?.pages.flatMap((p) => p.items) ?? [];

  /**
   * Email links may target an alert older than page one. The old implementation
   * only auto-expanded a target already present in `items`; a valid older link
   * landed on an ordinary feed with no explanation. Walk the existing keyset
   * pages until the target is loaded. TanStack still owns request de-duplication;
   * the ref prevents this effect from scheduling concurrent page advances.
   */
  useEffect(() => {
    if (!focusAlertId || !query.data) return;
    if (items.some((item) => item.id === focusAlertId)) {
      focusExhaustedRef.current = null;
      return;
    }
    if (query.isFetchNextPageError) {
      if (focusExhaustedRef.current !== focusAlertId) {
        focusExhaustedRef.current = focusAlertId;
        message.warning('Could not load the linked alert. The active feed is still available.');
        onFocused?.();
      }
      return;
    }
    if (query.hasNextPage) {
      if (!query.isFetchingNextPage && !focusPagingRef.current) {
        focusPagingRef.current = true;
        void query.fetchNextPage().finally(() => {
          focusPagingRef.current = false;
        });
      }
      return;
    }
    if (focusExhaustedRef.current !== focusAlertId) {
      focusExhaustedRef.current = focusAlertId;
      message.warning('The linked alert is no longer available in this feed.');
      onFocused?.();
    }
  }, [
    focusAlertId,
    items,
    message,
    onFocused,
    query.data,
    query.fetchNextPage,
    query.hasNextPage,
    query.isFetchNextPageError,
    query.isFetchingNextPage,
  ]);

  // §4.8 edge case 4: how many loaded alerts predate the re-weight.""",
)

# --------------------------------------------------------------- feed tests
feed_test = 'apps/web/src/pages/clients/tracker/TrackerFeedPanel.test.tsx'
replace_once(
    feed_test,
    """function feedPage(items: FeedItem[]) {
  return {
    items,
    nextCursor: null,
    hasMore: false,
    counts: { bill: items.length },
    severityCounts: { critical: items.length },
  };
}""",
    """function feedPage(
  items: FeedItem[],
  opts: { nextCursor?: string | null; hasMore?: boolean } = {},
) {
  return {
    items,
    nextCursor: opts.nextCursor ?? null,
    hasMore: opts.hasMore ?? false,
    counts: { bill: items.length },
    severityCounts: { critical: items.length },
  };
}""",
)
replace_once(
    feed_test,
    """function renderPanel() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <AntApp>
          <TrackerFeedPanel clientId=\"c1\" clientName=\"Acme Aerospace\" />
        </AntApp>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}""",
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
)
replace_once(
    feed_test,
    """describe('P1-10 — priority ordering is a control', () => {""",
    """describe('alert email deep links', () => {
  test('widens to All and keyset-pages until an older focused alert is loaded', async () => {
    const onFocused = vi.fn();
    const target = feedItem({
      id: 'older-alert',
      title: 'Older linked alert',
      workState: {
        state: 'dismissed',
        assignedTo: null,
        assignedToName: null,
        snoozedUntil: null,
        note: null,
      },
    });
    apiGetMock.mockImplementation(async (url: string) => {
      if (url.includes('/feed')) {
        feedUrls.push(url);
        if (url.includes('cursor=page-2')) return { data: feedPage([target]) };
        return {
          data: feedPage([feedItem({ id: 'newer-alert', title: 'Newer alert' })], {
            nextCursor: 'page-2',
            hasMore: true,
          }),
        };
      }
      return { data: {} };
    });

    const { container } = renderPanel({ focusAlertId: 'older-alert', onFocused });

    await waitFor(() =>
      expect(feedUrls.some((url) => url.includes('workState=all'))).toBe(true),
    );
    await waitFor(() =>
      expect(feedUrls.some((url) => url.includes('cursor=page-2'))).toBe(true),
    );
    expect(await screen.findByText('Older linked alert')).toBeInTheDocument();
    await waitFor(() => expect(onFocused).toHaveBeenCalledTimes(1));
    expect(container.querySelector('[data-alert-id="older-alert"]')).toHaveClass('open');
  });
});

describe('P1-10 — priority ordering is a control', () => {""",
)

# ------------------------------------------------------------- first-run truth
radar = 'apps/web/src/pages/radar/RadarPage.tsx'
replace_once(
    radar,
    """      title: 'LegiWatch finds matching bills',
      body: 'It scores new legislation against that watchlist and lists the matches. You choose which to track; tracked bills go on a board that shows each one’s current status.',""",
    """      title: 'LegiWatch finds matching policy and funding developments',
      body: 'It scores federal and state legislation, regulations, and Program Element funding changes against the client’s priorities. You choose which bills to track on the board.',""",
)
replace_once(
    radar,
    """      body: 'Bill moves and hearing moments land in one list. From there you can save a recap, draft a memo, or start outreach.',""",
    """      body: 'Bill moves, hearing moments, regulations, and funding changes land in one list. From there you can save a recap, draft a memo, or start outreach.',""",
)
replace_once(
    radar,
    """            It tracks bills and congressional hearings for each of your clients and shows you what
            changed. Here’s the flow, start to finish.""",
    """            It tracks legislation, hearings, regulations, and defense-budget changes for each client
            and shows you what changed. Here’s the flow, start to finish.""",
)

radar_test = 'apps/web/src/pages/radar/RadarPage.test.tsx'
replace_once(
    radar_test,
    """    expect(screen.getByText('What LegiWatch does')).toBeInTheDocument();
    expect(screen.getByText('You set a watchlist for each client')).toBeInTheDocument();""",
    """    expect(screen.getByText('What LegiWatch does')).toBeInTheDocument();
    expect(screen.getByText('You set a watchlist for each client')).toBeInTheDocument();
    expect(screen.getByText(/legislation, hearings, regulations, and defense-budget changes/i)).toBeInTheDocument();""",
)

# --------------------------------------------------------------- CI floor
ci = '.github/workflows/legiwatch-ci.yml'
replace_once(
    ci,
    'run: node scripts/assert-test-summary.mjs "$GITHUB_WORKSPACE/web-summary.json" apps/web 100 370',
    'run: node scripts/assert-test-summary.mjs "$GITHUB_WORKSPACE/web-summary.json" apps/web 100 371',
)

print('Applied feed deep-link and first-run truth patches')
