import { describe, expect, test } from '@jest/globals';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { VendorReferencePullDto } from './vendor-reference.dto.js';

async function errorsFor(query: Record<string, unknown>): Promise<string[]> {
  const dto = plainToInstance(VendorReferencePullDto, query);
  const errors = await validate(dto, { whitelist: true, forbidNonWhitelisted: true });
  return errors.map((e) => e.property);
}

describe('VendorReferencePullDto', () => {
  test('name alone is a valid pull', async () => {
    expect(await errorsFor({ name: 'Lockheed Martin Corporation' })).toEqual([]);
  });

  test('accepts the full optional set', async () => {
    expect(
      await errorsFor({
        name: 'Lockheed Martin Corporation',
        uei: 'KM99JJBNQ9M5',
        cage: '3V1F7',
        state: 'TX',
        district: '12',
        facilityAddress: '1 Lockheed Blvd, Fort Worth, TX 76108',
        clientId: '2c6f2a8e-6e0e-4c4c-9d4a-0f4d8f1a2b3c',
        strategyId: '9d7a5c2b-1f3e-4a6b-8c9d-0e1f2a3b4c5d',
      }),
    ).toEqual([]);
  });

  test('rejects malformed identifiers and ids', async () => {
    const props = await errorsFor({
      name: 'X',
      uei: 'TOO-SHORT',
      cage: 'ABCDEF',
      state: 'Texas',
      district: '123',
      clientId: 'not-a-uuid',
      strategyId: 'nope',
    });
    expect(props.sort()).toEqual(['cage', 'clientId', 'district', 'name', 'state', 'strategyId', 'uei']);
  });

  test('at-large district spelled AL is accepted', async () => {
    expect(await errorsFor({ name: 'Acme Corp', state: 'WY', district: 'AL' })).toEqual([]);
  });
});
