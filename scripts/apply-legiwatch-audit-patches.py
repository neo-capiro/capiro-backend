from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    p = Path(path)
    text = p.read_text(encoding="utf-8")
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"{path}: expected exactly one anchor, found {count}: {old[:100]!r}")
    p.write_text(text.replace(old, new, 1), encoding="utf-8")


# ---------------------------------------------------------------- Radar board
radar = "apps/web/src/pages/radar/RadarPage.tsx"
replace_once(
    radar,
    "import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';",
    "import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';",
)
replace_once(
    radar,
    "type TenantBoard = { columns: Array<{ id: string; label: string; cards: TenantBoardCard[] }> };",
    """type TenantBoard = {
  columns: Array<{ id: string; label: string; cards: TenantBoardCard[] }>;
  nextCursor?: string | null;
  hasMore?: boolean;
  total?: number;
  withheld?: number;
};""",
)
replace_once(
    radar,
    """  const board = useQuery<TenantBoard>({
    queryKey: ['radar-tenant-board'],
    queryFn: async () => (await api.get<TenantBoard>(intelTrackerPaths.board('_all'))).data,
    staleTime: 30_000,
  });

  if (board.isPending) return <PanelLoading />;
  if (board.isError)
    return (
      <div className=\"guide plain\">
        <h4>Couldn’t load the all-clients board</h4>
        <p>Try again in a moment.</p>
      </div>
    );

  const columns = board.data?.columns ?? [];
  const total = columns.reduce((n, c) => n + c.cards.length, 0);
  if (total === 0) {""",
    """  const board = useInfiniteQuery<TenantBoard>({
    queryKey: ['radar-tenant-board'],
    initialPageParam: null as string | null,
    queryFn: async ({ pageParam }) =>
      (
        await api.get<TenantBoard>(
          intelTrackerPaths.board('_all', typeof pageParam === 'string' ? pageParam : undefined),
        )
      ).data,
    getNextPageParam: (lastPage) =>
      lastPage.hasMore && lastPage.nextCursor ? lastPage.nextCursor : undefined,
    staleTime: 30_000,
  });

  // The tenant board is keyset-paginated at the API. The old surface consumed
  // only page 1 (200 rows by default) and silently presented it as the complete
  // all-client portfolio. Merge pages by stage and de-duplicate on the true card
  // identity (client + bill), preserving the server's page/stage order.
  const columns = useMemo(() => {
    const byStage = new Map<string, TenantBoard['columns'][number]>();
    for (const page of board.data?.pages ?? []) {
      for (const column of page.columns) {
        const existing = byStage.get(column.id);
        if (!existing) {
          byStage.set(column.id, { ...column, cards: [...column.cards] });
          continue;
        }
        const seen = new Set(existing.cards.map((card) => `${card.clientId}:${card.billId}`));
        for (const card of column.cards) {
          const key = `${card.clientId}:${card.billId}`;
          if (!seen.has(key)) {
            existing.cards.push(card);
            seen.add(key);
          }
        }
      }
    }
    return [...byStage.values()];
  }, [board.data]);
  const loadedTotal = columns.reduce((n, c) => n + c.cards.length, 0);
  const availableTotal = board.data?.pages[0]?.total ?? loadedTotal;

  if (board.isPending) return <PanelLoading />;
  if (board.isError)
    return (
      <div className=\"guide plain\">
        <h4>Couldn’t load the all-clients board</h4>
        <p>Try again in a moment.</p>
      </div>
    );

  if (loadedTotal === 0) {""",
)
replace_once(
    radar,
    """        })}
      </div>
      <BillDrawer""",
    """        })}
      </div>
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 10 }}>
        <span className=\"muted mini\">
          Showing {loadedTotal.toLocaleString()} of {availableTotal.toLocaleString()} tracked bills
        </span>
        {board.hasNextPage ? (
          <Button
            size=\"small\"
            loading={board.isFetchingNextPage}
            disabled={board.isFetchingNextPage}
            onClick={() => void board.fetchNextPage()}
          >
            Load more tracked bills
          </Button>
        ) : null}
      </div>
      <BillDrawer""",
)

