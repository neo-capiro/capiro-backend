from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    p = Path(path)
    text = p.read_text(encoding="utf-8")
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"{path}: expected one anchor, found {count}: {old[:120]!r}")
    p.write_text(text.replace(old, new, 1), encoding="utf-8")


# ------------------------------------------------------------ intel-api service
service = "apps/intel-api/src/hearing/hearing-session.service.ts"
replace_once(
    service,
    """  async list(tenantId: string, userId: string) {
    return this.prisma.withTenant(tenantId, (tx) =>
      tx.liveHearingSession.findMany({
        where: {
          tenantId,
          OR: [
            { sourceType: { in: [...PUBLIC_SOURCE_TYPES] } },
            { createdBy: userId },
          ],
        },
        orderBy: { createdAt: 'desc' },
        take: 100,
      }),
    );
  }
""",
    """  /** Legacy bounded array response retained for existing callers. */
  async list(tenantId: string, userId: string) {
    return this.prisma.withTenant(tenantId, (tx) =>
      tx.liveHearingSession.findMany({
        where: {
          tenantId,
          OR: [
            { sourceType: { in: [...PUBLIC_SOURCE_TYPES] } },
            { createdBy: userId },
          ],
        },
        orderBy: { createdAt: 'desc' },
        take: 100,
      }),
    );
  }

  /**
   * Paginated My Sessions history. The old list endpoint silently stopped at
   * 100 rows, so a mature workspace could no longer reach older transcripts.
   * This uses the exact same public-vs-private visibility predicate as list()
   * and returns a truthful total plus an offset cursor for the web's Load More.
   */
  async listPage(
    tenantId: string,
    userId: string,
    opts?: { offset?: number; limit?: number },
  ) {
    const offset = Math.max(0, Math.floor(opts?.offset ?? 0));
    const limit = Math.min(Math.max(Math.floor(opts?.limit ?? 50), 1), 100);
    const where = {
      tenantId,
      OR: [
        { sourceType: { in: [...PUBLIC_SOURCE_TYPES] } },
        { createdBy: userId },
      ],
    };
    const [items, total] = await this.prisma.withTenant(tenantId, (tx) =>
      Promise.all([
        tx.liveHearingSession.findMany({
          where,
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          skip: offset,
          take: limit,
        }),
        tx.liveHearingSession.count({ where }),
      ]),
    );
    const nextOffset = offset + items.length;
    return {
      items,
      total,
      nextOffset: nextOffset < total ? nextOffset : null,
      hasMore: nextOffset < total,
    };
  }
""",
)

# --------------------------------------------------------- intel-api controller
controller = "apps/intel-api/src/hearing/hearing.controller.ts"
replace_once(
    controller,
    """  @Get()
  list(@CurrentTenant() ctx: WorkspaceTenantContext) {
    return this.sessions.list(ctx.tenantId, ctx.clerkUserId);
  }

  @Get(':id')""",
    """  @Get()
  list(@CurrentTenant() ctx: WorkspaceTenantContext) {
    return this.sessions.list(ctx.tenantId, ctx.clerkUserId);
  }

  /** Paginated history for My Sessions; declared before :id so `history` is not treated as an id. */
  @Get('history')
  history(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Query('offset') offset?: string,
    @Query('limit') limit?: string,
  ) {
    return this.sessions.listPage(ctx.tenantId, ctx.clerkUserId, {
      offset: parseNonNegativeInt(offset),
      limit: parsePositiveInt(limit),
    });
  }

  @Get(':id')""",
)

