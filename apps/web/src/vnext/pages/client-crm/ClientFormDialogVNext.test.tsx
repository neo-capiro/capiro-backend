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

function renderDialog(props: Partial<Parameters<typeof ClientFormDialogVNext>[0]> = {}) {
  getMock.mockResolvedValue({ data: [{ code: 'DEF', name: 'Defense' }] });
  const onSubmit = vi.fn<(submission: ClientFormSubmit) => void>();
  const onCancel = vi.fn();
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const utils = render(
    <QueryClientProvider client={queryClient}>
      <div className="capiro-vnext-root">
        <ClientFormDialogVNext
          open
          mode="create"
          submitting={false}
          onCancel={onCancel}
          onSubmit={onSubmit}
          {...props}
        />
      </div>
    </QueryClientProvider>,
  );
  return { ...utils, onSubmit, onCancel };
}

function fillRequiredStepOne() {
  fireEvent.change(screen.getByLabelText(/^Legal name/), {
    target: { value: 'Vantage Orbital Systems, Inc.' },
  });
  fireEvent.change(screen.getByLabelText(/^Website/), { target: { value: 'vantageorbital.example' } });
  fireEvent.change(screen.getByLabelText(/^Company description/), {
    target: { value: 'Smallsat propulsion and orbital logistics.' },
  });
}

describe('ClientFormDialogVNext', () => {
  it('gates Next on the current step: required company fields block, then advance', async () => {
    renderDialog();
    expect(screen.getByRole('dialog', { name: 'Add client' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(await screen.findByText('Legal name is required')).toBeInTheDocument();
    expect(screen.getByText('Website is required')).toBeInTheDocument();
    expect(screen.getByText('Company description is required')).toBeInTheDocument();

    fillRequiredStepOne();
    // Errors clear as the fields become valid (post-failure re-validation).
    await waitFor(() => expect(screen.queryByText('Legal name is required')).not.toBeInTheDocument());

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
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));

    // Step 3 (Sector & Tracks): sector checkboxes come from the controlled
    // SECTOR_TAGS list; the LDA issue-code list is served by the mocked
    // reference endpoint.
    fireEvent.click(await screen.findByLabelText('Energy'));
    fireEvent.click(await screen.findByLabelText('DEF — Defense'));

    fireEvent.click(screen.getByRole('button', { name: 'Add client' }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    const submission = onSubmit.mock.calls[0]![0];
    expect(submission.payload.name).toBe('Vantage Orbital Systems, Inc.');
    expect(submission.payload.website).toBe('vantageorbital.example');
    expect(submission.payload.description).toBe('Smallsat propulsion and orbital logistics.');
    expect(submission.payload.primaryContactPhone).toBe('+1 202-555-0147');
    expect(submission.payload.uei).toBe('ABQ997XK21RR');
    expect(submission.payload.naicsCodes).toEqual(['336414']);
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
      },
    } as unknown as Client;
    const { onSubmit } = renderDialog({ mode: 'edit', client });

    expect(screen.getByRole('dialog', { name: 'Edit client' })).toBeInTheDocument();
    expect(screen.getByLabelText('Legal name')).toHaveValue('Harborline Analytics');
    // DBA is no longer a rendered field.
    expect(screen.queryByLabelText('DBA / trade name')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Next' }));
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
    });
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
    expect(screen.queryByLabelText('Documents', { selector: 'input[type="file"]' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Next' }));
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
});