# --------------------------------------------------------------- Radar tests
radar_test = "apps/web/src/pages/radar/RadarPage.test.tsx"
replace_once(
    radar_test,
    """    // L2b all-clients board roll-up: client-labelled cards across the tenant.
    if (url.endsWith('/_all/tracker/board')) {
      return {
        data: {
          columns: [
            { id: 'introduced', label: 'Introduced', cards: [] },
            {
              id: 'committee',
              label: 'In committee',
              cards: [
                {
                  billId: 'hr-1',
                  displayNum: 'H.R. 1',
                  title: 'Test Roll-up Act',
                  passageProbability: 80,
                  unread: false,
                  matchedTags: [],
                  changeChip: null,
                  hearingCount: 0,
                  clientId: 'c1',
                  clientName: 'Acme Aerospace',
                },
              ],
            },
          ],
        },
      };
    }""",
    """    // L2b all-clients board roll-up: client-labelled, keyset-paginated cards.
    if (url.includes('/_all/tracker/board')) {
      const secondPage = url.includes('cursor=page-2');
      return {
        data: secondPage
          ? {
              columns: [
                { id: 'introduced', label: 'Introduced', cards: [] },
                {
                  id: 'committee',
                  label: 'In committee',
                  cards: [
                    {
                      billId: 'hr-2',
                      displayNum: 'H.R. 2',
                      title: 'Second Page Act',
                      passageProbability: 65,
                      unread: false,
                      matchedTags: ['Defense'],
                      changeChip: null,
                      hearingCount: 1,
                      clientId: 'c1',
                      clientName: 'Acme Aerospace',
                    },
                  ],
                },
              ],
              nextCursor: null,
              hasMore: false,
              total: 2,
              withheld: 0,
            }
          : {
              columns: [
                { id: 'introduced', label: 'Introduced', cards: [] },
                {
                  id: 'committee',
                  label: 'In committee',
                  cards: [
                    {
                      billId: 'hr-1',
                      displayNum: 'H.R. 1',
                      title: 'Test Roll-up Act',
                      passageProbability: 80,
                      unread: false,
                      matchedTags: [],
                      changeChip: null,
                      hearingCount: 0,
                      clientId: 'c1',
                      clientName: 'Acme Aerospace',
                    },
                  ],
                },
              ],
              nextCursor: 'page-2',
              hasMore: true,
              total: 2,
              withheld: 1,
            },
      };
    }""",
)
replace_once(
    radar_test,
    """  test('L2b: Bills at all-clients without tracker_v2 falls back to the client-gate', async () => {""",
    """  test('L2b: all-clients Bills loads every keyset page instead of silently stopping at page one', async () => {
    mockApi({ tracker_v2: true });
    renderRadar('/radar?tab=bills');

    await waitFor(() => expect(screen.getByText('H.R. 1')).toBeInTheDocument());
    expect(screen.queryByText('H.R. 2')).not.toBeInTheDocument();
    expect(screen.getByText(/Showing 1 of 2 tracked bills/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Load more tracked bills/i }));

    await waitFor(() => expect(screen.getByText('H.R. 2')).toBeInTheDocument());
    expect(screen.getByText('Second Page Act')).toBeInTheDocument();
    expect(screen.getByText(/Showing 2 of 2 tracked bills/i)).toBeInTheDocument();
    expect(
      apiGetMock.mock.calls.some((args: unknown[]) =>
        String(args[0]).includes('/_all/tracker/board?cursor=page-2'),
      ),
    ).toBe(true);
  });

  test('L2b: Bills at all-clients without tracker_v2 falls back to the client-gate', async () => {""",
)