# -------------------------------------------------------------- web API hook
api_file = "apps/web/src/lib/hearing-watch-api.ts"
replace_once(
    api_file,
    """export function useHearingSessions() {
  const api = useApi();
  return useQuery<LiveHearingSession[]>({
    queryKey: ['intel', 'hearings'],
    queryFn: async () => (await api.get<LiveHearingSession[]>('/intel-api/hearings')).data,
    retry: false,
    staleTime: 15_000,
  });
}
""",
    """export interface HearingSessionHistoryPage {
  items: LiveHearingSession[];
  total: number;
  nextOffset: number | null;
  hasMore: boolean;
}

/** Paginated My Sessions history; preserves the legacy /hearings array endpoint for other callers. */
export function useHearingSessionHistory() {
  const api = useApi();
  return useInfiniteQuery<HearingSessionHistoryPage>({
    queryKey: ['intel', 'hearings', 'history'],
    initialPageParam: 0,
    queryFn: async ({ pageParam }) => {
      const offset = Number(pageParam ?? 0);
      return (
        await api.get<HearingSessionHistoryPage>(
          `/intel-api/hearings/history?offset=${offset}&limit=50`,
        )
      ).data;
    },
    getNextPageParam: (last) => (last.hasMore ? last.nextOffset ?? undefined : undefined),
    retry: false,
    staleTime: 15_000,
  });
}
""",
)
replace_once(
    api_file,
    """    onSuccess: () => qc.invalidateQueries({ queryKey: ['intel', 'hearings'] }),""",
    """    onSuccess: () => qc.invalidateQueries({ queryKey: ['intel', 'hearings'] }),""",
)

