import { describe, expect, it } from '@jest/globals';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { PatchStrategyDto } from './patch-strategy.dto.js';

async function invalidFields(payload: Record<string, unknown>) {
  return (await validate(plainToInstance(PatchStrategyDto, payload)))
    .map((error) => error.property);
}

describe('PatchStrategyDto nullable fields', () => {
  it.each(['title', 'type', 'ownerUserId'])('rejects null for required %s', async (field) => {
    expect(await invalidFields({ [field]: null })).toContain(field);
  });

  it.each(['title', 'ownerUserId'])('rejects blank %s', async (field) => {
    expect(await invalidFields({ [field]: '  ' })).toContain(field);
  });

  it('allows omission and clearing genuinely nullable metadata', async () => {
    expect(await invalidFields({})).toEqual([]);
    expect(await invalidFields({ goal: null, meriContext: null, targetDate: null })).toEqual([]);
  });
});