# -------------------------------------------------------------- Hearing copy
hearing = "apps/web/src/pages/intelligence/HearingWatchPage.tsx"
replace_once(
    hearing,
    """        Every hearing you’ve watched or transcribed. The recaps you save to a client live in that
        client’s profile under <b>Saved</b>.""",
    """        Every hearing you’ve watched or transcribed. Recaps saved to a client are filed in that
        client’s <b>Documents</b> and indexed into Meri knowledge.""",
)
replace_once(
    hearing,
    """          <h4>Hearing Watch is not enabled</h4>
          <p>This workspace doesn’t have Hearing Watch turned on yet.</p>""",
    """          <h4>LegiWatch Hearings is not enabled</h4>
          <p>This workspace doesn’t have the LegiWatch hearing capability turned on yet.</p>""",
)
replace_once(
    hearing,
    """              <AudioOutlined /> Hearing Watch""",
    """              <AudioOutlined /> LegiWatch Hearings""",
)
replace_once(
    hearing,
    """              setProvenance(
                normalized.note ??
                  `via ${normalized.media.provider} — resolves at connect time (not persisted)`,
              );
              message.warning(
                'This source is IP-bound and short-lived; it is not saved. It resolves at connect time (not yet wired) — see the note.',
              );""",
    """              setProvenance(
                `via ${normalized.media.provider} — short-lived source; open it and share that tab’s audio`,
              );
              message.warning(
                'This source is IP-bound and short-lived, so its media URL is not saved. Open the source from the Live Hearing Room and share that tab’s audio.',
              );""",
)
replace_once(
    hearing,
    """              setProvenance(
                r.note ?? `via ${r.media.provider} — resolves at connect time (not persisted)`,
              );
              message.warning(
                'This source is IP-bound and short-lived; it is not saved. It resolves at connect time (not yet wired) — see the note.',
              );""",
    """              setProvenance(
                `via ${r.media.provider} — short-lived source; open it and share that tab’s audio`,
              );
              message.warning(
                'This source is IP-bound and short-lived, so its media URL is not saved. Open the source from the Live Hearing Room and share that tab’s audio.',
              );""",
)

# -------------------------------------------------------------- Hearing test
hearing_test = "apps/web/src/pages/intelligence/HearingWatchPage.test.tsx"
replace_once(
    hearing_test,
    """    // The provenance + \"not saved\" note appears…
    await waitFor(() => expect(screen.getByText(/Source found — not saved/i)).toBeInTheDocument());
    // …but the expiring googlevideo URL is NOT written into the field.
    expect(urlInput.value).not.toContain('googlevideo.com');""",
    """    // The UI explains the real browser-capture fallback; it must not claim
    // a connect-time re-resolver that does not exist.
    await waitFor(() => expect(screen.getByText(/Source found — not saved/i)).toBeInTheDocument());
    expect(screen.getByText(/open it and share that tab’s audio/i)).toBeInTheDocument();
    expect(screen.queryByText(/resolves at connect time/i)).not.toBeInTheDocument();
    // The expiring googlevideo URL is NOT written into the field.
    expect(urlInput.value).not.toContain('googlevideo.com');""",
)

# --------------------------------------------------------------- Plan truth
plan = "docs/plans/legiwatch-v2-plan.md"
replace_once(
    plan,
    """**Remaining follow-ons (documented; NOT rushed — each needs new backend / a restructure and would violate the \"flawless, ships-live\" bar if crammed in):**
1. **L2b — all-clients Bills roll-up** (Gherkin \"All-clients board\" + U1). Today Bills at the all-clients altitude shows a client-gate; the roll-up needs a tenant-wide board endpoint + index in intel-api (mirror the P11 `_all/feed`) + a `global` client-labelled mode in `TrackerSurface`'s bills variant. `getBoard` is per-client with compiled-topics + alert logic, so this is a real backend addition.
2. **L3 hearing refinements** — merge Upcoming+Archive into one segmented toggle; \"watched archive → open saved session\" (needs hearing↔session correlation); per-row \"N watchlist matches\"/\"recap saved\" (needs a session-list API enrichment — `LiveHearingSession` list lacks those fields).
3. **G7 client-profile reorg** into Feed/Bills/Hearings/Saved sub-tabs (the profile LegiWatch tab still renders the tracker toggle; \"Saved\" is already covered by the existing Documents tab per decision #2).""",
    """**Remaining follow-ons (re-measured against current `main` on 2026-07-28):**
1. **L2b — all-clients Bills roll-up is implemented.** The tenant-wide `_all/tracker/board` endpoint and client-labelled board exist. The audit found and fixed a later pagination regression: the web consumed only the first keyset page and silently hid tracked bills beyond it.
2. **L3 hearing refinements are partial.** Upcoming+Archive is now one segmented schedule. Still missing: watched archive → open its correlated saved session, and per-row `N watchlist matches` / recap-saved indicators (the session-list contract does not expose them).
3. **G7 remains intentionally partial.** Client-profile LegiWatch is a compact Board/Recs/Feed/Configure surface. Saved hearing recaps are truthfully filed under the existing Documents tab and indexed into Meri knowledge; there is no source-session metadata on the attachment contract yet, so do not present a fake Saved subview that cannot link back to its hearing.""",
)

print("Applied LegiWatch audit patches")