# --------------------------------------------------------------- Hearing UI
page = "apps/web/src/pages/intelligence/HearingWatchPage.tsx"
replace_once(page, "  useHearingSessions,", "  useHearingSessionHistory,")
replace_once(
    page,
    """function SessionsView() {
  const navigate = useNavigate();
  const sessions = useHearingSessions();

  if (sessions.isLoading) {
    return (
      <div style={{ padding: '48px 0', textAlign: 'center' }}>
        <Spin />
      </div>
    );
  }
  if (!sessions.data || sessions.data.length === 0) {
    return (
      <div className=\"guide\">
        <div className=\"gico\">
          <Ic n=\"audio\" size={20} />
        </div>
        <h4>No sessions yet</h4>
        <p>
          Watch a hearing from the schedule and it becomes a session here — your full transcription
          history.
        </p>
      </div>
    );
  }

  return (
    <div className=\"stack\" style={{ gap: 10, maxWidth: 820 }}>
      <span className=\"hint\">
        <span className=\"hico\">
          <Ic n=\"layers\" size={13} />
        </span>
        Every hearing you’ve watched or transcribed. Recaps saved to a client are filed in that
        client’s <b>Documents</b> and indexed into Meri knowledge.
      </span>
      {sessions.data.map((s) => {
        const live = s.status === 'live';
        return (
          <div
            key={s.id}
            className={'hsession' + (live ? ' live' : '')}
            onClick={() => navigate(`/intelligence/hearing-watch/${s.id}`)}
          >
            <span className=\"sico\">
              <Ic n={live ? 'audio' : 'clock'} size={16} />
            </span>
            <div className=\"st\">
              <div className=\"t1\">{s.title}</div>
              <div className=\"t2\">
                <span>{s.sourceType}</span>
                {s.startedAt ? (
                  <>
                    <span>·</span>
                    <span>started {new Date(s.startedAt).toLocaleDateString()}</span>
                  </>
                ) : null}
              </div>
            </div>
            {live ? (
              <span
                className=\"chip\"
                style={{ background: 'var(--critical)', color: '#fff', border: 'none', fontSize: 10.5 }}
              >
                <span className=\"dot pulse\" style={{ background: '#fff' }} />
                LIVE
              </span>
            ) : (
              <span className=\"chip muted\" style={{ fontSize: 10.5 }}>
                {s.status}
              </span>
            )}
            <Ic n=\"chevR\" size={14} />
          </div>
        );
      })}
    </div>
  );
}""",
    """function SessionsView() {
  const navigate = useNavigate();
  const history = useHearingSessionHistory();
  const sessions = useMemo(
    () => history.data?.pages.flatMap((page) => page.items) ?? [],
    [history.data],
  );
  const total = history.data?.pages[0]?.total ?? sessions.length;

  if (history.isLoading) {
    return (
      <div style={{ padding: '48px 0', textAlign: 'center' }}>
        <Spin />
      </div>
    );
  }
  if (sessions.length === 0) {
    return (
      <div className=\"guide\">
        <div className=\"gico\">
          <Ic n=\"audio\" size={20} />
        </div>
        <h4>No sessions yet</h4>
        <p>
          Watch a hearing from the schedule and it becomes a session here — your full transcription
          history.
        </p>
      </div>
    );
  }

  return (
    <div className=\"stack\" style={{ gap: 10, maxWidth: 820 }}>
      <span className=\"hint\">
        <span className=\"hico\">
          <Ic n=\"layers\" size={13} />
        </span>
        Every hearing you’ve watched or transcribed. Recaps saved to a client are filed in that
        client’s <b>Documents</b> and indexed into Meri knowledge.
      </span>
      {sessions.map((s) => {
        const live = s.status === 'live';
        return (
          <div
            key={s.id}
            className={'hsession' + (live ? ' live' : '')}
            onClick={() => navigate(`/intelligence/hearing-watch/${s.id}`)}
          >
            <span className=\"sico\">
              <Ic n={live ? 'audio' : 'clock'} size={16} />
            </span>
            <div className=\"st\">
              <div className=\"t1\">{s.title}</div>
              <div className=\"t2\">
                <span>{s.sourceType}</span>
                {s.startedAt ? (
                  <>
                    <span>·</span>
                    <span>started {new Date(s.startedAt).toLocaleDateString()}</span>
                  </>
                ) : null}
              </div>
            </div>
            {live ? (
              <span
                className=\"chip\"
                style={{ background: 'var(--critical)', color: '#fff', border: 'none', fontSize: 10.5 }}
              >
                <span className=\"dot pulse\" style={{ background: '#fff' }} />
                LIVE
              </span>
            ) : (
              <span className=\"chip muted\" style={{ fontSize: 10.5 }}>
                {s.status}
              </span>
            )}
            <Ic n=\"chevR\" size={14} />
          </div>
        );
      })}
      <div style={{ textAlign: 'center' }}>
        <div className=\"muted mini\" style={{ marginBottom: history.hasNextPage ? 6 : 0 }}>
          Showing {sessions.length.toLocaleString()} of {total.toLocaleString()} sessions
        </div>
        {history.hasNextPage ? (
          <button
            className=\"btn\"
            disabled={history.isFetchingNextPage}
            onClick={() => void history.fetchNextPage()}
          >
            {history.isFetchingNextPage ? 'Loading…' : 'Load more sessions'}
          </button>
        ) : null}
      </div>
    </div>
  );
}""",
)

