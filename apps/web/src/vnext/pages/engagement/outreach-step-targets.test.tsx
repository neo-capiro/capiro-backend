import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  OUTREACH_BUILDER_STEP_SUBLINES,
  OUTREACH_BUILDER_STEP_TITLES,
} from './outreach-campaign-flow.js';
import { OutreachTargetsStep } from './outreach-step-targets.js';
import type { OutreachV3Command, OutreachV3SessionEnvelope } from '../../../pages/engagement/outreach/v3/contracts.js';

/**
 * The Targets step's two honesty properties, both of which the prototype gets
 * wrong and are therefore the reason most of these tests exist:
 *
 *  - applying a saved audience must really add its members (the prototype only
 *    flips a local flag, 00-GAP §4.6), and "Saved" must be read back off the
 *    campaign rather than off that flag;
 *  - list vs group must drive the campaign's delivery pattern, and a group can
 *    never carry high personalization — `deliveryCommands` refuses that pair.
 */
const { api, directory, audienceRows, created, committees, targetSearch } = vi.hoisted(() => {
  const directory = {
    contacts: [] as unknown[],
    total: 0,
    availableStates: [] as string[],
    availableFilters: { chambers: [] as string[] },
  };
  const audienceRows: { rows: unknown[] } = { rows: [] };
  const created: { row: unknown } = { row: null };
  const committees = {
    list: [] as Array<{ id: string; name: string }>,
    rosters: {} as Record<string, unknown[]>,
  };
  const targetSearch: { candidates: unknown[] } = { candidates: [] };
  const api = {
    get: vi.fn(async (url: string) => {
      if (url.includes('/api/directory/favorites')) return { data: [] };
      if (url.includes('/api/directory/committees') && url.includes('/staff')) {
        const match = /\/committees\/([^/]+)\/staff/.exec(url);
        const committeeId = match ? decodeURIComponent(match[1]!) : '';
        return {
          data: {
            committee: committees.list.find((c) => c.id === committeeId) ?? null,
            staff: committees.rosters[committeeId] ?? [],
            total: (committees.rosters[committeeId] ?? []).length,
            page: 1,
            pageSize: 500,
          },
        };
      }
      if (url.includes('/api/directory/committees')) {
        return { data: { committees: committees.list, total: committees.list.length, page: 1, pageSize: 200 } };
      }
      if (url.includes('/api/directory/contacts')) return { data: directory };
      if (url.includes('/outreach/audiences')) return { data: audienceRows.rows };
      return { data: null };
    }),
    post: vi.fn(async (url: string, _body?: unknown) => {
      if (url.includes('/targets/search')) {
        return {
          data: {
            capability: 'search_targets',
            data: { candidates: targetSearch.candidates, totalConsidered: targetSearch.candidates.length, unsupportedCriteria: [] },
            provenance: [],
          },
        };
      }
      return { data: created.row };
    }),
    delete: vi.fn(async () => ({ data: null })),
  };
  return { api, directory, audienceRows, created, committees, targetSearch };
});

vi.mock('../../../lib/use-api.js', () => ({ useApi: () => api }));

interface TargetOverrides {
  key?: string;
  name?: string;
  title?: string | null;
  organization?: string | null;
  email?: string | null;
  emailStatus?: 'available' | 'missing' | 'invalid';
  source?: string;
}

function target(over: TargetOverrides = {}) {
  return {
    targetKey: over.key ?? 'tk-1',
    locator: { source: over.source ?? 'directory_member', id: over.key ?? 'tk-1' },
    displayName: over.name ?? 'Rep. Jane Smith',
    title: over.title === undefined ? 'Ranking Member · Cyber, IT & Innovation' : over.title,
    organization: over.organization === undefined ? '2245 Rayburn' : over.organization,
    email: over.email === undefined ? 'jane.smith@mail.house.gov' : over.email,
    emailStatus: over.emailStatus ?? (over.email === null ? 'missing' : 'available'),
    clientId: null,
    roleStatus: 'current',
    snapshotHash: 'hash',
    jurisdiction: {
      governmentLevel: 'federal',
      chamber: 'House',
      state: 'CA',
      district: null,
      committees: [],
      issueAreas: [],
    },
  };
}

