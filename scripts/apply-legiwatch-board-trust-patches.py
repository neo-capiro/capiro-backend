from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    p = Path(path)
    text = p.read_text(encoding="utf-8")
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"{path}: expected one anchor, found {count}: {old[:120]!r}")
    p.write_text(text.replace(old, new, 1), encoding="utf-8")


radar = "apps/web/src/pages/radar/RadarPage.tsx"
replace_once(
    radar,
    """/** One tenant-board card (per-client tracked bill) from `_all/tracker/board`. */
type TenantBoardCard = {
  billId: string;
  displayNum: string;
  title: string | null;
  passageProbability: number;
  unread: boolean;
  matchedTags: string[];
  changeChip: { label: string; changeType: string | null } | null;
  hearingCount?: number;
  clientId: string;
  clientName: string | null;
};
type TenantBoard = {
  columns: Array<{ id: string; label: string; cards: TenantBoardCard[] }>;
  nextCursor?: string | null;
  hasMore?: boolean;
  total?: number;
  withheld?: number;
};""",
    """/** One tenant-board card (per-client tracked bill) from `_all/tracker/board`. */
export type TenantBoardCard = {
  billId: string;
  displayNum: string;
  title: string | null;
  passageProbability: number;
  unread: boolean;
  matchedTags: string[];
  matchedHighPriorityTopics?: string[];
  changeChip: {
    label: string;
    changeType: string | null;
    severity?: string | null;
    tone?: string | null;
  } | null;
  hearingCount?: number;
  clientId: string;
  clientName: string | null;
};
type TenantBoard = {
  columns: Array<{ id: string; label: string; cards: TenantBoardCard[] }>;
  nextCursor?: string | null;
  hasMore?: boolean;
  total?: number;
  withheld?: number;
};

export type TenantBoardFilter = 'all' | 'hifit' | 'hiprob';

/** Keep the global board's labels aligned with the server-owned scoring facts. */
export function tenantBoardCardMatchesFilter(
  card: TenantBoardCard,
  filter: TenantBoardFilter,
): boolean {
  if (filter === 'hifit') return (card.matchedHighPriorityTopics?.length ?? 0) > 0;
  if (filter === 'hiprob') {
    const pct = card.passageProbability > 1 ? card.passageProbability : card.passageProbability * 100;
    return pct >= 70;
  }
  return true;
}

/** Server tone wins; severity is only a compatibility fallback for cached cards. */
export function tenantBoardChangeTone(card: TenantBoardCard): 'critical' | 'notable' | 'info' | 'success' {
  const tone = card.changeChip?.tone;
  if (tone === 'critical' || tone === 'notable' || tone === 'info' || tone === 'success') return tone;
  if (card.changeChip?.severity === 'critical') return 'critical';
  if (card.changeChip?.severity === 'info') return 'info';
  return 'notable';
}""",
)
replace_once(
    radar,
    """  const [filter, setFilter] = useState<'all' | 'hifit' | 'hiprob'>('all');""",
    """  const [filter, setFilter] = useState<TenantBoardFilter>('all');""",
)
replace_once(
    radar,
    """  // GAI-07 adjacent: the API sends passageProbability on the shared 0..1 scale,
  // so a bare `>= 70` never matched (dead filter — masked by a 0-100-scale test
  // mock). Normalize like PassageBar does before comparing.
  const pass = (c: TenantBoardCard) =>
    filter === 'hifit'
      ? c.matchedTags.length > 0
      : filter === 'hiprob'
        ? (c.passageProbability > 1 ? c.passageProbability : c.passageProbability * 100) >= 70
        : true;
""",
    """  const pass = (card: TenantBoardCard) => tenantBoardCardMatchesFilter(card, filter);
""",
)
replace_once(
    radar,
    """          onChange={(v) => setFilter(v as 'all' | 'hifit' | 'hiprob')}""",
    """          onChange={(v) => setFilter(v as TenantBoardFilter)}""",
)
replace_once(
    radar,
    """                          className=\"dot notable\"
                          style={{ width: 7, height: 7 }}
                          title={c.changeChip.label}""",
    """                          className={`dot ${tenantBoardChangeTone(c)}`}
                          style={{ width: 7, height: 7 }}
                          title={c.changeChip.label}""",
)