# ------------------------------------------------------------- service test
scope_test = "apps/intel-api/src/hearing/hearing-tenant-scoping.spec.ts"
replace_once(
    scope_test,
    """    it('list() scopes to the caller tenantId AND the caller user', async () => {
      const { prisma, withTenant, model } = makeFakePrisma();
      const service = new HearingSessionService(prisma);

      // `list` now takes the clerk user id too: a private meeting/webinar/agency
      // session is creator-visible only, so tenant scoping alone is not enough.
      await service.list('tenant-1', 'user-1');
      expect(withTenant).toHaveBeenCalledWith('tenant-1', expect.any(Function));
      expect(model('liveHearingSession').findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            tenantId: 'tenant-1',
            OR: [{ sourceType: { in: ['hearing', 'markup'] } }, { createdBy: 'user-1' }],
          }),
        }),
      );
    });""",
    """    it('list() scopes to the caller tenantId AND the caller user', async () => {
      const { prisma, withTenant, model } = makeFakePrisma();
      const service = new HearingSessionService(prisma);

      // `list` now takes the clerk user id too: a private meeting/webinar/agency
      // session is creator-visible only, so tenant scoping alone is not enough.
      await service.list('tenant-1', 'user-1');
      expect(withTenant).toHaveBeenCalledWith('tenant-1', expect.any(Function));
      expect(model('liveHearingSession').findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            tenantId: 'tenant-1',
            OR: [{ sourceType: { in: ['hearing', 'markup'] } }, { createdBy: 'user-1' }],
          }),
        }),
      );
    });

    it('listPage() preserves private-session scope and returns a truthful next offset', async () => {
      const { prisma, withTenant, model } = makeFakePrisma();
      model('liveHearingSession').findMany.mockResolvedValue([{ id: 's2' }, { id: 's1' }]);
      model('liveHearingSession').count.mockResolvedValue(5);
      const service = new HearingSessionService(prisma);

      await expect(
        service.listPage('tenant-1', 'user-1', { offset: 2, limit: 2 }),
      ).resolves.toEqual({ items: [{ id: 's2' }, { id: 's1' }], total: 5, nextOffset: 4, hasMore: true });
      expect(withTenant).toHaveBeenCalledWith('tenant-1', expect.any(Function));
      expect(model('liveHearingSession').findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          skip: 2,
          take: 2,
          where: expect.objectContaining({
            tenantId: 'tenant-1',
            OR: [{ sourceType: { in: ['hearing', 'markup'] } }, { createdBy: 'user-1' }],
          }),
        }),
      );
    });""",
)

# --------------------------------------------------------------- web test
web_test = "apps/web/src/pages/intelligence/HearingWatchPage.test.tsx"
replace_once(
    web_test,
    """  test('consent field appears only for a private source type', async () => {""",
    """  test('My Sessions pages past the former 100-row cap', async () => {
    apiGetMock.mockImplementation(async (url: string) => {
      if (url.startsWith('/intel-api/hearings/history')) {
        const second = url.includes('offset=50');
        return {
          data: second
            ? {
                items: [{ id: 's2', title: 'Older session', status: 'ended', sourceType: 'hearing' }],
                total: 51,
                nextOffset: null,
                hasMore: false,
              }
            : {
                items: [{ id: 's1', title: 'Newest session', status: 'ended', sourceType: 'markup' }],
                total: 51,
                nextOffset: 50,
                hasMore: true,
              },
        };
      }
      if (url === '/intel-api/upcoming-hearings') return { data: [] };
      if (url.startsWith('/intel-api/upcoming-hearings/browse')) {
        return { data: { items: [], total: 0 } };
      }
      return { data: [] };
    });

    renderPanel();
    fireEvent.click(await screen.findByText('My Sessions'));

    expect(await screen.findByText('Newest session')).toBeInTheDocument();
    expect(screen.getByText(/Showing 1 of 51 sessions/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Load more sessions/i }));

    expect(await screen.findByText('Older session')).toBeInTheDocument();
    expect(screen.getByText(/Showing 2 of 51 sessions/i)).toBeInTheDocument();
    expect(
      apiGetMock.mock.calls.some((args: unknown[]) =>
        String(args[0]).includes('/intel-api/hearings/history?offset=50&limit=50'),
      ),
    ).toBe(true);
  }, 15000);

  test('consent field appears only for a private source type', async () => {""",
)

# --------------------------------------------------------------- CI floors
ci = ".github/workflows/legiwatch-ci.yml"
replace_once(
    ci,
    'run: node scripts/assert-test-summary.mjs "$GITHUB_WORKSPACE/intel-summary.json" apps/intel-api 38 557',
    'run: node scripts/assert-test-summary.mjs "$GITHUB_WORKSPACE/intel-summary.json" apps/intel-api 38 558',
)
replace_once(
    ci,
    'run: node scripts/assert-test-summary.mjs "$GITHUB_WORKSPACE/web-summary.json" apps/web 100 366',
    'run: node scripts/assert-test-summary.mjs "$GITHUB_WORKSPACE/web-summary.json" apps/web 100 370',
)

print('Applied hearing session history pagination patches')
