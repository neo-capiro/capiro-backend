import { describe, expect, it } from 'vitest';
import { GRANTS_GOV_OTHER_APPLICANTS, GRANTS_GOV_UNRESTRICTED_APPLICANTS } from '@capiro/shared';
import { clientToFormValues, formValuesToClientPayload } from './client-form-mapping.js';
import type { Client } from './clientTypes.js';

const client = {
  name: 'Prairie Network',
  applicantTypes: [
    'Small businesses',
    GRANTS_GOV_UNRESTRICTED_APPLICANTS,
    GRANTS_GOV_OTHER_APPLICANTS,
    'Imported legacy type',
  ],
  intakeData: {
    fundingPriorities: ['Rural broadband', 'Workforce training'],
    fundingAsk: '500000',
    profileNotes: [{ body: 'Keep this note' }],
    peNumber: '0604215N',
  },
} as unknown as Client;

describe('client funding profile form mapping', () => {
  it('loads concrete funding phrases and preserves source-only organization selections on unrelated saves', () => {
    const values = clientToFormValues(client);
    expect(values.fundingPriorities).toEqual(['Rural broadband', 'Workforce training']);
    expect(values.applicantTypes).toEqual(client.applicantTypes);
    const payload = formValuesToClientPayload({ ...values, name: 'Prairie Network LLC' }, client);
    expect(payload.applicantTypes).toEqual(client.applicantTypes);
    expect(payload.intakeData).toMatchObject(client.intakeData!);
  });

  it('normalizes priority phrases without tokenizing spaces or replacing unrelated intake fields', () => {
    const payload = formValuesToClientPayload(
      {
        name: client.name,
        fundingPriorities: [
          '  Battery   recycling ',
          'battery recycling',
          'Community health clinics',
        ],
      },
      client,
    );
    expect(payload.intakeData).toMatchObject({
      fundingPriorities: ['Battery recycling', 'Community health clinics'],
      fundingAsk: '500000',
      profileNotes: [{ body: 'Keep this note' }],
      peNumber: '0604215N',
    });
    expect(payload.applicantTypes).toEqual(client.applicantTypes);
  });

  it('an explicit clear removes priorities and organization types, retaining unrelated intake data', () => {
    const payload = formValuesToClientPayload(
      {
        ...clientToFormValues(client),
        fundingPriorities: [],
        applicantTypes: [],
      },
      client,
    );
    expect(payload.applicantTypes).toEqual([]);
    expect(payload.intakeData).not.toHaveProperty('fundingPriorities');
    expect(payload.intakeData?.fundingAsk).toBe('500000');
    expect(payload.intakeData?.profileNotes).toEqual([{ body: 'Keep this note' }]);
  });

  it('an editor omitting priorities preserves existing values', () => {
    expect(
      formValuesToClientPayload({ name: client.name }, client).intakeData?.fundingPriorities,
    ).toEqual(['Rural broadband', 'Workforce training']);
  });
});

describe('edit-mode intentional clears (D10)', () => {
  const saved = {
    name: 'Contact Co',
    website: 'contact.example',
    description: 'Has contact details.',
    primaryContactName: 'Jane Smith',
    primaryContactEmail: 'jane@contact.example',
    primaryContactPhone: '+1 202-555-0100',
    sectorTag: 'DEFENSE',
    submissionTracks: ['NDAA'],
    intakeData: { profileNotes: 'keep me', peNumber: '0604215N' },
  } as unknown as Client;

  it('sends explicit null for cleared contact/identity fields on edit (the API nulls the column)', () => {
    const payload = formValuesToClientPayload(
      {
        name: 'Contact Co',
        website: '',
        description: '',
        primaryContactName: '',
        primaryContactEmail: '',
        primaryContactPhone: '',
        sectors: [],
        submissionTracks: [],
      },
      saved,
    );
    expect(payload.website).toBeNull();
    expect(payload.description).toBeNull();
    expect(payload.primaryContactName).toBeNull();
    expect(payload.primaryContactEmail).toBeNull();
    expect(payload.primaryContactPhone).toBeNull();
    expect(payload.sectorTag).toBeNull();
    expect(payload.submissionTracks).toEqual([]);
    // Unknown / non-wizard intake keys ride through untouched.
    expect(payload.intakeData).toMatchObject({ profileNotes: 'keep me', peNumber: '0604215N' });
  });

  it('a partial clear nulls only the cleared field and keeps the rest', () => {
    const payload = formValuesToClientPayload(
      {
        name: 'Contact Co',
        website: 'contact.example',
        description: 'Has contact details.',
        primaryContactName: '',
        primaryContactEmail: 'jane@contact.example',
        primaryContactPhone: '+1 202-555-0100',
        sectors: ['DEFENSE'],
        submissionTracks: ['NDAA'],
      },
      saved,
    );
    expect(payload.primaryContactName).toBeNull();
    expect(payload.primaryContactEmail).toBe('jane@contact.example');
    expect(payload.website).toBe('contact.example');
    expect(payload.sectorTag).toBe('DEFENSE');
    expect(payload.submissionTracks).toEqual(['NDAA']);
  });

  it('create mode omits empty fields instead of sending null (create semantics preserved)', () => {
    const payload = formValuesToClientPayload({
      name: 'New Co',
      website: '',
      description: '',
      primaryContactName: '',
      primaryContactEmail: '',
      primaryContactPhone: '',
      sectors: [],
      submissionTracks: [],
    });
    expect(payload).not.toHaveProperty('website');
    expect(payload).not.toHaveProperty('description');
    expect(payload).not.toHaveProperty('primaryContactName');
    expect(payload).not.toHaveProperty('primaryContactEmail');
    expect(payload).not.toHaveProperty('primaryContactPhone');
    expect(payload).not.toHaveProperty('sectorTag');
    expect(payload).not.toHaveProperty('submissionTracks');
  });

  it('create mode keeps a formatted phone (unchanged from before the clear fix)', () => {
    const payload = formValuesToClientPayload({
      name: 'New Co',
      primaryContactPhone: '2025550100',
    });
    // formatPhone applies in BOTH modes — a regression dropped it on create.
    expect(payload.primaryContactPhone).toBe('+1 202-555-0100');
  });

  it('edit mode keeps a non-empty value and a formatted phone as before', () => {
    const payload = formValuesToClientPayload(
      {
        name: 'Contact Co',
        website: 'contact.example',
        description: 'Has contact details.',
        primaryContactName: 'Jane Smith',
        primaryContactEmail: 'jane@contact.example',
        primaryContactPhone: '2025550100',
        sectors: ['DEFENSE'],
        submissionTracks: ['NDAA'],
      },
      saved,
    );
    expect(payload.primaryContactPhone).toBe('+1 202-555-0100');
    expect(payload.website).toBe('contact.example');
  });
});