radar_test = "apps/web/src/pages/radar/RadarPage.test.tsx"
replace_once(
    radar_test,
    """import { RadarPage } from './RadarPage.js';""",
    """import {
  RadarPage,
  tenantBoardCardMatchesFilter,
  tenantBoardChangeTone,
  type TenantBoardCard,
} from './RadarPage.js';""",
)
replace_once(
    radar_test,
    """                      matchedTags: ['Defense'],
                      changeChip: null,""",
    """                      matchedTags: ['Defense'],
                      matchedHighPriorityTopics: ['Defense'],
                      changeChip: null,""",
)
replace_once(
    radar_test,
    """                      matchedTags: [],
                      changeChip: null,""",
    """                      matchedTags: ['General relevance'],
                      matchedHighPriorityTopics: [],
                      changeChip: {
                        label: 'Critical move',
                        changeType: 'bill_failed',
                        severity: 'critical',
                        tone: 'critical',
                      },""",
)
replace_once(
    radar_test,
    """function renderRadar(initialEntry: string) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  render(
    <QueryClientProvider client={queryClient}>
      <AntApp>
        <MemoryRouter initialEntries={[initialEntry]}>
          <Routes>
            <Route path=\"/radar\" element={<RadarPage />} />
          </Routes>
        </MemoryRouter>
      </AntApp>
    </QueryClientProvider>,
  );
}

describe('RadarPage', () => {""",
    """function renderRadar(initialEntry: string) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  render(
    <QueryClientProvider client={queryClient}>
      <AntApp>
        <MemoryRouter initialEntries={[initialEntry]}>
          <Routes>
            <Route path=\"/radar\" element={<RadarPage />} />
          </Routes>
        </MemoryRouter>
      </AntApp>
    </QueryClientProvider>,
  );
}

const tenantCard = (patch: Partial<TenantBoardCard> = {}): TenantBoardCard => ({
  billId: 'hr-1',
  displayNum: 'H.R. 1',
  title: 'Example',
  passageProbability: 0.5,
  unread: false,
  matchedTags: [],
  matchedHighPriorityTopics: [],
  changeChip: null,
  clientId: 'c1',
  clientName: 'Acme',
  ...patch,
});

describe('tenant board trust helpers', () => {
  test('Priority-tag filter requires a high-priority topic, not any matched tag', () => {
    expect(
      tenantBoardCardMatchesFilter(
        tenantCard({ matchedTags: ['General relevance'], matchedHighPriorityTopics: [] }),
        'hifit',
      ),
    ).toBe(false);
    expect(
      tenantBoardCardMatchesFilter(
        tenantCard({ matchedTags: ['Defense'], matchedHighPriorityTopics: ['Defense'] }),
        'hifit',
      ),
    ).toBe(true);
  });

  test('change indicator preserves the server tone with a severity fallback', () => {
    expect(tenantBoardChangeTone(tenantCard({ changeChip: { label: 'Failed', changeType: 'bill_failed', tone: 'critical' } }))).toBe('critical');
    expect(tenantBoardChangeTone(tenantCard({ changeChip: { label: 'Info', changeType: 'bill_action', severity: 'info' } }))).toBe('info');
    expect(tenantBoardChangeTone(tenantCard({ changeChip: { label: 'Unknown', changeType: null } }))).toBe('notable');
  });
});

describe('RadarPage', () => {""",
)
replace_once(
    radar_test,
    """    // Each card is labelled with its client (U4 roll-up).
    expect(screen.getByText('Acme Aerospace')).toBeInTheDocument();
    // It fetches the tenant-wide board, not a per-client one.""",
    """    // Each card is labelled with its client (U4 roll-up).
    expect(screen.getByText('Acme Aerospace')).toBeInTheDocument();
    // The global card must preserve the server's critical tone instead of
    // painting every change as ordinary/notable.
    expect(screen.getByTitle('Critical move')).toHaveClass('critical');
    // It fetches the tenant-wide board, not a per-client one.""",
)

print('Applied tenant-board trust patches')
