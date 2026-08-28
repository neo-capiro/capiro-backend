import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { VNextMeetingLibrary } from './VNextMeetingLibrary.js';
import type { Meeting } from '../../../pages/engagement/meetings/meetings-types.js';

/**
 * VNextMeetingLibrary — the vNext-only Meeting Library surface (see the
 * phase brief: genuinely new markup on literal navy, reusing only the real
 * useMeetingLibrary/useClientOptions data layer). Mocks meetings-api.js
 * wholesale, same convention MeetingLibraryView.test.tsx already uses for
 * the canonical component's own equivalent tests, since this component only
 * calls those two hooks directly (no shared drawer tree the way
 * VNextMeetingsWorkspace.test.tsx has to work around).
 */

const useMeetingLibraryMock = vi.fn();
const useClientOptionsMock = vi.fn();

vi.mock('../../../pages/engagement/meetings/meetings-api.js', () => ({
  useMeetingLibrary: (...args: unknown[]) => useMeetingLibraryMock(...args),
  useClientOptions: (...args: unknown[]) => useClientOptionsMock(...args),
}));

function lastLibraryQuery() {
  return useMeetingLibraryMock.mock.calls[useMeetingLibraryMock.mock.calls.length - 1]![0] as {
    clientId?: string;
    artifactType?: string;
    visibility?: string;
    from?: string;
    to?: string;
    page: number;
    limit: number;
  };
}

function makeMeeting(overrides: Partial<Meeting> = {}): Meeting {
  return {
    id: 'm-1',
    subject: 'HASC autonomy provision check-in',
    source: 'outlook',
    description: null,
    location: null,
    startsAt: new Date(2026, 7, 18, 10, 0).toISOString(),
    endsAt: new Date(2026, 7, 18, 10, 30).toISOString(),
    organizerEmail: null,
    organizerName: null,
    status: 'confirmed',
    metadata: null,
    isVirtual: false,
    joinLink: null,
    provider: null,
    visibility: 'private',
    sharedAt: null,
    sharedByUserId: null,
    client: { id: 'c-overland', name: 'Overland AI' },
    attendees: [],
    attachments: [],
    preps: [],
    notes: [],
    debriefs: [],
    notesApproved: false,
    meri: null,
    contributors: [],
    sharedBy: null,
    ...overrides,
  };
}

function LocationSpy() {
  const location = useLocation();
  return (
    <div data-testid="location-spy">
      {location.pathname}
      {location.search}
    </div>
  );
}

function renderLibrary(initialEntry = '/engagement/meeting-library') {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <VNextMeetingLibrary />
      <LocationSpy />
    </MemoryRouter>,
  );
}

function locationSearch(): string {
  return screen.getByTestId('location-spy').textContent ?? '';
}

function openMenu() {
  return document.querySelector('.uui-library-dropdown__menu') as HTMLElement;
}

