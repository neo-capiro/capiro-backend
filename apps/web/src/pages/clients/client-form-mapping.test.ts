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
