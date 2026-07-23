import { describe, expect, it } from '@jest/globals';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { FirmPhasesDto } from './firm-phases.dto.js';

async function errs(payload: unknown): Promise<boolean> {
  const dto = plainToInstance(FirmPhasesDto, payload);
  const e = await validate(dto as object, { whitelist: true });
  return e.length > 0;
}

describe('FirmPhasesDto', () => {
  const ok = { rows: [{ label: 'Strategy refresh', startFy: 2027, startQ: 1, endFy: 2027, endQ: 3 }] };

  it('accepts a well-formed phase set', async () => {
    expect(await errs(ok)).toBe(false);
  });

  it('accepts an empty row set (clears phases)', async () => {
    expect(await errs({ rows: [] })).toBe(false);
  });

  it('rejects a quarter out of 1-4', async () => {
    expect(await errs({ rows: [{ label: 'X', startFy: 2027, startQ: 5, endFy: 2027, endQ: 3 }] })).toBe(true);
  });

  it('rejects a missing label', async () => {
    expect(await errs({ rows: [{ startFy: 2027, startQ: 1, endFy: 2027, endQ: 2 }] })).toBe(true);
  });

  it('rejects a non-integer fiscal year', async () => {
    expect(await errs({ rows: [{ label: 'X', startFy: 2027.5, startQ: 1, endFy: 2027, endQ: 2 }] })).toBe(true);
  });
});