function session(targets: ReturnType<typeof target>[]): OutreachV3SessionEnvelope {
  return {
    spec: { targeting: { selectedTargetRefs: targets } },
  } as unknown as OutreachV3SessionEnvelope;
}

function renderStep(over: Partial<Parameters<typeof OutreachTargetsStep>[0]> = {}) {
  const applyCommands = vi.fn(async (_commands: OutreachV3Command[]) => undefined);
  const toast = vi.fn();
  const onNext = vi.fn();
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const props = {
    sessionId: 'session-1',
    session: session([]),
    campaignType: 'send_update' as const,
    busy: false,
    applyCommands,
    toast,
    onNext,
    primaryLabel: 'Continue to context',
    selectedClientId: null,
    ...over,
  };
  const result = render(
    <QueryClientProvider client={qc}>
      <OutreachTargetsStep {...props} />
    </QueryClientProvider>,
  );
  return { ...result, applyCommands, toast, onNext };
}

/** Flattens every command from every applyCommands call. */
function commandTypes(applyCommands: ReturnType<typeof vi.fn>): string[] {
  return applyCommands.mock.calls.flatMap((call: unknown[]) =>
    (call[0] as OutreachV3Command[]).map((command) => command.type),
  );
}

describe('OutreachTargetsStep', () => {
  beforeEach(() => {
    directory.contacts = [];
    directory.total = 0;
    audienceRows.rows = [];
    created.row = null;
    committees.list = [];
    committees.rosters = {};
    targetSearch.candidates = [];
    api.get.mockClear();
    api.post.mockClear();
  });

  it('carries the prototype step copy: title, subline, tabs, explainer and the primary label', () => {
    const { onNext } = renderStep();

    // Title and subline are painted by the builder shell from the step machine;
    // this pins the strings the prototype promises for THIS step.
    expect(OUTREACH_BUILDER_STEP_TITLES.targets).toBe(
      'Choose the people and offices to contact',
    );
    expect(OUTREACH_BUILDER_STEP_SUBLINES.targets).toBe(
      'Browsing the Directory is a read. Adding a target stores a locator; Capiro re-resolves the person server-side before any draft or send.',
    );

    expect(screen.getByRole('tab', { name: 'Directory' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: 'State legislators' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Committee staff' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Add manually' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Saved audiences' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Selected · 0' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'New list' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'New group' })).toBeInTheDocument();

    // The two bolded words are separate elements, so the paragraph is matched
    // on its flattened text.
    const explainer = document.querySelector('.ots-explainer');
    expect(explainer?.textContent).toBe(
      'A list sends each member their own 1:1 email. A group sends one shared email to everyone on it. Both are saved to your firm’s contact library and reusable across campaigns.',
    );
    expect(explainer?.querySelectorAll('strong')).toHaveLength(2);

    const primary = screen.getByRole('button', { name: 'Continue to context' });
    fireEvent.click(primary);
    expect(onNext).toHaveBeenCalledTimes(1);
  });

  it('Selected shows the campaign recipients, the held-out pill, and removes one', async () => {
    const { applyCommands } = renderStep({
      session: session([
        target(),
        target({
          key: 'tk-2',
          name: 'Devon Marsh',
          title: 'Legislative Assistant',
          organization: '1032 Longworth',
          email: null,
          source: 'directory_staff',
        }),
      ]),
    });

    fireEvent.click(screen.getByRole('tab', { name: 'Selected · 2' }));
    expect(screen.getByText('2 targets selected')).toBeInTheDocument();
    expect(
      screen.getByText('Ranking Member · Cyber, IT & Innovation · 2245 Rayburn'),
    ).toBeInTheDocument();
    expect(screen.getByText('Member')).toBeInTheDocument();
    expect(screen.getByText('Staffer')).toBeInTheDocument();
    // Only the address-less recipient is marked, and only once.
    expect(screen.getAllByText('No email on file')).toHaveLength(1);

    fireEvent.click(screen.getAllByRole('button', { name: 'Remove' })[0]!);
    await waitFor(() => expect(applyCommands).toHaveBeenCalled());
    const [commands] = applyCommands.mock.calls[0]! as [OutreachV3Command[]];
    expect(commands).toEqual([
      { type: 'REMOVE_TARGET_REFS', schemaVersion: 1, payload: { targetKeys: ['tk-1'] } },
    ]);
  });

  it('Selected renders the empty state with nothing chosen', () => {
    renderStep();
    fireEvent.click(screen.getByRole('tab', { name: 'Selected · 0' }));
    // Plural at zero, singular only at exactly one — the prototype's formula.
    expect(screen.getByText('0 targets selected')).toBeInTheDocument();
    expect(
      screen.getByText('No targets yet. Add members or staffers from the Directory.'),
    ).toBeInTheDocument();
  });

  it('New group opens the amber builder bar with the group copy, and Cancel dismisses it', () => {
    renderStep({ session: session([target()]) });

    fireEvent.click(screen.getByRole('button', { name: 'New group' }));
    expect(screen.getByText('1 member selected')).toBeInTheDocument();
    expect(
      screen.getByText(
        'These recipients will be emailed as a group — one email sent together, not individually.',
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save as group' })).toBeEnabled();

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByText('1 member selected')).not.toBeInTheDocument();
  });

  it('New list saves the emailable recipients and sets one-email-each delivery', async () => {
    created.row = { id: 'aud-new', kind: 'list', name: 'HASC autonomy staff', members: [{}, {}] };
    const { applyCommands, toast } = renderStep({
      session: session([
        target(),
        target({ key: 'tk-2', name: 'Marcus Feld', email: 'marcus@mail.house.gov' }),
        // No address: excluded from the save, and counted in the warning.
        target({ key: 'tk-3', name: 'Rep. Caleb Hart', email: null }),
      ]),
    });

    fireEvent.click(screen.getByRole('button', { name: 'New list' }));
    expect(screen.getByText('3 members selected')).toBeInTheDocument();
    expect(
      screen.getByText('Each recipient gets their own 1:1 email. Nobody sees the rest of the list.'),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Save as list' }));
    expect(
      screen.getByText('1 contact without a usable email address will be left out.'),
    ).toBeInTheDocument();
    expect(
      screen.getByText('Saved to your firm’s contact library and reusable across campaigns.'),
    ).toBeInTheDocument();

    const save = screen.getAllByRole('button', { name: 'Save as list' }).at(-1)!;
    expect(save).toBeDisabled();
    fireEvent.change(screen.getByPlaceholderText('HASC autonomy staff'), {
      target: { value: 'HASC autonomy staff' },
    });
    fireEvent.click(screen.getAllByRole('button', { name: 'Save as list' }).at(-1)!);

    await waitFor(() => expect(api.post).toHaveBeenCalled());
    const [url, rawBody] = api.post.mock.calls[0]!;
    const body = rawBody as Record<string, unknown>;
    expect(url).toBe('/api/engagement/outreach/audiences');
    expect(body.kind).toBe('list');
    expect(body.name).toBe('HASC autonomy staff');
    expect(body.members).toHaveLength(2);

    await waitFor(() => expect(commandTypes(applyCommands)).toContain('SET_DELIVERY_PATTERN'));
    const [commands] = applyCommands.mock.calls[0]! as [OutreachV3Command[]];
    expect(commands).toEqual([
      { type: 'SET_DELIVERY_PATTERN', schemaVersion: 1, payload: { value: 'personalized_separate' } },
      { type: 'SET_PERSONALIZATION', schemaVersion: 1, payload: { value: 'high' } },
    ]);
    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith('List saved · HASC autonomy staff — 2 contacts'),
    );
  });

  it('saving a group sets a shared thread and never high personalization', async () => {
    created.row = { id: 'aud-g', kind: 'group', name: 'HASC Member Offices', members: [{}] };
    const { applyCommands, toast } = renderStep({ session: session([target()]) });

    fireEvent.click(screen.getByRole('button', { name: 'New group' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save as group' }));
    fireEvent.change(screen.getByPlaceholderText('HASC Member Offices'), {
      target: { value: 'HASC Member Offices' },
    });
    fireEvent.click(screen.getAllByRole('button', { name: 'Save as group' }).at(-1)!);

    await waitFor(() => expect(applyCommands).toHaveBeenCalled());
    const [commands] = applyCommands.mock.calls[0]! as [OutreachV3Command[]];
    // Personalization is lowered BEFORE the pattern moves, so no intermediate
    // state is the pair the reducer rejects.
    expect(commands).toEqual([
      { type: 'SET_PERSONALIZATION', schemaVersion: 1, payload: { value: 'light' } },
      { type: 'SET_DELIVERY_PATTERN', schemaVersion: 1, payload: { value: 'shared_thread' } },
    ]);
    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith('Group saved · HASC Member Offices — 1 contact'),
    );
  });

  it('refuses the save when no selected recipient has a usable address', () => {
    renderStep({ session: session([target({ email: null })]) });
    fireEvent.click(screen.getByRole('button', { name: 'New list' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save as list' }));

    expect(
      screen.getByText(
        'None of the selected contacts have a usable email address — add at least one with an email before saving.',
      ),
    ).toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText('HASC autonomy staff'), {
      target: { value: 'Anything' },
    });
    expect(screen.getAllByRole('button', { name: 'Save as list' }).at(-1)!).toBeDisabled();
  });

  it('Saved audiences lists the real library and applying one ADDS its members', async () => {
    audienceRows.rows = [
      {
        id: 'a1',
        kind: 'list',
        name: 'HASC autonomy staff',
        members: [
          { id: 'm1', source: 'congress', sourceRefId: 's1', name: 'Priya Anand', email: 'priya@mail.house.gov', title: 'Legislative Director', office: '2245 Rayburn' },
          { id: 'm2', source: 'congress', sourceRefId: 's2', name: 'Marcus Feld', email: 'marcus@mail.house.gov', title: 'MLA', office: '2245 Rayburn' },
        ],
      },
      { id: 'a2', kind: 'group', name: 'HASC Member Offices', members: [{ id: 'm3', source: 'congress', sourceRefId: 'm1', name: 'Rep. Jane Smith', email: 'jane.smith@mail.house.gov', title: null, office: null }] },
    ];
    const { applyCommands, toast } = renderStep();

    fireEvent.click(screen.getByRole('tab', { name: 'Saved audiences' }));
    await waitFor(() => expect(screen.getByText('HASC autonomy staff')).toBeInTheDocument());
    expect(screen.getByText('2 contacts · 1:1 emails')).toBeInTheDocument();
    expect(screen.getByText('1 contact · one shared email')).toBeInTheDocument();
    expect(screen.getByText('List')).toBeInTheDocument();
    expect(screen.getByText('Group')).toBeInTheDocument();

    fireEvent.click(screen.getAllByRole('button', { name: '+ Add' })[0]!);
    await waitFor(() => expect(applyCommands).toHaveBeenCalled());
    const [commands] = applyCommands.mock.calls[0]! as [OutreachV3Command[]];
    // The prototype's defect is exactly this: it never issues these.
    expect(commands.filter((command) => command.type === 'ADD_TARGET_REFS')).toHaveLength(2);
    expect(commands.at(-2)?.type).toBe('SET_DELIVERY_PATTERN');
    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith('HASC autonomy staff added · 2 contacts'),
    );
  });

  it('reads "Saved" back off the campaign, not off a local flag', async () => {
    audienceRows.rows = [
      {
        id: 'a1',
        kind: 'list',
        name: 'HASC autonomy staff',
        members: [{ id: 'm1', source: 'congress', sourceRefId: 'm1', name: 'Rep. Jane Smith', email: 'Jane.Smith@mail.house.gov', title: null, office: null }],
      },
    ];
    renderStep({ session: session([target()]) });

    fireEvent.click(screen.getByRole('tab', { name: 'Saved audiences' }));
    await waitFor(() => expect(screen.getByText('HASC autonomy staff')).toBeInTheDocument());
    const action = screen.getByRole('button', { name: 'Saved' });
    expect(action).toBeDisabled();
    expect(screen.queryByRole('button', { name: '+ Add' })).not.toBeInTheDocument();
  });

  it('Saved audiences renders an honest empty state', async () => {
    renderStep();
    fireEvent.click(screen.getByRole('tab', { name: 'Saved audiences' }));
    await waitFor(() =>
      expect(
        screen.getByText(
          'No saved lists or groups yet. Choose your recipients, then use New list or New group to save them.',
        ),
      ).toBeInTheDocument(),
    );
  });

  it('Add manually refuses to submit without a name or an audience type, and adds a valid manual target', async () => {
    const { applyCommands } = renderStep();
    fireEvent.click(screen.getByRole('tab', { name: 'Add manually' }));

    // No name yet: the primary action stays disabled, same idiom as every
    // other gated primary button on this step.
    expect(screen.getByRole('button', { name: 'Add target to campaign' })).toBeDisabled();

    fireEvent.change(screen.getByRole('textbox', { name: 'Name' }), {
      target: { value: 'Alex Rivera' },
    });
    // Name alone is not enough — no audience type chosen yet.
    expect(screen.getByRole('button', { name: 'Add target to campaign' })).toBeDisabled();

    fireEvent.change(screen.getByRole('combobox', { name: 'Audience type' }), {
      target: { value: 'client_executive' },
    });
    expect(screen.getByRole('button', { name: 'Add target to campaign' })).toBeEnabled();

    fireEvent.click(screen.getByRole('button', { name: 'Add target to campaign' }));
    await waitFor(() => expect(applyCommands).toHaveBeenCalled());
    const [commands] = applyCommands.mock.calls[0]! as [OutreachV3Command[]];
    expect(commands).toHaveLength(1);
    expect(commands[0]!.type).toBe('ADD_TARGET_REFS');
    const payload = commands[0]!.payload as { refs: Array<Record<string, unknown>> };
    expect(payload.refs[0]).toEqual(
      expect.objectContaining({
        source: 'manual',
        name: 'Alex Rivera',
        audienceType: 'client_executive',
      }),
    );
  });

  it('Add manually rejects a malformed email before submitting', () => {
    renderStep();
    fireEvent.click(screen.getByRole('tab', { name: 'Add manually' }));

    fireEvent.change(screen.getByRole('textbox', { name: 'Name' }), {
      target: { value: 'Alex Rivera' },
    });
    fireEvent.change(screen.getByRole('combobox', { name: 'Audience type' }), {
      target: { value: 'client_executive' },
    });
    fireEvent.change(screen.getByRole('textbox', { name: 'Email' }), {
      target: { value: 'not-an-email' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add target to campaign' }));

    expect(
      screen.getByText('Enter a valid email address or leave the email blank.'),
    ).toBeInTheDocument();
  });

  it('State legislators searches via the search_targets capability and adds a candidate', async () => {
    targetSearch.candidates = [
      {
        recommendationRef: 'orec_abc',
        targetKey: 'state_legislator:sl-1',
        locator: { source: 'state_legislator', id: 'sl-1' },
        displayName: 'Sen. Pat Alvarez',
        title: 'State Senator',
        organization: 'District 12',
        email: 'pat.alvarez@state.gov',
        clientId: null,
        score: 1,
        signals: [],
        roleStatus: 'current',
        emailStatus: 'available',
        jurisdiction: {
          governmentLevel: 'state',
          chamber: 'state_senate',
          state: 'CA',
          district: '12',
          committees: [],
          issueAreas: [],
        },
      },
    ];
    const { applyCommands } = renderStep();
    fireEvent.click(screen.getByRole('tab', { name: 'State legislators' }));

    await waitFor(() => expect(screen.getByText('Sen. Pat Alvarez')).toBeInTheDocument());
    expect(screen.getByText('State Senator · District 12')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '+ Add' }));
    await waitFor(() => expect(applyCommands).toHaveBeenCalled());
    const [commands] = applyCommands.mock.calls[0]! as [OutreachV3Command[]];
    expect(commands).toEqual([
      {
        type: 'ADD_TARGET_REFS',
        schemaVersion: 1,
        payload: { refs: [{ source: 'state_legislator', id: 'sl-1' }] },
      },
    ]);

    expect(api.post).toHaveBeenCalledWith(
      expect.stringContaining('/targets/search'),
      expect.objectContaining({ sources: ['state_legislator'] }),
    );
  });

  it('State legislators renders an honest empty state when nothing matches', async () => {
    renderStep();
    fireEvent.click(screen.getByRole('tab', { name: 'State legislators' }));
    await waitFor(() =>
      expect(
        screen.getByText('No matching state legislators. Try a different search.'),
      ).toBeInTheDocument(),
    );
  });

  it('Committee staff lists the selected committee\'s roster and adds a staffer', async () => {
    committees.list = [{ id: 'committee-118', name: 'Committee on Armed Services' }];
    committees.rosters['committee-118'] = [
      {
        id: 'staff-42',
        fullName: 'Jordan Rivera',
        title: 'Professional Staff Member',
        email: 'jordan.rivera@mail.house.gov',
        phone: '202-555-0100',
        officeLocation: '2129 RHOB',
        isCurrent: true,
        committee: { id: 'committee-118', name: 'Committee on Armed Services', chamber: 'House', kind: 'committee' },
      },
    ];
    const { applyCommands } = renderStep();
    fireEvent.click(screen.getByRole('tab', { name: 'Committee staff' }));

    await waitFor(() => expect(screen.getByText('Jordan Rivera')).toBeInTheDocument());
    expect(
      screen.getByText('Professional Staff Member · Committee on Armed Services'),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '+ Add' }));
    await waitFor(() => expect(applyCommands).toHaveBeenCalled());
    const [commands] = applyCommands.mock.calls[0]! as [OutreachV3Command[]];
    expect(commands).toEqual([
      {
        type: 'ADD_TARGET_REFS',
        schemaVersion: 1,
        payload: { refs: [{ source: 'committee_staff', id: 'staff-42' }] },
      },
    ]);
  });

  it('Committee staff marks a former staffer distinctly from a current one', async () => {
    committees.list = [{ id: 'committee-118', name: 'Committee on Armed Services' }];
    committees.rosters['committee-118'] = [
      {
        id: 'staff-99',
        fullName: 'Former Staffer',
        title: 'Counsel',
        email: 'former@mail.house.gov',
        phone: '',
        officeLocation: '',
        isCurrent: false,
        committee: { id: 'committee-118', name: 'Committee on Armed Services', chamber: 'House', kind: 'committee' },
      },
    ];
    renderStep();
    fireEvent.click(screen.getByRole('tab', { name: 'Committee staff' }));

    await waitFor(() => expect(screen.getByText('Former Staffer')).toBeInTheDocument());
    expect(screen.getByText('Former staff')).toBeInTheDocument();
  });

  it('Selected tab opens the Cc/Bcc popover, validates input, and saves via SET_TARGET_CC_BCC', async () => {
    const { applyCommands } = renderStep({ session: session([target()]) });
    fireEvent.click(screen.getByRole('tab', { name: 'Selected · 1' }));

    fireEvent.click(screen.getByRole('button', { name: 'Cc/Bcc' }));
    expect(screen.getByRole('dialog', { name: /Cc\/Bcc for Rep\. Jane Smith/ })).toBeInTheDocument();

    // Malformed address blocks the save with no command issued.
    const [ccFieldInvalid] = screen.getAllByPlaceholderText('name@example.com, name2@example.com');
    fireEvent.change(ccFieldInvalid!, {
      target: { value: 'not-an-email' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(screen.getByText('"not-an-email" is not a valid email address.')).toBeInTheDocument();
    expect(applyCommands).not.toHaveBeenCalled();

    const [ccField, bccField] = screen.getAllByPlaceholderText('name@example.com, name2@example.com');
    fireEvent.change(ccField!, { target: { value: 'chief@office.test, deputy@office.test' } });
    fireEvent.change(bccField!, { target: { value: 'archive@firm.test' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(applyCommands).toHaveBeenCalled());
    const [commands] = applyCommands.mock.calls[0]! as [OutreachV3Command[]];
    expect(commands).toEqual([
      {
        type: 'SET_TARGET_CC_BCC',
        schemaVersion: 1,
        payload: {
          targetKey: 'tk-1',
          cc: ['chief@office.test', 'deputy@office.test'],
          bcc: ['archive@firm.test'],
        },
      },
    ]);
  });

  it('Selected tab shows an existing Cc/Bcc count on the button and pre-fills the popover', () => {
    const withCcBcc = {
      spec: {
        targeting: {
          selectedTargetRefs: [target()],
          targetCcBcc: { 'tk-1': { cc: ['chief@office.test'], bcc: [] } },
        },
      },
    } as unknown as OutreachV3SessionEnvelope;
    renderStep({ session: withCcBcc });
    fireEvent.click(screen.getByRole('tab', { name: 'Selected · 1' }));

    expect(screen.getByRole('button', { name: 'Cc/Bcc · 1' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Cc/Bcc · 1' }));
    expect(screen.getByDisplayValue('chief@office.test')).toBeInTheDocument();
  });
});