describe('VNextMeetingLibrary', () => {
  beforeEach(() => {
    useMeetingLibraryMock.mockReset();
    useClientOptionsMock.mockReset();
    useClientOptionsMock.mockReturnValue({
      data: [
        { id: 'c-acme', name: 'Acme Corp' },
        { id: 'c-overland', name: 'Overland AI' },
      ],
      isLoading: false,
    });
    useMeetingLibraryMock.mockReturnValue({
      data: { data: [], total: 0, page: 1, limit: 25 },
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    });
  });

  test('describes the library as OWNER-scoped, which is what the query actually does', () => {
    renderLibrary();
    expect(screen.getByText('Meetings')).toBeInTheDocument();
    expect(screen.getByText('Library')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Meeting Library' })).toBeInTheDocument();

    /*
     * `listMeetingLibrary` applies `ownMeetingWhere(ctx.userId)`, i.e.
     * `createdByUserId = me OR connection.createdByUserId = me`. The Library is
     * OWNER-scoped.
     *
     * This subline briefly claimed the opposite ("Tenant-wide ... every approved
     * or saved material in the firm"), on the strength of a handoff document
     * that asserted tenant scoping. That told users an empty result meant "the
     * firm has nothing" when it actually means "you have nothing" - a
     * materially different, and wrong, statement. Neither claim may come back.
     */
    expect(screen.getByText(/Your meetings/i)).toBeInTheDocument();
    expect(screen.getByText(/came from a calendar you connected/i)).toBeInTheDocument();
    expect(screen.queryByText(/tenant-wide/i)).toBeNull();

    // The even older subline claimed the page was "Searchable by client, date,
    // artifact type, and visibility" next to a text box that searched none of
    // those and never reached the server. Also must not come back.
    expect(screen.queryByText(/Searchable by client, date, artifact type/i)).toBeNull();
  });

  test('the Meetings breadcrumb button navigates back to /engagement/meetings', () => {
    renderLibrary();
    fireEvent.click(screen.getByRole('button', { name: 'Meetings' }));
    expect(locationSearch()).toBe('/engagement/meetings');
  });

  describe('the three dropdown filters actually change the real query params', () => {
    test('client dropdown sets clientId and resets the page', () => {
      renderLibrary('/engagement/meeting-library?page=3');
      fireEvent.click(screen.getByRole('button', { name: 'Filter by client' }));
      fireEvent.click(within(openMenu()).getByText('Acme Corp'));

      expect(lastLibraryQuery().clientId).toBe('c-acme');
      expect(lastLibraryQuery().page).toBe(1);
      // The trigger's own label now reflects the real selection instead of
      // silently staying on "All clients".
      expect(screen.getByRole('button', { name: 'Filter by client' })).toHaveTextContent(
        'Acme Corp',
      );
    });

    test('artifact-type dropdown sets artifactType to a real ArtifactKind', () => {
      renderLibrary();
      fireEvent.click(screen.getByRole('button', { name: 'Filter by artifact type' }));
      fireEvent.click(within(openMenu()).getByText('Debrief'));

      expect(lastLibraryQuery().artifactType).toBe('debrief');
      // "All" never reaches the query as a literal value — undefined means
      // "no filter", matching LibraryParams' real optional shape.
      expect(lastLibraryQuery().artifactType).not.toBe('all');
    });

    test('visibility dropdown sets visibility to shared/private and persists it to the URL', () => {
      renderLibrary();
      fireEvent.click(screen.getByRole('button', { name: 'Filter by visibility' }));
      fireEvent.click(within(openMenu()).getByText('Shared'));

      expect(lastLibraryQuery().visibility).toBe('shared');
      expect(locationSearch()).toContain('vis=shared');
    });

    test('picking "All" again for a filter omits it from both the query and the URL', () => {
      renderLibrary('/engagement/meeting-library?vis=shared');
      expect(lastLibraryQuery().visibility).toBe('shared');

      fireEvent.click(screen.getByRole('button', { name: 'Filter by visibility' }));
      fireEvent.click(within(openMenu()).getByText('All'));

      expect(lastLibraryQuery().visibility).toBeUndefined();
      expect(locationSearch()).not.toContain('vis=');
    });
  });

  describe('empty state', () => {
    test('distinguishes "nothing approved matches the filters" from "nothing on this page matches"', () => {
      renderLibrary();
      // No rows from the server at all: the honest statement is about the
      // server-side filters and the tenant scope, not about a search term.
      expect(
        screen.getByText(/No approved or saved materials match these filters/i),
      ).toBeInTheDocument();
      expect(screen.queryByText(/only narrows the rows already loaded/i)).toBeNull();
    });

    test('names the search term, and still says a colleague-owned meeting will not appear', () => {
      renderLibrary();
      fireEvent.change(screen.getByPlaceholderText('Search by meeting or client…'), {
        target: { value: 'zzz-no-such-meeting' },
      });
      // getAllByText, not getByText: the harness's LocationSpy also renders
      // `location.search`, which now carries `q=zzz-no-such-meeting`.
      expect(screen.getAllByText(/zzz-no-such-meeting/).length).toBeGreaterThan(0);
      /*
       * Still owner-scoped, and the empty state has to say so. Without it a user
       * whose colleague owns the meeting concludes the material does not exist.
       *
       * The page-local caveat this replaces ("only narrows the rows already
       * loaded") is gone on purpose: `search` is now a real server parameter, so
       * "no rows" can no longer mean "matches exist, just not on this page".
       */
      expect(screen.getAllByText(/colleague/i).length).toBeGreaterThan(0);
      expect(screen.queryByText(/only narrows the rows already loaded/i)).toBeNull();
    });

    test('does not render the empty state once a row exists', () => {
      useMeetingLibraryMock.mockReturnValue({
        data: { data: [makeMeeting()], total: 1, page: 1, limit: 25 },
        isLoading: false,
        isError: false,
        refetch: vi.fn(),
      });
      renderLibrary();
      expect(
        screen.queryByText('No approved or saved materials match this search.'),
      ).not.toBeInTheDocument();
    });
  });

  describe('Materials cell', () => {
    test('renders a plain-text string derived from the real approved/saved fields, not a badge grid', () => {
      const meeting = makeMeeting({
        preps: [
          {
            id: 'p-1',
            status: 'approved',
            agenda: [],
            talkingPoints: [],
            risks: [],
            followUps: [],
            emailEvidence: [],
            summary: null,
            provider: null,
            model: null,
            sharedAt: null,
            sharedByUserId: null,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
        ],
        notesApproved: true,
        debriefs: [],
      });
      useMeetingLibraryMock.mockReturnValue({
        data: { data: [meeting], total: 1, page: 1, limit: 25 },
        isLoading: false,
        isError: false,
        refetch: vi.fn(),
      });
      const { container } = renderLibrary();

      // A single plain-text node reading "Prep · Notes" — approved prep +
      // notesApproved, in prep/notes/debrief order, NOT the MatBadge 3-pill
      // grid (which would render "Prep"/"Notes"/"Debrief" as three separate
      // elements, each with its own Check/Circle icon).
      const materialsCell = screen.getByText('Prep · Notes');
      expect(materialsCell).toBeInTheDocument();
      expect(materialsCell.className).toContain('uui-library-materials');
      expect(container.querySelectorAll('.uui-library-materials svg')).toHaveLength(0);
    });

    test('a meeting with nothing approved/saved yet renders the plain "—" placeholder', () => {
      const meeting = makeMeeting({ preps: [], notes: [], debriefs: [], notesApproved: false });
      useMeetingLibraryMock.mockReturnValue({
        data: { data: [meeting], total: 1, page: 1, limit: 25 },
        isLoading: false,
        isError: false,
        refetch: vi.fn(),
      });
      renderLibrary();
      expect(screen.getByText('—')).toBeInTheDocument();
    });
  });

  describe('visibility pill', () => {
    test('a shared row gets the navy pill with a dot; a private row gets the gray pill with no dot', () => {
      const shared = makeMeeting({ id: 'shared-1', visibility: 'shared' });
      const priv = makeMeeting({ id: 'private-1', visibility: 'private' });
      useMeetingLibraryMock.mockReturnValue({
        data: { data: [shared, priv], total: 2, page: 1, limit: 25 },
        isLoading: false,
        isError: false,
        refetch: vi.fn(),
      });
      renderLibrary();

      const sharedPill = screen.getByText('Shared');
      expect(sharedPill.className).toContain('eng-pill--navy');
      expect(sharedPill.querySelector('.eng-pill__dot')).not.toBeNull();

      const privatePill = screen.getByText('Private');
      expect(privatePill.className).toContain('eng-pill--gray');
      expect(privatePill.querySelector('.eng-pill__dot')).toBeNull();
    });
  });

  test('clicking a row navigates to Meetings with that meeting selected', () => {
    const meeting = makeMeeting({ id: 'target-meeting' });
    useMeetingLibraryMock.mockReturnValue({
      data: { data: [meeting], total: 1, page: 1, limit: 25 },
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    });
    renderLibrary();

    fireEvent.click(screen.getByText('HASC autonomy provision check-in'));
    expect(locationSearch()).toBe('/engagement/meetings?meeting=target-meeting');
  });

  test('the closing note about cross-user sharing is present', () => {
    renderLibrary();
    expect(
      screen.getByText(
        "A colleague's shared material appears alongside yours; sharing is per artifact and never replaces an existing share.",
      ),
    ).toBeInTheDocument();
  });

  describe('date range', () => {
    test('a from-date reaches the query as a server-side ISO start-of-day and resets the page', () => {
      renderLibrary('/engagement/meeting-library?page=2');
      fireEvent.change(screen.getByLabelText('From'), { target: { value: '2026-08-10' } });

      const query = lastLibraryQuery();
      expect(query.from).toBeTruthy();
      expect(new Date(query.from!).getHours()).toBe(0);
      expect(query.page).toBe(1);
    });

    test('Clear dates removes both bounds from the query and the URL', () => {
      renderLibrary('/engagement/meeting-library?from=2026-08-01&to=2026-08-15');
      expect(lastLibraryQuery().from).toBeTruthy();

      fireEvent.click(screen.getByRole('button', { name: /clear dates/i }));
      expect(lastLibraryQuery().from).toBeUndefined();
      expect(lastLibraryQuery().to).toBeUndefined();
      expect(locationSearch()).not.toContain('from=');
      expect(locationSearch()).not.toContain('to=');
    });
  });

  describe('search', () => {
    test('typing a query persists it to the URL as `q`', () => {
      renderLibrary();
      fireEvent.change(screen.getByPlaceholderText('Search by meeting or client…'), {
        target: { value: 'HASC' },
      });
      expect(locationSearch()).toContain('q=HASC');
    });

    /*
     * `MeetingLibraryQueryDto` now declares a `search` field, and
     * `listMeetingLibrary` AND-s it into the query as an OR over meeting subject
     * and client name.
     *
     * This is the inverse of the test it replaces, which asserted the param was
     * NEVER sent — correct while no server search existed, wrong now that one
     * does.
     */
    test('sends the query to the server as `search`, so it reaches every page', () => {
      renderLibrary();
      fireEvent.change(screen.getByPlaceholderText('Search by meeting or client…'), {
        target: { value: 'HASC' },
      });
      const sent = useMeetingLibraryMock.mock.calls
        .map((call) => call[0] as Record<string, unknown> | undefined)
        .filter((params) => params?.search === 'HASC');
      expect(sent.length).toBeGreaterThan(0);
    });

    test('sends no `search` key at all when the box is empty', () => {
      // `search: ''` would be a distinct react-query key from "absent", so
      // clearing the box would refetch rather than reuse the unfiltered result.
      renderLibrary();
      for (const call of useMeetingLibraryMock.mock.calls) {
        const params = call[0] as Record<string, unknown> | undefined;
        expect(params?.search).toBeUndefined();
      }
    });

    test('does not re-filter server results on the client', () => {
      // The server already applied `search`, and `total` reflects it. A second
      // client-side filter would hide rows the server counted, so page N could
      // render empty while the pager still claimed results existed.
      useMeetingLibraryMock.mockReturnValue({
        data: {
          data: [makeMeeting({ subject: 'Totally unrelated subject' })],
          total: 1,
          page: 1,
          limit: 25,
        },
        isLoading: false,
        isError: false,
        refetch: vi.fn(),
      });
      renderLibrary();
      fireEvent.change(screen.getByPlaceholderText('Search by meeting or client…'), {
        target: { value: 'HASC' },
      });
      // Row survives despite not matching the term locally: the server decides.
      expect(screen.getByText('Totally unrelated subject')).toBeInTheDocument();
    });
  });
});

/*
 * Scope-claim drift guard.
 *
 * The Library's scope is stated in TWO places: this component's own subline, and
 * `subline()` in VNextEngagementRoutes.tsx, which renders above the tabs. They
 * drifted: the component's copy was corrected while the routes copy still said
 * "Every approved or saved material in the firm", so the page displayed an
 * owner-scoped claim and a firm-wide claim simultaneously, and that shipped to
 * production for a full deploy before anyone saw it on screen.
 *
 * A rendering test cannot catch this — the two strings live in different
 * components. So this reads the source of both and asserts neither has
 * reacquired a firm-wide claim.
 */
describe('Library scope claims do not drift between the two sublines', () => {
  const read = (rel: string) =>
    readFileSync(resolve(process.cwd(), 'src/vnext/pages/engagement', rel), 'utf8');

  /*
   * Comments are stripped before matching. Both files explain this bug in prose
   * and quote the old wording, which is the clearest way to document it — so a
   * whole-file match would find the explanation and could never fail.
   *
   * Matching quoted string literals instead was the first attempt and was worse:
   * apostrophes in prose ("component's", "user's") made every comment look like
   * the start of a literal, so the extracted "strings" were comment fragments.
   */
  const codeOnly = (src: string) =>
    src
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/^[^\n]*\/\/[^\n]*$/gm, ' ');

  const FIRM_WIDE_CLAIMS = [
    /in the firm/i,
    /tenant-wide/i,
    /whole firm/i,
    /not only your own/i,
  ];

  it.each([
    ['VNextMeetingLibrary.tsx'],
    ['VNextEngagementRoutes.tsx'],
  ])('%s claims no firm-wide scope', (file) => {
    const code = codeOnly(read(file));
    for (const claim of FIRM_WIDE_CLAIMS) {
      expect(code).not.toMatch(claim);
    }
  });

  it('both files state the owner scope', () => {
    // Not just "absence of the wrong claim" — the right one has to be present,
    // or a future edit could delete the scope statement entirely and pass.
    expect(codeOnly(read('VNextMeetingLibrary.tsx'))).toMatch(/Your meetings/i);
    expect(codeOnly(read('VNextEngagementRoutes.tsx'))).toMatch(/Your meetings/i);
  });
});
