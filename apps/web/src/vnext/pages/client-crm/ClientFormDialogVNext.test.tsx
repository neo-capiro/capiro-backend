/**
 * Client form wizard — vNext (re-skin of the canonical antd ClientFormModal).
 *
 * These cover the wizard CONTRACT, not fixture echoes: per-step validation
 * gating Next, the full-form payload produced through the shared
 * `client-form-mapping` module, edit-mode prefill + intakeData ride-through,
 * and file collection. Field values are deliberately absent from every fixture
 * file so an assertion cannot pass vacuously.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GRANTS_GOV_APPLICANT_TYPES, GRANTS_GOV_UNRESTRICTED_APPLICANTS } from '@capiro/shared';
import { ClientFormDialogVNext } from './ClientFormDialogVNext.js';
import type { Client, ClientFormSubmit } from '../../../pages/clients/clientTypes.js';

const getMock = vi.hoisted(() => vi.fn());
vi.mock('../../../lib/use-api.js', () => ({
  useApi: () => ({ get: getMock }),
}));

beforeEach(() => {
  getMock.mockReset();
});

// Labels that carry a character count, help text, or an inline error inside
// the <label> match by prefix, not exact text.

function renderDialog(
  props: Partial<Parameters<typeof ClientFormDialogVNext>[0]> = {},
  options: { issuesError?: boolean } = {},
) {
  // Default the LDA reference read to success; a failure-path test opts into
  // the rejection explicitly so the mock is never clobbered mid-render.
  if (options.issuesError) {
    getMock.mockRejectedValue(Object.assign(new Error('Request failed with status code 503'), { response: { status: 503 } }));
  } else {
    getMock.mockResolvedValue({ data: [{ code: 'DEF', name: 'Defense' }] });
  }
  const onSubmit = vi.fn<(submission: ClientFormSubmit) => void>();
  const onCancel = vi.fn();
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = (nextProps = props) => (
    <QueryClientProvider client={queryClient}>
      <div className="capiro-vnext-root">
        <ClientFormDialogVNext
          open
          mode="create"
          submitting={false}
          onCancel={onCancel}
          onSubmit={onSubmit}
          {...nextProps}
        />
      </div>
    </QueryClientProvider>
  );
  const utils = render(view());
  return { ...utils, onSubmit, onCancel, rerenderDialog: (nextProps: typeof props) => utils.rerender(view({ ...props, ...nextProps })) };
}

function fillRequiredStepOne() {
  fireEvent.change(screen.getByLabelText(/^Legal name/), {
    target: { value: 'Vantage Orbital Systems, Inc.' },
  });
  fireEvent.change(screen.getByLabelText(/^Website/), {
    target: { value: 'vantageorbital.example' },
  });
  fireEvent.change(screen.getByLabelText(/^Company description/), {
    target: { value: 'Smallsat propulsion and orbital logistics.' },
  });
}

describe('ClientFormDialogVNext', () => {
  it('associates registration labels and NAICS removal controls with their specific inputs', async () => {
    renderDialog();
    fillRequiredStepOne();
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(screen.getByRole('textbox', { name: 'CAGE Code' })).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'UEI' })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'SAM.gov status' })).toBeInTheDocument();
    expect(screen.getByLabelText('SAM.gov expiration date')).toHaveAttribute('type', 'date');
    const naics = screen.getByRole('textbox', { name: 'NAICS codes' });
    fireEvent.change(naics, { target: { value: '541330' } });
    fireEvent.keyDown(naics, { key: 'Enter' });
    expect(screen.getByRole('textbox', { name: 'NAICS codes' })).toBe(naics);
    expect(naics).toHaveAccessibleDescription(/Procurement NAICS codes/);
    fireEvent.click(screen.getByRole('button', { name: 'Remove NAICS code 541330' }));
    expect(screen.queryByRole('button', { name: 'Remove NAICS code 541330' })).not.toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'HUBZone' })).toBeInTheDocument();
  });

  it('blocks a new malformed EIN and accepts the usual hyphenated format', async () => {
    const { onSubmit } = renderDialog();
    fillRequiredStepOne();
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    fireEvent.change(screen.getByRole('textbox', { name: /^EIN/ }), { target: { value: '123456' } });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Next' })).not.toBeDisabled());
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(screen.getByText('Enter nine digits, for example 12-3456789, or leave EIN empty.')).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
    fireEvent.change(screen.getByRole('textbox', { name: /^EIN/ }), { target: { value: '12-3456789' } });
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Add client' })).not.toBeDisabled());
    fireEvent.click(screen.getByRole('button', { name: 'Add client' }));
    expect(onSubmit.mock.calls[0]?.[0].payload.intakeData?.ein).toBe('123456789');
  });

  it('shows saved registration conflicts and invalid EIN without blocking an unrelated correction', async () => {
    const saved = { id: 'saved', name: 'Example', website: 'example.test', description: 'Example organization', applicantTypes: [GRANTS_GOV_APPLICANT_TYPES[1], GRANTS_GOV_APPLICANT_TYPES[9]], intakeData: { ein: '123456' } } as Client;
    const { onSubmit } = renderDialog({ mode: 'edit', client: saved });
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(screen.getByText('Registration selections need review')).toBeInTheDocument();
    expect(screen.getByText(/Saved or entered EIN needs review/)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Next' })).not.toBeDisabled());
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save changes' })).not.toBeDisabled());
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit.mock.calls[0]?.[0].payload.intakeData?.ein).toBe('123456');
  });

  it('preserves a cleared EIN, edited classifications and wizard step during a background client refresh', async () => {
    const saved = { id: 'saved', name: 'Example', website: 'example.test', description: 'Example organization',
      applicantTypes: [], naicsCodes: ['336414', '541330'], intakeData: { ein: '237130', primaryNaics: '541512', profileNotes: 'Original note' } } as unknown as Client;
    const { onSubmit, rerenderDialog } = renderDialog({ mode: 'edit', client: saved });
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    fireEvent.change(screen.getByRole('textbox', { name: /^EIN/ }), { target: { value: '' } });
    fireEvent.click(screen.getByRole('checkbox', { name: 'HUBZone' }));
    rerenderDialog({ client: { ...saved, updatedAt: '2026-09-08T12:00:00Z', intakeData: { ...saved.intakeData, profileNotes: 'Updated in background' } } });
    expect(screen.getByRole('textbox', { name: /^EIN/ })).toHaveValue('');
    expect(screen.getByRole('checkbox', { name: 'HUBZone' })).toBeChecked();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Next' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save changes' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    const payload = onSubmit.mock.calls[0]?.[0].payload;
    expect(payload?.intakeData).not.toHaveProperty('ein');
    expect(payload?.intakeData).not.toHaveProperty('primaryNaics');
    expect(payload?.naicsCodes).toEqual(['336414', '541330']);
    // The certification option is the canonical durable code (was the legacy
    // solicitation-restriction code HZC before the options reconciled to the
    // API's DURABLE_SET_ASIDE_CERTIFICATIONS).
    expect(payload?.setAsideCertifications).toContain('HUBZONE');
    expect(payload?.intakeData?.profileNotes).toBe('Updated in background');
  });

  it('loads fresh values when reopened and does not carry an open draft to a different client', () => {
    const saved = { id: 'saved', name: 'Example', website: 'example.test', description: 'Example organization',
      intakeData: { ein: '237130' } } as Client;
    const { rerenderDialog } = renderDialog({ mode: 'edit', client: saved });
    fireEvent.change(screen.getByLabelText(/^Legal name/), { target: { value: 'Unsaved name' } });
    rerenderDialog({ open: false });
    rerenderDialog({ open: true, client: { ...saved, name: 'Fresh saved name' } });
    expect(screen.getByLabelText(/^Legal name/)).toHaveValue('Fresh saved name');
    fireEvent.change(screen.getByLabelText(/^Legal name/), { target: { value: 'Another unsaved name' } });
    rerenderDialog({ client: { ...saved, id: 'other-client', name: 'Different client' } });
    expect(screen.getByLabelText(/^Legal name/)).toHaveValue('Different client');
  });

  it('requires correcting new mutually exclusive nonprofit tax statuses', async () => {
    const { onSubmit } = renderDialog();
    fillRequiredStepOne();
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    fireEvent.click(screen.getByText('Select organization types'));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Nonprofit with 501(c)(3) status' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Nonprofit without 501(c)(3) status' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Next' })).not.toBeDisabled());
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Choose either nonprofit with or without');
    expect(onSubmit).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Nonprofit without 501(c)(3) status' }));
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(screen.getByRole('button', { name: 'Add client' })).toBeInTheDocument();
  });

  it('gates Next on the current step: required company fields block, then advance', async () => {
    renderDialog();
    expect(screen.getByRole('dialog', { name: 'Add client' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(await screen.findByText('Legal name is required')).toBeInTheDocument();
    expect(screen.getByText('Website is required')).toBeInTheDocument();
    expect(screen.getByText('Company description is required')).toBeInTheDocument();

    fillRequiredStepOne();
    // Errors clear as the fields become valid (post-failure re-validation).
    await waitFor(() =>
      expect(screen.queryByText('Legal name is required')).not.toBeInTheDocument(),
    );

    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    // Step 2 (Gov't Registration) is next; Back appears once past step 1.
    expect(await screen.findByRole('button', { name: 'Back' })).toBeInTheDocument();
  });

  it('validates the email format on the company info step (contact block merged in)', async () => {
    renderDialog();
    fillRequiredStepOne();

    fireEvent.change(screen.getByLabelText(/^Main company email/), {
      target: { value: 'not-an-email' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(await screen.findByText('Enter a valid email address')).toBeInTheDocument();
    // Still on step 1 — Back has not appeared.
    expect(screen.queryByRole('button', { name: 'Back' })).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText(/^Main company email/), {
      target: { value: 'ops@vantageorbital.example' },
    });
    await waitFor(() =>
      expect(screen.queryByText('Enter a valid email address')).not.toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(await screen.findByRole('button', { name: 'Back' })).toBeInTheDocument();
  });

  it('submits the mapped payload from the final step (shared client-form-mapping)', async () => {
    const { onSubmit } = renderDialog();
    fillRequiredStepOne();
    fireEvent.click(screen.getByLabelText('Small Business (SB)'));
    fireEvent.change(screen.getByLabelText('Main company phone'), {
      target: { value: '2025550147' },
    });
    fireEvent.blur(screen.getByLabelText('Main company phone'));
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));

    // Step 2 (Gov't Registration): token lists commit on Enter; UEI uppercases as typed.
    const uei = await screen.findByLabelText('UEI');
    fireEvent.change(uei, { target: { value: 'abq997xk21rr' } });
    const naics = screen.getByLabelText(/^NAICS codes/);
    fireEvent.change(naics, { target: { value: '336414' } });
    fireEvent.keyDown(naics, { key: 'Enter' });
    fireEvent.click(screen.getByText('Select organization types'));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Small business' }));
    expect(screen.queryByRole('checkbox', { name: /Unrestricted/ })).not.toBeInTheDocument();
    // The footer briefly disables after a step change (guards against a fast
    // double-click landing on the next step's now-differently-sized last
    // button — see the `stepTransitioning` comment in the component).
    await waitFor(() => expect(screen.getByRole('button', { name: 'Next' })).not.toBeDisabled());
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));

    // Step 3 (Sector & Tracks): sector checkboxes come from the controlled
    // SECTOR_TAGS list; the LDA issue-code list is served by the mocked
    // reference endpoint.
    fireEvent.click(await screen.findByLabelText('Energy'));
    fireEvent.click(await screen.findByLabelText('DEF — Defense'));
    const priorities = screen.getByLabelText(/^Funding priorities/);
    fireEvent.change(priorities, { target: { value: 'Battery recycling' } });
    fireEvent.keyDown(priorities, { key: ' ' });
    expect(priorities).toHaveValue('Battery recycling');
    fireEvent.keyDown(priorities, { key: 'Enter' });

    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Add client' })).not.toBeDisabled(),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Add client' }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    const submission = onSubmit.mock.calls[0]![0];
    expect(submission.payload.name).toBe('Vantage Orbital Systems, Inc.');
    expect(submission.payload.website).toBe('vantageorbital.example');
    expect(submission.payload.description).toBe('Smallsat propulsion and orbital logistics.');
    expect(submission.payload.primaryContactPhone).toBe('+1 202-555-0147');
    expect(submission.payload.uei).toBe('ABQ997XK21RR');
    expect(submission.payload.naicsCodes).toEqual(['336414']);
    expect(submission.payload.applicantTypes).toEqual(['Small businesses']);
    expect(submission.payload.intakeData?.fundingPriorities).toEqual(['Battery recycling']);
    expect(submission.payload.issueCodes).toEqual(['DEF']);
    // First (only) selected sector mirrors to the controlled top-level tag.
    expect(submission.payload.sectorTag).toBe('ENERGY');
    expect(submission.payload.intakeData).toMatchObject({ sectors: ['ENERGY'] });
    expect(submission.payload.intakeData).toMatchObject({ sbClassification: { sb: true } });
    // Document upload was removed from the wizard (2026-08-23) — always empty.
    expect(submission.documents).toEqual([]);
    expect(submission.logo).toBeUndefined();
  });

  it('prefills edit mode from the client and preserves non-wizard intakeData keys', async () => {
    const client = {
      id: 'client-77',
      name: 'Harborline Analytics',
      website: 'harborline.example',
      description: 'Port logistics analytics.',
      productDescription: null,
      primaryContactName: null,
      primaryContactEmail: null,
      primaryContactPhone: null,
      logoS3Key: null,
      logoContentType: null,
      logoUploadedAt: null,
      status: 'active',
      applicantTypes: ['Small businesses', GRANTS_GOV_UNRESTRICTED_APPLICANTS],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      intakeData: {
        // NOT rendered by the wizard (dba/address removed 2026-08-23; peNumber
        // and governmentHistory were never rendered) — all must survive an
        // edit round-trip via the merge in formValuesToClientPayload.
        dba: 'Harborline',
        city: 'Norfolk',
        peNumber: '0604215N',
        governmentHistory: { note: 'kept' },
        fundingPriorities: ['Port electrification'],
      },
    } as unknown as Client;
    const { onSubmit } = renderDialog({ mode: 'edit', client });

    expect(screen.getByRole('dialog', { name: 'Edit client' })).toBeInTheDocument();
    expect(screen.getByLabelText('Legal name')).toHaveValue('Harborline Analytics');
    // DBA is no longer a rendered field.
    expect(screen.queryByLabelText('DBA / trade name')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(screen.getByText('Saved selections need review')).toBeInTheDocument();
    // The footer briefly disables after a step change (guards against a fast
    // double-click landing on the next step's now-differently-sized last
    // button — see the `stepTransitioning` comment in the component).
    await waitFor(() => expect(screen.getByRole('button', { name: 'Next' })).not.toBeDisabled());
    fireEvent.click(await screen.findByRole('button', { name: 'Next' }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Save changes' })).not.toBeDisabled(),
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    const { payload } = onSubmit.mock.calls[0]![0];
    expect(payload.name).toBe('Harborline Analytics');
    // Removed-from-wizard keys ride through untouched, same as always-unrendered ones.
    expect(payload.intakeData).toMatchObject({
      dba: 'Harborline',
      city: 'Norfolk',
      peNumber: '0604215N',
      governmentHistory: { note: 'kept' },
      fundingPriorities: ['Port electrification'],
    });
    expect(payload.applicantTypes).toEqual([
      'Small businesses',
      GRANTS_GOV_UNRESTRICTED_APPLICANTS,
    ]);
  });

  it('allows a deliberate organization correction and funding priority clear in edit mode', async () => {
    const client = {
      name: 'Prairie Network',
      website: 'prairie.example',
      description: 'Community connectivity.',
      applicantTypes: [GRANTS_GOV_UNRESTRICTED_APPLICANTS],
      intakeData: { fundingPriorities: ['Rural broadband'], profileNotes: ['keep'] },
    } as unknown as Client;
    const { onSubmit } = renderDialog({ mode: 'edit', client });
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    fireEvent.click(screen.getByText('Select organization types'));
    fireEvent.click(screen.getByRole('checkbox', { name: 'County government' }));
    expect(screen.queryByText('Saved selections need review')).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Next' })).not.toBeDisabled());
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove Rural broadband' }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Save changes' })).not.toBeDisabled(),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    const { payload } = onSubmit.mock.calls[0]![0];
    expect(payload.applicantTypes).toEqual(['County governments']);
    expect(payload.intakeData).not.toHaveProperty('fundingPriorities');
    expect(payload.intakeData?.profileNotes).toEqual(['keep']);
  });

  it('keeps an overlong pending priority visible and blocks saving until corrected', async () => {
    const { onSubmit } = renderDialog();
    fillRequiredStepOne();
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Next' })).not.toBeDisabled());
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    const priorities = screen.getByLabelText(/^Funding priorities/);
    fireEvent.change(priorities, { target: { value: 'A'.repeat(121) } });
    fireEvent.keyDown(priorities, { key: 'Enter' });
    expect(screen.getByRole('alert')).toHaveTextContent('120 characters or fewer');
    expect(priorities).toHaveValue('A'.repeat(121));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Add client' })).not.toBeDisabled(),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Add client' }));
    expect(onSubmit).not.toHaveBeenCalled();
    fireEvent.change(priorities, { target: { value: 'Rural broadband' } });
    fireEvent.keyDown(priorities, { key: 'Enter' });
    fireEvent.click(screen.getByRole('button', { name: 'Add client' }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0]![0].payload.intakeData?.fundingPriorities).toEqual([
      'Rural broadband',
    ]);
  });

  /**
   * Regression for the reported bug: clicking Next from Gov't Registration to
   * advance to Sector & Tracks (the one transition where the footer's LAST
   * button swaps from "Next" to "Save changes"/"Add client" in the same
   * flex-end slot) could have a fast second click land on the new, wider
   * submit button at the same position — silently submitting the form with
   * Sector & Tracks never seen, and closing the dialog on success. The footer
   * must ignore input for a brief window right after any step change.
   */
  it('ignores an immediate second click on the swapped footer button after Next reaches the last step', async () => {
    const client = {
      id: 'client-77',
      name: 'Harborline Analytics',
      website: 'harborline.example',
      description: 'Port logistics analytics.',
      productDescription: null,
      primaryContactName: null,
      primaryContactEmail: null,
      primaryContactPhone: null,
      logoS3Key: null,
      logoContentType: null,
      logoUploadedAt: null,
      status: 'active',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      intakeData: {},
    } as unknown as Client;
    const { onSubmit } = renderDialog({ mode: 'edit', client });

    fireEvent.click(screen.getByRole('button', { name: 'Next' })); // Company Info -> Gov't Registration
    await waitFor(() => expect(screen.getByRole('button', { name: 'Next' })).not.toBeDisabled());
    fireEvent.click(screen.getByRole('button', { name: 'Next' })); // Gov't Registration -> Sector & Tracks
    // Immediately, before the footer's brief lock clears: a stray click on
    // the button now occupying the same footer slot must be a no-op.
    fireEvent.click(await screen.findByRole('button', { name: 'Save changes' }));
    expect(onSubmit).not.toHaveBeenCalled();
    // Still on Sector & Tracks — the click didn't even change the step.
    expect(screen.getByLabelText('Energy')).toBeInTheDocument();

    // Once the lock clears, a deliberate click submits normally.
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Save changes' })).not.toBeDisabled(),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
  });

  it('collects the logo File and hands it to the caller unsent; documents always empty', async () => {
    const { onSubmit } = renderDialog();
    fillRequiredStepOne();

    const logo = new File(['png-bytes'], 'crest.png', { type: 'image/png' });
    fireEvent.change(screen.getByLabelText('Client logo', { selector: 'input[type="file"]' }), {
      target: { files: [logo] },
    });
    expect(screen.getByText('crest.png')).toBeInTheDocument();
    // Document upload was removed from the wizard (2026-08-23).
    expect(
      screen.queryByLabelText('Documents', { selector: 'input[type="file"]' }),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Next' })).not.toBeDisabled());
    fireEvent.click(await screen.findByRole('button', { name: 'Next' }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Add client' })).not.toBeDisabled(),
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Add client' }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    const submission = onSubmit.mock.calls[0]![0];
    expect(submission.logo?.name).toBe('crest.png');
    expect(submission.documents).toEqual([]);
  });

  it('renders nothing while closed', () => {
    const queryClient = new QueryClient();
    render(
      <QueryClientProvider client={queryClient}>
        <ClientFormDialogVNext
          open={false}
          mode="create"
          submitting={false}
          onCancel={() => {}}
          onSubmit={() => {}}
        />
      </QueryClientProvider>,
    );
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    // The LDA issue-code reference read is gated on `open`.
    expect(getMock).not.toHaveBeenCalled();
  });

  it('D11: a failed LDA issue-code reference read shows a retryable error, not "No options match."', async () => {
    // The rejection is arranged by renderDialog's options so it's in place the
    // moment the issues query mounts (setting it before render is clobbered
    // by the default success mock; after render, the query already resolved).
    renderDialog({}, { issuesError: true });
    fillRequiredStepOne();
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Next' })).not.toBeDisabled());
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));

    // The reference read failed — the field must say so, not claim there are
    // simply no codes (which reads as "source answered, empty").
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load the LDA issue-code reference list.');
    expect(screen.queryByText('No options match.')).not.toBeInTheDocument();

    // Retry recovers once the source answers.
    getMock.mockResolvedValue({ data: [{ code: 'DEF', name: 'Defense' }] });
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByLabelText('DEF — Defense')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('D9: stored legacy certification codes render an honest label, not a raw code, and are not offered as new choices', async () => {
    const client = {
      id: 'client-legacy',
      name: 'Legacy Cert Co',
      website: 'legacy.example',
      description: 'Holds a legacy restriction code.',
      setAsideCertifications: ['SDVOSBC', 'HZC'],
      intakeData: {},
    } as unknown as Client;
    renderDialog({ mode: 'edit', client });
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));

    // Stored legacy codes are visible with English labels (legacy-tagged),
    // not raw codes — and NOT offered again as selectable options. The label
    // appears on both the selected chip and the (removable) orphan checkbox.
    expect(screen.getAllByText('Service-disabled veteran-owned small business (legacy)').length).toBeGreaterThan(0);
    expect(screen.getAllByText('HUBZone (legacy)').length).toBeGreaterThan(0);
    // The durable certification is recorded as selected (a current option) —
    // the legacy codes ride through as history, never re-offered.
    expect(screen.queryByRole('checkbox', { name: 'SDVOSBC' })).not.toBeInTheDocument();
    expect(screen.queryByRole('checkbox', { name: 'HZC' })).not.toBeInTheDocument();
  });
});