describe('registration editing round trips', () => {
  it('retains every legacy generic NAICS code through an unrelated save without inventing a primary', () => {
    const saved = { ...client, intakeData: { naics: '541330, 541512; 336414', note: 'retain' } } as Client;
    const values = clientToFormValues(saved);
    expect(values.naicsCodes).toEqual(['541330', '541512', '336414']);
    const payload = formValuesToClientPayload({ ...values, name: 'Updated name' }, saved);
    expect(payload.naicsCodes).toEqual(['541330', '541512', '336414']);
    expect(payload.intakeData).toEqual({ note: 'retain' });
  });

  it('retains all codes recorded in explicit-primary aliases while preserving the selected primary', () => {
    const saved = { ...client, intakeData: {
      primaryNaics: '541330, 541512', primary_naics: '336414',
      naics: '541712', additionalNaics: '541330', additional_naics: '541715',
    } } as Client;
    const values = clientToFormValues(saved);
    expect(values.naicsCodes).toEqual(['541330', '541512', '336414', '541712', '541715']);
    const payload = formValuesToClientPayload(values, saved);
    expect(payload.naicsCodes).toEqual(values.naicsCodes);
    expect(payload.intakeData).toEqual({ primaryNaics: '541330', additionalNaics: '541512, 336414, 541712, 541715' });
  });

  it('reconciles stale legacy NAICS fields to the edited canonical list while preserving other data', () => {
    const saved = { ...client, naicsCodes: ['336414'], intakeData: { ...client.intakeData, primaryNaics: '541330', additionalNaics: '541512' } } as Client;
    const values = clientToFormValues(saved);
    expect(values.naicsCodes).toEqual(['336414']);
    const payload = formValuesToClientPayload(values, saved);
    expect(payload.naicsCodes).toEqual(['336414']);
    expect(payload.intakeData).not.toHaveProperty('primaryNaics');
    expect(payload.intakeData).not.toHaveProperty('additionalNaics');
    expect(payload.intakeData?.peNumber).toBe('0604215N');
  });
  it('loads legacy-only codes into the editor, preserving a real primary on save', () => {
    const saved = { ...client, intakeData: { primaryNaics: '541330', additionalNaics: '541512, 336414' } } as Client;
    const values = clientToFormValues(saved);
    expect(values.naicsCodes).toEqual(['541330', '541512', '336414']);
    const payload = formValuesToClientPayload(values, saved);
    expect(payload.intakeData).toMatchObject({ primaryNaics: '541330', additionalNaics: '541512, 336414' });
  });
  it('normalizes a formatted EIN while retaining an invalid unchanged saved value for review', () => {
    expect(formValuesToClientPayload({ name: 'Client', ein: '12-3456789' }).intakeData?.ein).toBe('123456789');
    expect(formValuesToClientPayload({ name: 'Client', ein: '123456' }).intakeData?.ein).toBe('123456');
  });
  it('extracts identifiers from older NAICS descriptions without treating words as codes', () => {
    const saved = { ...client, intakeData: { primaryNaics: '541512 · Computer Systems Design Services', additionalNaics: '541330 — Engineering services, 336414' } } as Client;
    const values = clientToFormValues(saved);
    expect(values.naicsCodes).toEqual(['541512', '541330', '336414']);
    const payload = formValuesToClientPayload(values, saved);
    expect(payload.intakeData).toMatchObject({ primaryNaics: '541512', additionalNaics: '541330, 336414' });
  });
});
